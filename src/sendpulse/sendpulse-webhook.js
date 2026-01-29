// src/sendpulse/sendpulse-webhook.js

import { triadChat } from "../triad/triad-openai.js";
import { parsePartnerFromTextV4 } from "../parsing/parsePartnerFromText.v4.js";
import { sendpulseTelegramSendText } from "./sendpulse-api.js";

import { setTgMap } from "../access/tg-map-store.js";

// путь как у тебя сейчас
import {
  getHistory,
  pushToHistory,
  clearHistory,
} from "../src/memory/memory-store.js";

import { checkAndConsumeQuota } from "../access/access-store.js";

// ---------- helpers ----------
function getEvent(payload) {
  return Array.isArray(payload) ? payload[0] ?? {} : payload ?? {};
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

  const v = candidates.find((x) => x !== undefined && x !== null && String(x).trim() !== "");
  return v ? String(v).trim() : null;
}

function normalizeMainSignFromVars(vars) {
  const raw = vars?.Animal || vars?.animal || "";
  return String(raw)
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
        sign: String(x?.sign || "").trim().toUpperCase(),
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

function safeStr(x) {
  return String(x ?? "").trim();
}

// ---------- PAYWALL ----------
function buildPaywallText({ gate, mode = "auto" }) {
  // mode:
  // - "auto" -> по причине из gate
  // - "manual" -> когда юзер сам просит "оплата"

  if (mode === "manual") {
    return ["<b>Выберите доступ:</b>"].join("\n");
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
    // ВАЖНО: тут НЕТ текста про “завтра”, потому что триал уже закончился
    return [
      "⛔ <b>Бесплатный период завершён.</b>",
      "Чтобы продолжить — оформи подписку 👇",
      "",
      "<b>Доступы:</b>",
    ].join("\n");
  }

  // daily_limit: “завтра” уместно только когда это реально дневной лимит
  return [
    "⛔ <b>Дневной лимит вопросов исчерпан.</b>",
    "Завтра снова будут доступны 3 вопроса 👇",
    "",
    "<b>Доступы:</b>",
  ].join("\n");
}

function getPublicBaseUrl(req) {
  // Если PUBLIC_BASE_URL задан — используем его (самый стабильный вариант)
  const envBase = safeStr(process.env.PUBLIC_BASE_URL);
  if (envBase) return envBase.replace(/\/$/, "");

  // fallback: строим из запроса (в проде может быть прокси)
  const proto = safeStr(req.headers["x-forwarded-proto"]) || "https";
  const host =
    safeStr(req.headers["x-forwarded-host"]) || safeStr(req.headers.host);

  if (!host) return "";
  return `${proto}://${host}`.replace(/\/$/, "");
}

function getPayLinks(req, contactId) {
  const base = getPublicBaseUrl(req);
  if (!base) return { basic: null, unlimited: null };

  // ВАЖНО: ссылки ведут на ТВОЙ сервер /pay/..., который уже делает редирект в Tribute
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
        "Проверь в Render переменную PUBLIC_BASE_URL.\n" +
        "И что в server.js есть роуты /pay/basic и /pay/unlimited.",
    });
    return;
  }

  const header = buildPaywallText({ gate, mode });

  const text = [
    header,
    `• 900 ₽ — 3 вопроса в день: <a href="${basic}">Оплатить</a>`,
    `• 2900 ₽ — безлимит: <a href="${unlimited}">Оплатить</a>`,
  ].join("\n");

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

    // tgId -> contactId (для Tribute, если он присылает telegram_user_id)
    const tgId = extractTelegramUserId(event);
    if (tgId) {
      try {
        setTgMap(String(tgId), String(contactId));
      } catch (e) {
        console.error("setTgMap error:", e);
      }
    }
console.log("TG_MAP_SAVE:", { tgId, contactId });
    const lower = text.toLowerCase();

    // -------- commands --------
    if (lower === "/start") {
      await sendpulseTelegramSendText({
        contactId,
        text: "Привет!🙂",
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

    // "оплата" — показываем ссылки без расхода лимита и без “завтра”
    if (lower === "оплата" || lower === "/pay") {
      await sendPaywall(req, contactId, null, "manual");
      return;
    }

    // -------- limits BEFORE GPT --------
  const gate = checkAndConsumeQuota(contactId);

// ✅ Если это unlimited и лимит 150/день исчерпан — МОЛЧА НЕ ОТВЕЧАЕМ
if (!gate.ok && gate.plan === "unlimited") {
  return;
}

// остальные планы — показываем paywall/сообщение
if (!gate.ok) {
  await sendPaywall(req, contactId, gate, "auto");
  return;
}

    // -------- memory --------
    pushToHistory(contactId, "user", text);
    const history = getHistory(contactId, 10);

    // -------- profile from SendPulse vars --------
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

    const answer =
      safeStr(result?.answer) || "Я рядом. Сформулируй вопрос чуть конкретнее 🙂";

    const out = decodeHtmlEntities(answer);

    await sendpulseTelegramSendText({
      contactId,
      text: out,
    });

    pushToHistory(contactId, "assistant", answer);

    console.log("quota:", gate.plan, "left:", gate.left, "reason:", gate.reason);
  } catch (err) {
    console.error("SENDPULSE_WEBHOOK_ERROR:", err);
    // IMPORTANT: не молчим пользователю если можем
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
