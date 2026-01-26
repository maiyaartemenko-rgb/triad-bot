// src/sendpulse/sendpulse-api.js
import dotenv from "dotenv";
dotenv.config();

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

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`SendPulse token error ${resp.status}: ${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;

  return cachedToken;
}

export async function sendpulseTelegramSendText({ contactId, text }) {
  const token = await getAccessToken();

  const resp = await fetch("https://api.sendpulse.com/telegram/contacts/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      contact_id: String(contactId),
      message: {
        type: "text",
        text: String(text || ""),
        parse_mode: "HTML",
      },
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`SendPulse send error ${resp.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Обновляет переменные контакта в SendPulse
 * vars = { plan, paid_until, trial_started_at, daily_used, last_reset_date }
 */
export async function sendpulseSetContactVariables({ contactId, vars }) {
  const token = await getAccessToken();

  // В SendPulse обычно ждут массив переменных вида [{name, value}]
  const variables = Object.entries(vars || {}).map(([name, value]) => ({
    name,
    value: value === null || value === undefined ? "" : String(value),
  }));

  const resp = await fetch("https://api.sendpulse.com/telegram/contacts/setVariables", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      contact_id: String(contactId),
      variables,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`SendPulse setVariables error ${resp.status}: ${JSON.stringify(data)}`);
  }

  return data;
}
