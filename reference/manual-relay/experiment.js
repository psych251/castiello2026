/*
 * Psych 251 replication of Castiello et al. (2026), Experiment 3.
 * Castiello, Pitliya, Lametti & Murphy, Communications Psychology 4:93,
 * https://doi.org/10.1038/s44271-026-00433-8
 *
 * Design summary
 *   IV:     chatbot personality, within subjects: "mirror" (the participant's own BFI-44
 *           profile) vs "inverse" (6 − each trait mean). Every participant chats with both.
 *   DV:     affiliation per bot = mean of six post-chat ratings coded −2..+2, "distant" and
 *           "different" reversed. Saved on the `affiliation` trial as affiliation_mirror and
 *           affiliation_inverse.
 *   Trials: consent, BFI-44 (+1 attention check), task instructions, chat 1 (24 messages),
 *           chat 2 (24 messages), post-chat questionnaire, demographics, debrief.
 *   Random: order (mirror first / inverse first) x name (mirror is Pat / mirror is Alex),
 *           simple random assignment, saved on every row and on the participant document.
 *   Exclusions (preregistration, applied in the report): fewer than 8 turns in a chat, a
 *           failed attention check, or all five trait means exactly 3.
 *
 * Chats are relayed by hand for Pilot A: scripts/operator.js shows the researcher each
 * message and sends back the chatbot's reply. See docs in that file.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
window.TEMPLATE_VERSION = "0.1.0";

const EXPERIMENT = {
  // Firestore path: experiments/<id>/participants/... Change it for each phase so pilot and
  // real data never mix. Must match experiment_id in writeup/replication-report.qmd.
  id: "castiello2026-pilot-a",

  // Trials per Firestore write. 1 = save every trial the moment it finishes. This study has
  // only about ten trials, so 1 is well inside the free tier.
  chunk_size: 1,

  // Also store the complete jsPsych dataset on the participant document at the end.
  save_full_data_at_end: true,

  // Prolific: if set, participants are redirected to Prolific when they finish.
  prolific_completion_code: "",

  // Contact shown in consent and debrief.
  contact_email: "stanfordpsych251@gmail.com",

  // The chats are typed, which needs a physical keyboard; phones and tablets are turned away
  // before consent.
  requires_keyboard: true,

  // Each chat ends after this many messages, counting both sides and the bot's opener
  // (so the participant sends 12). The paper requires "24 conversational turns".
  messages_per_chat: 24,

  // BFI-44: how many of the 44 items a participant may leave blank and still continue.
  max_bfi_skips: 5,

  // Longest single chat message a participant can type.
  max_message_chars: 1000,
};

// True on anything with a mouse, trackpad, or stylus, including laptops with touchscreens.
function hasFinePointer() {
  return !!(window.matchMedia && window.matchMedia("(any-pointer: fine)").matches);
}

// `?emulator=1` sends data to the local emulator instead of the real project (used by
// `npm test`; start it yourself with `npm run emulators`).
const URL_PARAMS = new URLSearchParams(window.location.search);
const USE_EMULATOR = URL_PARAMS.get("emulator") === "1";
const CHUNK_SIZE = Number(URL_PARAMS.get("chunk_size")) || EXPERIMENT.chunk_size;
if (USE_EMULATOR && URL_PARAMS.get("cc")) EXPERIMENT.prolific_completion_code = URL_PARAMS.get("cc");

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function main() {
  const C = window.Castiello;
  const deviceSupported = !EXPERIMENT.requires_keyboard || hasFinePointer();

  const saver = await DataSaver.init({
    experiment_id: EXPERIMENT.id,
    chunk_size: CHUNK_SIZE,
    save_full_data_at_end: EXPERIMENT.save_full_data_at_end,
    use_emulator: USE_EMULATOR,
    contact_email: EXPERIMENT.contact_email,
  });
  window.__saver = saver; // for debugging and the automated test

  // `?standin=1` replaces the relay with automatic placeholder replies, for previewing the
  // flow and for offline tests. It is honoured only in emulator or offline runs, so it can
  // never reach live data.
  const STANDIN = URL_PARAMS.get("standin") === "1" && (USE_EMULATOR || saver.mode === "offline");
  const relayMode = STANDIN ? "standin" : saver.mode === "offline" ? "unavailable" : "manual-relay";

  saver.updateParticipant({ device_supported: deviceSupported, requires_keyboard: EXPERIMENT.requires_keyboard });

  if (!deviceSupported) {
    document.body.innerHTML =
      '<div id="device-unsupported" class="jspsych-content" style="max-width:640px;margin:15vh auto;font:16px/1.6 system-ui,sans-serif;">' +
      "<h2>Please use a computer</h2>" +
      "<p>This study needs a computer with a physical keyboard, because you will be typing " +
      "messages in two chats. Phones and tablets cannot be used.</p>" +
      "<p>Please reopen this link on a laptop or desktop computer. If you were sent here from " +
      "Prolific, you can return the study and take it later on a computer; nothing has been recorded " +
      "against you.</p>" +
      "<p>Questions: <a href=\"mailto:" + EXPERIMENT.contact_email + "\">" + EXPERIMENT.contact_email + "</a></p></div>";
    return;
  }

  const jsPsych = initJsPsych({
    show_progress_bar: true,
    auto_update_progress_bar: true,
    on_data_update: (trial) => saver.onTrial(trial),
    on_finish: async () => {
      const el = jsPsych.getDisplayElement();
      el.innerHTML = '<div id="finish-message"><p class="thanks">Saving your responses…</p></div>';
      const result = await saver.finish(jsPsych);
      const consentRow = jsPsych.data.get().filter({ task: "consent" }).values()[0];
      const consented = !consentRow || consentRow.consented !== false;
      const unavailable = jsPsych.data.get().filter({ task: "chat_unavailable" }).count() > 0;
      const msg = document.getElementById("finish-message");

      if (!consented) {
        msg.innerHTML = "<h2 class='thanks'>Thank you</h2><p class='thanks'>You chose not to participate. " +
          "You may close this window" + (EXPERIMENT.prolific_completion_code ? " and return the study on Prolific" : "") + ".</p>";
        return;
      }
      if (unavailable) {
        msg.innerHTML = "<h2 class='thanks'>Sorry</h2><p class='thanks'>The chat could not connect, so the " +
          "study cannot continue. You may close this window. Questions: " + EXPERIMENT.contact_email + "</p>";
        return;
      }
      if (result.ok && EXPERIMENT.prolific_completion_code && !USE_EMULATOR) {
        msg.innerHTML = "<p class='thanks'>Saved. Returning you to Prolific…</p>";
        window.location.href =
          "https://app.prolific.com/submissions/complete?cc=" + EXPERIMENT.prolific_completion_code;
        return;
      }
      msg.innerHTML =
        "<h2 class='thanks'>All done</h2>" +
        (result.ok ? "<p class='thanks'>Your responses were saved. Thank you for participating!</p>" : "") +
        (EXPERIMENT.prolific_completion_code
          ? "<p class='thanks'>Your completion code is <strong>" + EXPERIMENT.prolific_completion_code + "</strong>.</p>"
          : "");
    },
  });

  // -------------------------------------------------------------------------
  // Assignment: chat order x bot name (4 cells), simple random.
  // Test runs may fix it with ?order=mirror-first|inverse-first&mirror_name=Pat|Alex.
  // -------------------------------------------------------------------------
  const pick = (xs) => jsPsych.randomization.sampleWithoutReplacement(xs, 1)[0];
  const forcedOrder = USE_EMULATOR ? URL_PARAMS.get("order") : null;
  const forcedName = USE_EMULATOR ? URL_PARAMS.get("mirror_name") : null;
  const order = ["mirror-first", "inverse-first"].includes(forcedOrder) ? forcedOrder : pick(["mirror-first", "inverse-first"]);
  const mirrorName = ["Pat", "Alex"].includes(forcedName) ? forcedName : pick(["Pat", "Alex"]);
  const inverseName = mirrorName === "Pat" ? "Alex" : "Pat";
  const chats = order === "mirror-first"
    ? [{ condition: "mirror", name: mirrorName }, { condition: "inverse", name: inverseName }]
    : [{ condition: "inverse", name: inverseName }, { condition: "mirror", name: mirrorName }];
  const assignment = {
    order: order,
    mirror_name: mirrorName,
    inverse_name: inverseName,
    chat1_name: chats[0].name,
    chat1_condition: chats[0].condition,
    chat2_name: chats[1].name,
    chat2_condition: chats[1].condition,
  };

  jsPsych.data.addProperties({
    // Must be the run-scoped document id, so trial rows join to participants.csv on export.
    participant_id: saver.docId,
    prolific_pid: saver.params.PROLIFIC_PID || null,
    experiment_id: EXPERIMENT.id,
    order: order,
    mirror_name: mirrorName,
    relay_mode: relayMode,
  });
  saver.updateParticipant(Object.assign({ relay_mode: relayMode, chat_status: "not_started" }, assignment));

  // -------------------------------------------------------------------------
  // Chat transport: the manual relay (Firestore + operator tool) or the stand-in.
  // -------------------------------------------------------------------------
  let transport;
  if (STANDIN) {
    const listeners = new Set();
    transport = {
      send(msg) {
        setTimeout(() => {
          const reply = { id: "standin-" + msg.chat_index + "-" + (msg.seq + 1), chat_index: msg.chat_index, seq: msg.seq + 1,
                          text: "(Stand-in reply " + (msg.seq + 1) + " from " + msg.bot_name + ". The live chat is relayed by the researcher.)" };
          listeners.forEach((fn) => fn(reply));
        }, 150);
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  } else {
    transport = {
      send(msg) {
        return saver.sendChatMessage(msg);
      },
      subscribe(fn) {
        return saver.watchReplies(fn);
      },
    };
  }

  // -------------------------------------------------------------------------
  // 1. Consent (course-wide IRB text; edit only the contact address)
  // -------------------------------------------------------------------------
  const consent = {
    type: jsPsychHtmlButtonResponse,
    stimulus: `
      <div class="consent">
        <h2>Consent</h2>
        <p>By answering the following questions, you are participating in a study being performed by
        cognitive scientists in the Stanford Department of Psychology. If you have questions about
        this research, please contact us at <a href="mailto:${EXPERIMENT.contact_email}">${EXPERIMENT.contact_email}</a>.
        You must be at least 18 years old to participate. Your participation in this research is
        voluntary. You may decline to answer any or all of the following questions. You may decline
        further participation, at any time, without adverse consequences. Your anonymity is assured;
        the researchers who have requested your participation will not receive any personal
        information about you.</p>
      </div>`,
    choices: ["I agree to participate", "I do not agree"],
    data: { task: "consent" },
    on_finish: (data) => {
      data.consented = data.response === 0;
      if (!data.consented) jsPsych.abortExperiment();
    },
  };

  // Shown only if the page could not connect to the database, so no replies can arrive.
  const chatUnavailable = {
    timeline: [{
      type: jsPsychHtmlButtonResponse,
      stimulus: "<h2>The chat cannot connect</h2><p>This study needs a live connection for its chats, and " +
        "the connection failed. Please close this window; you do not need to do anything else.</p>",
      choices: ["Close"],
      data: { task: "chat_unavailable" },
      on_finish: () => jsPsych.abortExperiment(),
    }],
    conditional_function: () => relayMode === "unavailable",
  };

  // -------------------------------------------------------------------------
  // 2. BFI-44 (one page; up to max_bfi_skips items may be left blank)
  // -------------------------------------------------------------------------
  const bfiRows = [];
  for (const item of C.BFI_ITEMS) {
    bfiRows.push({ value: item.id, text: item.text });
    if (item.number === C.ATTENTION_CHECK.after_item) bfiRows.push({ value: C.ATTENTION_CHECK.id, text: C.ATTENTION_CHECK.text });
  }
  const bfi = {
    type: jsPsychSurvey,
    survey_json: {
      showQuestionNumbers: "off",
      widthMode: "responsive",
      completeText: "Continue",
      pages: [{
        elements: [{
          type: "matrix",
          name: "bfi",
          title: C.BFI_STEM,
          description: "Here are a number of characteristics that may or may not apply to you. Please indicate " +
            "the extent to which you agree or disagree with each statement. You may leave up to " +
            EXPERIMENT.max_bfi_skips + " statements blank.",
          columns: C.BFI_SCALE,
          columnMinWidth: "88px",
          rowTitleWidth: "34%",
          rows: bfiRows,
          alternateRows: true,
        }],
      }],
    },
    survey_function: (survey) => {
      window.__survey = survey; // lets the automated test fill the page quickly
      survey.onValidateQuestion.add((sender, options) => {
        if (options.name !== "bfi") return;
        const v = options.value || {};
        const blank = C.BFI_ITEMS.filter((i) => v[i.id] === undefined || v[i.id] === null).length;
        if (blank > EXPERIMENT.max_bfi_skips) {
          options.error = "You have left " + blank + " statements blank. You may leave at most " +
            EXPERIMENT.max_bfi_skips + " blank; please answer at least " + (C.BFI_ITEMS.length - EXPERIMENT.max_bfi_skips) + ".";
        }
      });
    },
    data: { task: "bfi" },
    on_finish: (data) => {
      const s = C.scoreBfi((data.response || {}).bfi);
      const mirror = s.traits;
      const inverse = C.inverseProfile(mirror);
      data.bfi_raw = s.raw;
      data.bfi_n_skipped = s.n_skipped;
      data.bfi_items_answered = s.items_answered;
      data.attention_check_response = s.attention_check_response;
      data.attention_check_passed = s.attention_check_passed;
      for (const t of C.TRAITS) {
        data["trait_" + t] = mirror[t];
        data["inverse_" + t] = inverse[t];
      }
      // The prompts include only the five scores, never the item answers.
      const scores = { mirror: mirror, inverse: inverse };
      const prompts = {};
      prompts[mirrorName] = C.buildPrompt(mirror, mirrorName);
      prompts[inverseName] = C.buildPrompt(inverse, inverseName);
      saver.updateParticipant({
        bfi_done: true,
        traits: mirror,
        mirror_scores: scores.mirror,
        inverse_scores: scores.inverse,
        attention_check_passed: s.attention_check_passed,
        bfi_n_skipped: s.n_skipped,
        bot_prompts: prompts,
        opener_trigger: C.OPENER_TRIGGER,
      });
    },
  };

  // -------------------------------------------------------------------------
  // 3. Task instructions (Supplementary Information, "Task instructions", verbatim)
  // -------------------------------------------------------------------------
  const instructions = {
    type: jsPsychInstructions,
    pages: [
      `<div class="instructions">
       <p>Thank you for participating in this study. We will ask you to interact with two chatbots.</p>
       <p>Each chat will take around 10 minutes.</p>
       <p>Your goal is to learn as much as you can about each chatbot, asking them whatever questions
       you’d find necessary to determine whether you get on with them if they were a real person.</p>
       <p>After chatting with both chatbots, you will be asked about your experience with the chatbots.</p>
       </div>`,
    ],
    show_clickable_nav: true,
    data: { task: "instructions" },
  };

  // -------------------------------------------------------------------------
  // 4–5. The two chats
  // -------------------------------------------------------------------------
  function chatBlock(index) {
    const c = chats[index - 1];
    const intro = {
      type: jsPsychHtmlButtonResponse,
      stimulus: `<div class="instructions">
        <h2>${index === 1 ? "Your first chat" : "Your second chat"}</h2>
        <p>You will now chat with <strong>${c.name}</strong>. ${c.name} will send the first message.</p>
        <p>The chat ends after ${EXPERIMENT.messages_per_chat} messages in total
        (${EXPERIMENT.messages_per_chat / 2} from you). Please wait for each reply before writing again.</p>
      </div>`,
      choices: ["Start chat"],
      data: { task: "chat_intro", chat_index: index, bot_name: c.name },
      on_finish: () => saver.updateParticipant({ chat_status: "chat" + index }),
    };
    const chat = {
      type: jsPsychRelayChat,
      chat_index: index,
      bot_name: c.name,
      total_messages: EXPERIMENT.messages_per_chat,
      opener_trigger: C.OPENER_TRIGGER,
      max_chars: EXPERIMENT.max_message_chars,
      transport: transport,
      save_trial_parameters: { transport: false },
      data: { task: "chat", bot_condition: c.condition },
    };
    return [intro, chat];
  }

  // -------------------------------------------------------------------------
  // 6. Post-chat questionnaire (Supplementary Information, "Post chat questionnaire")
  // -------------------------------------------------------------------------
  const affiliation = {
    type: jsPsychSurvey,
    survey_json: {
      showQuestionNumbers: "off",
      widthMode: "responsive",
      completeText: "Continue",
      pages: [{
        elements: [
          {
            type: "html",
            name: "aff_intro",
            html: `<p>Thank you for participating in our study. We have a few questions to match you with the ideal chatbot.</p>
              <p>Choose the answer that shows how much you agree or disagree with each of the following statements about
              the Chatbots you have just communicated with, as if they were a real-life individual.</p>
              <p>As a reminder, your first chat was with ${chats[0].name}, and the second chat was with ${chats[1].name}.</p>`,
          },
        ].concat(C.AFFILIATION_ITEMS.map((item) => ({
          type: "matrix",
          name: "aff_" + item.id,
          title: item.text + ":",
          columns: C.AFFILIATION_SCALE,
          columnMinWidth: "88px",
          rowTitleWidth: "18%",
          rows: [{ value: "chat1", text: chats[0].name }, { value: "chat2", text: chats[1].name }],
        }))),
      }],
    },
    survey_function: (survey) => { window.__survey = survey; },
    data: { task: "affiliation" },
    on_finish: (data) => {
      const s = C.scoreAffiliation(data.response, { chat1: chats[0].condition, chat2: chats[1].condition });
      Object.assign(data, {
        affiliation_coded: s.coded,
        affiliation_chat1: s.affiliation_chat1,
        affiliation_chat2: s.affiliation_chat2,
        affiliation_mirror: s.affiliation_mirror,
        affiliation_inverse: s.affiliation_inverse,
        affiliation_n_items_chat1: s.n_items_chat1,
        affiliation_n_items_chat2: s.n_items_chat2,
      });
      saver.updateParticipant({
        chat_status: "done",
        affiliation_mirror: s.affiliation_mirror,
        affiliation_inverse: s.affiliation_inverse,
      });
    },
  };

  // -------------------------------------------------------------------------
  // 7. Demographics (the paper reports age and gender; "What is your gender?" is its wording)
  // -------------------------------------------------------------------------
  const demographics = {
    type: jsPsychSurvey,
    survey_json: {
      showQuestionNumbers: "off",
      widthMode: "responsive",
      completeText: "Continue",
      pages: [{
        elements: [
          // The consent text promises participants may decline any question, so nothing here is required.
          { type: "text", name: "age", title: "How old are you?", inputType: "number", min: 18, max: 120 },
          {
            type: "radiogroup", name: "gender", title: "What is your gender?",
            choices: ["Woman", "Man", "Non-binary"], showOtherItem: true, showNoneItem: true, noneText: "Prefer not to say",
          },
          { type: "boolean", name: "native_english", title: "Is English your first language?", labelTrue: "Yes", labelFalse: "No" },
        ],
      }],
    },
    data: { task: "demographics" },
  };

  // -------------------------------------------------------------------------
  // 8. Debrief
  // -------------------------------------------------------------------------
  const debrief = {
    type: jsPsychHtmlButtonResponse,
    stimulus: `
      <h2>Debrief</h2>
      <!-- TODO (Hazel): write the study-specific debrief here before Pilot A. -->
      <p class="todo">[Debrief text to be written by the researcher.]</p>
      <p>If you have questions about this research, contact
      <a href="mailto:${EXPERIMENT.contact_email}">${EXPERIMENT.contact_email}</a>.
      Press the button to save your responses and finish.</p>`,
    choices: ["Finish"],
    data: { task: "debrief" },
  };

  await jsPsych.run([
    consent,
    chatUnavailable,
    bfi,
    instructions,
    ...chatBlock(1),
    ...chatBlock(2),
    affiliation,
    demographics,
    debrief,
  ]);
})();
