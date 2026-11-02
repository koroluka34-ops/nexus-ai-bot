
require("dotenv").config();

const { Bot, InlineKeyboard } = require("grammy");
const http = require("http");

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const PORT = process.env.PORT || 10000;
const WEBHOOK_PATH = "/telegram";

if (!BOT_TOKEN) {
  console.error("ОШИБКА: BOT_TOKEN не задан в Render Environment");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

const MAX_HISTORY = 8;
const MAX_OUTPUT = 900;

const histories = new Map();
const busyUsers = new Set();
const searchUsers = new Set();

const SYSTEM_PROMPT = `
Ты NEXUS AI — универсальный ИИ-помощник.

ОБЯЗАТЕЛЬНО:
- Отвечай на русском языке.
- Пиши кратко и понятно.
- Обычно используй 3–6 предложений.
- Не растягивай ответы.
- Не повторяй вопрос пользователя.
- Не используй большие таблицы.
- Для поиска давай краткую выжимку и максимум 3 ссылки.
- Не выдумывай факты, новости и источники.
- Если не знаешь — честно скажи.
- Подробные инструкции давай только когда это необходимо.
- Не ограничивайся тематикой Minecraft.
`;

function getHistory(userId) {
  if (!histories.has(userId)) {
    histories.set(userId, []);
  }

  return histories.get(userId);
}

function addHistory(userId, role, content) {
  const history = getHistory(userId);

  history.push({ role, content });

  while (history.length > MAX_HISTORY * 2) {
    history.shift();
  }
}

function errorText(data) {
  return data?.error?.message ||
    data?.message ||
    JSON.stringify(data);
}

async function askGroq(messages, searchMode) {
  if (!GROQ_API_KEY) {
    throw new Error("Groq API key не настроен");
  }

  const body = {
    model: "openai/gpt-oss-120b",
    messages,
    max_completion_tokens: MAX_OUTPUT,
    temperature: 1,
    stream: false
  };

  if (searchMode) {
    body.tools = [{ type: "browser_search" }];
    body.tool_choice = "required";
    body.reasoning_effort = "low";
  }

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(errorText(data));
  }

  const answer = data?.choices?.[0]?.message?.content;

  if (!answer) {
    throw new Error("Groq не вернул ответ");
  }

  return answer;
}

async function askOpenRouter(messages, searchMode) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OpenRouter API key не настроен");
  }

  const body = {
    model: "openrouter/free",
    messages,
    max_tokens: MAX_OUTPUT,
    temperature: 0.7
  };

  if (searchMode) {
    body.plugins = [{ id: "web" }];
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://nexus-ai-bot-kt4w.onrender.com",
        "X-Title": "NEXUS AI"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(errorText(data));
  }

  const answer = data?.choices?.[0]?.message?.content;

  if (!answer) {
    throw new Error("OpenRouter не вернул ответ");
  }

  return answer;
}

async function askAI(userId, question, searchMode = false) {
  const history = getHistory(userId);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    {
      role: "user",
      content: searchMode
        ? `Найди информацию в интернете и ответь на вопрос: ${question}`
        : question
    }
  ];

  let answer;
  let provider;

  try {
    answer = await askGroq(messages, searchMode);
    provider = "Groq";
  } catch (groqError) {
    console.error("Groq error:", groqError.message);

    try {
      answer = await askOpenRouter(messages, searchMode);
      provider = "OpenRouter";
    } catch (openRouterError) {
      console.error("OpenRouter error:", openRouterError.message);

      throw new Error(
        "Сейчас оба ИИ-провайдера недоступны.\n\n" +
        "Groq: " + groqError.message + "\n\n" +
        "OpenRouter: " + openRouterError.message
      );
    }
  }

  addHistory(userId, "user", question);
  addHistory(userId, "assistant", answer);

  return { answer, provider };
}

async function sendLongMessage(ctx, text) {
  const maxLength = 3900;

  for (let i = 0; i < text.length; i += maxLength) {
    await ctx.reply(text.slice(i, i + maxLength), {
      link_preview_options: { is_disabled: true }
    });
  }
}

function mainMenu() {
  return new InlineKeyboard()
    .text("💬 Общение с ИИ", "menu_chat")
    .text("🌐 Поиск в интернете", "menu_search")
    .row()
    .text("ℹ️ Возможности", "menu_features")
    .text("🔄 Сбросить память", "menu_reset");
}

bot.command("start", async (ctx) => {
  searchUsers.delete(ctx.from.id);

  await ctx.reply(
    "👋 Привет! Я NEXUS AI.\n\n" +
    "Я универсальный ИИ-помощник. Могу отвечать на вопросы, " +
    "объяснять сложные темы, помогать с программированием и искать информацию в интернете.\n\n" +
    "Выбери нужный режим:",
    { reply_markup: mainMenu() }
  );
});

