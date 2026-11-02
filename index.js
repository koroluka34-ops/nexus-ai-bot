
require("dotenv").config();

const {
  Bot,
  InlineKeyboard,
  InputFile
} = require("grammy");

const http = require("http");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { EdgeTTS } = require("node-edge-tts");

// ==================================================
// NEXUS AI
// ==================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const PORT = process.env.PORT || 10000;
const WEBHOOK_PATH = "/telegram";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN не настроен!");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

const MAX_HISTORY = 8;
const MAX_OUTPUT = 900;

const histories = new Map();
const busyUsers = new Set();
const searchUsers = new Set();
const voiceUsers = new Set();

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

// ==================================================
// МЕНЮ
// ==================================================

function mainMenu() {
  return new InlineKeyboard()
    .text("💬 Общение с ИИ", "menu_chat")
    .text("🌐 Поиск", "menu_search")
    .row()
    .text("🖼 Генерация картинок", "menu_image")
    .text("🔊 Голос", "menu_voice")
    .row()
    .text("ℹ️ Возможности", "menu_features")
    .text("🔄 Сброс памяти", "menu_reset");
}

// ==================================================
// ИСТОРИЯ
// ==================================================

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

// ==================================================
// ОШИБКИ API
// ==================================================

function errorText(data) {
  if (data?.errors?.length) {
    return data.errors.map(e => e.message).join("; ");
  }

  return (
    data?.error?.message ||
    data?.message ||
    JSON.stringify(data)
  );
}

// ==================================================
// GROQ
// ==================================================

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
        Authorization: `Bearer ${GROQ_API_KEY}`,
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

// ==================================================
// OPENROUTER
// ==================================================

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
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
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

// ==================================================
// ЕДИНЫЙ ИИ
// ==================================================

async function askAI(userId, question, searchMode = false) {
  const history = getHistory(userId);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    {
      role: "user",
      content: searchMode
        ? `Найди информацию в интернете и ответь: ${question}`
        : question
    }
  ];

  let answer;
  let provider;

  try {
    answer = await askGroq(messages, searchMode);
    provider = "Groq";
  } catch (groqError) {
    console.error("Groq:", groqError.message);

    try {
      answer = await askOpenRouter(messages, searchMode);
      provider = "OpenRouter";
    } catch (openRouterError) {
      console.error("OpenRouter:", openRouterError.message);

      throw new Error(
        "Оба ИИ-провайдера сейчас недоступны.\n\n" +
        "Groq: " + groqError.message + "\n\n" +
        "OpenRouter: " + openRouterError.message
      );
    }
  }

  addHistory(userId, "user", question);
  addHistory(userId, "assistant", answer);

  return { answer, provider };
}

// ==================================================
// ГЕНЕРАЦИЯ ИЗОБРАЖЕНИЙ — CLOUDFLARE FLUX
// ==================================================

async function generateImage(prompt) {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    throw new Error("Cloudflare не настроен в Render Environment");
  }

  if (!prompt || prompt.length > 1800) {
    throw new Error("Описание картинки должно быть от 1 до 1800 символов");
  }

  const url =
    `https://api.cloudflare.com/client/v4/accounts/` +
    `${CLOUDFLARE_ACCOUNT_ID}/ai/run/` +
    `@cf/black-forest-labs/flux-1-schnell`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt,
      steps: 4
    }),
    signal: AbortSignal.timeout(120000)
  });

  const data = await response.json();

  if (!response.ok || data.success === false) {
    throw new Error(errorText(data));
  }

  let imageBase64 =
    data.result?.image ||
    data.result?.data?.[0]?.b64_json;

  if (!imageBase64) {
    throw new Error("Cloudflare не вернул изображение");
  }

  imageBase64 = imageBase64.replace(
    /^data:image\/[^;]+;base64,/,
    ""
  );

  return Buffer.from(imageBase64, "base64");
}

// ==================================================
// РАСПОЗНАВАНИЕ ГОЛОСА — GROQ WHISPER
// ==================================================

