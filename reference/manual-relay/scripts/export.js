#!/usr/bin/env node
/*
 * Export Firestore data to tidy CSV (plus a raw JSON dump).
 *
 *   npm run export -- --experiment framing-demo
 *   npm run export -- --experiment framing-demo --key ~/keys/my-project-service-account.json --out data/raw
 *
 * Authentication: the Admin SDK needs a service-account key for YOUR project.
 *   Firebase console -> Project settings -> Service accounts -> "Generate new private key".
 * Save it OUTSIDE the repo (or at a gitignored path; *service-account*.json is ignored) and
 * pass --key, or set GOOGLE_APPLICATION_CREDENTIALS to its path.
 * The key bypasses security rules and can read/delete everything. Never commit it.
 *
 * Output (in --out, default data/raw/<experiment>/):
 *   participants.csv   one row per participant (start/end, completed, condition, browser, ...)
 *   trials.csv         one row per jsPsych trial, long format; nested values are JSON strings
 *   errors.csv         client-side error reports
 *   export.json        the above, verbatim, for safekeeping
 *   identifiers.csv    participant_id -> Prolific ids and raw URL parameters. GITIGNORED.
 *                      Prolific ids are persistent identifiers; keep this file private and
 *                      use it only to approve/pay participants or reconcile duplicates.
 *   messages.csv       one row per chat message, both sides (relay chat), with timing and
 *                      length but NOT the text. Safe to commit.
 *   transcripts.csv    the same rows WITH the text, from the relay's own records (so it
 *                      includes chats that were abandoned). GITIGNORED: participants may type
 *                      anything, including identifying details. The chat trial rows in
 *                      trials.csv have their transcript text removed for the same reason.
 */
const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const experimentId = arg("experiment", null);
const keyPath = arg("key", process.env.GOOGLE_APPLICATION_CREDENTIALS);
const emulator = process.argv.includes("--emulator");
if (!experimentId) {
  console.error("Usage: npm run export -- --experiment <id> [--key <service-account.json>] [--out <dir>] [--emulator]");
  process.exit(1);
}
const outDir = arg("out", path.join("data", "raw", experimentId));

const admin = require("firebase-admin");
if (emulator) {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
  admin.initializeApp({ projectId: "demo-psych251" });
} else {
  if (!keyPath || !fs.existsSync(keyPath)) {
    console.error("No service-account key. Pass --key <path> or set GOOGLE_APPLICATION_CREDENTIALS.");
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(keyPath, "utf8"))) });
}
const db = admin.firestore();

function plain(v) {
  // Firestore Timestamps -> ISO strings; everything else as-is.
  if (v && typeof v.toDate === "function") return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = plain(v[k]);
    return o;
  }
  return v;
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCsv(file, rows, firstColumns) {
  const cols = [...(firstColumns || [])];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  fs.writeFileSync(file, lines.join("\n") + "\n");
  console.log(`  ${path.relative(process.cwd(), file)}: ${rows.length} rows`);
}

