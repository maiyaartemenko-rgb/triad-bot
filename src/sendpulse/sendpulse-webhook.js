// src/sendpulse/sendpulse-webhook.js

import { triadChat } from "../triad/triad-openai.js";
import { parsePartnerFromTextV4 } from "../parsing/parsePartnerFromText.v4.js";
import { sendpulseTelegramSendText, sendpulseTelegramSendButtons } from "./sendpulse-api.js";
import { setTgMap } from "../access/tg-map-store.js";

// путь как у тебя сейчас
import { getHistory, pushToHistory, clearHistory } from "../src/memory/memory-store.js";

import {
  checkAndConsumeQuota,
  getAccess,
  setAccess,
  markPaywallShown,
  markUnlimitedUpsellShown,
  consumeDueFollowups,
} from "../access/access-store.js";

// ---------- helpers ----------
function getEvent(payload) {
  return Array.isArray(payload) ? (payload[0] ?? {}) : (payload ?? {});
}

function safeStr(x) {
  return String(x ?? "").trim();
}

// ✅ единый безопасный способ отправки кнопок: если SendPulse 500 → отправляем ссылки
async function sendWithButtonsFallback({ contactId, text, buttons }) {
  try {
    return await sendpulseTelegramSendButtons({ contactId, text, buttons });
  } catch (e) {
    console.error("SENDPULSE_BUTTONS_ERROR:", e);

    const links = (buttons || [])
      .filter((b) => b?.text && b?.url)
      .map((b) => `👉 <a href="${String(b.url)}">${String(b.text)}</a>`)
      .join("\n");

    return await sendpulseTelegramSendText({
      contactId,
      text: [text, links].filter(Boolean).join("\n\n"),
    });
  }
}

// --- PROMO TIMER ---
const PROMO_UNTIL_ISO = process.env.PROMO_UNTIL_ISO || "2026-02-04T23:59:59+03:00";
// (до конца дня 4 февраля по Москве)
function isPromoActive() {
  const until = new Date(PROMO_UNTIL_ISO).getTime();
  return Number.isFinite(until) && Date.now() <= until;
}

function extractText(event) {
  return event?.info?.message?.channel_data?.message?.text ?? event?.contact?.last_message ?? "";
}

function extractContactId(event) {
  return event?.contact?.id ?? null;
}

function extractTelegramUserId(event) {
  const candidates = [
    event?.info?.message?.channel_data?.message?.from?.id,
    event?.info?.message?.channel_data?.from?.id,
    event?.info?.message?.channel_data?.message?.chat?.id,
    event?.info?.message?.channel_data?.chat?.id,
    event?.contact?.telegram_user_id,
    event?.contact?.telegram_id,
    event?.contact?.external_id,
  ];

  const v = candidates.find((x) => x !== undefined && x !== null && safeStr(x) !== "");
  return v ? safeStr(v) : null;
}

function normalizeMainSignFromVars(vars) {
  const raw = vars?.Animal || vars?.animal || "";
  return safeStr(raw).replace(/[^\p{L}\s-]/gu, "").trim().toUpperCase();
}

function parseActiveSigns(vars) {
  const raw = vars?.active_signs || "";
  if (!raw) return [];
  try {
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => ({
        sign: safeStr(x?.sign).toUpperCase(),
        pct: Number(x?.pct ?? 0),
      }))
      .filter((x) => x.sign && Number.isFinite(x.pct));
  } catch (err) {
    console.error("Bad active_signs JSON:", err);
    return [];
  }
}

