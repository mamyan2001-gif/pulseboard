import { nanoid } from "nanoid";
import {
  loadStore,
  saveStore,
  withStoreLock,
  getActiveProfile,
  HISTORY_LIMIT,
} from "./store.js";

const TICK_MS = 10_000;

function getAlertWebhook() {
  const url = (process.env.ALERT_WEBHOOK || "").trim();
  return url || null;
}

async function postAlert({ monitor, status, message }) {
  const webhook = getAlertWebhook();
  if (!webhook) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ monitor, status, message }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.error("[Pulseboard] alert webhook failed:", err.message);
  }
}

async function checkOnce(url, timeoutMs) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Pulseboard/1.0 (+https://github.com/pulseboard)",
        Accept: "*/*",
      },
    });
    const latencyMs = Date.now() - started;
    try {
      res.body?.cancel?.();
    } catch {
      /* ignore */
    }
    return { okHttp: true, statusCode: res.status, latencyMs, error: null };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message =
      err?.name === "AbortError" ? "Request timed out" : String(err?.message || err);
    return { okHttp: false, statusCode: null, latencyMs, error: message.slice(0, 500) };
  } finally {
    clearTimeout(timer);
  }
}

function isDue(mon, now) {
  if (!mon.lastCheckAt) return true;
  const last = Date.parse(mon.lastCheckAt);
  if (Number.isNaN(last)) return true;
  return now - last >= mon.intervalSec * 1000;
}

export async function runDueChecks() {
  const now = Date.now();
  const snapshot = await loadStore();
  const active = getActiveProfile(snapshot);
  if (!active) return;

  const profileId = active.id;
  const due = Object.entries(active.profile.monitors).filter(([, mon]) => isDue(mon, now));
  if (!due.length) return;

  for (const [id, mon] of due) {
    const result = await checkOnce(mon.url, mon.timeoutMs);
    const ok = result.okHttp && result.statusCode === mon.expectedStatus;
    const error = ok
      ? null
      : result.error ||
        `Expected status ${mon.expectedStatus}, got ${result.statusCode ?? "none"}`;
    const checkedAt = new Date().toISOString();

    const alertPayload = await withStoreLock(async () => {
      const data = await loadStore();
      const currentActive = getActiveProfile(data);
      if (!currentActive || currentActive.id !== profileId) return null;
      const current = currentActive.profile.monitors[id];
      if (!current) return null;

      const entry = {
        at: checkedAt,
        ok,
        latencyMs: result.latencyMs,
        statusCode: result.statusCode,
        error,
      };
      const history = [...(current.history || []), entry].slice(-HISTORY_LIMIT);

      let openIncident = current.openIncident || null;
      let alert = null;

      if (!ok && !openIncident) {
        const incidentId = nanoid(12);
        openIncident = {
          id: incidentId,
          openedAt: checkedAt,
          message: error || "Monitor failed",
        };
        currentActive.profile.incidents[incidentId] = {
          id: incidentId,
          monitorId: id,
          openedAt: checkedAt,
          closedAt: null,
          message: openIncident.message,
          status: "open",
        };
        alert = {
          monitor: { id, name: current.name, url: current.url },
          status: "down",
          message: openIncident.message,
        };
      } else if (ok && openIncident) {
        const closedId = openIncident.id;
        if (
          closedId &&
          Object.prototype.hasOwnProperty.call(currentActive.profile.incidents, closedId)
        ) {
          currentActive.profile.incidents[closedId].closedAt = checkedAt;
          currentActive.profile.incidents[closedId].status = "closed";
        }
        alert = {
          monitor: { id, name: current.name, url: current.url },
          status: "up",
          message: `Recovered after incident opened at ${openIncident.openedAt}`,
        };
        openIncident = null;
      }

      currentActive.profile.monitors[id] = {
        ...current,
        lastCheckAt: checkedAt,
        lastOk: ok,
        lastLatencyMs: result.latencyMs,
        lastError: error,
        history,
        openIncident,
      };

      await saveStore(data);
      return alert;
    });

    if (alertPayload) {
      await postAlert(alertPayload);
    }
  }
}

export function startChecker() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueChecks();
    } catch (err) {
      console.error("[Pulseboard] checker error:", err.message);
    } finally {
      running = false;
    }
  };
  tick();
  const handle = setInterval(tick, TICK_MS);
  handle.unref?.();
  return handle;
}
