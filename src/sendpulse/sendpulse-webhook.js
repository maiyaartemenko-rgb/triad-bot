// src/sendpulse/sendpulse-webhook.js

import { triadChat } from "../triad/triad-openai.js";
import { parsePartnerFromTextV4 } from "../parsing/parsePartnerFromText.v4.js";
import { sendpulseTelegramSendText } from "./sendpulse-api.js";
import { setTgMap } from "../access/tg-map-store.js";

// путь как у тебя сейчас
import { getHistory, pushToHistory, clearHistory } from "../src/memory/memory-store.js";

import { checkAndConsumeQuota } from "../access/access-store.js";

// ---------- helpers ----------
function getEvent(payload) {
  return Array.isArray(payload) ? (payload[0] ?? {}) : (payload ?? {});
}

function safeStr(x) {
  return String(x ?? "").trim();
}

// --- PROMO TIMER ---
const PROMO_UNTIL_ISO = process.env.PROMO_UNTIL_ISO || "2026-02-04T23:59:59+03:00"; 
// (до конца дня 4 февраля по Москве)

function isPromoActive() {
  const until = new Date(PROMO_UNTIL_ISO).getTime();
  return Number.isFinite(until) && Date.now() <= until;
}

function extractText(event) {
  return (
    event?.info?.message?.channel_data?.message?.text ??
    event?.contact?.last_message ??
    ""
  );
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
  return safeStr(raw)
    .replace(/[^\p{L}\s-]/gu, "")
    .trim()
    .toUpperCase();
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
  return String(s)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

// ---------- PAYWALL ----------
function buildPaywallText({ gate, mode = "auto" }) {
  if (mode === "manual") {
    return "<b>Выберите доступ:</b>";
  }

  const reason = gate?.reason || null;

  if (reason === "paid_ended") {
    return [
      "⛔ <b>Подписка закончилась.</b>",
      "Чтобы продолжить — оформи подписку 👇",
      "",
      "<b>Доступы:</b>",
    ].join("\n");
  }

  if (reason === "trial_ended") {
    return [
      "⛔ <b>Бесплатный период завершён.</b>",
      "Чтобы продолжить — оформи подписку 👇",
      "",
      "<b>Доступы:</b>",
    ].join("\n");
  }

  // daily_limit
  return [
    "⛔ <b>Дневной лимит вопросов исчерпан.</b>",
    "Завтра снова будут доступны 3 вопроса 👇",
    "",
    "<b>Доступы:</b>",
  ].join("\n");
}

function getPublicBaseUrl(req) {
  const envBase = safeStr(process.env.PUBLIC_BASE_URL);
  if (envBase) return envBase.replace(/\/$/, "");

  const proto = safeStr(req.headers["x-forwarded-proto"]) || "https";
  const host = safeStr(req.headers["x-forwarded-host"]) || safeStr(req.headers.host);
  if (!host) return "";

  return `${proto}://${host}`.replace(/\/$/, "");
}

function getPayLinks(req, contactId) {
  const base = getPublicBaseUrl(req);
  if (!base) return { basic: null, unlimited: null };

  return {
    basic: `${base}/pay/basic?cid=${encodeURIComponent(contactId)}`,
    unlimited: `${base}/pay/unlimited?cid=${encodeURIComponent(contactId)}`,
  };
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
      `• <s>990 ₽</s> <b>490 ₽</b> — 3 вопроса в день: <a href="${basic}">Оплатить</a>`,
      `• <s>2990 ₽</s> <b>1990 ₽</b> — безлимит: <a href="${unlimited}">Оплатить</a>`,
      `\n⏳ <i>Скидка действует до 4 февраля 2026</i>`,
    ]
  : [
      `• <b>990 ₽</b> — 3 вопроса в день: <a href="${basic}">Оплатить</a>`,
      `• <b>2990 ₽</b> — безлимит: <a href="${unlimited}">Оплатить</a>`,
    ];

const text = [header, ...priceLines].join("\n");

  await sendpulseTelegramSendText({ contactId, text });
}

// ---------- main ----------
export async function handleSendpulseWebhook(req, res) {
  // SendPulse нужно быстрое 200 OK
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
      await sendpulseTelegramSendText({
        contactId,
        text: "Привет! Напиши вопрос — и я отвечу 🙂",
      });
      return;
    }

    if (lower === "/reset") {
      clearHistory(contactId);
      await sendpulseTelegramSendText({
        contactId,
        text: "Ок, очистила контекст 🧼",
      });
      return;
    }
// 🔐 ADMIN: снять безлимит у себя
if (lower === "/remove_unlimited") {
  const adminTgId = String(process.env.ADMIN_TG_ID || "").trim();

  if (!adminTgId) {
    await sendpulseTelegramSendText({
      contactId,
      text: "ADMIN_TG_ID не задан в env",
    });
    return;
  }

  const tgId = extractTelegramUserId(event);

  if (String(tgId) !== adminTgId) {
    await sendpulseTelegramSendText({
      contactId,
      text: "⛔ Команда недоступна",
    });
    return;
  }

  // снимаем доступ
  const { setAccess } = await import("../access/access-store.js");

  setAccess(contactId, {
    plan: null,
    paid_until: null,
    daily_used: 0,
  });

  await sendpulseTelegramSendText({
    contactId,
    text: "✅ Безлимит снят. Ты снова в обычном режиме.",
  });

  return;
}

    // "оплата" — показываем ссылки без расхода лимита
    if (lower === "оплата" || lower === "/pay") {
      await sendPaywall(req, contactId, null, "manual");
      return;
    }

    // -------- limits BEFORE GPT --------
    const gate = checkAndConsumeQuota(contactId);
    console.log("GATE:", { contactId, plan: gate.plan, ok: gate.ok, left: gate.left, reason: gate.reason, notify: gate.notify });

    // ✅ Unlimited: 150/день — молча не отвечаем
    if (!gate.ok && gate.reason === "silent_limit") {
      return;
    }

    // ✅ Trial закончился: показываем paywall только один раз.
    // Дальше access-store вернёт notify:false — и мы молчим.
    if (!gate.ok && gate.reason === "trial_ended" && gate.notify === false) {
      return;
    }

    // Остальные случаи — показываем paywall
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

    console.log("OK_REPLY:", { contactId, partnerSign, confidence: parsed?.confidence });
  } catch (err) {
    console.error("SENDPULSE_WEBHOOK_ERROR:", err);
    // если можем — скажем пользователю, что был сбой
    try {
      const event = getEvent(req.body);
      const contactId = extractContactId(event);
      if (contactId) {
        await sendpulseTelegramSendText({
          contactId,
          text: "Упс, что-то пошло не так. Попробуй повторить сообщение 🙏",
        });
      }
    } catch {}
  }
}
