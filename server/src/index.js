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
  isValidMonitorId,
  withStoreLock,
  monitorPublicView,
  statusPublicView,
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
    version: "1.0.0",
    alertWebhook: Boolean(ALERT_WEBHOOK),
    publicBaseUrl: PUBLIC_BASE_URL || null,
  });
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
    const list = Object.entries(data.monitors)
      .map(([id, mon]) => monitorPublicView(id, mon))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ monitors: list });
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

    await withStoreLock(async () => {
      const data = await loadStore();
      data.monitors[id] = monitor;
      await saveStore(data);
    });

    res.status(201).json(monitorPublicView(id, monitor));
  } catch (err) {
    console.error("[Pulseboard] create monitor failed:", err);
    clientError(res, 500, "Failed to create monitor");
  }
});

app.delete("/api/monitors/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidMonitorId(id)) return clientError(res, 404, "Monitor not found");

    const removed = await withStoreLock(async () => {
      const data = await loadStore();
      const mon = getMonitor(data, id);
      if (!mon) return false;
      delete data.monitors[id];
      for (const [incId, inc] of Object.entries(data.incidents)) {
        if (inc.monitorId === id) delete data.incidents[incId];
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
