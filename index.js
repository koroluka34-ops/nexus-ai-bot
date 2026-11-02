
const { Bot, webhookCallback } = require("grammy");
const http = require("http");

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!BOT_TOKEN || !GROQ_API_KEY) {
  throw new Error("Не заданы BOT_TOKEN или GROQ_API_KEY");
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

  if (!histories.has(userId)) {
    histories.set(userId, []);
  }

  const history = histories.get(userId);

  await ctx.replyWithChatAction("typing");

  try {
    const messages = [
      {
        role: "system",
        content:
          "Ты NEXUS AI — умный, дружелюбный персональный ИИ-помощник. " +
          "Отвечай на русском языке, понятно и подробно."
      },
      ...history,
      { role: "user", content: question }
    ];

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages,
          temperature: 0.7,
          max_tokens: 1200
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Groq error:", data);
      throw new Error("Ошибка Groq API");
    }

    const answer =
      data.choices?.[0]?.message?.content ||
      "Не получилось получить ответ.";

    history.push(
      { role: "user", content: question },
      { role: "assistant", content: answer }
    );

    while (history.length > 20) {
      history.shift();
    }

    for (let i = 0; i < answer.length; i += 4000) {
      await ctx.reply(answer.slice(i, i + 4000));
    }
  } catch (error) {
    console.error(error);
    await ctx.reply("⚠️ Произошла ошибка. Попробуй ещё раз.");
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
        res.end("Error");
      }
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NEXUS AI started on port ${PORT}`);
});
