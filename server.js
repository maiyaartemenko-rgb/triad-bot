// server.js
import express from "express";
import dotenv from "dotenv";
import fs from "node:fs";

import { triadChat } from "./src/triad/triad-openai.js";
import { handleSendpulseWebhook } from "./src/sendpulse/sendpulse-webhook.js";
import { setAccess } from "./src/access/access-store.js";
import { getContactIdByTgId } from "./src/access/tg-map-store.js";
import { sendpulseTelegramSendText } from "./src/sendpulse/sendpulse-api.js";

dotenv.config();

const app = express();

// ---------- MIDDLEWARE ----------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- HELPERS ----------
function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

function normalizePlan(p) {
  const x = String(p || "").toLowerCase().trim();
  if (!x) return null;
  if (x.includes("unlimit")) return "unlimited";
  if (x.includes("basic")) return "basic";
  return null;
}

// sMoF = unlimited, sMoE = basic
function planFromStartapp(startapp = "") {
  const s = String(startapp || "");
  if (s.includes("sMoF")) return "unlimited";
  if (s.includes("sMoE")) return "basic";
  return null;
}

// иногда Tribute присылает web_app_link: https://t.me/tribute/app?startapp=XXXX
function extractStartappValue(maybeUrlOrCode = "") {
  const s = String(maybeUrlOrCode || "").trim();
  if (!s) return "";
  if (s.includes("startapp=")) {
    const m = s.match(/startapp=([^&\s]+)/);
    return m ? m[1] : "";
  }
  return s; // уже код
}

// достаем contactId из startapp вида sMoE.<cid> / sMoF.<cid>
function extractCidFromStartapp(startapp = "") {
  const s = String(startapp || "").trim();
  const m = s.match(/^(sMoE|sMoF)\.(.+)$/);
  return m ? String(m[2] || "").trim() : "";
}

function requireCid(req, res) {
  const cid = String(req.query.cid || "").trim();
  if (!cid) {
    res.status(400).send("Missing cid");
    return null;
  }
  return cid;
}

// добавляем startapp к Tribute URL (или cid как запасной параметр, если startapp уже есть)
function appendStartapp(url, startappValue) {
  const s = String(url || "").trim();
  if (!s) return s;

  // если startapp уже есть, не ломаем — добавим отдельный cid
  if (s.includes("startapp=")) {
    const joiner = s.includes("?") ? "&" : "?";
    const cid = startappValue.split(".").slice(1).join(".") || "";
    return `${s}${joiner}cid=${encodeURIComponent(cid)}`;
  }

  const joiner = s.includes("?") ? "&" : "?";
  return `${s}${joiner}startapp=${encodeURIComponent(startappValue)}`;
}

function normalizePaidUntil(x) {
  if (!x) return addDaysISO(30);

  // число или строка-число
  if (typeof x === "number" || /^\d+$/.test(String(x))) {
    const n = Number(x);
    const ms = n < 10_000_000_000 ? n * 1000 : n; // seconds -> ms
    return new Date(ms).toISOString();
  }

  // строка-дата
  const t = new Date(x).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : addDaysISO(30);
}

// ---------- PAY REDIRECTS (Tribute) ----------
// ВАЖНО: теперь вшиваем cid в startapp, чтобы Tribute webhook мог 100% привязать оплату к contactId.
app.get("/pay/basic", (req, res) => {
  const cid = requireCid(req, res);
  if (!cid) return;

  const base = String(process.env.TRIBUTE_BASIC_URL || "").trim();
  if (!base) return res.status(500).send("TRIBUTE_BASIC_URL is not set");

  // sMoE = basic
  const url = appendStartapp(base, `sMoE.${cid}`);

  res.status(302).setHeader("Location", url);
  return res.end();
});

app.get("/pay/unlimited", (req, res) => {
  const cid = requireCid(req, res);
  if (!cid) return;

  const base = String(process.env.TRIBUTE_UNLIMITED_URL || "").trim();
  if (!base) return res.status(500).send("TRIBUTE_UNLIMITED_URL is not set");

  // sMoF = unlimited
  const url = appendStartapp(base, `sMoF.${cid}`);

  res.status(302).setHeader("Location", url);
  return res.end();
});

