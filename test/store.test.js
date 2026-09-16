import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DataStore } from "../src/store.js";

function createStore(options = {}) {
  const directory = options.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "lan-battle-store-"));
  const store = new DataStore({ directory, adminKey: options.adminKey ?? "admin-key-for-test", ...options });
  return { store, directory };
}

function fakeSaveState(wave = 3) {
  return {
    version: 1,
    mode: "endless",
    wave,
    phase: "peace",
    elapsed: wave * 30,
    map: { width: 4200, height: 760, groundY: 660, platforms: [], decorations: [] },
    players: [
      {
        accountId: "acct-1",
        username: "alice",
        name: "爱丽丝",
        classId: "assault",
        level: 4,
        weapons: [{ id: "shotgun", level: 2 }],
        items: [{ id: "vitality", count: 1 }],
        upgrades: { power: 2 },
        stats: { maxHp: 150, damage: 30 },
      },
    ],
  };
}

test("账号以明文保存，并可用同样的明文密码登录", () => {
  const { store, directory } = createStore();
  const account = store.registerAccount({ username: "Alice", password: "pass1234", displayName: "爱丽丝" });

  assert.equal(account.username, "Alice");
  assert.equal(account.displayName, "爱丽丝");
  assert.equal(account.password, "pass1234");

  store.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(directory, "accounts.json"), "utf8"));
  assert.equal(raw.accounts.length, 1);
  // 明文存储：文件中可以直接读到密码
  assert.equal(raw.accounts[0].password, "pass1234");
  assert.match(raw.note, /明文/);

  assert.equal(store.verifyCredentials("alice", "pass1234").id, account.id);
  assert.throws(() => store.verifyCredentials("alice", "wrong"), /账号或密码错误/);
  assert.throws(() => store.registerAccount({ username: "ALICE", password: "pass1234" }), /已被注册/);
  assert.throws(() => store.registerAccount({ username: "bob", password: "12" }), /密码长度/);
  store.close();
});

test("登录令牌可以续期，退出后失效", () => {
  const { store } = createStore();
  const account = store.registerAccount({ username: "bob", password: "pass1234" });
  const session = store.createSession(account);

  const resolved = store.resolveSession(session.token);
  assert.equal(resolved.account.id, account.id);

  store.revokeSession(session.token);
  assert.equal(store.resolveSession(session.token), null);
  assert.throws(() => store.verifyCredentials("bob", "nope"), /账号或密码错误/);
  store.close();
});

test("账号统计会在对局结算时累计", () => {
  const { store } = createStore();
  const account = store.registerAccount({ username: "carol", password: "pass1234" });
  store.recordMatchResult(account, { won: true, kills: 12, gold: 88, wave: 7, seconds: 300, endless: true });
  store.recordMatchResult(account, { won: false, kills: 3, gold: 10, wave: 9, seconds: 120, endless: true });

  const stats = store.getAccountById(account.id).stats;
  assert.equal(stats.games, 2);
  assert.equal(stats.wins, 1);
  assert.equal(stats.kills, 15);
  assert.equal(stats.bestWave, 9);
  assert.equal(stats.endlessBestWave, 9);
  assert.equal(stats.playSeconds, 420);
  store.close();
});

test("存档可以创建、更新、封存与删除，并校验归属", () => {
  const { store } = createStore();
  const alice = store.registerAccount({ username: "alice", password: "pass1234" });
  const bob = store.registerAccount({ username: "bob", password: "pass1234" });

  const save = store.createSave({ accountId: alice.id, username: alice.username, state: fakeSaveState(2) });
  assert.equal(save.status, "active");
  assert.equal(save.wave, 2);
  assert.match(save.label, /第 2 波/);

  store.updateSave(save.id, { state: fakeSaveState(5) });
  assert.equal(store.getSave(save.id).wave, 5);
  assert.equal(store.listSaves(alice.id).length, 1);
  assert.equal(store.listSaves(bob.id).length, 0);
  assert.throws(() => store.deleteSave(save.id, bob.id), /他人的存档/);

  store.finishSave(save.id, { outcome: "无尽挑战结束", wave: 8 });
  assert.equal(store.getSave(save.id).status, "finished");
  assert.equal(store.listSaves(alice.id).length, 0);
  assert.equal(store.listSaves(alice.id, { includeFinished: true }).length, 1);

  assert.equal(store.deleteSave(save.id, alice.id), true);
  assert.equal(store.getSave(save.id), null);
  store.close();
});

