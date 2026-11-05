"use strict";

const crypto = require("node:crypto");
const { InputFile, InlineKeyboard } = require("grammy");

const TOKEN = String(process.env.PC_AGENT_TOKEN || "");
const BOT_TOKEN = String(process.env.BOT_TOKEN || "");
const touchpad = { activeUntil: 0, dx: 0, dy: 0, events: [] };
let latestScreen = "", latestScreenAt = 0;
let pendingWebRtcOffer = null;
const webRtcAnswers = new Map();
const pollWaiters = new Set();
function takeTouchpadCommand() {
  if (touchpad.events.length) return touchpad.events.shift();
  if (touchpad.dx || touchpad.dy) {
    const command = { action: "touch_move", args: { dx: touchpad.dx, dy: touchpad.dy } };
    touchpad.dx = 0; touchpad.dy = 0;
    return command;
  }
  return null;
}
function wakeTouchpadPoller() {
  const waiter = pollWaiters.values().next().value;
  if (!waiter) return;
  pollWaiters.delete(waiter);
  clearTimeout(waiter.timer);
  const command = takeTouchpadCommand();
  if (!waiter.res.writableEnded) sendJson(waiter.res, 200, { ok: true, command, touchpadActive: touchpad.activeUntil > Date.now(), pollAfterMs: 0 });
}
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
function queueVoiceAction(action, args, userId, chatId) {
  if (!OWNER_ID || String(userId) !== OWNER_ID) {
    throw new Error("Голосовое управление ПК доступно только владельцу.");
  }
  const allowedApps = new Set(["roblox", "discord", "notepad", "calculator", "paint", "explorer"]);
  const allowedFolders = new Set(["downloads", "desktop", "documents", "pictures", "videos", "music"]);
  if (action === "open_app" && !allowedApps.has(String(args.app || ""))) {
    throw new Error("Это приложение не входит в разрешённый список.");
  }
  if (action === "open_folder" && !allowedFolders.has(String(args.folder || ""))) {
    throw new Error("Эта папка не входит в разрешённый список.");
  }
  if (action === "open_url") {
    let url;
    try { url = new URL(String(args.url || "")); } catch { throw new Error("Некорректная ссылка."); }
    if (url.protocol !== "https:" || url.hostname !== "www.youtube.com" || !["/","/results"].includes(url.pathname)) {
      throw new Error("Голосом разрешено открывать только YouTube.");
    }
    args.url = url.toString();
  } else if (!["open_app", "open_folder"].includes(action)) {
    throw new Error("Такое голосовое действие не поддерживается.");
  }
  if (!TOKEN || TOKEN.length < 32) throw new Error("Мост ПК не настроен: отсутствует PC_AGENT_TOKEN в Render.");
  const device = devices.get("windows-main");
  if (!device || Date.now() - device.lastSeen > 45000) {
    throw new Error("ПК не подключён. Сначала запусти NEXUS Agent на Windows.");
  }
  return enqueue(action, args, userId, chatId, null);
}

