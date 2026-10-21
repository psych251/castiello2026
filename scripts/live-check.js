#!/usr/bin/env node
/*
 * One synthetic session through the DEPLOYED chat service, before the participant site is
 * connected. It does what a participant's page does, through the same endpoints: an anonymous
 * sign-in, the questionnaire (made-up answers), then both chats in full (the opener and 12
 * made-up messages each, 24 visible messages per chat). The replies come from the real model.
 *
 *   node scripts/live-check.js --endpoint https://us-central1-<project>.cloudfunctions.net/chat --yes-write-live-data
 *
 * It only runs under the study id castiello2026-livecheck (capped at 3 sessions in
 * server/config.js), so nothing it writes can mix with Pilot A. What it writes, all of it to
 * delete afterwards:
 *   - one anonymous user in Firebase Authentication (its uid is printed)
 *   - experiments/castiello2026-livecheck/participants/<id>/private/session, .../chat/* (50
 *     records) and .../chat_events/* (only if a reply fails)
 *   - experiments/castiello2026-livecheck/private_sessions_per_uid/<uid>
 *   - experiments/castiello2026-livecheck/private_counters/sessions
 * It writes no participant document and no trials (those come from the page, which is not used).
 * No key: the sign-in uses the public web-app key in firebase-config.js, as the page does.
 *
 * --emulator runs the same session against the local emulators instead (sign-in from the Auth
 * emulator, simulated replies), to check this script itself without touching anything live:
 *   npm run dev, then: node scripts/live-check.js --emulator --endpoint http://127.0.0.1:5001/demo-psych251/us-central1/chat --yes-write-live-data
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Castiello = require(path.join(__dirname, "..", "server", "castiello.js"));

const STUDY = "castiello2026-livecheck";
const arg = (n) => { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : null; };
const EMULATOR = process.argv.includes("--emulator");
const endpoint = (arg("endpoint") || "").replace(/\/$/, "");
if (!(EMULATOR ? /^http:\/\/(127\.0\.0\.1|localhost):/ : /^https:\/\//).test(endpoint)) {
  console.error("Usage: node scripts/live-check.js --endpoint https://<region>-<project>.cloudfunctions.net/chat --yes-write-live-data");
  process.exit(1);
}
const cfgText = fs.readFileSync(path.join(__dirname, "..", "firebase-config.js"), "utf8");
const apiKey = EMULATOR ? "demo-key" : (/apiKey:\s*"([^"]+)"/.exec(cfgText) || [])[1];
const projectId = EMULATOR ? "demo-psych251 (local emulators)" : (/projectId:\s*"([^"]+)"/.exec(cfgText) || [])[1];
const AUTH = EMULATOR ? "http://127.0.0.1:9099/identitytoolkit.googleapis.com" : "https://identitytoolkit.googleapis.com";

console.log(`Deployed service: ${endpoint}`);
console.log(`Firebase project: ${projectId}   Study id: ${STUDY} (not Pilot A)`);
console.log("Writes: 1 anonymous user, 1 session, 50 chat records, 2 counters (see the top of this file).");
if (!process.argv.includes("--yes-write-live-data")) {
  console.log("\nDry run: nothing was sent. Add --yes-write-live-data to run the session.");
  process.exit(0);
}

// Made-up questionnaire answers with a clearly non-neutral profile, two items left blank, and
// the attention check answered correctly.
const bfi = {};
for (let n = 1; n <= 44; n++) if (n !== 3 && n !== 40) bfi["bfi_" + String(n).padStart(2, "0")] = [5, 4, 1, 2, 5][n % 5];
bfi[Castiello.ATTENTION_CHECK.id] = Castiello.ATTENTION_CHECK.correct;

const MESSAGES = [
  "Hi! Pretty good, thanks. Just testing things out today.",
  "Not much planned. Maybe a walk later if the weather holds.",
  "I like quiet mornings. What do you usually do on weekends?",
  "That sounds nice. I have been trying to cook more at home.",
  "Mostly pasta, nothing fancy. Do you cook?",
  "Fair enough. Have you read anything good lately?",
  "I have been meaning to start a new book but keep putting it off.",
  "Probably something light. Any recommendations?",
  "I will look that up. What kind of music do you like?",
  "I mostly listen to whatever is on while I work.",
  "True. Anyway, it was nice chatting with you.",
  "Thanks, you too. Take care!",
];

async function post(pathname, token, body) {
  const t0 = Date.now();
  const r = await fetch(endpoint + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(125000),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, body: json, ms: Date.now() - t0 };
}

(async () => {
  const health = await fetch(endpoint + "/health").then((r) => r.status).catch(() => 0);
  if (health !== 200) throw new Error("the service's /health answered " + health);

  const signUp = await fetch(`${AUTH}/v1/accounts:signUp?key=${apiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }),
  }).then((r) => r.json());
  if (!signUp.idToken) throw new Error("anonymous sign-in failed: " + JSON.stringify(signUp.error || signUp));
  const uid = signUp.localId;
  const pid = uid + "-" + Math.random().toString(36).slice(2, 10);
  console.log(`\nAnonymous user ${uid}\nParticipant id ${pid}`);
  const ids = { experiment_id: STUDY, participant_id: pid };

  const s = await post("/session", signUp.idToken, { ...ids, bfi });
  if (s.status !== 200) throw new Error("/session answered " + s.status + " " + JSON.stringify(s.body));
  console.log("Session: " + JSON.stringify(s.body) + "  (the page gets only this)");

  const times = [];
  for (const chat of s.body.chats) {
    console.log(`\n=== Chat ${chat.chat_index} with ${chat.bot_name}`);
    const turn = async (seq, text) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await post("/turn", signUp.idToken, { ...ids, chat_index: chat.chat_index, seq, text });
        if (r.status === 200) return r;
        console.log(`  message ${seq}: HTTP ${r.status} ${r.body.error || ""} (try ${attempt}; retrying as "Try again" would)`);
        if (!r.body.retryable) throw new Error("not retryable: " + JSON.stringify(r.body));
      }
      throw new Error("message " + seq + " failed three times");
    };
    let r = await turn(0, "");
    times.push({ chat: chat.chat_index, seq: 1, ms: r.ms });
    console.log(`  [1] ${chat.bot_name} (${(r.ms / 1000).toFixed(1)} s): ${r.body.reply.text}`);
    for (let k = 0; k < 12; k++) {
      const seq = 2 + 2 * k;
      r = await turn(seq, MESSAGES[k]);
      console.log(`  [${seq}] participant: ${MESSAGES[k]}`);
      if (r.body.reply) {
        times.push({ chat: chat.chat_index, seq: r.body.reply.seq, ms: r.ms });
        console.log(`  [${r.body.reply.seq}] ${chat.bot_name} (${(r.ms / 1000).toFixed(1)} s): ${r.body.reply.text}`);
      }
      if (r.body.done) { console.log(`  chat ended after message ${seq}`); break; }
    }
  }
  const sec = times.map((t) => t.ms / 1000).sort((a, b) => a - b);
  console.log(`\nReplies: ${sec.length}; seconds, median ${sec[Math.floor(sec.length / 2)].toFixed(1)}, slowest ${sec[sec.length - 1].toFixed(1)} (round trip from this computer)`);
  console.log(`Done. To clean up later: Authentication user ${uid}, and the collection experiments/${STUDY}.`);
})().catch((e) => { console.error("\nLive check stopped: " + e.message); process.exit(1); });
