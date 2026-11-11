"use strict";

const crypto = require("node:crypto");
const { InlineKeyboard } = require("grammy");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID || "";
const locks = new Set();
const NO_PRIZE_WEIGHT = 500000;
const MAX_GIFTS_IN_WHEEL = 6;

function kvReady() { return Boolean(ACCOUNT && TOKEN && NAMESPACE); }
function kvUrl(userId) {
  return "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(ACCOUNT) +
    "/storage/kv/namespaces/" + encodeURIComponent(NAMESPACE) +
    "/values/" + encodeURIComponent("nexus:roulette:" + userId);
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
async function getStarBalance(bot) {
  const value = await bot.api.callApi("getMyStarBalance", {});
  return Number(value?.amount || 0);
}
async function getGiftCatalog(bot) {
  const [balance, result] = await Promise.all([
    getStarBalance(bot),
    bot.api.callApi("getAvailableGifts", {})
  ]);
  const gifts = Array.isArray(result?.gifts) ? result.gifts : [];
  const available = gifts
    .filter(g => g && typeof g.id === "string" && Number(g.star_count) > 0)
    .filter(g => g.remaining_count === undefined || Number(g.remaining_count) > 0)
    .filter(g => Number(g.star_count) <= balance)
    .sort((a, b) => Number(a.star_count) - Number(b.star_count))
    .slice(0, MAX_GIFTS_IN_WHEEL)
    .map(g => ({
      id: "gift:" + g.id,
      giftId: g.id,
      label: (g.sticker?.emoji ? g.sticker.emoji + " " : "🎁 ") + "Подарок · " + Number(g.star_count) + " ⭐",
      short: (g.sticker?.emoji || "🎁") + " " + Number(g.star_count) + " ⭐",
      probability: "",
      type: "gift",
      cost: Number(g.star_count)
    }));
  const chanceEach = available.length ? (50 / available.length) : 0;
  for (const gift of available) gift.probability = chanceEach.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + "%";
  const prizes = [...available, {
    id: "no_prize", label: "Сегодня без подарка. Попробуй завтра!", short: "Попробуй завтра",
    probability: "50%", type: "none", cost: 0
  }];
  return { balance, gifts: available, prizes };
}
function choosePrize(gifts) {
  if (!gifts.length || crypto.randomInt(0, 1000000) < NO_PRIZE_WEIGHT) {
    return { id: "no_prize", label: "Сегодня без подарка. Попробуй завтра!", short: "Попробуй завтра", probability: "50%", type: "none", cost: 0 };
  }
  return gifts[crypto.randomInt(0, gifts.length)];
}
function publicPrize(prize) {
  return { id: prize.id, label: prize.label, short: prize.short, probability: prize.probability, type: prize.type, cost: prize.cost || 0 };
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
function installRoulette(bot) {
  const webAppUrl = makeWebAppUrl();
  const openKeyboard = () => webAppUrl
    ? new InlineKeyboard().webApp("🎁 Открыть рулетку подарков", webAppUrl)
    : new InlineKeyboard().text("⚠️ Рулетка пока не настроена", "roulette_not_configured");

  bot.command("roulette", async ctx => {
    if (!webAppUrl) return ctx.reply("🎁 Для Mini App настрой NEXUS_WEBAPP_URL или проверь RENDER_EXTERNAL_HOSTNAME.");
    return ctx.reply("🎁 <b>NEXUS GIFT ROULETTE</b>\n\nОдна бесплатная попытка каждый день. При выигрыше бот отправит настоящий Telegram-подарок прямо в этот чат. Подарки доступны, пока на балансе бота хватает Stars.", {
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
      const catalog = await getGiftCatalog(bot);
      const cheapest = catalog.gifts[0];
      return ctx.reply(
        "⭐ Баланс Stars бота: <b>" + catalog.balance + " ⭐</b>\n" +
        "🎁 Доступно подарков для рулетки: <b>" + catalog.gifts.length + "</b>\n" +
        (cheapest ? "Самый дешёвый доступный подарок: <b>" + cheapest.cost + " ⭐</b>" : "Пока нет подарков, которые можно оплатить с текущего баланса.") +
        "\n\nПодарки отправляются через официальный Bot API. Получатель может показать их в профиле, но подарок от бота нельзя обменять на Stars.",
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
    if (!url.pathname.startsWith("/roulette/api/")) return false;
    const initData = String(req.headers["x-telegram-init-data"] || "");
    const user = verifyInitData(initData);
    if (!user) { json(res, 401, { ok: false, error: "Сессия Telegram недействительна. Закрой и заново открой Mini App из бота." }); return true; }
    if (!kvReady()) { json(res, 503, { ok: false, error: "Cloudflare KV не настроен — рулетка временно недоступна." }); return true; }

    try {
      if (req.method === "GET" && url.pathname === "/roulette/api/status") {
        const [state, catalog] = await Promise.all([readState(user.id), getGiftCatalog(bot)]);
        const canSpin = state.lastSpinDay !== kyivDay() && catalog.gifts.length > 0;
        json(res, 200, {
          ok: true, canSpin, lastSpinDay: state.lastSpinDay,
          balance: catalog.balance,
          giftsAvailable: catalog.gifts.length,
          prizes: catalog.prizes.map(publicPrize),
          unavailableReason: catalog.gifts.length ? "" : "На балансе бота пока недостаточно Stars для доступных подарков.",
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
          if (!catalog.gifts.length) {
            json(res, 503, { ok: false, error: "Сейчас нет доступных подарков: на балансе бота недостаточно Stars. Попробуй позже.", canSpin: false });
            return true;
          }
          const prize = choosePrize(catalog.gifts);
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
          try {
            if (prize.type === "gift") {
              await bot.api.callApi("sendGift", {
                user_id: user.id,
                gift_id: prize.giftId,
                text: "Поздравляем! Ты выиграл этот подарок в NEXUS Gift Roulette 🎉"
              });
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
            delivered,
            message: delivered
              ? (prize.type === "gift" ? "🎁 Настоящий Telegram-подарок отправлен тебе в личный чат с ботом!" : "Сегодня без подарка. Новая попытка будет завтра.")
              : "Подарок выпал, но Telegram не подтвердил отправку. Выигрыш сохранён для проверки — напиши /paysupport, повторно крутить не нужно."
          });
          return true;
        } finally {
          locks.delete(String(user.id));
        }
      }
      json(res, 404, { ok: false, error: "Маршрут не найден." });
      return true;
    } catch (error) {
      console.error("NEXUS gift roulette HTTP:", error.message);
      json(res, 500, { ok: false, error: "Не удалось обработать рулетку. Попробуй позже." });
      return true;
    }
  }
  return { handleHttp, webAppUrl };
}
module.exports = { installRoulette };
