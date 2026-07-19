import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import {
  ROOT,
  ensureDirs,
  loadStore,
  saveStore,
  getMonitor,
  getProfile,
  getActiveProfile,
  isValidMonitorId,
  withStoreLock,
  monitorPublicView,
  statusPublicView,
  listProfilesPublic,
  createProfile,
  normalizeProfileName,
} from "./store.js";
import { startChecker } from "./checker.js";
import { loadEnvFile } from "./env.js";

loadEnvFile();

const PORT = Number(process.env.PORT) || 5060;
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";
const ALERT_WEBHOOK = (process.env.ALERT_WEBHOOK || "").trim();

await ensureDirs();
await withStoreLock(async () => {
  // Force migrate legacy store on boot
  const data = await loadStore();
  await saveStore(data);
});

const app = express();
app.disable("x-powered-by");

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

if (CORS_ORIGIN) {
  const allowed = CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || allowed.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
    }),
  );
}

app.use(express.json({ limit: "32kb" }));

/** Simple sliding-window rate limiter (per key). */
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function rateLimit(key) {
    const now = Date.now();
    let bucket = hits.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      hits.set(key, bucket);
    }
    bucket.count += 1;
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (now - v.start >= windowMs) hits.delete(k);
      }
    }
    return bucket.count <= max;
  };
}

const createLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 40 });
const profileLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function clientError(res, status, message) {
  return res.status(status).json({ error: message });
}

function isValidHttpUrl(value) {
  if (typeof value !== "string") return false;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!parsed.hostname) return false;
  return true;
}

/** Prepend https:// when the caller omits a scheme. */
function normalizeMonitorUrl(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return `https://${trimmed}`;
}

function parseMonitorBody(body) {
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
  const url = normalizeMonitorUrl(
    typeof body?.url === "string" ? body.url.trim().slice(0, 2048) : "",
  ).slice(0, 2048);
  const intervalSec = Number(body?.intervalSec);
  const timeoutMs = Number(body?.timeoutMs);
  const expectedStatus =
    body?.expectedStatus == null || body?.expectedStatus === ""
      ? 200
      : Number(body.expectedStatus);

  if (!name) return { error: "Name is required" };
  if (!isValidHttpUrl(url)) return { error: "A valid http(s) URL is required" };
  if (!Number.isFinite(intervalSec) || intervalSec < 30 || intervalSec > 3600) {
    return { error: "intervalSec must be between 30 and 3600" };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 500 || timeoutMs > 60000) {
    return { error: "timeoutMs must be between 500 and 60000" };
  }
  if (
    !Number.isFinite(expectedStatus) ||
    expectedStatus < 100 ||
    expectedStatus > 599 ||
    Math.floor(expectedStatus) !== expectedStatus
  ) {
    return { error: "expectedStatus must be an HTTP status code (100–599)" };
  }

  return {
    name,
    url,
    intervalSec: Math.floor(intervalSec),
    timeoutMs: Math.floor(timeoutMs),
    expectedStatus: Math.floor(expectedStatus),
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "pulseboard",
    version: "1.1.0",
    alertWebhook: Boolean(ALERT_WEBHOOK),
    publicBaseUrl: PUBLIC_BASE_URL || null,
  });
});

app.get("/api/profiles", async (_req, res) => {
  try {
    const data = await loadStore();
    res.json(listProfilesPublic(data));
  } catch (err) {
    console.error("[Pulseboard] list profiles failed:", err);
    clientError(res, 500, "Failed to list profiles");
  }
});

app.post("/api/profiles", async (req, res) => {
  const ip = clientIp(req);
  if (!profileLimiter(`profile-create:${ip}`)) {
    return clientError(res, 429, "Too many profile creates. Try again later.");
  }
  try {
    const name = normalizeProfileName(req.body?.name);
    if (!name) return clientError(res, 400, "Profile name is required");

    const created = await withStoreLock(async () => {
      const data = await loadStore();
      const id = createProfile(data, name);
      await saveStore(data);
      return { id, name, monitorCount: 0, createdAt: data.profiles[id].createdAt };
    });

    res.status(201).json(created);
  } catch (err) {
    console.error("[Pulseboard] create profile failed:", err);
    clientError(res, 500, "Failed to create profile");
  }
});

app.patch("/api/profiles/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidMonitorId(id)) return clientError(res, 404, "Profile not found");
    const name = normalizeProfileName(req.body?.name);
    if (!name) return clientError(res, 400, "Profile name is required");

    const updated = await withStoreLock(async () => {
      const data = await loadStore();
      const profile = getProfile(data, id);
      if (!profile) return null;
      profile.name = name;
      await saveStore(data);
      return {
        id,
        name: profile.name,
        monitorCount: Object.keys(profile.monitors).length,
        createdAt: profile.createdAt,
      };
    });

    if (!updated) return clientError(res, 404, "Profile not found");
    res.json(updated);
  } catch (err) {
    console.error("[Pulseboard] rename profile failed:", err);
    clientError(res, 500, "Failed to rename profile");
  }
});

app.delete("/api/profiles/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidMonitorId(id)) return clientError(res, 404, "Profile not found");

    const result = await withStoreLock(async () => {
      const data = await loadStore();
      if (!getProfile(data, id)) return { error: "not_found" };
      const ids = Object.keys(data.profiles);
      if (ids.length <= 1) return { error: "last" };

      delete data.profiles[id];
      if (data.activeProfileId === id) {
        data.activeProfileId = Object.keys(data.profiles)[0];
      }
      await saveStore(data);
      return { ok: true, activeProfileId: data.activeProfileId };
    });

    if (result.error === "not_found") return clientError(res, 404, "Profile not found");
    if (result.error === "last") {
      return clientError(res, 400, "Cannot delete the last profile");
    }
    res.json(result);
  } catch (err) {
    console.error("[Pulseboard] delete profile failed:", err);
    clientError(res, 500, "Failed to delete profile");
  }
});

