import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RoomManager } from "../src/room-manager.js";
import { DataStore } from "../src/store.js";

function createIo() {
  const events = [];
  return {
    events,
    to(target) {
      return {
        emit(event, payload) {
          events.push({ target, event, payload });
        },
      };
    },
    emit(event, payload) {
      events.push({ target: "all", event, payload });
    },
  };
}

function createSocket(id, account = null) {
  return {
    id,
    data: account ? { accountId: account.id, username: account.username } : {},
    joined: new Set(),
    join(code) {
      this.joined.add(code);
    },
    leave(code) {
      this.joined.delete(code);
    },
    emitted: [],
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
  };
}

function createManager() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lan-battle-room-"));
  const store = new DataStore({ directory, adminKey: "test-key" });
  const io = createIo();
  const manager = new RoomManager(io, { store, rejoinGraceMs: 5 });
  return { manager, store, io, directory };
}

function cleanup(manager, store) {
  for (const room of manager.rooms.values()) room.game?.stop();
  store.close();
}

test("未登录的房主无法保存无尽进度", () => {
  const { manager, store, io } = createManager();
  const host = createSocket("host");
  const room = manager.createRoom(host, { playerName: "游客", mode: "endless" });
  manager.startGame(host);

  const save = manager.saveProgress(room, room.game, { reason: "manual", force: true });
  assert.equal(save, null);
  assert.equal(room.saveId, null);
  assert.equal(store.saves.size, 0);
  assert.ok(
    io.events.some((entry) => entry.target === "host" && entry.event === "save:error"),
    "应提示房主登录账号后才能保存",
  );
  cleanup(manager, store);
});

test("登录房主的无尽进度会写入存档，并在同一存档上持续更新", () => {
  const { manager, store, io } = createManager();
  const account = store.registerAccount({ username: "alice", password: "pass1234" });
  const host = createSocket("host", account);
  const room = manager.createRoom(host, { playerName: "爱丽丝", mode: "endless" });
  manager.startGame(host);

  const first = manager.saveProgress(room, room.game, { reason: "manual", force: true });
  assert.ok(first);
  assert.equal(room.saveId, first.id);
  assert.equal(first.wave, 1);
  assert.equal(store.listSaves(account.id).length, 1);
  assert.ok(io.events.some((entry) => entry.event === "game:event" && entry.payload?.type === "saved"));

  room.game.wave = 4;
  const second = manager.saveProgress(room, room.game, { reason: "manual", force: true });
  assert.equal(second.id, first.id, "同一局无尽模式应复用同一个存档");
  assert.equal(store.listSaves(account.id).length, 1);
  assert.equal(store.getSave(first.id).wave, 4);
  assert.match(store.getSave(first.id).label, /第 4 波/);
  cleanup(manager, store);
});

test("清空一波会自动写入存档（无需手动操作）", () => {
  const { manager, store, io } = createManager();
  const account = store.registerAccount({ username: "auto", password: "pass1234" });
  const host = createSocket("host", account);
  const room = manager.createRoom(host, { playerName: "自动存档", mode: "endless" });
  manager.startGame(host);

  // 直接推进到波次结束，验证 enterPeace -> onWaveCleared -> saveProgress 的链路
  room.game.phase = "combat";
  room.game.phaseTimer = 0.01;
  room.game.updatePve(0.02);

  assert.equal(room.game.phase, "peace");
  const saves = store.listSaves(account.id);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].wave, 1);
  assert.equal(room.saveId, saves[0].id);
  assert.ok(io.events.some((entry) => entry.event === "game:event" && entry.payload?.type === "saved"));
  assert.ok(io.events.some((entry) => entry.event === "account:saves"), "存档列表会推送给同账号连接");
  cleanup(manager, store);
});

test("无尽模式的新房间可以从存档点继续", () => {
  const { manager, store } = createManager();
  const account = store.registerAccount({ username: "bob", password: "pass1234" });
  const host = createSocket("host", account);
  const room = manager.createRoom(host, { playerName: "鲍勃", mode: "endless" });
  manager.startGame(host);
  const player = room.game.players.get("host");
  player.gold = 250;
  player.level = 6;
  room.game.wave = 7;
  room.game.phase = "peace";
  const save = manager.saveProgress(room, room.game, { reason: "manual", force: true });
  room.game.stop();

  const host2 = createSocket("host2", account);
  const room2 = manager.createRoom(host2, { playerName: "鲍勃", mode: "endless", saveId: save.id });
  assert.equal(room2.saveId, save.id);
  assert.equal(room2.saveLabel, save.label);
  manager.startGame(host2);

  const resumed = room2.game.players.get("host2");
  assert.equal(room2.game.wave, 7);
  assert.equal(room2.game.restoredFromSave, true);
  assert.equal(resumed.gold, 250);
  assert.equal(resumed.level, 6);
  assert.ok(host2.joined.has(room2.code));
  cleanup(manager, store);
});

