import {
  GROUND_Y,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_BASE,
  PLAYER_RADIUS,
  getPlayerClass,
  getItem,
  getUpgrade,
  getWeapon,
  ITEMS,
  ITEM_COST,
  MAX_ITEMS,
  MAX_WAVES,
  MAX_WEAPONS,
  MAX_WEAPON_LEVEL,
  PEACE_DURATION,
  SERVER_TICK_RATE,
  SNAPSHOT_RATE,
  SHOP_SERVICES,
  UPGRADE_POOL,
  WAVE_DURATION,
  WEAPONS,
  WEAPON_COST,
} from "./config.js";
import { clamp, distanceSquared, randomId, sample } from "./utils.js";

const GRAVITY = 1800;
const GAME_DURATION = 150;
const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.12;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateMap() {
  const rng = mulberry32((Math.random() * 1e9) | 0);
  const platforms = [];
  let x = 130;
  while (x < MAP_WIDTH - 200) {
    const width = 190 + rng() * 190;
    const gap = 70 + rng() * 130;
    const y = 400 + rng() * 160;
    platforms.push({ x, y, width, height: 24 });
    x += width + gap;
  }
  // 高台 / 塔楼：在随机平台上方叠加，形成更立体的地形
  const towerCount = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < towerCount; i += 1) {
    const base = platforms[Math.floor(rng() * platforms.length)];
    const width = 140 + rng() * 140;
    platforms.push({
      x: base.x + (base.width - width) * rng(),
      y: base.y - (120 + rng() * 90),
      width,
      height: 24,
    });
  }
  const decorations = [];
  const decoCount = 26 + Math.floor(rng() * 14);
  for (let i = 0; i < decoCount; i += 1) {
    const type = rng() < 0.6 ? "pillar" : "rock";
    if (type === "pillar") {
      const w = 30 + rng() * 70;
      const h = 80 + rng() * 260;
      decorations.push({ type, x: 40 + rng() * (MAP_WIDTH - 80), y: GROUND_Y, w, h });
    } else {
      decorations.push({ type, x: 40 + rng() * (MAP_WIDTH - 80), y: GROUND_Y, w: 40 + rng() * 80, h: 24 + rng() * 60 });
    }
  }
  return { width: MAP_WIDTH, height: MAP_HEIGHT, groundY: GROUND_Y, platforms, decorations };
}

export class GameSession {
  constructor(room, io, onFinished, options = {}) {
    this.room = room;
    this.io = io;
    this.onFinished = onFinished;
    this.tickRate = options.tickRate ?? SERVER_TICK_RATE;
    this.snapshotEvery = Math.max(1, Math.round(this.tickRate / SNAPSHOT_RATE));
    this.now = options.now ?? (() => Date.now());
    this.players = new Map();
    this.enemies = new Map();
    this.projectiles = new Map();
    this.pickups = new Map();
    this.map = generateMap();
    this.elapsed = 0;
    this.wave = 1;
    this.phase = "combat";
    this.phaseTimer = WAVE_DURATION;
    this.waveSpawnBudget = 0;
    this.spawnCooldown = 0;
    this.bossWavesSpawned = new Set();
    this.shopStock = [];
    this.tickNumber = 0;
    this.ended = false;
    this.result = null;
    this.loop = null;
    this.buildPlayers();
    this.shopStock = this.buildShopStock();
  }

  totalDuration() {
    return WAVE_DURATION * MAX_WAVES + PEACE_DURATION * (MAX_WAVES - 1);
  }

  buildPlayers() {
    const count = this.room.players.size;
    let index = 0;
    for (const lobbyPlayer of this.room.players.values()) {
      const playerClass = getPlayerClass(lobbyPlayer.classId);
      const stats = { ...PLAYER_BASE, ...playerClass.stats };
      const spread = count === 1 ? MAP_WIDTH / 2 : 300 + (index * (MAP_WIDTH - 600)) / (count - 1);
      this.players.set(lobbyPlayer.id, {
        id: lobbyPlayer.id,
        name: lobbyPlayer.name,
        classId: playerClass.id,
        className: playerClass.name,
        skillName: playerClass.skillName,
        color: lobbyPlayer.color,
        x: spread,
        y: GROUND_Y - PLAYER_RADIUS,
        vx: 0,
        vy: 0,
        facing: index % 2 === 0 ? 1 : -1,
        grounded: true,
        hp: stats.maxHp,
        maxHp: stats.maxHp,
        speed: stats.speed,
        jumpSpeed: stats.jumpSpeed,
        maxJumps: stats.maxJumps,
        jumps: 0,
        coyoteTimer: 0,
        jumpBuffer: 0,
        jumpWasHeld: false,
        damage: stats.damage,
        attackRate: stats.attackRate,
        projectileSpeed: stats.projectileSpeed,
        armor: stats.armor,
        regen: stats.regen,
        critChance: stats.critChance,
        pierce: stats.pierce,
        lifesteal: stats.lifesteal,
        goldBonus: stats.goldBonus,
        projectileCount: 1,
        pickupRange: stats.pickupRange,
        weapons: [{ id: "pistol", level: 1, cooldown: Math.random() * 0.4 }],
        items: [],
        upgrades: {},
        orbitAngle: 0,
        orbitBlades: [],
        skillCooldown: 0,
        skillCooldownMax: playerClass.skillCooldown,
        skillPressed: false,
        shield: 0,
        shieldFor: 0,
        invulnerableFor: 1.5,
        alive: true,
        downFor: 0,
        disconnected: false,
        kills: 0,
        gold: 0,
        level: 1,
        xp: 0,
        xpNeeded: 25,
        pendingUpgrade: null,
        upgradeDeadline: 0,
        owedUpgrades: 0,
        input: { left: false, right: false, jump: false, skill: false },
      });
      index += 1;
    }
  }

