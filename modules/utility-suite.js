"use strict";

const dns = require("node:dns/promises");

function validDomain(value) {
  const d = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!d || d.length > 253 || d.includes("://") || d.includes("/") || d.includes(":")) return false;
  const labels = d.split(".");
  return labels.length >= 2 && labels.every(x =>
    x.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x)
  );
}

function colorInfo(input) {
  const v = String(input || "").trim();
  let r, g, b, m = v.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map(x => x + x).join("");
    r = parseInt(h.slice(0,2),16); g = parseInt(h.slice(2,4),16); b = parseInt(h.slice(4,6),16);
  } else {
    m = v.match(/^rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
    if (!m) throw new Error("Формат: /color #3498db или /color rgb(52,152,219)");
    r = +m[1]; g = +m[2]; b = +m[3];
    if ([r,g,b].some(x => x > 255)) throw new Error("RGB-компоненты должны быть от 0 до 255.");
  }
  const [rn,gn,bn] = [r,g,b].map(x=>x/255);
  const max=Math.max(rn,gn,bn), min=Math.min(rn,gn,bn), delta=max-min;
  let h=0;
  if (delta) h=max===rn?60*(((gn-bn)/delta)%6):max===gn?60*((bn-rn)/delta+2):60*((rn-gn)/delta+4);
  if (h<0) h+=360;
  const l=(max+min)/2, s=delta?delta/(1-Math.abs(2*l-1)):0;
  return {
    hex:"#"+[r,g,b].map(x=>x.toString(16).padStart(2,"0")).join("").toUpperCase(),
    rgb:"rgb("+r+", "+g+", "+b+")",
    hsl:"hsl("+Math.round(h)+", "+Math.round(s*100)+"%, "+Math.round(l*100)+"%)"
  };
}

function parseDate(value) {
  const v=String(value||"").trim();
  if (!v) return new Date();
  if (/^-?\d{1,13}$/.test(v)) {
    const n=Number(v);
    if (!Number.isSafeInteger(n)) throw new Error("Некорректный Unix timestamp.");
    return new Date(v.replace(/^-/, "").length<=10?n*1000:n);
  }
  const d=new Date(v);
  if (!Number.isFinite(d.getTime())) throw new Error("Не распознал дату. Пример: 2026-11-04T15:30:00+02:00");
  return d;
}

function stripFence(value) {
  return String(value||"").trim()
    .replace(/^\s*\x60{3}(?:json)?\s*/i,"")
    .replace(/\s*\x60{3}\s*$/,"").trim();
}

