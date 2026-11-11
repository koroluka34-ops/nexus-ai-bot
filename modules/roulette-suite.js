"use strict";

const crypto = require("node:crypto");
const { InlineKeyboard } = require("grammy");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID || "";
const locks = new Set();
const NO_PRIZE_WEIGHT = 499900;
const PLUS_WEIGHT = 5000; // 0.50%
const ULTRA_WEIGHT = 2000; // 0.20%
const GIFT_TOTAL_WEIGHT = 493000; // 49.30%, split between currently affordable gifts
const TELEGRAM_PREMIUM_WEIGHT = 100; // 0.01%, 12 months
const MAX_GIFTS_IN_WHEEL = 20;

function kvReady() { return Boolean(ACCOUNT && TOKEN && NAMESPACE); }
function kvUrl(userId) {
  return "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(ACCOUNT) +
    "/storage/kv/namespaces/" + encodeURIComponent(NAMESPACE) +
    "/values/" + encodeURIComponent("nexus:roulette:" + userId);
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
  if (r.status === 404) return { lastSpinDay: "", history: [] };
  if (!r.ok) throw new Error("Cloudflare KV HTTP " + r.status);
  const value = JSON.parse(await r.text());
  return {
    lastSpinDay: String(value.lastSpinDay || ""),
    history: Array.isArray(value.history) ? value.history.slice(-30) : []
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
    .filter(g => g && typeof g.id === "string" && Number(g.star_count) >= 15 && Number(g.star_count) <= 500)
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
  const prizes = [
    { id: "telegram_premium_12m", label: "⭐ Telegram Premium · 12 месяцев", short: "Telegram Premium", probability: premiumAvailable ? "0,01%" : "Пока недоступен", type: "telegram_premium", cost: 2500, available: premiumAvailable, weight: premiumAvailable ? TELEGRAM_PREMIUM_WEIGHT : 0 },
    { id: "nexus_plus", label: "💎 NEXUS Premium · 30 дней", short: "NEXUS Premium", probability: "0,5%", type: "nexus_plus", cost: 0, weight: PLUS_WEIGHT },
    { id: "nexus_ultra", label: "🚀 NEXUS Ultra · 30 дней", short: "NEXUS Ultra", probability: "0,20%", type: "nexus_ultra", cost: 0, weight: ULTRA_WEIGHT },
    { id: "telegram_gift_random", label: "🧸 Случайный подарок Telegram · 15–500 ⭐", short: "Мишка · 15–500 ⭐", probability: "49,3%", type: "gift_random", cost: 0, available: true, weight: GIFT_TOTAL_WEIGHT },
    { id: "no_prize", label: "Сегодня без приза. Попробуй завтра!", short: "Без приза", probability: premiumAvailable ? "49,99%" : "50%", type: "none", cost: 0, weight: NO_PRIZE_WEIGHT + (premiumAvailable ? 0 : TELEGRAM_PREMIUM_WEIGHT) }
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
function installRoulette(bot, { grantPrize } = {}) {
  const webAppUrl = makeWebAppUrl();
  let queueWorkerRunning = false;
  async function processPendingGiftQueue() {
    if (queueWorkerRunning || !kvReady()) return;
    queueWorkerRunning = true;
    try {
      let queue = await readPendingQueue();
      if (!queue.length) return;
      let balance = await getStarBalance();
      const catalog = await telegramApi("getAvailableGifts");
      const gifts = (Array.isArray(catalog?.gifts) ? catalog.gifts : [])
        .filter(g => g && typeof g.id === "string" && Number(g.star_count) >= 15 && Number(g.star_count) <= 500)
        .filter(g => g.remaining_count === undefined || Number(g.remaining_count) > 0);
      for (const item of [...queue]) {
        // If the catalog was empty at spin time, select a real gift only when
        // it becomes available and the bot can afford it.
        let gift = item.giftId ? gifts.find(g => g.id === item.giftId) : null;
        if (!gift && !item.giftId) {
          const affordable = gifts.filter(g => Number(g.star_count) <= balance);
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
    return ctx.reply("🎁 <b>NEXUS GIFT ROULETTE</b>\n\nОдна бесплатная попытка каждый день. При выигрыше бот отправит настоящий Telegram-подарок прямо в этот чат. Сектор с мишкой выдаёт случайный настоящий подарок стоимостью 15–500 ⭐, если он доступен на балансе бота.", {
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

    try {
      if (req.method === "GET" && url.pathname === "/roulette/api/status") {
        const [state, catalog] = await Promise.all([readState(user.id), getGiftCatalog(bot)]);
        const canSpin = state.lastSpinDay !== kyivDay();
        json(res, 200, {
          ok: true, canSpin, lastSpinDay: state.lastSpinDay,
          balance: catalog.balance,
          giftsAvailable: catalog.gifts.length,
          prizes: catalog.prizes.map(publicPrize),
          unavailableReason: catalog.gifts.length ? "" : "Нет доступных подарков стоимостью 15–500 ⭐ или не хватает Stars на балансе бота.",
          lastResult: state.history.at(-1) || null
        });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/roulette/api/spin") {
        await readBody(req);
        if (locks.has(String(user.id))) { json(res, 409, { ok: false, error: "Рулетка уже обрабатывает твою попытку." }); return true; }
        locks.add(String(user.id));
        try {
          const [fresh, catalog] = await Promise.all([readState(user.id), getGiftCatalog(bot)]);
          const today = kyivDay();
          if (fresh.lastSpinDay === today) {
            json(res, 409, { ok: false, error: "Сегодня ты уже использовал бесплатную попытку.", canSpin: false });
            return true;
          }
          
          let prize = choosePrize(catalog.prizes);
          // A single teddy-bear wheel sector resolves to a random real Telegram gift.
          if (prize.type === "gift_random") {
            const wheelIndex = prize.wheelIndex;
            const selectedGift = catalog.gifts.length
              ? catalog.gifts[crypto.randomInt(0, catalog.gifts.length)]
              : null;
            // Keep the win even if Telegram currently returns no eligible gifts.
            // The queue worker will choose a real 15–500 ⭐ gift after it appears.
            prize = selectedGift
              ? { ...selectedGift, wheelIndex, sectorId: "telegram_gift_random" }
              : {
                  id: "gift:pending-random",
                  giftId: "",
                  label: "🧸 Подарок Telegram · 15–500 ⭐",
                  short: "Мишка · подарок ожидает",
                  type: "gift",
                  cost: 0,
                  wheelIndex,
                  sectorId: "telegram_gift_random"
                };
          }
          const spinId = crypto.randomUUID();
          const row = {
            spinId, day: today, prize: prize.id, label: prize.label,
            giftId: prize.giftId || "", cost: prize.cost || 0,
            status: "processing", at: Date.now()
          };
          fresh.lastSpinDay = today;
          fresh.history.push(row);
          fresh.history = fresh.history.slice(-30);
          await writeState(user.id, fresh);

          let delivered = false, deliveryMessage = "";
          if (prize.type === "gift") {
            const queue = await readPendingQueue();
            if (!queue.some(item => item.spinId === spinId)) {
              queue.push({ spinId, userId: user.id, giftId: prize.giftId || "", cost: prize.cost || 0, createdAt: Date.now() });
              await writePendingQueue(queue);
            }
            await processPendingGiftQueue();
            const refreshed = await readState(user.id);
            const savedRow = refreshed.history.find(item => item.spinId === spinId);
            delivered = savedRow?.status === "delivered";
            if (!delivered) deliveryMessage = "Подарок сохранён в очереди. Бот отправит его автоматически, когда на балансе появятся нужные Stars.";
          } else try {
            if (prize.type === "telegram_premium") {
              await telegramApi("giftPremiumSubscription", { user_id: user.id, month_count: 12, star_count: 2500, text: "Ты выиграл Telegram Premium на 12 месяцев в NEXUS!" });
              delivered = true;
            } else if (prize.type === "nexus_plus" || prize.type === "nexus_ultra") {
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
          row.status = delivered ? "delivered" : "pending";
          row.deliveryMessage = deliveryMessage;
          await writeState(user.id, fresh);
          json(res, 200, {
            ok: true, canSpin: false, spinId,
            prize: publicPrize(prize),
            prizeIndex: prize.wheelIndex,
            delivered,
            message: delivered
              ? (prize.type === "gift" ? "🎁 Настоящий Telegram-подарок отправлен тебе в личный чат с ботом!" : prize.type === "nexus_plus" ? "💎 Тебе выдан NEXUS Premium на 30 дней!" : prize.type === "nexus_ultra" ? "🚀 Тебе выдан NEXUS Ultra на 30 дней!" : prize.type === "telegram_premium" ? "⭐ Telegram Premium на 12 месяцев отправлен тебе! Бот списал 2500 Stars." : "Сегодня без приза. Новая попытка будет завтра.")
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
