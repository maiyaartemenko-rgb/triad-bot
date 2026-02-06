
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

// Follow-ups
const PAYWALL_PAUSE_DELAY_MS = 5 * 60 * 1000;
const PAYWALL_PITCH_DELAY_MS = 10 * 60 * 1000;
const UNLIMITED_NUDGE_DELAY_MS = 5 * 60 * 1000;

// ✅ атомарная запись: пишем во временный файл -> rename
function safeSave(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });

  const tmp = `${FILE}.tmp`;
  const data = JSON.stringify(db, null, 2);

  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, FILE);
}

// ✅ если JSON битый — НЕ затираем его молча, а сохраняем копию corrupt
function safeLoad() {
  try {
    const txt = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(txt);

    // лёгкая валидация структуры
    if (!parsed || typeof parsed !== "object") return { users: {} };
    if (!parsed.users || typeof parsed.users !== "object") parsed.users = {};
    return parsed;
  } catch (e) {
    // если файл существует и он битый — сохраняем его под другим именем
    try {
      if (fs.existsSync(FILE)) {
        const corruptName = `${FILE}.corrupt.${Date.now()}`;
        fs.renameSync(FILE, corruptName);
        console.error("ACCESS_DB_CORRUPT: moved to", corruptName);
      }
    } catch (e2) {
      console.error("ACCESS_DB_CORRUPT_RENAME_FAILED:", e2);
    }
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

  if (rec.plan === "unlimited") return isPaidActive(rec) ? UNLIMITED_DAILY_LIMIT : 0;
  if (rec.plan === "basic") return isPaidActive(rec) ? BASIC_DIALOG_LIMIT : 0;

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
    daily_used: 0,
    trial_end_notified: false,

    // BASIC 100/мес
    dialog_used: 0,
    dialog_warn95_sent: false,
    dialog_end100_sent: false,

    // PAYWALL FLOW (после 2-го ответа)
    paywall_shown: false,

    // ✅ жесткая блокировка после paywall, чтобы бот не продолжал отвечать
    // notify=true один раз, дальше notify=false (чтобы не спамить)
    paywall_hold_notified: false,

    // ✅ follow-ups после paywall (2 шага)
    paywall_pause_due_at: null,
    paywall_pause_sent: false,
    paywall_pitch_due_at: null,
    paywall_pitch_sent: false,

    // ✅ upsell unlimited (после 100-го)
    unlimited_upsell_shown: false,
    unlimited_nudge_due_at: null,
    unlimited_nudge_sent: false,
  });
}

/**
 * Возвращает:
 * ok: true|false
 * left: сколько осталось
 * plan: "trial" | "basic" | "unlimited" | null
 * reason:
 *  - null
 *  - "paywall_hold" (после 2-го ответа, пока не оплатил BASIC)
 *  - "daily_limit" (trial/unlimited)
 *  - "trial_ended"
 *  - "paid_ended"
 *  - "silent_limit" (unlimited как было)
 *  - "dialog_limit" (basic >100)
 * notify: true|false
 * extra: null | "warn95" | "end100"
 */
