"use strict";

const dns = require("node:dns/promises");
const net = require("node:net");

const KV_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const KV_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const KV_NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const KV_KEY = "nexus:security-monitor:v1";

const state = { groups: {}, watches: [] };
const warned = new Map();
let loaded = false;
let saveChain = Promise.resolve();
let monitorTimer = null;

function kvReady() {
  return Boolean(KV_ACCOUNT_ID && KV_TOKEN && KV_NAMESPACE_ID);
}

function kvUrl() {
  return "https://api.cloudflare.com/client/v4/accounts/" +
    encodeURIComponent(KV_ACCOUNT_ID) + "/storage/kv/namespaces/" +
    encodeURIComponent(KV_NAMESPACE_ID) + "/values/" + encodeURIComponent(KV_KEY);
}

async function loadState() {
  if (loaded) return;
  loaded = true;
  if (!kvReady()) return;
  try {
    const response = await fetch(kvUrl(), {
      headers: { Authorization: "Bearer " + KV_TOKEN },
      signal: AbortSignal.timeout(10000)
    });
    if (response.status === 404) return;
    if (!response.ok) throw new Error("KV HTTP " + response.status);
    const data = await response.json();
    if (data && typeof data === "object") {
      state.groups = data.groups && typeof data.groups === "object" ? data.groups : {};
      state.watches = Array.isArray(data.watches) ? data.watches.slice(0, 500) : [];
    }
  } catch (error) {
    console.error("NEXUS security state load:", error.message);
  }
}

async function saveState() {
  await loadState();
  if (!kvReady()) return false;
  const snapshot = JSON.stringify(state);
  saveChain = saveChain.then(async () => {
    const response = await fetch(kvUrl(), {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + KV_TOKEN,
        "Content-Type": "application/json"
      },
      body: snapshot,
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error("KV HTTP " + response.status);
  });
  try {
    await saveChain;
    return true;
  } catch (error) {
    console.error("NEXUS security state save:", error.message);
    return false;
  }
}

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

function isPrivateIPv6(ip) {
  const value = ip.toLowerCase().split("%")[0];
  return value === "::" || value === "::1" || value.startsWith("fc") ||
    value.startsWith("fd") || value.startsWith("fe8") ||
    value.startsWith("fe9") || value.startsWith("fea") ||
    value.startsWith("feb") || value.startsWith("::ffff:127.") ||
    value.startsWith("::ffff:10.") || value.startsWith("::ffff:192.168.");
}

async function validatePublicHttps(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("Нужна корректная ссылка https://"); }
  if (url.protocol !== "https:") throw new Error("Разрешены только HTTPS-сайты.");
  if (url.username || url.password) throw new Error("Ссылки с логином или паролем запрещены.");
  if (!url.hostname || url.hostname.length > 253) throw new Error("Некорректный адрес сайта.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.endsWith(".test") || host.endsWith(".invalid")) {
    throw new Error("Локальные и внутренние адреса запрещены.");
  }
  if (net.isIP(host)) throw new Error("IP-адреса вместо доменных имён не поддерживаются.");
  let records;
  try { records = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error("Не удалось найти домен в DNS."); }
  if (!records.length || records.some(record =>
    net.isIP(record.address) === 4 ? isPrivateIPv4(record.address) : isPrivateIPv6(record.address)
  )) throw new Error("Домен указывает на локальный или зарезервированный IP-адрес.");
  return url;
}

async function checkWebsite(raw) {
  const url = await validatePublicHttps(raw);
  const started = Date.now();
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { "User-Agent": "NEXUS-Uptime-Monitor/1.0", "Range": "bytes=0-0" },
    signal: AbortSignal.timeout(12000)
  });
  const elapsed = Date.now() - started;
  const redirected = response.status >= 300 && response.status < 400;
  return {
    ok: response.status >= 200 && response.status < 400,
    status: redirected ? "REDIRECT " + response.status : String(response.status),
    ms: elapsed,
    url: url.origin
  };
}

function extractUrls(text) {
  return String(text || "").match(/https?:\/\/[^\s<>()]+/giu) || [];
}

const SHORTENERS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "cutt.ly", "is.gd", "rb.gy",
  "rebrand.ly", "shorturl.at", "lnkd.in", "buff.ly"
]);
const BRAND_ROOTS = [
  "telegram.org", "t.me", "steamcommunity.com", "steampowered.com",
  "discord.com", "discord.gg", "google.com", "microsoft.com",
  "paypal.com", "binance.com", "metamask.io", "openai.com"
];

function hostIsBrandSpoof(host) {
  const brands = [
    ["telegram", ["telegram.org", "t.me"]],
    ["steam", ["steamcommunity.com", "steampowered.com"]],
    ["discord", ["discord.com", "discord.gg"]],
    ["google", ["google.com"]],
    ["microsoft", ["microsoft.com"]],
    ["paypal", ["paypal.com"]],
    ["binance", ["binance.com"]],
    ["metamask", ["metamask.io"]],
    ["openai", ["openai.com"]]
  ];
  for (const [word, allowed] of brands) {
    if (host.includes(word) && !allowed.some(domain => host === domain || host.endsWith("." + domain))) return true;
  }
  return false;
}

