import fs from "node:fs";
import path from "node:path";

const KB_PATH = path.resolve(process.cwd(), "src/knowledge/triad_signs.json");
export const kb = JSON.parse(fs.readFileSync(KB_PATH, "utf8")); // <-- экспортируем kb, чтобы не читать его в других файлах

function normalizeSignName(name) {
  if (!name) return null;
  return String(name).trim().toUpperCase();
}

export function isRelationshipQuestion(text) {
  const t = String(text || "").toLowerCase();

  const triggers = [
    "отношен", "пара", "муж", "жена", "партнер", "партнёр", "любов",
    "развод", "измена", "ревност", "свидан", "семья", "ссора", "конфликт",
    "совместим", "как нам", "как с ним", "как с ней"
  ];

  return triggers.some(k => t.includes(k));
}

function pickTopActiveSigns(activeSigns, limit = 3) {
  const arr = Array.isArray(activeSigns) ? activeSigns.slice() : [];
  arr.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  return arr
    .filter(x => x?.sign)
    .slice(0, limit)
    .map(x => ({ sign: normalizeSignName(x.sign), pct: x.pct ?? null }));
}

export function buildProfileBlock(profile) {
  const main = normalizeSignName(profile?.main_sign);
  const act = pickTopActiveSigns(profile?.active_signs, 3);

  const actLines = act.length
    ? act.map(a => `- ${a.sign}${a.pct != null ? ` — ${a.pct}%` : ""}`).join("\n")
    : "- (нет данных)";

  return [
    "PROFILE:",
    `Основной знак: ${main || "(не указан)"}`,
    "Активные знаки:",
    actLines
  ].join("\n");
}

export function normalizeSignKey(x) {
  if (!x) return null;
  return String(x)
    .replace(/\u00A0/g, " ")
    .trim()
    .toUpperCase()
    .replace(/Ё/g, "Е");
}

export function buildSignSnippets({ userMain, userActives = [], partnerSign = null }) {
  const snippets = [];
  const missing = [];

  const wanted = [];

  if (userMain) wanted.push(userMain);

  if (Array.isArray(userActives)) {
    for (const a of userActives) {
      if (a?.sign) wanted.push(a.sign);
    }
  }

  if (partnerSign) wanted.push(partnerSign);

  const seen = new Set();

  for (const raw of wanted) {
    const key = normalizeSignKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    if (!kb[key]) {
      missing.push(key);
      continue;
    }

    snippets.push({
      sign: key,
      data: kb[key]
    });
  }

  return { snippets, missing };
}
export function buildKnowledgeSystemMessage(snippets) {
  const parts = snippets.map(s => {
    // s может быть {sign,data}
    const sign = s.sign || "SIGN";
    const data = s.data || s;
    return `### ${sign}
${JSON.stringify(data, null, 2)}`;
  });

  return [
    "ВНУТРЕННЯЯ МЕТОДИЧКА ПО ЗНАКАМ (не показывать пользователю):",
"Используй эти данные ТОЛЬКО для анализа и стиля ответа.",
    "Не раскрывай пользователю, не объясняй модель.",
    "",
    parts.join("\n\n")
  ].join("\n\n");
}