test("无法使用他人存档，也不允许非房主切换存档点", () => {
  const { manager, store } = createManager();
  const alice = store.registerAccount({ username: "alice", password: "pass1234" });
  const bob = store.registerAccount({ username: "bob", password: "pass1234" });
  const save = store.createSave({ accountId: alice.id, username: alice.username, state: { wave: 3, players: [] } });

  const bobSocket = createSocket("bob", bob);
  const room = manager.createRoom(bobSocket, { playerName: "鲍勃", mode: "endless" });
  assert.throws(() => manager.setSavePoint(bobSocket, save.id), /找不到属于你的存档/);

  const aliceSocket = createSocket("alice-host", alice);
  const aliceRoom = manager.createRoom(aliceSocket, { playerName: "爱丽丝", mode: "endless" });
  manager.setSavePoint(aliceSocket, save.id);
  assert.equal(aliceRoom.saveId, save.id);

  const guest = createSocket("guest", bob);
  manager.joinRoom(guest, { code: aliceRoom.code, playerName: "路人" });
  assert.throws(() => manager.setSavePoint(guest, null), /只有房主/);
  assert.equal(manager.createRoom(guest, { playerName: "路人", mode: "endless", saveId: save.id }) && true, true);
  cleanup(manager, store);
});

test("对局结束会封存存档点并累计账号战绩", () => {
  const { manager, store } = createManager();
  const account = store.registerAccount({ username: "carol", password: "pass1234" });
  const host = createSocket("host", account);
  const room = manager.createRoom(host, { playerName: "卡罗尔", mode: "endless" });
  manager.startGame(host);
  const player = room.game.players.get("host");
  player.kills = 17;
  player.gold = 60;
  room.game.wave = 6;
  const save = manager.saveProgress(room, room.game, { reason: "manual", force: true });

  player.alive = false;
  player.hp = 0;
  room.game.checkEndConditions();

  assert.equal(store.getSave(save.id).status, "finished");
  assert.match(store.getSave(save.id).outcome, /无尽/);
  assert.equal(store.listSaves(account.id).length, 0, "已结束的存档不再作为续玩点");
  const stats = store.getAccountById(account.id).stats;
  assert.equal(stats.games, 1);
  assert.equal(stats.kills, 17);
  assert.equal(stats.endlessBestWave, 6);
  cleanup(manager, store);
});

test("手动保存与删除存档的权限与副作用", () => {
  const { manager, store } = createManager();
  const account = store.registerAccount({ username: "dave", password: "pass1234" });
  const host = createSocket("host", account);
  const room = manager.createRoom(host, { playerName: "戴夫", mode: "endless" });

  const guest = createSocket("guest", account);
  manager.joinRoom(guest, { code: room.code, playerName: "路人" });
  manager.toggleReady(guest, true);
  manager.startGame(host);

  const save = manager.saveNow(host);
  assert.ok(save.id);
  assert.equal(room.saveId, save.id);
  assert.throws(() => manager.saveNow(guest), /只有房主/);

  manager.deleteSavePoint(host, save.id);
  assert.equal(store.getSave(save.id), null);
  assert.equal(room.saveId, null);
  cleanup(manager, store);
});

test("全员掉线不会封存存档（之后仍可继续）", async () => {
  const { manager, store } = createManager();
  const account = store.registerAccount({ username: "idle", password: "pass1234" });
  const host = createSocket("host", account);
  const room = manager.createRoom(host, { playerName: "挂机", mode: "endless" });
  manager.startGame(host);
  const save = manager.saveProgress(room, room.game, { reason: "manual", force: true });

  manager.handleDisconnect(host);
  room.game.checkEndConditions();
  assert.equal(room.game.ended, false, "掉线不应直接结束无尽对局");
  assert.equal(store.getSave(save.id).status, "active");

  // 重连宽限期结束后房间解散，存档依然保留可继续状态
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(manager.rooms.size, 0);
  assert.equal(store.getSave(save.id).status, "active");
  assert.equal(store.listSaves(account.id).length, 1);
  cleanup(manager, store);
});

test("固定波次与竞技模式不支持存档", () => {
  const { manager, store } = createManager();
  const account = store.registerAccount({ username: "erin", password: "pass1234" });
  const host = createSocket("host", account);

  const pve = manager.createRoom(host, { playerName: "艾琳", mode: "pve" });
  manager.startGame(host);
  assert.equal(pve.game.endless, false);
  assert.throws(() => manager.saveNow(host), /只有无尽模式/);
  assert.equal(manager.saveProgress(pve, pve.game, { reason: "manual", force: true }), null);
  assert.equal(manager.serializeRoom(pve).endless, false);
  pve.game.stop();

  const pvp = manager.createRoom(host, { playerName: "艾琳", mode: "pvp" });
  assert.equal(manager.serializeRoom(pvp).mode, "pvp");
  cleanup(manager, store);
});