  start() {
    if (this.loop || this.ended) return;
    this.io.to(this.room.code).emit("game:start", {
      mode: this.room.mode,
      map: this.map,
    });
    this.emitShopStock();
    const dt = 1 / this.tickRate;
    this.loop = setInterval(() => this.update(dt), 1000 / this.tickRate);
  }

  stop() {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    if (!this.ended) this.checkEndConditions();
  }

  markDisconnected(playerId) {
    const player = this.players.get(playerId);
    if (player) player.disconnected = true;
  }

  reconnectPlayer(oldId, newId) {
    const player = this.players.get(oldId);
    if (!player) return false;
    this.players.delete(oldId);
    player.id = newId;
    player.disconnected = false;
    this.players.set(newId, player);
    return true;
  }

  resendState(playerId) {
    this.io.to(playerId).emit("game:start", { mode: this.room.mode, map: this.map });
    this.io.to(playerId).emit("shop:stock", this.shopStockPayload());
    this.io.to(playerId).emit("game:snapshot", this.snapshot());
  }

  setInput(playerId, rawInput = {}) {
    const player = this.players.get(playerId);
    if (!player) return;
    const input = rawInput ?? {};
    player.input = {
      left: Boolean(input.left),
      right: Boolean(input.right),
      jump: Boolean(input.jump),
      skill: Boolean(input.skill),
    };
  }

  chooseUpgrade(playerId, upgradeId) {
    const player = this.players.get(playerId);
    if (!player?.pendingUpgrade) return false;
    const choice = player.pendingUpgrade.find((candidate) => candidate.id === upgradeId);
    if (!choice) return false;
    const upgrade = getUpgrade(upgradeId);
    upgrade?.apply(player);
    player.upgrades[upgradeId] = (player.upgrades[upgradeId] ?? 0) + 1;
    player.pendingUpgrade = null;
    player.upgradeDeadline = 0;
    this.io.to(playerId).emit("upgrade:applied", { id: upgradeId, level: player.upgrades[upgradeId] });
    this.dispatchUpgrades(player);
    return true;
  }

  buyShopItem(playerId, itemId) {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return false;
    if (this.room.mode === "pve" && this.phase !== "peace") {
      this.io.to(playerId).emit("shop:error", { message: "商店仅在和平时间开放" });
      return false;
    }
    const service = SHOP_SERVICES.find((candidate) => candidate.id === itemId);
    if (service) {
      if (player.gold < service.cost) {
        this.io.to(playerId).emit("shop:error", { message: "金币不足" });
        return false;
      }
      player.gold -= service.cost;
      service.apply(player);
      this.io.to(playerId).emit("shop:bought", { id: service.id, gold: player.gold });
      return true;
    }
    const entry = this.shopStock.find((candidate) => candidate.id === itemId);
    if (!entry) return false;
    if (player.gold < entry.cost) {
      this.io.to(playerId).emit("shop:error", { message: "金币不足" });
      return false;
    }
    const granted = entry.kind === "weapon"
      ? this.grantWeapon(player, entry.refId)
      : this.grantItem(player, entry.refId);
    if (!granted) {
      this.io.to(playerId).emit("shop:error", { message: "武器已满级或背包已满，无法购买" });
      return false;
    }
    player.gold -= entry.cost;
    this.shopStock = this.shopStock.filter((candidate) => candidate.id !== entry.id);
    this.io.to(playerId).emit("shop:bought", { id: entry.id, gold: player.gold });
    this.emitShopStock();
    return true;
  }

  grantWeapon(player, weaponId) {
    const config = getWeapon(weaponId);
    if (!config) return false;
    const owned = player.weapons.find((weapon) => weapon.id === weaponId);
    if (owned) {
      if (owned.level >= MAX_WEAPON_LEVEL) return false;
      owned.level += 1;
      return true;
    }
    if (player.weapons.length >= MAX_WEAPONS) return false;
    player.weapons.push({ id: weaponId, level: 1, cooldown: 0 });
    return true;
  }

  grantItem(player, itemId) {
    const config = getItem(itemId);
    if (!config) return false;
    const owned = player.items.find((item) => item.id === itemId);
    if (!owned && player.items.length >= MAX_ITEMS) return false;
    if (owned) owned.count += 1;
    else player.items.push({ id: itemId, count: 1 });
    config.apply(player);
    return true;
  }

