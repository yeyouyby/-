import { AUTOSAVE_MIN_INTERVAL_MS, getPlayerClass, isGameMode, MAX_PLAYERS, ROOM_CODE_LENGTH } from "./config.js";
import { GameSession } from "./game.js";
import { accountChannel, randomId, randomRoomCode, sanitizeName } from "./utils.js";

const REJOIN_GRACE_MS = 90_000;

export class RoomManager {
  constructor(io, options = {}) {
    this.io = io;
    this.rooms = new Map();
    this.maxPlayers = options.maxPlayers ?? MAX_PLAYERS;
    this.rejoinGraceMs = options.rejoinGraceMs ?? REJOIN_GRACE_MS;
    this.store = options.store ?? null; // DataStore：账号 + 无尽模式存档
  }

  createRoom(socket, payload = {}) {
    this.leaveRoom(socket);
    socket.data.classId = payload.classId;
    let code;
    do {
      code = randomRoomCode(ROOM_CODE_LENGTH);
    } while (this.rooms.has(code));

    const mode = isGameMode(payload.mode) ? payload.mode : "pve";
    const room = {
      code,
      name: String(payload.roomName ?? "").trim().slice(0, 24) || `${sanitizeName(payload.playerName)}的房间`,
      mode,
      hostId: socket.id,
      maxPlayers: Math.max(2, Math.min(this.maxPlayers, Number(payload.maxPlayers) || 4)),
      players: new Map(),
      game: null,
      saveId: null,
      saveLabel: null,
      lastSavedAt: 0, // 该房间最近一次自动存档时间（按房间节流）
      createdAt: Date.now(),
    };
    this.rooms.set(code, room);
    this.addPlayer(room, socket, payload.playerName);
    // 房主可以在建房时直接指定从哪个存档点继续
    if (payload.saveId) {
      try {
        this.assignSavePoint(room, socket, payload.saveId);
      } catch (error) {
        socket.emit("save:error", { message: error.message });
      }
    }
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
    const account = this.getAccount(socket);
    const player = {
      id: socket.id,
      name: sanitizeName(playerName ?? account?.displayName),
      classId: playerClass.id,
      className: playerClass.name,
      ready: socket.id === room.hostId,
      color: this.playerColor(room.players.size),
      playerKey: randomId("pk"),
      disconnected: false,
      disconnectedAt: null,
      accountId: account?.id ?? null,
      username: account?.username ?? null,
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
      this.reassignSavePoint(room);
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
        this.reassignSavePoint(room);
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
        this.reassignSavePoint(current);
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
    // 重连时同步最新账号信息（可能刚登录）
    const account = this.getAccount(socket);
    if (account) {
      player.accountId = account.id;
      player.username = account.username;
    }
    room.players.set(socket.id, player);
    socket.data.roomCode = code;
    socket.data.classId = player.classId;
    socket.join(code);

    if (room.hostId === oldId) room.hostId = socket.id;

    if (room.game) {
      room.game.reconnectPlayer(oldId, socket.id);
      this.sendSession(socket, room);
      this.broadcastRoom(room);
      // 无论对局是否结束都重发状态；结束时附带 game:end 以便客户端显示结算界面
      room.game.resendState(socket.id);
      return room;
    }
    this.sendSession(socket, room);
    this.broadcastRoom(room);
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
    const save = this.loadSavePoint(room);
    room.game = new GameSession(room, this.io, () => {
      room.game = null;
      for (const player of room.players.values()) player.ready = player.id === room.hostId;
      this.broadcastRoom(room);
    }, {
      save,
      onWaveCleared: (game) => this.saveProgress(room, game, { reason: "wave" }),
      onFinish: (result, game) => this.handleGameEnd(room, result, game),
    });
    room.game.start();
    if (save) {
      this.io.to(room.code).emit("game:event", {
        type: "resumed",
        wave: room.game.wave,
        label: room.saveLabel ?? save.label,
      });
    }
    this.broadcastRoom(room);
  }

  replay(socket) {
    const room = this.getSocketRoom(socket);
    if (room.hostId !== socket.id) throw new Error("只有房主可以重新开始");
    if (!room.game?.ended) throw new Error("当前不能重新开始");
    room.game.stop();
    room.game = null;
    // 新一轮从零开始；如需续玩请在房间内重新选择存档点
    room.saveId = null;
    room.saveLabel = null;
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

  getAccount(socket) {
    const accountId = socket.data?.accountId;
    if (!accountId || !this.store) return null;
    return this.store.getAccountById(accountId);
  }

  /** 玩家在房间内登录/退出账号时同步席位信息（战绩与存档归属随之生效） */
  updateAccountBinding(socket, account) {
    const room = this.rooms.get(socket.data?.roomCode);
    if (!room) return null;
    const player = room.players.get(socket.id);
    if (!player) return null;
    player.accountId = account?.id ?? null;
    player.username = account?.username ?? null;
    if (account?.displayName && player.name === "无名战士") player.name = sanitizeName(account.displayName);
    const gamePlayer = room.game?.players.get(socket.id);
    if (gamePlayer) {
      gamePlayer.accountId = player.accountId;
      gamePlayer.username = player.username;
      gamePlayer.name = player.name;
    }
    // 换号（登录 / 退出 / 换账号）后不再拥有原账号的存档点，避免继续使用他人存档
    this.reassignSavePoint(room);
    this.broadcastRoom(room);
    return player;
  }

  /* ------------------------------------------------------------- 存档点 */

  loadSavePoint(room) {
    if (!room.saveId || !this.store) return null;
    const save = this.store.getSave(room.saveId);
    if (!save || save.status !== "active") return null;
    // 存档归属校验：房主必须正是该存档的账号，避免换号后沿用他人的存档
    const host = room.players.get(room.hostId);
    if (!host?.accountId || save.accountId !== host.accountId) {
      room.saveId = null;
      room.saveLabel = null;
      return null;
    }
    room.saveLabel = save.label;
    return save;
  }

  assignSavePoint(room, socket, saveId) {
    const host = room.players.get(socket.id);
    if (!saveId) {
      room.saveId = null;
      room.saveLabel = null;
      return null;
    }
    if (!this.store) throw new Error("服务端未启用存档功能");
    if (!host?.accountId) throw new Error("请先登录账号再选择存档点");
    const save = this.store.getSave(saveId);
    if (!save || save.accountId !== host.accountId) throw new Error("找不到属于你的存档");
    if (save.status !== "active") throw new Error("该存档已结束，无法继续");
    if (save.mode !== room.mode) throw new Error("存档模式与房间模式不一致");
    room.saveId = save.id;
    room.saveLabel = save.label;
    return save;
  }

  /** 房主切换（原房主离开）时，沿用同账号的存档；否则清空，避免越权使用他人存档 */
  reassignSavePoint(room) {
    if (!room.saveId || !this.store) return;
    const host = room.players.get(room.hostId);
    const save = this.store.getSave(room.saveId);
    if (!save || !host?.accountId || save.accountId !== host.accountId) {
      room.saveId = null;
      room.saveLabel = null;
    }
  }

  setSavePoint(socket, saveId = null) {
    const room = this.getSocketRoom(socket);
    if (room.hostId !== socket.id) throw new Error("只有房主可以选择存档点");
    if (room.game && !room.game.ended) throw new Error("对局进行中无法切换存档点");
    const save = this.assignSavePoint(room, socket, saveId);
    this.broadcastRoom(room);
    return save;
  }

  /** 把当前无尽进度写入服务器存档（自动存档 / 房主手动存档共用） */
  saveProgress(room, game, { reason = "auto", force = false } = {}) {
    if (!this.store || room.mode !== "endless" || !game || game.ended) return null;
    const now = Date.now();
    // 自动存档按房间节流：不同房间之间的自动存档互不影响
    if (!force && reason === "wave" && now - (room.lastSavedAt ?? 0) < AUTOSAVE_MIN_INTERVAL_MS) return null;
    const host = room.players.get(room.hostId);
    if (!host?.accountId) {
      this.io.to(room.hostId).emit("save:error", { message: "房主登录账号后才能保存无尽进度" });
      return null;
    }
    if (!game.hasConnectedPlayers()) return null; // 没人连接时不写存档
    const state = game.captureSaveState();
    let save = room.saveId ? this.store.getSave(room.saveId) : null;
    if (save && save.accountId !== host.accountId) save = null; // 换号后不覆盖他人存档
    try {
      if (!save || save.accountId !== host.accountId || save.status !== "active") {
        save = this.store.createSave({
          accountId: host.accountId,
          username: host.username,
          mode: room.mode,
          roomName: room.name,
          state,
        });
        room.saveId = save.id;
      } else {
        this.store.updateSave(save.id, { state, roomName: room.name });
      }
    } catch (error) {
      this.io.to(room.hostId).emit("save:error", { message: `保存失败：${error.message}` });
      return null;
    }
    room.lastSavedAt = now;
    room.saveLabel = save.label;
    this.pushSaves(host.accountId);
    this.io.to(room.code).emit("game:event", {
      type: "saved",
      wave: save.wave,
      label: save.label,
      reason,
      saveId: save.id,
    });
    return save;
  }

  /** 房主手动请求保存（无尽模式按 💾 按钮） */
  saveNow(socket) {
    const room = this.getSocketRoom(socket);
    if (room.hostId !== socket.id) throw new Error("只有房主可以保存进度");
    if (!room.game || room.game.ended) throw new Error("当前没有进行中的对局");
    if (room.mode !== "endless") throw new Error("只有无尽模式支持存档");
    const save = this.saveProgress(room, room.game, { reason: "manual", force: true });
    if (!save) throw new Error("保存失败，请先登录账号");
    return save;
  }

  deleteSavePoint(socket, saveId) {
    if (!this.store) throw new Error("服务端未启用存档功能");
    const account = this.getAccount(socket);
    if (!account) throw new Error("请先登录账号");
    this.store.deleteSave(saveId, account.id);
    for (const room of this.rooms.values()) {
      if (room.saveId === saveId) {
        room.saveId = null;
        room.saveLabel = null;
        this.broadcastRoom(room);
      }
    }
    this.pushSaves(account.id);
    return true;
  }

  pushSaves(accountId) {
    if (!this.store || !accountId) return;
    this.io.to(accountChannel(accountId)).emit("account:saves", this.store.listSaves(accountId, { includeFinished: true }).map((save) => this.store.saveSummary(save)));
  }

  /** 对局结束：结算账号统计并封存存档点 */
  handleGameEnd(room, result, game) {
    if (!this.store || !game) return;
    const players = [...game.players.values()];
    // 全员离开或全部掉线（房间解散）不算失败：既不结算战绩，也不封存存档，
    // 让玩家之后仍能从这个存档点继续。
    const abandoned = players.length === 0 || players.every((player) => player.disconnected);
    if (abandoned) return;
    if (room.saveId) {
      const save = this.store.getSave(room.saveId);
      if (save && save.status === "active") {
        this.store.finishSave(save.id, { outcome: result?.title ?? "", wave: game.wave });
        this.pushSaves(save.accountId);
      }
    }
    const reachedWave = Number(result?.wave ?? game.wave) || game.wave;
    const seen = new Set();
    for (const player of players) {
      if (!player.accountId || seen.has(player.accountId)) continue;
      seen.add(player.accountId);
      this.store.recordMatchResult(player.accountId, {
        won: Array.isArray(result?.winnerIds) && result.winnerIds.includes(player.id),
        kills: player.kills,
        gold: player.gold,
        wave: reachedWave,
        seconds: game.elapsed,
        endless: game.endless,
      });
      this.io.to(accountChannel(player.accountId)).emit("account:profile", {
        account: this.store.publicAccount(this.store.getAccountById(player.accountId)),
      });
    }
    // 存档点已封存，房间回到“等待”状态时不再显示
    room.saveLabel = null;
  }

  /* ------------------------------------------------------------- 序列化 */

  serializeRoom(room) {
    const host = room.players.get(room.hostId);
    return {
      code: room.code,
      name: room.name,
      mode: room.mode,
      endless: room.mode === "endless",
      hostId: room.hostId,
      maxPlayers: room.maxPlayers,
      status: room.game ? (room.game.ended ? "ended" : "playing") : "waiting",
      saveId: room.saveId,
      saveLabel: room.saveLabel,
      saveMode: room.mode,
      savesSupported: Boolean(this.store),
      hostCanSave: Boolean(this.store && host?.accountId),
      hostAccount: host?.username ?? null,
      players: [...room.players.values()].map((player) => ({
        id: player.id,
        name: player.name,
        classId: player.classId,
        className: player.className,
        ready: player.ready,
        color: player.color,
        disconnected: player.disconnected,
        username: player.username,
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
        endless: room.mode === "endless",
        players: room.players.size,
        maxPlayers: room.maxPlayers,
        saveLabel: room.saveLabel,
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
