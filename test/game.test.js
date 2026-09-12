import assert from "node:assert/strict";
import test from "node:test";
import { GROUND_Y, PLAYER_RADIUS } from "../src/config.js";
import { GameSession } from "../src/game.js";

function createGame(mode = "pve", playerCount = 1, classes = []) {
  const emitted = [];
  const io = {
    to(target) {
      return {
        emit(event, payload) {
          emitted.push({ target, event, payload });
        },
      };
    },
  };
  const players = new Map();
  for (let index = 0; index < playerCount; index += 1) {
    players.set(`player-${index}`, {
      id: `player-${index}`,
      name: `玩家${index + 1}`,
      classId: classes[index] ?? "assault",
      color: "#fff",
    });
  }
  const room = { code: "TEST1", mode, players };
  return { game: new GameSession(room, io, () => {}), emitted };
}

test("服务端根据输入权威更新移动状态", () => {
  const { game } = createGame();
  const player = game.players.get("player-0");
  const startX = player.x;
  game.setInput(player.id, { right: true, jump: true });
  game.updatePlayers(1 / 30);

  assert.ok(player.x > startX);
  assert.ok(player.y < GROUND_Y - PLAYER_RADIUS);
  assert.equal(player.facing, 1);
});

test("经验升级会向对应玩家发出三选一", () => {
  const { game, emitted } = createGame();
  const player = game.players.get("player-0");
  game.addExperience(player, player.xpNeeded);

  assert.equal(player.level, 2);
  assert.equal(player.pendingUpgrade.length, 3);
  assert.ok(emitted.some((item) => item.target === player.id && item.event === "upgrade:choices"));
});

test("职业属性和主动技能由服务端计算", () => {
  const { game } = createGame("pve", 2, ["guardian", "medic"]);
  const guardian = game.players.get("player-0");
  const medic = game.players.get("player-1");

  assert.equal(guardian.className, "守卫");
  assert.ok(guardian.maxHp > medic.maxHp);

  game.setInput(guardian.id, { skill: true });
  game.updatePlayers(1 / 30);
  assert.ok(guardian.shield > 0);
  assert.ok(guardian.skillCooldown > 0);
});

test("战斗阶段无法购买", () => {
  const { game } = createGame();
  const player = game.players.get("player-0");
  player.gold = 100;
  game.phase = "combat";
  assert.equal(game.buyShopItem(player.id, "heal"), false);
});

test("跨多级经验会依次发放升级选择", () => {
  const { game } = createGame();
  const player = game.players.get("player-0");
  game.addExperience(player, player.xpNeeded * 3);
  assert.equal(player.level, 3);
  assert.equal(player.owedUpgrades, 1);
  assert.equal(player.pendingUpgrade.length, 3);
});

test("长按跳跃不会自动触发二段跳", () => {
  const { game } = createGame();
  const player = game.players.get("player-0");
  game.setInput(player.id, { jump: true });
  for (let i = 0; i < 10; i += 1) game.updatePlayers(1 / 30);
  // 持续按住跳跃只消耗一次跳跃
  assert.equal(player.jumps, 1);
});

test("穿甲弹不会重复命中同一目标", () => {
  const { game } = createGame();
  const player = game.players.get("player-0");
  const enemy = { id: "e1", x: player.x + 20, y: player.y, radius: 30, hp: 100, maxHp: 100, elite: false };
  game.enemies.set(enemy.id, enemy);
  const projectile = {
    ownerId: player.id,
    x: enemy.x,
    y: enemy.y,
    radius: 6,
    damage: 10,
    pierce: 3,
    hitTargets: [],
  };

  game.hitEnemy(projectile);
  const afterFirst = enemy.hp;
  assert.equal(projectile.hitTargets.length, 1);
  assert.equal(projectile.pierce, 2);

  // 弹丸仍与目标重叠，下一次不应再次造成伤害
  game.hitEnemy(projectile);
  assert.equal(enemy.hp, afterFirst);
  assert.equal(projectile.hitTargets.length, 1);
});

test("断线玩家在游戏中不会被伤害或瞄准", () => {
  const { game } = createGame();
  const player = game.players.get("player-0");
  player.hp = 100;
  game.markDisconnected(player.id);
  game.damagePlayer(player, 20);
  assert.equal(player.hp, 100);

  assert.equal(game.closestLivingPlayer({ x: player.x, y: player.y }), null);
});

test("重连会迁移玩家席位", () => {
  const { game } = createGame();
  const player = game.players.get("player-0");
  game.markDisconnected("player-0");
  assert.equal(game.reconnectPlayer("player-0", "player-0-new"), true);
  assert.equal(game.players.has("player-0"), false);
  const migrated = game.players.get("player-0-new");
  assert.ok(migrated);
  assert.equal(migrated.disconnected, false);
});

