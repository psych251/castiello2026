#!/usr/bin/env node
/*
 * One minimal, synthetic check of the real Gemini connection, run by the researcher on their own
 * computer. It uses the chat service's own code (server/gemini.js) with the study's prompt for a
 * made-up personality profile, and makes exactly two model calls: the bot's opener (answering the
 * hidden startup instruction), then one reply to a made-up participant message. No participant
 * data, no database, no Firebase.
 *
 *   node scripts/check-model.js --project <id> --location <loc> --model <id> --yes-call-the-model
 *
 * Signs in with Application Default Credentials (`gcloud auth application-default login`), so no
 * key is passed, printed or stored. Prints the replies, finish reasons, the model version Google
 * reports, timings and token counts. Costs a fraction of a cent.
 */
"use strict";

const path = require("path");
const server = path.join(__dirname, "..", "server");
const Castiello = require(path.join(server, "castiello.js"));
const { createModel } = require(path.join(server, "models.js"));
const config = require(path.join(server, "config.js"));

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const project = arg("project");
const location = arg("location");
const modelId = arg("model");
if (!project || !location || !modelId) {
  console.error("Usage: node scripts/check-model.js --project <id> --location <loc> --model <id> --yes-call-the-model");
  process.exit(1);
}

// A made-up profile (not anyone's answers), and the study's real prompt and opener request.
const scores = { openness: 4.2, conscientiousness: 3.6, extraversion: 2.1, agreeableness: 4.0, neuroticism: 2.5 };
const system = Castiello.buildPrompt(scores, "Pat");
const synthetic = "Not much, just testing a chat app. What did you do this weekend?";

console.log("Model:      " + modelId + " on Vertex AI, project " + project + ", location " + location);
console.log("Generation: " + JSON.stringify(config.model.generation) + " (null = the model's default; the same for both bots)");
console.log("Calls:      2 (the opener, then one reply to a made-up message)");
if (!process.argv.includes("--yes-call-the-model")) {
  console.log("\nDry run: nothing was sent. Add --yes-call-the-model to make the two calls.");
  process.exit(0);
}

(async () => {
  const logs = [];
  const model = createModel({
    provider: "gemini",
    model_id: modelId,
    gemini: { access: "vertex", vertex_project: project, vertex_location: location },
    timeout_ms: config.model_timeout_ms,
    log: (l) => logs.push(l),
  });
  const history = [{ role: "user", text: Castiello.OPENER_TRIGGER }];
  const call = async (label) => {
    const t0 = Date.now();
    const out = await model.generate({ system: system, messages: history, generation: config.model.generation });
    console.log(`\n${label} (${Date.now() - t0} ms, finish ${out.finish_reason}, model version ${out.model_version}):`);
    console.log("  " + (out.text || "(empty reply)"));
    console.log("  " + logs[logs.length - 1]);
    return out;
  };
  try {
    const opener = await call("Opener");
    history.push({ role: "model", text: opener.text }, { role: "user", text: synthetic });
    console.log("\nMade-up participant message: " + synthetic);
    await call("Reply");
    console.log("\nDone: the connection works with these settings.");
  } catch (e) {
    console.error("\nThe call failed: " + e.message + (e.code ? " [" + e.code + "]" : ""));
    console.error(logs.join("\n"));
    process.exit(1);
  }
})();
