import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { randomId } from "./utils.js";

const STORE_VERSION = 1;
const ACCOUNTS_FILE = "accounts.json";
const SAVES_FILE = "saves.json";
const SERVER_FILE = "server.json";

export const BACKUP_FORMAT = "lan-battle-backup";
export const BACKUP_VERSION = 1;
export const USERNAME_PATTERN = /^[\w\u4e00-\u9fa5-]{2,16}$/u;
export const MIN_PASSWORD_LENGTH = 4;
export const MAX_PASSWORD_LENGTH = 64;

function readJsonFile(file, fallback) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return fallback;
  } catch (error) {
    if (error.code !== "ENOENT") {
      // 损坏的文件不直接丢弃：留档后再用空数据启动，方便人工修复
      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* 忽略留档失败 */
      }
    }
    return fallback;
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function ensureString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function ensureNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

/**
 * 服务器数据存储。
 *
 * 需求约定（按用户要求）：所有信息以明文保存在 data 目录下的 JSON 文件中，
 * 方便服务器迁移时直接人工查看、拷贝、导出与还原。账号密码同样是明文，
 * 因此该服务只应部署在可信的内网/局域网环境，不要直接暴露到公网。
 */
export class DataStore {
  constructor(options = {}) {
    this.directory = options.directory ?? process.env.DATA_DIR ?? path.join(process.cwd(), "data");
    this.accountsFile = path.join(this.directory, ACCOUNTS_FILE);
    this.savesFile = path.join(this.directory, SAVES_FILE);
    this.serverFile = path.join(this.directory, SERVER_FILE);
    this.backupDirectory = path.join(this.directory, "backups");
    this.flushDelayMs = options.flushDelayMs ?? 120;
    this.maxAutoBackups = options.maxAutoBackups ?? 20;
    this.maxBackupHistory = options.maxBackupHistory ?? 50;
    this.logger = options.logger ?? console;
    this.adminKey = String(options.adminKey ?? process.env.ADMIN_KEY ?? "").trim() || null;
    this.accounts = new Map(); // key: 小写账号名
    this.saves = new Map(); // key: 存档 id
    this.sessions = new Map(); // key: 登录令牌
    this.server = {
      version: STORE_VERSION,
      instanceId: randomId("srv"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      adminKey: this.adminKey,
      history: [],
    };
    this.timers = new Map();
    this.autoBackupTimer = null;
    this.closed = false;
    this.load();
    this.startedAt = new Date().toISOString();
  }

  /* ------------------------------------------------------------------ 读写 */

  load() {
    fs.mkdirSync(this.directory, { recursive: true });
    const accountsPayload = readJsonFile(this.accountsFile, {});
    for (const account of Array.isArray(accountsPayload.accounts) ? accountsPayload.accounts : []) {
      const normalized = this.normalizeAccountRecord(account);
      if (normalized) this.accounts.set(normalized.username.toLowerCase(), normalized);
    }
    for (const session of Array.isArray(accountsPayload.sessions) ? accountsPayload.sessions : []) {
      const token = ensureString(session?.token);
      const accountId = ensureString(session?.accountId);
      if (!token || !accountId) continue;
      this.sessions.set(token, {
        token,
        accountId,
        username: ensureString(session.username),
        createdAt: ensureString(session.createdAt, new Date().toISOString()),
        lastSeenAt: ensureString(session.lastSeenAt, new Date().toISOString()),
        expiresAt: ensureNumber(session.expiresAt, this.defaultSessionExpiry()),
      });
    }

    const savesPayload = readJsonFile(this.savesFile, {});
    for (const save of Array.isArray(savesPayload.saves) ? savesPayload.saves : []) {
      const normalized = this.normalizeSaveRecord(save);
      if (normalized) this.saves.set(normalized.id, normalized);
    }

    const serverPayload = readJsonFile(this.serverFile, {});
    this.server = {
      ...this.server,
      ...(typeof serverPayload === "object" && serverPayload ? serverPayload : {}),
      version: STORE_VERSION,
      history: Array.isArray(serverPayload.history) ? serverPayload.history.slice(0, this.maxBackupHistory) : [],
    };
    // 环境变量 / 显式传入的管理密钥优先级最高；其余情况沿用磁盘上的密钥
    if (this.adminKey) this.server.adminKey = this.adminKey;
    else this.adminKey = this.server.adminKey || null;
    if (!this.server.adminKey) {
      this.server.adminKey = crypto.randomBytes(12).toString("hex");
      this.adminKey = this.server.adminKey;
      this.markDirty("server");
    }
    // 兼容早期版本导入产生过的重复账号 id
    this.repairedAccountIds = this.repairAccountIdCollisions();
    this.accountsDirectoryReady = true;
    return this;
  }

  markDirty(kind) {
    if (this.closed) return;
    if (!this.timers.has(kind)) {
      const timer = setTimeout(() => {
        this.timers.delete(kind);
        this.flushKind(kind);
      }, this.flushDelayMs);
      timer.unref?.();
      this.timers.set(kind, timer);
    }
  }

  flushKind(kind) {
    this.server.updatedAt = new Date().toISOString();
    if (kind === "accounts") {
      writeJsonFile(this.accountsFile, {
        version: STORE_VERSION,
        updatedAt: this.server.updatedAt,
        note: "账号数据以明文保存（含明文密码），请妥善保管该文件",
        accounts: [...this.accounts.values()],
        sessions: [...this.sessions.values()],
      });
      return;
    }
    if (kind === "saves") {
      writeJsonFile(this.savesFile, {
        version: STORE_VERSION,
        updatedAt: this.server.updatedAt,
        note: "无尽模式存档点，明文保存，随服务器迁移一起导出/导入",
        saves: [...this.saves.values()],
      });
      return;
    }
    writeJsonFile(this.serverFile, this.server);
  }

  flush() {
    for (const [kind, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(kind);
    }
    this.flushKind("accounts");
    this.flushKind("saves");
    this.flushKind("server");
  }

  close() {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    this.stopAutoBackup();
  }

  /* -------------------------------------------------------------- 管理密钥 */

  verifyAdminKey(key) {
    const expected = String(this.server.adminKey ?? "");
    const provided = String(key ?? "");
    if (!expected || !provided) return false;
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    if (expectedBuffer.length !== providedBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  }

  /* ------------------------------------------------------------------ 账号 */

  normalizeAccountRecord(account) {
    if (!account || typeof account !== "object") return null;
    const username = ensureString(account.username).trim();
    if (!username) return null;
    return {
      id: ensureString(account.id) || randomId("acct"),
      username,
      displayName: ensureString(account.displayName, username) || username,
      // 明文密码：按需求不做散列，方便迁移与人工导出
      password: ensureString(account.password),
      createdAt: ensureString(account.createdAt, new Date().toISOString()),
      updatedAt: ensureString(account.updatedAt, new Date().toISOString()),
      lastLoginAt: ensureString(account.lastLoginAt, ""),
      stats: {
        games: ensureNumber(account.stats?.games, 0),
        wins: ensureNumber(account.stats?.wins, 0),
        kills: ensureNumber(account.stats?.kills, 0),
        goldEarned: ensureNumber(account.stats?.goldEarned, 0),
        bestWave: ensureNumber(account.stats?.bestWave, 0),
        endlessBestWave: ensureNumber(account.stats?.endlessBestWave, 0),
        playSeconds: ensureNumber(account.stats?.playSeconds, 0),
      },
    };
  }

  normalizeSaveRecord(save) {
    if (!save || typeof save !== "object") return null;
    const id = ensureString(save.id);
    const accountId = ensureString(save.accountId);
    if (!id || !accountId) return null;
    return {
      id,
      accountId,
      username: ensureString(save.username),
      roomName: ensureString(save.roomName),
      mode: ensureString(save.mode, "endless"),
      label: ensureString(save.label, "无尽存档"),
      status: save.status === "finished" ? "finished" : "active",
      createdAt: ensureString(save.createdAt, new Date().toISOString()),
      updatedAt: ensureString(save.updatedAt, new Date().toISOString()),
      finishedAt: ensureString(save.finishedAt, ""),
      wave: Math.max(1, Math.floor(ensureNumber(save.wave, 1))),
      elapsed: Math.max(0, ensureNumber(save.elapsed, 0)),
      outcome: ensureString(save.outcome, ""),
      state: save.state && typeof save.state === "object" ? clone(save.state) : null,
    };
  }

  normalizeUsername(username) {
    return ensureString(username).trim();
  }

  findAccount(username) {
    return this.accounts.get(this.normalizeUsername(username).toLowerCase()) ?? null;
  }

  getAccountById(accountId) {
    const wanted = ensureString(accountId);
    if (!wanted) return null;
    for (const account of this.accounts.values()) {
      if (account.id === wanted) return account;
    }
    return null;
  }

  /** 生成一个当前库中未被占用的账号 id */
  uniqueAccountId(taken = null) {
    const used = taken ?? new Set([...this.accounts.values()].map((account) => account.id));
    let candidate = randomId("acct");
    while (used.has(candidate)) candidate = randomId("acct");
    used.add(candidate);
    return candidate;
  }

  usedAccountIds() {
    return new Set([...this.accounts.values()].map((account) => account.id));
  }

  /**
   * 修复历史数据里重复的账号 id（早期导入逻辑的缺陷可能让两个账号共用一个 id，
   * 导致 getAccountById 命中错误的账号）。重复者改用新的 id，并按用户名把
   * 存档与登录令牌迁移过去；无法确认归属的令牌会被吊销（宁可重新登录）。
   */
  repairAccountIdCollisions() {
    const seen = new Map(); // id -> 第一个持有该 id 的账号
    const taken = new Set();
    const repaired = [];
    for (const account of this.accounts.values()) {
      if (!taken.has(account.id)) {
        taken.add(account.id);
        seen.set(account.id, account);
        continue;
      }
      const previousId = account.id;
      account.id = this.uniqueAccountId(taken);
      repaired.push({ username: account.username, previousId, id: account.id });
    }
    if (repaired.length === 0) return [];

    for (const entry of repaired) {
      const name = entry.username.toLowerCase();
      for (const save of this.saves.values()) {
        if (save.accountId !== entry.previousId) continue;
        // 该 id 原来被两个账号共用，按存档记录的所属用户名判断真正的主人
        const ownerName = ensureString(save.username).toLowerCase();
        if (ownerName === name) {
          save.accountId = entry.id;
          save.username = entry.username;
        } else if (!ownerName) {
          save.username = this.getAccountById(save.accountId)?.username ?? save.username;
        }
      }
      for (const [token, session] of [...this.sessions]) {
        if (session.accountId !== entry.previousId) continue;
        const sessionName = ensureString(session.username).toLowerCase();
        if (sessionName === name) {
          session.accountId = entry.id;
          session.username = entry.username;
        } else if (!sessionName) {
          // 没有用户名可供判断：无法确定这份令牌属于谁，直接吊销
          this.sessions.delete(token);
        }
      }
    }
    this.markDirty("accounts");
    this.markDirty("saves");
    this.logger.warn?.(
      `[store] 检测到重复的账号 id，已修复 ${repaired.length} 个账号：${repaired.map((entry) => entry.username).join("、")}`,
    );
    return repaired;
  }

  registerAccount({ username, password, displayName } = {}) {
    const name = this.normalizeUsername(username);
    if (!USERNAME_PATTERN.test(name)) {
      throw new Error("账号名需为 2-16 位中文、字母、数字、下划线或短横线");
    }
    const secret = String(password ?? "");
    if (secret.length < MIN_PASSWORD_LENGTH || secret.length > MAX_PASSWORD_LENGTH) {
      throw new Error(`密码长度需为 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位`);
    }
    if (this.findAccount(name)) throw new Error("该账号名已被注册");
    const now = new Date().toISOString();
    const account = {
      id: randomId("acct"),
      username: name,
      displayName: this.normalizeUsername(displayName).slice(0, 16) || name,
      password: secret,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
      stats: { games: 0, wins: 0, kills: 0, goldEarned: 0, bestWave: 0, endlessBestWave: 0, playSeconds: 0 },
    };
    this.accounts.set(name.toLowerCase(), account);
    this.markDirty("accounts");
    return account;
  }

  verifyCredentials(username, password) {
    const account = this.findAccount(username);
    if (!account) throw new Error("账号或密码错误");
    const secret = String(password ?? "");
    const expectedBuffer = Buffer.from(account.password);
    const providedBuffer = Buffer.from(secret);
    const matches =
      expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
    if (!matches) throw new Error("账号或密码错误");
    return account;
  }

  setPassword(accountOrId, newPassword) {
    const account = typeof accountOrId === "string" ? this.getAccountById(accountOrId) : accountOrId;
    if (!account) throw new Error("账号不存在");
    const secret = String(newPassword ?? "");
    if (secret.length < MIN_PASSWORD_LENGTH || secret.length > MAX_PASSWORD_LENGTH) {
      throw new Error(`密码长度需为 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位`);
    }
    account.password = secret;
    account.updatedAt = new Date().toISOString();
    this.markDirty("accounts");
    return account;
  }

  setDisplayName(accountOrId, displayName) {
    const account = typeof accountOrId === "string" ? this.getAccountById(accountOrId) : accountOrId;
    if (!account) throw new Error("账号不存在");
    const name = this.normalizeUsername(displayName).slice(0, 16);
    if (!name) throw new Error("显示名不能为空");
    account.displayName = name;
    account.updatedAt = new Date().toISOString();
    this.markDirty("accounts");
    return account;
  }

  deleteAccount(username, password) {
    const account = this.verifyCredentials(username, password);
    this.accounts.delete(account.username.toLowerCase());
    for (const [id, save] of [...this.saves]) {
      if (save.accountId === account.id) this.saves.delete(id);
    }
    for (const [token, session] of [...this.sessions]) {
      if (session.accountId === account.id) this.sessions.delete(token);
    }
    this.markDirty("accounts");
    this.markDirty("saves");
    return account;
  }

  /* ------------------------------------------------------------------ 会话 */

  defaultSessionExpiry() {
    return Date.now() + 1000 * 60 * 60 * 24 * 30;
  }

  createSession(account) {
    const now = new Date().toISOString();
    const session = {
      token: crypto.randomBytes(24).toString("hex"),
      accountId: account.id,
      username: account.username,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: this.defaultSessionExpiry(),
    };
    account.lastLoginAt = now;
    account.updatedAt = now;
    this.sessions.set(session.token, session);
    this.markDirty("accounts");
    return session;
  }

  resolveSession(token) {
    const session = this.sessions.get(String(token ?? ""));
    if (!session) return null;
    if (session.expiresAt && session.expiresAt < Date.now()) {
      this.sessions.delete(session.token);
      this.markDirty("accounts");
      return null;
    }
    const account = this.getAccountById(session.accountId);
    if (!account) {
      this.sessions.delete(session.token);
      this.markDirty("accounts");
      return null;
    }
    // lastSeenAt 每 60 秒落盘一次即可，避免高频校验时反复写文件
    const lastSeen = Date.parse(session.lastSeenAt ?? "") || 0;
    if (Date.now() - lastSeen > 60_000) {
      session.lastSeenAt = new Date().toISOString();
      this.markDirty("accounts");
    }
    return { session, account };
  }

  revokeSession(token) {
    const removed = this.sessions.delete(String(token ?? ""));
    if (removed) this.markDirty("accounts");
    return removed;
  }

  revokeAccountSessions(accountId) {
    let removed = 0;
    for (const [token, session] of [...this.sessions]) {
      if (session.accountId === accountId) {
        this.sessions.delete(token);
        removed += 1;
      }
    }
    if (removed) this.markDirty("accounts");
    return removed;
  }

  /* ------------------------------------------------------------ 账号资料/统计 */

  publicAccount(account) {
    return {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      createdAt: account.createdAt,
      lastLoginAt: account.lastLoginAt,
      stats: clone(account.stats),
    };
  }

  recordMatchResult(accountOrId, result = {}) {
    const account = typeof accountOrId === "string" ? this.getAccountById(accountOrId) : accountOrId;
    if (!account) return null;
    const stats = account.stats;
    stats.games += 1;
    if (result.won) stats.wins += 1;
    stats.kills += Math.max(0, Math.floor(ensureNumber(result.kills, 0)));
    stats.goldEarned += Math.max(0, Math.floor(ensureNumber(result.gold, 0)));
    stats.bestWave = Math.max(stats.bestWave, Math.floor(ensureNumber(result.wave, 0)));
    if (result.endless) {
      stats.endlessBestWave = Math.max(stats.endlessBestWave, Math.floor(ensureNumber(result.wave, 0)));
    }
    stats.playSeconds += Math.max(0, Math.floor(ensureNumber(result.seconds, 0)));
    account.updatedAt = new Date().toISOString();
    this.markDirty("accounts");
    return account;
  }

  /* ------------------------------------------------------------------ 存档 */

  listSaves(accountId, options = {}) {
    const includeFinished = Boolean(options.includeFinished);
    return [...this.saves.values()]
      .filter((save) => save.accountId === accountId && (includeFinished || save.status === "active"))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  getSave(saveId) {
    return this.saves.get(String(saveId ?? "")) ?? null;
  }

  defaultSaveLabel(mode, wave) {
    return `${mode === "endless" ? "无尽" : "进度"} · 第 ${Math.max(1, Math.floor(ensureNumber(wave, 1)))} 波`;
  }

  createSave({ accountId, username = "", mode = "endless", roomName = "", label, state } = {}) {
    const account = this.getAccountById(accountId);
    if (!account) throw new Error("账号不存在，无法创建存档");
    const now = new Date().toISOString();
    const wave = Math.max(1, Math.floor(ensureNumber(state?.wave, 1)));
    const save = {
      id: randomId("save"),
      accountId: account.id,
      username: account.username,
      roomName: String(roomName ?? "").slice(0, 24),
      mode,
      label: String(label ?? this.defaultSaveLabel(mode, wave)).slice(0, 40),
      status: "active",
      createdAt: now,
      updatedAt: now,
      finishedAt: "",
      wave,
      elapsed: Math.max(0, ensureNumber(state?.elapsed, 0)),
      outcome: "",
      state: clone(state ?? null),
    };
    this.saves.set(save.id, save);
    this.markDirty("saves");
    return save;
  }

  /** 清理孤立的存档（归属账号已不存在） */
  pruneOrphanSaves() {
    let removed = 0;
    for (const [id, save] of [...this.saves]) {
      if (!this.getAccountById(save.accountId)) {
        this.saves.delete(id);
        removed += 1;
      }
    }
    if (removed) this.markDirty("saves");
    return removed;
  }

  updateSave(saveId, { state, label, roomName } = {}) {
    const save = this.getSave(saveId);
    if (!save) throw new Error("存档不存在");
    if (state) {
      save.state = clone(state);
      save.wave = Math.max(1, Math.floor(ensureNumber(state.wave, save.wave)));
      save.elapsed = Math.max(0, ensureNumber(state.elapsed, save.elapsed));
      if (label == null) save.label = this.defaultSaveLabel(save.mode, save.wave);
    }
    if (label != null) save.label = String(label).slice(0, 40);
    if (roomName != null) save.roomName = String(roomName).slice(0, 24);
    save.updatedAt = new Date().toISOString();
    this.markDirty("saves");
    return save;
  }

  finishSave(saveId, { outcome = "", wave } = {}) {
    const save = this.getSave(saveId);
    if (!save) return null;
    save.status = "finished";
    save.outcome = String(outcome).slice(0, 120);
    save.finishedAt = new Date().toISOString();
    save.updatedAt = save.finishedAt;
    if (Number.isFinite(wave)) save.wave = Math.max(save.wave, Math.floor(wave));
    this.markDirty("saves");
    return save;
  }

  deleteSave(saveId, accountId = null) {
    const save = this.getSave(saveId);
    if (!save) return false;
    if (accountId && save.accountId !== accountId) throw new Error("无法删除他人的存档");
    this.saves.delete(save.id);
    this.markDirty("saves");
    return true;
  }

  saveSummary(save) {
    return {
      id: save.id,
      label: save.label,
      mode: save.mode,
      status: save.status,
      wave: save.wave,
      elapsed: save.elapsed,
      roomName: save.roomName,
      createdAt: save.createdAt,
      updatedAt: save.updatedAt,
      finishedAt: save.finishedAt,
      outcome: save.outcome,
      players: Array.isArray(save.state?.players)
        ? save.state.players.map((player) => ({
            name: ensureString(player.name, "玩家"),
            username: ensureString(player.username),
            classId: ensureString(player.classId),
            level: Math.max(1, Math.floor(ensureNumber(player.level, 1))),
          }))
        : [],
    };
  }

  /* -------------------------------------------------------------- 备份/还原 */

  exportBackup(options = {}) {
    const now = new Date().toISOString();
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: now,
      exportedBy: options.exportedBy ?? "lan-battle-server",
      note: "该备份文件中的所有信息（包含明文密码）均未加密，请按机密文件保管",
      server: {
        instanceId: this.server.instanceId,
        createdAt: this.server.createdAt,
        version: STORE_VERSION,
        adminKey: this.server.adminKey,
      },
      counts: { accounts: this.accounts.size, saves: this.saves.size, sessions: this.sessions.size },
      accounts: [...this.accounts.values()].map((account) => clone(account)),
      sessions: [...this.sessions.values()].map((session) => clone(session)),
      saves: [...this.saves.values()].map((save) => clone(save)),
    };
  }

  validateBackup(payload) {
    if (!payload || typeof payload !== "object") throw new Error("备份内容不是有效的 JSON 对象");
    const hasAccounts = Array.isArray(payload.accounts);
    const hasSaves = Array.isArray(payload.saves);
    if (!hasAccounts && !hasSaves) throw new Error("备份内容缺少 accounts / saves 字段");
    if (payload.format && payload.format !== BACKUP_FORMAT) {
      throw new Error(`备份格式不匹配：${payload.format}`);
    }
    if (payload.version && Number(payload.version) > BACKUP_VERSION) {
      throw new Error(`备份版本 ${payload.version} 高于当前服务端支持的版本 ${BACKUP_VERSION}`);
    }
    return { hasAccounts, hasSaves };
  }

  importBackup(payload, options = {}) {
    const { hasAccounts, hasSaves } = this.validateBackup(payload);
    const mode = options.mode === "merge" ? "merge" : "replace";
    const report = {
      mode,
      importedAt: new Date().toISOString(),
      accounts: { added: 0, updated: 0, skipped: 0, reassigned: 0, repaired: 0 },
      saves: { added: 0, updated: 0, skipped: 0, removed: 0, orphaned: 0 },
      sessions: { imported: 0, skipped: 0 },
      adminKeyPreserved: true,
      preImportBackup: null,
    };
    if (options.preImportBackup !== false) {
      const file = this.createBackupFile({ label: "pre-import" });
      report.preImportBackup = file;
    }
    if (mode === "replace") {
      if (hasAccounts) {
        this.accounts.clear();
        this.sessions.clear();
      }
      if (hasSaves) {
        report.saves.removed = this.saves.size;
        this.saves.clear();
      }
    }

    // 同一账号在两台服务器上的 id 可能不同：合并时保留本机 id，
    // 并记录「备份 id -> 本机 id」的映射，用于重写存档与令牌的归属，
    // 否则导入的存档会因为 accountId 对不上而对账号不可见。
    //
    // 安全性：来源 id 可能与「本机另一个用户名」的 id 相同（手工构造或跨服务器巧合）。
    // 此时必须给新账号换一个本机唯一 id，否则两个账号共用一个 id，
    // getAccountById 会命中错误的账号，导致存档串号甚至令牌登录成别人。
    const idMap = new Map(); // 来源 id -> 本机 id
    const usedIds = this.usedAccountIds(); // 本机已占用的 id
    const ambiguousIds = new Set(); // 备份中指向多个用户名、无法安全归属的来源 id

    for (const raw of hasAccounts ? payload.accounts : []) {
      const account = this.normalizeAccountRecord(raw);
      if (!account) {
        report.accounts.skipped += 1;
        continue;
      }
      const sourceId = account.id;
      const mapped = idMap.has(sourceId) ? idMap.get(sourceId) : null;
      const key = account.username.toLowerCase();
      const existing = this.accounts.get(key);
      if (existing) {
        if (mapped && mapped !== existing.id) ambiguousIds.add(sourceId);
        idMap.set(sourceId, existing.id);
        existing.displayName = account.displayName || existing.displayName;
        existing.password = account.password || existing.password;
        existing.stats = { ...existing.stats, ...account.stats };
        existing.updatedAt = new Date().toISOString();
        this.accounts.set(key, existing);
        report.accounts.updated += 1;
        continue;
      }

      // 新账号：来源 id 已被其它账号占用（本机已有，或本次导入已分配）时改用新的本机 id
      const takenBy = usedIds.has(sourceId) ? this.getAccountById(sourceId) : null;
      const conflict = Boolean(takenBy) || (mapped !== null && mapped !== sourceId);
      if (conflict) {
        // 同一个来源 id 指向多个用户名：标记为有歧义，后续只按用户名归属，不再猜 id
        ambiguousIds.add(sourceId);
        account.id = this.uniqueAccountId(usedIds);
        report.accounts.reassigned += 1;
      } else {
        usedIds.add(account.id);
      }
      if (!idMap.has(sourceId)) idMap.set(sourceId, account.id);
      this.accounts.set(key, account);
      report.accounts.added += 1;
    }

    for (const raw of hasSaves ? payload.saves : []) {
      const save = this.normalizeSaveRecord(raw);
      if (!save) {
        report.saves.skipped += 1;
        continue;
      }
      save.accountId = idMap.get(save.accountId) ?? save.accountId;
      // 存档内保存的玩家归属同样要重映射：解析不出主人的一律置空，
      // 避免残留的来源 id 在以后被同 id 的账号误认领（续玩时仍可按用户名匹配）。
      if (Array.isArray(save.state?.players)) {
        for (const savedPlayer of save.state.players) {
          if (!savedPlayer) continue;
          const current = ensureString(savedPlayer.accountId);
          if (!current) continue;
          savedPlayer.accountId = this.resolveImportedAccountId(current, savedPlayer.username, { idMap, ambiguousIds });
        }
      }
      // 归属判断：重映射表 -> 所属用户名 -> 本机同 id 账号（需用户名一致）
      const owner = this.resolveImportedAccount(save.accountId, save.username, { idMap, ambiguousIds });
      if (!owner) {
        // 没有对应账号的存档无法被任何账号使用，直接丢弃并统计
        report.saves.orphaned += 1;
        continue;
      }
      save.accountId = owner.id;
      save.username = owner.username;
      const existing = this.saves.get(save.id);
      this.saves.set(save.id, save);
      if (existing) report.saves.updated += 1;
      else report.saves.added += 1;
    }

    if (hasAccounts && Array.isArray(payload.sessions)) {
      for (const raw of payload.sessions) {
        const token = ensureString(raw?.token);
        const sourceId = ensureString(raw.accountId);
        // 来源 id 有歧义时按用户名回退；仍无法确定就吊销，避免令牌登录成别的账号
        const account = this.resolveImportedAccount(sourceId, raw?.username, { idMap, ambiguousIds });
        if (!token || !account) {
          report.sessions.skipped += 1;
          continue;
        }
        this.sessions.set(token, {
          token,
          accountId: account.id,
          username: account.username,
          createdAt: ensureString(raw.createdAt, new Date().toISOString()),
          lastSeenAt: new Date().toISOString(),
          expiresAt: ensureNumber(raw.expiresAt, this.defaultSessionExpiry()),
        });
        report.sessions.imported += 1;
      }
    }

    // 兜底：确认账号 id 唯一（正常导入不会产生重复，这里防的是历史脏数据）
    report.accounts.repaired = this.repairAccountIdCollisions().length;

    // 导入后清掉没有归属账号的旧存档，避免留下任何账号都读不到的记录
    // （例如只包含 accounts 的覆盖还原会把旧存档全部变成孤立数据）
    report.saves.orphaned += this.pruneOrphanSaves();

    // 管理密钥始终沿用本机现有密钥，避免一份泄露的备份文件直接接管服务器
    if (payload.server?.adminKey && payload.server.adminKey !== this.server.adminKey) {
      report.adminKeyPreserved = true;
      report.adminKeyFromBackup = payload.server.adminKey;
    }
    if (payload.server?.createdAt && !this.server.migratedFromInstanceId) {
      this.server.migratedFromInstanceId = ensureString(payload.server.instanceId);
      this.server.migratedAt = new Date().toISOString();
      report.migratedFromInstanceId = this.server.migratedFromInstanceId || null;
    }
    this.markDirty("accounts");
    this.markDirty("saves");
    this.markDirty("server");
    this.pushHistory({ type: "import", at: report.importedAt, mode, report: this.summarizeReport(report) });
    return report;
  }

  /**
   * 把备份中的来源账号 id 解析为本机账号。
   *
   * 关键约束：只要备份里记录了用户名，解析结果就必须与它一致（否则返回 null 表示「无法确定」）。
   * 备份内容本身不可信，映射表与 id 只能当作线索，绝不能让某条记录挂到用户名不同的账号上。
   */
  resolveImportedAccount(sourceId, username, { idMap = new Map(), ambiguousIds = new Set() } = {}) {
    const id = ensureString(sourceId);
    const name = ensureString(username).trim().toLowerCase();
    const matches = (account) => Boolean(account) && (!name || account.username.toLowerCase() === name);
    const ambiguous = id ? ambiguousIds.has(id) : false;

    if (id && !ambiguous) {
      const mapped = this.getAccountById(idMap.get(id));
      if (matches(mapped)) return mapped;
      const direct = this.getAccountById(id);
      if (matches(direct)) return direct;
    }
    if (name) {
      const byName = this.findAccount(name);
      if (byName) return byName;
    }
    return null;
  }

  resolveImportedAccountId(sourceId, username, context) {
    return this.resolveImportedAccount(sourceId, username, context)?.id ?? null;
  }

  summarizeReport(report) {
    return {
      mode: report.mode,
      accounts: report.accounts,
      saves: report.saves,
      sessions: report.sessions,
      preImportBackup: report.preImportBackup,
    };
  }

  pushHistory(entry) {
    this.server.history = [entry, ...(Array.isArray(this.server.history) ? this.server.history : [])].slice(
      0,
      this.maxBackupHistory,
    );
    this.markDirty("server");
  }

  createBackupFile({ label = "manual" } = {}) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = String(label).replace(/[^\w-]/g, "").slice(0, 20) || "backup";
    const fileName = `${stamp}-${safeLabel}.json`;
    const file = path.join(this.backupDirectory, fileName);
    writeJsonFile(file, this.exportBackup({ exportedBy: `auto:${safeLabel}` }));
    this.server.lastBackupAt = new Date().toISOString();
    this.server.lastBackupFile = fileName;
    this.markDirty("server");
    this.pushHistory({ type: "backup", at: this.server.lastBackupAt, file: fileName, label: safeLabel });
    this.pruneBackups();
    return fileName;
  }

  listBackupFiles() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.backupDirectory);
    } catch {
      return [];
    }
    return entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const file = path.join(this.backupDirectory, name);
        let size = 0;
        let createdAt = null;
        try {
          const stats = fs.statSync(file);
          size = stats.size;
          createdAt = stats.mtime.toISOString();
        } catch {
          /* 忽略无法读取的文件 */
        }
        return { file: name, size, createdAt };
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  readBackupFile(fileName) {
    const safeName = path.basename(String(fileName ?? ""));
    if (!safeName.endsWith(".json")) throw new Error("备份文件名无效");
    const file = path.join(this.backupDirectory, safeName);
    if (!fs.existsSync(file)) throw new Error("备份文件不存在");
    return { fileName: safeName, payload: JSON.parse(fs.readFileSync(file, "utf8")) };
  }

