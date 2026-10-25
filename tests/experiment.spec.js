// End-to-end tests: a robot participant runs the Castiello Experiment 3 flow, chatting with the
// chat service as a Cloud Function in the Functions emulator, with its simulated model. No real
// model is called.
//
// Everything runs against the local Firestore emulator, which `npm test` starts. Without the
// emulator these tests are skipped: this project has a real firebase-config.js, so a run
// outside the emulator would write test records into the live database.
//
// If you change the timeline in experiment.js, update `runThroughExperiment` below so the
// robot still knows which buttons to press.

const { test, expect, devices } = require("@playwright/test");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Castiello = require("../server/castiello.js");

const EMULATOR = process.env.EMULATOR === "1" || !!process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-psych251";
const EXPERIMENT_ID = "castiello2026-pilot-b";
const FS = `http://localhost:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
// The Cloud Function (server/index.js) in the Functions emulator, started by `npm test`.
const CHAT_SERVER = `http://127.0.0.1:5001/${PROJECT}/us-central1/chat`;
// Words that would give away the condition, the scores or the prompts.
const HIDDEN = /mirror|inverse|openness|conscientiousness|extraversion|agreeableness|neuroticism|prompt|trait_|your name is/i;

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

// The supplement's scoring key, typed out again here (not imported) so the test checks the
// experiment's scoring against an independent copy. Negative = reversed item.
const KEY = {
  openness: [5, 10, 15, 20, 25, 30, -35, 40, -41, 44],
  conscientiousness: [3, -8, 13, -18, -23, 28, 33, 38, -43],
  extraversion: [1, -6, 11, 16, -21, 26, -31, 36],
  agreeableness: [-2, 7, -12, 17, 22, -27, 32, -37, 42],
  neuroticism: [4, -9, 14, 19, -24, 29, -34, 39],
};
const id = (n) => "bfi_" + String(n).padStart(2, "0");

// A varied answer pattern with items 3 and 40 left blank (2 of the 5 allowed skips).
function bfiAnswers(blank = [3, 40]) {
  const a = {};
  for (let n = 1; n <= 44; n++) if (!blank.includes(n)) a[id(n)] = ((n * 7) % 5) + 1;
  a.attention_check = 2; // "Disagree": passes
  return a;
}
function expectedTraits(answers) {
  const out = {};
  for (const [trait, items] of Object.entries(KEY)) {
    const vals = items.map((k) => {
      const v = answers[id(Math.abs(k))];
      return v == null ? null : k < 0 ? 6 - v : v;
    }).filter((v) => v !== null);
    out[trait] = vals.reduce((s, v) => s + v, 0) / vals.length;
  }
  return out;
}

