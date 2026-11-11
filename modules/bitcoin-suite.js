"use strict";
const A=process.env.CLOUDFLARE_ACCOUNT_ID,T=process.env.CLOUDFLARE_API_TOKEN,N=process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const cache=new Map(),locks=new Set();
const url=id=>"https://api.cloudflare.com/client/v4/accounts/"+encodeURIComponent(A)+"/storage/kv/namespaces/"+encodeURIComponent(N)+"/values/nexus:bitcoin:"+id;
async function get(id){if(cache.has(String(id)))return cache.get(String(id));const s={balance:0,lastDaily:"",nextPromoAt:0};if(A&&T&&N){try{const r=await fetch(url(id),{headers:{Authorization:"Bearer "+T},signal:AbortSignal.timeout(8000)});if(r.ok)Object.assign(s,await r.json());}catch(e){console.error("BTC read",e.message);}}cache.set(String(id),s);return s;}
async function put(id,s){if(!(A&&T&&N))return false;try{const r=await fetch(url(id),{method:"PUT",headers:{Authorization:"Bearer "+T,"Content-Type":"application/json"},body:JSON.stringify(s),signal:AbortSignal.timeout(8000)});return r.ok;}catch(e){console.error("BTC write",e.message);return false;}}
const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Kyiv"}).format(new Date());
function pick(a){let n=Math.random()*a.reduce((s,x)=>s+x[1],0);for(const [v,w]of a){n-=w;if(n<0)return v;}return 0;}
function installBitcoinSuite(bot){
 bot.use(async(ctx,next)=>{if(ctx.from?.id&&ctx.chat?.type==="private"){const s=await get(ctx.from.id);if(!s.nextPromoAt)s.nextPromoAt=Date.now()+(24+Math.floor(Math.random()*49))*3600000;if(Date.now()>=s.nextPromoAt&&!ctx.message?.successful_payment){s.nextPromoAt=Date.now()+(24+Math.floor(Math.random()*49))*3600000;await put(ctx.from.id,s);await ctx.api.sendMessage(ctx.chat.id,"💎 <b>NEXUS Premium</b> — повышенные лимиты и приоритет ИИ. Посмотри тарифы.",{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"💎 Купить Premium · 50 ⭐",callback_data:"buy_plus"}],[{text:"🚀 Купить Ultra · 100 ⭐",callback_data:"buy_ultra"}],[{text:"Мой статус",callback_data:"btc_premium_status"}]]}}).catch(()=>{});}else await put(ctx.from.id,s);}await next();});
 bot.callbackQuery("btc_premium_status",async ctx=>{await ctx.answerCallbackQuery();await ctx.reply("Твой тариф и срок действия: /premium");});
 bot.command("btc",async ctx=>{const s=await get(ctx.from.id);await ctx.reply("₿ <b>NEXUS BITCOIN</b>\nБаланс: <b>"+s.balance+" ₿</b>\n\n/btcdaily — ежедневные 10 ₿\n/btcroulette — рулетка за 10 ₿\n/btccase — кейс за 50 ₿",{parse_mode:"HTML"});});
 bot.command("btcdaily",async ctx=>{const s=await get(ctx.from.id);if(s.lastDaily===today())return ctx.reply("⏳ Сегодня ты уже получил ежедневные 10 ₿.");s.lastDaily=today();s.balance+=10;if(!await put(ctx.from.id,s))return ctx.reply("❌ Не удалось сохранить баланс. Проверь Cloudflare KV.");return ctx.reply("🪙 Получено 10 ₿! Баланс: "+s.balance+" ₿");});
 async function game(ctx,cost,table,label){const id=String(ctx.from.id);if(locks.has(id))return ctx.reply("Операция уже выполняется.");locks.add(id);try{const s=await get(id);if(s.balance<cost)return ctx.reply("Не хватает ₿. Нужно "+cost+" ₿, у тебя "+s.balance+" ₿.");s.balance-=cost;const win=pick(table);s.balance+=win;if(!await put(id,s))return ctx.reply("❌ Не удалось сохранить результат. Попробуй позже.");return ctx.reply(label+"\n"+(win?"🎉 Выигрыш: +"+win+" ₿":"😵 Без выигрыша.")+"\nБаланс: "+s.balance+" ₿");}finally{locks.delete(id);}}
 bot.command("btcroulette",ctx=>game(ctx,10,[[0,55],[5,25],[20,15],[100,4],[500,1]],"🎰 NEXUS BTC ROULETTE"));
 bot.command("btccase",ctx=>game(ctx,50,[[0,45],[20,30],[50,18],[100,6],[500,1]],"📦 NEXUS BTC CASE"));
}
module.exports={installBitcoinSuite};
