import dotenv from "dotenv";
dotenv.config();

import OpenAI from "openai";

import { TRIAD_CORE_SYSTEM_PROMPT } from "../prompts/core.system.js";
import { TRIAD_COMPATIBILITY_SYSTEM_PROMPT } from "../prompts/compatibility.system.js";
import { TRIAD_ANTI_SYSTEM_PROMPT } from "../prompts/anti.system.js";

import {
  kb,
  isRelationshipQuestion,
  buildProfileBlock,
  buildSignSnippets,
  buildKnowledgeSystemMessage,
} from "./triad-context.js";

import {
  generateCompatibilityInsights,
  buildCompatibilitySystemBlock,
} from "./triad-compatibility-runtime.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function normalizeSign(name) {
  if (!name) return null;
  const s = String(name).trim().toUpperCase();
  return s || null;
}

function normalizeActives(active_signs) {
  const arr = Array.isArray(active_signs) ? active_signs : [];
  return arr
    .map((x) => ({
      sign: normalizeSign(x?.sign),
      pct: x?.pct ?? null,
    }))
    .filter((x) => x.sign);
}

// берём только роли user/assistant и только текст
function normalizeHistory(history) {
  const arr = Array.isArray(history) ? history : [];
  return arr
    .map((m) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: String(m?.content || "").trim(),
    }))
    .filter((m) => m.content);
}

function buildFullActivesBlock(userActives) {
  const full = Array.isArray(userActives) ? [...userActives] : [];

  // сортируем по pct (если есть), но НЕ обрезаем
  full.sort((a, b) => {
    const ap = Number.isFinite(Number(a?.pct)) ? Number(a.pct) : -Infinity;
    const bp = Number.isFinite(Number(b?.pct)) ? Number(b.pct) : -Infinity;
    return bp - ap;
  });

  const json = JSON.stringify(full);

  const list = full.length
    ? full
        .map((x) => {
          const pct = x?.pct == null ? "" : ` ${String(x.pct)}%`;
          return `${String(x.sign)}${pct}`.trim();
        })
        .join(", ")
    : "—";

  return [
    "PROFILE_ACTIVE_SIGNS_FULL_JSON:",
    json,
    "",
    "PROFILE_ACTIVE_SIGNS_FULL_LIST:",
    list,
  ].join("\n");
}

export async function triadChat({
  userText,
  profile,
  partnerSign = null,
  history = [], // ✅ ПАМЯТЬ
  model = "gpt-5.2",
  temperature = 0.6,
}) {
  const rel = isRelationshipQuestion(userText);

  const userMain = normalizeSign(profile?.main_sign);
  const userActives = normalizeActives(profile?.active_signs); // ✅ тут уже полный массив

  const partner = normalizeSign(partnerSign);

  const { snippets, missing } = buildSignSnippets({
    userMain,
    userActives, // ✅ передаём полный массив (если buildSignSnippets не режет — будет ок)
    partnerSign: partner,
  });

  if (missing.length) {
    return {
      mode: rel ? "compatibility" : "core",
      missing_signs: missing,
      answer: `Не нашла методичку для знаков: ${missing.join(
        ", "
      )}. Проверь triad_signs.json (ключи должны совпадать: ДРАКОН, СКОРПИОН и т.д.).`,
    };
  }

  const messages = [
    { role: "system", content: TRIAD_CORE_SYSTEM_PROMPT },
    { role: "system", content: TRIAD_ANTI_SYSTEM_PROMPT },
    ...(rel ? [{ role: "system", content: TRIAD_COMPATIBILITY_SYSTEM_PROMPT }] : []),
    { role: "system", content: buildKnowledgeSystemMessage(snippets) },
  ];

  if (rel && partner && userMain) {
    try {
      const insights = generateCompatibilityInsights({
        userSign: userMain,
        partnerSign: partner,
        kb,
      });
      messages.push({
        role: "system",
        content: buildCompatibilitySystemBlock(insights),
      });
    } catch (e) {
      console.error("compatibility disabled:", e?.message || e);
    }
  }

  // ✅ добавляем память до текущего запроса (нормализуем роли/тексты)
  const hist = normalizeHistory(history);
  if (hist.length) {
    messages.push(...hist);
  }

  // ✅ ВАЖНО: добавляем полный список active_signs отдельным блоком (без обрезки)
  const fullActivesBlock = buildFullActivesBlock(userActives);

  // ✅ текущий запрос — всегда последним user-сообщением
  messages.push({
    role: "user",
    content: [
      // как было (может резать — не трогаем)
      buildProfileBlock(profile),

      "",
      // ✅ добавили: полный массив active_signs (JSON + список)
      fullActivesBlock,

      "",
      "ПАРТНЁР:",
      partner ? "Знак: " + partner : "(знак неизвестен)",

      "",
      "ВОПРОС:",
      String(userText || ""),
    ].join("\n"),
  });

  const resp = await client.chat.completions.create({
    model,
    messages,
    temperature,
  });

  return {
    mode: rel ? "compatibility" : "core",
    answer: resp.choices?.[0]?.message?.content?.trim() || "",
  };
}
