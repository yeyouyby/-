#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { DataStore } from "./store.js";

const USAGE = `
荒原小队 · 数据备份工具

用法：
  node src/cli.js info                      查看数据目录、账号/存档数量与管理密钥
  node src/cli.js export [文件]             导出备份（默认 lan-battle-backup-<时间>.json）
  node src/cli.js import <文件> [--merge]   导入还原（默认覆盖；--merge 为合并导入）
  node src/cli.js backups                   列出服务器本地快照
  node src/cli.js restore <快照文件名>       用本地快照还原

可选环境变量：
  DATA_DIR   数据目录（默认 ./data）
`;

function main(argv) {
  const [command, ...rest] = argv;
  const store = new DataStore({ directory: process.env.DATA_DIR ?? path.join(process.cwd(), "data") });
  try {
    switch (command) {
      case "info":
        return info(store);
      case "export":
        return exportBackup(store, rest[0]);
      case "import":
        return importBackup(store, rest);
      case "backups":
        return listBackups(store);
      case "restore":
        return restoreBackup(store, rest[0]);
      default:
        console.log(USAGE.trim());
        return command ? 1 : 0;
    }
  } finally {
    store.close();
  }
}

function info(store) {
  const stats = store.stats();
  console.log(`数据目录: ${stats.directory}`);
  console.log(`账号数量: ${stats.accounts}`);
  console.log(`存档数量: ${stats.saves}（进行中 ${stats.activeSaves}）`);
  console.log(`登录令牌: ${stats.sessions}`);
  console.log(`管理密钥: ${stats.adminKey}`);
  console.log(`服务器实例: ${stats.server.instanceId}（创建于 ${stats.server.createdAt}）`);
  if (stats.server.migratedFromInstanceId) {
    console.log(`上次迁移来源: ${stats.server.migratedFromInstanceId}（${stats.server.migratedAt}）`);
  }
  console.log("数据文件:");
  for (const file of stats.files) console.log(`  ${file.file}  ${file.size} 字节`);
  return 0;
}

function exportBackup(store, target) {
  const file = target || `lan-battle-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(file, `${JSON.stringify(store.exportBackup({ exportedBy: "cli" }), null, 2)}\n`, "utf8");
  console.log(`已导出备份: ${path.resolve(file)}`);
  console.log(`包含账号 ${store.accounts.size} 个、存档 ${store.saves.size} 个（明文，请妥善保管）`);
  return 0;
}

function importBackup(store, args) {
  const file = args.find((entry) => !entry.startsWith("--"));
  if (!file) throw new Error("请指定备份文件路径");
  const mode = args.includes("--merge") ? "merge" : "replace";
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const report = store.importBackup(payload, { mode });
  console.log(`导入完成（${mode === "merge" ? "合并" : "覆盖"}）: ${path.resolve(file)}`);
  console.log(`账号：新增 ${report.accounts.added}，更新 ${report.accounts.updated}，跳过 ${report.accounts.skipped}`);
  console.log(`存档：新增 ${report.saves.added}，更新 ${report.saves.updated}，跳过 ${report.saves.skipped}，覆盖清理 ${report.saves.removed ?? 0}，清理孤立 ${report.saves.orphaned ?? 0}`);
  console.log(`登录令牌：恢复 ${report.sessions.imported}`);
  if (report.preImportBackup) console.log(`导入前的原数据已备份为: ${report.preImportBackup}`);
  console.log(`当前管理密钥（沿用本机密钥）: ${store.stats().adminKey}`);
  return 0;
}

function listBackups(store) {
  const backups = store.listBackupFiles();
  if (!backups.length) {
    console.log("暂无本地快照");
    return 0;
  }
  for (const backup of backups) console.log(`${backup.file}  ${backup.size} 字节  ${backup.createdAt}`);
  return 0;
}

function restoreBackup(store, fileName) {
  if (!fileName) throw new Error("请指定快照文件名");
  const { fileName: name, report } = store.restoreBackupFile(fileName, { mode: "replace" });
  console.log(`已用快照 ${name} 还原数据`);
  console.log(`账号：新增 ${report.accounts.added}，更新 ${report.accounts.updated}`);
  console.log(`存档：新增 ${report.saves.added}，更新 ${report.saves.updated}，覆盖清理 ${report.saves.removed ?? 0}，清理孤立 ${report.saves.orphaned ?? 0}`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2)) ?? 0;
} catch (error) {
  console.error(`错误: ${error.message}`);
  process.exitCode = 1;
}
