// src/sendpulse/sendpulse-webhook.js

import { triadChat } from "../triad/triad-openai.js";
import { parsePartnerFromTextV4 } from "../parsing/parsePartnerFromText.v4.js";

// ✅ SendPulse: текстовые сообщения + старт flow (Stars) + (опционально) переменные
import {
  sendpulseTelegramSendText,
  sendpulseStartFlow,
  sendpulseSetContactVariables,
} from "./sendpulse-api.js";

import { setTgMap, getContactIdByTgId } from "../access/tg-map-store.js";

// путь как у тебя сейчас
import { getHistory, pushToHistory, clearHistory } from "../src/memory/memory-store.js";

import {
  checkAndConsumeQuota,
  getAccess,
  setAccess,
  markUnlimitedUpsellShown,
  deleteAccess,

  // ✅ micro-cycle (29 ₽ / 16⭐)
  startMicroCycle,
  endMicroCycle,
  consumeMicroBotAnswer,
  getMicroState,
} from "../access/access-store.js";

// ==================== CONFIG ====================

// ✅ paywall/кнопка Stars делается в SendPulse, сервер НЕ шлёт тексты paywall
const PAYWALL_BY_SENDPULSE = true;

// ✅ ID воронки SendPulse, которая содержит сообщение+кнопку Stars (29 ₽ / 16⭐)
const SP_PAY_16_STARS_FLOW_ID = String(process.env.SP_PAY_16_STARS_FLOW_ID || "").trim();

/**
 * ✅ Имя переменной контакта в SendPulse, которую твоя “оплаченная” воронка/кнопка
 * ставит после успешной оплаты (например: "PAID_16_STARS_12_STEPS" = "1")
 *
 * ВАЖНО: это должно совпадать 1:1 с тем, что ты настроишь в SendPulse.
 */
const SP_MICRO_PAID_VAR = String(process.env.SP_MICRO_PAID_VAR || "PAID_16_STARS_12_STEPS").trim();

/**
 * Значения, которые считаем “оплачено”.
 */
const PAID_TRUE_VALUES = new Set(["1", "true", "yes", "paid", "ok", "y"]);

// ==================== helpers ====================

function getEvent(payload) {
  return Array.isArray(payload) ? (payload[0] ?? {}) : payload ?? {};
}

function safeStr(x) {
  return String(x ?? "").trim();
}

function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function fmtIsoRu(iso) {
  try {
    return new Date(iso).toLocaleString("ru-RU");
  } catch {
    return String(iso || "");
  }
}

function extractText(event) {
  return event?.info?.message?.channel_data?.message?.text ?? event?.contact?.last_message ?? "";
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

function isAdmin(event) {
  const adminTgId = String(process.env.ADMIN_TG_ID || "").trim();
  if (!adminTgId) return false;
  const tgId = extractTelegramUserId(event);
  return tgId && String(tgId) === adminTgId;
}

function normalizeMainSignFromVars(vars) {
  const raw = vars?.Animal || vars?.animal || "";
  return safeStr(raw).replace(/[^\p{L}\s-]/gu, "").trim().toUpperCase();
}

function parseActiveSigns(vars) {
  const raw = vars?.active_signs || "";
  if (!raw) return [];
  try {
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => ({ sign: safeStr(x?.sign).toUpperCase(), pct: Number(x?.pct ?? 0) }))
      .filter((x) => x.sign && Number.isFinite(x.pct));
  } catch (err) {
    console.error("Bad active_signs JSON:", err);
    return [];
  }
}

