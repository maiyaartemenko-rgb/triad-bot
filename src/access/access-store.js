// src/access/access-store.js
import fs from "node:fs";
import path from "node:path";

// Render persistent disk обычно смонтирован в /data
const RENDER_FILE = "/data/access.json";
const LOCAL_FILE = path.resolve(process.cwd(), "data/access.json");
const FILE = fs.existsSync("/data") ? RENDER_FILE : LOCAL_FILE;

// --- paid limits ---
const BASIC_DIALOG_LIMIT = 100;     // за период paid_until
const UNLIMITED_DAILY_LIMIT = 150;  // в день

// --- free window logic ---
const FREE_WINDOW_DAYS = 30;     // "месяц" скользящий
const FREE_DAYS_PER_WINDOW = 5;  // 5 раз (в разные дни)
const FREE_ANSWERS_PER_DAY = 2;  // по 2 ответа в выбранный день

// --- micro cycle (29 ₽ / 16 Stars) ---
const MICRO_WINDOW_HOURS = 24;
const MICRO_STEPS = 12;       // 12 ответов бота
const MICRO_FINAL = 1;        // + финальный (13-й)
const MICRO_TOTAL_ANSWERS = MICRO_STEPS + MICRO_FINAL;

// Follow-ups (оставляем совместимость, вдруг вернёшь)
const PAYWALL_PAUSE_DELAY_MS = 5 * 60 * 1000;
const PAYWALL_PITCH_DELAY_MS = 10 * 60 * 1000;
const UNLIMITED_NUDGE_DELAY_MS = 5 * 60 * 1000;

// ---------------- DB helpers ----------------

function ensureDbShape(db) {
  if (!db || typeof db !== "object") return { users: {} };
  if (!db.users || typeof db.users !== "object") db.users = {};
  return db;
}

// атомарная запись
function safeSave(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  const data = JSON.stringify(ensureDbShape(db), null, 2);
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, FILE);
}