  buildShopStock() {
    const stock = [];
    const weaponChoices = sample(
      WEAPONS.filter((weapon) => weapon.id !== "pistol"),
      2,
    );
    for (const weapon of weaponChoices) {
      stock.push({
        id: `weapon_${weapon.id}`,
        kind: "weapon",
        refId: weapon.id,
        name: weapon.name,
        tier: weapon.tier,
        cost: WEAPON_COST[weapon.tier],
        description: weapon.description,
      });
    }
    for (const item of sample(ITEMS, 2)) {
      stock.push({
        id: `item_${item.id}`,
        kind: "item",
        refId: item.id,
        name: item.name,
        tier: item.tier,
        cost: ITEM_COST[item.tier],
        description: item.description,
      });
    }
    return stock;
  }

  emitShopStock() {
    this.io.to(this.room.code).emit("shop:stock", this.shopStockPayload());
  }

  shopStockPayload() {
    return {
      services: SHOP_SERVICES.map(({ id, name, description, cost }) => ({ id, name, description, cost })),
      stock: this.shopStock,
    };
  }

  update(dt) {
    if (this.ended) return;
    this.elapsed += dt;
    this.tickNumber += 1;
    this.updatePlayers(dt);
    if (this.room.mode === "pve") this.updatePve(dt);
    this.updateOrbits(dt);
    this.updateProjectiles(dt);
    this.updatePickups(dt);
    this.resolvePendingUpgrades();
    this.checkEndConditions();
    if (this.tickNumber % this.snapshotEvery === 0) this.broadcastSnapshot();
  }

  updatePlayers(dt) {
    for (const player of this.players.values()) {
      if (!player.alive) {
        if (this.room.mode === "pve" && this.livingPlayers().length > 0) {
          player.downFor -= dt;
          if (player.downFor <= 0) this.revivePlayer(player);
        }
        player.skillPressed = Boolean(player.input.skill);
        continue;
      }
      player.invulnerableFor = Math.max(0, player.invulnerableFor - dt);
      player.skillCooldown = Math.max(0, player.skillCooldown - dt);
      player.shieldFor = Math.max(0, player.shieldFor - dt);
      if (player.shieldFor <= 0) player.shield = 0;
      if (player.regen > 0) player.hp = Math.min(player.maxHp, player.hp + player.regen * dt);
      if (player.input.skill && !player.skillPressed && player.skillCooldown <= 0) this.useSkill(player);
      player.skillPressed = Boolean(player.input.skill);
      const direction = Number(player.input.right) - Number(player.input.left);
      player.vx = direction * player.speed;
      if (direction !== 0) player.facing = direction;

      // —— 跳跃：输入缓冲 + 土狼时间 + 二段跳 + 可变跳跃高度 ——
      const wantsJump = player.input.jump;
      if (wantsJump && !player.jumpWasHeld) player.jumpBuffer = JUMP_BUFFER;
      else if (!wantsJump) player.jumpBuffer = Math.max(0, player.jumpBuffer - dt);
      if (player.grounded) {
        player.coyoteTimer = COYOTE_TIME;
        player.jumps = 0;
      } else {
        player.coyoteTimer = Math.max(0, player.coyoteTimer - dt);
      }
      if (!wantsJump && player.jumpWasHeld && player.vy < 0) player.vy *= 0.5;
      player.jumpWasHeld = wantsJump;
      if (player.jumpBuffer > 0 && (player.coyoteTimer > 0 || player.jumps < player.maxJumps)) {
        player.vy = -player.jumpSpeed;
        player.jumps += 1;
        player.grounded = false;
        player.coyoteTimer = 0;
        player.jumpBuffer = 0;
      }

      const previousBottom = player.y + PLAYER_RADIUS;
      player.vy += GRAVITY * dt;
      player.x = clamp(player.x + player.vx * dt, PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS);
      player.y += player.vy * dt;
      player.grounded = false;

      let landingY = GROUND_Y;
      for (const platform of this.map.platforms) {
        const withinX = player.x + PLAYER_RADIUS > platform.x && player.x - PLAYER_RADIUS < platform.x + platform.width;
        const crossedTop = previousBottom <= platform.y && player.y + PLAYER_RADIUS >= platform.y;
        if (withinX && crossedTop && player.vy >= 0) landingY = Math.min(landingY, platform.y);
      }
      if (player.y + PLAYER_RADIUS >= landingY) {
        player.y = landingY - PLAYER_RADIUS;
        player.vy = 0;
        player.grounded = true;
      }

      // —— 武器自动射击（每把武器独立冷却）——
      for (const weapon of player.weapons) {
        const config = getWeapon(weapon.id);
        if (!config || config.kind === "orbit") continue;
        weapon.cooldown -= dt;
        if (weapon.cooldown <= 0) {
          const target = this.findTarget(player);
          if (target) this.fireWeapon(player, weapon, config, target);
          weapon.cooldown = 1 / Math.max(0.2, player.attackRate * config.rate);
        }
      }
    }
  }

