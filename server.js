// server.js
import express from "express";
import dotenv from "dotenv";
import fs from "node:fs";

import { triadChat } from "./src/triad/triad-openai.js";
import { handleSendpulseWebhook } from "./src/sendpulse/sendpulse-webhook.js";
import { setAccess } from "./src/access/access-store.js";
import { getContactIdByTgId } from "./src/access/tg-map-store.js";

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

// sMoF = unlimited, sMoE = basic (как ты сказала)
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

function requireCid(req, res) {
  const cid = String(req.query.cid || "").trim();
  if (!cid) {
    res.status(400).send("Missing cid");
    return null;
  }
  return cid;
}

// ---------- PAY REDIRECTS (Tribute) ----------
// ВАЖНО: НЕ меняем startapp вообще.
// Просто редиректим на TRIBUTE_*_URL как есть.
// (cid нужен только чтобы ссылку строить в paywall, но Tribute его не использует)
app.get("/pay/basic", (req, res) => {
  const cid = requireCid(req, res);
  if (!cid) return;

  const base = String(process.env.TRIBUTE_BASIC_URL || "").trim();
  if (!base) return res.status(500).send("TRIBUTE_BASIC_URL is not set");

  res.status(302).setHeader("Location", base);
  return res.end();
});

app.get("/pay/unlimited", (req, res) => {
  const cid = requireCid(req, res);
  if (!cid) return;

  const base = String(process.env.TRIBUTE_UNLIMITED_URL || "").trim();
  if (!base) return res.status(500).send("TRIBUTE_UNLIMITED_URL is not set");

  res.status(302).setHeader("Location", base);
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

// отдельные парсеры ТОЛЬКО для webhook,
// чтобы принять любой формат, который шлёт Tribute
const tributeBodyParsers = [
  express.json({
    limit: "2mb",
    type: ["application/json", "application/*+json"],
  }),
  express.urlencoded({ extended: true }),
  express.text({ type: "*/*", limit: "2mb" }), // fallback: если пришёл text/plain или непонятный content-type
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

    // body может быть объектом (после json/urlencoded) или строкой (после text)
    let b = req.body;

    // если пришла строка — попробуем распарсить JSON
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

    // 1) startapp/web_app_link (если есть)
    const rawStartapp =
      q.startapp ||
      b.startapp ||
      b.startApp ||
      b?.payload?.startapp ||
      b?.payload?.web_app_link ||
      b?.web_app_link ||
      "";

    const startapp = String(rawStartapp || "").trim();

    // 2) plan: sMoF=unlimited, sMoE=basic + нормализация по названию
    const plan =
      normalizePlan(q.plan) ||
      normalizePlan(b.plan) ||
      normalizePlan(b?.payload?.plan) ||
      normalizePlan(b?.payload?.subscription_name) ||
      planFromStartapp(startapp);

    // 3) contactId: почти всегда НЕ приходит от Tribute => берём tgId
    let contactId = String(
      q.contactId ||
        q.contact_id ||
        q.cid ||
        b.contactId ||
        b.contact_id ||
        b.cid ||
        ""
    ).trim();

    // 4) tgId -> contactId (главный сценарий)
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
        hint:
          "User must message the bot at least once before paying (to save tgId->contactId mapping).",
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
    const paid_until = b?.payload?.expires_at || b?.expires_at || addDaysISO(30);

    // ✅ ВАЖНО: после оплаты очищаем все "догонялки",
    // чтобы человеку не прилетели "пауза/питч" или "догон безлимита" уже после оплаты.
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

    // ✅ Для BASIC логично начинать лимит 100 сообщений "с нуля" на момент оплаты
    const resetBasicCounters =
      plan === "basic"
        ? {
            dialog_used: 0,
            dialog_warn95_sent: false,
            dialog_end100_sent: false,
          }
        : {};

    setAccess(contactId, {
      plan,
      paid_until,

      // unlimited использует дневной счётчик
      daily_used: 0,
      last_reset_date: new Date().toISOString().slice(0, 10),

      ...clearFollowups,
      ...resetBasicCounters,
    });

    return res.status(200).json({ ok: true, contactId, plan, paid_until });
  } catch (e) {
    console.error("TRIBUTE_WEBHOOK_ERROR:", e);
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

// принимаем ВСЁ: GET/POST и любой content-type
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
