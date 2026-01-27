// src/sendpulse/sendpulse-webhook.js

import { triadChat } from "../triad/triad-openai.js";
import { parsePartnerFromTextV4 } from "../parsing/parsePartnerFromText.v4.js";
import { sendpulseTelegramSendText } from "./sendpulse-api.js";

import { setTgMap } from "../access/tg-map-store.js";

// ✅ путь как у тебя сейчас (оставляю так)
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
  return (
    event?.info?.message?.channel_data?.message?.from?.id ??
    event?.info?.message?.channel_data?.from?.id ??
    event?.contact?.telegram_user_id ??
    null
  );
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

// ---------- PAYWALL ----------
function buildPaywallText({ gate, mode = "auto" }) {
  // mode:
  // - "auto" -> по причине из gate
  // - "manual" -> когда юзер сам просит "оплата"
  const reason = gate?.reason || null;

  if (mode === "manual") {
    return ["<b>Выберите доступ:</b>"].join("\n");
  }

  if (reason === "paid_ended") {
    return [
      "⛔ <b>Подписка закончилась.</b>",
      "Чтобы продолжить — оформи подписку на следующий месяц 👇",
      "",
      "<b>Доступы:</b>",
    ].join("\n");
  }

  if (reason === "trial_ended") {
    return [
      "⛔ <b>Бесплатный период завершён.</b>",
      "Чтобы продолжить — оформи подписку ниже 👇",
      "",
      "<b>Доступы:</b>",
    ].join("\n");
  }

  // daily_limit
  return [
    "⛔ <b>Дневной лимит вопросов исчерпан.</b>",
    "Завтра снова будут доступны 3 вопроса бесплатно 👇",
    "",
    "<b>Доступы:</b>",
  ].join("\n");
}

function getPublicBaseUrl(req) {
  // если PUBLIC_BASE_URL задан — используем его (лучше)
  const envBase = String(process.env.PUBLIC_BASE_URL || "").trim();
  if (envBase) return envBase.replace(/\/$/, "");

  // fallback: строим из запроса (может быть http внутри прокси — поэтому envBase предпочтительнее)
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!host) return "";
  return `${proto}://${host}`.replace(/\/$/, "");
}

function getPayLinks(contactId) {
  const base =
    (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "") ||
    "https://triad-bot-ksxb.onrender.com";

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
        "⛔ Лимит исчерпан.\n\n" +
        "⚠️ Ссылки оплаты не настроены.\n" +
        "Проверь переменную Render: PUBLIC_BASE_URL\n" +
        "и что роуты /pay/basic и /pay/unlimited существуют.",
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

    const text = String(extractText(event) || "").trim();
    const contactId = extractContactId(event);

    if (!contactId) {
      console.error("No contactId in webhook payload");
      return;
    }
    if (!text) return;

    // сохраняем связку tgId -> contactId (для Tribute, если он присылает только telegram_user_id)
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
    const result = await triadChat({
      userText: text,
      profile,
      partnerSign,
      history,
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0.6),
    });

    const answer =
      result?.answer?.trim() ||
      "Я рядом. Сформулируй вопрос чуть конкретнее 🙂";

    const out = decodeHtmlEntities(answer);

    await sendpulseTelegramSendText({
      contactId,
      text: out,
    });

    pushToHistory(contactId, "assistant", answer);

    console.log(
      "quota:",
      gate.plan,
      "left:",
      gate.left,
      "reason:",
      gate.reason,
      "partnerSign:",
      partnerSign,
      "confidence:",
      parsed?.confidence
    );
  } catch (err) {
    console.error("SENDPULSE_WEBHOOK_ERROR:", err);
  }
}
