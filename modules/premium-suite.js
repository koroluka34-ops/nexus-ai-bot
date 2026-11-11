"use strict";

// NEXUS Premium: persistent plans, username lookup and monthly media quotas.
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const ADMIN_ID = String(process.env.ADMIN_ID || process.env.OWNER_ID || "");
const KEY = "nexus:premium:v1";
const FREE_LIMITS = { image: 10, video: 2, edit: 3, sticker: 10 };
const PREMIUM_LIMITS = { image: 100, video: 30, edit: 50, sticker: 100 };
const state = { users: {}, usernames: {} };
let loadPromise;
let saveChain = Promise.resolve();

function configured() { return Boolean(ACCOUNT && TOKEN && NAMESPACE); }
function endpoint() {
  return "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(ACCOUNT) +
    "/storage/kv/namespaces/" + encodeURIComponent(NAMESPACE) + "/values/" + encodeURIComponent(KEY);
}
async function load() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (!configured()) return;
    try {
      const response = await fetch(endpoint(), { headers: { Authorization: "Bearer " + TOKEN }, signal: AbortSignal.timeout(10000) });
      if (response.status === 404) return;
      if (!response.ok) throw new Error("KV HTTP " + response.status);
      const data = await response.json();
      if (data && typeof data === "object") {
        if (data.users && typeof data.users === "object") state.users = data.users;
        if (data.usernames && typeof data.usernames === "object") state.usernames = data.usernames;
      }
    } catch (error) { console.error("NEXUS premium load:", error.message); }
  })();
  return loadPromise;
}
async function save() {
  await load();
  if (!configured()) return false;
  const body = JSON.stringify(state);
  const write = async () => {
    const response = await fetch(endpoint(), {
      method: "PUT", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body, signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error("KV HTTP " + response.status);
  };
  saveChain = saveChain.then(write, write);
  try { await saveChain; return true; }
  catch (error) { console.error("NEXUS premium save:", error.message); saveChain = Promise.resolve(); return false; }
}
function monthKey() {
  const now = new Date();
  return now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0");
}
function premiumActive(record) {
  return Boolean(record && record.premiumUntil && (record.premiumUntil === "forever" || Number(record.premiumUntil) > Date.now()));
}
function planFor(id) {
  const record = state.users[String(id)] || {};
  return premiumActive(record) ? "premium" : "free";
}
function limitsFor(id) { return planFor(id) === "premium" ? PREMIUM_LIMITS : FREE_LIMITS; }
function userLabel(ctx) {
  return ctx.from.username ? "@" + ctx.from.username : String(ctx.from.first_name || "пользователь");
}
function monthUsage(record) {
  if (!record.usage || record.usage.month !== monthKey()) record.usage = { month: monthKey(), image: 0, video: 0, edit: 0, sticker: 0 };
  for (const key of Object.keys(FREE_LIMITS)) if (!Number.isFinite(record.usage[key])) record.usage[key] = 0;
  return record.usage;
}
function admin(ctx) { return Boolean(ADMIN_ID) && String(ctx.from && ctx.from.id) === ADMIN_ID; }

async function installPremium(bot) {
  await load();
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      const id = String(ctx.from.id);
      const username = String(ctx.from.username || "").replace(/^@/, "").toLowerCase();
      if (username && state.usernames[username] !== id) {
        state.usernames[username] = id;
        // Save asynchronously; do not block ordinary updates on KV latency.
        save().catch(() => {});
      }
    }
    await next();
  });

  bot.command("premium", async ctx => {
    if (!admin(ctx)) return ctx.reply("⛔ Эта команда доступна только администратору NEXUS.");
    const input = String(ctx.match || "").trim();
    const repliedUser = ctx.message.reply_to_message && ctx.message.reply_to_message.from;
    const parts = input.split(/\s+/).filter(Boolean);
    let targetId = repliedUser ? String(repliedUser.id) : "";
    let targetName = repliedUser ? (repliedUser.username ? "@" + repliedUser.username : repliedUser.first_name || targetId) : "";
    let action = parts[0] || "";
    if (!targetId && /^@?[a-z0-9_]{5,32}$/i.test(action)) {
      const username = action.replace(/^@/, "").toLowerCase();
      targetId = state.usernames[username] || "";
      targetName = "@" + username;
      action = parts[1] || "30d";
    } else if (targetId) action = parts[0] || "30d";

    if (action.toLowerCase() === "list") {
      const rows = Object.entries(state.users).filter(([,v]) => premiumActive(v)).map(([id,v]) =>
        (v.username ? "@" + v.username : "пользователь") + " · " + id + " · " +
        (v.premiumUntil === "forever" ? "навсегда" : new Date(Number(v.premiumUntil)).toLocaleDateString("ru-RU"))
      );
      return ctx.reply("👑 АКТИВНЫЙ PREMIUM\n\n" + (rows.join("\n") || "Активных подписок нет."));
    }
    if (!targetId) {
      return ctx.reply("Формат: /premium @username 30d\nИли ответь на сообщение пользователя командой /premium 30d.\n\nПользователь должен хотя бы один раз написать боту, чтобы NEXUS знал его username. Можно также выдать навсегда: /premium @username forever, снять: /premium @username off.");
    }
    const record = state.users[targetId] || (state.users[targetId] = {});
    if (repliedUser) {
      record.username = repliedUser.username || record.username || "";
      if (record.username) state.usernames[record.username.toLowerCase()] = targetId;
    }
    if (action.toLowerCase() === "off" || action.toLowerCase() === "remove") {
      delete record.premiumUntil;
      const saved = await save();
      return ctx.reply("🗑 Premium снят с " + targetName + (saved ? "." : ".\n⚠️ KV недоступен: изменение пока не сохранено."));
    }
    let until;
    if (action.toLowerCase() === "forever" || action.toLowerCase() === "навсегда") until = "forever";
    else {
      const match = action.match(/^(\d{1,3})(d|д|day|days|м|m|month|months)$/i);
      const days = match ? Number(match[1]) * (/[mм]/i.test(match[2]) ? 30 : 1) : (/^\d{1,3}$/.test(action) ? Number(action) : 30);
      if (days < 1 || days > 3650) return ctx.reply("Срок: 1–3650 дней или forever.");
      until = Date.now() + days * 86400000;
    }
    record.premiumUntil = until;
    const saved = await save();
    return ctx.reply("👑 Premium " + (until === "forever" ? "выдан навсегда" : "выдан до " + new Date(until).toLocaleString("ru-RU")) +
      " пользователю " + targetName + "." + (saved ? "" : "\n⚠️ Cloudflare KV недоступен: выдача не сохранена между перезапусками."));
  });

  bot.command("premiuminfo", async ctx => {
    await load();
    const id = String(ctx.from.id), record = state.users[id] || {};
    const premium = premiumActive(record), limits = premium ? PREMIUM_LIMITS : FREE_LIMITS;
    const usage = monthUsage(record);
    const names = { image: "ИИ-фото", video: "ИИ-видео", edit: "редактирование фото", sticker: "ИИ-стикеры" };
    const lines = Object.keys(limits).map(key => "• " + names[key] + ": " + usage[key] + "/" + limits[key]);
    const expiry = premium ? (record.premiumUntil === "forever" ? "навсегда" : "до " + new Date(Number(record.premiumUntil)).toLocaleDateString("ru-RU")) : "нет";
    return ctx.reply("👑 NEXUS " + (premium ? "PREMIUM" : "FREE") +
      "\nПодписка: " + expiry + "\nЛимиты на месяц (" + monthKey() + "):\n" + lines.join("\n") +
      "\n\nОформление Premium — у администратора бота.");
  });
}

