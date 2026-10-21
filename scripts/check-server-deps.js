#!/usr/bin/env node
/*
 * Runs before `npm test` and `npm run dev`. The functions emulator loads the chat service from
 * server/, which has its own dependencies (server/package.json). `npm install` at the top level
 * does not install them, so on a fresh clone the emulator would fail to load the function. This
 * installs them only if they are missing.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const server = path.join(__dirname, "..", "server");
if (fs.existsSync(path.join(server, "node_modules", "firebase-functions"))) {
  console.log("[server] chat service dependencies are installed.");
} else {
  console.log("[server] installing the chat service's dependencies (server/package.json)...");
  execSync("npm install --no-audit --no-fund", { cwd: server, stdio: "inherit" });
}
