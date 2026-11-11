"use strict";

const crypto = require("node:crypto");
const { InlineKeyboard } = require("grammy");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID || "";
const locks = new Set();
const NO_PRIZE_WEIGHT = 612700;
const PLUS_WEIGHT = 5000; // 0.50%
const ULTRA_WEIGHT = 2000; // 0.20%
const GIFT_TOTAL_WEIGHT = 380000; // 38.00%, split between eligible gifts
const TELEGRAM_PREMIUM_WEIGHT = 100; // 0.01%, 12 months
const JACKPOT_WEIGHT = 100; // 0.01%, exact 1000-Star Telegram gift
const SECRET_WEIGHT = 100; // 0.01%, hidden gift prize
const MAX_GIFTS_IN_WHEEL = 20;

function kvReady() { return Boolean(ACCOUNT && TOKEN && NAMESPACE); }
function kvUrl(userId) {
  return "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(ACCOUNT) +
    "/storage/kv/namespaces/" + encodeURIComponent(NAMESPACE) +
    "/values/" + encodeURIComponent("nexus:roulette:" + userId);
}
function globalUrl(key) {
  return "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(ACCOUNT) +
    "/storage/kv/namespaces/" + encodeURIComponent(NAMESPACE) +
    "/values/" + encodeURIComponent("nexus:roulette:global:" + key);
}
async function readGlobal(key, fallback) {
  const r = await fetch(globalUrl(key), { headers: { Authorization: "Bearer " + TOKEN }, signal: AbortSignal.timeout(9000) });
  if (r.status === 404) return fallback;
  if (!r.ok) throw new Error("Cloudflare KV global HTTP " + r.status);
  return JSON.parse(await r.text());
}
async function writeGlobal(key, value) {
  const r = await fetch(globalUrl(key), { method: "PUT", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(value), signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error("Cloudflare KV global write HTTP " + r.status);
}
function queueUrl() {
  return "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(ACCOUNT) +
    "/storage/kv/namespaces/" + encodeURIComponent(NAMESPACE) +
    "/values/nexus:roulette:pending-gifts";
}
async function readPendingQueue() {
  const r = await fetch(queueUrl(), { headers: { Authorization: "Bearer " + TOKEN }, signal: AbortSignal.timeout(9000) });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error("Cloudflare KV queue HTTP " + r.status);
  const value = JSON.parse(await r.text());
  return Array.isArray(value) ? value : [];
}
async function writePendingQueue(queue) {
  const r = await fetch(queueUrl(), {
    method: "PUT",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(queue),
    signal: AbortSignal.timeout(9000)
  });
  if (!r.ok) throw new Error("Cloudflare KV queue write HTTP " + r.status);
}
async function readState(userId) {
  if (!kvReady()) throw new Error("Cloudflare KV не настроен.");
  const r = await fetch(kvUrl(userId), {
    headers: { Authorization: "Bearer " + TOKEN },
    signal: AbortSignal.timeout(9000)
  });
  if (r.status === 404) return { lastSpinDay: "", bonusSpins: 0, history: [], streak: 0, lastStreakDay: "" };
  if (!r.ok) throw new Error("Cloudflare KV HTTP " + r.status);
  const value = JSON.parse(await r.text());
  return {
    lastSpinDay: String(value.lastSpinDay || ""),
    bonusSpins: Math.max(0, Math.min(100000, Math.floor(Number(value.bonusSpins) || 0))),
    history: Array.isArray(value.history) ? value.history.slice(-100) : [],
    streak: Math.max(0, Math.min(3650, Math.floor(Number(value.streak) || 0))),
    lastStreakDay: String(value.lastStreakDay || "")
  };
}
async function writeState(userId, state) {
  const r = await fetch(kvUrl(userId), {
    method: "PUT",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(state),
    signal: AbortSignal.timeout(9000)
  });
  if (!r.ok) throw new Error("Cloudflare KV HTTP " + r.status);
}
function kyivDay() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
}
function verifyInitData(initData) {
  if (!BOT_TOKEN || !initData || initData.length > 10000) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const userRaw = params.get("user");
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isFinite(authDate) || !userRaw) return null;
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > 86400) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + "=" + v).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const expected = crypto.createHmac("sha256", secret).update(check).digest("hex");
  const a = Buffer.from(expected, "hex"), b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const user = JSON.parse(userRaw);
    if (!Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) return null;
    return { id: Number(user.id), firstName: String(user.first_name || "").slice(0, 80) };
  } catch { return null; }
}
function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(data));
}
function readBody(req, limit = 12000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Слишком большой запрос."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(new Error("Некорректный JSON.")); }
    });
    req.on("error", reject);
  });
}
async function telegramApi(method, payload = {}) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN не настроен.");
  const response = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const description = String(data.description || ("Telegram API HTTP " + response.status));
    const error = new Error(description);
    error.error_code = data.error_code || response.status;
    throw error;
  }
  return data.result;
}
async function getStarBalance() {
  const value = await telegramApi("getMyStarBalance");
  return Number(value?.amount || 0);
}
async function getGiftCatalog(bot) {
  const balance = await getStarBalance();
  const result = await telegramApi("getAvailableGifts");
  const gifts = Array.isArray(result?.gifts) ? result.gifts : [];
  // Keep the complete eligible pool. The wheel has one teddy-bear sector;
  // the actual gift is selected randomly only after that sector wins.
  const available = gifts
    .filter(g => g && typeof g.id === "string" && Number(g.star_count) >= 15 && Number(g.star_count) <= 1000)
    .filter(g => g.remaining_count === undefined || Number(g.remaining_count) > 0)
    .map(g => ({
      id: "gift:" + g.id,
      giftId: g.id,
      label: (g.sticker?.emoji ? g.sticker.emoji + " " : "🎁 ") + "Подарок Telegram · " + Number(g.star_count) + " ⭐",
      short: (g.sticker?.emoji || "🎁") + " " + Number(g.star_count) + " ⭐",
      stickerFileId: g.sticker?.thumbnail?.file_id || g.sticker?.file_id || "",
      stickerFormat: g.sticker?.format || "",
      probability: "",
      type: "gift",
      cost: Number(g.star_count)
    }));
  const premiumAvailable = balance >= 2500;
  const settings = await readGlobal("settings", { giftPercent: 38 });
  const giftPercent = Math.max(1, Math.min(90, Number(settings.giftPercent) || 38));
  const giftWeight = Math.round(giftPercent * 10000);
  const noPrizeWeight = 1000000 - giftWeight - PLUS_WEIGHT - ULTRA_WEIGHT - TELEGRAM_PREMIUM_WEIGHT - JACKPOT_WEIGHT - SECRET_WEIGHT;
  const prizes = [
    { id: "telegram_premium_12m", label: "⭐ Telegram Premium · 12 месяцев", short: "Telegram Premium", probability: "0,01%", type: "telegram_premium", cost: 2500, available: true, weight: TELEGRAM_PREMIUM_WEIGHT },
    { id: "jackpot_1000", label: "💎 ДЖЕКПОТ · Telegram-подарок за 1000 ⭐", short: "ДЖЕКПОТ · 1000 ⭐", probability: "0,01%", type: "jackpot", cost: 1000, available: true, weight: JACKPOT_WEIGHT },
    { id: "secret_gift", label: "🎁 Секретный подарок", short: "Секретный приз", probability: "0,01%", type: "secret", cost: 0, available: true, weight: SECRET_WEIGHT },
    { id: "nexus_plus", label: "💎 NEXUS Premium · 30 дней", short: "NEXUS Premium", probability: "0,5%", type: "nexus_plus", cost: 0, weight: PLUS_WEIGHT },
    { id: "nexus_ultra", label: "🚀 NEXUS Ultra · 30 дней", short: "NEXUS Ultra", probability: "0,20%", type: "nexus_ultra", cost: 0, weight: ULTRA_WEIGHT },
    { id: "telegram_gift_random", label: "🧸 Случайный подарок Telegram · 15–1000 ⭐", short: "Мишка · 15–1000 ⭐", probability: giftPercent.toLocaleString("ru-RU") + "%", type: "gift_random", cost: 0, available: true, weight: giftWeight },
    { id: "no_prize", label: "Сегодня без приза. Попробуй завтра!", short: "Без приза", probability: (noPrizeWeight / 10000).toLocaleString("ru-RU") + "%", type: "none", cost: 0, weight: noPrizeWeight }
  ];
  return { balance, gifts: available, prizes };
}
function choosePrize(prizes) {
  const total = prizes.reduce((sum, prize) => sum + (Number(prize.weight) || 0), 0);
  let ticket = crypto.randomInt(0, total);
  for (let index = 0; index < prizes.length; index++) {
    ticket -= Number(prizes[index].weight) || 0;
    if (ticket < 0) return { ...prizes[index], wheelIndex: index };
  }
  return { ...prizes[prizes.length - 1], wheelIndex: prizes.length - 1 };
}
function publicPrize(prize) {
  return { id: prize.id, label: prize.label, short: prize.short, probability: prize.probability, type: prize.type, cost: prize.cost || 0, available: prize.available !== false, imageUrl: prize.type === "gift" && prize.stickerFileId ? "/roulette/api/gift-image/" + encodeURIComponent(prize.giftId) : prize.type === "gift_random" ? "/assets/teddy-bear.svg" : prize.type === "telegram_premium" ? "/assets/telegram-premium.svg" : prize.type === "nexus_plus" ? "/assets/nexus-premium.svg" : prize.type === "nexus_ultra" ? "/assets/nexus-ultra.svg" : "" };
}
function makeWebAppUrl() {
  const configured = process.env.NEXUS_WEBAPP_URL || process.env.WEBAPP_URL || "";
  const host = process.env.RENDER_EXTERNAL_HOSTNAME || "";
  const raw = configured || (host ? "https://" + host : "");
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? (u.pathname.replace(/\/$/, "") === "/roulette" ? u.toString() : u.toString().replace(/\/$/, "") + "/roulette") : "";
  } catch { return ""; }
}
function installRoulette(bot, { grantPrize, isAdmin, resolveUsername } = {}) {
  const webAppUrl = makeWebAppUrl();
  let queueWorkerRunning = false;
  async function processPendingGiftQueue() {
    if (queueWorkerRunning || !kvReady()) return;
    queueWorkerRunning = true;
    try {
      let queue = await readPendingQueue();
      if (!queue.length) return;
      let balance = await getStarBalance();
      const premiumQueue = queue.filter(item => item.type === "telegram_premium");
      for (const item of premiumQueue) {
        if (balance < 2500) continue;
        try {
          await telegramApi("giftPremiumSubscription", {
            user_id: Number(item.userId),
            month_count: 12,
            star_count: 2500,
            text: "Ты выиграл Telegram Premium на 12 месяцев в NEXUS!"
          });
          balance = Math.max(0, balance - 2500);
          queue = queue.filter(q => q.spinId !== item.spinId);
          await writePendingQueue(queue);
          const state = await readState(item.userId);
          const row = state.history.find(h => h.spinId === item.spinId);
          if (row) {
            row.status = "delivered";
            row.deliveryMessage = "";
            row.deliveredAt = Date.now();
            await writeState(item.userId, state);
          }
          await bot.api.sendMessage(Number(item.userId), "⭐ Твой выигранный Telegram Premium на 12 месяцев оформлен! Поздравляем! 🎉").catch(() => {});
        } catch (error) {
          console.error("NEXUS pending Telegram Premium:", item.spinId, String(error.message || error).slice(0, 200));
        }
      }
      const catalog = await telegramApi("getAvailableGifts");
      const gifts = (Array.isArray(catalog?.gifts) ? catalog.gifts : [])
        .filter(g => g && typeof g.id === "string" && Number(g.star_count) >= 15 && Number(g.star_count) <= 1000)
        .filter(g => g.remaining_count === undefined || Number(g.remaining_count) > 0);
      for (const item of [...queue].filter(entry => entry.type !== "telegram_premium")) {
        // If the catalog was empty at spin time, select a real gift only when
        // it becomes available and the bot can afford it.
        let gift = item.giftId ? gifts.find(g => g.id === item.giftId) : null;
        if (!gift && !item.giftId) {
          const eligible = item.type === "jackpot" ? gifts.filter(g => Number(g.star_count) === 1000) : gifts.filter(g => Number(g.star_count) >= 15 && Number(g.star_count) <= 999);
          const affordable = eligible.filter(g => Number(g.star_count) <= balance);
          if (affordable.length) gift = affordable[crypto.randomInt(0, affordable.length)];
        }
        const cost = Number(gift?.star_count || item.cost || 0);
        if (!gift || !cost || balance < cost) continue;
        try {
          await telegramApi("sendGift", {
            user_id: Number(item.userId),
            gift_id: gift.id,
            text: "Поздравляем! Твой подарок из NEXUS Gift Roulette готов — спасибо за ожидание! 🎉"
          });
          balance = Math.max(0, balance - cost);
          queue = queue.filter(q => q.spinId !== item.spinId);
          await writePendingQueue(queue);
          const state = await readState(item.userId);
          const row = state.history.find(h => h.spinId === item.spinId);
          if (row) {
            row.status = "delivered";
            row.deliveryMessage = "";
            row.deliveredAt = Date.now();
            await writeState(item.userId, state);
          }
          await bot.api.sendMessage(Number(item.userId), "🎁 Твой выигранный подарок из NEXUS Gift Roulette отправлен! Спасибо, что дождался ❤️").catch(() => {});
        } catch (error) {
          console.error("NEXUS pending gift delivery:", item.spinId, String(error.message || error).slice(0, 200));
          // Keep the item in KV; the next balance check will retry it.
        }
      }
    } catch (error) {
      console.error("NEXUS pending gift queue:", String(error.message || error).slice(0, 250));
    } finally {
      queueWorkerRunning = false;
    }
  }
  const openKeyboard = () => webAppUrl
    ? new InlineKeyboard().webApp("🎁 Открыть рулетку подарков", webAppUrl)
    : new InlineKeyboard().text("⚠️ Рулетка пока не настроена", "roulette_not_configured");

  bot.command("roulette", async ctx => {
    if (!webAppUrl) return ctx.reply("🎁 Для Mini App настрой NEXUS_WEBAPP_URL или проверь RENDER_EXTERNAL_HOSTNAME.");
    return ctx.reply("🎁 <b>NEXUS GIFT ROULETTE</b>\n\nОдна бесплатная попытка каждый день. При выигрыше бот отправит настоящий Telegram-подарок прямо в этот чат. Сектор с мишкой выдаёт случайный настоящий подарок стоимостью 15–1000 ⭐, если он доступен на балансе бота.", {
      parse_mode: "HTML", reply_markup: openKeyboard()
    });
  });
  bot.callbackQuery("menu_roulette", async ctx => {
    await ctx.answerCallbackQuery();
    if (!webAppUrl) return ctx.reply("🎁 Mini App не настроен. Добавь NEXUS_WEBAPP_URL в переменные Render.");
    return ctx.reply("🎁 <b>NEXUS GIFT ROULETTE</b>\nОдна бесплатная попытка в сутки.", {
      parse_mode: "HTML", reply_markup: openKeyboard()
    });
  });
  bot.callbackQuery("roulette_not_configured", async ctx => {
    await ctx.answerCallbackQuery({ text: "Нужно настроить адрес Mini App в Render.", show_alert: true });
  });

  bot.command("spinadd", async ctx => {
    if (typeof isAdmin !== "function" || !await isAdmin(ctx.from.id)) {
      return ctx.reply("⛔ Команда доступна только администраторам NEXUS.");
    }
    const parts = String(ctx.match || "").trim().split(/\s+/).filter(Boolean);
    const replied = ctx.message.reply_to_message?.from;
    let targetId = replied ? String(replied.id) : "";
    let amount;
    if (replied) amount = Number(parts[0]);
    else if (parts[0]?.startsWith("@")) {
      targetId = typeof resolveUsername === "function" ? await resolveUsername(parts[0]) : "";
      amount = Number(parts[1]);
      if (!targetId) return ctx.reply("Не удалось найти " + parts[0] + ". Пусть пользователь сначала напишет боту /start, или ответь на его сообщение командой /spinadd КОЛИЧЕСТВО.");
    } else {
      targetId = parts[0] || "";
      amount = Number(parts[1]);
    }
    if (!/^\d{1,20}$/.test(targetId) || !Number.isSafeInteger(Number(targetId)) ||
        !Number.isInteger(amount) || amount < 1 || amount > 10000) {
      return ctx.reply("Формат: /spinadd ID КОЛИЧЕСТВО\nПример: /spinadd 123456789 5\nМожно ответить на сообщение пользователя: /spinadd 5\nИли указать @username: /spinadd @username 5");
    }
    try {
      const state = await readState(targetId);
      state.bonusSpins = Math.min(100000, state.bonusSpins + amount);
      await writeState(targetId, state);
      await ctx.reply("✅ Выдано " + amount + " прокруток пользователю " + targetId + ".\n🎰 Всего дополнительных прокруток: " + state.bonusSpins);
      await bot.api.sendMessage(Number(targetId), "🎁 Тебе выдано " + amount + " дополнительных прокруток рулетки NEXUS! Открой /roulette.").catch(() => {});
    } catch (error) {
      return ctx.reply("❌ Не удалось выдать прокрутки: " + String(error.message || error).slice(0, 220));
    }
  });

  bot.command("roulettehistory", async ctx => {
    try {
      const state = await readState(ctx.from.id);
      if (!state.history.length) return ctx.reply("🎁 История рулетки пока пуста. Открыть: /roulette");
      const rows = state.history.slice(-10).reverse().map((item, index) =>
        (index + 1) + ". " + item.day + " — " + item.label + " [" +
        (item.status === "delivered" ? "подарок отправлен" : item.status === "pending" ? "ожидает проверки" : "обрабатывается") + "]"
      );
      return ctx.reply("🎁 <b>ИСТОРИЯ РУЛЕТКИ</b>\n\n" + rows.join("\n"), { parse_mode: "HTML" });
    } catch (error) {
      return ctx.reply("❌ Не удалось загрузить историю: " + String(error.message).slice(0, 250));
    }
  });

  bot.command("roulettewins", async ctx => {
    try {
      const userId = String(ctx.from.id);
      const queue = await readPendingQueue();
      const pending = queue.filter(item => String(item.userId) === userId);
      if (!pending.length) return ctx.reply("🎁 У тебя нет подарков, ожидающих отправки. Выигранные подарки появятся здесь, если на балансе бота пока недостаточно Stars.");
      const keyboard = new InlineKeyboard();
      const lines = pending.map((item, index) => {
        const label = item.type === "telegram_premium" ? "⭐ Telegram Premium · 12 месяцев" : (item.label || "🎁 Подарок Telegram");
        keyboard.text("❌ Отказаться от подарка №" + (index + 1), "rdecline_" + item.spinId).row();
        return (index + 1) + ". " + label + " — ожидает отправки" + (item.cost ? " (" + item.cost + " ⭐)" : "");
      });
      return ctx.reply("🎁 <b>ТВОИ ОЖИДАЮЩИЕ ПОДАРКИ</b>\n\n" + lines.join("\n") + "\n\nПодарки отправятся автоматически, когда у бота появятся нужные Stars. Чтобы отказаться, нажми кнопку под списком.", { parse_mode: "HTML", reply_markup: keyboard });
    } catch (error) { return ctx.reply("❌ Не удалось загрузить подарки: " + String(error.message || error).slice(0, 200)); }
  });

  bot.callbackQuery(/^rdecline_([a-f0-9-]{36})$/i, async ctx => {
    const spinId = ctx.match[1];
    try {
      const queue = await readPendingQueue();
      const item = queue.find(entry => entry.spinId === spinId && String(entry.userId) === String(ctx.from.id));
      if (!item) { await ctx.answerCallbackQuery({ text: "Подарок уже отправлен или удалён.", show_alert: true }); return; }
      await writePendingQueue(queue.filter(entry => entry.spinId !== spinId));
      const state = await readState(ctx.from.id);
      const row = state.history.find(entry => entry.spinId === spinId);
      if (row) { row.status = "declined"; row.deliveryMessage = "Пользователь отказался от подарка."; row.declinedAt = Date.now(); await writeState(ctx.from.id, state); }
      await ctx.answerCallbackQuery({ text: "Подарок удалён. Бот не будет его отправлять." });
      await ctx.editMessageText("❌ Ты отказался от подарка. Он удалён из очереди и не будет отправлен.");
    } catch (error) { await ctx.answerCallbackQuery({ text: "Не удалось отказаться: " + String(error.message || error).slice(0, 150), show_alert: true }); }
  });

  bot.command("rouletteevent", async ctx => {
    const adminId = String(process.env.ADMIN_ID || process.env.OWNER_ID || "");
    if (!adminId || String(ctx.from.id) !== adminId) return ctx.reply("⛔ Команда доступна только администратору.");
    const mode = String(ctx.match || "").trim().toLowerCase();
    const current = await readGlobal("event", { active: false, label: "NEXUS EVENT" });
    current.active = mode === "on" ? true : mode === "off" ? false : !current.active;
    current.updatedAt = Date.now();
    await writeGlobal("event", current);
    return ctx.reply(current.active ? "🔥 NEXUS EVENT включён: шанс подарочных секторов x2." : "⏹ NEXUS EVENT выключен.");
  });

  bot.command("rouletteodds", async ctx => {
    const adminId = String(process.env.ADMIN_ID || process.env.OWNER_ID || "");
    if (!adminId || String(ctx.from.id) !== adminId) return ctx.reply("⛔ Команда доступна только администратору.");
    const value = Number(String(ctx.match || "").trim());
    if (!Number.isFinite(value) || value < 1 || value > 90) return ctx.reply("Формат: /rouletteodds 38\nУкажи шанс обычного подарочного сектора от 1 до 90 процентов.");
    const settings = await readGlobal("settings", { giftPercent: 38 });
    settings.giftPercent = Math.round(value * 100) / 100;
    await writeGlobal("settings", settings);
    return ctx.reply("✅ Шанс обычных подарков установлен: " + settings.giftPercent + "%. Шанс «Без приза» автоматически пересчитан.");
  });

  bot.command("rouletteban", async ctx => {
    const adminId = String(process.env.ADMIN_ID || process.env.OWNER_ID || "");
    if (!adminId || String(ctx.from.id) !== adminId) return ctx.reply("⛔ Команда доступна только администратору.");
    const id = String(ctx.match || "").trim();
    if (!/^\d{1,20}$/.test(id)) return ctx.reply("Формат: /rouletteban TELEGRAM_ID");
    const blocked = await readGlobal("blocked", []);
    if (!blocked.map(String).includes(id)) blocked.push(id);
    await writeGlobal("blocked", blocked.slice(-5000));
    return ctx.reply("⛔ Доступ к рулетке заблокирован для ID " + id + ".");
  });

  bot.command("rouletteunban", async ctx => {
    const adminId = String(process.env.ADMIN_ID || process.env.OWNER_ID || "");
    if (!adminId || String(ctx.from.id) !== adminId) return ctx.reply("⛔ Команда доступна только администратору.");
    const id = String(ctx.match || "").trim();
    if (!/^\d{1,20}$/.test(id)) return ctx.reply("Формат: /rouletteunban TELEGRAM_ID");
    const blocked = await readGlobal("blocked", []);
    await writeGlobal("blocked", blocked.filter(value => String(value) !== id));
    return ctx.reply("✅ Доступ к рулетке восстановлен для ID " + id + ".");
  });

  bot.command("roulettegiftgrant", async ctx => {
    const adminId = String(process.env.ADMIN_ID || process.env.OWNER_ID || "");
    if (!adminId || String(ctx.from.id) !== adminId) return ctx.reply("⛔ Команда доступна только администратору.");
    const [userId, giftId] = String(ctx.match || "").trim().split(/\s+/);
    if (!/^\d{1,20}$/.test(userId || "") || !giftId || giftId.length > 256) return ctx.reply("Формат: /roulettegiftgrant TELEGRAM_ID GIFT_ID");
    try {
      await telegramApi("sendGift", { user_id: Number(userId), gift_id: giftId, text: "🎁 Тебе отправлен подарок от NEXUS!" });
      return ctx.reply("✅ Telegram-подарок отправлен пользователю " + userId + ".");
    } catch (error) {
      return ctx.reply("❌ Не удалось отправить подарок: " + String(error.message || error).slice(0, 220));
    }
  });

  bot.command("roulettegrant", async ctx => {
    const adminId = String(process.env.ADMIN_ID || process.env.OWNER_ID || "");
    if (!adminId || String(ctx.from.id) !== adminId) return ctx.reply("⛔ Команда доступна только администратору.");
    const [userId, kind, rawAmount] = String(ctx.match || "").trim().split(/\s+/);
    if (!/^\d{1,20}$/.test(userId || "") || !["plus", "ultra", "spin"].includes(kind)) return ctx.reply("Формат: /roulettegrant TELEGRAM_ID plus|ultra|spin [количество]");
    try {
      if (kind === "spin") {
        const amount = Math.max(1, Math.min(10000, Math.floor(Number(rawAmount) || 1)));
        const state = await readState(userId);
        state.bonusSpins = Math.min(100000, state.bonusSpins + amount);
        await writeState(userId, state);
        return ctx.reply("✅ Выдано " + amount + " прокруток пользователю " + userId + ".");
      }
      if (typeof grantPrize !== "function") throw new Error("Выдача подписок NEXUS не подключена.");
      await grantPrize(Number(userId), kind);
      return ctx.reply("✅ " + (kind === "ultra" ? "NEXUS Ultra" : "NEXUS Premium") + " выдан пользователю " + userId + ".");
    } catch (error) {
      return ctx.reply("❌ Не удалось выдать приз: " + String(error.message || error).slice(0, 220));
    }
  });

  bot.command("rouletteadmin", async ctx => {
    const adminId = String(process.env.ADMIN_ID || process.env.OWNER_ID || "");
    if (!adminId || String(ctx.from.id) !== adminId) return ctx.reply("⛔ Команда доступна только администратору.");
    try {
      const [balance, queue, winners, event, settings, blocked] = await Promise.all([
        getStarBalance(), readPendingQueue(), readGlobal("winners", []),
        readGlobal("event", { active: false }), readGlobal("settings", { giftPercent: 38 }),
        readGlobal("blocked", [])
      ]);
      return ctx.reply("🛠 <b>NEXUS ROULETTE ADMIN</b>\n\n⭐ Баланс: " + balance +
        "\n🎁 Ожидают выдачи: " + queue.length + "\n🏆 Выигрышей в ленте: " + winners.length +
        "\n🎯 Шанс подарков: " + settings.giftPercent + "%\n🔥 Ивент: " + (event.active ? "включён" : "выключен") +
        "\n🚫 Заблокировано: " + blocked.length, { parse_mode: "HTML" });
    } catch (error) { return ctx.reply("❌ " + String(error.message || error).slice(0, 200)); }
  });

  bot.command("roulettewinners", async ctx => {
    const winners = await readGlobal("winners", []);
    if (!winners.length) return ctx.reply("🏆 Победителей пока нет.");
    return ctx.reply("🏆 <b>ПОСЛЕДНИЕ ПОБЕДИТЕЛИ NEXUS</b>\n\n" + winners.slice(-10).reverse().map((w,i) => (i+1)+". "+String(w.name||"Игрок").replace(/[<>]/g,"")+" — "+String(w.label||"Приз").replace(/[<>]/g,"")).join("\n"), { parse_mode: "HTML" });
  });

  bot.command("roulettebalance", async ctx => {
    const adminId = String(process.env.ADMIN_ID || process.env.OWNER_ID || "");
    if (!adminId || String(ctx.from.id) !== adminId) return ctx.reply("⛔ Команда доступна только администратору.");
    try {
      await processPendingGiftQueue();
      const catalog = await getGiftCatalog(bot);
      const queue = await readPendingQueue();
      const cheapest = catalog.gifts[0];
      return ctx.reply(
        "⭐ Баланс Stars бота: <b>" + catalog.balance + " ⭐</b>\n" +
        "🎁 Доступно подарков для рулетки: <b>" + catalog.gifts.length + "</b>\n" +
        (cheapest ? "Самый дешёвый доступный подарок: <b>" + cheapest.cost + " ⭐</b>" : "Пока нет подарков, которые можно оплатить с текущего баланса.") +
        "\n⏳ Ожидают отправки: <b>" + queue.length + "</b>" +
        "\n\nПодарки отправляются автоматически после пополнения баланса бота. Получатель может показать их в профиле, но подарок от бота нельзя обменять на Stars.",
        { parse_mode: "HTML" }
      );
    } catch (error) {
      return ctx.reply("❌ Не удалось проверить баланс и каталог подарков: " + String(error.message).slice(0, 250));
    }
  });

  bot.command("roulettegifts", async ctx => {
    const adminId = String(process.env.ADMIN_ID || process.env.OWNER_ID || "");
    if (!adminId || String(ctx.from.id) !== adminId) return ctx.reply("⛔ Команда доступна только администратору.");
    try {
      const catalog = await getGiftCatalog(bot);
      if (!catalog.gifts.length) return ctx.reply("🎁 Сейчас нет подарков, которые можно купить с текущего баланса (" + catalog.balance + " ⭐).");
      return ctx.reply("🎁 <b>ПОДАРКИ В РУЛЕТКЕ</b>\n\n" + catalog.gifts.map((g, i) =>
        (i + 1) + ". " + g.label + " — шанс " + g.probability
      ).join("\n"), { parse_mode: "HTML" });
    } catch (error) {
      return ctx.reply("❌ Не удалось получить каталог: " + String(error.message).slice(0, 250));
    }
  });

  async function handleHttp(req, res) {
    const url = new URL(req.url, "https://nexus.local");
    if (req.method === "GET" && url.pathname === "/roulette") {
      const fs = require("node:fs/promises"), path = require("node:path");
      try {
        const page = await fs.readFile(path.join(__dirname, "..", "public", "roulette.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.end(page);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Roulette page not found");
      }
      return true;
    }
    if (req.method === "GET" && url.pathname.startsWith("/roulette/api/gift-image/")) {
      try {
        const giftId = decodeURIComponent(url.pathname.slice("/roulette/api/gift-image/".length));
        const result = await telegramApi("getAvailableGifts");
        const gift = (result?.gifts || []).find(item => item.id === giftId);
        const fileId = gift?.sticker?.thumbnail?.file_id || gift?.sticker?.file_id;
        if (!fileId) { res.writeHead(404); res.end(); return true; }
        const file = await bot.api.getFile(fileId);
        if (!file?.file_path) { res.writeHead(404); res.end(); return true; }
        const remote = await fetch("https://api.telegram.org/file/bot" + BOT_TOKEN + "/" + file.file_path);
        if (!remote.ok) { res.writeHead(502); res.end(); return true; }
        res.writeHead(200, {
          "Content-Type": remote.headers.get("content-type") || "application/octet-stream",
          "Cache-Control": "public, max-age=3600",
          "X-Content-Type-Options": "nosniff"
        });
        if (remote.body) {
          const { Readable } = require("node:stream");
          Readable.fromWeb(remote.body).pipe(res);
        } else res.end();
      } catch (error) {
        console.error("NEXUS gift sticker proxy:", error.message);
        res.writeHead(502); res.end();
      }
      return true;
    }
    if (!url.pathname.startsWith("/roulette/api/")) return false;
    const initData = String(req.headers["x-telegram-init-data"] || "");
    const user = verifyInitData(initData);
    if (!user) { json(res, 401, { ok: false, error: "Сессия Telegram недействительна. Закрой и заново открой Mini App из бота." }); return true; }
    if (!kvReady()) { json(res, 503, { ok: false, error: "Cloudflare KV не настроен — рулетка временно недоступна." }); return true; }
    const blockedUsers = await readGlobal("blocked", []);
    if (Array.isArray(blockedUsers) && blockedUsers.map(String).includes(String(user.id))) {
      json(res, 403, { ok: false, error: "Доступ к NEXUS Gift Roulette ограничен администратором." });
      return true;
    }

    try {
      if (req.method === "GET" && url.pathname === "/roulette/api/status") {
        const [state, catalog, queue] = await Promise.all([readState(user.id), getGiftCatalog(bot), readPendingQueue()]);
        const freeSpinAvailable = state.lastSpinDay !== kyivDay();
        const canSpin = freeSpinAvailable || state.bonusSpins > 0;
        const winners = await readGlobal("winners", []);
        const event = await readGlobal("event", { active: false, label: "NEXUS EVENT" });
        const collection = state.history.filter(item => item.status === "delivered" && (item.giftId || item.cost || /Premium|Ultra|подарок/i.test(item.label || ""))).slice(-30).reverse();
        const pendingGifts = queue.filter(item => String(item.userId) === String(user.id)).map(item => ({
          spinId: item.spinId,
          label: item.type === "telegram_premium" ? "⭐ Telegram Premium · 12 месяцев" : (item.label || "🎁 Подарок Telegram"),
          cost: Number(item.cost || 0), createdAt: item.createdAt || 0
        }));
        json(res, 200, {
          ok: true, canSpin, freeSpinAvailable, totalSpinsAvailable: state.bonusSpins + (freeSpinAvailable ? 1 : 0),
          lastSpinDay: state.lastSpinDay, bonusSpins: state.bonusSpins, balance: catalog.balance, streak: state.streak || 0, luckMultiplier: (state.streak >= 30 ? 5 : state.streak >= 7 ? 3 : state.streak >= 3 ? 2 : 1) * (event.active ? 2 : 1), event, collection, leaderboard: Array.isArray(winners) ? winners.slice(-10).reverse() : [],
          giftsAvailable: catalog.gifts.length, pendingGifts, prizes: catalog.prizes.map(publicPrize),
          unavailableReason: catalog.gifts.length ? "" : "Нет доступных подарков стоимостью 15–1000 ⭐ или не хватает Stars на балансе бота.",
          lastResult: state.history.at(-1) || null
        });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/roulette/api/decline") {
        const body = await readBody(req);
        const spinId = String(body.spinId || "");
        if (!/^[a-f0-9-]{36}$/i.test(spinId)) { json(res, 400, { ok: false, error: "Идентификатор подарка некорректен." }); return true; }
        const queue = await readPendingQueue();
        const item = queue.find(entry => entry.spinId === spinId && String(entry.userId) === String(user.id));
        if (!item) { json(res, 404, { ok: false, error: "Подарок уже отправлен или больше не ожидает выдачи." }); return true; }
        await writePendingQueue(queue.filter(entry => entry.spinId !== spinId));
        const state = await readState(user.id);
        const row = state.history.find(entry => entry.spinId === spinId);
        if (row) { row.status = "declined"; row.deliveryMessage = "Пользователь отказался от подарка."; row.declinedAt = Date.now(); await writeState(user.id, state); }
        json(res, 200, { ok: true, message: "Подарок удалён из ожидающих. Бот не будет его отправлять." });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/roulette/api/spin") {
        await readBody(req);
        if (locks.has(String(user.id))) { json(res, 409, { ok: false, error: "Рулетка уже обрабатывает твою попытку." }); return true; }
        locks.add(String(user.id));
        try {
          const [fresh, catalog] = await Promise.all([readState(user.id), getGiftCatalog(bot)]);
          const today = kyivDay();
          if (fresh.lastSpinDay === today && fresh.bonusSpins <= 0) {
            json(res, 409, { ok: false, error: "Сегодня ты уже использовал бесплатную попытку.", canSpin: false, bonusSpins: 0 });
            return true;
          }
          const usedBonusSpin = fresh.lastSpinDay === today;
          if (usedBonusSpin) fresh.bonusSpins = Math.max(0, fresh.bonusSpins - 1);
          else if (fresh.lastStreakDay !== today) {
            const yesterday = new Date(Date.parse(today + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
            fresh.streak = fresh.lastStreakDay === yesterday ? fresh.streak + 1 : 1;
            fresh.lastStreakDay = today;
            const streakBonus = fresh.streak === 30 ? 5 : fresh.streak === 7 ? 2 : fresh.streak === 3 ? 1 : 0;
            fresh.bonusSpins = Math.min(100000, fresh.bonusSpins + streakBonus);
          }
          
          let prizeList = catalog.prizes.map(item => ({ ...item }));
          const event = await readGlobal("event", { active: false, label: "NEXUS EVENT" });
          const streakMultiplier = fresh.streak >= 30 ? 5 : fresh.streak >= 7 ? 3 : fresh.streak >= 3 ? 2 : 1;
          const luckMultiplier = streakMultiplier * (event.active ? 2 : 1);
          if (luckMultiplier > 1) prizeList = prizeList.map(item => ({ ...item, weight: item.weight * (["gift_random", "secret", "jackpot"].includes(item.type) ? luckMultiplier : 1) }));
          let prize = choosePrize(prizeList);
          // A single teddy-bear wheel sector resolves to a random real Telegram gift.
          if (["gift_random", "secret", "jackpot"].includes(prize.type)) {
            const sourceType = prize.type;
            const wheelIndex = prize.wheelIndex;
            const eligible = sourceType === "jackpot"
              ? catalog.gifts.filter(g => g.cost === 1000)
              : catalog.gifts.filter(g => g.cost >= 15 && g.cost <= 999);
            const selectedGift = eligible.length ? eligible[crypto.randomInt(0, eligible.length)] : null;
            prize = selectedGift
              ? { ...selectedGift, label: sourceType === "jackpot" ? "💎 ДЖЕКПОТ · Telegram-подарок за 1000 ⭐" : sourceType === "secret" ? "🎁 СЕКРЕТНЫЙ ПОДАРОК · " + selectedGift.cost + " ⭐" : selectedGift.label, short: sourceType === "jackpot" ? "ДЖЕКПОТ · 1000 ⭐" : sourceType === "secret" ? "Секрет · " + selectedGift.cost + " ⭐" : selectedGift.short, wheelIndex, sectorId: sourceType === "jackpot" ? "jackpot_1000" : sourceType === "secret" ? "secret_gift" : "telegram_gift_random", type: "gift", jackpot: sourceType === "jackpot", secret: sourceType === "secret" }
              : { id: sourceType === "jackpot" ? "gift:pending-jackpot" : "gift:pending-random", giftId: "", label: sourceType === "jackpot" ? "💎 ДЖЕКПОТ · подарок за 1000 ⭐ (ожидает отправки)" : sourceType === "secret" ? "🎁 Секретный подарок (ожидает отправки)" : "🧸 Подарок Telegram · 15–999 ⭐", short: sourceType === "jackpot" ? "ДЖЕКПОТ · ожидание" : sourceType === "secret" ? "Секретный приз" : "Мишка · подарок ожидает", type: "gift", cost: sourceType === "jackpot" ? 1000 : 0, wheelIndex, sectorId: sourceType === "jackpot" ? "jackpot_1000" : sourceType === "secret" ? "secret_gift" : "telegram_gift_random", jackpot: sourceType === "jackpot", secret: sourceType === "secret" };
          }
          const spinId = crypto.randomUUID();
          const row = {
            spinId, day: today, prize: prize.id, label: prize.label,
            giftId: prize.giftId || "", cost: prize.cost || 0,
            status: "processing", at: Date.now()
          };
          fresh.lastSpinDay = today;
          fresh.history.push(row);
          fresh.history = fresh.history.slice(-100);
          await writeState(user.id, fresh);

          let delivered = false, deliveryMessage = "";
          if (prize.type === "gift" || prize.type === "telegram_premium") {
            const queue = await readPendingQueue();
            if (!queue.some(item => item.spinId === spinId)) {
              queue.push({
                spinId,
                userId: user.id,
                type: prize.type === "telegram_premium" ? "telegram_premium" : (prize.jackpot ? "jackpot" : "gift"),
                giftId: prize.giftId || "",
                label: prize.label,
                cost: prize.type === "telegram_premium" ? 2500 : (prize.cost || 0),
                createdAt: Date.now()
              });
              await writePendingQueue(queue);
            }
            await processPendingGiftQueue();
            const refreshed = await readState(user.id);
            const savedRow = refreshed.history.find(item => item.spinId === spinId);
            delivered = savedRow?.status === "delivered";
            if (!delivered) deliveryMessage = prize.type === "telegram_premium"
              ? "Telegram Premium на 12 месяцев сохранён в очереди. Бот автоматически оформит его, когда на балансе будет 2500 ⭐."
              : "Подарок сохранён в очереди. Бот отправит его автоматически, когда на балансе появятся нужные Stars.";
          } else try {
            if (prize.type === "nexus_plus" || prize.type === "nexus_ultra") {
              if (typeof grantPrize !== "function") throw new Error("Выдача NEXUS Premium не подключена.");
              await grantPrize(user.id, prize.type === "nexus_ultra" ? "ultra" : "plus");
              delivered = true;
            } else {
              delivered = true;
            }
          } catch (error) {
            deliveryMessage = String(error.message || error).slice(0, 300);
            console.error("NEXUS gift roulette delivery:", user.id, prize.id, deliveryMessage);
          }
          if (delivered && prize.type !== "none") {
            const winners = await readGlobal("winners", []);
            winners.push({ userId: user.id, name: user.firstName || "Игрок", label: prize.label, cost: prize.cost || 0, at: Date.now() });
            await writeGlobal("winners", winners.slice(-200));
          }
          const latestState = await readState(user.id);
          const latestRow = latestState.history.find(item => item.spinId === spinId);
          if (latestRow && latestRow.status !== "delivered" && latestRow.status !== "declined") {
            latestRow.status = delivered ? "delivered" : "pending";
            latestRow.deliveryMessage = deliveryMessage;
            await writeState(user.id, latestState);
          }
          json(res, 200, {
            ok: true, canSpin: fresh.bonusSpins > 0, bonusSpins: fresh.bonusSpins, totalSpinsAvailable: fresh.bonusSpins, spinId,
            prize: publicPrize(prize),
            prizeIndex: prize.wheelIndex,
            delivered,
            message: delivered
              ? (prize.type === "gift" ? "🎁 Настоящий Telegram-подарок отправлен тебе в личный чат с ботом!" : prize.type === "nexus_plus" ? "💎 Тебе выдан NEXUS Premium на 30 дней!" : prize.type === "nexus_ultra" ? "🚀 Тебе выдан NEXUS Ultra на 30 дней!" : prize.type === "telegram_premium" ? "⭐ Telegram Premium на 12 месяцев отправлен тебе! Бот списал 2500 Stars." : "Сегодня без приза. Новая попытка будет завтра.")
              : prize.type === "telegram_premium"
                ? "⭐ Telegram Premium на 12 месяцев выигран и сохранён в очереди. Бот автоматически оформит его, когда на балансе будет 2500 Stars. Повторно крутить не нужно."
                : "🧸 Мишка выигран! Подарок сохранён. Бот автоматически отправит его, когда на балансе появятся нужные Stars. Повторно крутить не нужно."
          });
          return true;
        } finally {
          locks.delete(String(user.id));
        }
      }
      json(res, 404, { ok: false, error: "Маршрут не найден." });
      return true;
    } catch (error) {
      console.error("NEXUS gift roulette HTTP:", error.stack || error.message);
      json(res, 500, { ok: false, error: "Ошибка рулетки: " + String(error.message || error).slice(0, 220) });
      return true;
    }
  }
  const queuePoller = setInterval(() => { processPendingGiftQueue().catch(() => {}); }, 60 * 1000);
  if (typeof queuePoller.unref === "function") queuePoller.unref();
  processPendingGiftQueue().catch(() => {});
  return { handleHttp, webAppUrl };
}
module.exports = { installRoulette };
