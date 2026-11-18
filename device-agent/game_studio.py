"""Safe local game-project scaffold generator for NEXUS Windows Agent."""
from pathlib import Path
import re
import json
import zipfile
from datetime import datetime

def _slug(value):
    value = re.sub(r"[^\w -]", "", str(value or ""), flags=re.UNICODE).strip()
    value = re.sub(r"[\s-]+", "-", value).strip("-")
    return value[:48] or "new-game"

def create_game_project(args):
    args = args or {}
    name = str(args.get("name", "New Game")).strip()
    brief = str(args.get("description", "")).strip()
    if not name or len(name) > 60:
        raise ValueError("Название игры должно содержать от 1 до 60 символов.")
    if not brief or len(brief) > 4000:
        raise ValueError("Описание игры должно содержать от 1 до 4000 символов.")
    root = Path.home() / "Documents" / "NEXUS-Projects"
    root.mkdir(parents=True, exist_ok=True)
    folder = root / _slug(name)
    if folder.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        folder = root / (_slug(name) + "-" + stamp)
    folder.mkdir(parents=False, exist_ok=False)

    safe_title = name.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    spec = "# " + name + "\n\n## Задание пользователя\n\n" + brief + "\n\n## Статус\n\nСоздан стартовый HTML5 Canvas-проект. Это каркас, а не законченная реализация всего задания. Следующий этап — разбор требований, генерация игровых механик и тестирование.\n"
    html = """<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>__TITLE__ — NEXUS Game Studio</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="shell">
    <header><div><p class="eyebrow">NEXUS GAME STUDIO</p><h1>__TITLE__</h1><p>Стартовый игровой прототип</p></div><div class="score">Счёт: <b id="score">0</b></div></header>
    <canvas id="game" width="960" height="540" aria-label="Игровое поле"></canvas>
    <footer><span>Управление: WASD / стрелки</span><button id="restart">Заново</button></footer>
  </main>
  <script src="game.js"></script>
</body>
</html>
""".replace("__TITLE__", safe_title)
    css = """*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#101522;color:#eef3ff;font:16px system-ui,sans-serif;display:grid;place-items:center;padding:24px}.shell{width:min(100%,1000px)}header,footer{display:flex;align-items:center;justify-content:space-between;gap:16px}h1{margin:0;font-size:clamp(26px,5vw,42px)}header p{color:#aab6cf;margin:6px 0}.eyebrow{letter-spacing:.18em;font-size:11px;color:#77d6c5}canvas{display:block;width:100%;height:auto;margin:22px 0;border:1px solid #34425e;border-radius:16px;background:#18243a;box-shadow:0 20px 60px #0006}.score{background:#202d45;padding:12px 18px;border-radius:12px}button{border:0;border-radius:10px;padding:10px 16px;background:#77d6c5;color:#10202a;font-weight:700;cursor:pointer}footer{color:#aab6cf;font-size:14px}
"""
    js = """(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const keys = new Set();
  let player, star, score, running;
  const rand = (min,max) => min + Math.random() * (max-min);
  function reset(){ player={x:canvas.width/2,y:canvas.height/2,r:16,speed:4}; star={x:rand(30,canvas.width-30),y:rand(30,canvas.height-30),r:10}; score=0; running=true; scoreEl.textContent=score; }
  addEventListener('keydown',e=>{const k=e.key.toLowerCase();if(['arrowup','arrowdown','arrowleft','arrowright',' '].includes(k))e.preventDefault();keys.add(k);});
  addEventListener('keyup',e=>keys.delete(e.key.toLowerCase()));
  document.getElementById('restart').addEventListener('click',reset);
  function frame(){
    if(running){
      if(keys.has('w')||keys.has('arrowup'))player.y-=player.speed;
      if(keys.has('s')||keys.has('arrowdown'))player.y+=player.speed;
      if(keys.has('a')||keys.has('arrowleft'))player.x-=player.speed;
      if(keys.has('d')||keys.has('arrowright'))player.x+=player.speed;
      player.x=Math.max(player.r,Math.min(canvas.width-player.r,player.x));
      player.y=Math.max(player.r,Math.min(canvas.height-player.r,player.y));
      if(Math.hypot(player.x-star.x,player.y-star.y)<player.r+star.r){score++;scoreEl.textContent=score;star={x:rand(30,canvas.width-30),y:rand(30,canvas.height-30),r:10};}
    }
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle='#263753';ctx.lineWidth=1;
    for(let x=0;x<canvas.width;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke();}
    for(let y=0;y<canvas.height;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke();}
    ctx.fillStyle='#ffd166';ctx.beginPath();ctx.arc(star.x,star.y,star.r,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#77d6c5';ctx.beginPath();ctx.arc(player.x,player.y,player.r,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#10202a';ctx.beginPath();ctx.arc(player.x-5,player.y-3,2,0,Math.PI*2);ctx.arc(player.x+5,player.y-3,2,0,Math.PI*2);ctx.fill();
    requestAnimationFrame(frame);
  }
  reset();frame();
})();
"""
    (folder / "index.html").write_text(html, encoding="utf-8")
    (folder / "style.css").write_text(css, encoding="utf-8")
    (folder / "game.js").write_text(js, encoding="utf-8")
    (folder / "GAME_SPEC.md").write_text(spec, encoding="utf-8")
    manifest = {"name": name, "description": brief, "engine": "HTML5 Canvas", "created_at": datetime.now().isoformat(timespec="seconds"), "status": "starter"}
    (folder / "project.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    archive = root / (folder.name + ".zip")
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in folder.rglob("*"):
            if item.is_file():
                zf.write(item, item.relative_to(root))
    return "Создан стартовый проект игры: " + str(folder) + "\nАрхив: " + str(archive) + "\nОткрой index.html в браузере. Внутри есть рабочий Canvas-прототип с движением WASD/стрелками и сбором объектов. Полное описание задания сохранено в GAME_SPEC.md. Это первый каркас; генерация полноценной игры и APK/EXE-сборка будут следующим этапом."
