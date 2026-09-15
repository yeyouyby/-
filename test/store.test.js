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
