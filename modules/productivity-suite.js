"use strict";
const dns = require("node:dns/promises");
const crypto = require("node:crypto");
const QRCode = require("qrcode");
const { InputFile } = require("grammy");

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const KEY = "nexus:productivity-tools:v1";
const state = { users: {} };
let loadPromise = null;
let saveChain = Promise.resolve();

function kvReady() { return Boolean(ACCOUNT && TOKEN && NAMESPACE); }
function kvUrl() {
  return "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(ACCOUNT) +
    "/storage/kv/namespaces/" + encodeURIComponent(NAMESPACE) + "/values/" + encodeURIComponent(KEY);
}
async function loadState() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (!kvReady()) return;
    try {
      const r = await fetch(kvUrl(), {
        headers: { Authorization: "Bearer " + TOKEN }, signal: AbortSignal.timeout(10000)
      });
      if (r.status === 404) return;
      if (!r.ok) throw new Error("KV HTTP " + r.status);
      const value = await r.json();
      if (value && typeof value === "object" && value.users && typeof value.users === "object") state.users = value.users;
    } catch (e) { console.error("NEXUS tools load:", e.message); }
  })();
  return loadPromise;
}
async function saveState() {
  await loadState();
  if (!kvReady()) return false;
  const body = JSON.stringify(state);
  const write = async () => {
    const r = await fetch(kvUrl(), {
      method: "PUT",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body, signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error("KV HTTP " + r.status);
  };
  saveChain = saveChain.then(write, write);
  try { await saveChain; return true; }
  catch (e) { console.error("NEXUS tools save:", e.message); saveChain = Promise.resolve(); return false; }
}
function recordFor(id) {
  const key = String(id);
  if (!state.users[key]) state.users[key] = { notes: [], todos: [] };
  const r = state.users[key];
  if (!Array.isArray(r.notes)) r.notes = [];
  if (!Array.isArray(r.todos)) r.todos = [];
  return r;
}
function makeId(items) {
  let id;
  do { id = crypto.randomBytes(3).toString("hex"); } while (items.some(x => x.id === id));
  return id;
}
function warning(saved) {
  return saved ? "" : "\n\n⚠️ Cloudflare KV не настроен или недоступен: запись пока временная и может исчезнуть после перезапуска.";
}
function replyText(ctx) {
  const m = ctx.message && ctx.message.reply_to_message;
  return String(m && (m.text || m.caption) || "").trim();
}
function validDomain(value) {
  const d = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!d || d.length > 253 || d.includes("://") || d.includes("/") || d.includes(":")) return false;
  const labels = d.split(".");
  return labels.length > 1 && labels.every(x => x.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x));
}
function colorInfo(input) {
  const v = String(input || "").trim();
  let r, g, b, m = v.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map(x => x + x).join("");
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else {
    m = v.match(/^rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
    if (!m) throw new Error("Формат: /color #3498db или /color rgb(52,152,219)");
    r = +m[1]; g = +m[2]; b = +m[3];
    if ([r,g,b].some(x => x > 255)) throw new Error("RGB-компоненты должны быть от 0 до 255.");
  }
  const [rn,gn,bn] = [r,g,b].map(x => x / 255);
  const max = Math.max(rn,gn,bn), min = Math.min(rn,gn,bn), d = max-min;
  let h = 0;
  if (d) h = max === rn ? 60 * (((gn-bn)/d)%6) : max === gn ? 60*((bn-rn)/d+2) : 60*((rn-gn)/d+4);
  if (h < 0) h += 360;
  const l = (max+min)/2, s = d ? d/(1-Math.abs(2*l-1)) : 0;
  return {
    hex: "#" + [r,g,b].map(x => x.toString(16).padStart(2,"0")).join("").toUpperCase(),
    rgb: "rgb(" + r + ", " + g + ", " + b + ")",
    hsl: "hsl(" + Math.round(h) + ", " + Math.round(s*100) + "%, " + Math.round(l*100) + "%)"
  };
}
function parseDate(value) {
  const v = String(value || "").trim();
  if (!v) return new Date();
  if (/^-?\d{1,13}$/.test(v)) {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new Error("Некорректный timestamp.");
    return new Date(v.replace(/^-/, "").length <= 10 ? n*1000 : n);
  }
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) throw new Error("Не распознал дату. Пример: 2026-11-04T15:30:00+02:00");
  return d;
}
function timestampText(d) {
  if (!Number.isFinite(d.getTime())) throw new Error("Дата вне допустимого диапазона.");
  return "🕒 ДАТА И ВРЕМЯ\nISO: " + d.toISOString() +
    "\nUnix (сек): " + Math.floor(d.getTime()/1000) + "\nUnix (мс): " + d.getTime() +
    "\nКиев: " + new Intl.DateTimeFormat("ru-RU",{dateStyle:"full",timeStyle:"long",timeZone:"Europe/Kyiv"}).format(d) +
    "\nUTC: " + new Intl.DateTimeFormat("ru-RU",{dateStyle:"medium",timeStyle:"medium",timeZone:"UTC"}).format(d);
}
function zoneText(d, zone) {
  try {
    return new Intl.DateTimeFormat("ru-RU",{
      weekday:"long",year:"numeric",month:"long",day:"numeric",
      hour:"2-digit",minute:"2-digit",second:"2-digit",timeZone:zone,timeZoneName:"long"
    }).format(d);
  } catch { throw new Error("Неизвестный часовой пояс. Примеры: Europe/Kyiv, America/New_York, Asia/Tokyo."); }
}
function removeFence(s) {
  return String(s || "").trim().replace(/^\s*\x60{3}(?:json)?\s*/i,"").replace(/\s*\x60{3}\s*$/,"").trim();
}