function decodeHtmlEntities(s = "") {
  return String(s).replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

// ✅ реальная проверка “оплата активна” (Tribute планы)
function isPaidActive(rec) {
  if (!rec?.paid_until) return false;
  const t = new Date(rec.paid_until).getTime();
  return Number.isFinite(t) && Date.now() < t;
}

function isMicroPaidBySendpulse(event) {
  const vars = event?.contact?.variables || {};
  const val = safeStr(vars?.[SP_MICRO_PAID_VAR]);
  if (!val) return false;
  return PAID_TRUE_VALUES.has(val.toLowerCase());
}

// ==================== TEXTS ====================

// 🧩 после 12 доп. ответов (перед 13-м)
const MICRO_BEFORE_FINAL_QUESTION_TEXT = [
  "✅ Мы прошли <b>12 шагов</b>.",
  "",
  "Сейчас важно зафиксировать главное 🧷",
  "и поставить точку так, чтобы это работало в жизни, а не осталось мыслью 💡",
  "",
  "🔹 <b>Финальный вопрос</b>",
  "Если собрать всё, что ты увидел(а),",
  "что стало самым важным для тебя сегодня? ✨",
].join("\n");

// ✅ после 13-го (закрытие цикла)
const MICRO_CYCLE_FINISHED_TEXT = [
  "🏁 Готово. Этот цикл завершён.",
  "",
  "Иногда один точный день даёт больше, чем долгие размышления 🔥",
  "Если захочешь пройти следующий цикл — я рядом.",
].join("\n");

// BASIC 95/100 (оставляем как было)
const BASIC_95_WARN_TEXT = [
  "Мы подходим к завершению этого разговора 🔚",
  "",
  "Я хочу собрать главное 🧩",
  "и зафиксировать то, что для тебя сейчас ключевое ✨",
  "",
  "💬 Ответь коротко:",
  "1️⃣ Что самое важное из разговора?",
  "2️⃣ Что стало яснее?",
  "3️⃣ Если вернёшься — про что будет продолжение?",
  "4️⃣ В каком ты сейчас состоянии по сравнению с началом?",
  "5️⃣ Одна фраза итога — какая?",
].join("\n");

const BASIC_100_END_TEXT = [
  "Мы завершили этот разговор 😌",
  "",
  "Если захочешь разобрать другую тему или пойти глубже — можно начать новый диалог 💬✨",
].join("\n");

const UNLIMITED_HARD_UPSELL_TEXT = [
  "😈 Окей, честно.",
  "100 сообщений — это уже не «потестить». Это работа.",
  "",
  "Самая дорогая ошибка тут — закрыть «на потом»…",
  "и через неделю снова оказаться в той же точке. ⚠️",
  "",
  "Безлимит — когда ты не копишь,",
  "а разбираешь всё по факту появления:",
  "отношения, деньги, выбор, тревогу, границы.",
  "",
  "Хочешь выйти из сценария — не делай паузу.",
  "Открывай безлимит и добивай до результата. 💥",
].join("\n");

// ==================== PAY LINKS (Tribute) ====================

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

async function sendUnlimitedUpsellWithLink(req, contactId, prefixText = "") {
  const { unlimited } = getPayLinks(req, contactId);
  if (!unlimited) {
    await sendpulseTelegramSendText({
      contactId,
      text: `${prefixText}\n\n⚠️ Не могу построить ссылку на безлимит.\nПроверь PUBLIC_BASE_URL и роут /pay/unlimited`,
    });
    return;
  }

  const out = `${prefixText}\n\n👉 <a href="${unlimited}">Открыть безлимит — 2990 ₽</a>`;
  await sendpulseTelegramSendText({ contactId, text: out });
}

// ==================== STARS FLOW TRIGGER ====================

async function triggerStarsFlowIfConfigured(contactId) {
  if (!PAYWALL_BY_SENDPULSE) return { ok: false, reason: "disabled" };
  if (!SP_PAY_16_STARS_FLOW_ID) {
    console.error("SP_PAY_16_STARS_FLOW_ID is empty. Flow won't start.");
    return { ok: false, reason: "no_flow_id" };
  }

  try {
    await sendpulseStartFlow({ flowId: SP_PAY_16_STARS_FLOW_ID, contactId });
    return { ok: true };
  } catch (e) {
    console.error("sendpulseStartFlow error:", e);
    return { ok: false, reason: "api_error" };
  }
}

/**
 * Если SendPulse отмечает оплату переменной — можно (по желанию) сразу же её сбрасывать,
 * чтобы не “липло навсегда”. Это не обязательно, но уменьшает сюрпризы.
 */
async function clearMicroPaidVar(contactId) {
  if (!SP_MICRO_PAID_VAR) return;
  try {
    await sendpulseSetContactVariables({
      contactId,
      variables: { [SP_MICRO_PAID_VAR]: "0" },
    });
  } catch (e) {
    // не критично
    console.error("clearMicroPaidVar error:", e);
  }
}

// ==================== ADMIN: выдача доступа (по tgId) ====================

async function grantPlanToContact({ contactId, plan, days = 30 }) {
  const paid_until = addDaysISO(days);

  setAccess(contactId, {
    plan,
    paid_until,
    last_reset_date: todayStr(),
    daily_used: 0,

    paywall_shown: false,
    paywall_hold_notified: false,

    bot_answers_count: 0,

    dialog_used: 0,
    dialog_warn95_sent: false,
    dialog_end100_sent: false,

    unlimited_upsell_shown: false,
    unlimited_nudge_due_at: null,
    unlimited_nudge_sent: false,

    // micro-cycle сброс
    micro_cycle_until: null,
    micro_used_bot_answers: 0,
  });

  try {
    clearHistory(contactId);
  } catch {}

  return { ok: true, plan, paid_until };
}

// ==================== main ====================

export async function handleSendpulseWebhook(req, res) {
  res.status(200).json({ ok: true });

  try {
    const event = getEvent(req.body);
    if (event?.title !== "incoming_message") return;

    const text = safeStr(extractText(event));
    const contactId = extractContactId(event);
    if (!contactId || !text) return;

    // tgId -> contactId mapping
    const tgId = extractTelegramUserId(event);
    if (tgId) {
      try {
        setTgMap(String(tgId), String(contactId));
      } catch (e) {
        console.error("setTgMap error:", e);
      }
    }

    const lower = text.toLowerCase();

    // ✅ /start — ничего не пишем
    if (lower === "/start") return;

    // ---------- ADMIN ----------
    if (lower === "/whoami") {
      const myTgId = extractTelegramUserId(event);
      await sendpulseTelegramSendText({
        contactId,
        text: `tgId: <b>${safeStr(myTgId) || "?"}</b>\ncontactId: <b>${safeStr(contactId)}</b>`,
      });
      return;
    }

    if (lower.startsWith("/grant_basic")) {
      if (!isAdmin(event)) return;

      const parts = text.trim().split(/\s+/);
      const targetTgId = parts[1] ? String(parts[1]).trim() : "";
      const days = parts[2] ? Number(parts[2]) : 30;
      if (!targetTgId) return;

      const targetContactId = String(getContactIdByTgId(String(targetTgId)) || "").trim();
      if (!targetContactId) return;

      const r = await grantPlanToContact({ contactId: targetContactId, plan: "basic", days });
      await sendpulseTelegramSendText({
        contactId,
        text: `✅ Выдан BASIC\ncontactId=${targetContactId}\npaid_until=${fmtIsoRu(r.paid_until)}`,
      });
      return;
    }

    if (lower.startsWith("/grant_unlimited")) {
      if (!isAdmin(event)) return;

      const parts = text.trim().split(/\s+/);
      const targetTgId = parts[1] ? String(parts[1]).trim() : "";
      const days = parts[2] ? Number(parts[2]) : 30;
      if (!targetTgId) return;

      const targetContactId = String(getContactIdByTgId(String(targetTgId)) || "").trim();
      if (!targetContactId) return;

      const r = await grantPlanToContact({ contactId: targetContactId, plan: "unlimited", days });
      await sendpulseTelegramSendText({
        contactId,
        text: `✅ Выдан UNLIMITED\ncontactId=${targetContactId}\npaid_until=${fmtIsoRu(r.paid_until)}`,
      });
      return;
    }

    // ✅ ручной старт микро-цикла для теста
    if (lower === "/micro_start") {
      if (!isAdmin(event)) return;
      startMicroCycle(contactId);
      await sendpulseTelegramSendText({ contactId, text: "✅ MICRO: цикл активирован на 24 часа (тест)." });
      return;
    }

    if (lower === "/micro_end") {
      if (!isAdmin(event)) return;
      endMicroCycle(contactId);
      await sendpulseTelegramSendText({ contactId, text: "✅ MICRO: цикл принудительно завершён (тест)." });
      return;
    }

    if (lower === "/reset") {
      if (!isAdmin(event)) return;

      try {
        clearHistory(contactId);
      } catch {}
      try {
        deleteAccess(contactId);
      } catch (e) {
        console.error("deleteAccess error:", e);
      }

      await sendpulseTelegramSendText({
        contactId,
        text: "✅ Полный сброс сделан. Теперь ты как новый пользователь.",
      });
      return;
    }

    // ==================== 0) AUTO-ACTIVATE MICRO after payment flag ====================
    // Если SendPulse проставил переменную оплаты — включаем микро-цикл в access-store.
    // ВАЖНО: делаем это ДО любых “молчаний”.
    try {
      const recBefore = getAccess(contactId) || {};
      const micro = getMicroState(contactId);

      if (!micro.active && isMicroPaidBySendpulse(event)) {
        startMicroCycle(contactId);
        await clearMicroPaidVar(contactId);
      } else {
        // если окно уже истекло, а paywall_shown висит — на следующем сообщении снова предложим оплату
        // (ничего не делаем)
        void recBefore;
      }
    } catch (e) {
      console.error("MICRO_AUTO_ACTIVATE_ERROR:", e);
    }

    // ==================== 1) Early gate: paywall silence (only when NOT micro and NOT paid plan) ====================
    const rec0 = getAccess(contactId) || {};
    const paidActive0 = isPaidActive(rec0);
    const micro0 = getMicroState(contactId);
    const botAnswers0 = Number.isFinite(rec0.bot_answers_count) ? rec0.bot_answers_count : 0;

    // Если мы в micro-окне — НЕ молчим никогда (пока есть лимит micro)
    if (PAYWALL_BY_SENDPULSE && !paidActive0 && !micro0.active && (rec0.paywall_shown || botAnswers0 >= 2)) {
      return;
    }

    // ==================== 2) Limits BEFORE GPT ====================
    const gate = checkAndConsumeQuota(contactId);

    if (!gate.ok) {
      // Если micro кончился/лимит — запускаем оплату снова (через flow), один раз
      if (PAYWALL_BY_SENDPULSE && !paidActive0) {
        const recX = getAccess(contactId) || {};
        const microX = getMicroState(contactId);

        // micro закончился -> можно тут же выключить его (на всякий) и снова предложить оплату
        if (!microX.active) {
          // ставим paywall_shown и стартуем flow (один раз)
          if (!recX.paywall_shown) {
            setAccess(contactId, { paywall_shown: true, paywall_hold_notified: false });
            await triggerStarsFlowIfConfigured(contactId);
          }
        }
      }
      return;
    }

    // ==================== 3) memory ====================
    pushToHistory(contactId, "user", text);
    const history = getHistory(contactId, 10);

    // ==================== 4) profile ====================
    const vars = event?.contact?.variables || {};
    const main_sign = normalizeMainSignFromVars(vars) || null;
    const active_signs = parseActiveSigns(vars);
    const profile = { main_sign: main_sign || "БАРСУК", active_signs };

    // ==================== 5) partner ====================
    const parsed = parsePartnerFromTextV4(text);
    const partnerSign = parsed?.partnerSign || null;

    // ==================== 6) GPT ====================
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
        text: "Сейчас технический сбой. Попробуй ещё раз через минуту 🙏",
      });
      return;
    }

    const answer = safeStr(result?.answer) || "Ок. Сформулируй вопрос чуть конкретнее 🙂";
    const out = decodeHtmlEntities(answer);

    await sendpulseTelegramSendText({ contactId, text: out });
    pushToHistory(contactId, "assistant", answer);

    // ==================== 7) Post-actions by plan ====================

    // --- BASIC 95/100 ---
    if (gate?.extra === "warn95" && gate?.notify) {
      await sendpulseTelegramSendText({ contactId, text: BASIC_95_WARN_TEXT });
    }

    if (gate?.extra === "end100" && gate?.notify) {
      await sendpulseTelegramSendText({ contactId, text: BASIC_100_END_TEXT });
      await sendUnlimitedUpsellWithLink(req, contactId, UNLIMITED_HARD_UPSELL_TEXT);
      try {
        markUnlimitedUpsellShown(contactId);
      } catch {}
    }

    // --- MICRO: списываем доп-ответы ТОЛЬКО если gate.plan === "micro" ---
    // Важно: checkAndConsumeQuota в micro-режиме не списывает — списываем тут.
    if (gate?.plan === "micro") {
      const c = consumeMicroBotAnswer(contactId);
      // после 12-го доп. ответа — шлём финальный вопрос
      // c.left = 1 означает: использовано 12 из 13 (остался 1)
      if (c.ok && c.left === 1) {
        await sendpulseTelegramSendText({ contactId, text: MICRO_BEFORE_FINAL_QUESTION_TEXT });
      }
      // после 13-го — закрываем цикл и сбрасываем “2 бесплатных ответа” на следующий цикл
      if (c.ok && c.left === 0) {
        await sendpulseTelegramSendText({ contactId, text: MICRO_CYCLE_FINISHED_TEXT });
        endMicroCycle(contactId);

        // чтобы следующий цикл снова начинался с 2 бесплатных ответов
        setAccess(contactId, {
          bot_answers_count: 0,
          paywall_shown: false,
          paywall_hold_notified: false,
        });
        return;
      }
    }

    // ==================== 8) Count bot answers for "2 free then pay" ====================
    // Считаем только если НЕ micro и НЕ активный paid-план (Tribute). Иначе не надо.
    const recAfter = getAccess(contactId) || {};
    const paidNow = isPaidActive(recAfter);
    const microNow = getMicroState(contactId);

    if (!paidNow && !microNow.active) {
      const botAnswers = Number.isFinite(recAfter.bot_answers_count) ? recAfter.bot_answers_count : 0;
      const newBotAnswers = botAnswers + 1;
      setAccess(contactId, { bot_answers_count: newBotAnswers });

      // после 2-го ответа — запускаем Stars-flow и ставим paywall_shown
      if (PAYWALL_BY_SENDPULSE && newBotAnswers === 2 && !recAfter.paywall_shown) {
        setAccess(contactId, { paywall_shown: true, paywall_hold_notified: false });
        await triggerStarsFlowIfConfigured(contactId);
        return;
      }
    }
  } catch (err) {
    console.error("SENDPULSE_WEBHOOK_ERROR:", err);
  }
}
