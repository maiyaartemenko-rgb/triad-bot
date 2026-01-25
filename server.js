import express from "express";
import dotenv from "dotenv";

import { triadChat } from "./src/triad/triad-openai.js";
import { handleSendpulseWebhook } from "./src/sendpulse/sendpulse-webhook.js";
import { handleTributeWebhook } from "./src/tribute/tribute-webhook.js";

dotenv.config();

const app = express(); // ✅ app создаётся ДО любых app.post

// ---------- MIDDLEWARE ----------
app.use(express.json({ limit: "2mb" }));

// ---------- HEALTH ----------
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ---------- SENDPULSE WEBHOOK ----------
app.post(
  "/sendpulse/webhook",
  express.json({ limit: "2mb" }),
  handleSendpulseWebhook
);

// ---------- TRIBUTE WEBHOOK ----------
app.post(
  "/tribute/webhook",
  express.json({ limit: "2mb" }),
  handleTributeWebhook
);

// ---------- OPTIONAL: CHAT API (если нужен) ----------
app.post("/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const text = String(body.text || "");
    const profile = body.profile || {};
    const partnerSign = body.partnerSign || null;

    if (!text.trim()) {
      return res.status(400).json({ error: "Missing text" });
    }

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