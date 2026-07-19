#!/usr/bin/env node
/**
 * Production-style run: build UI if needed, then serve API + static UI on :5060.
 * Usage: npm start
 *        npm start -- --no-open
 *        npm start -- --rebuild
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distIndex = path.join(root, "client", "dist", "index.html");
const openBrowser = !process.argv.includes("--no-open");
const forceRebuild = process.argv.includes("--rebuild");
const port = Number(process.env.PORT) || 5060;
const host = process.env.HOST || "127.0.0.1";
const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
const base = `http://${displayHost}:${port}`;

function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
      ...opts,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function waitHealth(url, timeoutMs = 30000) {
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
      setTimeout(attempt, 250);
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

if (forceRebuild || !fs.existsSync(distIndex)) {
  console.log("[pulseboard] Building UI…");
  await run("npm", ["run", "build", "--prefix", "client"]);
}

console.log("");
console.log("  Pulseboard");
console.log("  ──────────");
console.log(`  App    ${base}`);
console.log(`  Stats  ${base}/stats`);
console.log(`  Health ${base}/api/health`);
console.log("  Press Ctrl+C to stop");
console.log("");

const server = spawn("npm", ["run", "start", "--prefix", "server"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

const shutdown = () => {
  try {
    server.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.on("exit", (code) => process.exit(code ?? 0));

try {
  await waitHealth(`${base}/api/health`);
  if (openBrowser) {
    openUrl(base);
    console.log(`[pulseboard] Opening ${base}`);
  }
} catch (err) {
  console.error(`[pulseboard] ${err.message}`);
  shutdown();
}
