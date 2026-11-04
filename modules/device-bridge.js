"use strict";

const crypto = require("node:crypto");
const { InputFile, InlineKeyboard } = require("grammy");

const TOKEN = String(process.env.PC_AGENT_TOKEN || "");
const OWNER_ID = String(process.env.ADMIN_ID || process.env.OWNER_ID || "");
const queue = [];
const pending = new Map();
const devices = new Map();
const results = new Map();
let deviceBot = null;
const MAX_QUEUE = 20;

function authorized(ctx) {
  return Boolean(OWNER_ID && ctx.from && String(ctx.from.id) === OWNER_ID);
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
function auth(req) {
  const value = String(req.headers.authorization || "");
  return TOKEN.length >= 32 && value === "Bearer " + TOKEN;
}
function safeText(s, max = 1500) {
  return String(s || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, max);
}
function enqueue(action, args, userId, chatId, messageId) {
  if (queue.length >= MAX_QUEUE) throw new Error("Очередь команд заполнена. Подожди выполнения предыдущих.");
  const id = crypto.randomUUID();
  queue.push({ id, action, args, userId: String(userId), chatId, messageId, createdAt: Date.now() });
  results.set(id, { chatId, userId: String(userId) });
  return id;
}
function installDeviceBridge(bot) {
  deviceBot = bot;
  bot.command("pc", async ctx => {
    if (!authorized(ctx)) return ctx.reply("⛔ Управление ПК доступно только владельцу бота.");
    if (!TOKEN || TOKEN.length < 32) return ctx.reply("⚠️ Мост ПК ещё не настроен: добавь PC_AGENT_TOKEN (не менее 32 символов) в переменные Render.");
    const input = String(ctx.match || "").trim();
    const [verb, ...rest] = input.split(/\s+/);
    const arg = rest.join(" ").trim();
    if (!verb || verb === "help") {
      return ctx.reply("🖥 NEXUS PC\n/pc status — состояние подключения\n/pc screen — скриншот экрана\n/pc open https://... — открыть сайт\n/pc launch notepad — открыть программу\n/pc type текст — напечатать текст в активном окне\n\nИзменяющие действия требуют подтверждения кнопкой. Произвольные shell-команды не поддерживаются.");
    }
    if (verb === "status") {
      const d = devices.get("windows-main");
      return ctx.reply(d && Date.now() - d.lastSeen < 45000
        ? "🟢 ПК подключён · " + new Date(d.lastSeen).toLocaleTimeString("ru-RU") + "\nАгент: " + d.version
        : "🔴 ПК не подключён. Запусти NEXUS Agent на Windows.");
    }
    let action, args = {};
    if (verb === "screen") action = "screenshot";
    else if (verb === "open") {
      let url;
      try { url = new URL(arg); } catch { return ctx.reply("Формат: /pc open https://example.com"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return ctx.reply("Разрешены только безопасные HTTP/HTTPS-ссылки без логина и пароля.");
      action = "open_url"; args.url = url.toString();
    } else if (verb === "launch") {
      const allowed = { notepad: "notepad.exe", calculator: "calc.exe", paint: "mspaint.exe", explorer: "explorer.exe" };
      const app = arg.toLowerCase();
      if (!allowed[app]) return ctx.reply("Разрешённые приложения: notepad, calculator, paint, explorer.");
      action = "launch"; args.app = app;
    } else if (verb === "type") {
      if (!arg || arg.length > 1000) return ctx.reply("Укажи текст длиной от 1 до 1000 символов.");
      action = "type_text"; args.text = arg;
    } else return ctx.reply("Неизвестная команда. Напиши /pc help.");
    const id = crypto.randomUUID();
    pending.set(id, { action, args, userId: String(ctx.from.id), chatId: ctx.chat.id });
    const label = action === "screenshot" ? "сделать скриншот" : action === "open_url" ? "открыть сайт " + args.url : action === "launch" ? "запустить " + args.app : "напечатать указанный текст";
    const keyboard = new InlineKeyboard().text("✅ Подтвердить", "pc_yes:" + id).text("Отмена", "pc_no:" + id);
    return ctx.reply("Подтверди действие на подключённом компьютере: " + label, { reply_markup: keyboard });
  });

  bot.callbackQuery(/^pc_(yes|no):([\w-]+)$/, async ctx => {
    if (!authorized(ctx)) return ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
    const id = ctx.match[2];
    const item = pending.get(id);
    if (!item || item.userId !== String(ctx.from.id)) return ctx.answerCallbackQuery({ text: "Запрос устарел." });
    pending.delete(id);
    await ctx.answerCallbackQuery();
    if (ctx.match[1] === "no") return ctx.editMessageText("❎ Действие отменено.");
    const device = devices.get("windows-main");
    if (!device || Date.now() - device.lastSeen > 45000) return ctx.editMessageText("🔴 Компьютер сейчас не подключён. Запусти NEXUS Agent и повтори команду.");
    try {
      enqueue(item.action, item.args, ctx.from.id, ctx.chat.id, ctx.callbackQuery.message.message_id);
      return ctx.editMessageText("⏳ Команда отправлена на ПК. Жду ответ агента...");
    } catch (e) { return ctx.editMessageText("❌ " + e.message); }
  });

  bot.command("pcdisconnect", async ctx => {
    if (!authorized(ctx)) return ctx.reply("⛔ Нет доступа.");
    devices.delete("windows-main");
    queue.length = 0;
    pending.clear();
    return ctx.reply("🔌 Очередь очищена. Останови NEXUS Agent на компьютере, чтобы полностью отключить его.");
  });
}

async function handleDeviceHttp(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith("/device/")) return false;
  if (!auth(req)) { sendJson(res, 401, { error: "unauthorized" }); return true; }
  if (req.method === "GET" && url.pathname === "/device/poll") {
    const now = Date.now();
    devices.set("windows-main", { lastSeen: now, version: "1.0" });
    while (queue.length && now - queue[0].createdAt > 60000) {
      const expired = queue.shift();
      results.delete(expired.id);
      const msg = "⌛ Команда отменена: истекло время ожидания ПК.";
      deviceBot.api.sendMessage(expired.chatId, msg).catch(() => {});
    }
    const item = queue.shift();
    sendJson(res, 200, { ok: true, command: item ? { id: item.id, action: item.action, args: item.args } : null, pollAfterMs: 1800 });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/device/result") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 12 * 1024 * 1024) req.destroy(); });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const id = String(data.id || "");
        const result = String(data.result || "");
        if (!id || result.length > 10 * 1024 * 1024) return sendJson(res, 400, { error: "invalid_result" });
        const item = results.get(id);
        if (data.image) {
          if (typeof data.image !== "string" || data.image.length > 10 * 1024 * 1024) return sendJson(res, 413, { error: "image_too_large" });
          const bytes = Buffer.from(data.image, "base64");
          if (bytes.length > 7 * 1024 * 1024) return sendJson(res, 413, { error: "image_too_large" });
          if (item) await deviceBot.api.sendPhoto(item.chatId, new InputFile(bytes, "pc-screen.png"), { caption: "🖥 Скриншот компьютера" }).catch(() => {});
        }
        if (item) {
          const text = safeText(result || (data.image ? "Скриншот отправлен." : "Команда выполнена."), 3000);
          await deviceBot.api.sendMessage(item.chatId, "🖥 NEXUS PC: " + text).catch(() => {});
          results.delete(id);
        }
        sendJson(res, 200, { ok: true });
      } catch (e) { sendJson(res, 400, { error: "bad_json" }); }
    });
    return true;
  }
  sendJson(res, 404, { error: "not_found" });
  return true;
}

module.exports = { installDeviceBridge, handleDeviceHttp };
