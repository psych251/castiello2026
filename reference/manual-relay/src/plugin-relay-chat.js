/*
 * jsPsychRelayChat: one text chat with one chatbot, for Castiello et al. (2026) Experiment 3.
 *
 * The bot speaks first. The trial sends a hidden opener request (message 0, never shown),
 * then alternates: bot message 1, participant message 2, bot message 3, ... Every message
 * from either side is one turn, and the chat ends after `total_messages` (24: the
 * participant's 12th message, which gets no reply).
 *
 * Messages travel through `transport`, an object with
 *   send(msg)             deliver one message ({ chat_index, seq, from, kind, text, ... })
 *   subscribe(fn)         call fn(reply) for each reply ({ chat_index, seq, text, ... });
 *                         returns an unsubscribe function
 * experiment.js supplies either the manual relay (Firestore + scripts/operator.js) or the
 * stand-in used for local previews and offline tests.
 *
 * Each chat keeps only its own history: replies for another chat_index are ignored, so the
 * second bot never sees the first chat.
 */
var jsPsychRelayChat = (function (jspsych) {
  "use strict";

  const info = {
    name: "relay-chat",
    version: "1.0.0",
    parameters: {
      chat_index: { type: jspsych.ParameterType.INT, default: 1 },
      bot_name: { type: jspsych.ParameterType.STRING, default: "Pat" },
      total_messages: { type: jspsych.ParameterType.INT, default: 24 },
      opener_trigger: { type: jspsych.ParameterType.STRING, default: "" },
      max_chars: { type: jspsych.ParameterType.INT, default: 1000 },
      transport: { type: jspsych.ParameterType.OBJECT, default: null },
    },
    data: {
      chat_index: { type: jspsych.ParameterType.INT },
      bot_name: { type: jspsych.ParameterType.STRING },
      n_messages: { type: jspsych.ParameterType.INT },
      n_participant_messages: { type: jspsych.ParameterType.INT },
      n_bot_messages: { type: jspsych.ParameterType.INT },
      transcript: { type: jspsych.ParameterType.COMPLEX, array: true },
      chat_started_at: { type: jspsych.ParameterType.STRING },
      chat_ended_at: { type: jspsych.ParameterType.STRING },
      duration_ms: { type: jspsych.ParameterType.INT },
    },
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; // never innerHTML: the text comes from people
    return e;
  }

  function toIso(ts) {
    if (!ts) return null;
    if (typeof ts.toDate === "function") return ts.toDate().toISOString();
    return String(ts);
  }

  class RelayChatPlugin {
    constructor(jsPsych) {
      this.jsPsych = jsPsych;
    }

    trial(display_element, trial) {
      return new Promise((resolve) => {
        const started = new Date();
        const transcript = [];
        let lastSeq = 0;
        let waiting = true;
        let finished = false;

        display_element.innerHTML = "";
        const box = el("div", "chat");
        box.dataset.chatIndex = String(trial.chat_index);
        const header = el("div", "chat-header", "Chat with " + trial.bot_name);
        const counter = el("div", "chat-counter");
        const log = el("div", "chat-log");
        log.setAttribute("aria-live", "polite");
        const status = el("div", "chat-status");
        const form = el("form", "chat-form");
        const input = el("textarea", "chat-input");
        input.rows = 2;
        input.maxLength = trial.max_chars;
        input.placeholder = "Type your message";
        input.setAttribute("aria-label", "Your message");
        const send = el("button", "jspsych-btn chat-send", "Send");
        send.type = "submit";
        form.append(input, send);
        box.append(header, counter, log, status, form);
        display_element.appendChild(box);

        const updateCounter = () => {
          counter.textContent = "Message " + Math.min(lastSeq + 1, trial.total_messages) + " of " + trial.total_messages;
        };
        const setWaiting = (w) => {
          waiting = w;
          input.disabled = w;
          send.disabled = w;
          status.textContent = w ? "Waiting for " + trial.bot_name + "…" : "";
          updateCounter();
          if (!w) input.focus();
        };
        const addBubble = (from, text, seq) => {
          const b = el("div", "chat-msg chat-" + from, text);
          b.dataset.seq = String(seq);
          b.dataset.from = from;
          log.appendChild(b);
          log.scrollTop = log.scrollHeight;
        };

        const finish = () => {
          if (finished) return;
          finished = true;
          unsubscribe();
          const ended = new Date();
          const msgs = transcript.filter((m) => m.seq >= 1);
          const data = {
            chat_index: trial.chat_index,
            bot_name: trial.bot_name,
            n_messages: msgs.length,
            n_participant_messages: msgs.filter((m) => m.from === "participant").length,
            n_bot_messages: msgs.filter((m) => m.from === "bot").length,
            transcript: transcript,
            chat_started_at: started.toISOString(),
            chat_ended_at: ended.toISOString(),
            duration_ms: ended - started,
          };
          display_element.innerHTML = "";
          resolve(data);
        };

        const endOfChat = () => {
          form.remove();
          status.textContent = "";
          counter.textContent = "Message " + trial.total_messages + " of " + trial.total_messages;
          const note = el("div", "chat-end");
          note.appendChild(el("p", null, "Your chat with " + trial.bot_name + " has ended."));
          const next = el("button", "jspsych-btn chat-continue", "Continue");
          next.type = "button";
          next.onclick = finish;
          note.appendChild(next);
          box.appendChild(note);
          next.focus();
        };

        const onReply = (r) => {
          if (finished || Number(r.chat_index) !== trial.chat_index) return; // another chat's reply
          if (!waiting || Number(r.seq) !== lastSeq + 1) return;             // duplicate or out of turn
          lastSeq = Number(r.seq);
          transcript.push({
            seq: lastSeq, from: "bot", text: String(r.text), reply_id: r.id || null,
            submitted_at: toIso(r.submitted_at), client_shown_at: new Date().toISOString(),
          });
          addBubble("bot", String(r.text), lastSeq);
          if (lastSeq >= trial.total_messages) endOfChat();
          else setWaiting(false);
        };

        const transport = trial.transport;
        const unsubscribe = transport.subscribe(onReply) || function () {};

        form.addEventListener("submit", (ev) => {
          ev.preventDefault();
          const text = input.value.trim();
          if (waiting || finished || !text) return;
          lastSeq += 1;
          const msg = { chat_index: trial.chat_index, bot_name: trial.bot_name, seq: lastSeq, from: "participant",
                        kind: "message", text: text, client_sent_at: new Date().toISOString() };
          transcript.push({ seq: msg.seq, from: "participant", text: text, client_sent_at: msg.client_sent_at });
          addBubble("participant", text, lastSeq);
          input.value = "";
          transport.send(msg);
          if (lastSeq >= trial.total_messages) endOfChat();
          else setWaiting(true);
        });
        // Enter sends; Shift+Enter starts a new line.
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            form.requestSubmit();
          }
        });

        setWaiting(true);
        const opener = { chat_index: trial.chat_index, bot_name: trial.bot_name, seq: 0, from: "system",
                         kind: "open", text: trial.opener_trigger, client_sent_at: new Date().toISOString() };
        transcript.push({ seq: 0, from: "system", kind: "open", text: trial.opener_trigger, client_sent_at: opener.client_sent_at });
        transport.send(opener);
      });
    }
  }
  RelayChatPlugin.info = info;
  return RelayChatPlugin;
})(jsPsychModule);