// Post-chat ratings (−2..+2). With chat 1 = mirror, hand-computed affiliation:
//   chat 1: similar 2, enjoy 1, distant −2→+2, understood 1, different −1→+1, again 2 = 9/6 = 1.5
//   chat 2: similar −1, enjoy 0, distant 1→−1, understood −2, different 2→−2, again −1 = −7/6
const AFF = {
  aff_similar: { chat1: 2, chat2: -1 },
  aff_enjoy: { chat1: 1, chat2: 0 },
  aff_distant: { chat1: -2, chat2: 1 },
  aff_understood: { chat1: 1, chat2: -2 },
  aff_different: { chat1: -1, chat2: 2 },
  aff_chat_again: { chat1: 2, chat2: -1 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Every page load points at the test chat service.
const url = (qs = "") => "/?emulator=1&chat_server=" + encodeURIComponent(CHAT_SERVER) + (qs ? "&" + qs : "");

async function setSurvey(page, values) {
  await page.waitForFunction((names) => window.__survey && names.every((n) => window.__survey.getQuestionByName(n)), Object.keys(values));
  await page.evaluate((v) => { for (const [k, x] of Object.entries(v)) window.__survey.setValue(k, x); }, values);
}

async function sendMessage(page, text) {
  await page.locator(".chat-input:not([disabled])").waitFor({ timeout: 30000 });
  await page.locator(".chat-input").fill(text);
  await page.keyboard.press("Enter");
}

async function chat(page, chatIndex, { total = 24, prefix = "" } = {}) {
  await page.getByRole("button", { name: "Start chat" }).click();
  // The bot's opener is visible message 1. The hidden startup instruction is never shown, and the
  // progress counter (outside the chat log) counts visible messages only.
  const bubbles = page.locator(".chat-log .chat-msg");
  await expect(bubbles).toHaveCount(1);
  await expect(bubbles.first()).not.toContainText(Castiello.OPENER_TRIGGER);
  await expect(page.locator(".chat-counter")).toHaveText(`1 of ${total} messages completed`);
  await expect(page.locator(".chat-log .chat-counter")).toHaveCount(0);
  await sendMessage(page, `${prefix}c${chatIndex}-m1`);
  await expect(bubbles).toHaveCount(3); // the participant's message and the bot's reply
  await expect(page.locator(".chat-counter")).toHaveText(`3 of ${total} messages completed`);
  for (let k = 2; k <= total / 2; k++) await sendMessage(page, `${prefix}c${chatIndex}-m${k}`);
  await expect(page.locator(".chat-end")).toBeVisible();
  await expect(bubbles).toHaveCount(total);
  await expect(page.locator(".chat-counter")).toHaveText(`${total} of ${total} messages completed`);
  await page.getByRole("button", { name: "Continue" }).click();
}

async function runThroughExperiment(page, { bfi = bfiAnswers(), aff = AFF, finish = true, prefix = "", feedback = "I chatted with two bots" } = {}) {
  // 1. consent
  await page.getByRole("button", { name: "I agree to participate" }).click();
  // 2. BFI-44, then the chat service scores it and assigns the bots
  await setSurvey(page, { bfi: bfi });
  await page.locator('input[value="Continue"]').click();
  // 3. task instructions
  await page.locator("#jspsych-instructions-next").click();
  // 4–5. two chats
  await chat(page, 1, { prefix });
  await chat(page, 2, { prefix });
  // 6. post-chat questionnaire
  await setSurvey(page, aff);
  await page.locator('input[value="Continue"]').click();
  // 7. demographics
  await page.locator('input[type="number"]').fill("34");
  await page.getByText("Woman", { exact: true }).click();
  await page.locator('[data-name="native_english"]').getByText("Yes", { exact: true }).first().click();
  await page.locator('input[value="Continue"]').click();
  // 7b. optional feedback: answer the first question, leave the second blank
  await expect(page.getByText("In your own words, what were you asked to do during the chats?")).toBeVisible();
  await expect(page.getByText("Was anything about the instructions or study confusing? If so, please describe.")).toBeVisible();
  await page.locator("textarea").first().fill(feedback);
  await page.locator('input[value="Continue"]').click();
  // 8. debrief
  if (!finish) return;
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByText("All done")).toBeVisible({ timeout: 30000 });
}

// Runs the export in --adc mode against the emulator, with a throwaway CLOUDSDK_CONFIG holding a
// placeholder credentials file (never used: the emulator asks for no token).
function exportWithAdc(projectId) {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "adc-"));
  fs.writeFileSync(path.join(config, "application_default_credentials.json"),
    JSON.stringify({ type: "authorized_user", client_id: "x", client_secret: "x", refresh_token: "x" }));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "export-"));
  const r = spawnSync(process.execPath,
    [path.join(__dirname, "..", "scripts", "export.js"), "--adc", "--project", projectId, "--experiment", EXPERIMENT_ID, "--out", out],
    { encoding: "utf8", env: { ...process.env, FIRESTORE_EMULATOR_HOST: "localhost:8080", CLOUDSDK_CONFIG: config, GOOGLE_APPLICATION_CREDENTIALS: "" } });
  return { out, config, status: r.status, log: r.stderr };
}

async function fsGet(p) {
  // "Bearer owner" is the emulator's admin token: it bypasses security rules, like the Admin SDK.
  const r = await fetch(`${FS}/${p}`, { headers: { Authorization: "Bearer owner" } });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
}
async function fsList(p) {
  const r = await fsGet(`${p}?pageSize=500`);
  return ((r.body && r.body.documents) || []).map((d) => ({ id: d.name.split("/").pop(), ...decodeFields(d.fields) }));
}
function decode(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  return v;
}
function decodeFields(fields) {
  const out = {};
  for (const k of Object.keys(fields || {})) out[k] = decode(fields[k]);
  return out;
}
async function participantDoc(docId) {
  const p = await fsGet(`experiments/${EXPERIMENT_ID}/participants/${docId}`);
  return p.status === 200 ? decodeFields(p.body.fields) : null;
}
async function trialsOf(docId) {
  const chunks = await fsList(`experiments/${EXPERIMENT_ID}/participants/${docId}/trials`);
  return chunks.flatMap((c) => c.trials);
}

async function sessionOf(docId) {
  const s = await fsGet(`experiments/${EXPERIMENT_ID}/participants/${docId}/private/session`);
  return s.status === 200 ? decodeFields(s.body.fields) : null;
}
async function chatOf(docId) {
  return (await fsList(`experiments/${EXPERIMENT_ID}/participants/${docId}/chat`))
    .sort((a, b) => a.chat_index - b.chat_index || a.seq - b.seq);
}

test.beforeEach(() => {
  test.skip(!EMULATOR, "needs the Firestore emulator: run `npm test`");
});