bot.command("menu", async (ctx) => {
  await ctx.reply("Меню NEXUS AI:", {
    reply_markup: mainMenu()
  });
});

bot.command("reset", async (ctx) => {
  histories.delete(ctx.from.id);
  searchUsers.delete(ctx.from.id);

  await ctx.reply("🧹 Память диалога очищена.");
});

bot.command("status", async (ctx) => {
  await ctx.reply(
    "🤖 NEXUS AI — статус\n\n" +
    "Telegram: ✅ Подключён\n" +
    "Groq: " + (GROQ_API_KEY ? "✅ Настроен" : "❌ Не настроен") + "\n" +
    "OpenRouter: " + (OPENROUTER_API_KEY ? "✅ Настроен" : "❌ Не настроен") + "\n\n" +
    "Автоматическое переключение: ✅\n" +
    "Режим поиска: 🌐 Доступен"
  );
});

bot.callbackQuery("menu_chat", async (ctx) => {
  searchUsers.delete(ctx.from.id);
  await ctx.answerCallbackQuery();

  await ctx.reply(
    "💬 Режим общения включён.\nЗадавай любой вопрос!"
  );
});

bot.callbackQuery("menu_search", async (ctx) => {
  searchUsers.add(ctx.from.id);
  await ctx.answerCallbackQuery();

  await ctx.reply(
    "🌐 Режим поиска включён.\n\n" +
    "Напиши, что нужно найти. Я попробую использовать интернет-поиск."
  );
});

bot.callbackQuery("menu_features", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.reply(
    "✨ Возможности NEXUS AI:\n\n" +
    "💬 Общение и ответы на вопросы\n" +
    "🌐 Поиск информации в интернете\n" +
    "💻 Помощь с программированием\n" +
    "🧠 Контекст текущего диалога\n" +
    "🔄 Автоматическое переключение Groq / OpenRouter\n\n" +
    "Команды:\n" +
    "/start — запуск\n" +
    "/menu — меню\n" +
    "/reset — очистить память\n" +
    "/status — статус бота"
  );
});

bot.callbackQuery("menu_reset", async (ctx) => {
  histories.delete(ctx.from.id);
  searchUsers.delete(ctx.from.id);

  await ctx.answerCallbackQuery({
    text: "Память очищена!"
  });

  await ctx.reply("🧹 История диалога удалена.");
});

bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const question = ctx.message.text.trim();

  if (!question || question.startsWith("/")) return;

  if (busyUsers.has(userId)) {
    await ctx.reply("⏳ Подожди, я ещё отвечаю на предыдущий вопрос.");
    return;
  }

  busyUsers.add(userId);

  const searchMode = searchUsers.has(userId);

  if (searchMode) {
    searchUsers.delete(userId);
  }

  const statusMessage = await ctx.reply(
    searchMode ? "🌐 Ищу информацию..." : "🤔 Думаю..."
  );

  try {
    const result = await askAI(userId, question, searchMode);

    await ctx.api.deleteMessage(
      ctx.chat.id,
      statusMessage.message_id
    ).catch(() => {});

    await sendLongMessage(
      ctx,
      result.answer + "\n\n⚡ " + result.provider
    );

  } catch (error) {
    console.error("AI error:", error.message);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      "❌ " + error.message
    ).catch(() => {});
  } finally {
    busyUsers.delete(userId);
  }
});

async function start() {
  await bot.init();

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("NEXUS AI is running");
    }

    if (req.method === "POST" && req.url === WEBHOOK_PATH) {
      let body = "";

      req.on("data", chunk => {
        body += chunk;
      });

      req.on("end", () => {
        res.writeHead(200);
        res.end("OK");

        try {
          const update = JSON.parse(body);

          bot.handleUpdate(update).catch(error => {
            console.error("Telegram update error:", error);
          });
        } catch (error) {
          console.error("Webhook parse error:", error);
        }
      });

      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, async () => {
    console.log(`NEXUS AI started on port ${PORT}`);
    console.log("Groq configured:", Boolean(GROQ_API_KEY));
    console.log("OpenRouter configured:", Boolean(OPENROUTER_API_KEY));

    const renderUrl = process.env.RENDER_EXTERNAL_URL;

    if (renderUrl) {
      try {
        await bot.api.setWebhook(
          `${renderUrl}${WEBHOOK_PATH}`
        );

        console.log("Telegram webhook connected!");
      } catch (error) {
        console.error("Webhook setup error:", error.message);
      }
    } else {
      console.log("RENDER_EXTERNAL_URL not found");
    }
  });
}

start().catch(error => {
  console.error("Startup error:", error);
  process.exit(1);
});
