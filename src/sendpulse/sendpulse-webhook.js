// src/sendpulse/sendpulse-webhook.js
import { triadChat } from "../triad/triad-openai.js";
import { parsePartnerFromTextV4 } from "../parsing/parsePartnerFromText.v4.js";

import {
  sendpulseTelegramSendText,
  sendpulseTelegramSendButtons
} from "./sendpulse-api.js";

import { getHistory, pushToHistory, clearHistory } from "..src/memory/memory-store.js";
import { checkAndConsumeQuota } from "../access/access-store.js"; // ← убедись, что файл есть

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
  const raw = vars?.Animal || "";
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

function buildPayLinks(contactId) {
  // ✅ ВАЖНО: сюда вставь свои реальные ссылки из Tribute (одна на basic, одна на unlimited)
  const BASIC_URL = process.env.TRIBUTE_BASIC_URL || "";
  const UNLIMITED_URL = process.env.TRIBUTE_UNLIMITED_URL || "";

  // если ты хочешь одну и ту же ссылку, а plan различать параметром — можно так:
  // const BASIC_URL = process.env.TRIBUTE_PAY_URL || "";
  // const UNLIMITED_URL = process.env.TRIBUTE_PAY_URL || "";

  const basic = BASIC_URL
    ? `${BASIC_URL}${BASIC_URL.includes("?") ? "&" : "?"}contactId=${encodeURIComponent(
        contactId
      )}&plan=basic`
    : null;

  const unlimited = UNLIMITED_URL
    ? `${UNLIMITED_URL}${UNLIMITED_URL.includes("?") ? "&" : "?"}contactId=${encodeURIComponent(
        contactId
      )}&plan=unlimited`
    : null;

  return { basic, unlimited };
}

async function sendPaywall(contactId) {
  const { basic, unlimited } = buildPayLinks(contactId);

  const text = [
    "⛔ Дневной лимит вопросов исчерпан.",
    "Завтра можно будет снова задать 3 вопроса бесплатно.",
    "",
    "Оформи доступ, чтобы продолжить:",
    "• 990 ₽ — 3 вопроса в день",
    "• 2900 ₽ — безлимит",
  ].join("\n");

  // если кнопки не сконфигурены — хотя бы текстом
  if (!basic || !unlimited) {
    await sendpulseTelegramSendText({
      contactId,
      text:
        text +
        "\n\n⚠️ Ссылки оплаты не настроены. Проверь переменные TRIBUTE_BASIC_URL и TRIBUTE_UNLIMITED_URL.",
    });
    return;
  }

  // ✅ отправляем кнопки
  await sendpulseTelegramSendButtons({
    contactId,
    text,
    buttons: [
      { text: "Оплатить 990 ₽ (3/день)", url: basic },
      { text: "Оплатить 2900 ₽ (безлимит)", url: unlimited },
    ],
  });
}

// ---------- main ----------
export async function handleSendpulseWebhook(req, res) {
  // всегда быстро отвечаем OK
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

    // ✅ команды
    if (text.toLowerCase() === "/start") {
      await sendpulseTelegramSendText({
        contactId,
        text: "Привет! Напиши вопрос — и я отвечу 🙂",
      });
      return;
    }

    if (text.toLowerCase() === "/reset") {
      clearHistory(contactId);
      await sendpulseTelegramSendText({
        contactId,
        text: "Ок, очистила контекст 🧼",
      });
      return;
    }

    // ✅ 1) сохраняем входящее в память
    pushToHistory(contactId, "user", text);

    // ✅ 2) достаем историю (последние 10 сообщений)
    const history = getHistory(contactId, 10);

    // ✅ 3) проверка лимитов ПЕРЕД GPT
    const gate = checkAndConsumeQuota(contactId);
    if (!gate.ok) {
      await sendPaywall(contactId);
      return;
    }

    // профиль
    const vars = event?.contact?.variables || {};
    const main_sign = normalizeMainSignFromVars(vars) || null;
    const active_signs = parseActiveSigns(vars);
    const profile = {
      main_sign: main_sign || "БАРСУК",
      active_signs,
    };

    // парсим партнёра
    const parsed = parsePartnerFromTextV4(text);
    const partnerSign = parsed?.partnerSign || null;

    // GPT
    const result = await triadChat({
      userText: text,
      profile,
      partnerSign,
      history, // ✅ важно
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

    // ✅ 4) сохраняем ответ ассистента
    pushToHistory(contactId, "assistant", answer);

    console.log("partnerSign:", partnerSign, "confidence:", parsed?.confidence);
  } catch (err) {
    console.error("SENDPULSE_WEBHOOK_ERROR:", err);
  }
}