app.post("/api/profiles/:id/activate", async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidMonitorId(id)) return clientError(res, 404, "Profile not found");

    const result = await withStoreLock(async () => {
      const data = await loadStore();
      if (!getProfile(data, id)) return null;
      data.activeProfileId = id;
      await saveStore(data);
      return listProfilesPublic(data);
    });

    if (!result) return clientError(res, 404, "Profile not found");
    res.json(result);
  } catch (err) {
    console.error("[Pulseboard] activate profile failed:", err);
    clientError(res, 500, "Failed to activate profile");
  }
});

app.get("/api/status", async (_req, res) => {
  try {
    const data = await loadStore();
    res.json(statusPublicView(data));
  } catch (err) {
    console.error("[Pulseboard] status failed:", err);
    clientError(res, 500, "Failed to load status");
  }
});

app.get("/api/monitors", async (_req, res) => {
  try {
    const data = await loadStore();
    const active = getActiveProfile(data);
    const monitorsMap = active?.profile?.monitors || {};
    const list = Object.entries(monitorsMap)
      .map(([id, mon]) => monitorPublicView(id, mon))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({
      monitors: list,
      activeProfileId: active?.id || null,
      profileName: active?.profile?.name || null,
    });
  } catch (err) {
    console.error("[Pulseboard] list monitors failed:", err);
    clientError(res, 500, "Failed to list monitors");
  }
});

app.post("/api/monitors", async (req, res) => {
  const ip = clientIp(req);
  if (!createLimiter(`create:${ip}`)) {
    return clientError(res, 429, "Too many creates. Try again later.");
  }

  try {
    const parsed = parseMonitorBody(req.body);
    if (parsed.error) return clientError(res, 400, parsed.error);

    const id = nanoid(12);
    const createdAt = new Date().toISOString();
    const monitor = {
      name: parsed.name,
      url: parsed.url,
      intervalSec: parsed.intervalSec,
      timeoutMs: parsed.timeoutMs,
      expectedStatus: parsed.expectedStatus,
      createdAt,
      lastCheckAt: null,
      lastOk: null,
      lastLatencyMs: null,
      lastError: null,
      history: [],
      openIncident: null,
    };

    const ok = await withStoreLock(async () => {
      const data = await loadStore();
      const active = getActiveProfile(data);
      if (!active) return false;
      active.profile.monitors[id] = monitor;
      await saveStore(data);
      return true;
    });

    if (!ok) return clientError(res, 500, "No active profile");
    res.status(201).json(monitorPublicView(id, monitor));
  } catch (err) {
    console.error("[Pulseboard] create monitor failed:", err);
    clientError(res, 500, "Failed to create monitor");
  }
});

app.patch("/api/monitors/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidMonitorId(id)) return clientError(res, 404, "Monitor not found");

    const parsed = parseMonitorBody(req.body);
    if (parsed.error) return clientError(res, 400, parsed.error);

    const updated = await withStoreLock(async () => {
      const data = await loadStore();
      const mon = getMonitor(data, id);
      if (!mon) return null;
      const urlChanged = mon.url !== parsed.url;
      const expectedChanged = mon.expectedStatus !== parsed.expectedStatus;
      mon.name = parsed.name;
      mon.url = parsed.url;
      mon.intervalSec = parsed.intervalSec;
      mon.timeoutMs = parsed.timeoutMs;
      mon.expectedStatus = parsed.expectedStatus;
      if (urlChanged || expectedChanged) {
        mon.lastCheckAt = null;
        mon.lastOk = null;
        mon.lastLatencyMs = null;
        mon.lastError = null;
      }
      await saveStore(data);
      return monitorPublicView(id, mon);
    });

    if (!updated) return clientError(res, 404, "Monitor not found");
    res.json(updated);
  } catch (err) {
    console.error("[Pulseboard] update monitor failed:", err);
    clientError(res, 500, "Failed to update monitor");
  }
});

app.delete("/api/monitors/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidMonitorId(id)) return clientError(res, 404, "Monitor not found");

    const removed = await withStoreLock(async () => {
      const data = await loadStore();
      const active = getActiveProfile(data);
      if (!active) return false;
      const mon = active.profile.monitors[id];
      if (!mon) return false;
      delete active.profile.monitors[id];
      for (const [incId, inc] of Object.entries(active.profile.incidents)) {
        if (inc.monitorId === id) delete active.profile.incidents[incId];
      }
      await saveStore(data);
      return true;
    });

    if (!removed) return clientError(res, 404, "Monitor not found");
    res.json({ ok: true });
  } catch (err) {
    console.error("[Pulseboard] delete monitor failed:", err);
    clientError(res, 500, "Failed to delete monitor");
  }
});

const dist = path.join(ROOT, "client", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
}

startChecker();

app.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  const base = `http://${displayHost}:${PORT}`;
  console.log(`Pulseboard listening on ${base}`);
  if (fs.existsSync(dist)) {
    console.log(`  UI     ${base}`);
    console.log(`  Stats  ${base}/stats`);
  } else {
    console.log(`  API only — run "npm run dev" for the UI, or "npm start" to build + serve`);
  }
  console.log(`  Health ${base}/api/health`);
});
