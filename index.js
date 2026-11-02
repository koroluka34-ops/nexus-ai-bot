
require("dotenv").config();

const { Bot, InlineKeyboard, InputFile } = require("grammy");
const { EdgeTTS } = require("node-edge-tts");
const http = require("http");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// =====================================================
// NEXUS AI — CONFIG
// =====================================================

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

// =====================================================
// STATE
// =====================================================

const MAX_HISTORY = 8;
const MAX_OUTPUT = 900;

const histories = new Map();
const busyUsers = new Set();
const searchUsers = new Set();
const voiceUsers = new Set();
const imagePendingUsers = new Set();

// =====================================================
// SYSTEM PROMPT
// =====================================================

const SYSTEM_PROMPT = `
Ты NEXUS AI — универсальный ИИ-помощник.

Правила:
- Отвечай на русском языке.
- Пиши кратко и понятно.
- Обычно используй 3–6 предложений.
- Не повторяй вопрос пользователя.
- Не выдумывай факты, новости и источники.
- Если не знаешь — честно скажи.
- Не используй большие таблицы.
- Не ограничивайся тематикой Minecraft.
`;

// =====================================================
// MENU
// =====================================================

function mainMenu() {
  return new InlineKeyboard()
    .text("💬 Общение с ИИ", "menu_chat")
    .text("🌐 Поиск", "menu_search")
    .row()
    .text("🖼 Создать картинку", "menu_image")
    .text("🔊 Голос", "menu_voice")
    .row()
    .text("ℹ️ Возможности", "menu_features")
    .text("🔄 Сброс памяти", "menu_reset");
}

// =====================================================
// HISTORY
// =====================================================

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

// =====================================================
// API ERROR
// =====================================================

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

// =====================================================
// GROQ AI
// =====================================================

async function askGroq(messages, searchMode = false) {
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

// =====================================================
// OPENROUTER AI
// =====================================================

async function askOpenRouter(messages) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OpenRouter API key не настроен");
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
      body: JSON.stringify({
        model: "openrouter/free",
        messages,
        max_tokens: MAX_OUTPUT,
        temperature: 0.7
      }),
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

// =====================================================
// MAIN AI
// =====================================================

async function askAI(userId, question, searchMode = false) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...getHistory(userId),
    {
      role: "user",
      content: searchMode
        ? "Найди информацию в интернете. Не выдумывай источники. Вопрос: " + question
        : question
    }
  ];

  let answer;
  let provider;

  try {
    answer = await askGroq(messages, searchMode);
    provider = "Groq";
  } catch (error) {
    console.error("Groq:", error.message);

    try {
      if (searchMode) {
        throw new Error("Веб-поиск Groq временно недоступен");
      }

      answer = await askOpenRouter(messages);
      provider = "OpenRouter";

    } catch (fallbackError) {
      throw new Error(
        "ИИ сейчас недоступен.\n\n" +
        "Groq: " + error.message + "\n\n" +
        "OpenRouter: " + fallbackError.message
      );
    }
  }

  addHistory(userId, "user", question);
  addHistory(userId, "assistant", answer);

  return { answer, provider };
}

// =====================================================
// TRANSLATE IMAGE PROMPT
// Russian / Ukrainian -> English
// =====================================================

async function translateImagePrompt(prompt) {
  // English prompts are sent without changes.
  if (!/[А-Яа-яЁёІіЇїЄєҐґ]/.test(prompt)) {
    return prompt;
  }

  const messages = [
    {
      role: "system",
      content:
        "Translate the user's image description into clear English " +
        "for the FLUX text-to-image model. Preserve the exact subject, " +
        "objects, actions, setting, style and composition. " +
        "Do not invent additional objects or scenes. " +
        "Return ONLY the English prompt, without explanations."
    },
    {
      role: "user",
      content: prompt
    }
  ];

  try {
    const translated = await askGroq(messages, false);
    return translated.trim().slice(0, 2048);
  } catch (error) {
    console.log("Image translation Groq:", error.message);
  }

  try {
    const translated = await askOpenRouter(messages);
    return translated.trim().slice(0, 2048);
  } catch (error) {
    console.log("Image translation OpenRouter:", error.message);
  }

  // If translation is unavailable, preserve the original prompt.
  return prompt.slice(0, 2048);
}

// =====================================================
// CLOUDFLARE FLUX IMAGE GENERATION
// =====================================================

function isImageBuffer(buffer, contentType = "") {
  if (!buffer || buffer.length < 1000) {
    return false;
  }

  const isJpeg =
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;

  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;

  const isWebp =
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP";

  return (
    isJpeg ||
    isPng ||
    isWebp ||
    contentType.startsWith("image/")
  );
}

