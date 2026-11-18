"use strict";

const crypto = require("crypto");
const { InputFile } = require("grammy");

const REPO = process.env.NEXUS_GAME_REPO || "koroluka34-ops/nexus-ai-bot";
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const MODEL = process.env.NEXUS_GAME_MODEL || "openai/gpt-oss-120b";
const running = new Set();

function isGameCreationRequest(text) {
  const s = String(text || "");
  return /(?:создай|сделай|разработай|напиши|собери|сгенерируй|построй).{0,100}(?:игр|шутер|симулятор|rpg|рпг|платформер|гонк|counter[\s-]?strike|кс2|cs2|minecraft|майнкрафт)|(?:игр|шутер).{0,80}(?:создай|сделай|разработай|напиши|собери)/iu.test(s);
}

function ghHeaders() {
  return {
    Authorization: "Bearer " + GH_TOKEN,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json"
  };
}

async function gh(path, options = {}) {
  const res = await fetch("https://api.github.com/repos/" + REPO + path, {
    ...options,
    headers: { ...ghHeaders(), ...(options.headers || {}) },
    signal: AbortSignal.timeout(30000)
  });
  const body = await res.text();
  let data;
  try { data = body ? JSON.parse(body) : {}; } catch { data = { raw: body }; }
  if (!res.ok) throw new Error("GitHub API " + res.status + ": " + (data.message || body).slice(0, 500));
  return data;
}

async function generateGodotProject(prompt, jobId) {
  const system = [
    "You are an autonomous senior Godot 4 game development team.",
    "Create a complete, playable, original 3D tactical first-person shooter project inspired by classic round-based tactical shooters. Do not use copyrighted Counter-Strike maps, names, logos, sounds, models or other proprietary assets.",
    "Return ONLY valid JSON object: {\"title\":\"...\",\"summary\":\"...\",\"files\":{\"relative/path\":\"complete UTF-8 file contents\"}}.",
    "Required Godot 4 project files: project.godot, export_presets.cfg, scenes/main.tscn, scripts/main.gd, scripts/player.gd, scripts/bot.gd, scripts/weapon.gd, scripts/hud.gd. Add any other needed text files.",
    "The project must run in Godot 4 headless import and as a desktop game. Use primitive meshes/materials generated in GDScript; no external assets or network dependencies.",
    "Implement a first-person player with mouse look, WASD movement, jump, hitscan shooting, reload/ammo, health, a simple arena map with cover, at least 3 enemy bots with navigation or simple steering, bot shooting/damage, score/round state, a start/restart menu and in-game HUD. Add clear controls and a crosshair.",
    "Do not claim real online multiplayer unless you actually implement a working ENet host/join flow. Add a basic LAN host/join UI using ENetMultiplayerPeer if feasible; otherwise label it LAN prototype and clearly state server hosting is not included.",
    "All paths must be relative and safe. No binary files. GDScript must be valid Godot 4 syntax. Avoid TODO-only stubs. Ensure main.tscn references scripts correctly. Export presets must include Windows Desktop and Linux/X11.",
    "Keep total output under 14000 tokens. Make the game genuinely playable rather than a static mockup."
  ].join("\n");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + GROQ_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 14000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: "Create the complete game project for this request. Job ID: " + jobId + "\nUser request:\n" + prompt }
      ]
    }),
    signal: AbortSignal.timeout(180000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Groq project generation failed: " + (data.error?.message || res.status));
  const raw = data.choices?.[0]?.message?.content || "";
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Модель не вернула корректный JSON проекта.");
    parsed = JSON.parse(match[0]);
  }
  if (!parsed.files || typeof parsed.files !== "object") throw new Error("В ответе ИИ нет списка файлов проекта.");
  const files = {};
  for (const [name, value] of Object.entries(parsed.files)) {
    const clean = String(name).replace(/\\/g, "/");
    if (!clean || clean.startsWith("/") || clean.split("/").some(p => p === "..") || typeof value !== "string") continue;
    files[clean] = value;
  }
  for (const required of ["project.godot", "scenes/main.tscn", "scripts/main.gd"]) {
    if (!files[required]) throw new Error("В проекте отсутствует обязательный файл: " + required);
  }
  return { title: String(parsed.title || "NEXUS Game"), summary: String(parsed.summary || ""), files };
}

