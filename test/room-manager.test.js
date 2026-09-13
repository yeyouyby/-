import assert from "node:assert/strict";
import test from "node:test";
import { RoomManager } from "../src/room-manager.js";

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

function createSocket(id) {
  return {
    id,
    data: {},
    joined: new Set(),
    join(code) {
      this.joined.add(code);
    },
    leave(code) {
      this.joined.delete(code);
    },
    emit(event, payload) {
      // 测试用：记录私有事件（如 room:session）
    },
  };
}

test("创建房间时清理输入并设置房主", () => {
  const manager = new RoomManager(createIo());
  const host = createSocket("host");
  const room = manager.createRoom(host, {
    playerName: "  测试   房主  ",
    classId: "medic",
    roomName: "测试房",
    mode: "pve",
    maxPlayers: 4,
  });

  assert.equal(room.hostId, "host");
  assert.equal(room.players.get("host").name, "测试 房主");
  assert.equal(room.players.get("host").className, "医师");
  assert.equal(room.players.get("host").ready, true);
  assert.equal(room.mode, "pve");
  assert.equal(room.code.length, 5);
});

test("加入、准备及房主转移", () => {
  const manager = new RoomManager(createIo());
  const host = createSocket("host");
  const guest = createSocket("guest");
  const room = manager.createRoom(host, { playerName: "房主" });

  manager.joinRoom(guest, { code: room.code.toLowerCase(), playerName: "队友" });
  manager.toggleReady(guest, true);
  assert.equal(room.players.get("guest").ready, true);

  manager.leaveRoom(host);
  assert.equal(room.hostId, "guest");
  assert.equal(room.players.get("guest").ready, true);
});

test("PvP 不允许单人开局", () => {
  const manager = new RoomManager(createIo());
  const host = createSocket("host");
  manager.createRoom(host, { playerName: "独行者", mode: "pvp" });
  assert.throws(() => manager.startGame(host), /至少需要 2 名玩家/);
});

test("断线玩家保留席位，重连后迁移", () => {
  const manager = new RoomManager(createIo());
  const host = createSocket("host");
  const room = manager.createRoom(host, { playerName: "房主" });
  const guest = createSocket("guest");
  manager.joinRoom(guest, { code: room.code, playerName: "队友" });
  const playerKey = room.players.get("guest").playerKey;

  manager.handleDisconnect(guest);
  assert.equal(room.players.get("guest").disconnected, true);
  assert.equal(room.players.size, 2);

  const guest2 = createSocket("guest2");
  const rejoined = manager.rejoin(guest2, { code: room.code, playerKey });
  assert.equal(rejoined.code, room.code);
  assert.equal(room.players.has("guest"), false);
  assert.equal(room.players.get("guest2").disconnected, false);
  assert.equal(guest2.joined.has(room.code), true);
});

test("room:state 广播不泄露 playerKey", () => {
  const manager = new RoomManager(createIo());
  const host = createSocket("host");
  manager.createRoom(host, { playerName: "房主" });
  const serialized = manager.serializeRoom(manager.rooms.values().next().value);
  for (const player of serialized.players) {
    assert.equal("playerKey" in player, false);
  }
});

test("已在房间中的 socket 无法重连", () => {
  const manager = new RoomManager(createIo());
  const host = createSocket("host");
  const room = manager.createRoom(host, { playerName: "房主" });
  const guest = createSocket("guest");
  manager.joinRoom(guest, { code: room.code, playerName: "队友" });
  const playerKey = room.players.get("guest").playerKey;
  manager.handleDisconnect(guest);

  const intruder = createSocket("intruder");
  manager.createRoom(intruder, { playerName: "入侵者" });
  assert.throws(() => manager.rejoin(intruder, { code: room.code, playerKey }), /已在房间中/);
});

test("无效 playerKey 无法重连", () => {
  const manager = new RoomManager(createIo());
  const host = createSocket("host");
  const room = manager.createRoom(host, { playerName: "房主" });
  const guest = createSocket("guest");
  manager.joinRoom(guest, { code: room.code, playerName: "队友" });
  manager.handleDisconnect(guest);

  const guest2 = createSocket("guest2");
  assert.throws(() => manager.rejoin(guest2, { code: room.code, playerKey: "pk_bogus" }), /无法恢复席位/);
  assert.equal(room.players.size, 2);
});

test("大厅中的键盘输入不会导致服务端异常", () => {
  const manager = new RoomManager(createIo());
  const visitor = createSocket("visitor");
  assert.doesNotThrow(() => manager.handleInput(visitor, { right: true }));
  assert.doesNotThrow(() => manager.chooseUpgrade(visitor, "power"));
  assert.doesNotThrow(() => manager.buyShopItem(visitor, "heal"));
});
