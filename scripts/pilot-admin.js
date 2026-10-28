#!/usr/bin/env node
/*
 * Researcher controls for the chat service, through the Admin SDK (added 2026-10-27).
 *
 *   Invites (for a study with invite_only in server/config.js):
 *     npm run pilot-admin -- invite  --experiment <id> --label T01 [--uses 1]
 *         Makes one invite and prints its link ONCE. Only a hash of the code is stored, so a
 *         lost link cannot be recovered: revoke it and make another. Labels name testers in
 *         your own records; keep the label-to-person list private and out of the repository.
 *     npm run pilot-admin -- invites --experiment <id>         labels, uses, revoked (no codes)
 *     npm run pilot-admin -- revoke  --experiment <id> --label T01
 *
 *   Pause (checked by the service on every request and before every model call; no redeploy):
 *     npm run pilot-admin -- pause   [--experiment <id> | --all] [--reason "..."]
 *     npm run pilot-admin -- resume  [--experiment <id> | --all]
 *     npm run pilot-admin -- status  [--experiment <id>]
 *
 * Connection, as for scripts/export.js:
 *   --emulator                                   the local emulators (npm run dev)
 *   --adc --project <firebase project id>        application default credentials; with
 *                                                CLOUDSDK_CONFIG set, its credentials file is used
 * Every command but invites/status writes to that database. Nothing here reads chat text.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name, fallback = null) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes("--" + name);
const PAGE = arg("page", "https://psych251.github.io/castiello2026/");

function usage(msg) {
  if (msg) console.error(msg);
  console.error("Usage: npm run pilot-admin -- <invite|invites|revoke|pause|resume|status> [options] (--emulator | --adc --project <id>)");
  process.exit(2);
}

if (flag("emulator") === flag("adc")) usage("Give exactly one of --emulator or --adc --project <id>.");
if (flag("emulator")) {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  admin.initializeApp({ projectId: "demo-psych251" });
} else {
  const projectId = arg("project");
  if (!projectId) usage("--adc needs --project <firebase project id>.");
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.CLOUDSDK_CONFIG) {
    const file = path.join(process.env.CLOUDSDK_CONFIG, "application_default_credentials.json");
    if (!fs.existsSync(file)) usage("No credentials in CLOUDSDK_CONFIG. Run: gcloud auth application-default login");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
  }
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId });
}
const db = admin.firestore();
const config = require("../server/config.js");

function needExperiment() {
  const id = arg("experiment");
  if (!id || !config.experiments[id]) usage("--experiment must be one of: " + Object.keys(config.experiments).join(", "));
  return id;
}
const invitesOf = (exp) => db.collection("experiments").doc(exp).collection("private_invites");
const pauseRef = (exp) => (exp ? db.collection("experiments").doc(exp).collection("private_control").doc("pause") : db.collection("chat_control").doc("global"));

(async () => {
  if (cmd === "invite") {
    const exp = needExperiment();
    const label = arg("label");
    if (!label || !/^[A-Za-z0-9_-]{1,40}$/.test(label)) usage("--label: letters, digits, - or _ (e.g. T01). Not a person's name.");
    const existing = await invitesOf(exp).where("label", "==", label).get();
    if (!existing.empty) usage(`An invite labelled ${label} already exists for ${exp}. Use another label, or revoke it first.`);
    const uses = Number(arg("uses", "1"));
    if (!Number.isInteger(uses) || uses < 1 || uses > 5) usage("--uses must be 1 to 5.");
    const code = crypto.randomBytes(18).toString("base64url");
    const hash = crypto.createHash("sha256").update(code).digest("hex");
    await invitesOf(exp).doc(hash).create({ label, max_uses: uses, uses: 0, revoked: false, created_at: new Date().toISOString() });
    console.log(`Invite ${label} for ${exp} (${uses} use${uses > 1 ? "s" : ""}). This link is shown once; send it privately:`);
    console.log(`  ${PAGE}?invite=${code}`);
  } else if (cmd === "invites") {
    const exp = needExperiment();
    const snap = await invitesOf(exp).get();
    for (const d of snap.docs.map((x) => x.data()).sort((a, b) => String(a.label).localeCompare(String(b.label)))) {
      console.log(`  ${d.label}: ${d.uses || 0}/${d.max_uses} used${d.revoked ? ", REVOKED" : ""}, created ${d.created_at}`);
    }
    if (snap.empty) console.log("  (no invites)");
  } else if (cmd === "revoke") {
    const exp = needExperiment();
    const label = arg("label");
    const snap = await invitesOf(exp).where("label", "==", label).get();
    if (snap.empty) usage(`No invite labelled ${label} for ${exp}.`);
    for (const d of snap.docs) await d.ref.set({ revoked: true, revoked_at: new Date().toISOString() }, { merge: true });
    console.log(`Revoked ${label} for ${exp}.`);
  } else if (cmd === "pause" || cmd === "resume") {
    if (!flag("all") && !arg("experiment")) usage("Give --experiment <id> or --all.");
    const exp = flag("all") ? null : needExperiment();
    await pauseRef(exp).set({ paused: cmd === "pause", reason: arg("reason"), at: new Date().toISOString() }, { merge: true });
    console.log(`${cmd === "pause" ? "Paused" : "Resumed"}: ${exp || "ALL studies (global switch)"}.` +
      (cmd === "resume" && exp ? " (The global switch, if on, still pauses everything.)" : ""));
  } else if (cmd === "status") {
    const g = await pauseRef(null).get();
    console.log(`  global: ${g.exists && g.data().paused ? "PAUSED" : "not paused"}`);
    for (const exp of arg("experiment") ? [needExperiment()] : Object.keys(config.experiments)) {
      const s = await pauseRef(exp).get();
      const c = config.experiments[exp];
      const set = s.exists && typeof s.data().paused === "boolean";
      const state = set ? (s.data().paused ? "PAUSED" : "not paused") : c.default_paused ? "PAUSED (by default: never resumed)" : "not paused";
      console.log(`  ${exp}: ${state}; local config open=${c.open === true}, max_sessions=${c.max_sessions}` +
        (c.invite_only ? ", invite only" : ""));
    }
    console.log("  (open and max_sessions are this checkout's server/config.js; the deployed function has whatever was deployed.)");
  } else {
    usage();
  }
  process.exit(0);
})().catch((e) => { console.error("Failed:", e.code || "", e.message || e); process.exit(1); });