function installDeviceBridge(bot) {
  deviceBot = bot;
  bot.command("pc", async ctx => {
    if (!authorized(ctx)) return ctx.reply("⛔ Управление ПК доступно только владельцу бота.");
    if (!TOKEN || TOKEN.length < 32) return ctx.reply("⚠️ Мост ПК ещё не настроен: добавь PC_AGENT_TOKEN (не менее 32 символов) в переменные Render.");
    const input = String(ctx.match || "").trim();
    const [verb, ...rest] = input.split(/\s+/);
    const arg = rest.join(" ").trim();
    if (verb === "touchpad") {
      if (ctx.chat.type !== "private") return ctx.reply("Открой личный чат с ботом и отправь /pc touchpad.");
      const base = String(process.env.RENDER_EXTERNAL_URL || "https://nexus-ai-bot-kt4w.onrender.com").replace(/\/$/, "");
      const keyboard = new InlineKeyboard().webApp("🖱 Открыть тачпад", base + "/touchpad");
      return ctx.reply("🖥 Сенсорное управление ПК\nВоди пальцем по панели — курсор будет двигаться на компьютере. Один тап — клик, два пальца — прокрутка.", { reply_markup: keyboard });
    }
    if (!verb || verb === "help") {
      return ctx.reply("🖥 NEXUS PC\n/pc touchpad — открыть сенсорную мышь в Telegram\n/pc status — состояние подключения\n/pc screen — скриншот экрана\n/pc open https://... — открыть сайт\n/pc launch notepad — открыть программу\n/pc type текст — вставить текст\n\n🖱 Мышь:\n/pc mouse move 500 300 — переместить курсор\n/pc mouse click — левый щелчок\n/pc mouse click right — правый щелчок\n/pc mouse double — двойной щелчок\n/pc mouse scroll up 3 — прокрутка вверх\n/pc mouse drag 100 100 500 400 — перетащить мышь\n\n⌨️ Клавиатура:\n/pc key enter — нажать Enter\n/pc key esc — Escape\n/pc key tab — Tab\n/pc key up — стрелка вверх\n/pc key f5 — функциональные клавиши F1–F12\n/pc hotkey ctrl+c — сочетание клавиш\n/pc hotkey alt+tab — переключить окно\n/pc hotkey win+d — показать рабочий стол\n/pc hotkey win+e — открыть Проводник\n/pc hotkey ctrl+shift+esc — Диспетчер задач\n/pc hotkey alt+f4 — закрыть активное окно\n\nВсе действия требуют подтверждения кнопкой. Произвольные shell-команды не поддерживаются.");
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
    } else if (verb === "mouse") {
      const [op, ...parts] = arg.split(/\s+/);
      if (op === "move") {
        if (parts.length !== 2 || !parts.every(v => /^\d{1,5}$/.test(v))) return ctx.reply("Формат: /pc mouse move 500 300");
        args.x = Number(parts[0]); args.y = Number(parts[1]);
        if (args.x > 10000 || args.y > 10000) return ctx.reply("Координаты слишком большие.");
        action = "mouse_move";
      } else if (op === "click") {
        const button = (parts[0] || "left").toLowerCase();
        if (!["left", "right", "middle"].includes(button) || parts.length > 1) return ctx.reply("Формат: /pc mouse click [left|right|middle]");
        args.button = button; action = "mouse_click";
      } else if (op === "double") {
        const button = (parts[0] || "left").toLowerCase();
        if (!["left", "right"].includes(button) || parts.length > 1) return ctx.reply("Формат: /pc mouse double [left|right]");
        args.button = button; action = "mouse_double";
      } else if (op === "scroll") {
        const direction = (parts[0] || "").toLowerCase();
        const amount = parts[1] === undefined ? 3 : Number(parts[1]);
        if (!["up", "down"].includes(direction) || parts.length > 2 || !Number.isInteger(amount) || amount < 1 || amount > 10) return ctx.reply("Формат: /pc mouse scroll up 3 (1–10)");
        args.direction = direction; args.amount = amount; action = "mouse_scroll";
      } else if (op === "drag") {
        if (parts.length !== 4 || !parts.every(v => /^\d{1,5}$/.test(v))) return ctx.reply("Формат: /pc mouse drag X1 Y1 X2 Y2");
        [args.x1, args.y1, args.x2, args.y2] = parts.map(Number);
        if ([args.x1,args.y1,args.x2,args.y2].some(v => v > 10000)) return ctx.reply("Координаты слишком большие.");
        action = "mouse_drag";
      } else return ctx.reply("Команды мыши: move X Y, click [left|right|middle], double, scroll up/down [1–10], drag X1 Y1 X2 Y2.");
    } else if (verb === "key") {
      const key = arg.toLowerCase();
      const allowed = ["enter", "esc", "tab", "space", "backspace", "delete", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", ...Array.from({length:12},(_,i)=>"f"+(i+1))];
      if (!allowed.includes(key)) return ctx.reply("Клавиши: enter, esc, tab, space, backspace, delete, стрелки, home/end, pageup/pagedown, F1–F12.");
      args.key = key; action = "key_press";
    } else if (verb === "hotkey") {
      const combo = arg.toLowerCase().replace(/\s+/g, "");
      const allowed = ["ctrl+c","ctrl+v","ctrl+x","ctrl+z","ctrl+y","ctrl+a","ctrl+s","ctrl+f","ctrl+p","ctrl+w","ctrl+t","ctrl+tab","ctrl+shift+tab","alt+tab","alt+f4","win+d","win+e","ctrl+shift+esc"];
      if (!allowed.includes(combo)) return ctx.reply("Сочетание не разрешено. Доступно: ctrl+c/v/x/z/y/a/s/f/p/w/t, ctrl+tab, ctrl+shift+tab, alt+tab, alt+f4, win+d/e, ctrl+shift+esc.");
      args.combo = combo; action = "hotkey";
    } else return ctx.reply("Неизвестная команда. Напиши /pc help.");
    const id = crypto.randomUUID();
    pending.set(id, { action, args, userId: String(ctx.from.id), chatId: ctx.chat.id });
    const labels = {
      screenshot: "сделать скриншот",
      open_url: "открыть сайт " + args.url,
      launch: "запустить " + args.app,
      type_text: "вставить указанный текст",
      mouse_move: "переместить мышь в " + args.x + ", " + args.y,
      mouse_click: "нажать " + args.button + " кнопкой мыши",
      mouse_double: "сделать двойной щелчок (" + args.button + ")",
      mouse_scroll: "прокрутить " + args.direction + " на " + args.amount,
      mouse_drag: "перетащить мышь из " + args.x1 + "," + args.y1 + " в " + args.x2 + "," + args.y2,
      key_press: "нажать клавишу " + args.key,
      hotkey: "нажать сочетание " + args.combo
    };
    const label = labels[action] || action;
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

function verifyTelegramWebApp(initData) {
  if (!BOT_TOKEN) return "server_bot_token_missing";
  if (!OWNER_ID) return "server_owner_missing";
  if (!initData || initData.length > 8192) return "init_data_missing";
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    const authDate = Number(params.get("auth_date") || 0);
    const user = JSON.parse(params.get("user") || "{}");
    if (!hash) return "hash_missing";
    if (!/^\d+$/.test(String(authDate)) || authDate > Date.now()/1000 + 60) return "auth_date_invalid";
    if (Date.now()/1000 - authDate > 86400) return "auth_data_expired";
    params.delete("hash");
    const check = [...params.entries()].sort().map(([k,v]) => k + "=" + v).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expected = crypto.createHmac("sha256", secret).update(check).digest();
    const supplied = Buffer.from(hash, "hex");
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return "hash_mismatch";
    if (String(user.id) !== OWNER_ID) return "owner_mismatch";
    return "";
  } catch { return "invalid_init_data"; }
}
async function handleDeviceHttp(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith("/device/")) return false;
  if (req.method === "POST" && url.pathname === "/device/webrtc/offer") {
    const authError = verifyTelegramWebApp(String(req.headers["x-telegram-init-data"] || ""));
    if (authError) { sendJson(res, 401, { error: authError }); return true; }
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 200000) req.destroy(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        if (!/^[a-f0-9-]{20,64}$/i.test(String(data.sessionId || "")) || typeof data.sdp !== "string" || data.sdp.length > 150000 || data.type !== "offer") return sendJson(res, 400, { error: "invalid_offer" });
        pendingWebRtcOffer = { sessionId: data.sessionId, sdp: data.sdp, type: data.type, createdAt: Date.now() };
        webRtcAnswers.delete(data.sessionId);
        sendJson(res, 200, { ok: true });
      } catch { sendJson(res, 400, { error: "bad_json" }); }
    });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/device/webrtc/answer") {
    const authError = verifyTelegramWebApp(String(req.headers["x-telegram-init-data"] || ""));
    if (authError) { sendJson(res, 401, { error: authError }); return true; }
    const sessionId = url.searchParams.get("sessionId") || "";
    sendJson(res, 200, { answer: webRtcAnswers.get(sessionId) || null });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/device/screen") {
    const authError = verifyTelegramWebApp(String(req.headers["x-telegram-init-data"] || ""));
    if (authError) { sendJson(res, 401, { error: authError }); return true; }
    sendJson(res, 200, { image: Date.now() - latestScreenAt < 3000 ? latestScreen : "", capturedAt: latestScreenAt }); return true;
  }
  if (req.method === "POST" && url.pathname === "/device/touchpad") {
    const authError = verifyTelegramWebApp(String(req.headers["x-telegram-init-data"] || ""));
    if (authError) {
      sendJson(res, 401, { error: authError }); return true;
    }
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        touchpad.activeUntil = Date.now() + 5000;
        if (data.type === "move") {
          const dx = Number(data.dx), dy = Number(data.dy);
          if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 500 || Math.abs(dy) > 500) return sendJson(res, 400, { error: "invalid_delta" });
          touchpad.dx = Math.max(-500, Math.min(500, touchpad.dx + dx));
          touchpad.dy = Math.max(-500, Math.min(500, touchpad.dy + dy));
        } else if (data.type === "click") {
          const button = data.button === "right" ? "right" : "left";
          if (touchpad.events.length < 12) touchpad.events.push({ action: "mouse_click", args: { button } });
        } else if (data.type === "scroll") {
          const amount = Math.max(1, Math.min(5, Math.round(Math.abs(Number(data.amount) || 1))));
          const direction = Number(data.direction) < 0 ? "down" : "up";
          if (touchpad.events.length < 12) touchpad.events.push({ action: "mouse_scroll", args: { direction, amount } });
        } else if (data.type === "text") {
          const value = safeText(data.text, 1000);
          if (!value.trim()) return sendJson(res, 400, { error: "empty_text" });
          if (touchpad.events.length < 12) touchpad.events.push({ action: "type_text", args: { text: value } });
          else return sendJson(res, 429, { error: "touchpad_queue_full" });
        } else if (data.type === "key") {
          const allowed = ["backspace", "delete", "left", "right", "up", "down", "home", "end", "enter", "esc", "tab", "f11"];
          const key = String(data.key || "").toLowerCase();
          if (!allowed.includes(key)) return sendJson(res, 400, { error: "invalid_key" });
          if (touchpad.events.length < 12) touchpad.events.push({ action: "key_press", args: { key } });
          else return sendJson(res, 429, { error: "touchpad_queue_full" });
        } else if (data.type === "game-key") {
          const key = String(data.key || "").toLowerCase();
          const allowed = ["w","a","s","d","space","shift","ctrl","alt","e","q","f","r","1","2","3","4","5","6","7","8","9","escape","tab","enter"];
          if (!allowed.includes(key) || !["down","up"].includes(data.state)) return sendJson(res, 400, { error: "invalid_game_key" });
          if (touchpad.events.length < 12) touchpad.events.push({ action: data.state === "down" ? "key_down" : "key_up", args: { key } });
          else return sendJson(res, 429, { error: "touchpad_queue_full" });
        } else if (data.type === "game-mouse") {
          const button = String(data.button || "left");
          if (!["left","right"].includes(button) || !["down","up"].includes(data.state)) return sendJson(res, 400, { error: "invalid_game_mouse" });
          if (touchpad.events.length < 12) touchpad.events.push({ action: data.state === "down" ? "mouse_down" : "mouse_up", args: { button } });
          else return sendJson(res, 429, { error: "touchpad_queue_full" });
        } else if (data.type === "hotkey") {
          const combo = String(data.combo || "").toLowerCase();
          if (combo !== "ctrl+a") return sendJson(res, 400, { error: "invalid_hotkey" });
          if (touchpad.events.length < 12) touchpad.events.push({ action: "hotkey", args: { combo } });
          else return sendJson(res, 429, { error: "touchpad_queue_full" });
        } else if (data.type !== "heartbeat") {
          return sendJson(res, 400, { error: "unknown_touch_action" });
        }
        if (["move", "click", "scroll", "text", "key", "game-key", "game-mouse", "hotkey"].includes(data.type)) wakeTouchpadPoller();
        sendJson(res, 200, { ok: true });
      } catch { sendJson(res, 400, { error: "bad_json" }); }
    });
    return true;
  }
  if (!auth(req)) { sendJson(res, 401, { error: "unauthorized" }); return true; }
  if (req.method === "POST" && url.pathname === "/device/webrtc/answer") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 200000) req.destroy(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const sessionId = String(data.sessionId || "");
        if (!/^[a-f0-9-]{20,64}$/i.test(sessionId) || typeof data.sdp !== "string" || data.sdp.length > 150000 || data.type !== "answer") {
          return sendJson(res, 400, { error: "invalid_answer" });
        }
        webRtcAnswers.set(sessionId, { sdp: data.sdp, type: data.type });
        sendJson(res, 200, { ok: true });
      } catch { sendJson(res, 400, { error: "bad_json" }); }
    });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/device/webrtc/offer") {
    const offer = pendingWebRtcOffer;
    if (!offer || Date.now() - offer.createdAt > 60000) {
      pendingWebRtcOffer = null;
      sendJson(res, 200, { offer: null });
      return true;
    }
    pendingWebRtcOffer = null;
    sendJson(res, 200, { offer: { sessionId: offer.sessionId, sdp: offer.sdp, type: offer.type } });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/device/stream") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 4 * 1024 * 1024) req.destroy(); });
    req.on("end", () => { try { const data = JSON.parse(body || "{}"); const image = String(data.image || ""); if (!/^[A-Za-z0-9+/=]+$/.test(image) || image.length > 3 * 1024 * 1024) return sendJson(res, 400, { error: "invalid_image" }); latestScreen = image; latestScreenAt = Date.now(); sendJson(res, 200, { ok: true }); } catch { sendJson(res, 400, { error: "bad_json" }); } });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/device/poll") {
    const now = Date.now();
    devices.set("windows-main", { lastSeen: now, version: "1.0" });
    while (queue.length && now - queue[0].createdAt > 60000) {
      const expired = queue.shift();
      results.delete(expired.id);
      const msg = "⌛ Команда отменена: истекло время ожидания ПК.";
      deviceBot.api.sendMessage(expired.chatId, msg).catch(() => {});
    }
    let command = touchpad.activeUntil > now ? takeTouchpadCommand() : null;
    const item = command ? null : queue.shift();
    if (!command && item) command = { id: item.id, action: item.action, args: item.args };
    if (command || touchpad.activeUntil <= now) {
      sendJson(res, 200, { ok: true, command, touchpadActive: touchpad.activeUntil > now, pollAfterMs: touchpad.activeUntil > now ? 0 : 1800 });
      return true;
    }
    // Keep one request open; incoming touch movement wakes the agent immediately.
    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => {
      pollWaiters.delete(waiter);
      if (!res.writableEnded) sendJson(res, 200, { ok: true, command: null, touchpadActive: touchpad.activeUntil > Date.now(), pollAfterMs: 0 });
    }, touchpad.activeUntil > Date.now() ? 900 : 20000);
    pollWaiters.add(waiter);
    res.on("close", () => { clearTimeout(waiter.timer); pollWaiters.delete(waiter); });
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

module.exports = { installDeviceBridge, handleDeviceHttp, queueVoiceAction };
