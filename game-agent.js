"use strict";

const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");

class GameAgent {
  constructor(options = {}) {
    this.decide = options.decide;
    this.bot = null;
    this.movements = null;
    this.autonomy = false;
    this.task = "";
    this.loopPromise = null;
    this.lastChatAt = 0;
    this.lastDecision = "Пока нет решений";
    this.lastError = "";
    this.startedAt = null;
  }

  isConnected() {
    return Boolean(this.bot && this.bot.entity);
  }

  status() {
    if (!this.bot) return "Отключён";
    const p = this.bot.entity?.position;
    const pos = p ? [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)].join(", ") : "ещё не появился";
    return [
      this.bot.entity ? "Подключён" : "Подключается",
      "Ник: " + this.bot.username,
      "Здоровье: " + (this.bot.health ?? "?") + "/20",
      "Голод: " + (this.bot.food ?? "?") + "/20",
      "Позиция: " + pos,
      "Автономный режим: " + (this.autonomy ? "включён" : "выключен"),
      this.lastDecision ? "Последнее решение: " + this.lastDecision : "",
      this.lastError ? "Ошибка: " + this.lastError : ""
    ].filter(Boolean).join("\n");
  }

  connect() {
    if (this.bot) throw new Error("Игровой бот уже подключён или подключается.");

    const host = process.env.MC_HOST || "skyyforge.falix.pro";
    const port = Number(process.env.MC_PORT || 20508);
    const username = process.env.MC_USERNAME || "NEXUS_AI";
    const version = process.env.MC_VERSION || "26.3";
    const auth = process.env.MC_AUTH || "offline";

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("MC_PORT должен быть числом от 1 до 65535.");
    }
    if (!["offline", "microsoft"].includes(auth)) {
      throw new Error("MC_AUTH должен быть offline или microsoft.");
    }

    this.lastError = "";
    this.startedAt = Date.now();
    this.bot = mineflayer.createBot({
      host, port, username, version, auth,
      hideErrors: false,
      checkTimeoutInterval: 60000
    });

    this.bot.loadPlugin(pathfinder);

    this.bot.once("spawn", () => {
      this.movements = new Movements(this.bot);
      this.movements.canDig = false;
      this.movements.allow1by1towers = false;
      this.bot.pathfinder.setMovements(this.movements);
      const loginCommand = process.env.MC_LOGIN_COMMAND;
      if (loginCommand) {
        setTimeout(() => {
          if (this.bot && this.bot.entity) this.bot.chat(loginCommand.slice(0, 200));
        }, 2500);
      }
    });

    this.bot.on("kicked", reason => {
      this.lastError = "Сервер отключил бота: " + String(reason).slice(0, 300);
      this.stopAutonomy();
      this.bot = null;
      this.movements = null;
    });

    this.bot.on("error", error => {
      this.lastError = error.message || String(error);
    });

    this.bot.on("end", () => {
      this.stopAutonomy();
      this.bot = null;
      this.movements = null;
    });

    return "Подключаю " + username + " к " + host + ":" + port + " (Minecraft " + version + ", auth=" + auth + ")...";
  }

  disconnect() {
    this.stopAutonomy();
    if (!this.bot) return "Игровой бот уже отключён.";
    const bot = this.bot;
    this.bot = null;
    this.movements = null;
    bot.quit("NEXUS AI отключается");
    return "Игровой бот отключается от сервера.";
  }

  stopAutonomy() {
    this.autonomy = false;
    if (this.bot?.pathfinder) this.bot.pathfinder.setGoal(null);
  }

  follow(username = process.env.MC_OWNER || "Edison0009") {
    if (!this.isConnected()) throw new Error("Сначала подключи игрового бота: /gameconnect");
    const player = this.bot.players[username];
    if (!player?.entity) throw new Error("Не вижу игрока " + username + ". Он должен быть в сети рядом.");
    this.bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true);
    this.lastDecision = "Следую за " + username;
    return "Иду за " + username + ".";
  }

  observe() {
    if (!this.isConnected()) throw new Error("Игровой бот не подключён.");
    const b = this.bot;
    const p = b.entity.position;
    const entities = Object.values(b.entities)
      .filter(e => e && e.id !== b.entity.id && e.position && p.distanceTo(e.position) < 16)
      .slice(0, 16)
      .map(e => ({
        name: e.username || e.name || e.displayName || e.type,
        kind: e.type,
        distance: Math.round(p.distanceTo(e.position) * 10) / 10,
        position: [Math.round(e.position.x), Math.round(e.position.y), Math.round(e.position.z)]
      }));
    const nearbyBlocks = [];
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -1; dy <= 2; dy++) {
        for (let dz = -3; dz <= 3; dz++) {
          const block = b.blockAt(p.offset(dx, dy, dz));
          if (block && block.name !== "air" && nearbyBlocks.length < 45) {
            nearbyBlocks.push({ name: block.name, offset: [dx, dy, dz] });
          }
        }
      }
    }
    return {
      position: [Math.round(p.x), Math.round(p.y), Math.round(p.z)],
      health: b.health,
      food: b.food,
      time: b.time?.timeOfDay,
      dimension: b.game?.dimension,
      task: this.task,
      players: Object.keys(b.players).filter(n => n !== b.username).slice(0, 10),
      entities,
      nearbyBlocks
    };
  }

  async execute(decision) {
    if (!this.isConnected()) return "disconnected";
    const action = String(decision?.action || "wait").toLowerCase();
    const b = this.bot;

    if (action === "follow") {
      const name = String(decision.target || process.env.MC_OWNER || "Edison0009").slice(0, 16);
      return this.follow(name);
    }
    if (action === "stop") {
      b.pathfinder.setGoal(null);
      return "Остановился.";
    }
    if (action === "look") {
      const name = String(decision.target || process.env.MC_OWNER || "Edison0009");
      const target = b.players[name]?.entity;
      if (target) {
        await b.lookAt(target.position.offset(0, 1.4, 0), true);
        return "Посмотрел на " + name + ".";
      }
      return "Игрока для взгляда не вижу.";
    }
    if (action === "say") {
      const now = Date.now();
      if (now - this.lastChatAt < 12000) return "Сообщение пропущено: ограничение частоты чата.";
      const message = String(decision.message || "").replace(/[\r\n]/g, " ").slice(0, 180);
      if (message) {
        b.chat(message);
        this.lastChatAt = now;
        return "Написал в игровой чат.";
      }
      return "Пустое сообщение пропущено.";
    }
    if (action === "explore") {
      const p = b.entity.position;
      const angle = Math.random() * Math.PI * 2;
      const distance = 5 + Math.floor(Math.random() * 6);
      const x = Math.round(p.x + Math.cos(angle) * distance);
      const z = Math.round(p.z + Math.sin(angle) * distance);
      b.pathfinder.setGoal(new goals.GoalNear(x, Math.round(p.y), z, 2));
      return "Исследую ближайшую область.";
    }
    return "Жду и наблюдаю.";
  }

  async startAutonomy(task) {
    if (!this.isConnected()) throw new Error("Сначала подключи игрового бота: /gameconnect");
    if (this.autonomy) throw new Error("Автономный режим уже работает. Остановить: /gamestop");
    this.task = String(task || "Исследуй ближайшую безопасную область и следуй за владельцем, если он рядом.").slice(0, 500);
    this.autonomy = true;
    this.lastError = "";
    this.loopPromise = this.runLoop();
    return "Автономный режим запущен. Задача: " + this.task;
  }

  async runLoop() {
    while (this.autonomy && this.isConnected()) {
      try {
        const observation = this.observe();
        const decision = await this.decide(this.task, observation);
        const result = await this.execute(decision);
        this.lastDecision = (decision.action || "wait") + " — " + result;
      } catch (error) {
        this.lastError = error.message || String(error);
        this.lastDecision = "Ошибка решения; остановка для безопасности";
        this.stopAutonomy();
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 12000));
    }
  }
}

module.exports = { GameAgent };