// ---------- DEBUG ACCESS ----------
app.get("/debug/access", (req, res) => {
  try {
    const file = "/data/access.json";
    if (!fs.existsSync(file)) {
      return res.json({
        ok: true,
        users: {},
        note: "access.json ещё не создан — появится после первого вопроса",
      });
    }
    const txt = fs.readFileSync(file, "utf8");
    res.type("json").send(txt);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/debug/tg-map", (req, res) => {
  try {
    const file = "/data/tg-map.json";
    if (!fs.existsSync(file)) {
      return res.json({
        ok: true,
        map: {},
        note: "tg-map.json ещё не создан — появится после первого сообщения в бота",
      });
    }
    const txt = fs.readFileSync(file, "utf8");
    res.type("json").send(txt);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- SENDPULSE WEBHOOK ----------
app.post("/sendpulse/webhook", handleSendpulseWebhook);

// ---------- TRIBUTE WEBHOOK (ROBUST) ----------
const tributeBodyParsers = [
  express.json({
    limit: "2mb",
    type: ["application/json", "application/*+json"],
  }),
  express.urlencoded({ extended: true }),
  express.text({ type: "*/*", limit: "2mb" }),
];

function safeJsonParseMaybe(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

async function tributeWebhook(req, res) {
  try {
    const headers = req.headers || {};
    const q = req.query || {};

    let b = req.body;

    if (typeof b === "string") {
      const parsed = safeJsonParseMaybe(b);
      if (parsed) b = parsed;
    }
    if (!b || typeof b !== "object") b = {};

    console.log("========== TRIBUTE WEBHOOK ==========");
    console.log("METHOD:", req.method);
    console.log("HEADERS:", headers);
    console.log("QUERY:", q);
    console.log("BODY_TYPE:", typeof req.body);
    console.log("BODY_RAW:", typeof req.body === "string" ? req.body : null);
    console.log("BODY_JSON:", JSON.stringify(b, null, 2));
    console.log("=====================================");

    // 1) startapp/web_app_link
    const rawStartapp =
      q.startapp ||
      b.startapp ||
      b.startApp ||
      b?.payload?.startapp ||
      b?.payload?.web_app_link ||
      b?.web_app_link ||
      "";

    const startappRaw = String(rawStartapp || "").trim();
    const startapp = extractStartappValue(startappRaw);

    // 2) plan
    const plan =
      normalizePlan(q.plan) ||
      normalizePlan(b.plan) ||
      normalizePlan(b?.payload?.plan) ||
      normalizePlan(b?.payload?.subscription_name) ||
      planFromStartapp(startapp);

    // 3) contactId (если Tribute вдруг прислал)
    let contactId = String(
      q.contactId ||
        q.contact_id ||
        q.cid ||
        b.contactId ||
        b.contact_id ||
        b.cid ||
        ""
    ).trim();

    // 3.1) если contactId нет — пробуем вытащить из startapp (sMoE.<cid>/sMoF.<cid>)
    if (!contactId) {
      const cidFromStartapp = extractCidFromStartapp(startapp);
      if (cidFromStartapp) {
        contactId = cidFromStartapp;
        console.log("startapp -> contactId:", startapp, "->", contactId);
      }
    }

    // 4) если всё ещё нет — tgId -> contactId
    if (!contactId) {
      const tgId =
        b?.payload?.telegram_user_id ||
        b?.telegram_user_id ||
        b?.payload?.user?.telegram_user_id ||
        b?.payload?.user?.id ||
        b?.payload?.user_id ||
        b?.user_id ||
        null;

      if (tgId) {
        contactId = String(getContactIdByTgId(String(tgId)) || "").trim();
        console.log("tgId -> contactId:", tgId, "->", contactId || "(not found)");
      }
    }

    if (!contactId) {
      return res.status(200).json({
        ok: false,
        error: "contactId_not_found",
        hint: "User must message the bot at least once OR pay link must include cid in startapp.",
        got: { startapp },
      });
    }

    if (!plan) {
      return res.status(200).json({
        ok: false,
        error: "plan_not_detected",
        got: { startapp, subscription_name: b?.payload?.subscription_name || null },
      });
    }

    // 5) paid_until
    const paid_until = normalizePaidUntil(b?.payload?.expires_at || b?.expires_at);

    // clear followups
    const clearFollowups = {
      paywall_shown: false,
      paywall_pause_due_at: null,
      paywall_pause_sent: false,
      paywall_pitch_due_at: null,
      paywall_pitch_sent: false,
      unlimited_upsell_shown: false,
      unlimited_nudge_due_at: null,
      unlimited_nudge_sent: false,
    };

    const resetBasicCounters =
      plan === "basic"
        ? {
            dialog_used: 0,
            dialog_warn95_sent: false,
            dialog_end100_sent: false,
          }
        : {};

    // 🔥 важно для твоего текущего sendpulse-webhook (оффер после 2-х ответов)
    const resetOfferMode = {
      bot_answers_count: 0,
      paywall_shown: false,
      paywall_hold_notified: false,
    };

    setAccess(contactId, {
      plan,
      paid_until,

      daily_used: 0,
      last_reset_date: new Date().toISOString().slice(0, 10),

      ...resetOfferMode,
      ...clearFollowups,
      ...resetBasicCounters,
    });

    // сообщение после оплаты
    try {
      const planName = plan === "basic" ? "BASIC (100 сообщений на 30 дней)" : "БЕЗЛИМИТ (2990 ₽)";
      const msg = [
        "✅ Оплата прошла! Доступ активирован.",
        "",
        `Твой тариф: <b>${planName}</b>`,
        `Доступ активен до: <b>${new Date(paid_until).toLocaleString("ru-RU")}</b>`,
        "",
        "📩 Файлы/бонусы мы пришлём в течение <b>1 суток</b> после оплаты.",
      ].join("\n");

      await sendpulseTelegramSendText({ contactId, text: msg });
    } catch (e) {
      console.error("POSTPAY_MESSAGE_ERROR:", e);
    }

    return res.status(200).json({ ok: true, contactId, plan, paid_until, startapp });
  } catch (e) {
    console.error("TRIBUTE_WEBHOOK_ERROR:", e);
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

app.all("/tribute/webhook", tributeBodyParsers, tributeWebhook);

// ---------- HEALTH ----------
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ---------- OPTIONAL: CHAT API ----------
app.post("/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const text = String(body.text || "");
    const profile = body.profile || {};
    const partnerSign = body.partnerSign || null;

    if (!text.trim()) return res.status(400).json({ error: "Missing text" });

    const result = await triadChat({
      userText: text,
      profile,
      partnerSign,
    });

    res.json({
      ok: true,
      answer: result.answer,
      mode: result.mode,
      missing_signs: result.missing_signs || [],
    });
  } catch (err) {
    console.error("CHAT_ERROR:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
