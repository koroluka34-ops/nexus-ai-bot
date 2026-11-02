
const { Bot, webhookCallback } = require("grammy");
const http = require("http");

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL;

if (!BOT_TOKEN || !GROQ_API_KEY || !WEBHOOK_URL) {
  throw new Error("Проверь BOT_TOKEN, GROQ_API_KEY и адрес Render");
}

const bot = new Bot(BOT_TOKEN);
const histories = new Map();

bot.command("start", async (ctx) => {
  histories.delete(ctx.from.id);
  await ctx.reply(
    "👋 Привет! Я NEXUS AI.\n\n" +
    "Я твой персональный ИИ-помощник.\n" +
    "Напиши мне любой вопрос!\n\n" +
    "/reset — очистить память"
  );
});

bot.command("reset", async (ctx) => {
  histories.delete(ctx.from.id);
  await ctx.reply("🧹 История диалога очищена!");
});

bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const question = ctx.message.text;

  if (!histories.has(userId)) histories.set(userId, []);
  const history = histories.get(userId);

  await ctx.replyWithChatAction("typing");

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            {
              role: "system",
              content: "Ты NEXUS AI — дружелюбный и умный ИИ-помощник. Отвечай на русском языке."
            },
            ...history,
            { role: "user", content: question }
          ],
          temperature: 0.7,
          max_tokens: 1200
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Groq:", data);
      throw new Error("Ошибка Groq API");
    }

    const answer = data.choices?.[0]?.message?.content ||
      "Не удалось получить ответ.";

    history.push(
      { role: "user", content: question },
      { role: "assistant", content: answer }
    );

    while (history.length > 20) history.shift();

    for (let i = 0; i < answer.length; i += 4000) {
      await ctx.reply(answer.slice(i, i + 4000));
    }
  } catch (error) {
    console.error(error);
    await ctx.reply("⚠️ Ошибка ИИ. Попробуй ещё раз.");
  }
});

const handleUpdate = webhookCallback(bot, "http");

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("NEXUS AI is online!");
  }

  if (req.method === "POST" && req.url === "/telegram") {
    try {
      await handleUpdate(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Webhook error");
      }
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`NEXUS AI started on port ${PORT}`);

  try {
    await bot.api.setWebhook(`${WEBHOOK_URL}/telegram`);
    console.log("Telegram webhook connected!");
  } catch (error) {
    console.error("Webhook setup error:", error);
  }
});
