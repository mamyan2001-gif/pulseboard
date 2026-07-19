#!/usr/bin/env node
/**
 * One-command local development: API (:5060) + Vite UI (:5175).
 * Usage: npm run dev
 *        npm run dev -- --no-open
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const openBrowser = !process.argv.includes("--no-open");
const API = "http://127.0.0.1:5060";
const UI = "http://127.0.0.1:5175";
const children = [];
let shuttingDown = false;

function log(msg) {
  console.log(msg);
}

function run(label, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (signal) {
      log(`[pulseboard] ${label} stopped (${signal})`);
    } else if (code && code !== 0) {
      log(`[pulseboard] ${label} exited with code ${code}`);
      shutdown(code);
    }
  });
  children.push(child);
  return child;
}

function waitHealth(url, timeoutMs = 45000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on("error", retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };
    function retry() {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(attempt, 300);
    }
    attempt();
  });
}

function openUrl(url) {
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* ignore */
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 200);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

log("");
log("  Pulseboard — local development");
log("  ─────────────────────────────");
log(`  API  ${API}`);
log(`  UI   ${UI}`);
log(`  Stats ${UI}/stats`);
log("  Press Ctrl+C to stop");
log("");

run("api", "npm", ["run", "dev", "--prefix", "server"]);
run("ui", "npm", ["run", "dev", "--prefix", "client"]);

try {
  await waitHealth(`${API}/api/health`);
  log(`[pulseboard] API ready`);
  if (openBrowser) {
    openUrl(UI);
    log(`[pulseboard] Opening ${UI}`);
  }
} catch (err) {
  log(`[pulseboard] ${err.message}`);
  log("[pulseboard] Is port 5060 free? Try: lsof -iTCP:5060");
  shutdown(1);
}