function safeLoad() {
  try {
    if (!fs.existsSync(FILE)) return { users: {} };
    const txt = fs.readFileSync(FILE, "utf8");
    if (!String(txt || "").trim()) return { users: {} };
    const parsed = JSON.parse(txt);
    return ensureDbShape(parsed);
  } catch (e) {
    try {
      if (fs.existsSync(FILE)) {
        const corruptCopy = `${FILE}.corrupt.${Date.now()}`;
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

// ---------------- time helpers ----------------

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function hoursFromNowISO(hours) {
  const d = new Date();
  d.setHours(d.getHours() + Number(hours || 0));
  return d.toISOString();
}

function daysSinceISO(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Math.floor((Date.now() - t) / 86400000);
}

function isPaidActive(rec) {
  if (!rec?.paid_until) return false;
  const until = new Date(rec.paid_until).getTime();
  return Number.isFinite(until) && Date.now() < until;
}

function isMicroActive(rec) {
  if (!rec?.micro_active_until) return false;
  const until = new Date(rec.micro_active_until).getTime();
  const activeByTime = Number.isFinite(until) && Date.now() < until;
  const stageOk = rec.micro_stage === "active" || rec.micro_stage === "await_final";
  return activeByTime && stageOk;
}

// ---------------- record init ----------------

export function ensureUserRecord(contactId) {
  const key = String(contactId);
  const existing = getAccess(key);
  if (existing) return existing;

  return setAccess(key, {
    // paid
    plan: null,          // null | "basic" | "unlimited"
    paid_until: null,

    // day reset marker (для unlimited и "снятия залипания paywall")
    last_reset_date: todayStr(),
    daily_used: 0,

    // BASIC counters
    dialog_used: 0,
    dialog_warn95_sent: false,
    dialog_end100_sent: false,

    // PAYWALL HOLD (сервер молчит пока не оплатил микро/платный)
    // ВАЖНО: теперь paywall должен быть дневным, чтобы на следующий день вернулись 2 бесплатных
    paywall_shown: false,
    paywall_hold_notified: false,
    paywall_day: null,

    // follow-ups compatibility
    paywall_pause_due_at: null,
    paywall_pause_sent: false,
    paywall_pitch_due_at: null,
    paywall_pitch_sent: false,

    // unlimited upsell compatibility
    unlimited_upsell_shown: false,
    unlimited_nudge_due_at: null,
    unlimited_nudge_sent: false,

    // счетчик ответов бота (если где-то ещё используется)
    bot_answers_count: 0,

    // -------- FREE WINDOW (5×2 за 30 дней) --------
    trial_window_started_at: new Date().toISOString(), // начало 30-дневного окна
    trial_days_used: 0,            // сколько дней из 5 уже потратили
    trial_day: null,               // YYYY-MM-DD, день когда выдаём бесплатные 2
    trial_free_used_today: 0,      // 0..2

    // -------- MICRO (29 ₽, 12+1, 24 часа) --------
    micro_cycle_count: 0,          // сколько раз покупали (для аналитики/текстов)
    micro_active_until: null,      // ISO когда истекает 24 часа
    micro_started_at: null,        // ISO старта
    micro_stage: "idle",           // idle | active | await_final
    micro_used_answers: 0,         // сколько ответов бота выдано в цикле (0..13)
  });
}

/**
 * ✅ Запуск micro-цикла (вызываем из webhook после подтверждения оплаты)
 */
export function startMicroCycle(contactId) {
  const rec = ensureUserRecord(contactId);

  rec.micro_cycle_count = Number.isFinite(rec.micro_cycle_count) ? rec.micro_cycle_count + 1 : 1;
  rec.micro_started_at = new Date().toISOString();
  rec.micro_active_until = hoursFromNowISO(MICRO_WINDOW_HOURS);
  rec.micro_stage = "active";
  rec.micro_used_answers = 0;

  // важно: снимаем paywall hold, чтобы сервер снова отвечал
  rec.paywall_shown = false;
  rec.paywall_hold_notified = false;
  rec.paywall_day = null;

  return setAccess(contactId, rec);
}

/**
 * Возвращает:
 * ok: true|false
 * plan: "micro" | "trial" | "basic" | "unlimited" | null
 * reason: "micro_ended" | "paywall_hold" | "free_window_ended" | "daily_limit" | "dialog_limit" | "paid_ended" | "silent_limit" | null
 * extra:
 *  - null
 *  - "warn95"
 *  - "end100"
 *  - "micro_pre_final" (после 12-го ответа — надо прислать текст подытоживания)
 *  - "micro_end"       (после 13-го ответа — цикл завершён)
 */
export function checkAndConsumeQuota(contactId) {
  const rec = ensureUserRecord(contactId);
  const dayNow = todayStr();

  // 0) новый день — сброс дневных вещей
  if (rec.last_reset_date !== dayNow) {
    rec.last_reset_date = dayNow;
    rec.daily_used = 0;

    // снимаем "залипший" paywall на следующий день
    rec.paywall_shown = false;
    rec.paywall_hold_notified = false;
    rec.paywall_day = null;

    // free daily counter — тоже сбрасываем при смене дня
    if (rec.trial_day !== dayNow) {
      rec.trial_free_used_today = 0;
      rec.trial_day = null;
    }
  }

  // 1) если истёк paid план — сбросить
  if ((rec.plan === "basic" || rec.plan === "unlimited") && rec.paid_until) {
    const untilMs = new Date(rec.paid_until).getTime();
    if (Number.isFinite(untilMs) && untilMs <= Date.now()) {
      rec.plan = null;
      rec.paid_until = null;

      rec.daily_used = 0;

      rec.dialog_used = 0;
      rec.dialog_warn95_sent = false;
      rec.dialog_end100_sent = false;

      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: null, reason: "paid_ended", notify: true, extra: null };
    }
  }

  const paidActive = isPaidActive(rec);

  // 2) MICRO — приоритетнее всего
  if (isMicroActive(rec)) {
    const used = Number.isFinite(rec.micro_used_answers) ? rec.micro_used_answers : 0;
    const leftBefore = Math.max(0, MICRO_TOTAL_ANSWERS - used);

    if (leftBefore <= 0) {
      // на всякий случай
      rec.micro_stage = "idle";
      rec.micro_active_until = null;
      rec.micro_started_at = null;
      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: null, reason: "micro_ended", notify: false, extra: "micro_end" };
    }

    // consume 1 (1 сообщение пользователя -> 1 ответ бота)
    const nextUsed = used + 1;
    rec.micro_used_answers = nextUsed;

    let extra = null;
    let notify = false;

    // после 12-го ответа: нужно прислать серверный текст "подытожить" перед финальным
    if (nextUsed === MICRO_STEPS) {
      rec.micro_stage = "await_final";
      extra = "micro_pre_final";
      notify = true;
    }

    // после 13-го: цикл завершить
    if (nextUsed >= MICRO_TOTAL_ANSWERS) {
      rec.micro_stage = "idle";
      rec.micro_active_until = null;
      rec.micro_started_at = null;
      extra = "micro_end";
      notify = true;
    }

    setAccess(contactId, rec);

    return {
      ok: true,
      left: Math.max(0, MICRO_TOTAL_ANSWERS - nextUsed),
      plan: "micro",
      reason: null,
      notify,
      extra,
    };
  }

  // 3) PAYWALL HOLD (если включён и нет активного платного плана)
  const hasActivePaidPlan = (rec.plan === "basic" || rec.plan === "unlimited") && paidActive;
  if (rec.paywall_shown && !hasActivePaidPlan) {
    // важно: paywall дневной
    rec.paywall_day = rec.paywall_day || dayNow;
    const shouldNotify = rec.paywall_hold_notified ? false : true;
    rec.paywall_hold_notified = true;
    setAccess(contactId, rec);
    return { ok: false, left: 0, plan: null, reason: "paywall_hold", notify: shouldNotify, extra: null };
  }

  // 4) BASIC (100 сообщений за период)
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
    return { ok: true, left: BASIC_DIALOG_LIMIT - rec.dialog_used, plan: "basic", reason: null, notify, extra };
  }

  // 5) UNLIMITED (150/день)
  if (rec.plan === "unlimited" && paidActive) {
    if (rec.daily_used >= UNLIMITED_DAILY_LIMIT) {
      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: "unlimited", reason: "silent_limit", notify: false, extra: null };
    }
    rec.daily_used += 1;
    setAccess(contactId, rec);
    return { ok: true, left: UNLIMITED_DAILY_LIMIT - rec.daily_used, plan: "unlimited", reason: null, notify: false, extra: null };
  }

  // 6) FREE WINDOW (5 дней * 2 ответа, в течение 30 дней)
  // проверка: если окно закончилось — обнулить и начать заново
  const windowAge = daysSinceISO(rec.trial_window_started_at);
  if (!Number.isFinite(windowAge) || windowAge >= FREE_WINDOW_DAYS) {
    rec.trial_window_started_at = new Date().toISOString();
    rec.trial_days_used = 0;
    rec.trial_day = null;
    rec.trial_free_used_today = 0;
  }

  // если начался новый день бесплатных
  if (rec.trial_day !== dayNow) {
    // если лимит бесплатных дней исчерпан — бесплатного нет
    if ((Number.isFinite(rec.trial_days_used) ? rec.trial_days_used : 0) >= FREE_DAYS_PER_WINDOW) {
      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: null, reason: "free_window_ended", notify: true, extra: null };
    }

    // начинаем новый "бесплатный день"
    rec.trial_day = dayNow;
    rec.trial_free_used_today = 0;
    rec.trial_days_used = (Number.isFinite(rec.trial_days_used) ? rec.trial_days_used : 0) + 1;
  }

  // выдаём бесплатные ответы сегодня (0..2)
  const usedToday = Number.isFinite(rec.trial_free_used_today) ? rec.trial_free_used_today : 0;
  if (usedToday < FREE_ANSWERS_PER_DAY) {
    rec.trial_free_used_today = usedToday + 1;
    setAccess(contactId, rec);
    return {
      ok: true,
      left: FREE_ANSWERS_PER_DAY - rec.trial_free_used_today,
      plan: "trial",
      reason: null,
      notify: false,
      extra: null,
    };
  }

  // сегодня бесплатные закончились → дальше paywall (микро-покупка)
  setAccess(contactId, rec);
  return { ok: false, left: 0, plan: null, reason: "daily_limit", notify: true, extra: null };
}

// ---------------- compatibility exports ----------------

export function markPaywallShown(contactId) {
  const rec = ensureUserRecord(contactId);
  const now = Date.now();

  rec.paywall_shown = true;
  rec.paywall_hold_notified = false;
  rec.paywall_day = todayStr();

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

export function deleteAccess(contactId) {
  const db = safeLoad();
  const key = String(contactId);
  if (db.users && db.users[key]) {
    delete db.users[key];
    safeSave(db);
  }
  return true;
}