// These tests start many sessions in parallel against the real server/config.js, whose study
// cap is sized for real recruitment (or 0 until it is set). In the emulator only, give the
// study's session counter a large credit so the suite never reaches the cap; the cap itself is
// tested in chat-service.spec.js.
test.beforeAll(async () => {
  if (!EMULATOR) return;
  await fetch(`${FS}/experiments/${EXPERIMENT_ID}/private_counters/sessions`, {
    method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { n: { integerValue: "-1000000" } } }),
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("experiment", () => {
  test("a full session: live chats, nothing hidden reaches the browser, and the export is analysis-ready", async ({ page }) => {
    test.setTimeout(240000);
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    // Everything the chat service sends back to the page.
    const fromService = [];
    page.on("response", async (r) => {
      if (r.url().startsWith(CHAT_SERVER) && r.request().method() !== "OPTIONS") {
        fromService.push({ path: r.url().slice(CHAT_SERVER.length), req: r.request().postData(), text: await r.text().catch(() => "") });
      }
    });

    await page.goto(url("PROLIFIC_PID=PROLIFICMARKER&STUDY_ID=s1&SESSION_ID=sess1&order=mirror-first&mirror_name=Pat"));
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    expect(await page.evaluate(() => window.__saver.mode)).toBe("emulator");
    const docId = await page.evaluate(() => window.__saver.docId);

    const answers = bfiAnswers();
    await runThroughExperiment(page, { bfi: answers, prefix: "USERMARKER-", feedback: "FEEDBACKMARKER I chatted with two bots" });
    expect(pageErrors, "uncaught page errors").toEqual([]);
    const stats = await page.evaluate(() => window.__saver.stats);
    expect(stats.writes_failed).toBe(0);

    // The browser saw two names and the replies, never the condition, scores or prompts.
    const paths = fromService.map((r) => r.path);
    // The session, then 13 turns per chat (the opener request and 12 messages), each sent once.
    // The page's /health check is made during page load, which the listener may or may not catch.
    expect(paths.filter((x) => x === "/session").length).toBe(1);
    const turns = fromService.filter((r) => r.path === "/turn").map((r) => JSON.parse(r.req)).map((b) => b.chat_index + "/" + b.seq);
    expect(turns.length).toBe(2 * 13);
    expect(new Set(turns).size).toBe(turns.length);
    expect(paths.filter((x) => !["/health", "/session", "/turn"].includes(x))).toEqual([]);
    expect(paths.filter((x) => x === "/health").length).toBeLessThanOrEqual(1);
    expect(fromService.map((r) => r.text).join("\n")).not.toMatch(HIDDEN);
    // The debrief's own text is left out: it is the researcher's explanation of the design,
    // shown after the ratings, and may name it ("prompted", "personality profile").
    const pageData = await page.evaluate(() => JSON.stringify(window.__saver.allTrials
      .map((t) => (t.task === "debrief" ? { ...t, stimulus: undefined } : t))));
    expect(pageData).not.toMatch(HIDDEN);
    expect(pageData).not.toContain("USERMARKER"); // chat text is not kept in the trial data

    // The participant document (which the participant's browser may write) holds no assignment.
    const p = await participantDoc(docId);
    expect(p.completed).toBe(true);
    expect(p.prolific_pid).toBe("PROLIFICMARKER");
    expect(p.chat_mode).toBe("live");
    expect(p.chat_status).toBe("done");
    for (const k of ["order", "mirror_name", "chat1_condition", "bot_prompts", "traits"]) expect(p[k]).toBeUndefined();

    // The service's private record: assignment, scores, prompts, model.
    const s = await sessionOf(docId);
    expect(s).toMatchObject({ order: "mirror-first", mirror_name: "Pat", inverse_name: "Alex",
      chat1_name: "Pat", chat1_condition: "mirror", chat2_name: "Alex", chat2_condition: "inverse",
      attention_check_passed: true, bfi_n_skipped: 2, study_phase: "pilot-b", model_provider: "fake", messages_per_chat: 24 });
    const want = expectedTraits(answers);
    for (const t of Object.keys(KEY)) {
      expect(s.mirror_scores[t]).toBeCloseTo(want[t], 10);
      expect(s.inverse_scores[t]).toBeCloseTo(6 - want[t], 10);
    }
    expect(s.chat1_prompt).toContain("Openness: " + want.openness.toFixed(2));
    expect(s.chat2_prompt).toContain("Openness: " + (6 - want.openness).toFixed(2));
    expect(s.chat1_prompt).toContain("Your name is Pat.");

    // Both chats, in order, each bot quoting only its own conversation.
    const msgs = await chatOf(docId);
    for (const chatIndex of [1, 2]) {
      const mine = msgs.filter((m) => m.chat_index === chatIndex);
      expect(mine.map((m) => m.seq)).toEqual([...Array(25).keys()]);
      const opener = mine.find((m) => m.seq === 1);
      expect(opener.text).not.toContain(Castiello.OPENER_TRIGGER);
      expect(opener.text).not.toMatch(/\d+ messages/); // diagnostics go to the log, not the reply
      for (const m of mine.filter((x) => x.from === "bot" && x.seq > 1)) {
        expect(m.text).not.toMatch(/\d+ messages/);
        expect(m.text).toContain(`you said "USERMARKER-c${chatIndex}-m${(m.seq - 1) / 2}"`);
        expect(m.text.startsWith(chatIndex === 1 ? "Pat" : "Alex")).toBe(true);
      }
    }

    // Trial rows: counts, no text, no condition.
    const trials = await trialsOf(docId);
    expect([...new Set(trials.map((t) => t.participant_id))]).toEqual([docId]);
    expect(trials.find((t) => t.task === "bfi").bfi_raw.bfi_03).toBe(null); // never imputed
    expect(trials.find((t) => t.task === "chat_setup").setup_ok).toBe(true);
    const chats = trials.filter((t) => t.task === "chat");
    expect(chats.map((c) => [c.chat_index, c.bot_name])).toEqual([[1, "Pat"], [2, "Alex"]]);
    for (const c of chats) {
      expect(c).toMatchObject({ n_messages: 24, n_participant_messages: 12, n_bot_messages: 12, ended_reason: "complete", n_failed_requests: 0 });
      expect(c.participant_chars).toBe([...Array(12).keys()].reduce((n, k) => n + `USERMARKER-c${c.chat_index}-m${k + 1}`.length, 0));
    }
    const aff = trials.find((t) => t.task === "affiliation");
    expect(aff.affiliation_chat1).toBeCloseTo(1.5, 10);
    expect(aff.affiliation_chat2).toBeCloseTo(-7 / 6, 10);
    expect(aff.affiliation_coded.chat1.distant).toBe(2);
    // The optional feedback is its own trial, after demographics and before the debrief.
    const order = trials.map((t) => t.task);
    expect(order.slice(order.indexOf("demographics"))).toEqual(["demographics", "feedback", "debrief"]);
    expect(trials.find((t) => t.task === "feedback").response).toEqual({ task_understanding: "FEEDBACKMARKER I chatted with two bots", confusion: null });

    // Export: the analysis columns are joined back on, and the chat text and Prolific id land
    // only in the two gitignored files.
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "export-"));
    execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "export.js"), "--emulator", "--experiment", EXPERIMENT_ID, "--out", out], { stdio: "pipe" });
    const dump = JSON.parse(fs.readFileSync(path.join(out, "export.json"), "utf8"));
    const mineOut = dump.participants.find((x) => x.participant_id === docId);
    expect(mineOut.participant).toMatchObject({ order: "mirror-first", chat1_condition: "mirror", chat1_complete: true, chat2_complete: true,
      chat1_n_messages: 24, model_provider: "fake", completed: true });
    const t = (task) => mineOut.trials.filter((x) => x.task === task);
    expect(t("bfi")[0].trait_openness).toBeCloseTo(want.openness, 10);
    expect(t("bfi")[0].inverse_neuroticism).toBeCloseTo(6 - want.neuroticism, 10);
    expect(t("bfi")[0].attention_check_passed).toBe(true);
    expect(t("chat").map((c) => c.bot_condition)).toEqual(["mirror", "inverse"]);
    expect(t("affiliation")[0].affiliation_mirror).toBeCloseTo(1.5, 10);
    expect(t("affiliation")[0].affiliation_inverse).toBeCloseTo(-7 / 6, 10);
    // Feedback: answered or not, and length, in the public files; the text only in feedback.csv.
    expect(t("feedback")[0]).toMatchObject({ feedback_task_understanding_answered: true,
      feedback_task_understanding_n_chars: "FEEDBACKMARKER I chatted with two bots".length,
      feedback_confusion_answered: false, feedback_confusion_n_chars: 0 });
    expect(t("feedback")[0].response).toBeUndefined();
    const files = fs.readdirSync(out).sort();
    expect(files).toEqual(["chat_events.csv", "errors.csv", "export.json", "feedback.csv", "identifiers.csv", "messages.csv", "participants.csv", "transcripts.csv", "trials.csv"]);
    const containing = (marker) => files.filter((f) => fs.readFileSync(path.join(out, f), "utf8").includes(marker));
    expect(containing("USERMARKER")).toEqual(["transcripts.csv"]);
    expect(containing("FEEDBACKMARKER")).toEqual(["feedback.csv"]);
    expect(containing("PROLIFICMARKER")).toEqual(["identifiers.csv"]);
    expect(containing("Your name is")).toEqual([]);
    const participantsCsv = fs.readFileSync(path.join(out, "participants.csv"), "utf8").split("\n")[0].split(",");
    for (const col of ["participant_id", "completed", "order"]) expect(participantsCsv).toContain(col);

    // --adc --project reads the same data as --emulator, file for file, and takes its credentials
    // from CLOUDSDK_CONFIG (a placeholder file here: the emulator never asks for a token).
    const adc = exportWithAdc("demo-psych251");
    expect(adc.status, adc.log).toBe(0);
    expect(adc.log).toContain(path.join(adc.config, "application_default_credentials.json"));
    expect(adc.log).toContain("project: demo-psych251");
    const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/"exported_at": "[^"]*"/, "");
    for (const f of files) expect(read(adc.out, f), f).toBe(read(out, f));
    // ... and only from the project it names: another project's database is empty.
    const other = exportWithAdc("demo-other-project");
    expect(other.status).toBe(1);
    expect(other.log).toContain("No participants found");
    for (const d of [out, adc.out, adc.config, other.out, other.config]) fs.rmSync(d, { recursive: true, force: true });
  });

  test("export: --adc needs --project and excludes --key and --emulator", async () => {
    const run = (...args) => {
      try {
        execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "export.js"), "--experiment", EXPERIMENT_ID, ...args],
          { stdio: "pipe", env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: "", CLOUDSDK_CONFIG: "" } });
        return { code: 0, err: "" };
      } catch (e) {
        return { code: e.status, err: String(e.stderr) };
      }
    };
    expect(run("--adc")).toMatchObject({ code: 1, err: expect.stringContaining("--adc needs --project") });
    expect(run("--adc", "--project", "p", "--emulator")).toMatchObject({ code: 1, err: expect.stringContaining("cannot be combined") });
    expect(run("--adc", "--project", "p", "--key", "k.json")).toMatchObject({ code: 1, err: expect.stringContaining("cannot be combined") });
    expect(run("--project", "p")).toMatchObject({ code: 1, err: expect.stringContaining("only used with --adc") });
    expect(run()).toMatchObject({ code: 1, err: expect.stringContaining("No service-account key") });
  });

  test("scoring: BFI keys, inverse profile and affiliation match hand-computed values", async () => {
    // All 5s: openness (8×5 + 2×1)/10 = 4.2; conscientiousness (5×5 + 4×1)/9; extraversion
    // (5×5 + 3×1)/8 = 3.5; agreeableness (5×5 + 4×1)/9; neuroticism (5×5 + 3×1)/8 = 3.5.
    const all5 = {};
    for (let n = 1; n <= 44; n++) all5[id(n)] = 5;
    const s = Castiello.scoreBfi(all5);
    expect(s.traits.openness).toBeCloseTo(4.2, 10);
    expect(s.traits.conscientiousness).toBeCloseTo(29 / 9, 10);
    expect(s.traits.extraversion).toBeCloseTo(3.5, 10);
    expect(s.traits.agreeableness).toBeCloseTo(29 / 9, 10);
    expect(s.traits.neuroticism).toBeCloseTo(3.5, 10);
    expect(s.attention_check_passed).toBe(false); // left blank
    expect(Castiello.inverseProfile(s.traits).openness).toBeCloseTo(1.8, 10);

    // Skips: trait means use only the answered items; nothing is imputed.
    const varied = bfiAnswers([3, 8, 40]);
    const v = Castiello.scoreBfi(varied);
    expect(v.n_skipped).toBe(3);
    expect(v.items_answered.conscientiousness).toBe(7);
    for (const [t, x] of Object.entries(expectedTraits(varied))) expect(v.traits[t]).toBeCloseTo(x, 10);
    expect(v.attention_check_passed).toBe(true);

    // Affiliation: the same ratings scored with chat 1 = inverse swap the two means.
    const a = Castiello.scoreAffiliation(AFF, { chat1: "inverse", chat2: "mirror" });
    expect(a.affiliation_inverse).toBeCloseTo(1.5, 10);
    expect(a.affiliation_mirror).toBeCloseTo(-7 / 6, 10);
    const partial = Castiello.scoreAffiliation({ aff_similar: { chat1: 2 }, aff_distant: { chat1: 2 } }, { chat1: "mirror", chat2: "inverse" });
    expect(partial.affiliation_mirror).toBeCloseTo(0, 10); // (2 + −2) / 2
    expect(partial.affiliation_inverse).toBe(null);
  });

  test("the BFI accepts at most 5 blank items", async ({ page }) => {
    await page.goto(url());
    await page.getByRole("button", { name: "I agree to participate" }).click();
    await setSurvey(page, { bfi: bfiAnswers([1, 2, 3, 4, 5, 6]) });
    await page.locator('input[value="Continue"]').click();
    await expect(page.getByText("You have left 6 statements blank")).toBeVisible();
    await expect(page.locator("#jspsych-instructions-next")).toHaveCount(0);

    await setSurvey(page, { bfi: bfiAnswers([1, 2, 3, 4, 5]) });
    await page.locator('input[value="Continue"]').click();
    await expect(page.locator("#jspsych-instructions-next")).toBeVisible();
    const bfi = await page.evaluate(() => window.__saver.allTrials.find((t) => t.task === "bfi"));
    expect(bfi.bfi_n_skipped).toBe(5);
  });

  test("an abandoned chat is never marked complete", async ({ page }) => {
    await page.goto(url());
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    const docId = await page.evaluate(() => window.__saver.docId);
    await page.getByRole("button", { name: "I agree to participate" }).click();
    await setSurvey(page, { bfi: bfiAnswers() });
    await page.locator('input[value="Continue"]').click();
    await page.locator("#jspsych-instructions-next").click();
    await page.getByRole("button", { name: "Start chat" }).click();
    await sendMessage(page, "only one message");
    await expect(page.locator(".chat-bot")).toHaveCount(2);
    await page.close(); // the participant leaves mid-chat

    const p = await participantDoc(docId);
    expect(p.completed).toBe(false);
    expect(p.chat_status).toBe("chat1");
    const s = await sessionOf(docId);
    expect(s.chat1_completed_at).toBe(null);
    expect((await chatOf(docId)).map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  });

  test("a failed reply shows 'Try again', and retrying gives one reply, not two", async ({ page }) => {
    await page.goto(url());
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    const docId = await page.evaluate(() => window.__saver.docId);
    await page.getByRole("button", { name: "I agree to participate" }).click();
    await setSurvey(page, { bfi: bfiAnswers() });
    await page.locator('input[value="Continue"]').click();
    await page.locator("#jspsych-instructions-next").click();
    await page.getByRole("button", { name: "Start chat" }).click();
    await sendMessage(page, "[[fail:3]] hello there");
    await expect(page.getByText(/reply didn't arrive/)).toBeVisible({ timeout: 30000 });
    await expect(page.locator(".chat-input")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Leave the study" })).toHaveCount(0);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator(".chat-bot")).toHaveCount(2);
    await expect(page.locator(".chat-participant")).toHaveCount(1);
    await expect(page.locator(".chat-input")).toBeEnabled();

    expect((await chatOf(docId)).map((m) => m.seq)).toEqual([0, 1, 2, 3]);
    const ev = await fsList(`experiments/${EXPERIMENT_ID}/participants/${docId}/chat_events`);
    expect(ev.length).toBe(3);
  });

  test("a chat that keeps failing lets the participant leave, and is saved as not completed", async ({ page }) => {
    await page.goto(url());
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    const docId = await page.evaluate(() => window.__saver.docId);
    await page.getByRole("button", { name: "I agree to participate" }).click();
    await setSurvey(page, { bfi: bfiAnswers() });
    await page.locator('input[value="Continue"]').click();
    await page.locator("#jspsych-instructions-next").click();
    await page.getByRole("button", { name: "Start chat" }).click();
    await sendMessage(page, "[[fail:99]] hello");
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: "Try again" }).click();
    }
    await page.getByRole("button", { name: "Leave the study" }).click();
    await expect(page.getByText("The chat stopped working")).toBeVisible({ timeout: 30000 });
    await page.evaluate(() => window.__saver._settle());
    const p = await participantDoc(docId);
    expect(p).toMatchObject({ completed: false, ended_early: "chat_failed", chat_status: "chat1_failed" });
    const chatRow = (await trialsOf(docId)).find((t) => t.task === "chat");
    expect(chatRow).toMatchObject({ ended_reason: "failed", n_failed_requests: 3, n_retries: 2, n_participant_messages: 1 });
  });

  test("while a reply is being generated the page says so, outside the message log", async ({ page }) => {
    await page.goto(url());
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await page.getByRole("button", { name: "I agree to participate" }).click();
    await setSurvey(page, { bfi: bfiAnswers() });
    await page.locator('input[value="Continue"]').click();
    await page.locator("#jspsych-instructions-next").click();
    await page.getByRole("button", { name: "Start chat" }).click();
    await page.locator(".chat-input:not([disabled])").waitFor();
    await page.locator(".chat-input").fill("[[slow:1500]] are you there?");
    await page.keyboard.press("Enter");
    const waiting = page.locator(".chat-status.chat-waiting");
    await expect(waiting).toHaveText(/is writing a reply/);
    await expect(waiting).toHaveAttribute("role", "status");
    await expect(page.locator(".chat-input")).toBeDisabled();
    await expect(page.locator(".chat-log .chat-waiting, .chat-log .chat-status")).toHaveCount(0);
    await expect(page.locator(".chat-log .chat-msg")).toHaveCount(2); // the opener and the message; no placeholder bubble
    await expect(page.locator(".chat-bot")).toHaveCount(2);
    await expect(page.locator(".chat-status.chat-waiting")).toHaveCount(0);
    await expect(page.locator(".chat-input")).toBeEnabled();
  });

  test("pressing Enter repeatedly sends a message once", async ({ page }) => {
    await page.goto(url());
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    const docId = await page.evaluate(() => window.__saver.docId);
    await page.getByRole("button", { name: "I agree to participate" }).click();
    await setSurvey(page, { bfi: bfiAnswers() });
    await page.locator('input[value="Continue"]').click();
    await page.locator("#jspsych-instructions-next").click();
    await page.getByRole("button", { name: "Start chat" }).click();
    await page.locator(".chat-input:not([disabled])").waitFor();
    await page.locator(".chat-input").fill("[[slow:800]] once");
    await page.evaluate(() => {
      const f = document.querySelector(".chat-form");
      for (let i = 0; i < 5; i++) f.requestSubmit();
    });
    await expect(page.locator(".chat-bot")).toHaveCount(2);
    await expect(page.locator(".chat-participant")).toHaveCount(1);
    expect((await chatOf(docId)).map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  });

  test("without a reachable chat service the study stops right after consent", async ({ page }) => {
    await page.goto("/?emulator=1&chat_server=" + encodeURIComponent("http://127.0.0.1:9"));
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    const docId = await page.evaluate(() => window.__saver.docId);
    await page.getByRole("button", { name: "I agree to participate" }).click();
    await expect(page.getByText("The chat cannot connect")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByText("study cannot continue")).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => window.__saver._settle());
    const p = await participantDoc(docId);
    expect(p).toMatchObject({ completed: false, ended_early: "chat_unavailable", chat_mode: "unavailable: chat service unreachable" });
    expect(await sessionOf(docId)).toBe(null);
  });

  test("chunked writes (chunk_size > 1) save every trial, and inverse-first is exported correctly", async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(url("chunk_size=4&order=inverse-first&mirror_name=Alex"));
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    await runThroughExperiment(page);
    const docId = await page.evaluate(() => window.__saver.docId);
    const p = await participantDoc(docId);
    const chunks = await fsList(`experiments/${EXPERIMENT_ID}/participants/${docId}/trials`);
    expect(chunks.length).toBe(Math.ceil(p.n_trials / 4));
    const trials = chunks.flatMap((d) => d.trials);
    // Every trial saved exactly once. (Indices are not 0..n-1: the skipped "chat unavailable"
    // screen still uses up an index.)
    const indices = trials.map((t) => t.trial_index);
    expect(indices.length).toBe(p.n_trials);
    expect(new Set(indices).size).toBe(p.n_trials);
    expect(await sessionOf(docId)).toMatchObject({ chat1_name: "Pat", chat1_condition: "inverse", chat2_name: "Alex", chat2_condition: "mirror" });

    const out = fs.mkdtempSync(path.join(os.tmpdir(), "export-"));
    execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "export.js"), "--emulator", "--experiment", EXPERIMENT_ID, "--out", out], { stdio: "pipe" });
    const mine = JSON.parse(fs.readFileSync(path.join(out, "export.json"), "utf8")).participants.find((x) => x.participant_id === docId);
    const aff = mine.trials.find((t) => t.task === "affiliation");
    expect(aff.affiliation_inverse).toBeCloseTo(1.5, 10); // chat 1 ratings belong to the inverse bot here
    expect(aff.affiliation_mirror).toBeCloseTo(-7 / 6, 10);
    fs.rmSync(out, { recursive: true, force: true });
  });

  test("declining consent ends the study without a thank-you-for-your-data message", async ({ page }) => {
    await page.goto(url());
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    const docId = await page.evaluate(() => window.__saver.docId);
    await page.getByRole("button", { name: "I do not agree" }).click();
    await expect(page.getByText("You chose not to participate")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Your responses were saved")).toHaveCount(0);
    await expect(page.locator(".chat")).toHaveCount(0);
    await page.evaluate(() => window.__saver._settle());
    expect(await participantDoc(docId)).toMatchObject({ completed: false, ended_early: "declined_consent" });
  });

  test("losing the connection at the end offers the download fallback instead of hanging", async ({ page, context }) => {
    test.setTimeout(150000);
    await page.goto(url());
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    await runThroughExperiment(page, { finish: false });
    await context.setOffline(true);
    await page.getByRole("button", { name: "Finish" }).click();
    await expect(page.locator("#data-saver-fallback")).toBeVisible({ timeout: 40000 });
    await expect(page.getByText("connection to the server was lost")).toBeVisible();
    await expect(page.getByText("Your responses were saved")).toHaveCount(0);
    await context.setOffline(false);
  });

  test("a second run in the same browser is a new participant and saves cleanly", async ({ page }) => {
    test.setTimeout(180000);
    const ids = [];
    for (let run = 0; run < 2; run++) {
      await page.goto(url("PROLIFIC_PID=rerun" + run));
      await page.waitForFunction(() => window.__saver && window.__saver.docId);
      await runThroughExperiment(page);
      const info = await page.evaluate(() => ({ uid: window.__saver.uid, docId: window.__saver.docId, stats: window.__saver.stats }));
      expect(info.stats.writes_failed, "run " + run + " had failed writes").toBe(0);
      ids.push(info);
    }
    expect(ids[0].uid).toBe(ids[1].uid);
    expect(ids[0].docId).not.toBe(ids[1].docId);
    for (let run = 0; run < 2; run++) {
      const p = await participantDoc(ids[run].docId);
      expect(p.completed, "run " + run + " completed").toBe(true);
      expect(p.prolific_pid).toBe("rerun" + run);
      expect((await fsList(`experiments/${EXPERIMENT_ID}/participants/${ids[run].docId}/trials`)).length).toBe(p.n_trials);
      expect((await chatOf(ids[run].docId)).length).toBe(50);
    }
  });

  test("setting a Prolific completion code does not break the test run", async ({ page }) => {
    test.setTimeout(120000);
    const navigations = [];
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
    await page.goto(url("cc=QA123CODE"));
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await runThroughExperiment(page);
    expect(navigations.some((u) => u.includes("prolific.com")), "must not navigate to Prolific").toBe(false);
    await expect(page.getByText("QA123CODE")).toBeVisible();
  });

  test("phones and tablets are turned away before consent", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    await page.goto("http://localhost:8017" + url());
    await expect(page.locator("#device-unsupported")).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole("button", { name: "I agree to participate" })).toHaveCount(0);
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    const docId = await page.evaluate(() => window.__saver.docId);
    await page.evaluate(() => window.__saver._settle());
    const p = await participantDoc(docId);
    expect(p.device_supported).toBe(false);
    expect(p.completed).toBe(false);
    await context.close();
  });

  test("a desktop browser is not turned away", async ({ page }) => {
    await page.goto(url());
    await expect(page.getByRole("button", { name: "I agree to participate" })).toBeVisible();
    await expect(page.locator("#device-unsupported")).toHaveCount(0);
  });

  test("a write the database refuses is announced on the page, not only in the console", async ({ page }) => {
    await page.goto(url());
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await expect(page.locator('#data-saver-banner[data-kind="offline"]')).toHaveCount(0);
    await page.evaluate(async () => {
      window.__saver.docId = "someone-else-deadbeef";
      await window.__saver.updateParticipant({ blocked: true });
    });
    const banner = page.locator("#data-saver-banner");
    await expect(banner).toHaveAttribute("data-kind", "offline");
    await expect(banner).toContainText("NOT being saved");
    await expect(banner).toContainText("permission-denied");
    await expect(banner).toContainText("2.3");
    expect(await page.evaluate(() => window.__saver.stats.writes_failed)).toBeGreaterThan(0);
  });

  test("the download fallback tells the participant where to send the file", async ({ page }) => {
    await page.goto(url());
    await page.waitForFunction(() => window.__saver && window.__saver.docId);
    await page.evaluate(() => window.__saver._offerDownload(null, "[]"));
    const box = page.locator("#data-saver-fallback");
    await expect(box).toBeVisible();
    await expect(box).toContainText("@");
    await expect(box).toContainText("you will be paid");
    await expect(box.getByRole("link")).toHaveAttribute("href", /^mailto:/);
  });

  test("security rules: a browser cannot read or write the chat service's records, even its own", async ({ page }) => {
    await page.goto(url());
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    const docId = await page.evaluate(() => window.__saver.docId);

    // The service (admin) has written a session record and a chat message for this participant.
    for (const [p, fields] of [
      [`private?documentId=session`, { chat1_condition: { stringValue: "mirror" } }],
      [`chat?documentId=c1-001`, { text: { stringValue: "hi from the service" } }],
    ]) {
      const r = await fetch(`${FS}/experiments/${EXPERIMENT_ID}/participants/${docId}/${p}`, {
        method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields }),
      });
      expect(r.status).toBe(200);
    }

    const results = await page.evaluate(async () => {
      const s = window.__saver;
      const fb = s.fb;
      const P = (id, ...rest) => fb.doc(s.db, "experiments", s.opts.experiment_id, "participants", id, ...rest);
      const out = {};
      const attempt = async (name, fn) => {
        try { const v = await fn(); out[name] = v === undefined ? "allowed" : v; } catch (e) { out[name] = e.code || e.message; }
      };
      await attempt("read own session record", () => fb.getDoc(P(s.docId, "private", "session")));
      await attempt("overwrite own session record", () => fb.setDoc(P(s.docId, "private", "session"), { chat1_condition: "inverse" }));
      await attempt("read own chat", () => fb.getDoc(P(s.docId, "chat", "c1-001")));
      await attempt("write own chat", () => fb.setDoc(P(s.docId, "chat", "c1-003"), { text: "forged reply" }));
      await attempt("write own chat event", () => fb.setDoc(P(s.docId, "chat_events", "x"), { type: "x" }));
      await attempt("old relay messages path", () => fb.setDoc(P(s.docId, "messages", "c1-002"), { text: "hi" }));
      await attempt("old relay replies path", () => fb.getDoc(P(s.docId, "replies", "c1-001")));
      await attempt("session counter", () => fb.setDoc(fb.doc(s.db, "experiments", s.opts.experiment_id, "private_sessions_per_uid", s.uid), { n: 0 }));
      await attempt("read own doc", () => fb.getDoc(P(s.docId)));
      await attempt("read own trials", () => fb.getDoc(P(s.docId, "trials", "chunk-00000")));
      await attempt("write other participant", () => fb.setDoc(P("someone-else"), { hacked: true }));
      await attempt("write other participant trials", () => fb.setDoc(P("someone-else", "trials", "c0"), { trials: [] }));
      await attempt("write unrelated collection", () => fb.setDoc(fb.doc(s.db, "spam", "doc"), { spam: true }));
      await attempt("error doc with wrong uid", () =>
        fb.addDoc(fb.collection(s.db, "experiments", s.opts.experiment_id, "errors"), { uid: "not-me", message: "x" }));
      await attempt("own chunk (should be allowed)", () => fb.setDoc(P(s.docId, "trials", "chunk-test"), { trials: [{ a: 1 }] }));
      await attempt("participant doc without the run suffix", () => fb.setDoc(P(s.uid), { sneaky: true }));
      await attempt("another browser's run id", () => fb.setDoc(P("someone-else-abcd1234"), { sneaky: true }));
      return out;
    });

    for (const [name, result] of Object.entries(results)) {
      expect(result, name).toBe(name.includes("should be allowed") ? "allowed" : "permission-denied");
    }
    expect((await sessionOf(docId)).chat1_condition).toBe("mirror");
  });

  test("uncaught errors are logged to the errors collection", async ({ page }) => {
    await page.goto(url());
    await page.waitForFunction(() => window.__saver && window.__saver.uid);
    const uid = await page.evaluate(() => window.__saver.uid);
    await page.evaluate(() => { setTimeout(() => { throw new Error("simulated bug in trial code"); }, 0); });
    await page.waitForFunction(() => window.__saver.stats.errors_logged >= 1);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
    const errs = await fsList(`experiments/${EXPERIMENT_ID}/errors`);
    const mine = errs.filter((d) => d.uid === uid);
    expect(mine.length).toBe(1);
    expect(mine[0].message).toContain("simulated bug");
    expect(mine[0].context.kind).toBe("uncaught");
  });
});
