"use strict";

// Голосовые инструменты NEXUS: перевод, калькулятор, поиск,
// заметки, управление музыкой и пользовательские сценарии.
function installVoiceSuite(bot, deps) {
  const { loadMemory, saveMemory } = deps;

  bot.command("voicenotes", async ctx => {
    const memory = await loadMemory(ctx.from.id);
    const notes = Array.isArray(memory.voiceNotes) ? memory.voiceNotes : [];
    const input = String(ctx.match || "").trim();
    if (input.startsWith("del ")) {
      const id = input.slice(4).trim();
      const before = notes.length;
      memory.voiceNotes = notes.filter(note => note.id !== id);
      if (memory.voiceNotes.length === before) return ctx.reply("Такой голосовой заметки нет.");
      await saveMemory(ctx.from.id);
      return ctx.reply("🗑 Голосовая заметка удалена.");
    }
    if (!notes.length) return ctx.reply("🎙 Голосовых заметок пока нет. Скажи: «NEXUS, запиши заметку купить продукты».");
    const rows = notes.slice(-20).reverse().map(note =>
      "• " + note.id + " — " + new Date(note.createdAt).toLocaleString("ru-RU") + "\n" + note.text.slice(0, 180)
    );
    return ctx.reply("📝 ГОЛОСОВЫЕ ЗАМЕТКИ\n\n" + rows.join("\n\n") + "\n\nУдалить: /voicenotes del ID");
  });

  bot.command("scenario", async ctx => {
    const input = String(ctx.match || "").trim();
    const memory = await loadMemory(ctx.from.id);
    if (!Array.isArray(memory.voiceScenarios)) memory.voiceScenarios = [];
    const add = input.match(/^add\s+([^|]{1,40})\s*\|\s*(.+)$/iu);
    if (add) {
      const name = add[1].trim();
      const actions = [];
      for (const part of add[2].split(";").map(x => x.trim()).filter(Boolean)) {
        let m;
        if ((m = part.match(/^app\s*=\s*([\p{L}\p{N} ._()-]{1,60})$/iu))) actions.push({ action: "open_app", args: { app: m[1].trim() } });
        else if ((m = part.match(/^volume\s*=\s*(\d{1,3})$/iu)) && Number(m[1]) <= 100) actions.push({ action: "set_volume", args: { mode: "set", percent: Number(m[1]) } });
        else if ((m = part.match(/^music\s*=\s*(next|previous|play_pause|stop)$/iu))) actions.push({ action: "media_control", args: { command: m[1].toLowerCase() } });
        else return ctx.reply("Неизвестное действие: " + part + "\nРазрешено: app=Chrome; volume=40; music=play_pause");
      }
      if (!actions.length || actions.length > 5) return ctx.reply("В сценарии должно быть от 1 до 5 действий.");
      const existing = memory.voiceScenarios.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
      const item = { name, actions, updatedAt: Date.now() };
      if (existing >= 0) memory.voiceScenarios[existing] = item;
      else memory.voiceScenarios.push(item);
      memory.voiceScenarios = memory.voiceScenarios.slice(-20);
      await saveMemory(ctx.from.id);
      return ctx.reply("✅ Сценарий «" + name + "» сохранён. Запуск голосом: «NEXUS, запусти сценарий " + name + "».\nДействий: " + actions.length);
    }
    if (/^del\s+/iu.test(input)) {
      const name = input.replace(/^del\s+/iu, "").trim().toLowerCase();
      const before = memory.voiceScenarios.length;
      memory.voiceScenarios = memory.voiceScenarios.filter(x => x.name.toLowerCase() !== name);
      if (before === memory.voiceScenarios.length) return ctx.reply("Сценарий не найден.");
      await saveMemory(ctx.from.id);
      return ctx.reply("🗑 Сценарий удалён.");
    }
    if (!memory.voiceScenarios.length) return ctx.reply("Сценариев пока нет.\nСоздать: /scenario add Игра | app=Steam; volume=45; music=play_pause");
    return ctx.reply("⚙️ ТВОИ СЦЕНАРИИ\n\n" + memory.voiceScenarios.map(x => "• " + x.name + " (" + x.actions.length + " действий)").join("\n") + "\n\nСоздать: /scenario add Имя | app=Steam; volume=40\nУдалить: /scenario del Имя");
  });
}

function normalizeSpokenMath(text) {
  return String(text || "")
    .toLocaleLowerCase("ru")
    .replace(/умножить(?:ся)? на|умножить|умноженное на|умноженный на/gu, "*")
    .replace(/разделить на|делить на|поделить на/gu, "/")
    .replace(/плюс/gu, "+")
    .replace(/минус/gu, "-")
    .replace(/(?:в степени|степень)/gu, "^")
    .replace(/запятая/gu, ".")
    .replace(/\s+/g, " ")
    .trim();
}

