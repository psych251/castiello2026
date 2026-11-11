#!/usr/bin/env node
/*
 * Exploratory sentiment ratings for the main study (not preregistered; added after the midterm
 * feedback, with the TA's agreement, 2026-11-07). It applies the original paper's classifier
 * (Castiello et al., Methods, "Sentiment Analysis": GPT-4 with the system prompt below, one label
 * per message) to every visible message, using the same Gemini model and Vertex AI project that
 * ran the chats. Run by the researcher on their own computer. It signs in with Application
 * Default Credentials (`gcloud auth application-default login`), so no key is passed, printed or
 * stored. The calls go through the chat service's own Gemini code (server/gemini.js): one request
 * per attempt, the SDK's retries off, and the model's default generation settings, as in the chats.
 *
 * 1. Test: the paper's four example sentences only, with no study data:
 *      node scripts/rate-sentiment.js --test --project P --location L --model M --yes-call-the-model
 * 2. The study:
 *      node scripts/rate-sentiment.js --transcripts <private transcripts.csv>
 *        --pseudonyms <private pseudonym map> --cache <private .jsonl>
 *        --out data/raw/<id>/sentiment.csv --project P --location L --model M --yes-call-the-model
 *
 * Without --yes-call-the-model nothing is sent or written. It prints what a run would send.
 *
 * Each request contains only the system prompt and the text of one message: no ids, no other
 * message, no chat history.
 * The output holds no text. Per visible message (seq 0 left out) it has: the pseudonymous
 * participant id, chat, condition, seq, sender, the label, counts of "!", "?" and emoji
 * (computed here, with no model), and the model version Google reports. Like
 * disclosure_review.csv, it can be committed.
 * The cache is private (it is keyed by the raw participant id) and lets an interrupted run
 * resume without paying for the same message twice.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const server = path.join(__dirname, "..", "server");
const { createModel } = require(path.join(server, "models.js"));

// The paper's system prompt, verbatim (Methods, "Sentiment Analysis").
const SYSTEM_PROMPT =
  "Analyze the sentiment of messages. Given a message, classify it as positive, negative, neutral, " +
  "or mixed. Return just the sentiment of the message. Do not return anything else. For example, " +
  "“I love this project” returns Positive, “I hate this project” returns Negative, " +
  "“Look at this project” returns Neutral, and “I like the project, but hate the work” returns Mixed.";
const LABELS = ["positive", "negative", "neutral", "mixed"];
const TEST_SENTENCES = ["I love this project", "I hate this project", "Look at this project", "I like the project, but hate the work"];
const ATTEMPTS = 3;          // per message, for errors and for answers that are not one of LABELS
const CONCURRENCY = 6;
const TIMEOUT_MS = 30000;

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const flag = (name) => process.argv.includes("--" + name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// RFC 4180: quoted fields may hold commas, doubled quotes and line breaks.
function readCsv(file) {
  const s = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const rows = [];
  let row = [], f = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

function normalise(text) {
  const t = String(text || "").trim().replace(/^[\s"'“”*]+|[\s"'“”*.!]+$/g, "").toLowerCase();
  return LABELS.includes(t) ? t : null;
}

const count = (text, re) => (String(text).match(re) || []).length;

function tokensFrom(line) {   // gemini.js logs "tokens in X out Y thinking Z"; never any text
  const m = /tokens in (\d+) out (\d+) thinking (\d+)/.exec(line || "");
  return m ? { in: +m[1], out: +m[2], thinking: +m[3] } : null;
}

const project = arg("project"), location = arg("location"), modelId = arg("model");
const test = flag("test");
const go = flag("yes-call-the-model");
if (!project || !location || !modelId) {
  console.error("Usage: see the comment at the top of scripts/rate-sentiment.js");
  process.exit(1);
}

// ---- what would be sent ---------------------------------------------------------------------
let items;
if (test) {
  items = TEST_SENTENCES.map((text, i) => ({ key: "test-" + i, text }));
} else {
  const need = ["transcripts", "pseudonyms", "cache", "out"].filter((n) => !arg(n));
  if (need.length) { console.error("Missing: --" + need.join(", --")); process.exit(1); }
  const label = new Map(readCsv(arg("pseudonyms")).map((r) => [r.participant_id, r.label]));
  const rows = readCsv(arg("transcripts"));
  items = rows
    .filter((r) => (r.from === "bot" || r.from === "participant") && Number(r.seq) >= 1 && label.has(r.participant_id))
    .map((r) => ({
      key: [r.participant_id, r.chat_index, r.seq].join("|"),
      pid: label.get(r.participant_id), chat_index: r.chat_index, bot_condition: r.bot_condition,
      seq: Number(r.seq), from: r.from, text: r.text,
    }));
  const unmapped = new Set(rows.filter((r) => !label.has(r.participant_id)).map((r) => r.participant_id)).size;
  const people = new Set(items.map((x) => x.pid)).size;
  console.log(`Messages:   ${items.length} (${items.filter((x) => x.from === "bot").length} bot, ` +
    `${items.filter((x) => x.from === "participant").length} participant) from ${people} participants; ` +
    `seq 0 left out; ${unmapped} transcript ids with no pseudonym skipped`);
}
console.log(`Model:      ${modelId} on Vertex AI, project ${project}, location ${location}`);
console.log("Generation: the model's defaults (nothing sent), as in the chats");
console.log("Each call:  the system prompt below plus one message's text; no ids, no history");
console.log("System:     " + SYSTEM_PROMPT);
if (!go) {
  console.log("\nDry run: nothing was sent or written. Add --yes-call-the-model to make the calls.");
  process.exit(0);
}

// ---- the calls ------------------------------------------------------------------------------
const logs = [];
const model = createModel({
  provider: "gemini",
  model_id: modelId,
  gemini: { access: "vertex", vertex_project: project, vertex_location: location },
  timeout_ms: TIMEOUT_MS,
  log: (l) => logs.push(l),
});

const cachePath = test ? null : arg("cache");
const done = new Map();
if (cachePath && fs.existsSync(cachePath)) {
  for (const line of fs.readFileSync(cachePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    if (c.label) done.set(c.key, c);
  }
}

const usage = { calls: 0, in: 0, out: 0, thinking: 0 };
let fatal = null;

async function rate(item) {
  for (let a = 1; a <= ATTEMPTS && !fatal; a++) {
    try {
      const res = await model.generate({ system: SYSTEM_PROMPT, messages: [{ role: "user", text: item.text }], generation: null });
      usage.calls++;
      const t = tokensFrom(logs[logs.length - 1]);
      if (t) { usage.in += t.in; usage.out += t.out; usage.thinking += t.thinking; }
      const label = normalise(res.text);
      if (label) return { key: item.key, label, model_version: res.model_version, attempts: a };
    } catch (e) {
      usage.calls++;
      if (e.code === "http_401" || e.code === "http_403") { fatal = e; break; }   // sign-in or permission: stop
    }
    await sleep(2000 * a);
  }
  return { key: item.key, label: null, model_version: null, attempts: ATTEMPTS };
}

(async () => {
  const todo = items.filter((x) => !done.has(x.key));
  if (!test) console.log(`\nAlready rated (cache): ${items.length - todo.length}; to rate now: ${todo.length}`);
  let next = 0, finished = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
    while (next < todo.length && !fatal) {
      const item = todo[next++];
      const r = await rate(item);
      if (r.label) {
        done.set(r.key, r);
        if (cachePath) fs.appendFileSync(cachePath, JSON.stringify(r) + "\n", { mode: 0o600 });
      }
      if (test) console.log(`  "${item.text}" -> ${r.label || "(no valid label)"}`);
      if (++finished % 100 === 0) console.log(`  ${finished} / ${todo.length}`);
    }
  });
  await Promise.all(workers);

  console.log(`\nCalls: ${usage.calls}; tokens in ${usage.in}, out ${usage.out}, thinking ${usage.thinking}`);
  if (fatal) {
    console.error("Stopped: " + fatal.message + " [" + fatal.code + "]. Check the sign-in and that this account may use Vertex AI in " + project + ".");
    process.exit(1);
  }
  if (test) return;

  // ---- the output: no text --------------------------------------------------------------------
  const head = ["participant_id", "chat_index", "bot_condition", "seq", "from", "label", "n_exclaim", "n_question", "n_emoji", "model_version"];
  const out = items
    .slice()
    .sort((a, b) => a.pid.localeCompare(b.pid) || Number(a.chat_index) - Number(b.chat_index) || a.seq - b.seq)
    .map((x) => {
      const r = done.get(x.key) || {};
      return [x.pid, x.chat_index, x.bot_condition, x.seq, x.from, r.label || "",
        count(x.text, /!/g), count(x.text, /\?/g), count(x.text, /\p{Extended_Pictographic}/gu), r.model_version || ""].join(",");
    });
  fs.writeFileSync(arg("out"), head.join(",") + "\n" + out.join("\n") + "\n");
  const missing = items.filter((x) => !done.has(x.key)).length;
  console.log(`Wrote ${arg("out")}: ${items.length} rows, ${missing} without a label` +
    (missing ? " (run again to retry them; the cache keeps the rest)" : ""));
})();
