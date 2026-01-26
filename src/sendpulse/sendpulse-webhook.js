// src/sendpulse/sendpulse-webhook.js

import { triadChat } from "../triad/triad-openai.js";
import { parsePartnerFromTextV4 } from "../parsing/parsePartnerFromText.v4.js";

import { sendpulseTelegramSendText } from "./sendpulse-api.js";

import {
  getHistory,
  pushToHistory,
  clearHistory,
} from "../memory/memory-store.js";

import { checkAndConsumeQuota } from "../access/access-store.js";

// ---------- helpers ----------
function getEvent(payload) {
  return Array.isArray(payload) ? (payload[0] ?? {}) : (payload ?? {});
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

function getPayLinks() {
  // Твои готовые ссылки Tribute (можно хранить в переменных Render)
  const basic = process.env.TRIBUTE_BASIC_URL || "";
  const unlimited = process.env.TRIBUTE_UNLIMITED_URL || "";
  return { basic, unlimited };
}

async function sendPaywall(contactId) {
  const { basic, unlimited } = getPayLinks();

  // если вдруг забыли переменные — покажем явную ошибку
  if (!basic || !unlimited) {
    await sendpulseTelegramSendText({
      contactId,
      text:
        "⛔ Дневной лимит вопросов исчерпан.\n\n" +
        "⚠️ Ссылки оплаты не настроены.\n" +
        "Проверь переменные Render:\n" +
        "TRIBUTE_BASIC_URL и TRIBUTE_UNLIMITED_URL",
    });
    return;
  }

  // Telegram/SendPulse HTML ок: parse_mode="HTML"
  const text = [
    "⛔ <b>Дневной лимит вопросов исчерпан.</b>",
    "Завтра можно будет снова задать 3 вопроса бесплатно.",
    "",
    "<b>Оформи доступ, чтобы продолжить:</b>",
    `• 900 ₽ — 3 вопроса в день: <a href="${basic}">Оплатить</a>`,
    `• 2900 ₽ — безлимит: <a href="${unlimited}">Оплатить</a>`,
    "",
    "Если ссылки не открываются — напиши «Оплата».",
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

    const lower = text.toLowerCase();

    // команды
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

    // Если пользователь пишет "оплата" — показываем ссылки сразу
    if (lower === "оплата" || lower === "/pay") {
      await sendPaywall(contactId);
      return;
    }

    // 1) сохраняем входящее в память
    pushToHistory(contactId, "user", text);

    // 2) история (последние 10)
    const history = getHistory(contactId, 10);

    // 3) лимиты ДО GPT
    const gate = checkAndConsumeQuota(contactId);
    if (!gate.ok) {
      await sendPaywall(contactId);
      return;
    }

    // профиль из переменных SendPulse (если есть)
    const vars = event?.contact?.variables || {};
    const main_sign = normalizeMainSignFromVars(vars) || null;
    const active_signs = parseActiveSigns(vars);
    const profile = {
      main_sign: main_sign || "БАРСУК",
      active_signs,
    };

    // партнёр
    const parsed = parsePartnerFromTextV4(text);
    const partnerSign = parsed?.partnerSign || null;

    // GPT
    const result = await triadChat({
      userText: text,
      profile,
      partnerSign,
      history,
      model: process.env.OPENAI_MODEL || "gpt-5.2",
      temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0.6),
    });

    const answer =
      result?.answer?.trim() || "Я рядом. Сформулируй вопрос чуть конкретнее 🙂";

    const out = decodeHtmlEntities(answer);

    await sendpulseTelegramSendText({
      contactId,
      text: out,
    });

    // 4) сохраняем ответ ассистента
    pushToHistory(contactId, "assistant", answer);

    console.log("partnerSign:", partnerSign, "confidence:", parsed?.confidence);
  } catch (err) {
    console.error("SENDPULSE_WEBHOOK_ERROR:", err);
  }
}
