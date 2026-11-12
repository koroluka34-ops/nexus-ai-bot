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
  if (r.status === 404) return { lastSpinDay: "", bonusSpins: 0, coins: 0, history: [], streak: 0, lastStreakDay: "", claimedCodes: [], questClaims: {}, referralCount: 0, dailyQuests: null };
  if (!r.ok) throw new Error("Cloudflare KV HTTP " + r.status);
  const value = JSON.parse(await r.text());
  return {
    lastSpinDay: String(value.lastSpinDay || ""),
    bonusSpins: Math.max(0, Math.min(100000, Math.floor(Number(value.bonusSpins) || 0))),
    coins: Math.max(0, Math.min(100000000, Math.floor(Number(value.coins) || 0))),
    dailyQuests: value.dailyQuests && typeof value.dailyQuests === "object" ? value.dailyQuests : null,
    history: Array.isArray(value.history) ? value.history.slice(-100) : [],
    streak: Math.max(0, Math.min(3650, Math.floor(Number(value.streak) || 0))),
    lastStreakDay: String(value.lastStreakDay || ""),
    claimedCodes: Array.isArray(value.claimedCodes) ? value.claimedCodes.slice(-200) : [],
    questClaims: value.questClaims && typeof value.questClaims === "object" ? value.questClaims : {},
    referralCount: Math.max(0, Math.min(100000, Math.floor(Number(value.referralCount) || 0)))
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
function dailyQuestProgress(state, quest, today) {
  if (quest.kind === "spins") return state.history.filter(item => item.day === today).length;
  if (quest.kind === "wins") return state.history.filter(item => item.day === today && item.prize !== "no_prize" && item.status !== "declined").length;
  if (quest.kind === "referrals") return Number(state.referralCount || 0);
  return 0;
}
function ensureDailyQuests(state, userId) {
  const today = kyivDay();
  if (!state.dailyQuests || state.dailyQuests.day !== today || !Array.isArray(state.dailyQuests.tasks)) {
    // Daily tasks are separate from the permanent referral mission below.
    // Rotate every unfinished daily task at Kyiv midnight and avoid repeating
    // yesterday's pair whenever the pool allows it.
    const pool = [
      { id: "spin2", title: "Сделай 2 прокрутки", kind: "spins", target: 2, reward: 5 },
      { id: "spin3", title: "Сделай 3 прокрутки", kind: "spins", target: 3, reward: 8 },
      { id: "spin5", title: "Сделай 5 прокруток", kind: "spins", target: 5, reward: 12 },
      { id: "win1", title: "Получи любой приз", kind: "wins", target: 1, reward: 10 },
      { id: "win2", title: "Получи 2 любых приза", kind: "wins", target: 2, reward: 18 },
      { id: "spin7", title: "Сделай 7 прокруток", kind: "spins", target: 7, reward: 16 }
    ];
    const previousIds = new Set((state.dailyQuests?.tasks || []).map(q => q.id));
    const seed = crypto.createHash("sha256").update(String(userId) + ":" + today + ":daily-quests-v2").digest();
    const order = pool.map((q, index) => ({ q, key: seed.readUInt32BE((index * 4) % 28) }))
      .sort((a, b) => a.key - b.key);
    const fresh = order.filter(item => !previousIds.has(item.q.id));
    const chosen = [...fresh, ...order.filter(item => previousIds.has(item.q.id))]
      .slice(0, 2).map(item => item.q);
    state.dailyQuests = { day: today, tasks: chosen.map(q => ({ ...q, claimed: false })) };
  }
  return state.dailyQuests.tasks.map(q => ({
    ...q,
    progress: Math.min(q.target, dailyQuestProgress(state, q, today)),
    done: dailyQuestProgress(state, q, today) >= q.target
  }));
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
  const premiumLuck = await readGlobal("premiumLuck", { misses: 0, boostUntil: 0 });
  const luckBoostActive = Number(premiumLuck.boostUntil || 0) > Date.now();
  const telegramPremiumWeight = luckBoostActive ? 1000 : TELEGRAM_PREMIUM_WEIGHT;
  const plusWeight = luckBoostActive ? 10000 : PLUS_WEIGHT;
  const ultraWeight = luckBoostActive ? 5000 : ULTRA_WEIGHT;
  const noPrizeWeight = 1000000 - giftWeight - plusWeight - ultraWeight - telegramPremiumWeight - JACKPOT_WEIGHT - SECRET_WEIGHT;
  const prizes = [
    { id: "telegram_premium_12m", label: "⭐ Telegram Premium · 12 месяцев", short: "Telegram Premium", probability: (telegramPremiumWeight / 10000).toLocaleString("ru-RU") + "%", type: "telegram_premium", cost: 2500, available: true, weight: telegramPremiumWeight },
    { id: "jackpot_1000", label: "💎 ДЖЕКПОТ · Telegram-подарок за 1000 ⭐", short: "ДЖЕКПОТ · 1000 ⭐", probability: "0,01%", type: "jackpot", cost: 1000, available: true, weight: JACKPOT_WEIGHT },
    { id: "secret_gift", label: "🎁 Секретный подарок", short: "Секретный приз", probability: "0,01%", type: "secret", cost: 0, available: true, weight: SECRET_WEIGHT },
    { id: "nexus_plus", label: "💎 NEXUS Premium · 30 дней", short: "NEXUS Premium", probability: (plusWeight / 10000).toLocaleString("ru-RU") + "%", type: "nexus_plus", cost: 0, weight: plusWeight },
    { id: "nexus_ultra", label: "🚀 NEXUS Ultra · 30 дней", short: "NEXUS Ultra", probability: (ultraWeight / 10000).toLocaleString("ru-RU") + "%", type: "nexus_ultra", cost: 0, weight: ultraWeight },
    { id: "telegram_gift_random", label: "🧸 Случайный подарок Telegram · 15–1000 ⭐", short: "Мишка · 15–1000 ⭐", probability: giftPercent.toLocaleString("ru-RU") + "%", type: "gift_random", cost: 0, available: true, weight: giftWeight },
    { id: "no_prize", label: "Сегодня без приза. Попробуй завтра!", short: "Без приза", probability: (noPrizeWeight / 10000).toLocaleString("ru-RU") + "%", type: "none", cost: 0, weight: noPrizeWeight }
  ];
  return { balance, gifts: available, prizes, luckBoost: { active: luckBoostActive, until: luckBoostActive ? Number(premiumLuck.boostUntil) : 0, misses: Number(premiumLuck.misses || 0) } };
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
  const hiddenSecret = prize.type === "secret";
  return { id: prize.id, label: hiddenSecret ? "❔ Неизвестный приз" : prize.label, short: hiddenSecret ? "???" : prize.short, probability: hiddenSecret ? "Сюрприз" : prize.probability, type: prize.type, cost: prize.cost || 0, available: prize.available !== false, imageUrl: prize.type === "gift" && prize.giftId ? "/roulette/api/gift-image/" + encodeURIComponent(prize.giftId) : prize.type === "gift_random" ? "/assets/teddy-bear.svg" : prize.type === "telegram_premium" ? "/assets/telegram-premium.svg" : prize.type === "nexus_plus" ? "/assets/nexus-premium.svg" : prize.type === "nexus_ultra" ? "/assets/nexus-ultra.svg" : "" };
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
  const referralLocks = new Set();
  async function registerReferral(userId, payload) {
    const match = /^ref_(\d{1,20})$/.exec(String(payload || ""));
    if (!kvReady()) return { ok: false };
    const inviteeId = String(userId);
    if (referralLocks.has(inviteeId)) return { ok: false };
    referralLocks.add(inviteeId);
    try {
      const startedUsers = await readGlobal("startedUsers", {});
      if (startedUsers[inviteeId]) return { ok: false, duplicate: true };
      const referrals = await readGlobal("referrals", {});
      const invitee = await readState(inviteeId);
      const hasPriorRouletteActivity = Boolean(invitee.lastSpinDay || invitee.history.length || invitee.referralCount || invitee.bonusSpins || invitee.coins);
      startedUsers[inviteeId] = { at: Date.now() };
      if (!match || String(match[1]) === inviteeId || referrals[inviteeId] || hasPriorRouletteActivity) {
        await writeGlobal("startedUsers", startedUsers);
        return { ok: false, duplicate: Boolean(referrals[inviteeId] || hasPriorRouletteActivity) };
      }
      const inviterId = String(match[1]);
      const inviter = await readState(inviterId);
      referrals[inviteeId] = { inviterId, at: Date.now() };
      inviter.referralCount = Math.min(100000, (inviter.referralCount || 0) + 1);
      inviter.bonusSpins = Math.min(100000, inviter.bonusSpins + 2);
      invitee.bonusSpins = Math.min(100000, invitee.bonusSpins + 1);
      await writeState(inviterId, inviter);
      await writeState(inviteeId, invitee);
      await writeGlobal("referrals", referrals);
      await writeGlobal("startedUsers", startedUsers);
      await bot.api.sendMessage(Number(inviterId), "🎉 Новый игрок впервые нажал START по твоей ссылке! Тебе начислено +2 бонусные прокрутки.").catch(() => {});
      return { ok: true };
    } catch (error) {
      console.error("NEXUS referral:", String(error.message || error).slice(0, 180));
      return { ok: false };
    } finally { referralLocks.delete(inviteeId); }
  }
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
        const baseCost = Number(gift?.star_count || item.cost || 0);
        const totalCost = baseCost;
        if (!gift || !baseCost || balance < totalCost) continue;
        try {
          await telegramApi("sendGift", {
            user_id: Number(item.userId),
            gift_id: gift.id,
            text: "Поздравляем! Твой подарок из NEXUS Gift Roulette готов — спасибо за ожидание! 🎉"
          });
          balance = Math.max(0, balance - totalCost);
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
    return ctx.reply("🎁 <b>NEXUS GIFT ROULETTE</b>\n\nОдна бесплатная попытка каждый день. Выигрывай настоящие Telegram-подарки от 15 до 1000 ⭐, секретные призы и джекпот. Получай бонусы за задания и приглашения, активируй промокоды, собирай коллекцию и поднимайся в рейтинге. Режим x2 тратит две попытки и удваивает вес подарочных секторов.", {
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

  bot.command("use", async ctx => {
    if (typeof isAdmin !== "function" || !await isAdmin(ctx.from.id)) return ctx.reply("⛔ Команда доступна только администраторам NEXUS.");
    const parts = String(ctx.match || "").trim().split(/\s+/).filter(Boolean);
    const replied = ctx.message.reply_to_message?.from;
    let targetId = replied ? String(replied.id) : "";
    let amount;
    if (replied) amount = Number(parts[0]);
    else if (parts[0]?.startsWith("@")) {
      targetId = typeof resolveUsername === "function" ? await resolveUsername(parts[0]) : "";
      amount = Number(parts[1]);
      if (!targetId) return ctx.reply("Не удалось найти " + parts[0] + ". Пусть пользователь сначала напишет боту /start, или ответь на его сообщение: /use КОЛИЧЕСТВО.");
    } else { targetId = parts[0] || ""; amount = Number(parts[1]); }
    if (!/^\d{1,20}$/.test(targetId) || !Number.isSafeInteger(Number(targetId)) || !Number.isSafeInteger(amount) || amount < 1 || amount > 100000000) {
      return ctx.reply("Форматы выдачи биткоинов:\nОтветом на сообщение: /use 100\nПо Telegram ID: /use 123456789 100\nПо @username: /use @username 100");
    }
    try {
      const state = await readState(targetId);
      state.coins = Math.min(100000000, (state.coins || 0) + amount);
      await writeState(targetId, state);
      await ctx.reply("✅ Выдано " + amount + " ₿ пользователю " + targetId + ".\n🪙 Новый баланс: " + state.coins + " ₿");
      await bot.api.sendMessage(Number(targetId), "🪙 Администратор NEXUS начислил тебе +" + amount + " ₿.\nТвой баланс: " + state.coins + " ₿").catch(() => {});
    } catch (error) { return ctx.reply("❌ Не удалось выдать биткоины: " + String(error.message || error).slice(0, 220)); }
  });

  bot.command("roulettecode", async ctx => {
    const adminId = String(process.env.ADMIN_ID || process.env.OWNER_ID || "");
    if (!adminId || String(ctx.from.id) !== adminId) return ctx.reply("⛔ Только администратор может создавать промокоды.");
    const [rawCode, rawSpins, rawUses] = String(ctx.match || "").trim().split(/\s+/);
    const code = String(rawCode || "").toUpperCase(), spins = Number(rawSpins), maxUses = Number(rawUses || 100);
    if (!/^[A-Z0-9_-]{3,24}$/.test(code) || !Number.isInteger(spins) || spins < 1 || spins > 100 || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000)
      return ctx.reply("Формат: /roulettecode CODE ПРОКРУТКИ [ЛИМИТ]\nПример: /roulettecode NEXUS2026 3 100");
    const promos = await readGlobal("promos", {});
    promos[code] = { spins, maxUses, uses: 0, createdAt: Date.now(), expiresAt: Date.now() + 30 * 86400000 };
    await writeGlobal("promos", promos);
    return ctx.reply("✅ Промокод " + code + " создан: +" + spins + " прокрутки, лимит " + maxUses + " активаций, срок 30 дней.");
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
      const [balance, queue, winners, event, settings, blocked, stats] = await Promise.all([
        getStarBalance(), readPendingQueue(), readGlobal("winners", []),
        readGlobal("event", { active: false }), readGlobal("settings", { giftPercent: 38 }),
        readGlobal("blocked", []), readGlobal("stats", { totalSpins: 0, wins: 0, losses: 0 })
      ]);
      return ctx.reply("🛠 <b>NEXUS ROULETTE ADMIN</b>\n\n⭐ Баланс: " + balance +
        "\n🎰 Всего прокруток: " + (stats.totalSpins || 0) + "\n🎁 Выигрышей: " + (stats.wins || 0) + "\n🍀 Без приза: " + (stats.losses || 0) +
        "\n⏳ Ожидают выдачи: " + queue.length + "\n🏆 Победителей в ленте: " + winners.length +
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
        (i + 1) + ". " + g.label + " — ID: " + g.giftId
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
        // Prefer Telegram's static thumbnail: animated/video/TGS sticker files
        // cannot be displayed reliably by a normal HTML <img> element.
        const sticker = gift?.sticker;
        const thumbnail = sticker?.thumbnail;
        const fileId = thumbnail?.file_id || (sticker?.format === "static" ? sticker?.file_id : "");
        if (!fileId) { res.writeHead(404); res.end(); return true; }
        const file = await bot.api.getFile(fileId);
        if (!file?.file_path) { res.writeHead(404); res.end(); return true; }
        const remote = await fetch("https://api.telegram.org/file/bot" + BOT_TOKEN + "/" + file.file_path);
        if (!remote.ok) { res.writeHead(502); res.end(); return true; }
        // Telegram's file server can return application/octet-stream for image
        // stickers. Infer a safe image MIME type from the actual file extension;
        // nosniff would otherwise make browsers refuse to render the image.
        const extension = require("node:path").extname(file.file_path).toLowerCase();
        const imageTypes = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
        const contentType = imageTypes[extension] || (String(remote.headers.get("content-type") || "").toLowerCase().startsWith("image/") ? remote.headers.get("content-type") : "");
        if (!contentType) { res.writeHead(415); res.end(); return true; }
        res.writeHead(200, {
          "Content-Type": contentType,
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
        const dailyQuests = ensureDailyQuests(state, user.id);
        await writeState(user.id, state);
        const freeSpinAvailable = state.lastSpinDay !== kyivDay();
        const canSpin = freeSpinAvailable || state.bonusSpins > 0;
        const winners = await readGlobal("winners", []);
        const event = await readGlobal("event", { active: false, label: "NEXUS EVENT" });
        const playerStats = await readGlobal("playerStats", {});
        const me = await bot.api.getMe().catch(() => ({}));
        const collection = state.history.filter(item => item.status === "delivered" && !/NFT|коллекцион/i.test(item.label || "") && (item.giftId || item.cost || /Premium|Ultra|подарок/i.test(item.label || ""))).slice(-30).reverse().map(item => ({ ...item, imageUrl: item.giftId ? "/roulette/api/gift-image/" + encodeURIComponent(item.giftId) : "" }));
        const pendingGifts = queue.filter(item => String(item.userId) === String(user.id)).map(item => ({
          spinId: item.spinId,
          label: item.type === "telegram_premium" ? "⭐ Telegram Premium · 12 месяцев" : (item.label || "🎁 Подарок Telegram"),
          cost: Number(item.cost || 0), createdAt: item.createdAt || 0
        }));
        json(res, 200, {
          ok: true, canSpin, freeSpinAvailable, totalSpinsAvailable: state.bonusSpins + (freeSpinAvailable ? 1 : 0),
          lastSpinDay: state.lastSpinDay, bonusSpins: state.bonusSpins, coins: state.coins || 0, dailyQuests, balance: catalog.balance, streak: state.streak || 0, luckMultiplier: (state.streak >= 30 ? 5 : state.streak >= 7 ? 3 : state.streak >= 3 ? 2 : 1) * (event.active ? 2 : 1), event, collection, leaderboard: Object.values(playerStats).sort((a, b) => (Number(b.cost) - Number(a.cost)) || (Number(b.wins) - Number(a.wins))).slice(0, 10),
          recentWinners: winners.slice(-12).reverse().map(item => ({ name: item.name || "Игрок", label: item.label || "Подарок", cost: Number(item.cost || 0), at: item.at || 0 })),
          luckBoost: catalog.luckBoost,
          achievements: [
            { id: "first_spin", title: "Первый запуск", icon: "🎰", done: state.history.length >= 1, progress: Math.min(state.history.length, 1), target: 1 },
            { id: "collector", title: "Коллекционер", icon: "🎁", done: state.history.filter(item => item.status === "delivered" && item.cost > 0).length >= 3, progress: Math.min(state.history.filter(item => item.status === "delivered" && item.cost > 0).length, 3), target: 3 },
            { id: "lucky7", title: "Неделя удачи", icon: "🔥", done: state.streak >= 7, progress: Math.min(state.streak, 7), target: 7 },
            { id: "jackpot", title: "Охотник за джекпотом", icon: "💎", done: state.history.some(item => /ДЖЕКПОТ/.test(item.label || "")), progress: state.history.some(item => /ДЖЕКПОТ/.test(item.label || "")) ? 1 : 0, target: 1 },
            { id: "premium", title: "Премиум-клуб", icon: "👑", done: state.history.some(item => /Premium|Ultra/.test(item.label || "")), progress: state.history.some(item => /Premium|Ultra/.test(item.label || "")) ? 1 : 0, target: 1 }
          ],
          dailyTheme: ["Золотой день", "Синий неон", "Изумрудный шанс", "Фиолетовая ночь", "Рубиновый дроп", "Космический день", "Сюрприз выходного"][new Date().getDay()],
          luckySector: event.active ? (event.label || "Счастливый сектор активен") : "Счастливый сектор появится во время события",
          referralLink: me.username ? "https://t.me/" + me.username + "?start=ref_" + user.id : "",
          referralCount: state.referralCount || 0,
          inviteQuestAvailable: !state.questClaims.inviteFriend,
          dailyQuestClaimed: state.questClaims.dailySpin === kyivDay(),
          timedQuest: (() => {
            const cycle = Math.floor(Date.now() / 3600000), start = cycle * 3600000;
            return { cycle, startsAt: start, endsAt: start + 3600000, target: 3,
              progress: state.history.filter(item => Number(item.at) >= start && Number(item.at) < start + 3600000).length,
              claimed: state.questClaims.timedSpinCycle === cycle };
          })(),
          giftsAvailable: catalog.gifts.length, pendingGifts,
          giftOptions: (() => {
            const randomCount = catalog.gifts.filter(g => g.cost >= 15 && g.cost <= 999).length;
            const randomPrize = catalog.prizes.find(p => p.type === "gift_random");
            const randomChance = Number(String(randomPrize?.probability || "38").replace(",", ".")) || 0;
            return catalog.gifts.map(g => ({
              ...publicPrize(g),
              probability: g.cost === 1000
                ? "0,01% · джекпот"
                : (randomCount ? (randomChance / randomCount).toLocaleString("ru-RU", { maximumFractionDigits: 4 }) + "%" : "0%")
            }));
          })(),
          prizes: catalog.prizes.map(publicPrize),
          unavailableReason: catalog.gifts.length ? "" : "Нет доступных подарков стоимостью 15–1000 ⭐ или не хватает Stars на балансе бота.",
          lastResult: state.history.at(-1) || null
        });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/roulette/api/redeem-code") {
        const body = await readBody(req), code = String(body.code || "").trim().toUpperCase();
        if (!/^[A-Z0-9_-]{3,24}$/.test(code)) { json(res, 400, { ok: false, error: "Промокод должен содержать 3–24 символа." }); return true; }
        if (locks.has("promo:" + user.id)) { json(res, 409, { ok: false, error: "Подожди завершения предыдущей операции." }); return true; }
        locks.add("promo:" + user.id);
        try {
          const state = await readState(user.id), promos = await readGlobal("promos", {}), promo = promos[code];
          if (!promo || Number(promo.expiresAt) < Date.now() || Number(promo.uses) >= Number(promo.maxUses)) { json(res, 404, { ok: false, error: "Промокод не найден, истёк или уже исчерпан." }); return true; }
          if (state.claimedCodes.includes(code)) { json(res, 409, { ok: false, error: "Ты уже активировал этот промокод." }); return true; }
          promo.uses = Number(promo.uses || 0) + 1; state.claimedCodes.push(code); state.claimedCodes = state.claimedCodes.slice(-200);
          state.bonusSpins = Math.min(100000, state.bonusSpins + Number(promo.spins || 0));
          await writeGlobal("promos", promos); await writeState(user.id, state);
          json(res, 200, { ok: true, spins: Number(promo.spins || 0), bonusSpins: state.bonusSpins }); return true;
        } finally { locks.delete("promo:" + user.id); }
      }
      if (req.method === "POST" && url.pathname === "/roulette/api/quest/claim") {
        const body = await readBody(req), quest = String(body.quest || ""), today = kyivDay(), state = await readState(user.id);
        if (quest === "daily_spin") {
          if (!state.history.some(item => item.day === today)) { json(res, 409, { ok: false, error: "Сначала используй сегодняшнюю прокрутку." }); return true; }
          if (state.questClaims.dailySpin === today) { json(res, 409, { ok: false, error: "Награда за это задание уже получена сегодня." }); return true; }
          state.questClaims.dailySpin = today; state.bonusSpins = Math.min(100000, state.bonusSpins + 1);
        } else if (quest === "invite_friend") {
          if ((state.referralCount || 0) < 3) { json(res, 409, { ok: false, error: "Нужно пригласить 3 новых игроков. Сейчас: " + (state.referralCount || 0) + "/3." }); return true; }
          if (state.questClaims.inviteFriend) { json(res, 409, { ok: false, error: "Награда за приглашение уже получена." }); return true; }
          state.questClaims.inviteFriend = true; state.bonusSpins = Math.min(100000, state.bonusSpins + 3);
        } else if (quest === "timed_spin") {
          const cycle = Math.floor(Date.now() / 3600000), start = cycle * 3600000, end = start + 3600000;
          const progress = state.history.filter(item => Number(item.at) >= start && Number(item.at) < end).length;
          if (state.questClaims.timedSpinCycle === cycle) { json(res, 409, { ok: false, error: "Награда за это часовое задание уже получена." }); return true; }
          if (progress < 3) { json(res, 409, { ok: false, error: "Нужно сделать 3 прокрутки за это часовое задание. Сейчас: " + progress + "/3." }); return true; }
          state.questClaims.timedSpinCycle = cycle; state.bonusSpins = Math.min(100000, state.bonusSpins + 2);
        } else if (quest.startsWith("daily_")) {
          const dailyId = quest.slice(6), tasks = ensureDailyQuests(state, user.id);
          const task = state.dailyQuests.tasks.find(item => item.id === dailyId);
          const view = tasks.find(item => item.id === dailyId);
          if (!task || !view) { json(res, 404, { ok: false, error: "Это задание уже обновилось." }); return true; }
          if (task.claimed) { json(res, 409, { ok: false, error: "Награда за это задание уже получена." }); return true; }
          if (!view.done) { json(res, 409, { ok: false, error: "Задание ещё не выполнено: " + view.progress + "/" + view.target }); return true; }
          task.claimed = true; state.coins = Math.min(100000000, (state.coins || 0) + task.reward);
        } else { json(res, 400, { ok: false, error: "Неизвестное задание." }); return true; }
        await writeState(user.id, state); json(res, 200, { ok: true, bonusSpins: state.bonusSpins, coins: state.coins || 0 }); return true;
      }
      if (req.method === "POST" && url.pathname === "/roulette/api/case/open") {
        if (locks.has("case:" + user.id)) { json(res, 409, { ok: false, error: "Кейс уже открывается." }); return true; }
        locks.add("case:" + user.id);
        try {
          const [state, giftResponse, botBalance] = await Promise.all([
            readState(user.id), telegramApi("getAvailableGifts"), getStarBalance()
          ]);
          const cost = 100;
          if ((state.coins || 0) < cost) { json(res, 409, { ok: false, error: "Для открытия кейса нужно 100 ₿." }); return true; }
          const available = (Array.isArray(giftResponse?.gifts) ? giftResponse.gifts : [])
            .filter(g => g && typeof g.id === "string" && Number(g.star_count) >= 15 && Number(g.star_count) <= 1000)
            .filter(g => g.remaining_count === undefined || Number(g.remaining_count) > 0)
            .filter(g => Number(g.star_count) <= botBalance);
          if (!available.length) {
            json(res, 503, { ok: false, error: "Сейчас нет Telegram-подарков, которые бот может отправить. Попробуй позже — твои 100 ₿ не списаны." });
            return true;
          }
          const pickFrom = (min, max) => available.filter(g => Number(g.star_count) >= min && Number(g.star_count) <= max);
          const roll = crypto.randomInt(10000);
          const tiers = [
            { limit: 5500, min: 15, max: 50 },
            { limit: 8200, min: 51, max: 100 },
            { limit: 9600, min: 101, max: 250 },
            { limit: 9900, min: 251, max: 500 },
            { limit: 10000, min: 501, max: 1000 }
          ];
          const tier = tiers.find(t => roll < t.limit) || tiers[0];
          let candidates = pickFrom(tier.min, tier.max);
          if (!candidates.length) candidates = available;
          const gift = candidates[crypto.randomInt(0, candidates.length)];
          const spinId = crypto.randomUUID();
          const giftEmoji = gift.sticker?.emoji || "🎁";
          const giftTitle = giftEmoji + " Telegram-подарок";
          const reward = {
            title: giftTitle, detail: Number(gift.star_count) + " ⭐ · настоящий подарок Telegram",
            type: "gift", giftId: gift.id, giftStars: Number(gift.star_count),
            imageUrl: "/roulette/api/gift-image/" + encodeURIComponent(gift.id),
            coins: 0, spins: 0, status: "processing"
          };
          const row = {
            spinId, day: kyivDay(), prize: "case_gift", label: giftTitle + " · " + Number(gift.star_count) + " ⭐",
            giftId: gift.id, cost: Number(gift.star_count), status: "processing", at: Date.now(), source: "case"
          };
          const queueItem = {
            spinId, userId: String(user.id), type: "case_gift", giftId: gift.id,
            cost: Number(gift.star_count), label: row.label, createdAt: Date.now(), source: "case"
          };
          const reelPool = Array.from({ length: 59 }, () => {
            const item = available[crypto.randomInt(0, available.length)];
            return {
              title: (item.sticker?.emoji || "🎁") + " Telegram-подарок",
              detail: Number(item.star_count) + " ⭐",
              imageUrl: "/roulette/api/gift-image/" + encodeURIComponent(item.id)
            };
          });
          const reel = [...reelPool, { title: giftTitle, detail: Number(gift.star_count) + " ⭐", imageUrl: reward.imageUrl }];
          state.coins -= cost;
          state.history.push(row);
          state.history = state.history.slice(-100);
          try {
            await writeState(user.id, state);
            const queue = await readPendingQueue();
            queue.push(queueItem);
            await writePendingQueue(queue);
          } catch (error) {
            state.coins += cost;
            state.history = state.history.filter(item => item.spinId !== spinId);
            await writeState(user.id, state).catch(() => {});
            throw error;
          }
          processPendingGiftQueue().catch(() => {});
          json(res, 200, {
            ok: true, coins: state.coins, bonusSpins: state.bonusSpins,
            reward, reel, spinId,
            message: "Кейс открыт! Настоящий Telegram-подарок поставлен на отправку."
          });
          return true;
        } finally { locks.delete("case:" + user.id); }
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
        const spinBody = await readBody(req), x2Mode = spinBody.mode === "x2";
        if (locks.has(String(user.id))) { json(res, 409, { ok: false, error: "Рулетка уже обрабатывает твою попытку." }); return true; }
        locks.add(String(user.id));
        try {
          const [fresh, catalog] = await Promise.all([readState(user.id), getGiftCatalog(bot)]);
          const today = kyivDay();
          const freeAvailable = fresh.lastSpinDay !== today, totalAvailable = fresh.bonusSpins + (freeAvailable ? 1 : 0);
          const spinCost = x2Mode ? 2 : 1;
          if (totalAvailable < spinCost) { json(res, 409, { ok: false, error: x2Mode ? "Для режима x2 нужны две доступные прокрутки." : "Сегодня ты уже использовал бесплатную попытку.", canSpin: false, bonusSpins: fresh.bonusSpins }); return true; }
          const usedBonusSpin = !freeAvailable;
          if (x2Mode) fresh.bonusSpins = Math.max(0, fresh.bonusSpins - (freeAvailable ? 1 : 2));
          else if (usedBonusSpin) fresh.bonusSpins = Math.max(0, fresh.bonusSpins - 1);
          if (freeAvailable && fresh.lastStreakDay !== today) {
            const yesterday = new Date(Date.parse(today + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
            fresh.streak = fresh.lastStreakDay === yesterday ? fresh.streak + 1 : 1;
            fresh.lastStreakDay = today;
            const streakBonus = fresh.streak === 30 ? 5 : fresh.streak === 7 ? 2 : fresh.streak === 3 ? 1 : 0;
            fresh.bonusSpins = Math.min(100000, fresh.bonusSpins + streakBonus);
          }
          
          let prizeList = catalog.prizes.map(item => ({ ...item }));
          const event = await readGlobal("event", { active: false, label: "NEXUS EVENT" });
          const streakMultiplier = fresh.streak >= 30 ? 5 : fresh.streak >= 7 ? 3 : fresh.streak >= 3 ? 2 : 1;
          const luckMultiplier = streakMultiplier * (event.active ? 2 : 1) * (x2Mode ? 2 : 1);
          if (luckMultiplier > 1) prizeList = prizeList.map(item => ({ ...item, weight: item.weight * (["gift_random", "secret", "jackpot"].includes(item.type) ? luckMultiplier : 1) }));
          let prize = choosePrize(prizeList);
          // Track the shared premium dry spell. After 200 non-premium spins,
          // activate a 3-minute boost; a premium win resets it to normal odds.
          const premiumLuck = await readGlobal("premiumLuck", { misses: 0, boostUntil: 0 });
          const nowForLuck = Date.now();
          if (Number(premiumLuck.boostUntil || 0) <= nowForLuck) premiumLuck.boostUntil = 0;
          const premiumWin = ["telegram_premium", "nexus_plus", "nexus_ultra"].includes(prize.type);
          if (premiumWin) {
            premiumLuck.misses = 0;
            premiumLuck.boostUntil = 0;
          } else if (premiumLuck.boostUntil) {
            // Keep the active window; the catalog automatically restores base odds on expiry.
          } else {
            premiumLuck.misses = Math.max(0, Number(premiumLuck.misses || 0)) + 1;
            if (premiumLuck.misses >= 200) {
              premiumLuck.misses = 0;
              premiumLuck.boostUntil = nowForLuck + 3 * 60 * 1000;
            }
          }
          await writeGlobal("premiumLuck", premiumLuck);
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
          fresh.coins = Math.min(100000000, (fresh.coins || 0) + (x2Mode ? 2 : 1));
          fresh.history.push(row);
          fresh.history = fresh.history.slice(-100);
          await writeState(user.id, fresh);
          try {
            const playerStats = await readGlobal("playerStats", {});
            const player = playerStats[String(user.id)] || { userId: user.id, name: user.firstName || "Игрок", wins: 0, losses: 0, spins: 0, cost: 0 };
            player.name = user.firstName || player.name || "Игрок"; player.spins = (Number(player.spins) || 0) + 1;
            if (prize.type === "none") player.losses = (Number(player.losses) || 0) + 1;
            else { player.wins = (Number(player.wins) || 0) + 1; player.cost = (Number(player.cost) || 0) + Number(prize.cost || 0); }
            playerStats[String(user.id)] = player; await writeGlobal("playerStats", playerStats);
            const stats = await readGlobal("stats", { totalSpins: 0, wins: 0, losses: 0 });
            stats.totalSpins = (Number(stats.totalSpins) || 0) + 1;
            if (prize.type === "none") stats.losses = (Number(stats.losses) || 0) + 1;
            else stats.wins = (Number(stats.wins) || 0) + 1;
            stats.updatedAt = Date.now();
            await writeGlobal("stats", stats);
          } catch (statsError) {
            console.error("NEXUS roulette stats:", String(statsError.message || statsError).slice(0, 180));
          }

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
            ok: true, canSpin: fresh.bonusSpins > 0, bonusSpins: fresh.bonusSpins, totalSpinsAvailable: fresh.bonusSpins, spinId, x2Mode, jackpot: Boolean(prize.jackpot),
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
  return { handleHttp, webAppUrl, registerReferral };
}
module.exports = { installRoulette };
