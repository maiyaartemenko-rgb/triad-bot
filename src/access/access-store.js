// src/access/access-store.js
import fs from "node:fs";
import path from "node:path";

// Render persistent disk обычно смонтирован в /data
const RENDER_FILE = "/data/access.json";
const LOCAL_FILE = path.resolve(process.cwd(), "data/access.json");

// ✅ всегда пишем в /data если он доступен, иначе локально
const FILE = fs.existsSync("/data") ? RENDER_FILE : LOCAL_FILE;

// --- limits ---
const BASIC_DIALOG_LIMIT = 100;
const UNLIMITED_DAILY_LIMIT = 150;
const TRIAL_DAILY_LIMIT = 3;
const TRIAL_DAYS = 3;

// Follow-ups (оставляем — вдруг вернёшь; сейчас можно не использовать)
const PAYWALL_PAUSE_DELAY_MS = 5 * 60 * 1000;
const PAYWALL_PITCH_DELAY_MS = 10 * 60 * 1000;
const UNLIMITED_NUDGE_DELAY_MS = 5 * 60 * 1000;

function ensureDbShape(db) {
  if (!db || typeof db !== "object") return { users: {} };
  if (!db.users || typeof db.users !== "object") db.users = {};
  return db;
}

// ✅ атомарная запись: пишем во временный файл -> rename
function safeSave(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });

  const tmp = `${FILE}.tmp`;
  const data = JSON.stringify(ensureDbShape(db), null, 2);

  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, FILE);
}

/**
 * ✅ ВАЖНО: НЕ переименовываем основной файл на .corrupt.
 * Потому что при ручной правке/частичном сохранении ты получаешь "данные исчезли".
 *
 * Вместо этого:
 *  - если JSON битый, делаем COPY в *.corrupt.* (для диагностики)
 *  - основной файл оставляем как есть
 *  - возвращаем пустую базу { users: {} }
 */
function safeLoad() {
  try {
    if (!fs.existsSync(FILE)) return { users: {} };

    const txt = fs.readFileSync(FILE, "utf8");

    // пустой файл = частая ситуация при ручной правке
    if (!String(txt || "").trim()) return { users: {} };

    const parsed = JSON.parse(txt);
    return ensureDbShape(parsed);
  } catch (e) {
    try {
      if (fs.existsSync(FILE)) {
        const corruptCopy = `${FILE}.corrupt.${Date.now()}`;
        // copy, а не rename
        fs.copyFileSync(FILE, corruptCopy);
        console.error("ACCESS_DB_CORRUPT: copied to", corruptCopy);
      }
    } catch (e2) {
      console.error("ACCESS_DB_CORRUPT_COPY_FAILED:", e2);
    }
    console.error("ACCESS_DB_LOAD_ERROR:", e);
    return { users: {} };
  }
}

export function getAccess(contactId) {
  const db = safeLoad();
  return db.users[String(contactId)] || null;
}

export function setAccess(contactId, data) {
  const db = safeLoad();
  const key = String(contactId);
  db.users[key] = { ...(db.users[key] || {}), ...(data || {}) };
  safeSave(db);
  return db.users[key];
}

function todayStr() {
  // UTC день — ок для Render
  return new Date().toISOString().slice(0, 10);
}

function daysSinceISO(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Math.floor((Date.now() - t) / 86400000);
}

function isTrialActive(rec) {
  if (!rec?.trial_started_at) return false;
  return daysSinceISO(rec.trial_started_at) < TRIAL_DAYS;
}

function isPaidActive(rec) {
  if (!rec?.paid_until) return false;
  const until = new Date(rec.paid_until).getTime();
  return Number.isFinite(until) && Date.now() < until;
}

function planLimit(rec) {
  if (!rec) return 0;

  // paid plans
  if (rec.plan === "unlimited") return isPaidActive(rec) ? UNLIMITED_DAILY_LIMIT : 0;
  if (rec.plan === "basic") return isPaidActive(rec) ? BASIC_DIALOG_LIMIT : 0;

  // trial
  if (isTrialActive(rec)) return TRIAL_DAILY_LIMIT;

  return 0;
}

