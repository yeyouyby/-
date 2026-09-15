import assert from "node:assert/strict";
import test from "node:test";
import { ENDLESS, MAX_WAVES } from "../src/config.js";
import { GameSession } from "../src/game.js";

function createGame(mode = "endless", playerCount = 1, options = {}) {
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
      classId: options.classes?.[index] ?? "assault",
      color: "#fff",
      accountId: options.accountIds?.[index] ?? null,
      username: options.usernames?.[index] ?? null,
    });
  }
  const room = { code: "TESTS", mode, players };
  const game = new GameSession(room, io, () => {}, options);
  return { game, emitted, room };
}

test("无尽模式没有总时长，普通 PvE 仍有固定时长", () => {
  const endless = createGame("endless").game;
  const pve = createGame("pve").game;

  assert.equal(endless.endless, true);
  assert.equal(endless.totalDuration(), null);
  assert.equal(endless.snapshot().endless, true);
  assert.equal(endless.snapshot().duration, null);
  assert.ok(pve.totalDuration() > 0);
  assert.equal(pve.snapshot().endless, false);
});

test("清空最后一波后 PvE 结束，而无尽模式继续进入下一波", () => {
  const pve = createGame("pve").game;
  pve.wave = MAX_WAVES;
  pve.phase = "combat";
  pve.phaseTimer = 0.01;
  pve.updatePve(0.02);
  assert.equal(pve.ended, true);

  const endless = createGame("endless").game;
  endless.wave = MAX_WAVES + 12;
  endless.phase = "combat";
  endless.phaseTimer = 0.01;
  endless.updatePve(0.02);
  assert.equal(endless.ended, false);
  assert.equal(endless.phase, "peace");
});

test("无尽模式的波次持续时间与和平时间随波次变化", () => {
  const { game } = createGame("endless");
  game.wave = 1;
  const firstCombat = game.combatDuration();
  const firstPeace = game.peaceDuration();
  game.wave = 12;
  const laterCombat = game.combatDuration();
  const laterPeace = game.peaceDuration();

  assert.ok(laterCombat > firstCombat);
  assert.ok(laterCombat <= ENDLESS.combatMax);
  assert.ok(laterPeace < firstPeace);
  assert.ok(laterPeace >= ENDLESS.peaceMin);
});

test("无尽模式的敌人随波次与玩家数量增强", () => {
  const { game } = createGame("endless", 2);
  game.wave = 1;
  const weak = game.spawnEnemy();
  game.enemies.clear();
  game.wave = 20;
  const strong = game.spawnEnemy();

  assert.ok(strong.hp > weak.hp * 3);
  assert.ok(strong.speed > weak.speed);
  assert.ok(strong.damage > weak.damage);
});

test("无尽模式每 5 波刷新 Boss", () => {
  const { game } = createGame("endless");
  game.wave = 4;
  game.enterCombat();
  assert.equal(game.wave, 5);
  assert.ok([...game.enemies.values()].some((enemy) => enemy.boss));

  game.enemies.clear();
  game.wave = 6;
  game.enterCombat();
  assert.equal(game.enemies.size, 0);
});

test("清空一波会触发自动存档回调", () => {
  const cleared = [];
  const { game } = createGame("endless", 1, { onWaveCleared: (session) => cleared.push(session.wave) });
  game.phase = "combat";
  game.phaseTimer = 0.01;
  game.updatePve(0.02);
  assert.equal(game.phase, "peace");
  assert.deepEqual(cleared, [1]);

  // 固定波次模式不会触发无尽存档
  const pveCleared = [];
  const pve = createGame("pve", 1, { onWaveCleared: () => pveCleared.push(1) }).game;
  pve.phase = "combat";
  pve.phaseTimer = 0.01;
  pve.updatePve(0.02);
  assert.equal(pveCleared.length, 0);
});

test("存档点会完整保存并还原玩家成长、波次与地图", () => {
  const { game } = createGame("endless", 2, { accountIds: ["acct-alice", "acct-bob"], usernames: ["alice", "bob"] });
  const alice = game.players.get("player-0");
  const bob = game.players.get("player-1");

  game.wave = 9;
  game.phase = "peace";
  game.elapsed = 512.5;
  game.grantWeapon(alice, "rocket");
  game.grantItem(alice, "vitality");
  alice.upgrades.power = 3;
  alice.damage *= 1.2;
  alice.maxHp += 40;
  alice.hp = alice.maxHp * 0.5;
  alice.gold = 321;
  alice.level = 7;
  alice.kills = 44;
  alice.xp = 12;
  alice.owedUpgrades = 0;
  bob.gold = 5;

  const state = game.captureSaveState();
  assert.equal(state.wave, 9);
  assert.equal(state.players.length, 2);

  const { game: resumed } = createGame("endless", 2, {
    accountIds: ["acct-alice", "acct-bob"],
    usernames: ["alice", "bob"],
    save: { state },
  });
  const resumedAlice = resumed.players.get("player-0");

  assert.equal(resumed.restoredFromSave, true);
  assert.equal(resumed.wave, 9);
  assert.equal(resumed.phase, "peace");
  assert.equal(Math.round(resumed.elapsed), Math.round(game.elapsed));
  assert.equal(resumed.map.platforms.length, game.map.platforms.length);
  assert.equal(resumedAlice.gold, 321);
  assert.equal(resumedAlice.level, 7);
  assert.equal(resumedAlice.kills, 44);
  assert.equal(resumedAlice.upgrades.power, 3);
  assert.ok(Math.abs(resumedAlice.damage - alice.damage) < 1e-9);
  assert.ok(Math.abs(resumedAlice.maxHp - alice.maxHp) < 1e-9);
  assert.ok(Math.abs(resumedAlice.hp - alice.hp) < 1e-9);
  assert.ok(resumedAlice.weapons.some((weapon) => weapon.id === "rocket"));
  assert.ok(resumedAlice.items.some((item) => item.id === "vitality"));
  assert.equal(resumed.phaseTimer, resumed.peaceDuration());
  assert.equal(resumed.players.get("player-1").gold, 5);
});

