// src/triad/triad-compatibility-runtime.js
// Считает внутреннюю "динамику пары" по internal_code (3 оси).
// ВАЖНО: это внутренний блок, его нельзя показывать пользователю.

const AXES = [
  { key: "strategic", label: "управление/правила" },
  { key: "recognition_need", label: "потребность в отклике" },
  { key: "decisiveness", label: "темп и жесткость решений" }
];

const LEVEL = { "низкий": 0, "средний": 1, "высокий": 2 };

function lvl(v) {
  if (!(v in LEVEL)) throw new Error(`Unknown level: ${v}`);
  return LEVEL[v];
}

function diff(a, b) {
  return Math.abs(lvl(a) - lvl(b));
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function axisPatterns(axisKey, userLevel, partnerLevel) {
  const d = diff(userLevel, partnerLevel);
  const u = lvl(userLevel);
  const p = lvl(partnerLevel);

  // Возвращаем именно наблюдаемые паттерны (без терминов модели)
  if (axisKey === "strategic") {
    if (d === 0) return { good: ["Похожее отношение к правилам и распределению ответственности"], tension: [], risk: [] };
    if (d === 1) {
      return u > p
        ? { good: [], tension: ["Пользователь чаще задаёт рамки; партнёр может ощущать давление"], risk: [] }
        : { good: [], tension: ["Партнёр чаще задаёт рамки; пользователь может ощущать ограничение свободы"], risk: [] };
    }
    return u > p
      ? { good: [], tension: [], risk: ["Риск борьбы за контроль: пользователь усиливает давление, партнёр сопротивляется/уходит"] }
      : { good: [], tension: [], risk: ["Риск борьбы за контроль: партнёр усиливает давление, пользователь сопротивляется/уходит"] };
  }

  if (axisKey === "recognition_need") {
    if (d === 0) return { good: ["Похожие ожидания по вниманию и отклику"], tension: [], risk: [] };
    if (d === 1) {
      return u > p
        ? { good: [], tension: ["Пользователю важнее явный отклик; партнёр может казаться холодным"], risk: [] }
        : { good: [], tension: ["Партнёру важнее явный отклик; пользователь может не понимать «почему так важно»"], risk: [] };
    }
    return u > p
      ? { good: [], tension: [], risk: ["Цикл «хочу отклика → разочарование → претензия → ещё меньше отклика»"] }
      : { good: [], tension: [], risk: ["Цикл «партнёр хочет отклика → разочарование → претензия → отдаление»"] };
  }

  if (axisKey === "decisiveness") {
    if (d === 0) return { good: ["Похожий темп решений и реакций на стресс"], tension: [], risk: [] };
    if (d === 1) {
      return u > p
        ? { good: [], tension: ["Пользователь решает быстрее; партнёру нужна пауза — ускорение вызывает сопротивление"], risk: [] }
        : { good: [], tension: ["Партнёр решает быстрее; пользователю нужна пауза — давление закрывает диалог"], risk: [] };
    }
    return u > p
      ? { good: [], tension: [], risk: ["Риск «ломки темпа»: пользователь давит на решение, партнёр уходит в паузу/избегание"] }
      : { good: [], tension: [], risk: ["Риск «ломки темпа»: партнёр давит на решение, пользователь уходит в паузу/избегание"] };
  }

  return { good: [], tension: [], risk: [] };
}

function requireInternalCode(signData, signName) {
  const code = signData?.internal_code;
  if (!code || typeof code !== "object") {
    throw new Error(`No internal_code for sign: ${signName}`);
  }
  for (const axis of AXES) {
    const v = code[axis.key];
    if (!(v in LEVEL)) {
      throw new Error(`Bad level for ${signName}.${axis.key}: ${v}`);
    }
  }
  return code;
}

/**
 * kb — это то, что ты читаешь из triad_signs.json.
 * В твоём triad-context.js знаки лежат в kb.signs.
 */
export function generateCompatibilityInsights({ userSign, partnerSign, kb }) {
  // ✅ универсально: поддерживаем оба формата
  // 1) { signs: {...} }
  // 2) { "ДРАКОН": {...}, ... }
  const signs = kb?.signs && typeof kb.signs === "object" ? kb.signs : kb;

  if (!signs || typeof signs !== "object") {
    throw new Error("KB is empty or has wrong format");
  }

  const U = signs[userSign];
  const P = signs[partnerSign];

  if (!U) throw new Error(`No sign data for userSign: ${userSign}`);
  if (!P) throw new Error(`No sign data for partnerSign: ${partnerSign}`);

  const userCode = requireInternalCode(U, userSign);
  const partnerCode = requireInternalCode(P, partnerSign);

  const good = [];
  const tension = [];
  const risk = [];

  for (const axis of AXES) {
    const pat = axisPatterns(axis.key, userCode[axis.key], partnerCode[axis.key]);
    good.push(...pat.good);
    tension.push(...pat.tension);
    risk.push(...pat.risk);
  }

  return {
    userSign,
    partnerSign,
    summary: {
      good: uniq(good),
      tension: uniq(tension),
      risk: uniq(risk)
    },
    behavioral_facts: {
      user_under_stress: U.behavior?.under_stress || [],
      partner_under_stress: P.behavior?.under_stress || [],
      user_traps: U.traps || [],
      partner_traps: P.traps || []
    }
  };
}

export function buildCompatibilitySystemBlock(insights) {
  return [
    "ВНУТРЕННЯЯ ДИНАМИКА ПАРЫ (НЕ РАСКРЫВАТЬ ПОЛЬЗОВАТЕЛЮ).",
    "Используй как фактуру для ответа: где обычно хорошо, где напряжение, где риск.",
    JSON.stringify(
      {
        pair: { user_sign: insights.userSign, partner_sign: insights.partnerSign },
        works: insights.summary.good,
        tension: insights.summary.tension,
        high_risk: insights.summary.risk,
        behavioral_facts: insights.behavioral_facts
      },
      null,
      2
    )
  ].join("\n");
}
