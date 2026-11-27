"use strict";

// Independent NEXUS proactive sender. Runs from GitHub Actions when Render
// cannot answer its heartbeat. Uses Cloudflare KV as the shared durable registry.

const BOT_TOKEN = process.env.BOT_TOKEN;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const HEARTBEAT_URL = process.env.NEXUS_HEARTBEAT_URL ||
  "https://nexus-ai-bot-kt4w.onrender.com/heartbeat";

const required = [BOT_TOKEN, CF_ACCOUNT, CF_TOKEN, CF_NAMESPACE];
if (required.some(value => !value)) {
  console.error("Missing required GitHub Actions secrets: BOT_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_KV_NAMESPACE_ID");
  process.exit(1);
}

const now = Date.now();
const registryKey = "nexus:proactive:registry";
const baseUrl = "https://api.cloudflare.com/client/v4/accounts/" +
  encodeURIComponent(CF_ACCOUNT) + "/storage/kv/namespaces/" +
  encodeURIComponent(CF_NAMESPACE) + "/values/";

function kvUrl(key) { return baseUrl + encodeURIComponent(key); }

async function kvRead(key, fallback = {}) {
  const response = await fetch(kvUrl(key), {
    headers: { Authorization: "Bearer " + CF_TOKEN },
    signal: AbortSignal.timeout(15000)
  });
  if (response.status === 404) return fallback;
  if (!response.ok) throw new Error("Cloudflare KV read HTTP " + response.status);
  return response.json();
}

async function kvWrite(key, value) {
  const response = await fetch(kvUrl(key), {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + CF_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error("Cloudflare KV write HTTP " + response.status);
}

async function renderResponds() {
  try {
    const response = await fetch(HEARTBEAT_URL, {
      signal: AbortSignal.timeout(120000),
      headers: { "User-Agent": "NEXUS-GitHub-Autonomous-Backup/1.0" }
    });
    return response.ok;
  } catch (error) {
    console.log("Render heartbeat unavailable; using independent Telegram sender:", error.message);
    return false;
  }
}

async function generateMessage(userId, state, memory) {
  const context = [
    memory.summary || "",
    ...(Array.isArray(memory.facts) ? memory.facts.slice(-5) : []),
    ...(Array.isArray(memory.memoryItems) ? memory.memoryItems.slice(-5).map(item => item.content) : [])
  ].filter(Boolean).join("\n").slice(0, 1000);

  if (GROQ_API_KEY) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + GROQ_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b",
          temperature: 0.85,
          max_tokens: 120,
          messages: [
            {
              role: "system",
              content: "Ты NEXUS AI — живой по стилю, но честный ИИ-собеседник. Напиши одно короткое естественное сообщение на русском, 1–2 предложения, до 220 символов. Не говори, что скучал или испытывал человеческие чувства. Не упоминай автоматизацию, расписание или Render. Не навязывайся, не повторяй последнюю инициативную фразу. Одна мысль, без рекламы, без случайных фактов и без markdown."
            },
            {
              role: "user",
              content: "Последнее инициативное сообщение: " + String(state.lastProactiveMessage || "нет") +
                "\nКонтекст о собеседнике (используй только если естественно): " + (context || "нет") +
                "\nНачни разговор коротко и по-человечески."
            }
          ]
        }),
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error("Groq HTTP " + response.status);
      const data = await response.json();
      const text = String(data.choices?.[0]?.message?.content || "").trim()
        .replace(/^[\"«]|[\"»]$/g, "").slice(0, 240);
      if (text.length >= 8) return text;
    } catch (error) {
      console.log("Groq proactive generation failed; using local message:", error.message);
    }
  }

  const options = [
    "Слушай, внезапный вопрос: какую игру ты бы с удовольствием прошёл ещё раз с нуля?",
    "Какую песню сейчас можешь слушать на повторе и не надоедает?",
    "Если бы можно было на пару часов телепортироваться куда угодно, куда бы рванул?",
    "Есть фильм или сериал, который ты можешь пересматривать снова и снова?",
    "Чем сейчас занимаешься? Закинул тебе маленький вопрос 🙂",
    "Вот интересно: что бы ты сегодня выбрал — спокойный вечер или куда-нибудь выбраться?"
  ];
  const choices = options.filter(text => text !== state.lastProactiveMessage);
  return choices[Math.floor(Math.random() * choices.length)] || options[0];
}

