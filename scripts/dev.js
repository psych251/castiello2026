#!/usr/bin/env node
// `npm run dev`: run inside `firebase emulators:exec` (see package.json), which has already
// started the Auth, Firestore and Functions emulators; the chat service runs in the Functions
// emulator with the simulated model (server/.env.local). This serves the site, emulator-only,
// and stops on Ctrl+C.
const { spawn } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const port = process.env.PORT || "8000";
const site = spawn(process.execPath, [path.join(root, "scripts", "serve.js")], { stdio: "inherit", env: { ...process.env, PORT: port, EMULATOR_ONLY: "1" } });
setTimeout(() => {
  console.log("\nLocal prototype (Cloud Function in the emulator, simulated replies; nothing reaches live Firebase or a real model):");
  console.log("  http://localhost:" + port + "/?emulator=1\n");
  console.log("Press Ctrl+C to stop. (Ctrl+Z only suspends it and keeps the ports busy.)");
}, 1000);
const stop = () => { site.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
site.on("exit", (code) => { if (code) { console.error("the site server exited with code " + code); process.exit(code); } });
