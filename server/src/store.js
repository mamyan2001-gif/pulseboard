import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../..");
export const DATA_DIR = path.join(ROOT, "data");
export const META_FILE = path.join(DATA_DIR, "pulseboard.json");

const MONITOR_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const HISTORY_LIMIT = 100;

let writeChain = Promise.resolve();

/** Serialize all metadata reads/writes to avoid lost updates. */
export function withStoreLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function isValidMonitorId(id) {
  return typeof id === "string" && MONITOR_ID_RE.test(id);
}

export async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(META_FILE);
  } catch {
    await fs.writeFile(
      META_FILE,
      JSON.stringify({ monitors: {}, incidents: {} }, null, 2),
      "utf8",
    );
  }
}

function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h) => h && typeof h === "object")
    .slice(-HISTORY_LIMIT)
    .map((h) => ({
      at: String(h.at || ""),
      ok: Boolean(h.ok),
      latencyMs: Number.isFinite(Number(h.latencyMs)) ? Number(h.latencyMs) : null,
      statusCode:
        h.statusCode == null || !Number.isFinite(Number(h.statusCode))
          ? null
          : Number(h.statusCode),
      error: typeof h.error === "string" ? h.error.slice(0, 500) : null,
    }));
}

function normalizeIncident(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: typeof raw.id === "string" ? raw.id : null,
    openedAt: typeof raw.openedAt === "string" ? raw.openedAt : null,
    message: typeof raw.message === "string" ? raw.message.slice(0, 500) : "",
  };
}

function normalizeMonitor(raw) {
  if (!raw || typeof raw !== "object") return null;
  const intervalSec = Math.min(Math.max(Number(raw.intervalSec) || 60, 30), 3600);
  const timeoutMs = Math.min(Math.max(Number(raw.timeoutMs) || 5000, 500), 60000);
  const expectedStatus = Math.min(Math.max(Number(raw.expectedStatus) || 200, 100), 599);
  return {
    name: typeof raw.name === "string" ? raw.name.trim().slice(0, 120) : "Monitor",
    url: typeof raw.url === "string" ? raw.url.trim().slice(0, 2048) : "",
    intervalSec,
    timeoutMs,
    expectedStatus,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    lastCheckAt: typeof raw.lastCheckAt === "string" ? raw.lastCheckAt : null,
    lastOk: raw.lastOk == null ? null : Boolean(raw.lastOk),
    lastLatencyMs:
      raw.lastLatencyMs == null || !Number.isFinite(Number(raw.lastLatencyMs))
        ? null
        : Number(raw.lastLatencyMs),
    lastError: typeof raw.lastError === "string" ? raw.lastError.slice(0, 500) : null,
    history: normalizeHistory(raw.history),
    openIncident: normalizeIncident(raw.openIncident),
  };
}

function normalizeMonitors(raw) {
  const monitors = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return monitors;
  for (const [id, mon] of Object.entries(raw)) {
    if (!isValidMonitorId(id)) continue;
    const normalized = normalizeMonitor(mon);
    if (normalized && normalized.url) monitors[id] = normalized;
  }
  return monitors;
}

function normalizeIncidents(raw) {
  const incidents = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return incidents;
  for (const [id, inc] of Object.entries(raw)) {
    if (!isValidMonitorId(id) || !inc || typeof inc !== "object") continue;
    if (!isValidMonitorId(inc.monitorId)) continue;
    incidents[id] = {
      id,
      monitorId: inc.monitorId,
      openedAt: typeof inc.openedAt === "string" ? inc.openedAt : null,
      closedAt: typeof inc.closedAt === "string" ? inc.closedAt : null,
      message: typeof inc.message === "string" ? inc.message.slice(0, 500) : "",
      status: inc.status === "closed" ? "closed" : "open",
    };
  }
  return incidents;
}

export async function loadStore() {
  await ensureDirs();
  let raw;
  try {
    raw = await fs.readFile(META_FILE, "utf8");
  } catch {
    return { monitors: Object.create(null), incidents: Object.create(null) };
  }
  try {
    const data = JSON.parse(raw);
    return {
      monitors: normalizeMonitors(data?.monitors),
      incidents: normalizeIncidents(data?.incidents),
    };
  } catch (err) {
    console.error("[Pulseboard] corrupt pulseboard.json, starting empty:", err.message);
    return { monitors: Object.create(null), incidents: Object.create(null) };
  }
}