async function sendTelegram(chatId, text) {
  const response = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const error = new Error(data.description || "Telegram send failed HTTP " + response.status);
    error.telegramDescription = String(data.description || "");
    throw error;
  }
}

async function main() {
  // If Render wakes successfully, its own autonomous loop handles messages.
  // This avoids two senders competing while the main service is healthy.
  if (await renderResponds()) {
    console.log("Render heartbeat OK; main NEXUS process will handle autonomous messages.");
    return;
  }

  const registry = await kvRead(registryKey, {});
  let changed = false;
  let sent = 0;
  const cooldownMs = 48 * 60 * 60 * 1000;
  const promoCooldownMs = 7 * 24 * 60 * 60 * 1000;

  for (const [userId, rawState] of Object.entries(registry)) {
    const state = rawState && typeof rawState === "object" ? rawState : {};
    if (state.enabled === false || !state.chatId || !state.lastSeenAt) continue;

    const configuredHours = [6, 12, 24].includes(Number(state.inactivityHours))
      ? Number(state.inactivityHours) : 24;
    const engagementFactor = Number(state.consecutiveIgnored || 0) >= 2
      ? 2 : Number(state.proactiveReplies || 0) >= 2 ? 0.75 : 1;
    const inactiveMs = Math.max(2 * 60 * 60 * 1000,
      Math.min(48 * 60 * 60 * 1000, configuredHours * 60 * 60 * 1000 * engagementFactor));
    if (now - Number(state.lastSeenAt || 0) < inactiveMs) {
      if (state.nextProactiveAt) { state.nextProactiveAt = null; changed = true; }
      continue;
    }
    if (now - Number(state.lastSentAt || 0) < cooldownMs) continue;

    if (!Number(state.nextProactiveAt)) {
      state.nextProactiveAt = now + 60 * 60 * 1000 +
        Math.floor(Math.random() * 5 * 60 * 60 * 1000);
      changed = true;
      continue;
    }
    if (now < Number(state.nextProactiveAt)) continue;

    const memory = await kvRead("nexus:user:" + userId, {});
    const tier = String(memory.premium?.tier || "free").toLowerCase();
    const expiresAt = Number(memory.premium?.expiresAt || 0);
    const premiumActive = tier !== "free" && (!expiresAt || expiresAt > now);
    const promoEligible = !premiumActive &&
      now - Number(state.lastPremiumPromoAt || 0) >= promoCooldownMs;
    const sendPromo = promoEligible && Math.random() < 0.22;

    const promoTexts = [
      "Кстати, если бесплатных лимитов NEXUS иногда не хватает, можно посмотреть Premium: /premium",
      "Если захочешь больше лимитов на ИИ и медиа в NEXUS, тарифы здесь: /premium — без давления 🙂",
      "Оставлю на всякий случай: у NEXUS есть Premium с повышенными лимитами. Посмотреть: /premium"
    ];
    const message = sendPromo
      ? promoTexts[Math.floor(Math.random() * promoTexts.length)]
      : await generateMessage(userId, state, memory);

    const oldState = { ...state };
    if (Number(state.lastSentAt || 0) > Number(state.lastSeenAt || 0)) {
      state.consecutiveIgnored = Math.min(10, Number(state.consecutiveIgnored || 0) + 1);
    }
    state.lastSentAt = now;
    state.lastProactiveMessage = message;
    state.nextProactiveAt = null;
    if (sendPromo) state.lastPremiumPromoAt = now;

    // Write the shared cooldown before sending to reduce duplicate messages
    // if Render comes back online at the same moment.
    await kvWrite(registryKey, registry);
    try {
      await sendTelegram(state.chatId, message);
      sent++;
      console.log("Sent independent proactive message to chat " + String(state.chatId));
    } catch (error) {
      Object.assign(state, oldState);
      if (/blocked|chat not found|deactivated/i.test(error.telegramDescription || error.message)) {
        state.enabled = false;
      }
      await kvWrite(registryKey, registry);
      console.error("Telegram send failed:", error.message);
    }
    changed = true;
  }

  if (changed) await kvWrite(registryKey, registry);
  console.log("Independent proactive run complete. Sent: " + sent);
}

main().catch(error => {
  console.error("NEXUS independent autonomous sender failed:", error.message);
  process.exit(1);
});
