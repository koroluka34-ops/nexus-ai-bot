
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

function clearHistory(userId) {
  histories.delete(userId);
}

bot.command("start", async (ctx) => {
  searchModes.delete(ctx.from.id);

  await ctx.reply(
    "🚀 Добро пожаловать в NEXUS AI!\n\n" +
    "Твой персональный ИИ-помощник.\n" +
    "Выбери действие 👇",
    { reply_markup: mainMenu() }
  );
});

bot.command("menu", async (ctx) => {
  await ctx.reply("🏠 Главное меню NEXUS AI", {
    reply_markup: mainMenu()
  });
});

bot.command("reset", async (ctx) => {
  clearHistory(ctx.from.id);
  searchModes.delete(ctx.from.id);
  await ctx.reply("🧹 История диалога очищена!");
});

bot.callbackQuery("menu_chat", async (ctx) => {
  searchModes.delete(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply("💬 Обычный чат включён!");
});

bot.callbackQuery("menu_search", async (ctx) => {
  searchModes.add(ctx.from.id);
  await ctx.answerCallbackQuery();

  await ctx.reply(
    "🌐 Поиск в интернете включён!\n\n" +
    "Каждый вопрос будет проверяться через интернет.\n" +
    "Для обычного общения нажми «Общение»."
  );
});

bot.callbackQuery("menu_features", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.reply(
    "🧠 Возможности NEXUS AI:\n\n" +
    "💬 Общение и ответы на вопросы\n" +
    "🌐 Поиск актуальной информации\n" +
    "📚 Объяснение сложных тем\n" +
    "✍️ Создание текстов\n" +
    "💻 Программирование\n" +
    "🌍 Переводы\n" +
    "🧮 Решение задач"
  );
});

bot.callbackQuery("menu_reset", async (ctx) => {
  clearHistory(ctx.from.id);
  searchModes.delete(ctx.from.id);

  await ctx.answerCallbackQuery({
    text: "Память очищена!"
  });

  await ctx.reply("🧹 История очищена!", {
    reply_markup: mainMenu()
  });
});

bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const question = ctx.message.text;
  const useSearch = searchModes.has(userId);

  if (!histories.has(userId)) {
    histories.set(userId, []);
  }

  const history = histories.get(userId);

  await ctx.replyWithChatAction("typing");

  let statusMessage;

  if (useSearch) {
    statusMessage = await ctx.reply(
      "🔎 Ищу информацию и проверяю источники..."
    );
  }

  try {
    const today = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Kyiv",
      dateStyle: "long"
    }).format(new Date());

    const systemPrompt =
      `Сегодня ${today}. Ты NEXUS AI — универсальный ИИ-помощник.\n\n` +
      "Ты помогаешь с любыми темами: технологии, игры, программирование, " +
      "учёба, наука, история, новости и повседневная жизнь.\n\n" +
      "ОБЩИЕ ПРАВИЛА:\n" +
      "1. Всегда отвечай понятным русским языком.\n" +
      "2. Обычно отвечай кратко, в 2-5 предложениях.\n" +
      "3. Не используй таблицы без просьбы пользователя.\n" +
      "4. Учитывай предыдущий разговор и уточнения пользователя.\n" +
      "5. Не выдумывай факты, даты, версии, ссылки и события.\n" +
      "6. Если не знаешь ответа, честно скажи об этом.\n" +
      "7. Не ограничивай себя одной тематикой.\n\n" +

      (useSearch
        ? "ПРАВИЛА ИНТЕРНЕТ-ПОИСКА:\n" +
          "1. Используй результаты browser_search для ответа.\n" +
          "2. Не используй свои старые знания вместо свежих результатов поиска.\n" +
          "3. Проверяй даты публикаций и актуальность информации.\n" +
          "4. Отдавай предпочтение официальным сайтам и первоисточникам.\n" +
          "5. Не придумывай названия сайтов, URL и источники.\n" +
          "6. Подкрепляй факты маркерами цитирования из результатов поиска " +
          "в оригинальном формате, например 〖1†L1-L5〗.\n" +
          "7. Если источники не подтверждают информацию, прямо сообщи об этом.\n" +
          "8. Если поиск не дал достоверного результата, не угадывай.\n" +
          "9. Уточняющие вопросы тоже проверяй новым поиском.\n" +
          "10. Не выдавай предположения за подтверждённые факты.\n"
        : "");

    const requestBody = {
      model: "openai/gpt-oss-120b",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        ...history,
        {
          role: "user",
          content: question
        }
      ],
      temperature: 0.2,
      max_completion_tokens: 2048
    };

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
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(120000)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Groq API error:", data);
      throw new Error("Ошибка Groq API");
    }

    const answer =
      data.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      throw new Error("Groq вернул пустой ответ");
    }

    // Защита: не выдаём непроверенный ответ как результат поиска.
    if (useSearch) {
      const hasCitations =
        /〖\d+†L\d+(?:-L\d+)?〗/.test(answer);

      if (!hasCitations) {
        console.warn(
          "Search response has no citation markers."
        );

        if (statusMessage) {
          await ctx.api.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            "⚠️ Не удалось получить ответ с подтверждающими источниками.\n\n" +
            "Я не буду придумывать новости или ссылки. Попробуй повторить запрос."
          );
        }

        return;
      }
    }

    history.push(
      { role: "user", content: question },
      { role: "assistant", content: answer }
    );

    while (history.length > 20) {
      history.shift();
    }

    if (statusMessage) {
      await ctx.api.deleteMessage(
        ctx.chat.id,
        statusMessage.message_id
      ).catch(() => {});
    }

    for (let i = 0; i < answer.length; i += 4000) {
      await ctx.reply(answer.slice(i, i + 4000), {
        link_preview_options: {
          is_disabled: true
        }
      });
    }

  } catch (error) {
    console.error("NEXUS AI error:", error);

    if (statusMessage) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        "⚠️ Не удалось выполнить поиск или получить ответ.\n\n" +
        "Попробуй ещё раз немного позже."
      ).catch(() => {});
    } else {
      await ctx.reply(
        "⚠️ Не удалось получить ответ. Попробуй ещё раз."
      );
    }
  }
});

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
      console.error("Webhook error:", error);

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
