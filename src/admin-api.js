const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

/**
 * 服务器数据备份 / 导出 / 导入还原接口。
 *
 * 所有接口都需要管理密钥（启动时打印在终端，也可用 ADMIN_KEY 环境变量指定），
 * 支持两种带法：请求头 `x-admin-key`，或查询参数 `?key=`（方便用浏览器/curl 直接下载）。
 */
export function registerAdminRoutes(app, { store, roomManager, logger = console } = {}) {
  const requireKey = (request, response, next) => {
    const key = request.get("x-admin-key") ?? request.query.key ?? "";
    if (!store.verifyAdminKey(key)) {
      response.status(401).json({ ok: false, error: "管理密钥无效" });
      return;
    }
    next();
  };

  app.get("/api/admin/info", requireKey, (_request, response) => {
    const players = [...roomManager.rooms.values()].reduce((sum, room) => sum + room.players.size, 0);
    response.json({
      ok: true,
      adminKey: store.stats().adminKey,
      data: store.stats(),
      rooms: roomManager.rooms.size,
      players,
      autoBackupMinutes: store.autoBackupTimer ? "enabled" : "disabled",
    });
  });

  app.get("/api/admin/export", requireKey, (_request, response) => {
    const backup = store.exportBackup({ exportedBy: "http-export" });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="lan-battle-backup-${stamp}.json"`);
    response.send(`${JSON.stringify(backup, null, 2)}\n`);
  });

  app.get("/api/admin/backups", requireKey, (_request, response) => {
    response.json({ ok: true, backups: store.listBackupFiles() });
  });

  app.post("/api/admin/backup", requireKey, (_request, response) => {
    const file = store.createBackupFile({ label: "manual" });
    response.json({ ok: true, file, backups: store.listBackupFiles() });
  });

  app.post("/api/admin/import", requireKey, (request, response) => {
    const raw = JSON.stringify(request.body ?? null);
    if (raw.length > MAX_IMPORT_BYTES) {
      response.status(413).json({ ok: false, error: "备份文件过大" });
      return;
    }
    const mode = request.query.mode === "merge" ? "merge" : "replace";
    try {
      const report = store.importBackup(request.body, { mode });
      logger.log?.(`[admin] 导入备份完成（${mode}）：账号 +${report.accounts.added}/~${report.accounts.updated}，存档 +${report.saves.added}/~${report.saves.updated}（覆盖清理 ${report.saves.removed ?? 0}，清理孤立 ${report.saves.orphaned ?? 0}）`);
      response.json({ ok: true, mode, report, data: store.stats() });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/admin/restore-backup", requireKey, (request, response) => {
    const fileName = String(request.body?.file ?? "");
    try {
      const result = store.restoreBackupFile(fileName, { mode: "replace" });
      response.json({ ok: true, ...result, data: store.stats() });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/admin/backups/:file", requireKey, (request, response) => {
    try {
      const { fileName, payload } = store.readBackupFile(request.params.file);
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      response.send(`${JSON.stringify(payload, null, 2)}\n`);
    } catch (error) {
      response.status(404).json({ ok: false, error: error.message });
    }
  });
}
