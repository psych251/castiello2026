/*
 * Private records for the chat service, kept in the same Firestore project as the experiment,
 * through the Admin SDK (which bypasses security rules). firestore.rules closes all of these
 * paths to browsers:
 *
 *   experiments/<id>/participants/<docId>/private/session    assignment, scores, prompts, model
 *   experiments/<id>/participants/<docId>/chat/c<chat>-<seq>  every message, both sides, in order
 *   experiments/<id>/participants/<docId>/chat_events/<auto>  failed, empty or flagged replies, stops (no text)
 *   experiments/<id>/participants/<docId>/withheld/<auto>     the text of replies the safety check withheld
 *   experiments/<id>/participants/<docId>/private/model_calls model calls and flags per reply (limits)
 *   experiments/<id>/private_invites/<sha256 of code>         invite codes for invite-only studies
 *   experiments/<id>/private_control/pause, chat_control/global   the pause switches
 *   experiments/<id>/private_sessions_per_uid/<uid>          how many sessions each browser started
 *   experiments/<id>/private_counters/sessions                how many sessions the study has started
 *
 * Another host (e.g. a Cloudflare Worker, which cannot run the Admin SDK) would implement these
 * same methods over Firestore's REST API.
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
    async saveWithheld(exp, pid, record) {
      await participant(exp, pid).collection("withheld").add(record);
    },
    // Paused if the global switch or the study's own is on. Resolves { paused, scope, study_set }:
    // study_set says whether the study's switch has ever been set (see default_paused).
    async getPause(exp) {
      const [g, e] = await Promise.all([
        db.collection("chat_control").doc("global").get(),
        db.collection("experiments").doc(exp).collection("private_control").doc("pause").get(),
      ]);
      const studySet = e.exists && typeof e.data().paused === "boolean";
      if (g.exists && g.data().paused === true) return { paused: true, scope: "global", study_set: studySet };
      if (e.exists && e.data().paused === true) return { paused: true, scope: "study", study_set: true };
      return { paused: false, scope: null, study_set: studySet };
    },
    async getInvite(exp, hash) {
      const s = await db.collection("experiments").doc(exp).collection("private_invites").doc(hash).get();
      return s.exists ? s.data() : null;
    },
    // One use of an invite, if it has any left. Resolves { ok, label }.
    claimInvite(exp, hash, uid, at) {
      const ref = db.collection("experiments").doc(exp).collection("private_invites").doc(hash);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists) return { ok: false };
        const d = s.data();
        if (d.revoked || (d.uses || 0) >= (d.max_uses || 0)) return { ok: false };
        tx.set(ref, { uses: (d.uses || 0) + 1, used: FieldValue.arrayUnion({ uid: uid, at: at }) }, { merge: true });
        return { ok: true, label: d.label || null };
      });
    },
    // Counts one model call for reply `key` against the limits. Resolves { ok, reason, flags }.
    // lease { owner, until (ms) }: while another owner's lease on `key` is current, resolves
    // { ok: false, reason: "in_progress" } and counts nothing.
    reserveModelCall(exp, pid, key, limits, lease) {
      const ref = participant(exp, pid).collection("private").doc("model_calls");
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const d = s.exists ? s.data() : {};
        const calls = (d.calls && d.calls[key]) || 0;
        const total = d.total || 0;
        const flags = (d.flags && d.flags[key]) || 0;
        const held = d.leases && d.leases[key];
        if (lease && held && held.owner !== lease.owner && held.until > Date.now()) return { ok: false, reason: "in_progress", flags, until: held.until };
        if (calls >= limits.max_model_calls_per_reply) return { ok: false, reason: "per_reply", flags };
        if (total >= limits.max_model_calls_per_session) return { ok: false, reason: "per_session", flags };
        tx.set(ref, { calls: { [key]: calls + 1 }, total: total + 1, ...(lease ? { leases: { [key]: lease } } : {}) }, { merge: true });
        return { ok: true, reason: null, flags };
      });
    },
    // The deadline of reply `key`: set by its first request (or anew by a manual retry), and
    // returned unchanged to every later request for it. Resolves the deadline (ms).
    replyDeadline(exp, pid, key, proposed, renew) {
      const ref = participant(exp, pid).collection("private").doc("model_calls");
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const held = s.exists && s.data().deadlines && s.data().deadlines[key];
        if (held && !renew) return held;
        tx.set(ref, { deadlines: { [key]: proposed } }, { merge: true });
        return proposed;
      });
    },
    // One more session for a Prolific ID (by hash), if it has fewer than `max`. Resolves true/false.
    claimProlificSession(exp, hash, max) {
      const ref = db.collection("experiments").doc(exp).collection("private_prolific").doc(hash);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const n = s.exists ? s.data().n || 0 : 0;
        if (n >= max) return false;
        tx.set(ref, { n: n + 1 }, { merge: true });
        return true;
      });
    },
    // Gives up `owner`'s lease on reply `key`, if it still holds it.
    releaseLease(exp, pid, key, owner) {
      const ref = participant(exp, pid).collection("private").doc("model_calls");
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const held = s.exists && s.data().leases && s.data().leases[key];
        if (held && held.owner === owner) tx.set(ref, { leases: { [key]: FieldValue.delete() } }, { merge: true });
      });
    },
    // One more flagged reply for `key`; resolves the new count.
    noteFlag(exp, pid, key) {
      const ref = participant(exp, pid).collection("private").doc("model_calls");
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const n = ((s.exists && s.data().flags && s.data().flags[key]) || 0) + 1;
        tx.set(ref, { flags: { [key]: n } }, { merge: true });
        return n;
      });
    },
  };
}

module.exports = { createFirestoreStore };
