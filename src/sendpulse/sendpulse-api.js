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
      // ✅ ВАЖНО: строка с Bearer должна быть в кавычках/бэктиках
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload ?? {}),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`SendPulse API error ${resp.status} ${path}: ${JSON.stringify(data)}`);
  }
  return data;
}

// ✅ Обычное текстовое сообщение
export async function sendpulseTelegramSendText({ contactId, text }) {
  return spRequest("/telegram/contacts/send", {
    contact_id: String(contactId),
    message: {
      type: "text",
      text: String(text ?? ""),
      parse_mode: "HTML",
    },
  });
}

// ✅ Текст + inline-кнопки (URL)
export async function sendpulseTelegramSendButtons({ contactId, text, buttons }) {
  const inline_keyboard = (buttons || [])
    .filter((b) => b?.text && b?.url)
    .map((b) => [{ text: String(b.text), url: String(b.url) }]);

  return spRequest("/telegram/contacts/send", {
    contact_id: String(contactId),
    message: {
      type: "text",
      text: String(text ?? ""),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard,
      },
    },
  });
}

/**
 * ✅ Запись переменных контакта в SendPulse
 * variables = { plan, paid_until, trial_started_at, daily_used, day }
 *
 * ВАЖНО: по твоим логам SendPulse ждёт поля:
 * - variable_name
 * - variable_value
 * или variables (массив объектов)
 */
export async function sendpulseSetContactVariables({ contactId, variables }) {
  const vars = variables || {};
  const entries = Object.entries(vars).map(([k, v]) => ({
    variable_name: String(k),
    variable_value: v == null ? "" : String(v),
  }));

  // 1) Попытка "пачкой" (массивом) — самый частый корректный формат
  try {
    return await spRequest("/telegram/contacts/setVariables", {
      contact_id: String(contactId),
      variables: entries, // ✅ массив [{variable_name, variable_value}]
    });
  } catch (eBatchArray) {
    // 2) Попытка "пачкой" (объектом) — иногда в аккаунтах так
    try {
      const obj = {};
      for (const { variable_name, variable_value } of entries) obj[variable_name] = variable_value;

      return await spRequest("/telegram/contacts/setVariables", {
        contact_id: String(contactId),
        variables: obj, // ✅ объект {name:value}
      });
    } catch (eBatchObject) {
      // 3) Фолбэк: по одной переменной правильными полями
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