test("自动存档有最小间隔，手动存档不受限制", () => {
  const { manager, store } = createManager();
  const account = store.registerAccount({ username: "frank", password: "pass1234" });
  const host = createSocket("host", account);
  const room = manager.createRoom(host, { playerName: "弗兰克", mode: "endless" });
  manager.startGame(host);

  assert.ok(manager.saveProgress(room, room.game, { reason: "wave" }));
  assert.equal(manager.saveProgress(room, room.game, { reason: "wave" }), null, "自动存档应被节流");
  assert.ok(manager.saveProgress(room, room.game, { reason: "manual", force: true }));
  cleanup(manager, store);
});

test("房间状态会带上存档点信息，退出到大厅后房间被清理", () => {
  const { manager, store } = createManager();
  const account = store.registerAccount({ username: "gina", password: "pass1234" });
  const host = createSocket("host", account);
  const room = manager.createRoom(host, { playerName: "吉娜", mode: "endless" });
  const serialized = manager.serializeRoom(room);
  assert.equal(serialized.savesSupported, true);
  assert.equal(serialized.hostCanSave, true);
  assert.equal(serialized.hostAccount, "gina");
  assert.equal(serialized.saveId, null);

  manager.leaveRoom(host);
  assert.equal(manager.rooms.size, 0);
  cleanup(manager, store);
});

test("【回归】自动存档按房间节流，一个房间不会拖慢另一个房间", () => {
  const { manager, store } = createManager();
  const alice = store.registerAccount({ username: "alice", password: "pass1234" });
  const bob = store.registerAccount({ username: "bob", password: "pass1234" });

  const hostA = createSocket("host-a", alice);
  const roomA = manager.createRoom(hostA, { playerName: "A", mode: "endless" });
  manager.startGame(hostA);
  const hostB = createSocket("host-b", bob);
  const roomB = manager.createRoom(hostB, { playerName: "B", mode: "endless" });
  manager.startGame(hostB);

  const saveA = manager.saveProgress(roomA, roomA.game, { reason: "wave" });
  const saveB = manager.saveProgress(roomB, roomB.game, { reason: "wave" });
  assert.ok(saveA, "第一个房间应能自动存档");
  assert.ok(saveB, "3 秒内另一个房间同样应能自动存档");
  assert.equal(store.listSaves(alice.id).length, 1);
  assert.equal(store.listSaves(bob.id).length, 1);

  // 同一个房间的连续自动存档仍然受节流保护
  assert.equal(manager.saveProgress(roomA, roomA.game, { reason: "wave" }), null);
  cleanup(manager, store);
});

test("【回归】房主换号后不再使用原账号的存档点", () => {
  const { manager, store } = createManager();
  const alice = store.registerAccount({ username: "alice", password: "pass1234" });
  const mallory = store.registerAccount({ username: "mallory", password: "pass1234" });
  const aliceSave = store.createSave({
    accountId: alice.id,
    username: alice.username,
    state: { wave: 11, phase: "peace", players: [{ accountId: alice.id, name: "爱丽丝", stats: {} }] },
  });

  const host = createSocket("host", alice);
  const room = manager.createRoom(host, { playerName: "爱丽丝", mode: "endless", saveId: aliceSave.id });
  assert.equal(room.saveId, aliceSave.id);

  // 同一连接退出登录：存档点必须立即失效
  manager.updateAccountBinding(host, null);
  assert.equal(room.saveId, null);
  assert.equal(manager.loadSavePoint(room), null);

  // 换另一个账号登录也不能使用原存档
  manager.updateAccountBinding(host, mallory);
  assert.throws(() => manager.setSavePoint(host, aliceSave.id), /找不到属于你的存档/);
  assert.equal(room.saveId, null);
  cleanup(manager, store);
});

test("【回归】开始对局时会再次校验存档归属", () => {
  const { manager, store } = createManager();
  const alice = store.registerAccount({ username: "alice", password: "pass1234" });
  const bob = store.registerAccount({ username: "bob", password: "pass1234" });
  const aliceSave = store.createSave({ accountId: alice.id, username: alice.username, state: { wave: 6, phase: "combat", players: [] } });

  const host = createSocket("host", alice);
  const room = manager.createRoom(host, { playerName: "爱丽丝", mode: "endless", saveId: aliceSave.id });
  // 绕过 UI 直接把房间的归属账号改掉，模拟换号后仍残留 saveId 的情况
  room.players.get("host").accountId = bob.id;
  room.players.get("host").username = bob.username;

  manager.startGame(host);
  assert.equal(room.game.wave, 1, "换了账号后不应读到他人存档的波次");
  assert.equal(room.saveId, null);
  room.game.stop();
  cleanup(manager, store);
});