test("商店会消耗金币并应用强化", () => {
  const { game } = createGame();
  const player = game.players.get("player-0");
  game.phase = "peace";
  player.gold = 20;
  const before = player.damage;

  assert.equal(game.buyShopItem(player.id, "damage"), true);
  assert.equal(player.gold, 6);
  assert.ok(player.damage > before);
});

test("Boss 死亡会掉落宝箱和金币", () => {
  const { game } = createGame();
  const player = game.players.get("player-0");
  const boss = {
    id: "boss",
    x: player.x + 40,
    y: player.y,
    radius: 58,
    hp: 1,
    maxHp: 1,
    elite: true,
    boss: true,
  };
  game.enemies.set(boss.id, boss);
  const hit = game.hitEnemy({
    ownerId: player.id,
    x: boss.x,
    y: boss.y,
    radius: 6,
    damage: 10,
    pierce: 0,
  });

  assert.equal(hit, true);
  assert.ok([...game.pickups.values()].some((pickup) => pickup.type === "chest"));
  assert.ok([...game.pickups.values()].some((pickup) => pickup.type === "gold"));
});

test("PvP 在只剩一人时结束并宣布胜者", () => {
  const { game } = createGame("pvp", 2);
  game.elapsed = 3;
  game.players.get("player-1").alive = false;
  game.players.get("player-1").hp = 0;
  game.checkEndConditions();

  assert.equal(game.ended, true);
  assert.deepEqual(game.result.winnerIds, ["player-0"]);
});

test("二段跳：空中可再次跳跃", () => {
  const { game } = createGame();
  const player = game.players.get("player-0");
  game.setInput(player.id, { jump: true });
  game.updatePlayers(1 / 30);
  assert.equal(player.jumps, 1);

  game.setInput(player.id, { jump: false });
  game.updatePlayers(1 / 30);
  game.updatePlayers(1 / 30);
  assert.equal(player.jumps, 1);

  game.setInput(player.id, { jump: true });
  game.updatePlayers(1 / 30);
  assert.equal(player.jumps, 2);
});

test("波次结束进入和平时间并清空怪物", () => {
  const { game } = createGame();
  game.phase = "combat";
  game.phaseTimer = 0.01;
  game.spawnEnemy();
  assert.ok(game.enemies.size > 0);

  game.updatePve(0.02);
  assert.equal(game.phase, "peace");
  assert.equal(game.enemies.size, 0);
});

test("和平时间结束后进入下一波", () => {
  const { game } = createGame();
  game.phase = "peace";
  game.phaseTimer = 0.01;
  game.wave = 1;

  game.updatePve(0.02);
  assert.equal(game.wave, 2);
  assert.equal(game.phase, "combat");
});

test("武器可加入背包并可升级", () => {
  const { game } = createGame();
  const player = game.players.get("player-0");
  assert.equal(player.weapons.length, 1);

  assert.equal(game.grantWeapon(player, "shotgun"), true);
  assert.equal(player.weapons.length, 2);

  assert.equal(game.grantWeapon(player, "shotgun"), true);
  assert.equal(player.weapons.find((weapon) => weapon.id === "shotgun").level, 2);
});

test("满级升级不再出现在三选一中", () => {
  const { game } = createGame();
  const player = game.players.get("player-0");
  player.upgrades.jetpack = 1; // jetpack 满级为 1

  game.offerUpgrade(player);
  assert.equal(player.pendingUpgrade.length, 3);
  assert.ok(!player.pendingUpgrade.some((choice) => choice.id === "jetpack"));
});

test("商店可购买武器与道具", () => {
  const { game } = createGame();
  const player = game.players.get("player-0");
  game.phase = "peace";
  player.gold = 1000;

  const weaponEntry = game.shopStock.find((entry) => entry.kind === "weapon");
  assert.ok(weaponEntry);
  assert.equal(game.buyShopItem(player.id, weaponEntry.id), true);
  assert.ok(player.weapons.some((weapon) => weapon.id === weaponEntry.refId));

  const itemEntry = game.shopStock.find((entry) => entry.kind === "item");
  assert.ok(itemEntry);
  assert.equal(game.buyShopItem(player.id, itemEntry.id), true);
  assert.ok(player.items.some((item) => item.id === itemEntry.refId));
});

test("PvE 怪物死亡会生成经验掉落", () => {
  const { game } = createGame();
  const player = game.players.get("player-0");
  const enemy = {
    id: "enemy",
    x: player.x + 40,
    y: player.y,
    radius: 22,
    hp: 1,
    maxHp: 1,
    elite: false,
  };
  game.enemies.set(enemy.id, enemy);
  const hit = game.hitEnemy({
    ownerId: player.id,
    x: enemy.x,
    y: enemy.y,
    radius: 6,
    damage: 10,
  });

  assert.equal(hit, true);
  assert.equal(game.enemies.size, 0);
  assert.ok([...game.pickups.values()].some((pickup) => pickup.type === "xp"));
  assert.ok([...game.pickups.values()].some((pickup) => pickup.type === "gold"));
  assert.equal(player.kills, 1);
});