(async () => {
  const expRef = db.collection("experiments").doc(experimentId);
  const participantsSnap = await expRef.collection("participants").get();
  if (participantsSnap.empty) {
    console.error(`No participants found under experiments/${experimentId}. Check the experiment id (EXPERIMENT.id in experiment.js).`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const participants = [];
  const identifiers = [];
  const trials = [];
  const transcripts = [];
  const dump = { experiment_id: experimentId, exported_at: new Date().toISOString(), participants: [] };

  for (const pDoc of participantsSnap.docs) {
    const p = plain(pDoc.data());
    const uid = pDoc.id;
    const chunksSnap = await pDoc.ref.collection("trials").orderBy("chunk_index").get();
    const chunks = chunksSnap.docs.map((c) => plain(c.data()));
    let pTrials = chunks.flatMap((c) => c.trials || []);
    let source = "chunks";
    if (pTrials.length === 0 && typeof p.full_data === "string") {
      // No chunk writes reached the server (e.g. quota or network), but the final document did.
      pTrials = JSON.parse(p.full_data);
      source = "full_data";
    } else if (typeof p.full_data === "string") {
      const n = JSON.parse(p.full_data).length;
      if (n !== pTrials.length) console.warn(`  warning: ${uid}: ${pTrials.length} trials in chunks but ${n} in full_data (using chunks)`);
    }
    pTrials.sort((a, b) => (a.trial_index ?? 0) - (b.trial_index ?? 0));

    // Identifiers go to a separate, gitignored file; everything committed stays anonymous.
    const { full_data, prolific_pid, prolific_study_id, prolific_session_id, url_params, ...rest } = p;
    identifiers.push({ participant_id: uid, prolific_pid, prolific_study_id, prolific_session_id,
      url_params, started_at: rest.started_at, completed: rest.completed });
    // Relay chat: both sides, from the messages/replies subcollections.
    const conditionOf = (chat) => p["chat" + chat + "_condition"] || null;
    const msgSnap = await pDoc.ref.collection("messages").get();
    const repSnap = await pDoc.ref.collection("replies").get();
    const chatRows = [
      ...msgSnap.docs.map((d) => plain(d.data())).map((m) => ({
        participant_id: uid, chat_index: m.chat_index, bot_name: m.bot_name, bot_condition: conditionOf(m.chat_index),
        seq: m.seq, from: m.from, kind: m.kind, text: m.text,
        client_sent_at: m.client_sent_at, sent_at: m.sent_at })),
      ...repSnap.docs.map((d) => plain(d.data())).map((r) => ({
        participant_id: uid, chat_index: r.chat_index, bot_name: r.bot_name, bot_condition: r.bot_condition || conditionOf(r.chat_index),
        seq: r.seq, from: "bot", kind: "reply", text: r.text, reply_to_seq: r.reply_to_seq,
        request_sent_at: r.request_sent_at, request_received_at: r.request_received_at,
        operator_submitted_at: r.operator_submitted_at, submitted_at: r.submitted_at, relay_service: r.relay_service })),
    ].sort((a, b) => a.chat_index - b.chat_index || a.seq - b.seq);
    transcripts.push(...chatRows);

    // participant_id comes from the document path, never from the trial row: if an
    // experiment sets its own participant_id the two must not disagree, or trials.csv
    // and participants.csv will not join. Chat transcripts are dropped from the public rows.
    const pubTrials = pTrials.map(({ prolific_pid, participant_id, transcript, ...t }) => {
      if (Array.isArray(transcript)) {
        t.participant_chars = transcript.filter((m) => m.from === "participant").reduce((n, m) => n + String(m.text || "").length, 0);
      }
      return t;
    });
    participants.push({ participant_id: uid, ...rest, n_trials_exported: pubTrials.length, trials_source: source });
    for (const t of pubTrials) trials.push({ participant_id: uid, ...t });
    dump.participants.push({ participant_id: uid, participant: rest, trials: pubTrials, n_chunks: chunks.length,
      chat_messages: chatRows.map(({ text, ...m }) => ({ ...m, n_chars: String(text || "").length })) });
  }

  const errorsSnap = await expRef.collection("errors").orderBy("at").get().catch(() => expRef.collection("errors").get());
  const errors = errorsSnap.docs.map((d) => {
    const e = plain(d.data());
    if (typeof e.url === "string") e.url = e.url.split("?")[0]; // drop query string (may hold Prolific ids)
    return { error_id: d.id, ...e };
  });
  dump.errors = errors;

  console.log(`Exported experiments/${experimentId}:`);
  writeCsv(path.join(outDir, "participants.csv"), participants,
    ["participant_id", "completed", "condition", "started_at", "ended_at", "n_trials"]);
  writeCsv(path.join(outDir, "trials.csv"), trials,
    ["participant_id", "trial_index", "task", "condition", "trial_type", "rt", "response", "time_elapsed"]);
  writeCsv(path.join(outDir, "errors.csv"), errors, ["error_id", "uid", "at", "message", "trial_index"]);
  const chatCols = ["participant_id", "chat_index", "bot_name", "bot_condition", "seq", "from", "kind"];
  writeCsv(path.join(outDir, "messages.csv"), transcripts.map(({ text, ...m }) => ({ ...m, n_chars: String(text || "").length })), chatCols);
  writeCsv(path.join(outDir, "transcripts.csv"), transcripts, [...chatCols, "text"]);
  console.log("  transcripts.csv is gitignored: it holds what participants typed. Keep it private.");
  fs.writeFileSync(path.join(outDir, "export.json"), JSON.stringify(dump, null, 2));
  console.log(`  ${path.relative(process.cwd(), path.join(outDir, "export.json"))}`);
  writeCsv(path.join(outDir, "identifiers.csv"), identifiers, ["participant_id", "prolific_pid", "prolific_study_id", "prolific_session_id"]);
  console.log("  identifiers.csv is gitignored: it links participant ids to Prolific ids. Keep it private.");
  const done = participants.filter((p) => p.completed).length;
  console.log(`${participants.length} participants (${done} completed), ${trials.length} trials, ${errors.length} error reports.`);
  process.exit(0);
})().catch((e) => {
  console.error("Export failed:", e.message || e);
  process.exit(1);
});
