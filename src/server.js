import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { AccountService } from "./account-service.js";
import { registerAdminRoutes } from "./admin-api.js";
import { RoomManager } from "./room-manager.js";
import { DataStore } from "./store.js";

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createServerInstance(options = {}) {
  // 允许传入 0 让系统分配端口（测试用）
  const port = options.port ?? (Number(process.env.PORT) || 3000);
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const dataDirectory =
    options.dataDirectory ?? process.env.DATA_DIR ?? path.join(projectRoot, "data");
  const logger = options.logger ?? console;

  const store = new DataStore({
    directory: dataDirectory,
    logger,
    adminKey: options.adminKey,
  });
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: false },
    transports: ["websocket", "polling"],
    maxHttpBufferSize: 32 * 1024 * 1024, // 导入备份时可能上传较大的 JSON
  });
  const roomManager = new RoomManager(io, { store, maxPlayers: options.maxPlayers });
  const accountService = new AccountService({ store, io, roomManager, logger });
  const publicDirectory = options.publicDirectory ?? path.join(projectRoot, "public");

  app.disable("x-powered-by");
  app.use(express.json({ limit: "32mb" }));
  app.use(express.static(publicDirectory));
  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      rooms: roomManager.rooms.size,
      players: [...roomManager.rooms.values()].reduce((sum, room) => sum + room.players.size, 0),
      accounts: store.accounts.size,
      saves: store.saves.size,
    });
  });

  registerAdminRoutes(app, { store, roomManager, logger });

  io.on("connection", (socket) => {
    socket.emit("lobby:rooms", roomManager.listRooms());
    socket.emit("server:info", {
      savesSupported: true,
      endlessSupported: true,
      accountRequired: false,
    });

    bind(socket, "room:create", (payload) => roomManager.createRoom(socket, payload));
    bind(socket, "room:join", (payload) => roomManager.joinRoom(socket, payload));
    bind(socket, "room:leave", () => roomManager.leaveRoom(socket));
    bind(socket, "room:rejoin", (payload) => roomManager.rejoin(socket, payload));
    bind(socket, "room:ready", (payload) => roomManager.toggleReady(socket, payload?.ready));
    bind(socket, "room:set-save", (payload) => {
      roomManager.setSavePoint(socket, payload?.saveId ?? null);
      return roomManager.getSocketRoom(socket);
    });
    bind(socket, "game:start", () => roomManager.startGame(socket));
    bind(socket, "game:replay", () => roomManager.replay(socket));
    // 存档相关操作返回房间状态，方便客户端立刻刷新存档点面板
    bind(socket, "save:now", () => {
      roomManager.saveNow(socket);
      return roomManager.getSocketRoom(socket);
    });
    bind(socket, "save:delete", (payload) => {
      roomManager.deleteSavePoint(socket, payload?.saveId);
    });

    socket.on("game:input", (payload) => roomManager.handleInput(socket, payload));
    socket.on("upgrade:choose", (upgradeId) => roomManager.chooseUpgrade(socket, upgradeId));
    socket.on("shop:buy", (itemId) => roomManager.buyShopItem(socket, itemId));
    socket.on("disconnect", () => roomManager.handleDisconnect(socket));

    accountService.bind(socket);
  });

  function bind(socket, event, handler) {
    socket.on(event, (payload, acknowledge) => {
      // 客户端只传回调（不传数据）时，socket.io 会把回调放在第一个参数
      if (typeof payload === "function") {
        acknowledge = payload;
        payload = undefined;
      }
      try {
        const result = handler(payload);
        acknowledge?.({ ok: true, room: result ? roomManager.serializeRoom(result) : undefined });
      } catch (error) {
        acknowledge?.({ ok: false, error: error.message });
        socket.emit("server:error", { message: error.message });
      }
    });
  }

  function start() {
    return new Promise((resolve) => {
      httpServer.listen(port, host, () => {
        const address = httpServer.address();
        const activePort = address && typeof address === "object" ? address.port : port;
        instance.port = activePort;
        logger.log(`LAN Battle 已启动: http://localhost:${activePort}`);
        for (const lanAddress of getLanAddresses()) logger.log(`局域网访问: http://${lanAddress}:${activePort}`);
        logger.log(`数据目录（明文存储）: ${path.resolve(dataDirectory)}`);
        logger.log(`管理密钥（用于备份导出/导入还原）: ${store.stats().adminKey}`);
        logger.log(`备份接口示例: curl -H "x-admin-key: ${store.stats().adminKey}" http://localhost:${activePort}/api/admin/info`);
        store.startAutoBackup();
        const lastBackup = store.stats().server.lastBackupFile;
        if (lastBackup) logger.log(`最近一次自动备份: ${lastBackup}`);
        resolve({ port: activePort, host });
      });
    });
  }

  function close() {
    return new Promise((resolve) => {
      store.close();
      io.close(() => {
        httpServer.close(() => resolve());
      });
      // 兜底：若连接迟迟不关闭也要让进程退出
      setTimeout(resolve, 500).unref?.();
    });
  }

  const instance = { app, httpServer, io, roomManager, store, accountService, start, close, port, host, dataDirectory };
  return instance;
}

function getLanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address?.family === "IPv4" && !address.internal)
    .map((address) => address.address);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const instance = createServerInstance();
  instance.start().catch((error) => {
    console.error("启动失败:", error);
    process.exit(1);
  });
  const shutdown = async (signal) => {
    console.log(`\n收到 ${signal}，正在保存数据并退出…`);
    await instance.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // 进程异常退出前尽量落盘，避免明文数据文件与内存不一致
  process.on("exit", () => {
    try {
      instance.store.flush();
    } catch {
      /* 退出阶段忽略写入错误 */
    }
  });
}

export { getLanAddresses };
