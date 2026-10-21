/*
 * Private records for the chat service, kept in the same Firestore project as the experiment,
 * through the Admin SDK (which bypasses security rules). firestore.rules closes all of these
 * paths to browsers:
 *
 *   experiments/<id>/participants/<docId>/private/session    assignment, scores, prompts, model
 *   experiments/<id>/participants/<docId>/chat/c<chat>-<seq>  every message, both sides, in order
 *   experiments/<id>/participants/<docId>/chat_events/<auto>  failed or empty model replies
 *   experiments/<id>/private_sessions_per_uid/<uid>          how many sessions each browser started
 *   experiments/<id>/private_counters/sessions                how many sessions the study has started
 *
 * Another host (e.g. a Cloudflare Worker, which cannot run the Admin SDK) would implement these
 * same eight methods over Firestore's REST API.
 */
"use strict";

const ALREADY_EXISTS = 6; // gRPC status code

function pad(n) {
  return String(n).padStart(3, "0");
}

function createFirestoreStore(db, FieldValue) {
  const participant = (exp, pid) => db.collection("experiments").doc(exp).collection("participants").doc(pid);
  const sessionRef = (exp, pid) => participant(exp, pid).collection("private").doc("session");
  const messageRef = (exp, pid, chat, seq) => participant(exp, pid).collection("chat").doc("c" + chat + "-" + pad(seq));

  async function createIfAbsent(ref, data) {
    try {
      await ref.create(data);
      return true;
    } catch (e) {
      if (e && e.code === ALREADY_EXISTS) return false;
      throw e;
    }
  }

  return {
    async getSession(exp, pid) {
      const s = await sessionRef(exp, pid).get();
      return s.exists ? s.data() : null;
    },
    createSession(exp, pid, data) {
      return createIfAbsent(sessionRef(exp, pid), data);
    },
    async updateSession(exp, pid, fields) {
      await sessionRef(exp, pid).set(fields, { merge: true });
    },
    async incrementSession(exp, pid, field) {
      await sessionRef(exp, pid).set({ [field]: FieldValue.increment(1) }, { merge: true });
    },
    // Counts a new session against both limits at once. Resolves "ok", "browser_limit" or
    // "study_full"; a null maxPerStudy means no study-wide limit (and no study-wide count).
    claimSessionSlot(exp, uid, maxPerBrowser, maxPerStudy) {
      const browserRef = db.collection("experiments").doc(exp).collection("private_sessions_per_uid").doc(uid);
      const studyRef = db.collection("experiments").doc(exp).collection("private_counters").doc("sessions");
      return db.runTransaction(async (tx) => {
        const [b, s] = await Promise.all([tx.get(browserRef), tx.get(studyRef)]);
        const nBrowser = b.exists ? b.data().n || 0 : 0;
        const nStudy = s.exists ? s.data().n || 0 : 0;
        if (nBrowser >= maxPerBrowser) return "browser_limit";
        if (maxPerStudy != null && nStudy >= maxPerStudy) return "study_full";
        tx.set(browserRef, { n: nBrowser + 1 }, { merge: true });
        if (maxPerStudy != null) tx.set(studyRef, { n: nStudy + 1 }, { merge: true });
        return "ok";
      });
    },
    async getMessage(exp, pid, chat, seq) {
      const s = await messageRef(exp, pid, chat, seq).get();
      return s.exists ? s.data() : null;
    },
    async listMessages(exp, pid, chat) {
      const snap = await participant(exp, pid).collection("chat").where("chat_index", "==", chat).get();
      return snap.docs.map((d) => d.data()).sort((a, b) => a.seq - b.seq);
    },
    createMessage(exp, pid, msg) {
      return createIfAbsent(messageRef(exp, pid, msg.chat_index, msg.seq), msg);
    },
    async logEvent(exp, pid, event) {
      await participant(exp, pid).collection("chat_events").add(event);
    },
  };
}

module.exports = { createFirestoreStore };
