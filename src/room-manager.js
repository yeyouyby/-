import { getPlayerClass, MAX_PLAYERS, ROOM_CODE_LENGTH } from "./config.js";
import { GameSession } from "./game.js";
import { randomId, randomRoomCode, sanitizeName } from "./utils.js";

const REJOIN_GRACE_MS = 90_000;

export class RoomManager {
  constructor(io, options = {}) {
    this.io = io;
    this.rooms = new Map();
    this.maxPlayers = options.maxPlayers ?? MAX_PLAYERS;
    this.rejoinGraceMs = options.rejoinGraceMs ?? REJOIN_GRACE_MS;
  }

  createRoom(socket, payload = {}) {
    this.leaveRoom(socket);
    socket.data.classId = payload.classId;
    let code;
    do {
      code = randomRoomCode(ROOM_CODE_LENGTH);
    } while (this.rooms.has(code));

    const room = {
      code,
      name: String(payload.roomName ?? "").trim().slice(0, 24) || `${sanitizeName(payload.playerName)}的房间`,
      mode: payload.mode === "pvp" ? "pvp" : "pve",
      hostId: socket.id,
      maxPlayers: Math.max(2, Math.min(this.maxPlayers, Number(payload.maxPlayers) || 4)),
      players: new Map(),
      game: null,
      createdAt: Date.now(),
    };
    this.rooms.set(code, room);
    this.addPlayer(room, socket, payload.playerName);
    return room;
  }