  useSkill(player) {
    switch (player.classId) {
      case "assault":
        this.fireBurst(player);
        break;
      case "guardian":
        player.shield = Math.min(85, player.shield + 55);
        player.shieldFor = 5;
        player.invulnerableFor = Math.max(player.invulnerableFor, 0.35);
        break;
      case "medic":
        this.healPulse(player);
        break;
      case "scout":
        player.x = clamp(player.x + player.facing * 320, PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS);
        player.invulnerableFor = Math.max(player.invulnerableFor, 0.32);
        break;
      default:
        this.fireBurst(player);
        break;
    }
    player.skillCooldown = player.skillCooldownMax;
    this.io.to(this.room.code).emit("game:event", { type: "skill", playerId: player.id, skillName: player.skillName });
  }

  fireBurst(player) {
    const target = this.findTarget(player);
    const baseAngle = target ? Math.atan2(target.y - player.y, target.x - player.x) : (player.facing > 0 ? 0 : Math.PI);
    for (let index = 0; index < 8; index += 1) {
      const spread = (index - 3.5) * 0.105;
      const angle = baseAngle + spread;
      const id = randomId("burst");
      this.projectiles.set(id, {
        id,
        ownerId: player.id,
        x: player.x + Math.cos(angle) * (PLAYER_RADIUS + 8),
        y: player.y + Math.sin(angle) * (PLAYER_RADIUS + 8),
        vx: Math.cos(angle) * player.projectileSpeed * 1.12,
        vy: Math.sin(angle) * player.projectileSpeed * 1.12,
        radius: 5,
        damage: player.damage * 0.72,
        pierce: Math.max(0, player.pierce - 1),
        life: 1,
        aoe: 0,
        color: "#ffd166",
        hitTargets: [],
      });
    }
  }

  healPulse(player) {
    for (const target of this.players.values()) {
      if (distanceSquared(player, target) > 460 * 460) continue;
      if (!target.alive && this.room.mode === "pve") {
        target.alive = true;
        target.downFor = 0;
        target.invulnerableFor = 1.6;
      }
      if (target.alive) target.hp = Math.min(target.maxHp, target.hp + 38);
    }
  }

  updatePve(dt) {
    if (this.phase === "combat") {
      this.phaseTimer -= dt;
      this.waveSpawnBudget += dt * (0.8 + this.wave * 0.42);
      this.spawnCooldown -= dt;
      const maxEnemies = 7 + this.wave * 5;
      if (this.waveSpawnBudget >= 1 && this.spawnCooldown <= 0 && this.enemies.size < maxEnemies) {
        this.spawnEnemy();
        this.waveSpawnBudget -= 1;
        this.spawnCooldown = Math.max(0.16, 0.52 - this.wave * 0.05);
      }
      if (this.phaseTimer <= 0) {
        if (this.wave >= MAX_WAVES) {
          this.finish({ title: "合作胜利，所有波次已清除", winnerIds: this.connectedLivingPlayers().map((player) => player.id) });
          return;
        }
        this.enterPeace();
      }
    } else {
      // 和平时间：商店开放，无怪物刷新
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) this.enterCombat();
    }