export function ensureUserRecord(contactId) {
  const key = String(contactId);
  const existing = getAccess(key);

  if (existing) return existing;

  return setAccess(key, {
    plan: null,
    paid_until: null,

    // trial
    trial_started_at: new Date().toISOString(),
    last_reset_date: todayStr(),
    bot_answers_count: 0,
    daily_used: 0,
    trial_end_notified: false,

    // BASIC 100/мес
    dialog_used: 0,
    dialog_warn95_sent: false,
    dialog_end100_sent: false,

    // PAYWALL / OFFER MODE (после 2-го ответа)
    paywall_shown: false,
    paywall_hold_notified: false,

    // follow-ups (если захочешь вернуть)
    paywall_pause_due_at: null,
    paywall_pause_sent: false,
    paywall_pitch_due_at: null,
    paywall_pitch_sent: false,

    // upsell unlimited
    unlimited_upsell_shown: false,
    unlimited_nudge_due_at: null,
    unlimited_nudge_sent: false,

    // счётчик ответов бота (для “после 2-го”)
    bot_answers_count: 0,
  });
}

/**
 * Возвращает:
 * ok: true|false
 * left: сколько осталось
 * plan: "trial" | "basic" | "unlimited" | null
 * reason:
 *  - null
 *  - "paywall_hold"
 *  - "daily_limit"
 *  - "trial_ended"
 *  - "paid_ended"
 *  - "silent_limit"
 *  - "dialog_limit"
 * notify: true|false
 * extra: null | "warn95" | "end100"
 */
export function checkAndConsumeQuota(contactId) {
  const rec = ensureUserRecord(contactId);
  const dayNow = todayStr();

  // 1) если подписка истекла — сбрасываем план (и счетчики)
  if ((rec.plan === "basic" || rec.plan === "unlimited") && rec.paid_until) {
    const untilMs = new Date(rec.paid_until).getTime();
    if (Number.isFinite(untilMs) && untilMs <= Date.now()) {
      rec.plan = null;
      rec.paid_until = null;

      rec.daily_used = 0;

      rec.dialog_used = 0;
      rec.dialog_warn95_sent = false;
      rec.dialog_end100_sent = false;

      rec.paywall_shown = false;
      rec.paywall_hold_notified = false;

      rec.paywall_pause_due_at = null;
      rec.paywall_pause_sent = false;
      rec.paywall_pitch_due_at = null;
      rec.paywall_pitch_sent = false;

      rec.unlimited_upsell_shown = false;
      rec.unlimited_nudge_due_at = null;
      rec.unlimited_nudge_sent = false;

      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: null, reason: "paid_ended", notify: true, extra: null };
    }
  }

  // 2) новый день → сброс дневного счётчика
  if (rec.last_reset_date !== dayNow) {
    rec.last_reset_date = dayNow;
    rec.daily_used = 0;
  }

  const trialActive = isTrialActive(rec);
  const paidActive = isPaidActive(rec);
  const limit = planLimit(rec);

  // ✅ PAYWALL HOLD (режим оффера): если он включён и НЕТ активного платного плана — блокируем GPT
  // Важно: платным НЕ мешаем.
  const hasActivePaidPlan = (rec.plan === "basic" || rec.plan === "unlimited") && paidActive;

  if (rec.paywall_shown && !hasActivePaidPlan) {
    const shouldNotify = rec.paywall_hold_notified ? false : true;
    rec.paywall_hold_notified = true;
    setAccess(contactId, rec);
    return { ok: false, left: 0, plan: null, reason: "paywall_hold", notify: shouldNotify, extra: null };
  }

  // 3) если лимит 0 — нет доступа
  if (limit <= 0) {
    if (!trialActive && !paidActive && !rec.plan) {
      const shouldNotify = rec.trial_end_notified ? false : true;
      rec.trial_end_notified = true;
      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: null, reason: "trial_ended", notify: shouldNotify, extra: null };
    }

    setAccess(contactId, rec);
    return { ok: false, left: 0, plan: null, reason: "paid_ended", notify: true, extra: null };
  }

  // 4) BASIC: 100 сообщений за срок paid_until
  if (rec.plan === "basic") {
    const used = Number.isFinite(rec.dialog_used) ? rec.dialog_used : 0;

    if (used >= BASIC_DIALOG_LIMIT) {
      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: "basic", reason: "dialog_limit", notify: true, extra: "end100" };
    }

    rec.dialog_used = used + 1;

    let extra = null;
    let notify = false;

    if (rec.dialog_used === 95 && !rec.dialog_warn95_sent) {
      rec.dialog_warn95_sent = true;
      extra = "warn95";
      notify = true;
    }

    if (rec.dialog_used === 100 && !rec.dialog_end100_sent) {
      rec.dialog_end100_sent = true;
      extra = "end100";
      notify = true;
    }

    setAccess(contactId, rec);
    return {
      ok: true,
      left: BASIC_DIALOG_LIMIT - rec.dialog_used,
      plan: "basic",
      reason: null,
      notify,
      extra,
    };
  }

  // 5) UNLIMITED: 150/день, silent_limit
  if (rec.plan === "unlimited" && limit === UNLIMITED_DAILY_LIMIT) {
    if (rec.daily_used >= UNLIMITED_DAILY_LIMIT) {
      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: "unlimited", reason: "silent_limit", notify: false, extra: null };
    }

    rec.daily_used += 1;
    setAccess(contactId, rec);
    return {
      ok: true,
      left: UNLIMITED_DAILY_LIMIT - rec.daily_used,
      plan: "unlimited",
      reason: null,
      notify: false,
      extra: null,
    };
  }

  // 6) TRIAL
  if (rec.daily_used < limit) {
    rec.daily_used += 1;
    setAccess(contactId, rec);
    const planLabel = rec.plan || (trialActive ? "trial" : null);
    return { ok: true, left: limit - rec.daily_used, plan: planLabel, reason: null, notify: false, extra: null };
  }

  // 7) trial дневной лимит исчерпан
  setAccess(contactId, rec);
  return { ok: false, left: 0, plan: rec.plan || (trialActive ? "trial" : null), reason: "daily_limit", notify: true, extra: null };
}