test("导出备份包含明文账号与存档，且可以导入到新的服务器", () => {
  const { store, directory } = createStore();
  const alice = store.registerAccount({ username: "alice", password: "pass1234", displayName: "爱丽丝" });
  const save = store.createSave({ accountId: alice.id, username: alice.username, state: fakeSaveState(4) });
  const backup = store.exportBackup();
  store.close();

  assert.equal(backup.format, "lan-battle-backup");
  assert.equal(backup.counts.accounts, 1);
  assert.equal(backup.counts.saves, 1);
  assert.equal(backup.accounts[0].password, "pass1234");

  // 模拟换服务器：新的数据目录 + 新的管理密钥
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "lan-battle-store-new-"));
  const fresh = new DataStore({ directory: target, adminKey: "new-server-key" });
  const report = fresh.importBackup(backup);

  assert.equal(report.accounts.added, 1);
  assert.equal(report.saves.added, 1);
  assert.equal(fresh.accounts.size, 1);
  assert.equal(fresh.getSave(save.id).state.wave, 4);
  assert.equal(fresh.verifyCredentials("alice", "pass1234").displayName, "爱丽丝");
  // 管理密钥沿用新服务器自己的密钥，备份里的密钥不会直接接管服务器
  assert.equal(fresh.stats().adminKey, "new-server-key");
  // 导入前的数据会被自动快照
  assert.ok(report.preImportBackup);
  assert.ok(fresh.listBackupFiles().some((entry) => entry.file === report.preImportBackup));
  assert.ok(fs.existsSync(path.join(directory, "saves.json")));
  fresh.close();
});

test("导入时会拒绝无效的备份内容", () => {
  const { store } = createStore();
  assert.throws(() => store.importBackup(null), /有效的 JSON/);
  assert.throws(() => store.importBackup({ format: "other", accounts: [] }), /格式不匹配/);
  assert.throws(() => store.importBackup({ accounts: [], version: 99 }), /高于当前服务端/);
  store.close();
});

test("合并导入不会清除已有账号，覆盖导入会替换", () => {
  const { store } = createStore();
  store.registerAccount({ username: "keep", password: "pass1234" });
  const backup = {
    format: "lan-battle-backup",
    version: 1,
    accounts: [{ username: "keep", password: "changed", displayName: "改名", stats: { kills: 5 } }, { username: "newbie", password: "pass1234" }],
    saves: [],
    server: { adminKey: "other-key" },
  };

  const mergeReport = store.importBackup(backup, { mode: "merge" });
  assert.equal(mergeReport.accounts.added, 1);
  assert.equal(mergeReport.accounts.updated, 1);
  assert.equal(store.accounts.size, 2);
  assert.equal(store.verifyCredentials("keep", "changed").displayName, "改名");
  assert.equal(store.findAccount("keep").stats.kills, 5);

  const replaceReport = store.importBackup({ format: "lan-battle-backup", version: 1, accounts: [backup.accounts[1]], saves: [] }, { mode: "replace" });
  assert.equal(replaceReport.accounts.added, 1);
  assert.equal(store.accounts.size, 1);
  assert.equal(store.findAccount("newbie").username, "newbie");
  store.close();
});

test("本地快照可以创建、列出并还原", () => {
  const { store } = createStore();
  const account = store.registerAccount({ username: "dave", password: "pass1234" });
  const fileName = store.createBackupFile({ label: "test" });
  assert.ok(fileName.endsWith("-test.json"));
  assert.ok(store.listBackupFiles().some((entry) => entry.file === fileName));

  store.deleteAccount("dave", "pass1234");
  assert.equal(store.accounts.size, 0);

  const { report } = store.restoreBackupFile(fileName, { mode: "replace" });
  assert.equal(report.accounts.added, 1);
  assert.equal(store.findAccount("dave").id, account.id);
  store.close();
});