    for (const enemy of this.enemies.values()) {
      const target = this.closestLivingPlayer(enemy);
      if (!target) continue;
      const direction = Math.sign(target.x - enemy.x);
      enemy.vx = direction * enemy.speed;
      enemy.x = clamp(enemy.x + enemy.vx * dt, enemy.radius, MAP_WIDTH - enemy.radius);
      enemy.y = GROUND_Y - enemy.radius + Math.sin(this.elapsed * enemy.bobSpeed) * enemy.bobHeight;
      enemy.attackCooldown -= dt;
      const hitRange = enemy.radius + PLAYER_RADIUS + 8;
      if (distanceSquared(enemy, target) <= hitRange * hitRange && enemy.attackCooldown <= 0) {
        this.damagePlayer(target, enemy.damage);
        enemy.attackCooldown = 0.75;
      }
    }
  }

  enterPeace() {
    this.phase = "peace";
    this.phaseTimer = PEACE_DURATION;
    this.enemies.clear();
    for (const player of this.livingPlayers()) {
      player.hp = Math.min(player.maxHp, player.hp + player.maxHp * 0.12);
    }
    this.shopStock = this.buildShopStock();
    this.emitShopStock();
    this.io.to(this.room.code).emit("game:event", { type: "peace", duration: PEACE_DURATION, wave: this.wave });
  }

  enterCombat() {
    this.wave += 1;
    this.phase = "combat";
    this.phaseTimer = WAVE_DURATION;
    this.waveSpawnBudget = 0;
    this.spawnCooldown = 0.6;
    for (const player of this.livingPlayers()) {
      player.hp = Math.min(player.maxHp, player.hp + player.maxHp * 0.15);
    }
    if ((this.wave === 3 || this.wave === 5) && !this.bossWavesSpawned.has(this.wave)) {
      this.spawnEnemy("boss");
      this.bossWavesSpawned.add(this.wave);
    }
    this.io.to(this.room.code).emit("game:event", { type: "wave", wave: this.wave });
  }

  spawnEnemy(kind = "grunt") {
    const livingPlayers = this.livingPlayers();
    if (livingPlayers.length === 0) return;
    const anchor = livingPlayers[Math.floor(Math.random() * livingPlayers.length)];
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = clamp(anchor.x + side * (650 + Math.random() * 400), 40, MAP_WIDTH - 40);
    const boss = kind === "boss";
    const elite = boss || kind === "elite" || Math.random() < 0.05 * this.wave;
    const radius = boss ? 58 : elite ? 32 : 22;
    const hp = (boss ? 700 + this.players.size * 180 : elite ? 120 : 42) * (1 + (this.wave - 1) * 0.33);
    const enemy = {
      id: randomId("enemy"),
      x,
      y: GROUND_Y - radius,
      vx: 0,
      radius,
      hp,
      maxHp: hp,
      speed: (boss ? 82 : elite ? 105 : 145) + this.wave * 7,
      damage: (boss ? 32 : elite ? 22 : 12) + this.wave * 2,
      attackCooldown: Math.random() * 0.5,
      orbitHitCooldown: 0,
      elite,
      boss,
      bobSpeed: boss ? 2.3 : 0,
      bobHeight: boss ? 7 : 0,
    };
    this.enemies.set(enemy.id, enemy);
  }

  findTarget(player) {
    const candidates = this.room.mode === "pve"
      ? [...this.enemies.values()]
      : this.livingPlayers().filter((candidate) => candidate.id !== player.id && !candidate.disconnected);
    let closest = null;
    let closestDistance = 780 * 780;
    for (const candidate of candidates) {
      const candidateDistance = distanceSquared(player, candidate);
      if (candidateDistance < closestDistance) {
        closest = candidate;
        closestDistance = candidateDistance;
      }
    }
    return closest;
  }

  fireWeapon(player, weapon, config, target) {
    const angle = Math.atan2(target.y - player.y, target.x - player.x);
    const levelBonus = 1 + 0.3 * (weapon.level - 1);
    const count = config.count + Math.max(0, player.projectileCount - 1);
    const pierce = config.pierce + player.pierce;
    for (let index = 0; index < count; index += 1) {
      const spread = (index - (count - 1) / 2) * config.spread;
      const shotAngle = angle + spread;
      const crit = Math.random() < player.critChance + config.critBonus;
      const damage = player.damage * config.damageMul * levelBonus * (crit ? 2 : 1);
      const projectile = {
        id: randomId("shot"),
        ownerId: player.id,
        x: player.x + Math.cos(shotAngle) * (PLAYER_RADIUS + 8),
        y: player.y + Math.sin(shotAngle) * (PLAYER_RADIUS + 8),
        vx: Math.cos(shotAngle) * config.projSpeed,
        vy: Math.sin(shotAngle) * config.projSpeed,
        radius: config.radius,
        damage,
        pierce,
        life: config.life,
        aoe: config.aoe,
        color: config.color,
        crit,
        hitTargets: [],
      };
      this.projectiles.set(projectile.id, projectile);
    }
  }

  updateOrbits(dt) {
    for (const player of this.players.values()) {
      player.orbitBlades = [];
    }
    for (const enemy of this.enemies.values()) {
      enemy.orbitHitCooldown = Math.max(0, enemy.orbitHitCooldown - dt);
    }
    for (const player of this.livingPlayers()) {
      const orbitWeapons = player.weapons.filter((weapon) => {
        const config = getWeapon(weapon.id);
        return config && config.kind === "orbit";
      });
      if (orbitWeapons.length === 0) continue;
      let totalCount = 0;
      let orbitRadius = 0;
      let bladeRadius = 14;
      let orbitSpeed = 2.6;
      let color = "#7bed9f";
      let damageMul = 1;
      for (const weapon of orbitWeapons) {
        const config = getWeapon(weapon.id);
        totalCount += config.count + (weapon.level - 1);
        orbitRadius = Math.max(orbitRadius, config.orbitRadius);
        bladeRadius = Math.max(bladeRadius, config.radius);
        orbitSpeed = config.orbitSpeed;
        color = config.color;
        damageMul = config.damageMul * (1 + 0.3 * (weapon.level - 1));
      }
      player.orbitAngle += orbitSpeed * dt;
      for (let index = 0; index < totalCount; index += 1) {
        const bladeAngle = player.orbitAngle + (index * Math.PI * 2) / totalCount;
        const bx = player.x + Math.cos(bladeAngle) * orbitRadius;
        const by = player.y + Math.sin(bladeAngle) * orbitRadius;
        player.orbitBlades.push({ x: bx, y: by, radius: bladeRadius, color });
        for (const enemy of this.enemies.values()) {
          if (enemy.orbitHitCooldown > 0) continue;
          const hitRadius = enemy.radius + bladeRadius;
          if (distanceSquared({ x: bx, y: by }, enemy) <= hitRadius * hitRadius) {
            const damage = player.damage * damageMul * (Math.random() < player.critChance ? 2 : 1);
            enemy.hp -= damage;
            enemy.orbitHitCooldown = 0.3;
            if (enemy.hp <= 0) {
              this.enemies.delete(enemy.id);
              this.defeatEnemy(enemy, player);
            }
          }
        }
      }
    }
  }

  updateProjectiles(dt) {
    for (const projectile of this.projectiles.values()) {
      projectile.x += projectile.vx * dt;
      projectile.y += projectile.vy * dt;
      projectile.life -= dt;
      if (
        projectile.life <= 0 ||
        projectile.x < 0 ||
        projectile.x > MAP_WIDTH ||
        projectile.y < 0 ||
        projectile.y > MAP_HEIGHT
      ) {
        this.projectiles.delete(projectile.id);
        continue;
      }
      const hit = this.room.mode === "pve"
        ? this.hitEnemy(projectile)
        : this.hitOpponent(projectile);
      if (hit) this.projectiles.delete(projectile.id);
    }
  }

  hitEnemy(projectile) {
    if (!Array.isArray(projectile.hitTargets)) projectile.hitTargets = [];
    for (const enemy of this.enemies.values()) {
      if (projectile.hitTargets.includes(enemy.id)) continue;
      const hitRadius = enemy.radius + projectile.radius;
      if (distanceSquared(projectile, enemy) > hitRadius * hitRadius) continue;
      projectile.hitTargets.push(enemy.id);
      enemy.hp -= projectile.damage;
      const owner = this.players.get(projectile.ownerId);
      if (enemy.hp <= 0) {
        this.enemies.delete(enemy.id);
        this.defeatEnemy(enemy, owner);
      }
      if (projectile.aoe > 0) {
        this.explode(projectile, owner, enemy);
        return true;
      }
      if (projectile.pierce > 0) {
        projectile.pierce -= 1;
        return false;
      }
      return true;
    }
    return false;
  }

  explode(projectile, owner, exclude) {
    for (const enemy of [...this.enemies.values()]) {
      if (enemy === exclude) continue;
      if (distanceSquared(projectile, enemy) <= projectile.aoe * projectile.aoe) {
        enemy.hp -= projectile.damage;
        if (enemy.hp <= 0) {
          this.enemies.delete(enemy.id);
          this.defeatEnemy(enemy, owner);
        }
      }
    }
  }

  defeatEnemy(enemy, owner) {
    if (owner) owner.kills += 1;
    const xpValue = enemy.boss ? 55 : enemy.elite ? 18 : 7;
    const goldValue = Math.round((enemy.boss ? 32 : enemy.elite ? 9 : 3) * (1 + (owner?.goldBonus ?? 0)));
    this.spawnPickup(enemy, xpValue, "xp");
    this.spawnPickup({ ...enemy, x: enemy.x + 18, y: enemy.y - 6 }, goldValue, "gold");
    if (enemy.boss) {
      this.spawnPickup({ ...enemy, x: enemy.x - 45 }, 20, "chest");
      this.spawnPickup({ ...enemy, x: enemy.x + 45 }, 20, "chest");
      this.io.to(this.room.code).emit("game:event", { type: "bossDefeated" });
    } else if (enemy.elite && Math.random() < 0.4) {
      this.dropEquipment(enemy);
    } else if (Math.random() < 0.03) {
      this.dropEquipment(enemy);
    }
    if (owner?.lifesteal) owner.hp = Math.min(owner.maxHp, owner.hp + owner.lifesteal);
  }

  dropEquipment(enemy) {
    if (Math.random() < 0.5) {
      const weapon = WEAPONS[Math.floor(Math.random() * WEAPONS.length)];
      this.spawnPickup({ ...enemy, x: enemy.x - 18 }, weapon.id, "weapon");
    } else {
      const item = ITEMS[Math.floor(Math.random() * ITEMS.length)];
      this.spawnPickup({ ...enemy, x: enemy.x - 18 }, item.id, "item");
    }
  }

  hitOpponent(projectile) {
    if (!Array.isArray(projectile.hitTargets)) projectile.hitTargets = [];
    for (const player of this.livingPlayers()) {
      if (player.id === projectile.ownerId || player.invulnerableFor > 0) continue;
      if (projectile.hitTargets.includes(player.id)) continue;
      const hitRadius = PLAYER_RADIUS + projectile.radius;
      if (distanceSquared(projectile, player) > hitRadius * hitRadius) continue;
      projectile.hitTargets.push(player.id);
      this.damagePlayer(player, projectile.damage);
      if (!player.alive) {
        const owner = this.players.get(projectile.ownerId);
        if (owner) owner.kills += 1;
      }
      if (projectile.pierce > 0) {
        projectile.pierce -= 1;
        return false;
      }
      return true;
    }
    return false;
  }

  damagePlayer(player, damage) {
    if (!player.alive || player.invulnerableFor > 0 || player.disconnected) return;
    let remainingDamage = Math.max(1, damage - player.armor);
    if (player.shield > 0) {
      const absorbed = Math.min(player.shield, remainingDamage);
      player.shield -= absorbed;
      remainingDamage -= absorbed;
    }
    player.hp = Math.max(0, player.hp - remainingDamage);
    player.invulnerableFor = 0.16;
    if (player.hp <= 0) {
      player.alive = false;
      player.downFor = 8;
      player.vx = 0;
      player.vy = 0;
    }
  }

  revivePlayer(player) {
    player.alive = true;
    player.hp = Math.max(30, player.maxHp * 0.4);
    player.x = MAP_WIDTH / 2 + (Math.random() - 0.5) * 200;
    player.y = GROUND_Y - PLAYER_RADIUS;
    player.invulnerableFor = 2;
  }

  spawnPickup(enemy, value, type = "xp") {
    const pickup = {
      id: randomId(type),
      type,
      x: enemy.x,
      y: enemy.y,
      value,
      life: type === "chest" ? 35 : 20,
    };
    if (type === "weapon" || type === "item") pickup.refId = value;
    this.pickups.set(pickup.id, pickup);
  }

  updatePickups(dt) {
    for (const pickup of this.pickups.values()) {
      pickup.life -= dt;
      if (pickup.life <= 0) {
        this.pickups.delete(pickup.id);
        continue;
      }
      let collector = null;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const player of this.livingPlayers()) {
        const pickupDistance = distanceSquared(pickup, player);
        if (pickupDistance < player.pickupRange ** 2 && pickupDistance < closestDistance) {
          collector = player;
          closestDistance = pickupDistance;
        }
      }
      if (!collector) continue;
      const distance = Math.sqrt(closestDistance);
      if (distance < PLAYER_RADIUS + 12) {
        this.collectPickup(collector, pickup);
        this.pickups.delete(pickup.id);
        continue;
      }
      const pull = Math.min(1, dt * 9);
      pickup.x += (collector.x - pickup.x) * pull;
      pickup.y += (collector.y - pickup.y) * pull;
    }
  }

  collectPickup(player, pickup) {
    if (pickup.type === "gold") {
      player.gold += pickup.value;
      return;
    }
    if (pickup.type === "chest") {
      player.gold += pickup.value;
      this.grantRandomEquipment(player);
      player.owedUpgrades += 1;
      this.dispatchUpgrades(player);
      this.io.to(player.id).emit("game:event", { type: "chest", gold: pickup.value });
      return;
    }
    if (pickup.type === "weapon") {
      if (this.grantWeapon(player, pickup.refId)) {
        this.io.to(player.id).emit("game:event", { type: "pickup", label: `获得武器：${getWeapon(pickup.refId).name}` });
      } else {
        player.gold += 12;
        this.io.to(player.id).emit("game:event", { type: "pickup", label: "武器已满级或背包已满，折算为金币" });
      }
      return;
    }
    if (pickup.type === "item") {
      if (this.grantItem(player, pickup.refId)) {
        this.io.to(player.id).emit("game:event", { type: "pickup", label: `获得道具：${getItem(pickup.refId).name}` });
      } else {
        player.gold += 10;
        this.io.to(player.id).emit("game:event", { type: "pickup", label: "道具背包已满，折算为金币" });
      }
      return;
    }
    this.addExperience(player, pickup.value);
  }

  grantRandomEquipment(player) {
    const pool = [];
    for (const weapon of WEAPONS) {
      const owned = player.weapons.find((candidate) => candidate.id === weapon.id);
      const available = !owned
        ? player.weapons.length < MAX_WEAPONS
        : owned.level < MAX_WEAPON_LEVEL;
      if (available) pool.push({ kind: "weapon", id: weapon.id, weight: [0, 4, 3, 2, 1][weapon.tier] });
    }
    for (const item of ITEMS) pool.push({ kind: "item", id: item.id, weight: [0, 5, 3, 2, 1][item.tier] });
    if (pool.length === 0) {
      player.gold += 15;
      return;
    }
    const pick = this.weightedPick(pool);
    if (pick.kind === "weapon") this.grantWeapon(player, pick.id);
    else this.grantItem(player, pick.id);
  }

  addExperience(player, amount) {
    player.xp += amount;
    while (player.xp >= player.xpNeeded) {
      player.xp -= player.xpNeeded;
      player.level += 1;
      player.xpNeeded = Math.round(player.xpNeeded * 1.32);
      player.owedUpgrades += 1;
    }
    this.dispatchUpgrades(player);
  }

  dispatchUpgrades(player) {
    while (player.owedUpgrades > 0 && !player.pendingUpgrade) {
      player.owedUpgrades -= 1;
      this.offerUpgrade(player);
    }
  }

  offerUpgrade(player) {
    const available = UPGRADE_POOL.filter((upgrade) => (player.upgrades[upgrade.id] ?? 0) < upgrade.maxLevel);
    if (available.length === 0) {
      player.pendingUpgrade = null;
      player.upgradeDeadline = 0;
      player.gold += 10;
      this.io.to(player.id).emit("game:event", { type: "pickup", label: "强化已全部满级，获得金币补偿" });
      return;
    }
    const choices = this.weightedSample(
      available,
      3,
      (upgrade) => [0, 1, 0.6, 0.3, 0.12][upgrade.tier],
    ).map(({ id, name, description, tier }) => ({
      id,
      name,
      description,
      tier,
      level: (player.upgrades[id] ?? 0) + 1,
    }));
    player.pendingUpgrade = choices;
    player.upgradeDeadline = this.now() + 10_000;
    this.io.to(player.id).emit("upgrade:choices", choices);
  }

  weightedSample(array, count, weightFn) {
    const source = array.map((item) => ({ item, weight: weightFn(item) }));
    const selected = [];
    while (source.length > 0 && selected.length < count) {
      const total = source.reduce((sum, entry) => sum + entry.weight, 0);
      let roll = Math.random() * total;
      let index = 0;
      for (let i = 0; i < source.length; i += 1) {
        roll -= source[i].weight;
        if (roll <= 0) {
          index = i;
          break;
        }
      }
      selected.push(source.splice(index, 1)[0].item);
    }
    return selected;
  }

  weightedPick(pool) {
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = Math.random() * total;
    for (const entry of pool) {
      roll -= entry.weight;
      if (roll <= 0) return entry;
    }
    return pool[pool.length - 1];
  }

  resolvePendingUpgrades() {
    const now = this.now();
    for (const player of this.players.values()) {
      if (player.pendingUpgrade && now >= player.upgradeDeadline) {
        this.chooseUpgrade(player.id, player.pendingUpgrade[0].id);
      }
    }
  }

  livingPlayers() {
    return [...this.players.values()].filter((player) => player.alive);
  }

  connectedLivingPlayers() {
    return this.livingPlayers().filter((player) => !player.disconnected);
  }

  closestLivingPlayer(point) {
    let closest = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const player of this.livingPlayers()) {
      if (player.disconnected) continue;
      const playerDistance = distanceSquared(point, player);
      if (playerDistance < closestDistance) {
        closest = player;
        closestDistance = playerDistance;
      }
    }
    return closest;
  }

  checkEndConditions() {
    if (this.ended) return;
    const living = this.connectedLivingPlayers();
    if (this.players.size === 0) {
      this.finish({ title: "房间已关闭", winnerIds: [] });
      return;
    }
    if (this.room.mode === "pvp") {
      if (living.length <= 1 && this.elapsed > 2) {
        this.finish({
          title: living[0] ? `${living[0].name} 获胜` : "无人幸存",
          winnerIds: living.map((player) => player.id),
        });
      } else if (this.elapsed >= GAME_DURATION) {
        const candidates = [...this.players.values()].filter((player) => !player.disconnected);
        if (candidates.length === 0) {
          this.finish({ title: "无人幸存", winnerIds: [] });
        } else {
          const highest = candidates.sort((a, b) => b.kills - a.kills || b.hp - a.hp)[0];
          this.finish({ title: `${highest.name} 获胜`, winnerIds: [highest.id] });
        }
      }
      return;
    }
    if (living.length === 0) {
      this.finish({ title: `挑战失败，坚持了 ${Math.floor(this.elapsed)} 秒`, winnerIds: [] });
    }
  }

  finish(result) {
    this.ended = true;
    this.result = result;
    this.stop();
    this.broadcastSnapshot();
    this.io.to(this.room.code).emit("game:end", result);
  }

  broadcastSnapshot() {
    this.io.to(this.room.code).emit("game:snapshot", this.snapshot());
  }

  snapshot() {
    return {
      elapsed: this.elapsed,
      duration: this.room.mode === "pve" ? this.totalDuration() : GAME_DURATION,
      wave: this.wave,
      phase: this.phase,
      phaseTimer: this.phaseTimer,
      ended: this.ended,
      result: this.result,
      players: [...this.players.values()].map((player) => ({
        id: player.id,
        name: player.name,
        classId: player.classId,
        className: player.className,
        skillName: player.skillName,
        color: player.color,
        x: player.x,
        y: player.y,
        vx: player.vx,
        vy: player.vy,
        facing: player.facing,
        hp: player.hp,
        maxHp: player.maxHp,
        shield: player.shield,
        armor: player.armor,
        skillCooldown: player.skillCooldown,
        skillCooldownMax: player.skillCooldownMax,
        alive: player.alive,
        downFor: Math.max(0, player.downFor),
        kills: player.kills,
        gold: player.gold,
        level: player.level,
        xp: player.xp,
        xpNeeded: player.xpNeeded,
        weapons: player.weapons.map((weapon) => {
          const config = getWeapon(weapon.id);
          return { id: weapon.id, name: config?.name ?? weapon.id, tier: config?.tier ?? 1, level: weapon.level };
        }),
        items: player.items.map((item) => {
          const config = getItem(item.id);
          return { id: item.id, name: config?.name ?? item.id, tier: config?.tier ?? 1, count: item.count };
        }),
        upgrades: Object.entries(player.upgrades).map(([id, level]) => {
          const config = getUpgrade(id);
          return { id, name: config?.name ?? id, tier: config?.tier ?? 1, level };
        }),
        orbs: player.orbitBlades,
      })),
      enemies: [...this.enemies.values()],
      projectiles: [...this.projectiles.values()].map(({ hitTargets, ...rest }) => rest),
      pickups: [...this.pickups.values()],
    };
  }
}
