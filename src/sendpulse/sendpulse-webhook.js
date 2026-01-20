// src/sendpulse/sendpulse-webhook.js
import { triadChat } from "../triad/triad-openai.js";
import { sendpulseTelegramSendText } from "./sendpulse-api.js";
import { parsePartnerFromTextV4 } from "../parsing/parsePartnerFromText.v4.js";
import { getHistory, pushToHistory, clearHistory } from "../memory/memory-store.js";

// SendPulse присылает массив событий. Берём первое.
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
  // В SendPulse это обычно contact.id (строка типа "68ee...")
  return event?.contact?.id ?? null;
}

function normalizeMainSignFromVars(vars) {
  // vars.Animal у тебя типа "🦡 Барсук"
  const raw = vars?.Animal || "";
  return String(raw)
    .replace(/[^\p{L}\s-]/gu, "")
    .trim()
    .toUpperCase();
}

function parseActiveSigns(vars) {
  // vars.active_signs: строка JSON вида:
  // [{"sign":"БАРСУК","pct":4}, ...]
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

// если где-то понадобится
function toSignString(x) {
  if (!x) return null;
  if (typeof x === "string") return x;

  if (Array.isArray(x)) {
    for (const item of x) {
      const v = toSignString(item);
      if (v) return v;
    }
    return null;
  }

  if (typeof x === "object") {
    // ✅ тут должны быть ||
    return toSignString(x.sign || x.partnerSign || x.value || x.name || x.text);
  }

  return null;
}

function decodeHtmlEntities(s = "") {
  return String(s)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

export async function handleSendpulseWebhook(req, res) {
  // всегда быстро отвечаем OK
  res.status(200).json({ ok: true });

  try {
    const event = getEvent(req.body);
    if (event?.title !== "incoming_message") return;

    const text = String(extractText(event) || "").trim();
    const contactId = extractContactId(event);

    // ✅ сначала базовые проверки
    if (!contactId) {
      console.error("No contactId in webhook payload");
      return;
    }
    if (!text) return;

    // ✅ команды не записываем в память
    if (text.toLowerCase() === "/reset") {
      clearHistory(contactId);
      await sendpulseTelegramSendText({
        contactId,
        text: "Ок, очистила контекст 🧼",
      });
      return;
    }

    if (text.toLowerCase() === "/start") {
      clearHistory(contactId); // удобно: старт = новая сессия
      await sendpulseTelegramSendText({
        contactId,
        text: "Привет! Напиши вопрос — и я отвечу по твоему профилю 🙂",
      });
      return;
    }

    // ✅ 1) берём историю ДО добавления текущего сообщения
    const history = getHistory(contactId);

    // ✅ 2) сохраняем текущее сообщение пользователя
    pushToHistory(contactId, "user", text);

    const vars = event?.contact?.variables || {};
    const main_sign = normalizeMainSignFromVars(vars) || null;
    const active_signs = parseActiveSigns(vars);

    const profile = {
      main_sign: main_sign || "БАРСУК",
      active_signs,
    };

    // парсим партнёра из текста
    const parsed = parsePartnerFromTextV4(text);
    const partnerSign = parsed?.partnerSign || null;

    const result = await triadChat({
      userText: text,
      profile,
      partnerSign,
      history, // ✅ вот теперь history реально существует и передаётся
      model: process.env.OPENAI_MODEL || "gpt-5.2",
      temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0.6),
    });

    const answer =
      result?.answer?.trim() || "Я рядом. Сформулируй вопрос чуть конкретнее 🙂";

    // если GPT вдруг вернул экранированные сущности
    const out = decodeHtmlEntities(answer);

    await sendpulseTelegramSendText({
      contactId,
      text: out,
    });

    // ✅ 3) сохраняем ответ ассистента
    pushToHistory(contactId, "assistant", answer);

    console.log("partnerSign:", partnerSign, "confidence:", parsed?.confidence);
  } catch (err) {
    console.error("SENDPULSE_WEBHOOK_ERROR:", err);
  }
}
