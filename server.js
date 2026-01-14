import express from "express";
import dotenv from "dotenv";
import { triadChat } from "./src/triad/triad-openai.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// Health-check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Основной эндпоинт, который будет дёргать SendPulse
// ожидает JSON:
// {
//   "text": "вопрос пользователя",
//   "telegram_id": "123",
//   "profile": { "main_sign":"...", "active_signs":[{"sign":"..","pct":..}] },
//   "partnerSign": "..." // optional
// }
app.post("/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const text = String(body.text || "");
    const profile = body.profile || {};
    const partnerSign = body.partnerSign || null;

    if (!text.trim()) {
      return res.status(400).json({ error: "Missing text" });
    }

    // вызываем твой движок
    const result = await triadChat({
      userText: text,
      profile,
      partnerSign
    });

    res.json({
      ok: true,
      answer: result.answer,
      mode: result.mode,
      missing_signs: result.missing_signs || []
    });
  } catch (err) {
    console.error("CHAT_ERROR:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ВАЖНО: чтобы Express понимал JSON
app.use(express.json({ limit: "2mb" }));

app.post("/sendpulse/webhook", async (req, res) => {
  console.log("SENDPULSE WEBHOOK HEADERS:", req.headers);
  console.log("SENDPULSE WEBHOOK BODY:", JSON.stringify(req.body, null, 2));

  // пока просто отвечаем 200, чтобы SendPulse не ругался
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("Server listening on " + PORT);
});