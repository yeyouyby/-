import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { io as createClient } from "socket.io-client";
import { createServerInstance } from "../src/server.js";

const ADMIN_KEY = "integration-admin-key";

async function bootServer() {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lan-battle-server-"));
  const instance = createServerInstance({
    dataDirectory,
    adminKey: ADMIN_KEY,
    host: "127.0.0.1",
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  await instance.start();
  return { instance, dataDirectory, baseUrl: `http://127.0.0.1:${instance.port}` };
}

function connectClient(baseUrl) {
  return new Promise((resolve, reject) => {
    const socket = createClient(baseUrl, { transports: ["websocket"], forceNew: true });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function waitForEvent(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

async function adminFetch(baseUrl, routePath, options = {}) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    ...options,
    headers: { "x-admin-key": ADMIN_KEY, "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, payload, headers: response.headers };
}

test("账号注册、登录、存档与备份还原的完整流程", async (t) => {
  const { instance, dataDirectory, baseUrl } = await bootServer();
  const sockets = [];
  const openSocket = async () => {
    const socket = await connectClient(baseUrl);
    sockets.push(socket);
    return socket;
  };
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await instance.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  // —— 健康检查与管理员鉴权 ——
  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.accounts, 0);

  const unauthorized = await fetch(`${baseUrl}/api/admin/info`);
  assert.equal(unauthorized.status, 401, "缺少管理密钥应被拒绝");

  const info = await adminFetch(baseUrl, "/api/admin/info");
  assert.equal(info.status, 200);
  assert.equal(info.payload.data.accounts, 0);
  assert.equal(path.resolve(info.payload.data.directory), path.resolve(dataDirectory));

  // —— 注册账号 ——
  const host = await openSocket();
  const sessionPromise = waitForEvent(host, "account:session");
  const registered = await emitAck(host, "account:register", { username: "alice", password: "pass1234", displayName: "爱丽丝" });
  assert.equal(registered.ok, true, registered.error);
  const session = await sessionPromise;
  assert.equal(session.account.username, "alice");
  assert.equal(session.created, true);
  assert.ok(session.token);

  const afterRegister = await adminFetch(baseUrl, "/api/admin/info");
  assert.equal(afterRegister.payload.data.accounts, 1);

  // —— 无尽模式：开局、手动存档 ——
  const created = await emitAck(host, "room:create", { playerName: "爱丽丝", mode: "endless", maxPlayers: 4 });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.room.mode, "endless");
  assert.equal(created.room.savesSupported, true);

  const started = await emitAck(host, "game:start");
  assert.equal(started.ok, true, started.error);
  assert.equal(instance.roomManager.rooms.get(created.room.code).game.endless, true);

  const savedEvent = waitForEvent(host, "game:event");
  const saved = await emitAck(host, "save:now");
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.room.saveId.startsWith("save_"), true);
  const savedPayload = await savedEvent;
  assert.equal(savedPayload.type, "saved");

  // 存档列表会推送给同账号的连接
  const saves = await new Promise((resolve) => {
    host.emit("account:saves", {}, (response) => resolve(response));
  });
  assert.equal(saves.ok, true);
  assert.equal(saves.saves.length, 1);
  assert.equal(saves.saves[0].mode, "endless");

  // —— 导出备份：明文账号与存档都在里面 ——
  const exported = await adminFetch(baseUrl, "/api/admin/export");
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition") ?? "", /attachment; filename="lan-battle-backup-/);
  assert.equal(exported.payload.format, "lan-battle-backup");
  assert.equal(exported.payload.accounts[0].username, "alice");
  assert.equal(exported.payload.accounts[0].password, "pass1234");
  assert.equal(exported.payload.saves.length, 1);
  assert.equal(exported.payload.counts.saves, 1);

  // 数据文件同样是明文 JSON（写入有 120ms 防抖，这里先手动落盘）
  instance.store.flush();
  const accountsFile = JSON.parse(fs.readFileSync(path.join(dataDirectory, "accounts.json"), "utf8"));
  assert.equal(accountsFile.accounts[0].password, "pass1234");

  // —— 新连接用令牌恢复登录，并从存档点继续 ——
  const guest = await openSocket();
  const authResult = await emitAck(guest, "account:auth", { token: session.token });
  assert.equal(authResult.ok, true, authResult.error);
  assert.equal(authResult.session.account.username, "alice");
  assert.equal(authResult.session.saves.length, 1);

  const saveId = saved.room.saveId;
  const resumedRoom = await emitAck(guest, "room:create", { playerName: "爱丽丝", mode: "endless", saveId });
  assert.equal(resumedRoom.ok, true, resumedRoom.error);
  assert.equal(resumedRoom.room.saveId, saveId);
  assert.equal(resumedRoom.room.saveLabel, "无尽 · 第 1 波");

  const startPayload = waitForEvent(guest, "game:start");
  const resumedStart = await emitAck(guest, "game:start");
  assert.equal(resumedStart.ok, true, resumedStart.error);
  const startEvent = await startPayload;
  assert.equal(startEvent.resumed, true);
  assert.equal(startEvent.endless, true);
  assert.equal(startEvent.mode, "endless");

  // —— 导入还原：覆盖模式替换账号与存档 ——
  const backup = {
    format: "lan-battle-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    server: { adminKey: "other-server-key", instanceId: "srv_other" },
    accounts: [
      { id: "acct-imported", username: "imported", displayName: "迁移玩家", password: "pass1234", stats: { kills: 9 } },
    ],
    saves: [
      {
        id: "save-imported",
        accountId: "acct-imported",
        username: "imported",
        mode: "endless",
        label: "无尽 · 第 12 波",
        status: "active",
        wave: 12,
        state: { wave: 12, phase: "peace", players: [] },
      },
    ],
    sessions: [{ token: "imported-token", accountId: "acct-imported", username: "imported" }],
  };
  const imported = await adminFetch(baseUrl, "/api/admin/import?mode=replace", {
    method: "POST",
    body: JSON.stringify(backup),
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.payload));
  assert.equal(imported.payload.report.accounts.added, 1);
  assert.equal(imported.payload.report.saves.added, 1);
  assert.ok(imported.payload.report.preImportBackup, "导入前应自动快照原数据");
  assert.equal(imported.payload.data.accounts, 1);
  assert.equal(imported.payload.data.saves, 1);
  // 管理密钥沿用本机密钥，避免备份文件里的密钥接管服务器
  assert.equal(instance.store.stats().adminKey, ADMIN_KEY);

  const reExported = await adminFetch(baseUrl, "/api/admin/export");
  assert.equal(reExported.payload.accounts[0].username, "imported");
  assert.equal(reExported.payload.saves[0].wave, 12);

  // 迁移过来的令牌可以直接恢复登录
  const migrated = await openSocket();
  const migratedAuth = await emitAck(migrated, "account:auth", { token: "imported-token" });
  assert.equal(migratedAuth.ok, true, migratedAuth.error);
  assert.equal(migratedAuth.session.account.displayName, "迁移玩家");

  // —— 无效备份会被拒绝 ——
  const badImport = await adminFetch(baseUrl, "/api/admin/import", {
    method: "POST",
    body: JSON.stringify({ hello: "world" }),
  });
  assert.equal(badImport.status, 400);
  assert.match(badImport.payload.error, /accounts|saves/);

  // —— 本地快照：生成、列出、还原 ——
  const snapshot = await adminFetch(baseUrl, "/api/admin/backup", { method: "POST" });
  assert.equal(snapshot.status, 200);
  assert.ok(snapshot.payload.file.endsWith("-manual.json"));

  const backupList = await adminFetch(baseUrl, "/api/admin/backups");
  assert.ok(backupList.payload.backups.length >= 2);

  const download = await adminFetch(baseUrl, `/api/admin/backups/${encodeURIComponent(snapshot.payload.file)}`);
  assert.equal(download.status, 200);
  assert.equal(download.payload.format, "lan-battle-backup");

  const restored = await adminFetch(baseUrl, "/api/admin/restore-backup", {
    method: "POST",
    body: JSON.stringify({ file: snapshot.payload.file }),
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.payload));
  assert.equal(instance.store.accounts.size, 1);

  // —— 大厅列表包含无尽房间 ——
  const lobbyRooms = await new Promise((resolve) => {
    const probe = createClient(baseUrl, { transports: ["websocket"], forceNew: true });
    sockets.push(probe);
    probe.once("lobby:rooms", resolve);
    probe.once("connect", () => {});
  });
  assert.ok(Array.isArray(lobbyRooms));
});

test("登录失败会被拒绝，密码可以修改且旧令牌失效", async (t) => {
  const { instance, dataDirectory, baseUrl } = await bootServer();
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await instance.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  const socket = await connectClient(baseUrl);
  sockets.push(socket);

  await emitAck(socket, "account:register", { username: "bob", password: "pass1234" });
  const firstToken = (await emitAck(socket, "account:auth", { token: "bogus" }));
  assert.equal(firstToken.ok, false);
  assert.match(firstToken.error, /失效/);

  await emitAck(socket, "account:logout");
  const wrong = await emitAck(socket, "account:login", { username: "bob", password: "nope" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /账号或密码错误/);

  const login = await emitAck(socket, "account:login", { username: "BOB", password: "pass1234" });
  assert.equal(login.ok, true, login.error);
  const token = login.session.token;

  // 登录状态下不能重复登录
  const again = await emitAck(socket, "account:login", { username: "bob", password: "pass1234" });
  assert.equal(again.ok, false);
  assert.match(again.error, /已登录/);

  const changed = await emitAck(socket, "account:password", { currentPassword: "pass1234", newPassword: "newpass1" });
  assert.equal(changed.ok, true, changed.error);
  assert.notEqual(changed.session.token, token);
  // 改密后旧令牌失效（其他设备需要重新登录）
  assert.equal(instance.store.resolveSession(token), null);
  assert.equal(instance.store.resolveSession(changed.session.token).account.username, "bob");
  assert.equal(instance.store.verifyCredentials("bob", "newpass1").username, "bob");

  // 注销账号会同时清理账号与存档
  const save = instance.store.createSave({ accountId: instance.store.findAccount("bob").id, state: { wave: 2, players: [] } });
  const deleted = await emitAck(socket, "account:delete", { password: "newpass1" });
  assert.equal(deleted.ok, true, deleted.error);
  assert.equal(instance.store.accounts.size, 0);
  assert.equal(instance.store.getSave(save.id), null);
});

test("【回归】端到端：无尽模式对局中真的会刷怪", async (t) => {
  const { instance, dataDirectory, baseUrl } = await bootServer();
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await instance.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  const host = await connectClient(baseUrl);
  sockets.push(host);
  await emitAck(host, "account:register", { username: "endless", password: "pass1234" });
  const created = await emitAck(host, "room:create", { playerName: "无尽", mode: "endless" });
  assert.equal(created.ok, true, created.error);
  await emitAck(host, "game:start");

  // 收集真实快照，确认怪物出现在客户端可见状态里
  const enemyCounts = [];
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 6000);
    host.on("game:snapshot", (snapshot) => {
      enemyCounts.push(snapshot.enemies.length);
      assert.equal(snapshot.endless, true);
      if (snapshot.enemies.length > 0) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  assert.ok(enemyCounts.some((count) => count > 0), `无尽模式快照中必须出现怪物，实际：${enemyCounts.join(",")}`);
});

test("【回归】登录失败锁定不会被重连绕过", async (t) => {
  const { instance, dataDirectory, baseUrl } = await bootServer();
  const sockets = [];
  const openSocket = async () => {
    const socket = await connectClient(baseUrl);
    sockets.push(socket);
    return socket;
  };
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await instance.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  const setup = await openSocket();
  const registered = await emitAck(setup, "account:register", { username: "bruteforce", password: "pass1234" });
  assert.equal(registered.ok, true, registered.error);
  await emitAck(setup, "account:logout");

  // 失败两次后用正确密码登录：计数应被清零
  const patient = await openSocket();
  await emitAck(patient, "account:login", { username: "bruteforce", password: "wrong" });
  await emitAck(patient, "account:login", { username: "bruteforce", password: "wrong" });
  const recovered = await emitAck(patient, "account:login", { username: "bruteforce", password: "pass1234" });
  assert.equal(recovered.ok, true, recovered.error);
  await emitAck(patient, "account:logout");

  // 每次失败都换一条新连接（新的 socket.id），锁定依然生效
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const attacker = await openSocket();
    const result = await emitAck(attacker, "account:login", { username: "bruteforce", password: "guess" });
    assert.equal(result.ok, false);
    assert.match(result.error, /账号或密码错误/);
  }
  const blocked = await emitAck(await openSocket(), "account:login", { username: "bruteforce", password: "pass1234" });
  assert.equal(blocked.ok, false, "重连后仍然应该被锁定");
  assert.match(blocked.error, /登录尝试过于频繁/);
});

test("【回归】令牌被撤销后旧连接不能再操作账号，且房间绑定被清理", async (t) => {
  const { instance, dataDirectory, baseUrl } = await bootServer();
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await instance.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  const host = await connectClient(baseUrl);
  sockets.push(host);
  const registered = await emitAck(host, "account:register", { username: "revoked", password: "pass1234", displayName: "被撤销" });
  assert.equal(registered.ok, true, registered.error);
  const token = registered.session.token;

  const created = await emitAck(host, "room:create", { playerName: "被撤销", mode: "endless" });
  assert.equal(created.ok, true, created.error);
  const room = instance.roomManager.rooms.get(created.room.code);
  assert.equal(room.players.get(host.id).accountId, registered.session.account.id);

  // 模拟改密 / 导入还原导致令牌失效
  instance.store.revokeSession(token);
  const sessionEvents = [];
  host.on("account:session", (payload) => sessionEvents.push(payload));

  const rename = await emitAck(host, "account:rename", { displayName: "黑客" });
  assert.equal(rename.ok, false);
  assert.match(rename.error, /登录状态已失效/);
  const saves = await emitAck(host, "account:saves");
  assert.equal(saves.ok, false);
  const deleteSave = await emitAck(host, "account:delete-save", { saveId: "save_x" });
  assert.equal(deleteSave.ok, false);

  // 客户端会收到登出通知，房间里的账号绑定同步清空
  assert.ok(sessionEvents.some((payload) => payload.token === null));
  assert.equal(room.players.get(host.id).accountId, null);
  assert.equal(instance.store.findAccount("revoked").displayName, "被撤销", "显示名不应被修改");
});

test("【回归】端口被占用时 start() 会立即报错而不是永久等待", async (t) => {
  const { instance, dataDirectory, baseUrl } = await bootServer();
  t.after(async () => {
    await instance.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });
  assert.ok(baseUrl);

  const blocked = createServerInstance({
    dataDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "lan-battle-blocked-")),
    adminKey: ADMIN_KEY,
    host: "127.0.0.1",
    port: instance.port,
    logger: { log() {}, warn() {}, error() {} },
  });
  t.after(() => {
    blocked.store.close();
    fs.rmSync(blocked.dataDirectory, { recursive: true, force: true });
  });

  await assert.rejects(() => blocked.start(), (error) => error.code === "EADDRINUSE");
});