test("数据落盘后可以被重新加载（服务器重启不丢数据）", () => {
  const { store, directory } = createStore();
  const account = store.registerAccount({ username: "erin", password: "pass1234" });
  const session = store.createSession(account);
  store.createSave({ accountId: account.id, username: account.username, state: fakeSaveState(6) });
  store.close();

  const reopened = new DataStore({ directory, adminKey: "admin-key-for-test" });
  assert.equal(reopened.accounts.size, 1);
  assert.equal(reopened.verifyCredentials("erin", "pass1234").id, account.id);
  assert.equal(reopened.saves.size, 1);
  assert.ok(reopened.resolveSession(session.token));
  reopened.close();
});

test("管理密钥校验使用恒定时间比较", () => {
  const { store } = createStore();
  assert.equal(store.verifyAdminKey("admin-key-for-test"), true);
  assert.equal(store.verifyAdminKey("admin-key-for-tes"), false);
  assert.equal(store.verifyAdminKey(""), false);
  assert.equal(store.verifyAdminKey(undefined), false);
  store.close();
});

test("【回归】合并导入会重映射账号 id，存档不会变成孤儿", () => {
  const { store } = createStore();
  // 本机已有同名账号，但 id 与备份来源不同（换服务器场景）
  const local = store.registerAccount({ username: "alice", password: "oldpass1" });
  const backup = {
    format: "lan-battle-backup",
    version: 1,
    accounts: [{ id: "acct_from_other_server", username: "alice", displayName: "爱丽丝", password: "pass1234", stats: { kills: 3 } }],
    saves: [
      {
        id: "save-migrated",
        accountId: "acct_from_other_server",
        username: "alice",
        mode: "endless",
        label: "无尽 · 第 9 波",
        status: "active",
        wave: 9,
        state: { wave: 9, players: [{ accountId: "acct_from_other_server", name: "爱丽丝", stats: {} }] },
      },
    ],
    sessions: [{ token: "migrated-token", accountId: "acct_from_other_server", username: "alice" }],
  };

  const report = store.importBackup(backup, { mode: "merge" });
  assert.equal(report.accounts.updated, 1);
  assert.equal(report.saves.added, 1);
  assert.equal(report.saves.orphaned, 0);

  const save = store.getSave("save-migrated");
  assert.equal(save.accountId, local.id, "存档归属应重映射到本机账号 id");
  assert.equal(store.listSaves(local.id).length, 1, "本机账号必须能看到导入的存档");
  assert.equal(save.state.players[0].accountId, local.id, "存档内的玩家归属同样要重映射");
  assert.equal(store.resolveSession("migrated-token").account.id, local.id, "登录令牌也要指向本机账号");
  store.close();
});

test("【回归】只含 accounts 的覆盖还原不会留下无法访问的旧存档", () => {
  // 备份里带不带 saves 字段都必须清干净，否则旧存档会变成任何账号都读不到的垃圾数据
  for (const payload of [
    { format: "lan-battle-backup", version: 1, accounts: [{ username: "newbie", password: "pass1234" }] },
    { format: "lan-battle-backup", version: 1, accounts: [{ username: "newbie", password: "pass1234" }], saves: [] },
  ]) {
    const { store } = createStore();
    const alice = store.registerAccount({ username: "alice", password: "pass1234" });
    store.createSave({ accountId: alice.id, username: alice.username, state: fakeSaveState(3) });
    assert.equal(store.saves.size, 1);

    const report = store.importBackup(payload, { mode: "replace" });
    assert.equal(report.accounts.added, 1);
    assert.equal(store.saves.size, 0, "不应留下任何账号都读不到的存档");
    assert.equal(store.pruneOrphanSaves(), 0, "导入后不应还存在孤立存档");
    const accounted = report.saves.added + report.saves.updated + report.saves.orphaned + (report.saves.removed ?? 0);
    assert.equal(accounted, 1, "被清理的旧存档应出现在报告里");
    store.close();
  }
});

test("【回归】未包含账号的存档导入会按账号名匹配已有账号", () => {
  const { store } = createStore();
  const local = store.registerAccount({ username: "bob", password: "pass1234" });
  const report = store.importBackup({
    format: "lan-battle-backup",
    version: 1,
    saves: [{ id: "save-only", accountId: "acct_unknown", username: "bob", status: "active", wave: 4, state: { wave: 4, players: [] } }],
  });

  assert.equal(report.saves.added, 1);
  assert.equal(report.saves.orphaned, 0);
  assert.equal(store.getSave("save-only").accountId, local.id);
  assert.equal(store.listSaves(local.id).length, 1);
  store.close();
});