function assessSuspiciousMessage(text) {
  const body = String(text || "");
  const urls = extractUrls(body);
  if (!urls.length) return null;
  const reasons = [];
  for (const raw of urls.slice(0, 5)) {
    try {
      const url = new URL(raw.replace(/[.,!?;:]+$/, ""));
      const host = url.hostname.toLowerCase();
      if (host.startsWith("xn--") || host.split(".").some(part => part.startsWith("xn--"))) reasons.push("домен использует похожие Unicode-символы");
      if (hostIsBrandSpoof(host)) reasons.push("домен маскируется под известный сервис");
      if (SHORTENERS.has(host)) reasons.push("использована скрывающая адрес ссылка");
      if (url.username || url.password) reasons.push("в ссылке встроены данные для входа");
    } catch {}
  }
  const credentialAsk = /(seed phrase|recovery phrase|секретн\w*\s+фраз|сид[- ]?фраз|приватн\w*\s+ключ|private key|парол[ья]|код подтвержден|код из смс|2fa|одноразов\w*\s+код|подключи(?:те)?\s+кошел[её]к|connect wallet|verify your wallet|войдите в аккаунт|подтвердите аккаунт)/iu.test(body);
  const bait = /(бесплатн\w+\s+(?:nitro|нитро|крипт|робукс)|раздач\w+|airdrop|розыгрыш|выиграл\w*|получи(?:те)?\s+приз|срочно\s+подтверд|аккаунт.{0,20}(?:заблок|удал))/iu.test(body);
  if (credentialAsk) reasons.push("сообщение просит пароль, код или секретные данные");
  if (bait) reasons.push("обещает приз или требует срочного действия");
  if (!reasons.length) return null;
  return [...new Set(reasons)].slice(0, 3);
}

