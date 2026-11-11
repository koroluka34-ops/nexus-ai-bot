"use strict";

const crypto = require("node:crypto");
const { InlineKeyboard } = require("grammy");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID || "";
const locks = new Set();

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
  try {
    const value = await bot.api.callApi("getMyStarBalance", {});
    return Number(value?.amount || 0);
  } catch (error) {
    console.warn("NEXUS roulette balance check:", error.message);
    return 0;
  }
}
const PRIZES = [
  { id: "telegram_premium_3m", label: "Telegram Premium · 3 месяца", short: "3 месяца Premium", weight: 100, probability: "0,01%", type: "telegram_premium" },
  { id: "nexus_premium_7d", label: "NEXUS Premium · 7 дней", short: "Premium 7 дней", weight: 4900, probability: "0,49%", type: "nexus_premium", days: 7 },
  { id: "nexus_premium_3d", label: "NEXUS Premium · 3 дня", short: "Premium 3 дня", weight: 20000, probability: "2%", type: "nexus_premium", days: 3 },
  { id: "bonus_50", label: "50 дополнительных AI-запросов", short: "+50 AI-запросов", weight: 75000, probability: "7,5%", type: "bonus", amount: 50 },
  { id: "bonus_25", label: "25 дополнительных AI-запросов", short: "+25 AI-запросов", weight: 150000, probability: "15%", type: "bonus", amount: 25 },
  { id: "bonus_10", label: "10 дополнительных AI-запросов", short: "+10 AI-запросов", weight: 250000, probability: "25%", type: "bonus", amount: 10 },
  { id: "try_tomorrow", label: "Сегодня без приза. Попробуй завтра!", short: "Попробуй завтра", weight: 500000, probability: "50%", type: "none" }
];
function choosePrize(grandPrizeAvailable) {
  const roll = crypto.randomInt(0, 1000000);
  let cursor = 0;
  for (const prize of PRIZES) {
    cursor += prize.weight;
    if (roll < cursor) {
      if (prize.type === "telegram_premium" && !grandPrizeAvailable) {
        return PRIZES[PRIZES.length - 1];
      }
      return prize;
    }
  }
  return PRIZES[PRIZES.length - 1];
}
function publicPrize(prize) {
  return { id: prize.id, label: prize.label, short: prize.short, probability: prize.probability };
}
function makeWebAppUrl() {
  const configured = process.env.NEXUS_WEBAPP_URL || process.env.WEBAPP_URL || "";
  const host = process.env.RENDER_EXTERNAL_HOSTNAME || "";
  const raw = configured || (host ? "https://" + host : "");
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.toString().replace(/\/$/, "") + "/roulette" : "";
  } catch { return ""; }
}
function installRoulette(bot, memoryApi) {
  const webAppUrl = makeWebAppUrl();
  const openKeyboard = () => webAppUrl
    ? new InlineKeyboard().webApp("🎰 Открыть рулетку", webAppUrl)
    : new InlineKeyboard().text("⚠️ Рулетка пока не настроена", "roulette_not_configured");

  bot.command("roulette", async ctx => {
    if (!webAppUrl) return ctx.reply("🎰 Для Mini App настрой NEXUS_WEBAPP_URL или проверь RENDER_EXTERNAL_HOSTNAME.");
    return ctx.reply("🎰 <b>NEXUS DAILY ROULETTE</b>\n\nОдна бесплатная попытка каждый день. Главный приз — настоящая подписка Telegram Premium на 3 месяца.\n\nВероятность главного приза: 0,01%.", {
      parse_mode: "HTML", reply_markup: openKeyboard()
    });
  });
  bot.callbackQuery("menu_roulette", async ctx => {
    await ctx.answerCallbackQuery();
    if (!webAppUrl) return ctx.reply("🎰 Mini App не настроен. Добавь NEXUS_WEBAPP_URL в переменные Render.");
    return ctx.reply("🎰 <b>NEXUS DAILY ROULETTE</b>\nОдна бесплатная попытка в сутки.", {
      parse_mode: "HTML", reply_markup: openKeyboard()
    });
  });
  bot.callbackQuery("roulette_not_configured", async ctx => {
    await ctx.answerCallbackQuery({ text: "Нужно настроить адрес Mini App в Render.", show_alert: true });
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
      const state = await readState(user.id);
      const today = kyivDay();
      const canSpin = state.lastSpinDay !== today;
      const balance = await getStarBalance(bot);
      if (req.method === "GET" && url.pathname === "/roulette/api/status") {
        json(res, 200, {
          ok: true, canSpin, lastSpinDay: state.lastSpinDay,
          grandPrizeAvailable: balance >= 1000,
          grandPrizeText: balance >= 1000 ? "Главный приз активен" : "Главный приз временно отключён",
          lastResult: state.history.at(-1) || null
        });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/roulette/api/spin") {
        if (locks.has(String(user.id))) { json(res, 409, { ok: false, error: "Рулетка уже обрабатывает твою попытку." }); return true; }
        locks.add(String(user.id));
        try {
          const fresh = await readState(user.id);
          if (fresh.lastSpinDay === today) {
            json(res, 409, { ok: false, error: "Сегодня ты уже использовал бесплатную попытку.", canSpin: false });
            return true;
          }
          const prize = choosePrize(balance >= 1000);
          const spinId = crypto.randomUUID();
          const row = { spinId, day: today, prize: prize.id, label: prize.label, status: "processing", at: Date.now() };
          fresh.lastSpinDay = today;
          fresh.history.push(row);
          fresh.history = fresh.history.slice(-30);
          await writeState(user.id, fresh);

          let delivered = false, deliveryMessage = "";
          try {
            if (prize.type === "telegram_premium") {
              await bot.api.callApi("giftPremiumSubscription", {
                user_id: user.id, month_count: 3, star_count: 1000,
                text: "Поздравляем! Ты выиграл Telegram Premium на 3 месяца в NEXUS Roulette 🎉"
              });
              delivered = true;
            } else if (prize.type === "nexus_premium" || prize.type === "bonus") {
              await memoryApi.grantPrize(user.id, prize, spinId);
              delivered = true;
            } else {
              delivered = true;
            }
          } catch (error) {
            deliveryMessage = String(error.message || error).slice(0, 300);
            console.error("NEXUS roulette reward delivery:", user.id, prize.id, deliveryMessage);
          }
          row.status = delivered ? "delivered" : "pending";
          row.deliveryMessage = deliveryMessage;
          await writeState(user.id, fresh);
          json(res, 200, {
            ok: true, canSpin: false, spinId,
            prize: publicPrize(prize),
            delivered,
            message: delivered
              ? (prize.type === "telegram_premium" ? "Telegram отправил тебе настоящую Premium-подписку на 3 месяца." : prize.type === "none" ? "В этот раз без приза. Новая попытка будет завтра." : "Приз успешно добавлен в твой аккаунт NEXUS.")
              : "Приз выпал, но его выдача ожидает проверки. Напиши /paysupport — повторно крутить колесо не нужно."
          });
          return true;
        } finally {
          locks.delete(String(user.id));
        }
      }
      json(res, 404, { ok: false, error: "Маршрут не найден." });
      return true;
    } catch (error) {
      console.error("NEXUS roulette HTTP:", error.message);
      json(res, 500, { ok: false, error: "Не удалось обработать рулетку. Попробуй позже." });
      return true;
    }
  }
  return { handleHttp, webAppUrl };
}
module.exports = { installRoulette };