test("【回归】导出再导入到全新服务器后，存档仍属于同一个账号", () => {
  const { store } = createStore();
  const alice = store.registerAccount({ username: "alice", password: "pass1234" });
  store.createSave({ accountId: alice.id, username: alice.username, state: fakeSaveState(7) });
  const backup = store.exportBackup();
  store.close();

  const target = fs.mkdtempSync(path.join(os.tmpdir(), "lan-battle-store-move-"));
  const fresh = new DataStore({ directory: target, adminKey: "fresh-key" });
  fresh.importBackup(backup, { mode: "replace" });
  const moved = fresh.listSaves(fresh.findAccount("alice").id);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].wave, 7);
  fresh.close();
});

test("【回归】合并导入时来源 id 撞上其它用户名，会重新分配 id 且不会串号", () => {
  const { store } = createStore();
  const alice = store.registerAccount({ username: "alice", password: "alicepass", displayName: "爱丽丝" });
  store.createSave({ accountId: alice.id, username: alice.username, state: fakeSaveState(9) });

  // 手工构造的备份：bob 带来的来源 id 与本机 alice 相同
  const report = store.importBackup({
    format: "lan-battle-backup",
    version: 1,
    accounts: [{ id: alice.id, username: "bob", displayName: "鲍勃", password: "bobpass1" }],
    saves: [{ id: "save-bob", accountId: alice.id, username: "bob", status: "active", wave: 4, state: { wave: 4, players: [] } }],
    sessions: [{ token: "bob-token", accountId: alice.id, username: "bob" }],
  }, { mode: "merge" });

  const bob = store.findAccount("bob");
  assert.notEqual(bob.id, alice.id, "两个账号不能共用同一个 id");
  assert.equal(report.accounts.reassigned, 1);
  assert.equal(store.getAccountById(alice.id).username, "alice", "alice 不能被顶替");
  assert.equal(store.getAccountById(bob.id).username, "bob");

  // 关键：bob 的令牌必须登录成 bob，绝不能变成 alice
  assert.equal(store.resolveSession("bob-token").account.username, "bob");
  assert.equal(store.verifyCredentials("bob", "bobpass1").id, bob.id);
  assert.equal(store.verifyCredentials("alice", "alicepass").id, alice.id);

  // 存档归属互不污染
  assert.deepEqual(store.listSaves(bob.id).map((save) => save.username), ["bob"]);
  assert.deepEqual(store.listSaves(alice.id).map((save) => save.username), ["alice"]);
  store.close();
});

test("【回归】备份内两个账号共用同一 id 时，各自获得唯一 id 且按用户名归属", () => {
  const { store } = createStore();
  const report = store.importBackup({
    format: "lan-battle-backup",
    version: 1,
    accounts: [
      { id: "dup-id", username: "a", password: "pass1234" },
      { id: "dup-id", username: "b", password: "pass1234" },
    ],
    saves: [
      { id: "save-a", accountId: "dup-id", username: "a", status: "active", wave: 3, state: { wave: 3, players: [] } },
      { id: "save-b", accountId: "dup-id", username: "b", status: "active", wave: 7, state: { wave: 7, players: [] } },
      // 没有所属用户名的存档无法确定主人，只能丢弃
      { id: "save-unknown", accountId: "dup-id", status: "active", wave: 1, state: { wave: 1, players: [] } },
    ],
    sessions: [
      { token: "token-a", accountId: "dup-id", username: "a" },
      { token: "token-unknown", accountId: "dup-id" },
    ],
  }, { mode: "merge" });

  const a = store.findAccount("a");
  const b = store.findAccount("b");
  assert.notEqual(a.id, b.id);
  assert.equal(report.accounts.reassigned, 1);
  assert.deepEqual(store.listSaves(a.id).map((save) => save.id), ["save-a"]);
  assert.deepEqual(store.listSaves(b.id).map((save) => save.id), ["save-b"]);
  assert.equal(store.getSave("save-unknown"), null, "无法确定归属的存档应被丢弃");
  assert.equal(report.saves.orphaned, 1);
  // 有用户名的令牌按用户名恢复，没有用户名的令牌被吊销（sessions.skipped）
  assert.equal(store.resolveSession("token-a").account.username, "a");
  assert.equal(store.resolveSession("token-unknown"), null);
  assert.equal(report.sessions.imported, 1);
  assert.equal(report.sessions.skipped, 1);
  store.close();
});