  restoreBackupFile(fileName, options = {}) {
    const { fileName: safeName, payload } = this.readBackupFile(fileName);
    const report = this.importBackup(payload, options);
    this.pushHistory({ type: "restore", at: new Date().toISOString(), file: safeName });
    return { fileName: safeName, report };
  }

  pruneBackups() {
    const files = this.listBackupFiles();
    const preImport = files.filter((entry) => entry.file.includes("pre-import"));
    const others = files.filter((entry) => !entry.file.includes("pre-import"));
    const removable = others.slice(Math.max(this.maxAutoBackups, 0));
    const keepPreImport = preImport.slice(5);
    for (const entry of [...removable, ...keepPreImport]) {
      try {
        fs.unlinkSync(path.join(this.backupDirectory, entry.file));
      } catch {
        /* 忽略删除失败 */
      }
    }
    return removable.length + keepPreImport.length;
  }

  startAutoBackup(intervalMinutes = Number(process.env.AUTO_BACKUP_MINUTES ?? 30)) {
    this.stopAutoBackup();
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return null;
    const intervalMs = Math.max(1, intervalMinutes) * 60_000;
    this.autoBackupTimer = setInterval(() => {
      try {
        this.flush();
        this.createBackupFile({ label: "auto" });
      } catch (error) {
        this.logger.warn?.(`自动备份失败：${error.message}`);
      }
    }, intervalMs);
    this.autoBackupTimer.unref?.();
    return this.autoBackupTimer;
  }

