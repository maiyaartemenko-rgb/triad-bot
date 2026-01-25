// src/sendpulse/sendpulse-api.js

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 30_000) return cachedToken;

  const client_id = process.env.SENDPULSE_CLIENT_ID;
  const client_secret = process.env.SENDPULSE_CLIENT_SECRET;

  if (!client_id || !client_secret) {
    throw new Error("Missing SENDPULSE_CLIENT_ID or SENDPULSE_CLIENT_SECRET in env");
  }

  const resp = await fetch("https://api.sendpulse.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id,
      client_secret,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`SendPulse token error ${resp.status}: ${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;

  return cachedToken;
}

async function sendToSendPulseTelegram(contactId, message) {
  const token = await getAccessToken();

  const resp = await fetch("https://api.sendpulse.com/telegram/contacts/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      contact_id: String(contactId),
      message,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`SendPulse send error ${resp.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

export async function sendpulseTelegramSendText({ contactId, text }) {
  return sendToSendPulseTelegram(contactId, {
    type: "text",
    text: String(text ?? ""),
    parse_mode: "HTML",
  });
}

/**
 * Отправка текста + кнопок (URL)
 * ВАЖНО: у SendPulse формат кнопок может называться по-разному в разных каналах.
 * Поэтому мы:
 * 1) кладём кнопки в message.buttons (часто работает)
 * 2) дублируем ссылки в тексте (фолбэк — даже если кнопки не отрисуются)
 */
export async function sendpulseTelegramSendButtons({
  contactId,
  text,
  buttons = [], // [{ text: "Оплатить", url: "https://..." }, ...]
}) {
  const safeButtons = Array.isArray(buttons) ? buttons.filter(b => b?.text && b?.url) : [];

  const fallbackLinks =
    safeButtons.length
      ? "\n\n" +
        safeButtons
          .map((b) => `• <a href="${String(b.url)}">${String(b.text)}</a>`)
          .join("\n")
      : "";

  const finalText = String(text ?? "") + fallbackLinks;

  return sendToSendPulseTelegram(contactId, {
    type: "text",
    text: finalText,
    parse_mode: "HTML",

    // попытка №1 (часто работает)
    buttons: safeButtons.map((b) => ({
      type: "url",
      text: String(b.text),
      url: String(b.url),
    })),

    // попытка №2 (на всякий случай — некоторые реализации любят "keyboard")
    keyboard: safeButtons.map((b) => ([
      { type: "url", text: String(b.text), url: String(b.url) }
    ])),
  });
}