async function checkAndRecord(ctx, kind) {
  await load();
  const id = String(ctx.from.id);
  const record = state.users[id] || (state.users[id] = {});
  const usage = monthUsage(record);
  const premium = premiumActive(record);
  const limit = (premium ? PREMIUM_LIMITS : FREE_LIMITS)[kind];
  if (!Number.isFinite(limit)) return { allowed: true, finish: async () => {} };
  if (usage[kind] >= limit) {
    const label = ({ image: "ИИ-фото", video: "ИИ-видео", edit: "редактирование фото", sticker: "ИИ-стикеры" })[kind] || kind;
    return { allowed: false, message: "⛔ Лимит " + label + " на этот месяц исчерпан (" + limit + ").\n" +
      (premium ? "Лимит Premium обновится в начале следующего месяца." : "В бесплатном плане доступно " + limit + " операций в месяц. Premium открывает больше генераций.") +
      "\nПроверить тариф: /premiuminfo" };
  }
  let finished = false;
  return {
    allowed: true,
    finish: async success => {
      if (finished) return;
      finished = true;
      if (success) {
        const latest = monthUsage(record);
        latest[kind] = Math.min(limit, latest[kind] + 1);
        await save();
      }
    }
  };
}
module.exports = { installPremium, checkAndRecord };