  stopAutoBackup() {
    if (this.autoBackupTimer) clearInterval(this.autoBackupTimer);
    this.autoBackupTimer = null;
  }

  /* ------------------------------------------------------------------ 概览 */

  diskUsage() {
    const files = [];
    for (const [name, file] of [
      [ACCOUNTS_FILE, this.accountsFile],
      [SAVES_FILE, this.savesFile],
      [SERVER_FILE, this.serverFile],
    ]) {
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
      }
      files.push({ file: name, size });
    }
    for (const backup of this.listBackupFiles()) {
      files.push({ file: `backups/${backup.file}`, size: backup.size });
    }
    return files;
  }

  stats() {
    return {
      directory: path.resolve(this.directory),
      adminKey: this.server.adminKey,
      accounts: this.accounts.size,
      saves: this.saves.size,
      activeSaves: [...this.saves.values()].filter((save) => save.status === "active").length,
      sessions: this.sessions.size,
      server: {
        instanceId: this.server.instanceId,
        createdAt: this.server.createdAt,
        updatedAt: this.server.updatedAt,
        lastBackupAt: this.server.lastBackupAt ?? null,
        lastBackupFile: this.server.lastBackupFile ?? null,
        migratedFromInstanceId: this.server.migratedFromInstanceId ?? null,
        migratedAt: this.server.migratedAt ?? null,
      },
      history: clone(this.server.history ?? []),
      files: this.diskUsage(),
    };
  }
}
