"use strict";

// Lightweight task router: both models are already used by NEXUS through Groq.
// No additional API key or paid provider is required.
const MODEL_GPT = "openai/gpt-oss-120b";
const MODEL_QWEN = "qwen/qwen3.8-27b";

function routeTask(text, preference = "auto") {
  const mode = String(preference || "auto").toLowerCase();
  if (mode === "gpt") return { model: MODEL_GPT, category: "general", reason: "Выбор пользователя" };
  if (mode === "qwen") return { model: MODEL_QWEN, category: "technical", reason: "Выбор пользователя" };

  const value = String(text || "");
  const rules = [
    { category: "coding", re: /\b(code|coding|debug|javascript|typescript|python|node\.js|sql|regex|api|github|git|html|css)\b|код|программ|скрипт|ошибк[аи] в коде|разработ|деплой|сервер|конфиг|лог[аи]|minecraft|майнкрафт|fabric|forge|neoforge/i },
    { category: "reasoning", re: /сравни|проанализ|рассчитай|математ|логическ|докажи|пошагов|архитектур|оптимиз|диагност|почему не работает/i }
  ];
  const match = rules.find(rule => rule.re.test(value));
  if (match) return { model: MODEL_QWEN, category: match.category, reason: "Техническая или аналитическая задача" };
  return { model: MODEL_GPT, category: "general", reason: "Универсальная задача" };
}

module.exports = { routeTask, MODEL_GPT, MODEL_QWEN };