// ---- followup exports (оставляю совместимость) ----

export function markPaywallShown(contactId) {
  const rec = ensureUserRecord(contactId);
  const now = Date.now();

  rec.paywall_shown = true;
  rec.paywall_hold_notified = false;

  rec.paywall_pause_due_at = new Date(now + PAYWALL_PAUSE_DELAY_MS).toISOString();
  rec.paywall_pause_sent = false;

  rec.paywall_pitch_due_at = new Date(now + PAYWALL_PITCH_DELAY_MS).toISOString();
  rec.paywall_pitch_sent = false;

  return setAccess(contactId, rec);
}

export function markUnlimitedUpsellShown(contactId) {
  const rec = ensureUserRecord(contactId);
  const now = Date.now();

  rec.unlimited_upsell_shown = true;
  rec.unlimited_nudge_due_at = new Date(now + UNLIMITED_NUDGE_DELAY_MS).toISOString();
  rec.unlimited_nudge_sent = false;

  return setAccess(contactId, rec);
}

export function consumeDueFollowups() {
  const db = safeLoad();
  const nowMs = Date.now();

  const duePaywallPause = [];
  const duePaywallPitch = [];
  const dueUnlimited = [];

  for (const [contactId, rec] of Object.entries(db.users || {})) {
    if (!rec) continue;

    if (rec.paywall_shown && !rec.paywall_pause_sent && rec.paywall_pause_due_at) {
      const dueMs = new Date(rec.paywall_pause_due_at).getTime();
      const stillNotPaid = !isPaidActive(rec);
      if (Number.isFinite(dueMs) && dueMs <= nowMs && stillNotPaid) {
        rec.paywall_pause_sent = true;
        duePaywallPause.push(contactId);
      }
    }

    if (rec.paywall_shown && !rec.paywall_pitch_sent && rec.paywall_pitch_due_at) {
      const dueMs = new Date(rec.paywall_pitch_due_at).getTime();
      const stillNotPaid = !isPaidActive(rec);
      if (Number.isFinite(dueMs) && dueMs <= nowMs && stillNotPaid) {
        rec.paywall_pitch_sent = true;
        duePaywallPitch.push(contactId);
      }
    }

    if (rec.unlimited_upsell_shown && !rec.unlimited_nudge_sent && rec.unlimited_nudge_due_at) {
      const dueMs = new Date(rec.unlimited_nudge_due_at).getTime();
      const unlimitedActive = rec.plan === "unlimited" && isPaidActive(rec);
      if (Number.isFinite(dueMs) && dueMs <= nowMs && !unlimitedActive) {
        rec.unlimited_nudge_sent = true;
        dueUnlimited.push(contactId);
      }
    }
  }

  safeSave(db);
  return { paywallPause: duePaywallPause, paywallPitch: duePaywallPitch, unlimited: dueUnlimited };
}

export function resetDialogCounters(contactId) {
  const rec = ensureUserRecord(contactId);

  rec.dialog_used = 0;
  rec.dialog_warn95_sent = false;
  rec.dialog_end100_sent = false;

  rec.paywall_shown = false;
  rec.paywall_hold_notified = false;

  rec.paywall_pause_due_at = null;
  rec.paywall_pause_sent = false;

  rec.paywall_pitch_due_at = null;
  rec.paywall_pitch_sent = false;

  rec.unlimited_upsell_shown = false;
  rec.unlimited_nudge_due_at = null;
  rec.unlimited_nudge_sent = false;

  return setAccess(contactId, rec);
}