function installUtilitySuite(bot) {
  bot.command("dns", async ctx => {
    const domain=String(ctx.match||"").trim().toLowerCase().replace(/\.$/,"");
    if (!validDomain(domain)) return ctx.reply("Формат: /dns example.com\nПоказываю записи A, AAAA, MX, NS, TXT и CAA.");
    const results=await Promise.all([
      dns.resolve4(domain).catch(()=>[]), dns.resolve6(domain).catch(()=>[]),
      dns.resolveMx(domain).catch(()=>[]), dns.resolveNs(domain).catch(()=>[]),
      dns.resolveTxt(domain).catch(()=>[]), dns.resolveCaa(domain).catch(()=>[])
    ]);
    const [a,aaaa,mx,ns,txt,caa]=results;
    const rows=[
      "A: "+(a.join(", ")||"—"),
      "AAAA: "+(aaaa.join(", ")||"—"),
      "MX: "+(mx.sort((x,y)=>x.priority-y.priority).map(x=>x.exchange+" ("+x.priority+")").join(", ")||"—"),
      "NS: "+(ns.join(", ")||"—"),
      "TXT: "+(txt.map(x=>x.join("")).join(" | ").slice(0,850)||"—"),
      "CAA: "+(caa.map(x=>x.issue+" ["+x.tag+"]").join(", ")||"—")
    ];
    return ctx.reply("🌐 DNS: "+domain+"\n\n"+rows.join("\n"));
  });

  bot.command("tz", async ctx => {
    const zone=String(ctx.match||"").trim();
    if (!zone) return ctx.reply("Формат: /tz Europe/Kyiv\nПримеры: Europe/Kyiv, Europe/London, America/New_York, Asia/Tokyo.");
    try {
      const value=new Intl.DateTimeFormat("ru-RU",{
        weekday:"long",year:"numeric",month:"long",day:"numeric",
        hour:"2-digit",minute:"2-digit",second:"2-digit",timeZone:zone,timeZoneName:"long"
      }).format(new Date());
      return ctx.reply("🕰 "+zone+"\n"+value);
    } catch {
      return ctx.reply("❌ Неизвестный часовой пояс. Пример: Europe/Kyiv или America/New_York.");
    }
  });

  bot.command("timestamp", async ctx => {
    try {
      const d=parseDate(ctx.match);
      return ctx.reply("🕒 ДАТА И ВРЕМЯ\nISO: "+d.toISOString()+
        "\nUnix (сек): "+Math.floor(d.getTime()/1000)+"\nUnix (мс): "+d.getTime()+
        "\nКиев: "+new Intl.DateTimeFormat("ru-RU",{dateStyle:"full",timeStyle:"long",timeZone:"Europe/Kyiv"}).format(d)+
        "\nUTC: "+new Intl.DateTimeFormat("ru-RU",{dateStyle:"medium",timeStyle:"medium",timeZone:"UTC"}).format(d));
    } catch(e) { return ctx.reply("❌ "+e.message); }
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
    const quoted=ctx.message&&ctx.message.reply_to_message;
    const raw=String(ctx.match||"").trim()||String(quoted&&(quoted.text||quoted.caption)||"").trim();
    if (!raw) return ctx.reply("Формат: /jsoncheck {\"name\":\"NEXUS\"} или ответь командой на сообщение с JSON.");
    let value;
    try { value=JSON.parse(stripFence(raw)); }
    catch(e) { return ctx.reply("❌ JSON некорректен: "+e.message.slice(0,400)); }
    const pretty=JSON.stringify(value,null,2);
    const kind=value===null?"null":Array.isArray(value)?"массив":typeof value;
    const count=value&&typeof value==="object"?Object.keys(value).length:0;
    const safe=pretty.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    if (pretty.length>3500) return ctx.reply("✅ JSON корректен. Тип: "+kind+". Объём: "+pretty.length+" символов. Слишком большой вывод для одного сообщения; уменьши JSON или пришли его частями.");
    return ctx.reply("✅ JSON корректен · тип: "+kind+(count?" · элементов верхнего уровня: "+count:"")+"\n\n<pre>"+safe+"</pre>",{parse_mode:"HTML"});
  });

  bot.command("urlinfo", async ctx => {
    const quoted=ctx.message&&ctx.message.reply_to_message;
    const raw=String(ctx.match||"").trim()||String(quoted&&(quoted.text||quoted.caption)||"").trim();
    if (!raw) return ctx.reply("Формат: /urlinfo https://example.com/path?x=1");
    try {
      const u=new URL(raw);
      if (!["http:","https:"].includes(u.protocol)) throw new Error("Поддерживаются только HTTP и HTTPS.");
      if (u.username||u.password) throw new Error("Ссылка содержит встроенные учётные данные — разбор отменён.");
      const params=[...u.searchParams.entries()].slice(0,15).map(([k,v])=>
        k+"="+(/pass|password|token|secret|auth|key|code|session/i.test(k)?"[скрыто]":v.slice(0,100))
      );
      return ctx.reply("🔗 РАЗБОР URL\nПротокол: "+u.protocol.replace(":","")+
        "\nДомен: "+u.hostname+"\nПорт: "+(u.port||"стандартный")+
        "\nПуть: "+(u.pathname||"/")+"\nПараметры: "+(params.join(" · ")||"нет")+
        "\nФрагмент: "+(u.hash?u.hash.slice(0,100):"нет"));
    } catch(e) { return ctx.reply("❌ "+e.message); }
  });
}

module.exports={installUtilitySuite,validDomain,colorInfo,parseDate,stripFence};