test("存档还原后掉线与死亡状态会被清理，玩家重新投入战斗", () => {
  const { game } = createGame("endless", 1, { accountIds: ["acct-alice"] });
  const alice = game.players.get("player-0");
  alice.alive = false;
  alice.hp = 0;
  alice.owedUpgrades = 2;
  const state = game.captureSaveState();

  const { game: resumed } = createGame("endless", 1, { accountIds: ["acct-alice"], save: { state } });
  const resumedAlice = resumed.players.get("player-0");
  assert.equal(resumedAlice.alive, true);
  assert.ok(resumedAlice.hp > 0);
  assert.ok(resumedAlice.invulnerableFor > 0);
});

test("未参与原存档的玩家会获得按波次计算的加入补偿", () => {
  const { game } = createGame("endless", 1, { accountIds: ["acct-alice"] });
  game.wave = 8;
  const state = game.captureSaveState();

  const { game: resumed } = createGame("endless", 2, { save: { state } });
  const newcomer = resumed.players.get("player-1");
  const base = createGame("endless").game.players.get("player-0");

  assert.ok(newcomer.maxHp > base.maxHp);
  assert.ok(newcomer.damage > base.damage);
  assert.ok(newcomer.gold > 0);
  assert.ok(newcomer.owedUpgrades > 0);
  assert.ok(newcomer.pendingUpgrade, "补偿等级会立即给出三选一");
});

test("存档不会把玩家强化重复叠加（多次还原结果一致）", () => {
  const { game } = createGame("endless", 1, { accountIds: ["acct-alice"] });
  const alice = game.players.get("player-0");
  alice.upgrades.power = 4;
  alice.damage = 123.456;
  const state = game.captureSaveState();

  const first = createGame("endless", 1, { accountIds: ["acct-alice"], save: { state } }).game;
  const second = createGame("endless", 1, { accountIds: ["acct-alice"], save: { state: first.captureSaveState() } }).game;

  assert.equal(first.players.get("player-0").damage, 123.456);
  assert.equal(second.players.get("player-0").damage, 123.456);
  assert.equal(second.players.get("player-0").upgrades.power, 4);
});

test("无尽模式失败时会带上到达波次与存档信息，并触发结算回调", () => {
  const finished = [];
  const { game } = createGame("endless", 1, { accountIds: ["acct-alice"], onFinish: (result) => finished.push(result) });
  game.wave = 13;
  game.elapsed = 640;
  const alice = game.players.get("player-0");
  alice.alive = false;
  alice.hp = 0;
  game.checkEndConditions();

  assert.equal(game.ended, true);
  assert.equal(game.result.endless, true);
  assert.equal(game.result.wave, 13);
  assert.match(game.result.title, /第 13 波/);
  assert.deepEqual(finished.map((result) => result.wave), [13]);
});

test("无尽模式全员掉线时不会立刻结算，重连后可继续", () => {
  const { game } = createGame("endless", 2);
  game.markDisconnected("player-0");
  game.markDisconnected("player-1");
  game.checkEndConditions();
  assert.equal(game.ended, false, "全员掉线不应直接判定失败");

  game.reconnectPlayer("player-1", "player-1-back");
  game.checkEndConditions();
  assert.equal(game.ended, false);
  assert.equal(game.players.get("player-1-back").disconnected, false);
});

test("无尽模式全员阵亡（仍在线）会正常结算", () => {
  const { game } = createGame("endless", 2);
  for (const player of game.players.values()) {
    player.alive = false;
    player.hp = 0;
  }
  game.checkEndConditions();
  assert.equal(game.ended, true);
  assert.equal(game.result.endless, true);
});

test("地图在无尽模式中保持一致（存档续玩不会换图）", () => {
  const { game } = createGame("endless");
  game.wave = 6;
  const state = game.captureSaveState();
  const { game: resumed } = createGame("endless", 1, { save: { state } });
  assert.deepEqual(
    resumed.map.platforms.map((platform) => [platform.x, platform.y, platform.width]),
    game.map.platforms.map((platform) => [platform.x, platform.y, platform.width]),
  );
});