async function transcribeVoice(ctx) {
  if (!GROQ_API_KEY) {
    throw new Error("Для распознавания речи нужен Groq API key");
  }

  const voice = ctx.message.voice;

  if (voice.file_size && voice.file_size > 24 * 1024 * 1024) {
    throw new Error("Голосовое слишком большое. Максимум 24 МБ.");
  }

  const file = await ctx.api.getFile(voice.file_id);

  if (!file.file_path) {
    throw new Error("Не удалось получить файл голосового");
  }

  const fileUrl =
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

  const audioResponse = await fetch(fileUrl, {
    signal: AbortSignal.timeout(60000)
  });

  if (!audioResponse.ok) {
    throw new Error("Не удалось скачать голосовое сообщение");
  }

  const audioBuffer = Buffer.from(
    await audioResponse.arrayBuffer()
  );

  const form = new FormData();

  form.append(
    "file",
    new Blob([audioBuffer], { type: "audio/ogg" }),
    "voice.ogg"
  );

  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "json");

  const response = await fetch(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`
      },
      body: form,
      signal: AbortSignal.timeout(90000)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(errorText(data));
  }

  if (!data.text) {
    throw new Error("Не удалось распознать речь");
  }

  return data.text.trim();
}

// ==================================================
// ОЗВУЧКА ТЕКСТА — EDGE TTS
// ==================================================

async function makeSpeech(text) {
  const cleanText = String(text || "")
    .replace(/[*_`#]/g, "")
    .trim()
    .slice(0, 1500);

  if (!cleanText) {
    throw new Error("Нет текста для озвучивания");
  }

  const filename = path.join(
    os.tmpdir(),
    `nexus-${crypto.randomUUID()}.mp3`
  );

  try {
    const tts = new EdgeTTS({
      voice: "ru-RU-SvetlanaNeural",
      lang: "ru-RU",
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      timeout: 45000
    });

    await tts.ttsPromise(cleanText, filename);

    return await fs.readFile(filename);
  } finally {
    await fs.unlink(filename).catch(() => {});
  }
}

async function sendSpeech(ctx, text) {
  const audio = await makeSpeech(text);

  await ctx.replyWithAudio(
    new InputFile(audio, "nexus-ai.mp3"),
    {
      title: "NEXUS AI",
      performer: "NEXUS AI"
    }
  );
}

// ==================================================
// ОТПРАВКА ОТВЕТА ИИ
// ==================================================

async function sendLongMessage(ctx, text) {
  const maxLength = 3900;

  for (let i = 0; i < text.length; i += maxLength) {
    await ctx.reply(text.slice(i, i + maxLength), {
      link_preview_options: { is_disabled: true }
    });
  }
}

async function deliverAnswer(ctx, userId, result) {
  await sendLongMessage(
    ctx,
    result.answer + "\n\n⚡ " + result.provider
  );

  if (voiceUsers.has(userId)) {
    try {
      await sendSpeech(ctx, result.answer);
    } catch (error) {
      console.error("TTS error:", error.message);
      await ctx.reply("⚠️ Не удалось озвучить этот ответ.");
    }
  }
}

// ==================================================
// ПОИСК КОМАНДЫ ГЕНЕРАЦИИ КАРТИНОК
// ==================================================

function extractImagePrompt(text) {
  const command = text.match(
    /^\/image(?:@\w+)?(?:\s+([\s\S]+))?$/i
  );

  if (command) {
    return {
      isImage: true,
      prompt: (command[1] || "").trim()
    };
  }

  const natural = text.match(
    /^(?:нарисуй|создай(?: мне)? картинку|создай(?: мне)? изображение|сгенерируй(?: мне)? картинку|сгенерируй(?: мне)? изображение)\s+([\s\S]+)/i
  );

  if (natural) {
    return {
      isImage: true,
      prompt: natural[1].trim()
    };
  }

  return { isImage: false };
}

// ==================================================
// КОМАНДА /IMAGE
// ==================================================

async function handleImage(ctx, prompt) {
  const userId = ctx.from.id;

  if (!prompt) {
    await ctx.reply(
      "🖼 Напиши описание картинки:\n\n" +
      "/image красивый дракон в горах, реалистичный стиль"
    );
    return;
  }

  if (busyUsers.has(userId)) {
    await ctx.reply("⏳ Подожди, я ещё обрабатываю предыдущий запрос.");
    return;
  }

  busyUsers.add(userId);

  const status = await ctx.reply(
    "🎨 Создаю изображение...\nЭто может занять некоторое время."
  );

  try {
    const image = await generateImage(prompt);

    await ctx.api.deleteMessage(
      ctx.chat.id,
      status.message_id
    ).catch(() => {});

    await ctx.replyWithPhoto(
      new InputFile(image, "nexus-image.jpg"),
      {
        caption: "🖼 Готово! Изображение создано через NEXUS AI."
      }
    );

  } catch (error) {
    console.error("Image error:", error.message);

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      "❌ Не удалось создать изображение:\n" + error.message
    ).catch(() => {});

  } finally {
    busyUsers.delete(userId);
  }
}

bot.command("image", async (ctx) => {
  await handleImage(ctx, String(ctx.match || "").trim());
});