async function isGroupAdmin(ctx) {
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status === "creator" || member.status === "administrator";
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function installSecurityMonitor(bot) {
  bot.use(async (ctx, next) => {
    try {
      await loadState();
      const chat = ctx.chat;
      const message = ctx.message;
      const isGroup = chat && (chat.type === "group" || chat.type === "supergroup");
      const text = message?.text || message?.caption || "";
      if (isGroup && message && ctx.from && state.groups[String(chat.id)] === true &&
          !message.from?.is_bot && !/^\/antiscam(?:@\w+)?(?:\s|$)/i.test(text)) {
        const reasons = assessSuspiciousMessage(text);
        const key = String(chat.id) + ":" + String(message.message_id);
        if (reasons && !warned.has(key)) {
          warned.set(key, Date.now());
          if (warned.size > 1000) {
            const cutoff = Date.now() - 60 * 60 * 1000;
            for (const [id, time] of warned) if (time < cutoff) warned.delete(id);
          }
          await ctx.reply(
            "⚠️ <b>Возможный фишинг или скам</b>\n" +
            "NEXUS заметил подозрительные признаки: " + reasons.map(escapeHtml).join("; ") +
            ".\nНе открывай ссылку и не вводи пароли, коды, seed-фразы или данные кошелька. Проверяй адрес вручную.",
            { parse_mode: "HTML", reply_parameters: { message_id: message.message_id } }
          ).catch(() => {});
        }
      }
    } catch (error) {
      console.error("NEXUS anti-scam:", error.message);
    }
    await next();
  });

  bot.command("antiscam", async ctx => {
    if (!ctx.chat || !["group", "supergroup"].includes(ctx.chat.type)) {
      return ctx.reply("🛡 Антискам включается отдельно в каждой Telegram-группе: добавь NEXUS и выполни /antiscam on.");
    }
    if (!await isGroupAdmin(ctx)) return ctx.reply("Включать и выключать антискам могут только администраторы группы.");
    const action = String(ctx.match || "status").trim().toLowerCase();
    const id = String(ctx.chat.id);
    if (action === "on" || action === "вкл") {
      state.groups[id] = true;
      const saved = await saveState();
      return ctx.reply("🛡 Антискам включён. Я буду предупреждать о подозрительных ссылках и сообщениях." +
        (saved ? "" : "\n⚠️ Cloudflare KV не сохранил настройки — после перезапуска они могут сброситься."));
    }
    if (action === "off" || action === "выкл") {
      delete state.groups[id];
      const saved = await saveState();
      return ctx.reply("Антискам выключен." + (saved ? "" : "\n⚠️ Настройка сохранена только до перезапуска."));
    }
    return ctx.reply("🛡 Антискам: " + (state.groups[id] ? "включён" : "выключен") +
      "\nКоманды: /antiscam on — включить, /antiscam off — выключить.");
  });

  bot.command("checksite", async ctx => {
    const raw = String(ctx.match || "").trim();
    if (!raw) return ctx.reply("Пример: /checksite https://example.com\nПроверяю только публичные HTTPS-сайты.");
    const status = await ctx.reply("🔎 Проверяю доступность сайта...");
    try {
      const result = await checkWebsite(raw);
      await ctx.api.editMessageText(ctx.chat.id, status.message_id,
        (result.ok ? "🟢 Сайт отвечает" : "🔴 Сайт вернул ошибку") +
        "\nАдрес: " + result.url + "\nHTTP: " + result.status + "\nВремя ответа: " + result.ms + " мс");
    } catch (error) {
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, "❌ Проверка не удалась: " + error.message).catch(() => {});
    }
  });

  bot.command("watch", async ctx => {
    const raw = String(ctx.match || "").trim();
    if (!raw) return ctx.reply("Пример: /watch https://example.com\nДобавлю сайт в мониторинг и сообщу, если его доступность изменится.");
    await loadState();
    const owned = state.watches.filter(item => String(item.userId) === String(ctx.from.id));
    if (owned.length >= 5) return ctx.reply("Можно отслеживать не более 5 сайтов одновременно. Удали один через /unwatch ID.");
    try {
      const result = await checkWebsite(raw);
      const id = require("node:crypto").randomBytes(3).toString("hex");
      const item = {
        id, userId: String(ctx.from.id), chatId: String(ctx.chat.id),
        url: new URL(raw).origin, lastOk: result.ok, lastStatus: result.status,
        createdAt: Date.now(), lastCheckedAt: Date.now()
      };
      state.watches.push(item);
      const saved = await saveState();
      await ctx.reply(
        "👁 Сайт добавлен в мониторинг.\nID: <code>" + id + "</code>\n" +
        "Адрес: " + escapeHtml(item.url) + "\n" +
        "Сейчас: " + (result.ok ? "🟢 доступен" : "🔴 ошибка") +
        "\nПроверка примерно раз в 5 минут." +
        (saved ? "" : "\n⚠️ Cloudflare KV не сохранил мониторинг. Добавь KV-переменные в Render, иначе запись потеряется после перезапуска."),
        { parse_mode: "HTML" }
      );
    } catch (error) {
      await ctx.reply("❌ Не удалось добавить сайт: " + error.message);
    }
  });

  bot.command("watches", async ctx => {
    await loadState();
    const items = state.watches.filter(item => String(item.userId) === String(ctx.from.id));
    if (!items.length) return ctx.reply("Список пуст. Добавь сайт: /watch https://example.com");
    const lines = items.map(item =>
      "• <code>" + item.id + "</code> — " + escapeHtml(item.url) +
      "\n  Статус: " + (item.lastOk ? "🟢 доступен" : "🔴 ошибка") +
      " · HTTP " + escapeHtml(item.lastStatus || "—")
    );
    return ctx.reply("👁 <b>МОИ САЙТЫ</b>\n\n" + lines.join("\n\n") +
      "\n\nУдалить: /unwatch ID", { parse_mode: "HTML" });
  });

  bot.command("unwatch", async ctx => {
    await loadState();
    const id = String(ctx.match || "").trim();
    if (!id) return ctx.reply("Формат: /unwatch ID\nПосмотреть ID: /watches");
    const before = state.watches.length;
    state.watches = state.watches.filter(item =>
      !(item.id === id && String(item.userId) === String(ctx.from.id))
    );
    if (state.watches.length === before) return ctx.reply("Сайт с таким ID не найден в твоём списке.");
    const saved = await saveState();
    return ctx.reply(saved ? "🗑 Сайт удалён из мониторинга." : "🗑 Удалён из памяти процесса. KV недоступен, после перезапуска список может восстановиться.");
  });

  async function pollWatches() {
    await loadState();
    for (const item of [...state.watches]) {
      try {
        const result = await checkWebsite(item.url);
        const changed = item.lastOk !== result.ok;
        item.lastOk = result.ok;
        item.lastStatus = result.status;
        item.lastCheckedAt = Date.now();
        if (changed) {
          const message = result.ok
            ? "🟢 <b>Сайт снова доступен</b>\n" + escapeHtml(item.url) + "\nHTTP " + escapeHtml(result.status)
            : "🔴 <b>Сайт перестал отвечать</b>\n" + escapeHtml(item.url) + "\nHTTP " + escapeHtml(result.status);
          await bot.api.sendMessage(Number(item.chatId), message, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(error => {
            console.warn("NEXUS uptime notification:", error.message);
          });
        }
      } catch (error) {
        const changed = item.lastOk !== false;
        item.lastOk = false;
        item.lastStatus = "ERROR";
        item.lastCheckedAt = Date.now();
        if (changed) {
          await bot.api.sendMessage(Number(item.chatId),
            "🔴 <b>Не удалось проверить сайт</b>\n" + escapeHtml(item.url) +
            "\nПричина: " + escapeHtml(error.message.slice(0, 180)),
            { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
          ).catch(() => {});
        }
      }
    }
    await saveState();
  }

  if (!monitorTimer) {
    monitorTimer = setInterval(() => {
      pollWatches().catch(error => console.error("NEXUS uptime poll:", error.message));
    }, 5 * 60 * 1000);
    monitorTimer.unref?.();
    setTimeout(() => {
      pollWatches().catch(error => console.error("NEXUS uptime initial poll:", error.message));
    }, 15000).unref?.();
  }
}

module.exports = { installSecurityMonitor, checkWebsite };