export function checkAndConsumeQuota(contactId) {
  const rec = ensureUserRecord(contactId);
  const dayNow = todayStr();

  // 1) если подписка истекла — сбрасываем план
  let paidJustEnded = false;
  if ((rec.plan === "basic" || rec.plan === "unlimited") && rec.paid_until) {
    const untilMs = new Date(rec.paid_until).getTime();
    if (Number.isFinite(untilMs) && untilMs <= Date.now()) {
      paidJustEnded = true;
      rec.plan = null;
      rec.paid_until = null;

      // сброс диалога
      rec.dialog_used = 0;
      rec.dialog_warn95_sent = false;
      rec.dialog_end100_sent = false;

      // сброс paywall flow
      rec.paywall_shown = false;
      rec.paywall_hold_notified = false;

      rec.paywall_pause_due_at = null;
      rec.paywall_pause_sent = false;

      rec.paywall_pitch_due_at = null;
      rec.paywall_pitch_sent = false;

      // сброс unlimited followup
      rec.unlimited_upsell_shown = false;
      rec.unlimited_nudge_due_at = null;
      rec.unlimited_nudge_sent = false;

      // сброс trial/day
      rec.daily_used = 0;
    }
  }

  // 2) новый день → сбрасываем дневной счётчик (trial/unlimited)
  if (rec.last_reset_date !== dayNow) {
    rec.last_reset_date = dayNow;
    rec.daily_used = 0;
  }

  const trialActive = isTrialActive(rec);
  const paidActive = isPaidActive(rec);
  const limit = planLimit(rec);

  // ✅ PAYWALL HOLD: после 2-го ответа — пока нет активного платного плана, бот НЕ отвечает
  // Важно: не тратим trial/daily лимиты в этом состоянии.
  const hasActivePaidPlan = (rec.plan === "basic" || rec.plan === "unlimited") && paidActive;

  if (rec.paywall_shown && !hasActivePaidPlan) {
    const shouldNotify = rec.paywall_hold_notified ? false : true;
    rec.paywall_hold_notified = true;
    setAccess(contactId, rec);

    return {
      ok: false,
      left: 0,
      plan: null,
      reason: "paywall_hold",
      notify: shouldNotify,
      extra: null,
    };
  }

  // 3) если лимит 0 — нет доступа
  if (limit <= 0) {
    // trial закончился
    if (!trialActive && !paidActive && !rec.plan) {
      const shouldNotify = rec.trial_end_notified ? false : true;
      rec.trial_end_notified = true;
      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: null, reason: "trial_ended", notify: shouldNotify, extra: null };
    }

    // paid закончился
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
    return { ok: true, left: UNLIMITED_DAILY_LIMIT - rec.daily_used, plan: "unlimited", reason: null, notify: false, extra: null };
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

/**
 * ✅ Вызывать в момент, когда отправили paywall после 2-го ответа бота.
 * СТРОГО ПО ТЗ:
 *  - планирует через 5 минут "Диалог приостановлен"
 *  - ещё через 5 минут "Доведи этот разговор..."
 */
export function markPaywallShown(contactId) {
  const rec = ensureUserRecord(contactId);
  const now = Date.now();

  rec.paywall_shown = true;

  // ✅ сбрасываем, чтобы notify сработал 1 раз при следующем сообщении пользователя
  rec.paywall_hold_notified = false;

  // планируем 2 follow-up
  rec.paywall_pause_due_at = new Date(now + PAYWALL_PAUSE_DELAY_MS).toISOString();
  rec.paywall_pause_sent = false;

  rec.paywall_pitch_due_at = new Date(now + PAYWALL_PITCH_DELAY_MS).toISOString();
  rec.paywall_pitch_sent = false;

  return setAccess(contactId, rec);
}

/**
 * ✅ Вызывать когда показали сообщение "Кнопка оплаты безлимита" (после 100-го).
 * СТРОГО ПО ТЗ: follow-up через 5 минут.
 */
export function markUnlimitedUpsellShown(contactId) {
  const rec = ensureUserRecord(contactId);
  const now = Date.now();

  rec.unlimited_upsell_shown = true;
  rec.unlimited_nudge_due_at = new Date(now + UNLIMITED_NUDGE_DELAY_MS).toISOString();
  rec.unlimited_nudge_sent = false;

  return setAccess(contactId, rec);
}

/**
 * ✅ Основная функция для планировщика в боте.
 * Возвращает, кому пора отправить follow-up, и помечает как sent.
 *
 * Возвращает:
 *  { paywallPause: [...], paywallPitch: [...], unlimited: [...] }
 */
export function consumeDueFollowups() {
  const db = safeLoad();
  const nowMs = Date.now();

  const duePaywallPause = [];
  const duePaywallPitch = [];
  const dueUnlimited = [];

  for (const [contactId, rec] of Object.entries(db.users || {})) {
    if (!rec) continue;

    // PAYWALL PAUSE (+5): только если paywall показан и человек всё ещё не оплатил
    if (rec.paywall_shown && !rec.paywall_pause_sent && rec.paywall_pause_due_at) {
      const dueMs = new Date(rec.paywall_pause_due_at).getTime();
      const stillNotPaid = !isPaidActive(rec);
      if (Number.isFinite(dueMs) && dueMs <= nowMs && stillNotPaid) {
        rec.paywall_pause_sent = true;
        duePaywallPause.push(contactId);
      }
    }

    // PAYWALL PITCH (+10): только если всё ещё не оплатил
    if (rec.paywall_shown && !rec.paywall_pitch_sent && rec.paywall_pitch_due_at) {
      const dueMs = new Date(rec.paywall_pitch_due_at).getTime();
      const stillNotPaid = !isPaidActive(rec);
      if (Number.isFinite(dueMs) && dueMs <= nowMs && stillNotPaid) {
        rec.paywall_pitch_sent = true;
        duePaywallPitch.push(contactId);
      }
    }

    // UNLIMITED NUDGE (+5): если upsell был показан и unlimited не активирован/не оплачен
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

/**
 * ✅ Если у тебя есть "начать новый диалог" — вызови это.
 * (сбрасывает счётчик 95/100 и follow-ups)
 */
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