// ==================================================
// START / MENU / STATUS
// ==================================================

bot.command("start", async (ctx) => {
  searchUsers.delete(ctx.from.id);

  await ctx.reply(
    "👋 Привет! Я NEXUS AI.\n\n" +
    "Я универсальный ИИ-помощник.\n\n" +
    "💬 Общение с ИИ\n" +
    "🌐 Поиск информации\n" +
    "🖼 Создание изображений\n" +
    "🎙 Распознавание голосовых\n" +
    "🔊 Озвучивание ответов\n\n" +
    "Выбери нужную функцию:",
    { reply_markup: mainMenu() }
  );
});

bot.command("menu", async (ctx) => {
  await ctx.reply("Меню NEXUS AI:", {
    reply_markup: mainMenu()
  });
});

bot.command("status", async (ctx) => {
  await ctx.reply(
    "🤖 NEXUS AI — статус\n\n" +
    "Telegram: ✅ Подключён\n" +
    "Groq: " + (GROQ_API_KEY ? "✅ Настроен" : "❌ Не настроен") + "\n" +
    "OpenRouter: " + (OPENROUTER_API_KEY ? "✅ Настроен" : "❌ Не настроен") + "\n" +
    "Cloudflare: " +
    (CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN
      ? "✅ Настроен"
      : "❌ Не настроен") + "\n" +
    "Edge TTS: ✅ Включён в код\n\n" +
    "Генерация картинок: " +
    (CLOUDFLARE_API_TOKEN ? "✅" : "❌") + "\n" +
    "Распознавание голосовых: " +
    (GROQ_API_KEY ? "✅" : "❌") + "\n" +
    "Голосовые ответы: " +
    (voiceUsers.has(ctx.from.id) ? "🔊 Включены" : "🔇 Выключены")
  );
});

bot.command("reset", async (ctx) => {
  histories.delete(ctx.from.id);
  searchUsers.delete(ctx.from.id);

  await ctx.reply("🧹 Память диалога очищена.");
});

// ==================================================
// ГОЛОСОВОЙ РЕЖИМ
// ==================================================

bot.command("voice", async (ctx) => {
  const userId = ctx.from.id;

  if (voiceUsers.has(userId)) {
    voiceUsers.delete(userId);

    await ctx.reply(
      "🔇 Голосовые ответы выключены.\nТеперь я буду отвечать текстом."
    );
  } else {
    voiceUsers.add(userId);

    await ctx.reply(
      "🔊 Голосовые ответы включены!\nТеперь после текстового ответа я буду отправлять озвучку."
    );
  }
});

bot.command("voice_on", async (ctx) => {
  voiceUsers.add(ctx.from.id);
  await ctx.reply("🔊 Голосовые ответы включены.");
});

bot.command("voice_off", async (ctx) => {
  voiceUsers.delete(ctx.from.id);
  await ctx.reply("🔇 Голосовые ответы выключены.");
});

// ==================================================
// ОЗВУЧИТЬ ОТДЕЛЬНЫЙ ТЕКСТ
// ==================================================

bot.command("say", async (ctx) => {
  const text = String(ctx.match || "").trim();

  if (!text) {
    await ctx.reply(
      "🔊 Напиши текст для озвучивания:\n\n/say Привет! Это NEXUS AI."
    );
    return;
  }

  const status = await ctx.reply("🎙 Создаю аудио...");

  try {
    const audio = await makeSpeech(text);

    await ctx.api.deleteMessage(
      ctx.chat.id,
      status.message_id
    ).catch(() => {});

    await ctx.replyWithAudio(
      new InputFile(audio, "nexus-ai.mp3"),
      {
        title: "NEXUS AI",
        performer: "NEXUS AI"
      }
    );

  } catch (error) {
    console.error("Speech error:", error.message);

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      "❌ Ошибка озвучивания:\n" + error.message
    ).catch(() => {});
  }
});

// ==================================================
// КНОПКИ МЕНЮ
// ==================================================

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
    "🌐 Режим поиска включён.\nНапиши, что нужно найти."
  );
});

bot.callbackQuery("menu_image", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.reply(
    "🖼 Генерация изображений\n\n" +
    "Напиши:\n" +
    "/image описание картинки\n\n" +
    "Например:\n" +
    "/image футуристический город ночью, реалистичный стиль"
  );
});