test("【回归】存档内玩家的 accountId 只按用户名归属，不会挂到同 id 的其它账号", () => {
  const { store } = createStore();
  const alice = store.registerAccount({ username: "alice", password: "alicepass" });

  const state = fakeSaveState(5);
  state.players = [
    // 用户名与本机 alice 一致：可以确定为 alice 本人
    { accountId: alice.id, username: "alice", name: "爱丽丝", stats: {} },
    // 借用 alice 的 id 但用户名不同：必须判定为无法确定，不能挂到 alice 名下
    { accountId: alice.id, username: "mallory", name: "冒充者", stats: {} },
    { accountId: "acct_ghost", username: "ghost", name: "幽灵", stats: {} },
  ];
  store.importBackup({
    format: "lan-battle-backup",
    version: 1,
    accounts: [{ id: alice.id, username: "bob", password: "bobpass1" }],
    saves: [{ id: "save-team", accountId: alice.id, username: "bob", status: "active", wave: 5, state }],
  }, { mode: "merge" });

  const save = store.getSave("save-team");
  const bob = store.findAccount("bob");
  assert.equal(save.accountId, bob.id, "存档归 bob");
  assert.equal(save.state.players[0].accountId, alice.id, "用户名一致时归属 alice");
  assert.equal(save.state.players[1].accountId, null, "用户名不一致时置空，不能挂到 alice");
  assert.equal(save.state.players[2].accountId, null, "查不到的账号置空");
  store.close();
});

