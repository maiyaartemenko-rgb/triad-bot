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

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`SendPulse token error ${resp.status}: ${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;

  return cachedToken;
}

async function spRequest(path, payload) {
  const token = await getAccessToken();

  const resp = await fetch(`https://api.sendpulse.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload ?? {}),
  });

  const raw = await resp.text().catch(() => "");
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { _non_json: raw };
    }
  }

  if (!resp.ok) {
    throw new Error(`SendPulse API error ${resp.status} ${path}: ${JSON.stringify(data)}`);
  }

  return data;
}

// ✅ Обычное текстовое сообщение (HTML)
export async function sendpulseTelegramSendText({ contactId, text }) {
  return spRequest("/telegram/contacts/send", {
    contact_id: String(contactId),
    message: {
      type: "text",
      text: String(text ?? ""),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
  });
}

// ✅ Текст + inline-кнопки (URL)
export async function sendpulseTelegramSendButtons({ contactId, text, buttons }) {
  const items = (buttons || [])
    .filter((b) => b?.text && b?.url)
    .map((b) => ({ text: String(b.text), url: String(b.url) }));

  return spRequest("/telegram/contacts/send", {
    contact_id: String(contactId),
    message: {
      type: "text",
      text: String(text ?? ""),
      parse_mode: "HTML",
      disable_web_page_preview: true,

      // Формат как у Telegram API
      reply_markup: {
        inline_keyboard: items.map((b) => [b]),
      },

      // Fallback: иногда SendPulse принимает так
      buttons: items,
    },
  });
}

/**
 * ✅ Запись переменных контакта в SendPulse
 */
export async function sendpulseSetContactVariables({ contactId, variables }) {
  const vars = variables || {};
  const entries = Object.entries(vars).map(([k, v]) => ({
    variable_name: String(k),
    variable_value: v == null ? "" : String(v),
  }));

  // 1) массивом
  try {
    return await spRequest("/telegram/contacts/setVariables", {
      contact_id: String(contactId),
      variables: entries,
    });
  } catch (eBatchArray) {
    // 2) объектом
    try {
      const obj = {};
      for (const { variable_name, variable_value } of entries) obj[variable_name] = variable_value;

      return await spRequest("/telegram/contacts/setVariables", {
        contact_id: String(contactId),
        variables: obj,
      });
    } catch (eBatchObject) {
      // 3) по одной
      const results = [];
      for (const { variable_name, variable_value } of entries) {
        try {
          const r = await spRequest("/telegram/contacts/setVariable", {
            contact_id: String(contactId),
            variable_name,
            variable_value,
          });
          results.push({ name: variable_name, ok: true, r });
        } catch (eOne) {
          results.push({ name: variable_name, ok: false, error: String(eOne?.message || eOne) });
        }
      }

      const anyOk = results.some((x) => x.ok);
      if (!anyOk) {
        throw new Error(
          `SendPulse variables update failed. Tried: setVariables(array) + setVariables(object) + setVariable(one-by-one). Results: ${JSON.stringify(
            results,
            null,
            2
          )}`
        );
      }

      return { ok: true, partial: true, results };
    }
  }
}