function decodeBase64Image(value) {
  if (typeof value !== "string") {
    return null;
  }

  const clean = value.replace(
    /^data:image\/[^;]+;base64,/i,
    ""
  ).trim();

  if (!clean || clean.length < 100) {
    return null;
  }

  return Buffer.from(clean, "base64");
}

async function generateImage(prompt) {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    throw new Error("Cloudflare не настроен в Render Environment");
  }

  if (!prompt || prompt.length > 2048) {
    throw new Error("Описание должно содержать от 1 до 2048 символов");
  }

  const url =
    "https://api.cloudflare.com/client/v4/accounts/" +
    CLOUDFLARE_ACCOUNT_ID +
    "/ai/run/@cf/black-forest-labs/flux-1-schnell";

  console.log("FLUX PROMPT:", prompt);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt: prompt,
      steps: 8
    }),
    signal: AbortSignal.timeout(120000)
  });

  const contentType =
    response.headers.get("content-type") || "";

  const raw = Buffer.from(
    await response.arrayBuffer()
  );

  if (!response.ok) {
    const errorBody = raw.toString("utf8");

    let message = errorBody;

    try {
      message = errorText(JSON.parse(errorBody));
    } catch {}

    throw new Error(
      `Cloudflare HTTP ${response.status}: ${message.slice(0, 800)}`
    );
  }

  // Some image responses can be returned as raw image bytes.
  if (isImageBuffer(raw, contentType)) {
    return {
      buffer: raw,
      mime: contentType.startsWith("image/")
        ? contentType.split(";")[0]
        : "image/jpeg"
    };
  }

  // Other responses use a JSON envelope with Base64 image.
  let data;

  try {
    data = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(
      "Cloudflare вернул неизвестный формат ответа. " +
      "Content-Type: " + contentType
    );
  }

  if (data.success === false) {
    throw new Error(errorText(data));
  }

  const base64 =
    data?.result?.image ||
    data?.result?.image_base64 ||
    data?.result?.data?.[0]?.b64_json ||
    data?.image;

  const imageBuffer = decodeBase64Image(base64);

  if (!imageBuffer || !isImageBuffer(imageBuffer)) {
    throw new Error(
      "Модель не вернула настоящее изображение. " +
      "Проверьте ответ Cloudflare в логах Render."
    );
  }

  return {
    buffer: imageBuffer,
    mime: "image/jpeg"
  };
}

// =====================================================
// IMAGE HANDLER
// =====================================================

async function handleImage(ctx, originalPrompt) {
  const userId = ctx.from.id;
  const prompt = String(originalPrompt || "").trim();

  if (!prompt) {
    await ctx.reply(
      "🖼 Напиши описание картинки:\n\n" +
      "/image кот в космосе, реалистичный стиль"
    );
    return;
  }

  if (prompt.length > 1800) {
    await ctx.reply("Описание слишком длинное. Максимум 1800 символов.");
    return;
  }

  if (busyUsers.has(userId)) {
    await ctx.reply("⏳ Подожди, предыдущий запрос ещё обрабатывается.");
    return;
  }

  busyUsers.add(userId);

  const status = await ctx.reply(
    "🎨 Создаю изображение по твоему описанию:\n\n" +
    prompt.slice(0, 700)
  );

  try {
    // Translate Russian/Ukrainian prompt for FLUX.
    const englishPrompt = await translateImagePrompt(prompt);

    console.log("Original image prompt:", prompt);
    console.log("Translated image prompt:", englishPrompt);

    const result = await generateImage(englishPrompt);

    const extension =
      result.mime === "image/png" ? "png" :
      result.mime === "image/webp" ? "webp" : "jpg";

    await ctx.api.deleteMessage(
      ctx.chat.id,
      status.message_id
    ).catch(() => {});

    await ctx.replyWithPhoto(
      new InputFile(
        result.buffer,
        `nexus-image.${extension}`
      ),
      {
        caption:
          "🖼 Изображение создано!\n\n" +
          "📝 Твой запрос: " + prompt.slice(0, 700)
      }
    );

  } catch (error) {
    console.error("IMAGE ERROR:", error);

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      "❌ Не удалось создать изображение:\n\n" +
      String(error.message || error).slice(0, 2500)
    ).catch(() => {});

  } finally {
    busyUsers.delete(userId);
  }
}

// =====================================================
// IMAGE COMMAND
// =====================================================

bot.command("image", async (ctx) => {
  imagePendingUsers.delete(ctx.from.id);

  const text = ctx.message?.text || "";

  const prompt = text
    .replace(/^\/image(?:@\w+)?/i, "")
    .trim();

  await handleImage(ctx, prompt);
});

// =====================================================
// VOICE RECOGNITION — GROQ WHISPER
// =====================================================