test("【回归】加载历史脏数据时自动修复重复账号 id 并迁移存档与令牌", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lan-battle-store-dirty-"));
  const now = new Date().toISOString();
  // 模拟早期缺陷导入留下的数据：alice 与 bob 共用同一个 id
  fs.writeFileSync(path.join(directory, "accounts.json"), JSON.stringify({
    version: 1,
    accounts: [
      { id: "shared", username: "alice", displayName: "爱丽丝", password: "alicepass", stats: {} },
      { id: "shared", username: "bob", displayName: "鲍勃", password: "bobpass1", stats: {} },
    ],
    sessions: [
      { token: "token-alice", accountId: "shared", username: "alice", createdAt: now, expiresAt: Date.now() + 1e6 },
      { token: "token-bob", accountId: "shared", username: "bob", createdAt: now, expiresAt: Date.now() + 1e6 },
      { token: "token-anon", accountId: "shared", createdAt: now, expiresAt: Date.now() + 1e6 },
    ],
  }), "utf8");
  fs.writeFileSync(path.join(directory, "saves.json"), JSON.stringify({
    version: 1,
    saves: [
      { id: "save-alice", accountId: "shared", username: "alice", status: "active", wave: 2, state: { wave: 2, players: [] } },
      { id: "save-bob", accountId: "shared", username: "bob", status: "active", wave: 6, state: { wave: 6, players: [] } },
    ],
  }), "utf8");

  const warnings = [];
  const store = new DataStore({ directory, adminKey: "k", logger: { warn: (message) => warnings.push(message), log() {} } });
  assert.equal(store.accounts.size, 2);
  const alice = store.findAccount("alice");
  const bob = store.findAccount("bob");
  assert.notEqual(alice.id, bob.id, "重复 id 应被修复");
  assert.equal(store.getAccountById(alice.id).username, "alice");
  assert.equal(store.getAccountById(bob.id).username, "bob");

  // 存档与令牌按用户名迁移到新的 id
  assert.equal(store.getSave("save-alice").accountId, alice.id);
  assert.equal(store.getSave("save-bob").accountId, bob.id);
  assert.equal(store.resolveSession("token-alice").account.username, "alice");
  assert.equal(store.resolveSession("token-bob").account.username, "bob");
  assert.equal(store.resolveSession("token-anon"), null, "无法判断归属的令牌应被吊销");
  assert.equal(store.sessions.size, 2);
  assert.ok(warnings.some((message) => message.includes("重复的账号 id")));

  // 修复结果会落盘，重启后依旧唯一
  store.close();
  const reopened = new DataStore({ directory, adminKey: "k", logger: { warn() {}, log() {} } });
  assert.equal(reopened.accounts.size, 2);
  assert.notEqual(reopened.findAccount("alice").id, reopened.findAccount("bob").id);
  assert.equal(reopened.resolveSession("token-bob").account.username, "bob");
  reopened.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("【不变量】任意导入组合下：账号 id 唯一，且存档/令牌绝不跨账号", () => {
  // 用多组随机种子覆盖各种冲突组合：id 撞上本机其它账号、备份内重复 id、缺失 id、幽灵 id
  for (const seedStart of [20260915, 1, 7, 42, 99, 1234, 777, 20260101, 5150, 31337]) {
    const { store } = createStore();
    const localAccounts = ["alice", "bob"].map((username) => store.registerAccount({ username, password: "pass1234" }));

    let seed = seedStart;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const names = ["alice", "bob", "carol", "dave", "erin", "frank"];
    const idPool = [localAccounts[0].id, localAccounts[1].id, "acct_shared", "acct_ghost", undefined];
    const pick = (pool) => pool[Math.floor(rng() * pool.length)];
    const accounts = names.map((username) => ({
      id: pick(idPool),
      username,
      password: "pass1234",
      stats: { kills: Math.floor(rng() * 10) },
    }));
    const saves = [];
    const sessions = [];
    for (let index = 0; index < 12; index += 1) {
      const owner = names[Math.floor(rng() * names.length)];
      const id = pick(idPool);
      saves.push({
        id: `save-${index}`,
        accountId: id,
        username: rng() < 0.8 ? owner : undefined,
        status: "active",
        wave: 1 + index,
        state: { wave: 1 + index, players: [{ accountId: id, username: owner, name: owner, stats: {} }] },
      });
      sessions.push({ token: `token-${index}`, accountId: id, username: rng() < 0.8 ? owner : undefined });
    }
    store.importBackup({ format: "lan-battle-backup", version: 1, accounts, saves, sessions }, { mode: "merge" });

    // 不变量 1：账号 id 全局唯一
    const ids = [...store.accounts.values()].map((account) => account.id);
    assert.equal(new Set(ids).size, ids.length, `种子 ${seedStart}：账号 id 必须唯一`);

    // 不变量 2：getAccountById 拿到的账号用户名与 id 的注册者一致
    for (const account of store.accounts.values()) {
      assert.equal(store.getAccountById(account.id).username, account.username, `种子 ${seedStart}：id 查询错人`);
    }

    // 不变量 3：令牌只能登录到「同名的那个账号」
    for (const [token, session] of store.sessions) {
      const resolved = store.resolveSession(token);
      assert.ok(resolved, `种子 ${seedStart}：令牌 ${token} 应能解析`);
      if (session.username) {
        assert.equal(
          resolved.account.username.toLowerCase(),
          session.username.toLowerCase(),
          `种子 ${seedStart}：令牌 ${token} 不能登录成别的账号`,
        );
      }
    }

    // 不变量 4：存档归属与记录的所属用户名一致，且不会出现在别人名下
    for (const save of store.saves.values()) {
      const owner = store.getAccountById(save.accountId);
      assert.ok(owner, `种子 ${seedStart}：存档 ${save.id} 必须有归属账号`);
      assert.equal(owner.username.toLowerCase(), String(save.username).toLowerCase(), `种子 ${seedStart}：存档 ${save.id} 归属错误`);
      for (const account of store.accounts.values()) {
        const listed = store.listSaves(account.id).some((entry) => entry.id === save.id);
        assert.equal(listed, account.id === owner.id, `种子 ${seedStart}：存档 ${save.id} 出现在了 ${account.username} 名下`);
      }
    }

    // 不变量 5：存档内玩家要么指向同名账号，要么为空
    for (const save of store.saves.values()) {
      for (const player of save.state.players ?? []) {
        if (!player.accountId) continue;
        const owner = store.getAccountById(player.accountId);
        assert.ok(owner, `种子 ${seedStart}：玩家归属必须指向真实账号`);
        assert.equal(owner.username.toLowerCase(), String(player.username).toLowerCase(), `种子 ${seedStart}：玩家归属不能跨账号`);
      }
    }
    store.close();
  }
});