async function pushProject(jobId, files) {
  const ref = await gh("/git/ref/heads/main");
  const parentSha = ref.object.sha;
  const parent = await gh("/git/commits/" + parentSha);
  const entries = [];
  for (const [name, content] of Object.entries(files)) {
    const blob = await gh("/git/blobs", {
      method: "POST",
      body: JSON.stringify({ content, encoding: "utf-8" })
    });
    entries.push({ path: "generated-games/" + jobId + "/" + name, mode: "100644", type: "blob", sha: blob.sha });
  }
  const tree = await gh("/git/trees", {
    method: "POST",
    body: JSON.stringify({ base_tree: parent.tree.sha, tree: entries })
  });
  const commit = await gh("/git/commits", {
    method: "POST",
    body: JSON.stringify({ message: "NEXUS game project " + jobId, tree: tree.sha, parents: [parentSha] })
  });
  await gh("/git/refs/heads/main", {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha })
  });
}

async function dispatchBuild(jobId) {
  await gh("/actions/workflows/nexus-godot-build.yml/dispatches", {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs: { job_id: jobId } })
  });
}

async function waitForBuild(ctx, jobId, messageId) {
  const workflow = "/actions/workflows/nexus-godot-build.yml/runs?per_page=20";
  let run;
  for (let i = 0; i < 120; i++) {
    const data = await gh(workflow);
    run = (data.workflow_runs || []).find(r => r.name === "NEXUS game build " + jobId);
    if (run && run.status === "completed") break;
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  if (!run) throw new Error("GitHub Actions не зарегистрировал запуск сборки за 30 минут.");
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("Облачная сборка завершилась с ошибкой. Логи: " + run.html_url);
  }
  const artifacts = await gh("/actions/runs/" + run.id + "/artifacts");
  const artifact = (artifacts.artifacts || []).find(a => a.name === "nexus-game-" + jobId);
  if (!artifact) throw new Error("Сборка завершилась, но артефакт не найден. " + run.html_url);
  const response = await fetch(artifact.archive_download_url, {
    headers: { Authorization: "Bearer " + GH_TOKEN, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error("Не удалось скачать результат сборки: HTTP " + response.status);
  const zip = Buffer.from(await response.arrayBuffer());
  await ctx.api.sendDocument(ctx.chat.id, new InputFile(zip, "NEXUS-" + jobId + "-build.zip"), {
    caption: "✅ Облачная сборка завершена. В архиве — проект Godot и доступные сборки. Проверь README внутри архива."
  });
}

async function handleGameStudioRequest(ctx, prompt) {
  if (!isGameCreationRequest(prompt)) return false;
  const userId = String(ctx.from?.id || "");
  if (running.has(userId)) {
    await ctx.reply("⏳ Я уже собираю для тебя игру. Дождись результата текущей задачи.");
    return true;
  }
  if (!GROQ_API_KEY) {
    await ctx.reply("❌ Для облачной разработки не настроен GROQ_API_KEY в Render.");
    return true;
  }
  if (!GH_TOKEN) {
    await ctx.reply(
      "🛠 Запрос распознан как создание игры, но облачный сборщик ещё не подключён.\n\n" +
      "Нужно добавить в Render → nexus-ai-bot → Environment переменную GITHUB_TOKEN. " +
      "Токен GitHub должен иметь доступ к этому репозиторию: Contents (Read and write) и Actions (Read and write). " +
      "Не присылай токен в Telegram — добавь его только в Render Environment."
    );
    return true;
  }
  running.add(userId);
  const jobId = Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
  const status = await ctx.reply("🎮 NEXUS Game Studio принял задачу.\n\n1/4 — проектирую игру и генерирую файлы Godot 4…");
  (async () => {
    try {
      const project = await generateGodotProject(prompt, jobId);
      await ctx.api.editMessageText(ctx.chat.id, status.message_id,
        "🎮 Проект создан: " + project.title + "\n" +
        "2/4 — сохраняю " + Object.keys(project.files).length + " файлов в облачный репозиторий…");
      await pushProject(jobId, project.files);
      await ctx.api.editMessageText(ctx.chat.id, status.message_id,
        "🎮 " + project.title + "\n3/4 — запускаю облачную сборку Godot 4 (Windows/Linux)…");
      await dispatchBuild(jobId);
      await ctx.api.editMessageText(ctx.chat.id, status.message_id,
        "🎮 " + project.title + "\n4/4 — сборщик работает. Проверяю результат и подготовлю архив…");
      await waitForBuild(ctx, jobId, status.message_id);
      await ctx.api.editMessageText(ctx.chat.id, status.message_id,
        "✅ Готово: " + project.title + "\n" + project.summary.slice(0, 700));
    } catch (error) {
      console.error("NEXUS Game Studio:", error);
      await ctx.api.editMessageText(ctx.chat.id, status.message_id,
        "❌ Не удалось завершить создание игры.\n" + String(error.message || error).slice(0, 1800) +
        "\n\nЗадание не отмечено как готовое; это не готовая сборка.").catch(() => {});
    } finally {
      running.delete(userId);
    }
  })();
  return true;
}

module.exports = { handleGameStudioRequest, isGameCreationRequest };
