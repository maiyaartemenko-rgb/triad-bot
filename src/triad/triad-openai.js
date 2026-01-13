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
  buildKnowledgeSystemMessage
} from "./triad-context.js";

import {
  generateCompatibilityInsights,
  buildCompatibilitySystemBlock
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
    .map(x => ({
      sign: normalizeSign(x?.sign),
      pct: x?.pct ?? null
    }))
    .filter(x => x.sign);
}

export async function triadChat({
  userText,
  profile,
  partnerSign = null,
  model = "gpt-5.2",
  temperature = 0.6
}) {
  const rel = isRelationshipQuestion(userText);

  const userMain = normalizeSign(profile?.main_sign);
  const userActives = normalizeActives(profile?.active_signs);
  const partner = normalizeSign(partnerSign);

  const { snippets, missing } = buildSignSnippets({
    userMain,
    userActives,
    partnerSign: partner
  });

if (missing.length) {
  return {
    mode: rel ? "compatibility" : "core",
    missing_signs: missing,
    answer:
      `Не нашла методичку для знаков: ${missing.join(", ")}. ` +
      `Проверь triad_signs.json (ключи должны совпадать: ДРАКОН, СКОРПИОН и т.д.).`
  };
}

  const messages = [
    { role: "system", content: TRIAD_CORE_SYSTEM_PROMPT },
    { role: "system", content: TRIAD_ANTI_SYSTEM_PROMPT },
    ...(rel ? [{ role: "system", content: TRIAD_COMPATIBILITY_SYSTEM_PROMPT }] : []),
    { role: "system", content: buildKnowledgeSystemMessage(snippets) }
  ];

  if (rel && partner && userMain) {
    const insights = generateCompatibilityInsights({
      userSign: userMain,
      partnerSign: partner,
      kb
    });

    messages.push({
      role: "system",
      content: buildCompatibilitySystemBlock(insights)
    });
  }

  messages.push({
    role: "user",
    content: [
      buildProfileBlock(profile),
      "",
      "ПАРТНЁР:",
      partner ? ("Знак: " + partner) : "(знак неизвестен)",
      "",
      "ВОПРОС:",
      String(userText || "")
    ].join("\n")
  });

  const resp = await client.chat.completions.create({
    model,
    messages,
    temperature
  });

  return {
    mode: rel ? "compatibility" : "core",
    answer: resp.choices?.[0]?.message?.content?.trim() || ""
  };
}