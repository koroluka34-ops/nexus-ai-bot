// modules/astra-voice.js
// Custom Russian voice for NEXUS. Requires ELEVENLABS_API_KEY.
const fs = require("fs/promises");
const path = require("path");
const { InputFile } = require("grammy");

const API = "https://api.elevenlabs.io/v1";
const STATE_FILE = path.join(process.cwd(), "astra-voice.json");
const DESCRIPTION =
  "A young adult female voice, around 18 years old. Very cute, gentle, warm, soft and sweet, " +
  "with a light bright tone and a subtle smile in the voice. Natural fluent Russian pronunciation, " +
  "neutral Russian accent, friendly and affectionate but not childish, not squeaky or robotic. " +
  "Conversational pace and clear articulation.";

const SAMPLE =
  "Привет! Я Астра. Очень рада тебя слышать. Я буду рядом, чтобы поддержать тебя и помочь с любыми вопросами. " +
  "Давай спокойно разберёмся во всём вместе. Мне нравится узнавать новое, общаться и делать твой день чуточку лучше.";

let previews = [];

function apiKey() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("Добавь ELEVENLABS_API_KEY в переменные окружения NEXUS.");
  return key;
}

async function request(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey(),
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000)
  });

  const type = response.headers.get("content-type") || "";
  if (!response.ok) {
    const detail = type.includes("json") ? await response.json().catch(() => ({})) : await response.text();
    const message = detail?.detail?.message || detail?.detail || detail?.message || JSON.stringify(detail);
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return type.includes("json") ? response.json() : Buffer.from(await response.arrayBuffer());
}

async function readState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, "utf8")); }
  catch { return {}; }
}

async function writeState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function generatePreviews(ctx) {
  const data = await request(API + "/text-to-voice/design", {
    model_id: "eleven_multilingual_ttv_v2",
    voice_description: DESCRIPTION,
    text: SAMPLE,
    guidance_scale: 4,
    should_enhance: true
  });

  previews = Array.isArray(data.previews) ? data.previews : [];
  if (!previews.length) throw new Error("Сервис не вернул варианты голоса.");

  for (let i = 0; i < previews.length; i++) {
    const item = previews[i];
    if (!item.audio_base_64) continue;
    await ctx.replyWithAudio(
      new InputFile(Buffer.from(item.audio_base_64, "base64"), "astra-preview-" + (i + 1) + ".mp3"),
      {
        title: "Астра — вариант " + (i + 1),
        performer: "NEXUS",
        caption: "Вариант " + (i + 1) + ". Чтобы выбрать, отправь /astraselect " + (i + 1)
      }
    );
  }
  await ctx.reply("Выбери понравившийся вариант командой /astraselect 1 (или другой номер).");
}

async function selectPreview(ctx) {
  const n = Number(String(ctx.match || "").trim());
  if (!Number.isInteger(n) || n < 1 || n > previews.length || !previews[n - 1]?.generated_voice_id) {
    await ctx.reply("Сначала отправь /astravoice, затем выбери номер из присланных вариантов: /astraselect 1");
    return;
  }

  const selected = previews[n - 1];
  await ctx.reply("Сохраняю выбранный голос Астры…");
  await request(API + "/text-to-voice", {
    voice_name: "Астра",
    voice_description: DESCRIPTION,
    generated_voice_id: selected.generated_voice_id,
    labels: { language: "ru", project: "NEXUS", voice: "Astra" },
    played_not_selected_voice_ids: previews
      .filter((_, i) => i !== n - 1)
      .map(x => x.generated_voice_id)
  });

  const state = await readState();
  state.voice_id = selected.generated_voice_id;
  state.voice_name = "Астра";
  await writeState(state);
  await ctx.reply("❤️ Голос Астры сохранён! Теперь /say текст озвучивается выбранным голосом.");
}

async function synthesizeAstraSpeech(text) {
  const state = await readState();
  if (!state.voice_id) return null;

  const response = await fetch(
    API + "/text-to-speech/" + encodeURIComponent(state.voice_id) + "?output_format=mp3_44100_128",
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey(),
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text: String(text).replace(/[*_`#]/g, "").slice(0, 2500),
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.48, similarity_boost: 0.78, style: 0.35, use_speaker_boost: true }
      }),
      signal: AbortSignal.timeout(90000)
    }
  );

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error("ElevenLabs TTS: HTTP " + response.status + " " + message.slice(0, 300));
  }
  return Buffer.from(await response.arrayBuffer());
}

function installAstraVoice(bot) {
  bot.command("astravoice", async ctx => {
    if (!process.env.ELEVENLABS_API_KEY) {
      await ctx.reply("Чтобы создать голос Астры, добавь ELEVENLABS_API_KEY в переменные окружения NEXUS.");
      return;
    }
    await ctx.reply("❤️ Создаю несколько вариантов нежного русского голоса Астры…");
    try { await generatePreviews(ctx); }
    catch (e) {
      console.error("[ASTRA VOICE]", e);
      await ctx.reply("Не удалось создать голос: " + e.message);
    }
  });

  bot.command("astraselect", async ctx => {
    try { await selectPreview(ctx); }
    catch (e) {
      console.error("[ASTRA VOICE]", e);
      await ctx.reply("Не удалось сохранить голос: " + e.message);
    }
  });
}

module.exports = { installAstraVoice, synthesizeAstraSpeech };