function installProductivitySuite(bot) {
  bot.command("note", async ctx => {
    await loadState();
    const input = String(ctx.match || "").trim(), p = input.search(/\s/);
    const action = (p < 0 ? input || "list" : input.slice(0,p)).toLowerCase();
    const arg = p < 0 ? "" : input.slice(p).trim(), user = recordFor(ctx.from.id);
    if (["add","new"].includes(action)) {
      const text = (arg || replyText(ctx)).trim();
      if (!text) return ctx.reply("Формат: /note add текст или ответь /note add на сообщение.");
      if (text.length > 3500) return ctx.reply("Максимум 3500 символов в заметке.");
      if (user.notes.length >= 50) return ctx.reply("Лимит — 50 заметок. Удали старые через /note del ID.");
      const id = makeId(user.notes); user.notes.push({id,text,createdAt:Date.now()});
      return ctx.reply("📝 Заметка сохранена. ID: " + id + warning(await saveState()));
    }
    if (action === "list") {
      if (!user.notes.length) return ctx.reply("Заметок пока нет. Добавить: /note add текст");
      const rows = [...user.notes].sort((a,b)=>b.createdAt-a.createdAt).slice(0,25)
        .map(x => "• " + x.id + " — " + x.text.replace(/\s+/g," ").slice(0,100));
      return ctx.reply("📝 ТВОИ ЗАМЕТКИ (" + user.notes.length + "/50)\n\n" + rows.join("\n") + "\n\nОткрыть: /note get ID\nУдалить: /note del ID");
    }
    if (["get","show"].includes(action)) {
      const n = user.notes.find(x=>x.id===arg);
      if (!n) return ctx.reply("Заметка не найдена.");
      return ctx.reply("📝 ЗАМЕТКА " + n.id + "\n" + new Date(n.createdAt).toLocaleString("ru-RU",{timeZone:"Europe/Kyiv"}) + "\n\n" + n.text);
    }
    if (["del","delete","remove"].includes(action)) {
      const n = user.notes.length; user.notes = user.notes.filter(x=>x.id!==arg);
      if (user.notes.length===n) return ctx.reply("Заметка с таким ID не найдена.");
      return ctx.reply("🗑 Заметка удалена." + warning(await saveState()));
    }
    if (action === "search") {
      if (!arg) return ctx.reply("Формат: /note search слово");
      const found = user.notes.filter(x=>x.text.toLocaleLowerCase("ru").includes(arg.toLocaleLowerCase("ru")));
      if (!found.length) return ctx.reply("Совпадений не найдено.");
      return ctx.reply("🔎 НАЙДЕНО: " + found.length + "\n\n" + found.slice(0,20).map(x=>"• "+x.id+" — "+x.text.replace(/\s+/g," ").slice(0,100)).join("\n"));
    }
    return ctx.reply("📝 ЗАМЕТКИ\n/note add текст — создать\n/note list — список\n/note get ID — открыть\n/note search слово — поиск\n/note del ID — удалить");
  });

  bot.command("todo", async ctx => {
    await loadState();
    const input=String(ctx.match||"").trim(), p=input.search(/\s/);
    const action=(p<0?input||"list":input.slice(0,p)).toLowerCase(), arg=p<0?"":input.slice(p).trim();
    const user=recordFor(ctx.from.id);
    if (["add","new"].includes(action)) {
      const title=(arg||replyText(ctx)).trim();
      if (!title) return ctx.reply("Формат: /todo add Купить продукты");
      if (title.length>300) return ctx.reply("Максимум 300 символов в задаче.");
      if (user.todos.length>=100) return ctx.reply("Лимит — 100 задач.");
      const id=makeId(user.todos); user.todos.push({id,title,done:false,createdAt:Date.now(),completedAt:null});
      return ctx.reply("✅ Задача добавлена. ID: "+id+warning(await saveState()));
    }
    if (["list","show"].includes(action)) {
      if (!user.todos.length) return ctx.reply("Список задач пуст. Добавить: /todo add текст");
      const open=user.todos.filter(x=>!x.done), done=user.todos.filter(x=>x.done);
      const rows=[...open.slice(0,25).map(x=>"⬜ "+x.id+" — "+x.title),...done.slice(-10).reverse().map(x=>"✅ "+x.id+" — "+x.title)];
      return ctx.reply("📋 МОИ ЗАДАЧИ\nАктивных: "+open.length+" · Выполненных: "+done.length+"\n\n"+rows.join("\n")+"\n\nГотово: /todo done ID\nВернуть: /todo undo ID\nУдалить: /todo del ID");
    }
    if (["done","complete","undo"].includes(action)) {
      const t=user.todos.find(x=>x.id===arg);
      if (!t) return ctx.reply("Задача не найдена.");
      if (action==="undo") { t.done=false; t.completedAt=null; }
      else { t.done=true; t.completedAt=Date.now(); }
      return ctx.reply((t.done?"✅ Выполнено: ":"↩️ Возвращено: ")+t.title+warning(await saveState()));
    }
    if (["del","delete","remove"].includes(action)) {
      const n=user.todos.length; user.todos=user.todos.filter(x=>x.id!==arg);
      if (n===user.todos.length) return ctx.reply("Задача не найдена.");
      return ctx.reply("🗑 Задача удалена."+warning(await saveState()));
    }
    if (action==="clear") { user.todos=[]; return ctx.reply("🧹 Список очищен."+warning(await saveState())); }
    return ctx.reply("📋 ЗАДАЧИ\n/todo add текст — добавить\n/todo list — список\n/todo done ID — выполнить\n/todo undo ID — вернуть\n/todo del ID — удалить\n/todo clear — очистить");
  });

  bot.command("poll", async ctx => {
    const parts=String(ctx.match||"").split("|").map(x=>x.trim()).filter(Boolean);
    if (parts.length<3||parts.length>11) return ctx.reply("Формат: /poll Вопрос | вариант 1 | вариант 2\nНужно 2–10 вариантов.");
    const question=parts[0], options=parts.slice(1);
    if (question.length>300||options.some(x=>x.length>100)) return ctx.reply("Вопрос — до 300, каждый вариант — до 100 символов.");
    try {
      await ctx.api.sendPoll(ctx.chat.id,question,options,{is_anonymous:true,allows_multiple_answers:false});
      return ctx.reply("📊 Опрос создан. Голосуй в сообщении выше.");
    } catch(e) { return ctx.reply("❌ Не удалось создать опрос: "+String(e.message).slice(0,300)); }
  });

  bot.command("qr", async ctx => {
    const value=String(ctx.match||"").trim()||replyText(ctx);
    if (!value) return ctx.reply("Формат: /qr текст или ссылка. Можно ответить /qr на сообщение.");
    if (value.length>2000) return ctx.reply("Максимум 2000 символов для QR.");
    try {
      const png=await QRCode.toBuffer(value,{type:"png",width:900,margin:2,errorCorrectionLevel:"M"});
      return ctx.replyWithPhoto(new InputFile(png,"nexus-qr.png"),{caption:"▦ QR-код готов. Создан локально, без стороннего API."});
    } catch(e) { return ctx.reply("❌ QR не создан: "+String(e.message).slice(0,300)); }
  });

  bot.command("dns", async ctx => {
    const domain=String(ctx.match||"").trim().toLowerCase().replace(/\.$/,"");
    if (!validDomain(domain)) return ctx.reply("Формат: /dns example.com\nЗаписи A, AAAA, MX, NS, TXT, CAA.");
    const result=await Promise.all([
      dns.resolve4(domain).catch(()=>[]),dns.resolve6(domain).catch(()=>[]),
      dns.resolveMx(domain).catch(()=>[]),dns.resolveNs(domain).catch(()=>[]),
      dns.resolveTxt(domain).catch(()=>[]),dns.resolveCaa(domain).catch(()=>[])
    ]);
    const [a,aaaa,mx,ns,txt,caa]=result;
    const lines=[
      "A: "+(a.join(", ")||"—"),"AAAA: "+(aaaa.join(", ")||"—"),
      "MX: "+(mx.sort((x,y)=>x.priority-y.priority).map(x=>x.exchange+" ("+x.priority+")").join(", ")||"—"),
      "NS: "+(ns.join(", ")||"—"),"TXT: "+(txt.map(x=>x.join("")).join(" | ").slice(0,900)||"—"),
      "CAA: "+(caa.map(x=>x.issue+" ["+x.tag+"]").join(", ")||"—")
    ];
    return ctx.reply("🌐 DNS: "+domain+"\n\n"+lines.join("\n"));
  });

  bot.command("tz", async ctx => {
    const zone=String(ctx.match||"").trim();
    if (!zone) return ctx.reply("Формат: /tz Europe/Kyiv\nПримеры: Europe/Kyiv, Europe/London, America/New_York, Asia/Tokyo.");
    try { return ctx.reply("🕰 "+zone+"\n"+zoneText(new Date(),zone)); }
    catch(e) { return ctx.reply("❌ "+e.message); }
  });

  bot.command("timestamp", async ctx => {
    try { return ctx.reply(timestampText(parseDate(ctx.match))); }
    catch(e) { return ctx.reply("❌ "+e.message); }
  });

  bot.command("color", async ctx => {
    const input=String(ctx.match||"").trim();
    if (!input) return ctx.reply("Формат: /color #3498db или /color rgb(52,152,219)");
    try {
      const c=colorInfo(input);
      return ctx.reply("🎨 ЦВЕТ\nHEX: "+c.hex+"\nRGB: "+c.rgb+"\nHSL: "+c.hsl);
    } catch(e) { return ctx.reply("❌ "+e.message); }
  });

  bot.command("jsoncheck", async ctx => {
    const raw=String(ctx.match||"").trim()||replyText(ctx);
    if (!raw) return ctx.reply("Формат: /jsoncheck {\"name\":\"NEXUS\"} или ответь командой на JSON.");
    let parsed;
    try { parsed=JSON.parse(removeFence(raw)); }
    catch(e) { return ctx.reply("❌ JSON некорректен: "+e.message.slice(0,450)); }
    const pretty=JSON.stringify(parsed,null,2), kind=parsed===null?"null":Array.isArray(parsed)?"массив":typeof parsed;
    const count=parsed&&typeof parsed==="object"?Object.keys(parsed).length:0;
    if (pretty.length<=3500) {
      const safe=pretty.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      return ctx.reply("✅ JSON корректен · тип: "+kind+(count?" · ключей/элементов: "+count:"")+"\n\n<pre>"+safe+"</pre>",{parse_mode:"HTML"});
    }
    return ctx.replyWithDocument(new InputFile(Buffer.from(pretty,"utf8"),"formatted.json"),{caption:"✅ JSON корректен. Отформатированный файл."});
  });

  bot.command("urlinfo", async ctx => {
    const raw=String(ctx.match||"").trim()||replyText(ctx);
    if (!raw) return ctx.reply("Формат: /urlinfo https://example.com/path?x=1");
    try {
      const u=new URL(raw);
      if (!["http:","https:"].includes(u.protocol)) throw new Error("Поддерживаются только HTTP и HTTPS.");
      if (u.username||u.password) throw new Error("Ссылки со встроенным логином или паролем не анализируются.");
      const params=[...u.searchParams.entries()].slice(0,15).map(([k,v])=>k+"="+(/pass|password|token|secret|auth|key|code|session/i.test(k)?"[скрыто]":v.slice(0,120)));
      return ctx.reply("🔗 РАЗБОР ССЫЛКИ\nПротокол: "+u.protocol.replace(":","")+"\nДомен: "+u.hostname+
        "\nПорт: "+(u.port||"по умолчанию")+"\nПуть: "+(u.pathname||"/")+
        "\nПараметры: "+(params.join(" · ")||"нет")+"\nФрагмент: "+(u.hash?u.hash.slice(0,120):"нет"));
    } catch(e) { return ctx.reply("❌ "+e.message); }
  });
}
module.exports={installProductivitySuite,colorInfo,parseDate,timestampText,validDomain};
