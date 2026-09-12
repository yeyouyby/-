import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { RoomManager } from "./room-manager.js";

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: false },
  transports: ["websocket", "polling"],
});
const roomManager = new RoomManager(io);
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");

app.disable("x-powered-by");
app.use(express.static(publicDirectory));
app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    rooms: roomManager.rooms.size,
    players: [...roomManager.rooms.values()].reduce((sum, room) => sum + room.players.size, 0),
  });
});

io.on("connection", (socket) => {
  socket.emit("lobby:rooms", roomManager.listRooms());

  bind(socket, "room:create", (payload) => roomManager.createRoom(socket, payload));
  bind(socket, "room:join", (payload) => roomManager.joinRoom(socket, payload));
  bind(socket, "room:leave", () => roomManager.leaveRoom(socket));
  bind(socket, "room:ready", (payload) => roomManager.toggleReady(socket, payload?.ready));
  bind(socket, "game:start", () => roomManager.startGame(socket));
  bind(socket, "game:replay", () => roomManager.replay(socket));

  socket.on("game:input", (payload) => roomManager.handleInput(socket, payload));
  socket.on("upgrade:choose", (upgradeId) => roomManager.chooseUpgrade(socket, upgradeId));
  socket.on("shop:buy", (itemId) => roomManager.buyShopItem(socket, itemId));
  socket.on("disconnect", () => roomManager.leaveRoom(socket));
});

function bind(socket, event, handler) {
  socket.on(event, (payload, acknowledge) => {
    try {
      const result = handler(payload);
      acknowledge?.({ ok: true, room: result ? roomManager.serializeRoom(result) : undefined });
    } catch (error) {
      acknowledge?.({ ok: false, error: error.message });
      socket.emit("server:error", { message: error.message });
    }
  });
}

httpServer.listen(port, host, () => {
  console.log(`LAN Battle 已启动: http://localhost:${port}`);
  for (const address of getLanAddresses()) console.log(`局域网访问: http://${address}:${port}`);
});

function getLanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address?.family === "IPv4" && !address.internal)
    .map((address) => address.address);
}

export { app, httpServer, io, roomManager };