function decodeHtmlEntities(s = "") {
  return String(s).replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

// ---------- TEXTS (СТРОГО ТВОИ) ----------
const PAYWALL_AFTER_2_TEXT = [
  "Ты подошёл к тому моменту,",
  "когда разговор обычно",
  "либо обрывают ✋",
  "либо продолжают — по-настоящему 🔥",
  "Следующий ответ",
  "соберёт то, что сейчас только нащупано 🧩✨",
  "",
  "Ты можешь остановиться здесь ⏸",
  "",
  "Или продолжить разговор",
  "без пауз 👇🏻💬",
].join("\n");

const DIALOG_PAUSED_TEXT = ["Диалог приостановлен ⏸", "", "Ты можешь вернуться, когда будешь готов 🌿"].join(
  "\n"
);

const BASIC_PITCH_TEXT = [
  "Доведи этот разговор до ясности прямо сейчас!",
  "Этот формат — для тех,",
  "кто хочет не просто получить ответ 💬",
  "а понять, что происходит на самом деле ещё глубже 🧩",
  "",
  "Ты получишь ответы",
  "без шаблонов и общих советов 🧠",
  "",
  "Вместе с разговором мы подарим БОНУС - полный разбор твоего знака —",
  "подробный PDF на 20+ страниц 📘",
  "Это личная карта твоей жизни:",
  "с кем тебе лучше строить близость и любовь ❤️",
  "как найти своё предназначение 🎯",
  "где и как зарабатывать деньги 💼💸",
  "и в чём твоя истинная  миссия ✨",
  "",
  "Разговор даёт рост и сдвиг 🔥",
  "А разбор помогает удержать это понимание",
  "и возвращаться к нему снова, когда жизнь задаёт новые вопросы 🌿🔁",
].join("\n");

const BASIC_95_WARN_TEXT = [
  "Мы подходим к завершению этого разговора 🔚",
  "",
  "Я хочу собрать главное 🧩",
  "и зафиксировать то,",
  "что для тебя сейчас ключевое ✨",
  "",
  "💬Для более продуктивного завершения диалога напиши в бот ответы на вопросы:",
  "",
  "1️⃣ Что из этого разговора для тебя сейчас самое важное? 🧩",
  "",
  "2️⃣ Что стало яснее или встало на своё место? ✨",
  "",
  "3️⃣ Если ты вернёшься к разговору позже — про что он будет? 🔁💭",
  "",
  "4️⃣ В каком состоянии ты сейчас по сравнению с началом? 🌊",
  "",
  "5️⃣Если собрать всё в одну фразу — что ты понял(а)? 💬",
].join("\n");

const BASIC_100_END_TEXT = [
  "Мы завершили этот разговор 😌",
  "",
  "Если ты захочешь разобрать другую тему или пойти глубже — можно начать новый диалог 💬✨",
].join("\n");

const UNLIMITED_NUDGE_TEXT = [
  "Ты уже попробовал решить одну задачу 🧩",
  "И, скорее всего, почувствовал,",
  "что с этим ботом можно разбирать",
  "не только большие вопросы,",
  "но и самые повседневные 💬",
  "",
  "От глобального —",
  "в какой сфере искать себя и работу 💼",
  "до простого —",
  "что надеть на свидание и как себя вести ❤️",
  "",
  "Безлимит — это формат,",
  "в котором бот становится",
  "твоим прикладным помощником по жизни 🌿",
  "Ты встраиваешь его в свой день,",
  "и решения даются легче,",
  "потому что они учитывают",
  "твои внутренние потребности и ритм 🧠✨",
  "",
  "🎁 Бонус сразу после оплаты:",
  "ты получаешь 3 дополнительных файла 📂",
  "— совместимость с другими знаками ❤️",
  "— как раскрыть свою силу 💪",
  "— формула успеха и богатства 💸✨",
  "",
  "⸻",
  "",
  "🔓 Открыть безлимитный формат",
].join("\n");

// ---------- PAYWALL ----------
function buildPaywallText({ gate, mode = "auto" }) {
  if (mode === "manual") return "<b>Выберите доступ:</b>";

  const reason = gate?.reason || null;

  if (reason === "paid_ended") {
    return ["⛔ <b>Сейчас нет активного доступа.</b>", "Чтобы продолжить — выбери формат ниже 👇", "", "<b>Доступы:</b>"].join("\n");
  }

  if (reason === "trial_ended") {
    return ["⛔ <b>Бесплатный доступ завершён.</b>", "", "Если хочешь продолжить — выбери формат ниже 👇", "", "<b>Доступы:</b>"].join("\n");
  }

  if (reason === "daily_limit") {
    return ["⛔ <b>Лимит сообщений исчерпан.</b>", "Чтобы продолжить разговор без остановок — выбери формат ниже 👇", "", "<b>Доступы:</b>"].join("\n");
  }

  return ["⛔ <b>Ограничение доступа.</b>", "Чтобы продолжить — выбери формат ниже 👇", "", "<b>Доступы:</b>"].join("\n");
}

function getPublicBaseUrl(req) {
  const envBase = safeStr(process.env.PUBLIC_BASE_URL);
  if (envBase) return envBase.replace(/\/$/, "");

  const proto = safeStr(req.headers["x-forwarded-proto"]) || "https";
  const host = safeStr(req.headers["x-forwarded-host"]) || safeStr(req.headers.host);
  if (!host) return "";

  return `${proto}://${host}`.replace(/\/$/, "");
}

function getPublicBaseUrlEnvOnly() {
  const envBase = safeStr(process.env.PUBLIC_BASE_URL);
  return envBase ? envBase.replace(/\/$/, "") : "";
}

function getPayLinksBase(base, contactId) {
  if (!base) return { basic: null, unlimited: null };
  return {
    basic: `${base}/pay/basic?cid=${encodeURIComponent(contactId)}`,
    unlimited: `${base}/pay/unlimited?cid=${encodeURIComponent(contactId)}`,
  };
}

function getPayLinks(req, contactId) {
  const base = getPublicBaseUrl(req);
  return getPayLinksBase(base, contactId);
}

async function sendPaywall(req, contactId, gate, mode = "auto") {
  const { basic, unlimited } = getPayLinks(req, contactId);

  if (!basic || !unlimited) {
    await sendpulseTelegramSendText({
      contactId,
      text:
        "⛔ Ограничение доступа.\n\n" +
        "⚠️ Не могу построить ссылки оплаты.\n" +
        "Проверь в Render переменную PUBLIC_BASE_URL\n" +
        "и что в server.js есть роуты /pay/basic и /pay/unlimited.",
    });
    return;
  }

  const header = buildPaywallText({ gate, mode });
  const promo = isPromoActive();

  const priceLines = promo
    ? [
        `• <s>1490 ₽</s> <b>490 ₽</b> — 100 вопросов на 1 месяц: <a href="${basic}">Оплатить</a>`,
        `• <s>2990 ₽</s> <b>1990 ₽</b> — безлимит: <a href="${unlimited}">Оплатить</a>`,
        `\n⏳ <i>Скидка действует до 4 февраля 2026</i>`,
      ]
    : [
        `• <b>1490 ₽</b> — 100 вопросов на 1 месяц: <a href="${basic}">Оплатить</a>`,
        `• <b>2990 ₽</b> — безлимит: <a href="${unlimited}">Оплатить</a>`,
      ];

  const out = [header, ...priceLines].join("\n");
  await sendpulseTelegramSendText({ contactId, text: out });
}

async function sendBasicPayButton(req, contactId, prefixText = "") {
  const { basic } = getPayLinks(req, contactId);
  if (!basic) return;

  return sendWithButtonsFallback({
    contactId,
    text: String(prefixText ?? ""),
    buttons: [{ text: "Продолжить диалог", url: basic }],
  });
}

async function sendUnlimitedPayButton(req, contactId, prefixText = "") {
  const { unlimited } = getPayLinks(req, contactId);
  if (!unlimited) return;

  return sendWithButtonsFallback({
    contactId,
    text: String(prefixText ?? ""),
    buttons: [{ text: "Открыть безлимит", url: unlimited }],
  });
}

// ---------- FOLLOW-UP SCHEDULER (из access-store) ----------
let __followupSchedulerStarted = false;
function startFollowupSchedulerOnce() {
  if (__followupSchedulerStarted) return;
  __followupSchedulerStarted = true;

  const base = getPublicBaseUrlEnvOnly();
  if (!base) {
    console.warn("FOLLOWUP: PUBLIC_BASE_URL not set; follow-ups will be skipped.");
    return;
  }

  setInterval(async () => {
    try {
      const due = consumeDueFollowups();

      // 1) +5 минут после paywall
      for (const contactId of due.paywallPause || []) {
        const { basic } = getPayLinksBase(base, contactId);
        if (!basic) continue;

        await sendWithButtonsFallback({
          contactId,
          text: DIALOG_PAUSED_TEXT,
          buttons: [{ text: "Продолжить диалог", url: basic }],
        });
      }

      // 2) +10 минут после paywall
      for (const contactId of due.paywallPitch || []) {
        const { basic } = getPayLinksBase(base, contactId);
        if (!basic) continue;

        await sendWithButtonsFallback({
          contactId,
          text: BASIC_PITCH_TEXT,
          buttons: [{ text: "Продолжить диалог", url: basic }],
        });
      }

      // 3) +5 минут после upsell безлимита
      for (const contactId of due.unlimited || []) {
        const { unlimited } = getPayLinksBase(base, contactId);
        if (!unlimited) continue;

        await sendWithButtonsFallback({
          contactId,
          text: UNLIMITED_NUDGE_TEXT,
          buttons: [{ text: "Открыть безлимит", url: unlimited }],
        });
      }
    } catch (e) {
      console.error("FOLLOWUP_SCHEDULER_ERROR:", e);
    }
  }, 30_000);
}

// ---------- main ----------
export async function handleSendpulseWebhook(req, res) {
  startFollowupSchedulerOnce();
  res.status(200).json({ ok: true });

  try {
    const event = getEvent(req.body);
    if (event?.title !== "incoming_message") return;

    const text = safeStr(extractText(event));
    const contactId = extractContactId(event);

    if (!contactId) {
      console.error("No contactId in webhook payload");
      return;
    }
    if (!text) return;

    // tgId -> contactId (для Tribute)
    const tgId = extractTelegramUserId(event);
    if (tgId) {
      try {
        setTgMap(String(tgId), String(contactId));
      } catch (e) {
        console.error("setTgMap error:", e);
      }
    }

    const lower = text.toLowerCase();

    // -------- commands --------
    if (lower === "/start") {
      await sendpulseTelegramSendText({ contactId, text: "Привет🙂" });
      return;
    }

    // ⚠️ /reset сейчас доступен всем — это небезопасно.
    // Оставляю как было у тебя. Если хочешь, сделаю admin-only.
    if (lower === "/reset") {
      clearHistory(contactId);

      setAccess(contactId, {
        bot_answers_count: 0,

        paywall_shown: false,
        paywall_hold_notified: false,
        paywall_pause_due_at: null,
        paywall_pause_sent: false,
        paywall_pitch_due_at: null,
        paywall_pitch_sent: false,

        unlimited_upsell_shown: false,
        unlimited_nudge_due_at: null,
        unlimited_nudge_sent: false,
      });

      await sendpulseTelegramSendText({ contactId, text: "Ок, очистила контекст 🧼" });
      return;
    }

    // 🔐 ADMIN: снять безлимит у себя
    if (lower === "/remove_unlimited") {
      const adminTgId = String(process.env.ADMIN_TG_ID || "").trim();
      if (!adminTgId) {
        await sendpulseTelegramSendText({ contactId, text: "ADMIN_TG_ID не задан в env" });
        return;
      }

      const tgId2 = extractTelegramUserId(event);
      if (String(tgId2) !== adminTgId) {
        await sendpulseTelegramSendText({ contactId, text: "⛔ Команда недоступна" });
        return;
      }

      setAccess(contactId, {
        plan: null,
        paid_until: null,
        daily_used: 0,
        dialog_used: 0,
        bot_answers_count: 0,

        paywall_shown: false,
        paywall_hold_notified: false,
        paywall_pause_due_at: null,
        paywall_pause_sent: false,
        paywall_pitch_due_at: null,
        paywall_pitch_sent: false,

        unlimited_upsell_shown: false,
        unlimited_nudge_due_at: null,
        unlimited_nudge_sent: false,
      });

      await sendpulseTelegramSendText({ contactId, text: "✅ Безлимит снят. Ты снова в обычном режиме." });
      return;
    }

    // "оплата" — показываем ссылки без расхода лимита
    if (lower === "оплата" || lower === "/pay") {
      await sendPaywall(req, contactId, null, "manual");
      return;
    }

    // -------- limits BEFORE GPT --------
    const gate = checkAndConsumeQuota(contactId);
    console.log("GATE:", {
      contactId,
      plan: gate.plan,
      ok: gate.ok,
      left: gate.left,
      reason: gate.reason,
      notify: gate.notify,
      extra: gate.extra,
    });

    // Unlimited: 150/день — молча не отвечаем
    if (!gate.ok && gate.reason === "silent_limit") return;

    // Trial ended: показываем paywall только один раз. Дальше молчим.
    if (!gate.ok && gate.reason === "trial_ended" && gate.notify === false) return;

    // PAYWALL HOLD: после 2-го ответа
    if (!gate.ok && gate.reason === "paywall_hold") {
      if (gate.notify) {
        await sendBasicPayButton(req, contactId, DIALOG_PAUSED_TEXT);
      }
      return;
    }

    // BASIC закончился (100)
    if (!gate.ok && gate.reason === "dialog_limit") {
      await sendUnlimitedPayButton(req, contactId, BASIC_100_END_TEXT);
      return;
    }

    // Остальные случаи — paywall
    if (!gate.ok) {
      await sendPaywall(req, contactId, gate, "auto");
      return;
    }

    // -------- memory --------
    pushToHistory(contactId, "user", text);
    const history = getHistory(contactId, 10);

    // -------- profile --------
    const vars = event?.contact?.variables || {};
    const main_sign = normalizeMainSignFromVars(vars) || null;
    const active_signs = parseActiveSigns(vars);

    const profile = {
      main_sign: main_sign || "БАРСУК",
      active_signs,
    };

    // -------- partner parsing --------
    const parsed = parsePartnerFromTextV4(text);
    const partnerSign = parsed?.partnerSign || null;

    // -------- GPT --------
    let result;
    try {
      result = await triadChat({
        userText: text,
        profile,
        partnerSign,
        history,
        model: process.env.OPENAI_MODEL || "gpt-5.2",
        temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0.6),
      });
    } catch (e) {
      console.error("TRIAD_CHAT_ERROR:", e);
      await sendpulseTelegramSendText({
        contactId,
        text: "Сейчас у меня технический сбой. Попробуй ещё раз через минуту 🙏",
      });
      return;
    }

    const answer = safeStr(result?.answer) || "Я рядом. Сформулируй вопрос чуть конкретнее 🙂";
    const out = decodeHtmlEntities(answer);

    await sendpulseTelegramSendText({ contactId, text: out });
    pushToHistory(contactId, "assistant", answer);

    // -------- after-send triggers --------
    const rec = getAccess(contactId) || {};
    const botAnswers = Number.isFinite(rec.bot_answers_count) ? rec.bot_answers_count : 0;
    const newBotAnswers = botAnswers + 1;

    setAccess(contactId, { bot_answers_count: newBotAnswers });

    // ✅ После 2-го ответа — СТРОГО: только BASIC + followups
    const hasPaid = Boolean(rec.paid_until);

    if (!hasPaid && newBotAnswers === 2 && !rec.paywall_shown) {
      // ✅ сначала ставим флаги/таймеры, чтобы follow-ups точно сработали
      markPaywallShown(contactId);

      // ✅ потом отправляем paywall-кнопку (или ссылку fallback)
      await sendBasicPayButton(req, contactId, PAYWALL_AFTER_2_TEXT);
    }

    // BASIC: предупреждение на 95-м
    if (gate?.extra === "warn95" && gate?.notify) {
      await sendpulseTelegramSendText({ contactId, text: BASIC_95_WARN_TEXT });
    }

    // BASIC: завершение на 100-м + upsell unlimited + follow-up
    if (gate?.extra === "end100" && gate?.notify) {
      await sendUnlimitedPayButton(req, contactId, BASIC_100_END_TEXT);
      markUnlimitedUpsellShown(contactId);
    }

    console.log("OK_REPLY:", { contactId, partnerSign, confidence: parsed?.confidence });
  } catch (err) {
    console.error("SENDPULSE_WEBHOOK_ERROR:", err);
    try {
      const event2 = getEvent(req.body);
      const contactId2 = extractContactId(event2);
      if (contactId2) {
        await sendpulseTelegramSendText({
          contactId: contactId2,
          text: "Упс, что-то пошло не так. Попробуй повторить сообщение 🙏",
        });
      }
    } catch {}
  }
}