async function transcribeVoice(ctx) {
  if (!GROQ_API_KEY) {
    throw new Error("Groq API key не настроен");
  }

  const voice = ctx.message.voice;

  if (voice.file_size && voice.file_size > 20 * 1024 * 1024) {
    throw new Error("Голосовое слишком большое. Максимум 20 МБ.");
  }

  const file = await ctx.api.getFile(voice.file_id);

  if (!file.file_path) {
    throw new Error("Не удалось получить аудиофайл");
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

// =====================================================
// TEXT TO SPEECH — EDGE TTS
// =====================================================

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

    const audio = await fs.readFile(filename);

    if (!audio.length) {
      throw new Error("TTS вернул пустой аудиофайл");
    }

    return audio;

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

// =====================================================
// SEND LONG TEXT
// =====================================================

async function sendLongMessage(ctx, text) {
  const maxLength = 3900;

  for (let i = 0; i < text.length; i += maxLength) {
    await ctx.reply(text.slice(i, i + maxLength), {
      link_preview_options: { is_disabled: true }
    });
  }
}

// =====================================================
// DELIVER AI ANSWER
// =====================================================

async function deliverAnswer(ctx, userId, result) {
  await sendLongMessage(
    ctx,
    result.answer + "\n\n⚡ " + result.provider
  );

  if (voiceUsers.has(userId)) {
    try {
      await sendSpeech(ctx, result.answer);
    } catch (error) {
      console.error("TTS ERROR:", error.message);
      await ctx.reply("⚠️ Не удалось озвучить ответ.");
    }
  }
}

// =====================================================
// IMAGE PROMPT DETECTOR
// =====================================================

function extractImagePrompt(text) {
  const natural = text.match(
    /^(?:нарисуй|создай(?: мне)? картинку|создай(?: мне)? изображение|сгенерируй(?: мне)? картинку|сгенерируй(?: мне)? изображение)\s+([\s\S]+)/i
  );

  if (natural) {
    return {
      isImage: true,
      prompt: natural[1].trim()
    };
  }

  return {
    isImage: false,
    prompt: ""
  };
}

// =====================================================
// BASIC COMMANDS
// =====================================================

bot.command("start", async (ctx) => {
  imagePendingUsers.delete(ctx.from.id);
  searchUsers.delete(ctx.from.id);

  await ctx.reply(
    "👋 Привет! Я NEXUS AI.\n\n" +
    "💬 Общение с ИИ\n" +
    "🌐 Поиск информации\n" +
    "🖼 Генерация изображений\n" +
    "🎙 Распознавание голосовых\n" +
    "🔊 Озвучивание ответов\n\n" +
    "Выбери функцию:",
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
  imagePendingUsers.delete(ctx.from.id);

  await ctx.reply("🧹 Память диалога очищена.");
});

bot.command("status", async (ctx) => {
  await ctx.reply(
    "🤖 NEXUS AI — статус\n\n" +
    "Telegram: ✅ Подключён\n" +
    "Groq: " + (GROQ_API_KEY ? "✅ Настроен" : "❌ Нет ключа") + "\n" +
    "OpenRouter: " + (OPENROUTER_API_KEY ? "✅ Настроен" : "❌ Нет ключа") + "\n" +
    "Cloudflare: " +
    (CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN
      ? "✅ Настроен"
      : "❌ Не настроен") + "\n" +
    "Генерация изображений: " +
    (CLOUDFLARE_API_TOKEN ? "✅" : "❌") + "\n" +
    "Распознавание голоса: " +
    (GROQ_API_KEY ? "✅" : "❌") + "\n" +
    "Озвучивание: ✅ Edge TTS\n" +
    "Голосовой режим: " +
    (voiceUsers.has(ctx.from.id) ? "🔊 Включён" : "🔇 Выключен")
  );
});

// =====================================================
// VOICE MODE COMMANDS
// =====================================================

bot.command("voice", async (ctx) => {
  const userId = ctx.from.id;

  if (voiceUsers.has(userId)) {
    voiceUsers.delete(userId);
    await ctx.reply("🔇 Голосовые ответы выключены.");
  } else {
    voiceUsers.add(userId);
    await ctx.reply("🔊 Голосовые ответы включены.");
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

// =====================================================
// SAY COMMAND
// =====================================================

bot.command("say", async (ctx) => {
  const text = String(ctx.match || "").trim();

  if (!text) {
    await ctx.reply(
      "Напиши текст для озвучивания:\n\n" +
      "/say Привет! Это NEXUS AI."
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
    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      "❌ Ошибка озвучивания:\n" + error.message
    ).catch(() => {});
  }
});

// =====================================================
// MENU CALLBACKS
// =====================================================

bot.callbackQuery("menu_chat", async (ctx) => {
  imagePendingUsers.delete(ctx.from.id);
  searchUsers.delete(ctx.from.id);

  await ctx.answerCallbackQuery();

  await ctx.reply(
    "💬 Режим общения включён.\nЗадавай любой вопрос!"
  );
});

bot.callbackQuery("menu_search", async (ctx) => {
  imagePendingUsers.delete(ctx.from.id);
  searchUsers.add(ctx.from.id);

  await ctx.answerCallbackQuery();

  await ctx.reply(
    "🌐 Режим поиска включён.\nНапиши, что нужно найти."
  );
});

bot.callbackQuery("menu_image", async (ctx) => {
  searchUsers.delete(ctx.from.id);
  imagePendingUsers.add(ctx.from.id);

  await ctx.answerCallbackQuery();

  await ctx.reply(
    "🖼 Режим генерации включён!\n\n" +
    "Теперь просто напиши описание картинки.\n\n" +
    "Например:\n" +
    "Кот в космосе, в скафандре, Земля на заднем плане, фотореализм.\n\n" +
    "Также можно использовать команду:\n" +
    "/image кот в космосе"
  );
});

bot.callbackQuery("menu_voice", async (ctx) => {
  const userId = ctx.from.id;

  if (voiceUsers.has(userId)) {
    voiceUsers.delete(userId);

    await ctx.answerCallbackQuery({
      text: "Голос выключен"
    });

    await ctx.reply("🔇 Голосовые ответы выключены.");

  } else {
    voiceUsers.add(userId);

    await ctx.answerCallbackQuery({
      text: "Голос включён"
    });

    await ctx.reply("🔊 Голосовые ответы включены.");
  }
});

bot.callbackQuery("menu_features", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.reply(
    "✨ Возможности NEXUS AI:\n\n" +
    "💬 Общение с ИИ\n" +
    "🌐 Поиск информации — кнопка Поиск\n" +
    "🖼 Генерация изображений — /image\n" +
    "🎙 Распознавание голосовых сообщений\n" +
    "🔊 Озвучивание текста — /say\n" +
    "🔊 Автоматическая озвучка — /voice\n" +
    "🧠 Память диалога\n" +
    "🔄 Переключение Groq / OpenRouter\n\n" +
    "Команды:\n" +
    "/start — запуск\n" +
    "/menu — меню\n" +
    "/status — статус\n" +
    "/reset — очистить память\n" +
    "/image — создать изображение\n" +
    "/voice — включить или выключить голос\n" +
    "/say — озвучить текст"
  );
});

bot.callbackQuery("menu_reset", async (ctx) => {
  histories.delete(ctx.from.id);
  searchUsers.delete(ctx.from.id);
  imagePendingUsers.delete(ctx.from.id);

  await ctx.answerCallbackQuery({
    text: "Память очищена"
  });

  await ctx.reply("🧹 История диалога очищена.");
});

// =====================================================
// VOICE MESSAGE HANDLER
// =====================================================

bot.on("message:voice", async (ctx) => {
  const userId = ctx.from.id;

  if (busyUsers.has(userId)) {
    await ctx.reply("⏳ Подожди, предыдущий запрос ещё обрабатывается.");
    return;
  }

  busyUsers.add(userId);

  const status = await ctx.reply("🎙 Распознаю голосовое сообщение...");

  try {
    const transcript = await transcribeVoice(ctx);

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      "📝 Распознал:\n" + transcript
    ).catch(() => {});

    const result = await askAI(userId, transcript, false);

    await deliverAnswer(ctx, userId, result);

  } catch (error) {
    console.error("VOICE ERROR:", error.message);

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      "❌ Ошибка обработки голосового:\n" +
      String(error.message || error).slice(0, 2000)
    ).catch(() => {});

  } finally {
    busyUsers.delete(userId);
  }
});

// =====================================================
// TEXT MESSAGE HANDLER
// =====================================================

bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const question = ctx.message.text.trim();

  if (!question) return;

  // Commands are processed by bot.command handlers.
  if (question.startsWith("/")) return;

  // Image button mode: next normal text becomes image prompt.
  if (imagePendingUsers.has(userId)) {
    imagePendingUsers.delete(userId);
    await handleImage(ctx, question);
    return;
  }

  // Natural image request.
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
    console.error("AI ERROR:", error.message);

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      "❌ " + String(error.message || error).slice(0, 2500)
    ).catch(() => {});

  } finally {
    busyUsers.delete(userId);
  }
});

// =====================================================
// RENDER WEBHOOK SERVER
// =====================================================

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
    console.log("=================================");
    console.log("NEXUS AI started on port", PORT);
    console.log("Groq:", Boolean(GROQ_API_KEY));
    console.log("OpenRouter:", Boolean(OPENROUTER_API_KEY));
    console.log("Cloudflare:", Boolean(CLOUDFLARE_API_TOKEN));
    console.log("Edge TTS: enabled");
    console.log("=================================");

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
  console.error("STARTUP ERROR:", error);
  process.exit(1);
});