export async function saveStore(data) {
  await ensureDirs();
  const payload = {
    monitors: normalizeMonitors(data?.monitors),
    incidents: normalizeIncidents(data?.incidents),
  };
  const tmp = `${META_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, META_FILE);
}

export function getMonitor(data, id) {
  if (!isValidMonitorId(id)) return null;
  if (!Object.prototype.hasOwnProperty.call(data.monitors, id)) return null;
  return data.monitors[id];
}

export function computeUptimeStats(history) {
  const checks = Array.isArray(history) ? history : [];
  const total = checks.length;
  if (total === 0) {
    return {
      samples: 0,
      upCount: 0,
      downCount: 0,
      uptimePercent: null,
      avgLatencyMs: null,
      minLatencyMs: null,
      maxLatencyMs: null,
      windowFrom: null,
      windowTo: null,
    };
  }

  let upCount = 0;
  const latencies = [];
  for (const h of checks) {
    if (h.ok) {
      upCount += 1;
      if (Number.isFinite(h.latencyMs)) latencies.push(h.latencyMs);
    }
  }
  const downCount = total - upCount;
  const uptimePercent = Math.round((upCount / total) * 10000) / 100;

  let avgLatencyMs = null;
  let minLatencyMs = null;
  let maxLatencyMs = null;
  if (latencies.length) {
    const sum = latencies.reduce((a, b) => a + b, 0);
    avgLatencyMs = Math.round(sum / latencies.length);
    minLatencyMs = Math.min(...latencies);
    maxLatencyMs = Math.max(...latencies);
  }

  const times = checks.map((h) => h.at).filter(Boolean);
  return {
    samples: total,
    upCount,
    downCount,
    uptimePercent,
    avgLatencyMs,
    minLatencyMs,
    maxLatencyMs,
    windowFrom: times[0] || null,
    windowTo: times[times.length - 1] || null,
  };
}

export function monitorPublicView(id, mon) {
  return {
    id,
    name: mon.name,
    url: mon.url,
    intervalSec: mon.intervalSec,
    timeoutMs: mon.timeoutMs,
    expectedStatus: mon.expectedStatus,
    createdAt: mon.createdAt,
    lastCheckAt: mon.lastCheckAt,
    lastOk: mon.lastOk,
    lastLatencyMs: mon.lastLatencyMs,
    lastError: mon.lastError,
    stats: computeUptimeStats(mon.history),
    openIncident: mon.openIncident
      ? {
          id: mon.openIncident.id,
          openedAt: mon.openIncident.openedAt,
          message: mon.openIncident.message,
        }
      : null,
    history: (mon.history || []).slice(-20).map((h) => ({
      at: h.at,
      ok: h.ok,
      latencyMs: h.latencyMs,
      statusCode: h.statusCode,
    })),
  };
}

export function statusPublicView(data) {
  const monitors = [];
  let down = 0;
  let sampleSum = 0;
  let upSum = 0;
  for (const [id, mon] of Object.entries(data.monitors)) {
    if (mon.lastOk === false) down += 1;
    const stats = computeUptimeStats(mon.history);
    sampleSum += stats.samples;
    upSum += stats.upCount;
    monitors.push({
      id,
      name: mon.name,
      url: mon.url,
      lastCheckAt: mon.lastCheckAt,
      lastOk: mon.lastOk,
      lastLatencyMs: mon.lastLatencyMs,
      stats,
      openIncident: mon.openIncident
        ? {
            openedAt: mon.openIncident.openedAt,
            message: mon.openIncident.message,
          }
        : null,
    });
  }
  monitors.sort((a, b) => a.name.localeCompare(b.name));
  const up = monitors.filter((m) => m.lastOk === true).length;
  const pending = monitors.length - up - down;
  const overall =
    monitors.length === 0
      ? "unknown"
      : down > 0
        ? "down"
        : up === monitors.length
          ? "up"
          : "pending";
  const overallUptime =
    sampleSum > 0 ? Math.round((upSum / sampleSum) * 10000) / 100 : null;
  return {
    overall,
    checkedAt: new Date().toISOString(),
    total: monitors.length,
    down,
    up,
    pending,
    stats: {
      samples: sampleSum,
      upCount: upSum,
      downCount: sampleSum - upSum,
      uptimePercent: overallUptime,
    },
    monitors,
  };
}

export { HISTORY_LIMIT };
