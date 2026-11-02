
const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
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
const searchModes = new Set();

// Главное меню
function mainMenu() {
  return new InlineKeyboard()
    .text("💬 Общение", "menu_chat")
    .row()
    .text("🌐 Поиск в интернете", "menu_search")
    .row()
    .text("🧠 Возможности", "menu_features")
    .row()
    .text("🧹 Очистить память", "menu_reset");
}

// Старт
bot.command("start", async (ctx) => {
  await ctx.reply(
    "🚀 Добро пожаловать в NEXUS AI!\n\n" +
    "Твой персональный ИИ-помощник.\n" +
    "Выбери действие 👇",
    { reply_markup: mainMenu() }
  );
});

// Меню
bot.command("menu", async (ctx) => {
  await ctx.reply(
    "🏠 Главное меню NEXUS AI",
    { reply_markup: mainMenu() }
  );
});

// Очистка памяти
bot.command("reset", async (ctx) => {
  histories.delete(ctx.from.id);
  searchModes.delete(ctx.from.id);
  await ctx.reply("🧹 История диалога очищена!");
});

// Кнопка общения
bot.callbackQuery("menu_chat", async (ctx) => {
  searchModes.delete(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply("💬 Напиши мне любой вопрос!");
});

// Кнопка поиска
bot.callbackQuery("menu_search", async (ctx) => {
  searchModes.add(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "🌐 Режим поиска включён!\n\n" +
    "Напиши, что нужно найти.\n" +
    "Например: последние новости Minecraft."
  );
});

// Возможности
bot.callbackQuery("menu_features", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "🧠 Возможности NEXUS AI:\n\n" +
    "💬 Ответы на вопросы\n" +
    "🌐 Поиск в интернете\n" +
    "📚 Объяснение сложных тем\n" +
    "✍️ Создание текстов\n" +
    "💻 Помощь с программированием\n" +
    "🌍 Переводы\n" +
    "🧮 Решение задач"
  );
});

// Очистка через кнопку
bot.callbackQuery("menu_reset", async (ctx) => {
  histories.delete(ctx.from.id);
  searchModes.delete(ctx.from.id);

  await ctx.answerCallbackQuery({
    text: "Память очищена!"
  });

  await ctx.reply(
    "🧹 История диалога очищена!",
    { reply_markup: mainMenu() }
  );
});

// Обработка сообщений
bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const question = ctx.message.text;

  if (!histories.has(userId)) {
    histories.set(userId, []);
  }

  const history = histories.get(userId);
  const useSearch = searchModes.has(userId);

  // Режим поиска используется для одного запроса
  searchModes.delete(userId);

  await ctx.replyWithChatAction("typing");

  if (useSearch) {
    await ctx.reply("🔎 Ищу информацию в интернете...");
  }

  try {
    const requestBody = {
      model: "openai/gpt-oss-120b",

      messages: [
        {
          role: "system",
          content:
            "Ты NEXUS AI — умный ИИ-помощник. " +
            "Отвечай простым русским языком. " +
            "Пиши кратко и понятно, обычно 2–5 предложений. " +
            "При поиске используй свежую информацию из интернета. " +
            "Указывай источники и ссылки, если они доступны. " +
            "Не выдумывай факты."
        },
        ...history,
        { role: "user", content: question }
      ],

      temperature: 0.7,
      max_completion_tokens: 2048
    };

    // Подключаем настоящий интернет-поиск
    if (useSearch) {
      requestBody.tools = [
        { type: "browser_search" }
      ];

      requestBody.tool_choice = "required";
      requestBody.reasoning_effort = "low";
    }

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Groq:", data);
      throw new Error("Ошибка Groq API");
    }

    const answer =
      data.choices?.[0]?.message?.content ||
      "Не удалось получить ответ.";

    history.push(
      { role: "user", content: question },
      { role: "assistant", content: answer }
    );

    while (history.length > 20) {
      history.shift();
    }

    for (let i = 0; i < answer.length; i += 4000) {
      await ctx.reply(answer.slice(i, i + 4000), {
        link_preview_options: { is_disabled: true }
      });
    }

  } catch (error) {
    console.error(error);
    await ctx.reply(
      "⚠️ Не удалось получить ответ. Попробуй ещё раз."
    );
  }
});

// Webhook
const handleUpdate = webhookCallback(bot, "http");

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });
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
