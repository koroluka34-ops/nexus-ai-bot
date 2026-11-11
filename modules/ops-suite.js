"use strict";

const dns = require("node:dns/promises");
const net = require("node:net");

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const KEY = "nexus:ops-suite:v1";
const state = { groups: {}, rules: {} };
let loaded = false;
let saveTimer = null;
let saveChain = Promise.resolve();

function kvReady() { return Boolean(ACCOUNT && TOKEN && NAMESPACE); }
function kvUrl() {
  return "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(ACCOUNT) +
    "/storage/kv/namespaces/" + encodeURIComponent(NAMESPACE) + "/values/" + encodeURIComponent(KEY);
}
async function load() {
  if (loaded) return;
  loaded = true;
  if (!kvReady()) return;
  try {
    const response = await fetch(kvUrl(), { headers: { Authorization: "Bearer " + TOKEN }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return;
    const value = await response.json();
    if (value && typeof value === "object") {
      state.groups = value.groups && typeof value.groups === "object" ? value.groups : {};
      state.rules = value.rules && typeof value.rules === "object" ? value.rules : {};
    }
  } catch (error) { console.error("NEXUS ops load:", error.message); }
}
function scheduleSave() {
  if (!kvReady()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snapshot = JSON.stringify(state);
    saveChain = saveChain.then(async () => {
      const response = await fetch(kvUrl(), {
        method: "PUT",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
        body: snapshot, signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error("KV HTTP " + response.status);
    }).catch(error => console.error("NEXUS ops save:", error.message));
  }, 1500);
  saveTimer.unref?.();
}
function isGroup(ctx) { return ["group", "supergroup"].includes(ctx.chat?.type); }
async function isAdmin(ctx) {
  if (!isGroup(ctx)) return false;
  if (await isNexusAdmin(ctx.from.id)) return true;
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status === "creator" || member.status === "administrator";
  } catch { return false; }
}
function groupRecord(chatId) {
  const key = String(chatId);
  if (!state.groups[key]) state.groups[key] = { total: 0, users: {}, days: {}, hours: {} };
  return state.groups[key];
}
function esc(value) {
  return String(value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function isPrivateV4(ip) {
  const p = ip.split(".").map(Number), [a,b] = p;
  return p.length !== 4 || a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}
function isPrivateV6(ip) {
  const x = ip.toLowerCase();
  return x === "::" || x === "::1" || /^(fc|fd|fe[89ab])/.test(x) ||
    x.startsWith("::ffff:127.") || x.startsWith("::ffff:10.") || x.startsWith("::ffff:192.168.");
}
async function safeHttps(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("Укажи корректный URL https://"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Разрешены только публичные HTTPS URL без логина и пароля.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || net.isIP(host) || host === "localhost" || /\.(local|internal|test|invalid)$/.test(host)) throw new Error("Локальные адреса и IP запрещены.");
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(r => net.isIP(r.address) === 4 ? isPrivateV4(r.address) : isPrivateV6(r.address))) {
    throw new Error("Домен разрешается в локальный или зарезервированный IP.");
  }
  return url;
}
async function checkApi(raw) {
  const url = await safeHttps(raw);
  const started = Date.now();
  const response = await fetch(url, {
    method: "GET", redirect: "manual",
    headers: { "User-Agent": "NEXUS-API-Monitor/1.0", Accept: "application/json, */*" },
    signal: AbortSignal.timeout(10000)
  });
  const elapsed = Date.now() - started;
  const type = response.headers.get("content-type") || "не указан";
  let json = "не JSON";
  if (/json/i.test(type)) {
    try { await response.clone().json(); json = "валидный JSON"; }
    catch { json = "ошибка JSON"; }
  }
  return { status: response.status, ok: response.status >= 200 && response.status < 400, ms: elapsed, type, json, url: url.toString() };
}
async function domainCheck(domainInput) {
  const domain = String(domainInput || "").trim().toLowerCase().replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error("Укажи домен, например example.com");
  const [txt, dmarc, mx] = await Promise.all([
    dns.resolveTxt(domain).catch(() => []),
    dns.resolveTxt("_dmarc." + domain).catch(() => []),
    dns.resolveMx(domain).catch(() => [])
  ]);
  const flat = txt.flat().join(" ");
  const dmarcText = dmarc.flat().join(" ");
  return {
    domain, spf: /v=spf1/i.test(flat), dmarc: /v=DMARC1/i.test(dmarcText),
    mx: mx.length > 0, dmarcPolicy: (dmarcText.match(/p=([^;\s]+)/i) || [])[1] || "не найдена"
  };
}

function installOpsSuite(bot, askAI, isNexusAdmin = async () => false) {
  bot.use(async (ctx, next) => {
    try {
      await load();
      if (isGroup(ctx) && ctx.message && ctx.from && !ctx.from.is_bot) {
        const record = groupRecord(ctx.chat.id);
        const now = new Date();
        const day = now.toISOString().slice(0, 10);
        const hour = String(now.getUTCHours()).padStart(2, "0");
        record.total++;
        record.users[String(ctx.from.id)] = (record.users[String(ctx.from.id)] || 0) + 1;
        record.days[day] = (record.days[day] || 0) + 1;
        record.hours[hour] = (record.hours[hour] || 0) + 1;
        const cutoff = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
        for (const key of Object.keys(record.days)) if (key < cutoff) delete record.days[key];
        scheduleSave();

        const text = String(ctx.message.text || ctx.message.caption || "");
        const rules = state.rules[String(ctx.chat.id)] || [];
        const matched = rules.find(rule => text.toLocaleLowerCase("ru").includes(rule.phrase.toLocaleLowerCase("ru")));
        if (matched && !/^\/(?:rule|groupstats)(?:@\w+)?(?:\s|$)/i.test(text)) {
          await ctx.reply("📌 Напоминание правила группы: " + esc(matched.note) +
            "\nПравило: " + esc(matched.phrase),
            { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } }
          ).catch(() => {});
        }
      }
    } catch (error) { console.error("NEXUS ops middleware:", error.message); }
    await next();
  });

  bot.command("groupstats", async ctx => {
    if (!isGroup(ctx)) return ctx.reply("Команда работает в группах.");
    if (!await isAdmin(ctx)) return ctx.reply("Статистику группы могут смотреть только администраторы.");
    await load();
    const record = groupRecord(ctx.chat.id);
    const days = Object.entries(record.days).sort((a,b) => b[0].localeCompare(a[0])).slice(0,7);
    const top = Object.entries(record.users).sort((a,b) => b[1]-a[1]).slice(0,5);
    const userNames = [];
    for (const [id, count] of top) {
      let name = "ID " + id;
      try {
        const member = await ctx.api.getChatMember(ctx.chat.id, Number(id));
        name = [member.user.first_name, member.user.last_name].filter(Boolean).join(" ") || name;
      } catch {}
      userNames.push("• " + esc(name) + " — " + count);
    }
    const weekly = days.reduce((sum, x) => sum + x[1], 0);
    return ctx.reply(
      "📊 <b>СТАТИСТИКА ГРУППЫ</b>\n\nСообщений всего: " + record.total +
      "\nУчастников, писавших сообщения: " + Object.keys(record.users).length +
      "\nЗа последние 7 дней: " + weekly +
      "\n\n<b>Топ активности:</b>\n" + (userNames.join("\n") || "Пока нет данных") +
      "\n\n<b>По дням (UTC):</b>\n" + (days.map(([d,n]) => "• " + d + ": " + n).join("\n") || "Нет данных") +
      (kvReady() ? "" : "\n\n⚠️ KV не настроен: статистика сбросится при перезапуске."),
      { parse_mode: "HTML" }
    );
  });

  bot.command("rule", async ctx => {
    if (!isGroup(ctx)) return ctx.reply("Правила работают в группах.");
    if (!await isAdmin(ctx)) return ctx.reply("Добавлять правила могут только администраторы группы.");
    await load();
    const input = String(ctx.match || "").trim();
    const [action, ...rest] = input.split(/\s+/);
    const key = String(ctx.chat.id);
    const rules = state.rules[key] || (state.rules[key] = []);
    if (action === "add") {
      const value = rest.join(" ");
      const parts = value.split("|").map(x => x.trim());
      if (!parts[0] || parts[0].length < 3 || parts[0].length > 80 || !parts[1]) {
        return ctx.reply("Формат: /rule add рекламировать нельзя | Не размещай рекламу без разрешения");
      }
      if (rules.length >= 20) return ctx.reply("Лимит — 20 правил на группу.");
      const id = require("node:crypto").randomBytes(3).toString("hex");
      rules.push({ id, phrase: parts[0], note: parts.slice(1).join(" | ").slice(0, 240) });
      scheduleSave();
      return ctx.reply("✅ Правило добавлено. ID: " + id);
    }
    if (action === "remove") {
      const id = rest[0];
      const before = rules.length;
      state.rules[key] = rules.filter(x => x.id !== id);
      if (state.rules[key].length === before) return ctx.reply("Правило не найдено.");
      scheduleSave();
      return ctx.reply("🗑 Правило удалено.");
    }
    if (action === "list") {
      return ctx.reply(rules.length
        ? "📌 <b>ПРАВИЛА ГРУППЫ</b>\n" + rules.map(x => "• <code>" + x.id + "</code> — " + esc(x.phrase) + " → " + esc(x.note)).join("\n")
        : "Правил пока нет.", { parse_mode: "HTML" });
    }
    return ctx.reply("/rule add фраза | предупреждение\n/rule list\n/rule remove ID");
  });

  bot.command("checkapi", async ctx => {
    const raw = String(ctx.match || "").trim();
    if (!raw) return ctx.reply("Пример: /checkapi https://api.example.com/health");
    const status = await ctx.reply("📡 Проверяю API...");
    try {
      const r = await checkApi(raw);
      await ctx.api.editMessageText(ctx.chat.id, status.message_id,
        (r.ok ? "🟢 API отвечает" : "🔴 API вернул ошибку") +
        "\nHTTP: " + r.status + "\nЗадержка: " + r.ms + " мс" +
        "\nContent-Type: " + r.type + "\nJSON: " + r.json + "\nURL: " + r.url
      );
    } catch (error) {
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, "❌ " + error.message).catch(() => {});
    }
  });

  bot.command("domaincheck", async ctx => {
    const domain = String(ctx.match || "").trim();
    if (!domain) return ctx.reply("Пример: /domaincheck example.com\nПроверю SPF, DMARC и MX. Это проверка DNS-защиты домена, не поиск утечек.");
    try {
      const r = await domainCheck(domain);
      return ctx.reply(
        "🛡 <b>DNS-БЕЗОПАСНОСТЬ: " + esc(r.domain) + "</b>\n\n" +
        (r.spf ? "🟢" : "🔴") + " SPF: " + (r.spf ? "найден" : "не найден") + "\n" +
        (r.dmarc ? "🟢" : "🔴") + " DMARC: " + (r.dmarc ? "найден, политика " + esc(r.dmarcPolicy) : "не найден") + "\n" +
        (r.mx ? "🟢" : "⚪") + " MX: " + (r.mx ? "почтовые серверы найдены" : "не найдены"),
        { parse_mode: "HTML" }
      );
    } catch (error) { return ctx.reply("❌ " + error.message); }
  });

  bot.command("factcheck", async ctx => {
    const claim = String(ctx.match || "").trim() || String(ctx.message.reply_to_message?.text || "").trim();
    if (!claim) return ctx.reply("Пример: /factcheck В интернете пишут, что ...");
    if (typeof askAI !== "function") return ctx.reply("Проверка фактов временно недоступна.");
    const status = await ctx.reply("🕵️ Анализирую утверждение...");
    try {
      const result = await askAI(ctx.from.id,
        "Проведи предварительную проверку утверждения. Раздели ответ на: что именно утверждается, что можно оценить по общим знаниям, что требует свежих источников, возможные манипуляции. Не выдумывай ссылки и не объявляй утверждение доказанным без источников. Чётко укажи, что это предварительный анализ без независимого веб-поиска.\n\nУтверждение: " + claim.slice(0, 5000),
        false
      );
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, "🕵️ ПРЕДВАРИТЕЛЬНЫЙ РАЗБОР\n\n" + String(result.answer || "").slice(0, 3500)).catch(async () => {
        await ctx.reply(String(result.answer || "").slice(0, 3500));
      });
    } catch (error) {
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, "❌ " + String(error.message).slice(0, 500)).catch(() => {});
    }
  });

  bot.command("nexushealth", async ctx => {
    const mem = process.memoryUsage();
    const uptime = Math.floor(process.uptime());
    const fmt = n => (n / 1024 / 1024).toFixed(1) + " MB";
    const duration = Math.floor(uptime / 3600) + " ч " + Math.floor((uptime % 3600) / 60) + " мин";
    await ctx.reply(
      "🖥 <b>NEXUS — СОСТОЯНИЕ ПРОЦЕССА</b>\n\n" +
      "Uptime: " + duration + "\nRAM RSS: " + fmt(mem.rss) +
      "\nHeap: " + fmt(mem.heapUsed) + " / " + fmt(mem.heapTotal) +
      "\nNode.js: " + process.version + "\nПлатформа: " + process.platform +
      "\nCPU cores: " + require("node:os").cpus().length +
      "\nCloudflare KV: " + (kvReady() ? "настроен" : "не настроен") +
      "\nСборка: " + (process.env.RENDER_GIT_COMMIT || "неизвестна"),
      { parse_mode: "HTML" }
    );
  });
}

module.exports = { installOpsSuite, checkApi, domainCheck };
