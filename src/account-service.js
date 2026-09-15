import { accountChannel, sanitizeName } from "./utils.js";

const MAX_LOGIN_FAILURES = 8;
const LOGIN_LOCK_MS = 30_000;

/**
 * 账号服务：注册 / 登录 / 令牌续期 / 改密 / 删除账号 / 存档列表。
 *
 * 说明：账号与密码按用户要求以明文保存在服务器 data 目录的 JSON 文件中，
 * 因此只应运行在可信局域网。登录令牌同样明文存储，便于服务器整体迁移。
 */
export class AccountService {
  constructor({ store, io, roomManager, logger = console }) {
    this.store = store;
    this.io = io;
    this.roomManager = roomManager;
    this.logger = logger;
    this.failures = new Map(); // socket.id -> { count, lockedUntil }
  }

  bind(socket) {
    const handle = (event, handler) => {
      socket.on(event, (payload, acknowledge) => {
        try {
          const result = handler(payload ?? {});
          acknowledge?.({ ok: true, ...result });
        } catch (error) {
          acknowledge?.({ ok: false, error: error.message });
          socket.emit("account:error", { message: error.message });
        }
      });
    };

    handle("account:register", (payload) => this.register(socket, payload));
    handle("account:login", (payload) => this.login(socket, payload));
    handle("account:auth", (payload) => this.resume(socket, payload));
    handle("account:logout", () => this.logout(socket));
    handle("account:profile", () => this.sendProfile(socket));
    handle("account:password", (payload) => this.changePassword(socket, payload));
    handle("account:rename", (payload) => this.rename(socket, payload));
    handle("account:delete", (payload) => this.deleteAccount(socket, payload));
    handle("account:delete-save", (payload) => this.deleteSave(socket, payload));
    handle("account:saves", () => this.sendSaves(socket));

    socket.on("disconnect", () => this.failures.delete(socket.id));
  }

  /* ---------------------------------------------------------------- 登录 */

  assertNotLocked(socket) {
    const state = this.failures.get(socket.id);
    if (state?.lockedUntil && state.lockedUntil > Date.now()) {
      const seconds = Math.ceil((state.lockedUntil - Date.now()) / 1000);
      throw new Error(`登录尝试过于频繁，请 ${seconds} 秒后再试`);
    }
  }

  noteFailure(socket) {
    const state = this.failures.get(socket.id) ?? { count: 0, lockedUntil: 0 };
    state.count += 1;
    if (state.count >= MAX_LOGIN_FAILURES) {
      state.count = 0;
      state.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    }
    this.failures.set(socket.id, state);
  }

  register(socket, payload) {
    if (socket.data.accountId) throw new Error("当前已登录，请先退出账号");
    const account = this.store.registerAccount({
      username: payload.username,
      password: payload.password,
      displayName: payload.displayName,
    });
    const session = this.store.createSession(account);
    return this.attach(socket, account, session, { created: true });
  }

  login(socket, payload) {
    if (socket.data.accountId) throw new Error("当前已登录，请先退出账号");
    this.assertNotLocked(socket);
    let account;
    try {
      account = this.store.verifyCredentials(payload.username, payload.password);
    } catch (error) {
      this.noteFailure(socket);
      throw error;
    }
    this.failures.delete(socket.id);
    const session = this.store.createSession(account);
    return this.attach(socket, account, session, { created: false });
  }

  /** 用本地保存的令牌自动恢复登录状态（服务器迁移后同样有效，令牌随备份一起迁移） */
  resume(socket, payload) {
    const resolved = this.store.resolveSession(payload.token);
    if (!resolved) throw new Error("登录状态已失效，请重新登录");
    return this.attach(socket, resolved.account, resolved.session, { created: false, resumed: true });
  }

  attach(socket, account, session, { created = false, resumed = false } = {}) {
    socket.data.accountId = account.id;
    socket.data.username = account.username;
    socket.data.accountToken = session.token;
    socket.join(accountChannel(account.id));
    this.roomManager?.updateAccountBinding(socket, account);
    const payload = {
      token: session.token,
      account: this.store.publicAccount(account),
      saves: this.store.listSaves(account.id, { includeFinished: true }).map((save) => this.store.saveSummary(save)),
      created,
      resumed,
    };
    socket.emit("account:session", payload);
    return { session: payload };
  }

  logout(socket) {
    const token = socket.data.accountToken;
    if (token) this.store.revokeSession(token);
    if (socket.data.accountId) {
      socket.leave(accountChannel(socket.data.accountId));
      socket.data.accountId = null;
      socket.data.username = null;
      socket.data.accountToken = null;
    }
    this.roomManager?.updateAccountBinding(socket, null);
    socket.emit("account:session", { token: null, account: null, saves: [] });
    return { loggedOut: true };
  }

  requireAccount(socket) {
    const accountId = socket.data.accountId;
    if (!accountId) throw new Error("请先登录账号");
    const account = this.store.getAccountById(accountId);
    if (!account) throw new Error("账号已不存在，请重新登录");
    return account;
  }

  sendProfile(socket) {
    const account = this.requireAccount(socket);
    const payload = { account: this.store.publicAccount(account) };
    socket.emit("account:profile", payload);
    return payload;
  }

  sendSaves(socket) {
    const account = this.requireAccount(socket);
    const saves = this.store.listSaves(account.id, { includeFinished: true }).map((save) => this.store.saveSummary(save));
    socket.emit("account:saves", saves);
    return { saves };
  }

  changePassword(socket, payload) {
    const account = this.requireAccount(socket);
    this.store.verifyCredentials(account.username, payload.currentPassword);
    this.store.setPassword(account, payload.newPassword);
    // 修改密码后让其它登录令牌失效，仅保留当前连接
    this.store.revokeAccountSessions(account.id);
    const session = this.store.createSession(account);
    socket.data.accountToken = session.token;
    const sessionPayload = {
      token: session.token,
      account: this.store.publicAccount(account),
      saves: this.store.listSaves(account.id, { includeFinished: true }).map((save) => this.store.saveSummary(save)),
      created: false,
      resumed: false,
      passwordChanged: true,
    };
    socket.emit("account:session", sessionPayload);
    return { changed: true, session: sessionPayload };
  }

  rename(socket, payload) {
    const account = this.requireAccount(socket);
    this.store.setDisplayName(account, sanitizeName(payload.displayName));
    const profile = { account: this.store.publicAccount(account) };
    this.io.to(accountChannel(account.id)).emit("account:profile", profile);
    const room = this.roomManager?.rooms.get(socket.data.roomCode);
    if (room) {
      const player = room.players.get(socket.id);
      if (player && !room.game) {
        player.name = sanitizeName(payload.displayName);
        this.roomManager.broadcastRoom(room);
      }
    }
    return profile;
  }

  deleteAccount(socket, payload) {
    const account = this.requireAccount(socket);
    const accountId = account.id;
    this.store.deleteAccount(account.username, payload.password);
    socket.data.accountId = null;
    socket.data.username = null;
    socket.data.accountToken = null;
    socket.leave(accountChannel(accountId));
    this.roomManager?.updateAccountBinding(socket, null);
    socket.emit("account:session", { token: null, account: null, saves: [] });
    return { deleted: true };
  }

  deleteSave(socket, payload) {
    const account = this.requireAccount(socket);
    const save = this.store.getSave(payload.saveId);
    if (!save || save.accountId !== account.id) throw new Error("找不到该存档");
    this.roomManager?.deleteSavePoint(socket, save.id);
    return { deleted: true, saveId: save.id };
  }
}