bot.callbackQuery("menu_voice", async (ctx) => {
  const userId = ctx.from.id;

  if (voiceUsers.has(userId)) {
    voiceUsers.delete(userId);

    await ctx.answerCallbackQuery({
      text: "Голосовые ответы выключены"
    });

    await ctx.reply("🔇 Теперь ответы будут только текстовыми.");

  } else {
    voiceUsers.add(userId);

    await ctx.answerCallbackQuery({
      text: "Голосовые ответы включены"
    });

    await ctx.reply(
      "🔊 Теперь после текстовых ответов я буду отправлять озвучку."
    );
  }
});

bot.callbackQuery("menu_features", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.reply(
    "✨ Возможности NEXUS AI:\n\n" +
    "💬 Общение с искусственным интеллектом\n" +
    "🌐 Поиск информации\n" +
    "🖼 Генерация изображений — /image\n" +
    "🎙 Распознавание голосовых сообщений\n" +
    "🔊 Озвучка текста — /say\n" +
    "🔊 Автоматическая озвучка — /voice\n" +
    "🧠 Память диалога\n" +
    "🔄 Переключение Groq / OpenRouter\n\n" +
    "Команды:\n" +
    "/start — запуск\n" +
    "/menu — меню\n" +
    "/status — состояние\n" +
    "/reset — очистить память\n" +
    "/voice — включить или выключить голос\n" +
    "/say — озвучить текст\n" +
    "/image — создать картинку"
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

// ==================================================
// ОБРАБОТКА ГОЛОСОВЫХ СООБЩЕНИЙ
// ==================================================

bot.on("message:voice", async (ctx) => {
  const userId = ctx.from.id;

  if (busyUsers.has(userId)) {
    await ctx.reply("⏳ Подожди, я ещё обрабатываю предыдущий запрос.");
    return;
  }

  busyUsers.add(userId);

  const status = await ctx.reply("🎙 Распознаю голосовое сообщение...");

  try {
    const transcript = await transcribeVoice(ctx);

    await ctx.reply(
      "📝 Я распознал:\n" + transcript
    );

    const result = await askAI(
      userId,
      transcript,
      false
    );

    await ctx.api.deleteMessage(
      ctx.chat.id,
      status.message_id
    ).catch(() => {});

    await deliverAnswer(ctx, userId, result);

  } catch (error) {
    console.error("Voice error:", error.message);

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      "❌ Не удалось обработать голосовое:\n" + error.message
    ).catch(() => {});

  } finally {
    busyUsers.delete(userId);
  }
});

// ==================================================
// ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ
// ==================================================

bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const question = ctx.message.text.trim();

  if (!question || question.startsWith("/")) {
    return;
  }

  // Проверяем запрос на изображение

  const imageRequest = extractImagePrompt(question);

  if (imageRequest.isImage) {
    await handleImage(ctx, imageRequest.prompt);
    return;
  }

  if (busyUsers.has(userId)) {
    await ctx.reply("⏳ Подожди, я ещё отвечаю на предыдущий вопрос.");
    return;
  }

  busyUsers.add(userId);

  const searchMode = searchUsers.has(userId);

  if (searchMode) {
    searchUsers.delete(userId);
  }

  const status = await ctx.reply(
    searchMode ? "🌐 Ищу информацию..." : "🤔 Думаю..."
  );

  try {
    const result = await askAI(
      userId,
      question,
      searchMode
    );

    await ctx.api.deleteMessage(
      ctx.chat.id,
      status.message_id
    ).catch(() => {});

    await deliverAnswer(ctx, userId, result);

  } catch (error) {
    console.error("AI error:", error.message);

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      "❌ " + error.message
    ).catch(() => {});

  } finally {
    busyUsers.delete(userId);
  }
});

// ==================================================
// WEBHOOK / RENDER
// ==================================================

async function start() {
  await bot.init();

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, {
        "Content-Type": "text/plain"
      });

      return res.end("NEXUS AI is running");
    }

    if (req.method === "POST" && req.url === WEBHOOK_PATH) {
      let body = "";

      req.on("data", chunk => {
        body += chunk;

        if (body.length > 10 * 1024 * 1024) {
          req.destroy();
        }
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
    console.log("================================");
    console.log("NEXUS AI запущен!");
    console.log("Groq:", Boolean(GROQ_API_KEY));
    console.log("OpenRouter:", Boolean(OPENROUTER_API_KEY));
    console.log("Cloudflare:", Boolean(CLOUDFLARE_API_TOKEN));
    console.log("Edge TTS: enabled");
    console.log("================================");

    const renderUrl = process.env.RENDER_EXTERNAL_URL;

    if (renderUrl) {
      try {
        await bot.api.setWebhook(
          `${renderUrl}${WEBHOOK_PATH}`
        );

        console.log("Telegram webhook connected!");
      } catch (error) {
        console.error("Webhook error:", error.message);
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