async function handleVoiceTranscript(ctx, transcript, status, deps) {
  const { loadMemory, saveMemory, calculateExpression, askAI, deliverAnswer, queueVoiceAction } = deps;
  const userId = ctx.from.id;
  const text = String(transcript || "").trim();
  const lower = text.toLocaleLowerCase("ru");

  const finish = async message => {
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, message).catch(async () => ctx.reply(message));
    return true;
  };

  // Перевод речи: «переведи на английский привет, как дела».
  const translation = text.match(/^(?:nexus\s*)?(?:переведи|перевод)\s+(?:на\s+)?([\p{L}-]{2,30})\s*[:,]?\s+([\s\S]{1,1500})$/iu);
  if (translation) {
    const result = await askAI(userId,
      "Переведи следующий текст на язык «" + translation[1] + "». Верни только перевод, сохрани смысл и тон:\n\n" + translation[2],
      false);
    await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    await deliverAnswer(ctx, userId, result);
    return true;
  }

  // Калькулятор: выражение вычисляется безопасным парсером, без eval.
  const calcMatch = text.match(/^(?:(?:nexus[, ]*)?(?:посчитай|вычисли|сколько будет|чему равно)\s+)([\s\S]+)$/iu);
  if (calcMatch) {
    const expression = normalizeSpokenMath(calcMatch[1]);
    try {
      const value = calculateExpression(expression);
      return finish("🧮 " + expression + " = " + Number(value.toPrecision(12)));
    } catch {
      return finish("Не удалось разобрать пример. Скажи его, например: «NEXUS, посчитай 125 умножить на 48».");
    }
  }

  // Поиск: использует уже подключённый поисковый режим NEXUS.
  const searchMatch = text.match(/^(?:(?:nexus[, ]*)?(?:найди|поищи|загугли|найди в интернете|поищи в интернете)\s+)([\s\S]{2,500})$/iu);
  if (searchMatch) {
    const result = await askAI(userId, searchMatch[1].trim(), true);
    await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    await deliverAnswer(ctx, userId, result);
    return true;
  }

  // Голосовые заметки с постоянным хранением в Cloudflare KV.
  const noteMatch = text.match(/^(?:(?:nexus[, ]*)?(?:запиши|сохрани)\s+(?:голосовую\s+)?заметку|заметка)\s*[:, -]?\s*([\s\S]{2,2000})$/iu);
  if (noteMatch) {
    const memory = await loadMemory(userId);
    if (!Array.isArray(memory.voiceNotes)) memory.voiceNotes = [];
    if (memory.voiceNotes.length >= 100) memory.voiceNotes.shift();
    const id = require("crypto").randomBytes(3).toString("hex");
    memory.voiceNotes.push({ id, text: noteMatch[1].trim(), createdAt: Date.now() });
    const saved = await saveMemory(userId);
    return finish("📝 Заметка сохранена. ID: " + id + (saved ? "" : "\n⚠️ Cloudflare KV не сохранил данные — проверь настройки хранилища."));
  }

  // Музыкальные клавиши Windows отправляются только на подключённый ПК.
  const musicCommands = [
    [/\b(?:следующ\w* песн\w*|следующ\w* трек\w*|переключи на следующ\w*)\b/iu, "next"],
    [/\b(?:предыдущ\w* песн\w*|предыдущ\w* трек\w*)\b/iu, "previous"],
    [/\b(?:пауза|приостанови музыку|останови музыку|поставь на паузу)\b/iu, "play_pause"],
    [/\b(?:продолжи музыку|возобнови музыку|включи музыку|сними с паузы)\b/iu, "play_pause"],
    [/\b(?:останови воспроизведение|стоп музыка)\b/iu, "stop"]
  ];
  const music = musicCommands.find(([pattern]) => pattern.test(lower));
  if (music) {
    queueVoiceAction("media_control", { command: music[1] }, userId, ctx.chat.id);
    return finish("🎵 Команда управления музыкой отправлена на подключённый компьютер.");
  }

  // Запуск заранее сохранённого безопасного сценария.
  const scenarioMatch = text.match(/^(?:nexus[, ]*)?(?:запусти|выполни)\s+сценарий\s+([\p{L}\p{N} _-]{1,40})$/iu);
  if (scenarioMatch) {
    const memory = await loadMemory(userId);
    const scenarios = Array.isArray(memory.voiceScenarios) ? memory.voiceScenarios : [];
    const scenario = scenarios.find(x => x.name.toLocaleLowerCase("ru") === scenarioMatch[1].trim().toLocaleLowerCase("ru"));
    if (!scenario) return finish("Сценарий не найден. Посмотри список командой /scenario.");
    for (const item of scenario.actions) {
      queueVoiceAction(item.action, item.args || {}, userId, ctx.chat.id);
    }
    return finish("⚙️ Запускаю сценарий «" + scenario.name + "». Действий: " + scenario.actions.length + ".");
  }

  return false;
}

module.exports = { installVoiceSuite, handleVoiceTranscript };