  joinRoom(socket, payload = {}) {
    const code = String(payload.code ?? "").trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) {
      throw new Error("房间不存在");
    }
    if (room.game) {
      throw new Error("对局已经开始");
    }
    if (room.players.size >= room.maxPlayers) {
      throw new Error("房间已满");
    }
    if (socket.data.roomCode === code) {
      socket.data.classId = payload.classId;
      return room;
    }
    this.leaveRoom(socket);
    socket.data.classId = payload.classId;
    this.addPlayer(room, socket, payload.playerName);
    return room;
  }

  addPlayer(room, socket, playerName) {
    const playerClass = getPlayerClass(socket.data.classId);
    const player = {
      id: socket.id,
      name: sanitizeName(playerName),
      classId: playerClass.id,
      className: playerClass.name,
      ready: socket.id === room.hostId,
      color: this.playerColor(room.players.size),
      playerKey: randomId("pk"),
      disconnected: false,
      disconnectedAt: null,
    };
    room.players.set(socket.id, player);
    socket.data.roomCode = room.code;
    socket.join(room.code);
    this.sendSession(socket, room);
    this.broadcastRoom(room);
    return player;
  }

  sendSession(socket, room) {
    const player = room.players.get(socket.id);
    if (!player) return;
    socket.emit("room:session", { code: room.code, playerKey: player.playerKey });
  }

  leaveRoom(socket) {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = this.rooms.get(code);
    socket.data.roomCode = null;
    socket.leave(code);
    if (!room) return;

    room.players.delete(socket.id);
    room.game?.removePlayer(socket.id);
    if (room.players.size === 0) {
      room.game?.stop();
      this.rooms.delete(code);
      this.broadcastLobby();
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value;
      room.players.get(room.hostId).ready = true;
    }
    this.broadcastRoom(room);
  }

  handleDisconnect(socket) {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    player.disconnected = true;
    player.disconnectedAt = Date.now();
    socket.leave(code);
    socket.data.roomCode = null;

    if (room.hostId === socket.id) {
      const next = [...room.players.values()].find((candidate) => !candidate.disconnected);
      if (next) {
        room.hostId = next.id;
        next.ready = true;
      }
    }
    room.game?.markDisconnected(socket.id);
    this.broadcastRoom(room);

    const playerKey = player.playerKey;
    setTimeout(() => {
      const current = this.rooms.get(code);
      if (!current) return;
      const stale = current.players.get(socket.id);
      if (!stale || !stale.disconnected || stale.playerKey !== playerKey) return;
      current.players.delete(socket.id);
      current.game?.removePlayer(socket.id);
      if (current.players.size === 0) {
        current.game?.stop();
        this.rooms.delete(code);
        this.broadcastLobby();
        return;
      }
      if (current.hostId === socket.id) {
        current.hostId = current.players.keys().next().value;
        current.players.get(current.hostId).ready = true;
      }
      this.broadcastRoom(current);
    }, this.rejoinGraceMs).unref?.();
  }

  rejoin(socket, payload = {}) {
    if (socket.data.roomCode) throw new Error("当前已在房间中");
    const code = String(payload.code ?? "").trim().toUpperCase();
    const playerKey = String(payload.playerKey ?? "").trim();
    const room = this.rooms.get(code);
    if (!room) throw new Error("房间不存在或已解散");
    const entry = [...room.players.entries()].find(([, candidate]) => candidate.playerKey === playerKey && candidate.disconnected);
    if (!entry) throw new Error("无法恢复席位，可能已超时或被移除");
    const [oldId, player] = entry;

    room.players.delete(oldId);
    player.id = socket.id;
    player.disconnected = false;
    player.disconnectedAt = null;
    room.players.set(socket.id, player);
    socket.data.roomCode = code;
    socket.data.classId = player.classId;
    socket.join(code);

    if (room.game && !room.game.ended) {
      room.game.reconnectPlayer(oldId, socket.id);
    }
    this.sendSession(socket, room);
    this.broadcastRoom(room);
    if (room.game && !room.game.ended) room.game.resendState(socket.id);
    return room;
  }

  toggleReady(socket, ready) {
    const room = this.getSocketRoom(socket);
    if (room.game) throw new Error("对局已经开始");
    const player = room.players.get(socket.id);
    player.ready = socket.id === room.hostId ? true : Boolean(ready);
    this.broadcastRoom(room);
  }

  startGame(socket) {
    const room = this.getSocketRoom(socket);
    if (room.hostId !== socket.id) throw new Error("只有房主可以开始");
    if (room.game && !room.game.ended) throw new Error("对局正在进行中");
    if (room.mode === "pvp" && room.players.size < 2) throw new Error("PvP 至少需要 2 名玩家");
    if ([...room.players.values()].some((player) => !player.ready)) {
      throw new Error("仍有玩家未准备");
    }
    room.game = new GameSession(room, this.io, () => {
      room.game = null;
      for (const player of room.players.values()) player.ready = player.id === room.hostId;
      this.broadcastRoom(room);
    });
    room.game.start();
    this.broadcastRoom(room);
  }

  replay(socket) {
    const room = this.getSocketRoom(socket);
    if (room.hostId !== socket.id) throw new Error("只有房主可以重新开始");
    if (!room.game?.ended) throw new Error("当前不能重新开始");
    room.game.stop();
    room.game = null;
    for (const player of room.players.values()) player.ready = player.id === room.hostId;
    this.broadcastRoom(room);
  }

  handleInput(socket, input) {
    this.rooms.get(socket.data.roomCode)?.game?.setInput(socket.id, input);
  }

  chooseUpgrade(socket, upgradeId) {
    this.rooms.get(socket.data.roomCode)?.game?.chooseUpgrade(socket.id, upgradeId);
  }

  buyShopItem(socket, itemId) {
    this.rooms.get(socket.data.roomCode)?.game?.buyShopItem(socket.id, itemId);
  }

  getSocketRoom(socket) {
    const room = this.rooms.get(socket.data.roomCode);
    if (!room || !room.players.has(socket.id)) throw new Error("你不在房间中");
    return room;
  }

  serializeRoom(room) {
    return {
      code: room.code,
      name: room.name,
      mode: room.mode,
      hostId: room.hostId,
      maxPlayers: room.maxPlayers,
      status: room.game ? (room.game.ended ? "ended" : "playing") : "waiting",
      players: [...room.players.values()].map((player) => ({
        id: player.id,
        name: player.name,
        classId: player.classId,
        className: player.className,
        ready: player.ready,
        color: player.color,
        disconnected: player.disconnected,
      })),
    };
  }

  listRooms() {
    return [...this.rooms.values()]
      .filter((room) => !room.game && room.players.size < room.maxPlayers)
      .map((room) => ({
        code: room.code,
        name: room.name,
        mode: room.mode,
        players: room.players.size,
        maxPlayers: room.maxPlayers,
      }));
  }

  broadcastRoom(room) {
    this.io.to(room.code).emit("room:state", this.serializeRoom(room));
    this.broadcastLobby();
  }

  broadcastLobby() {
    this.io.emit("lobby:rooms", this.listRooms());
  }

  playerColor(index) {
    return ["#61dafb", "#ff6b81", "#ffd166", "#7bed9f", "#a29bfe", "#ff9f43", "#70a1ff", "#eccc68"][index];
  }
}
