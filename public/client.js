const socket = io();
const $ = (selector) => document.querySelector(selector);

const TIERS = [
  null,
  { name: "普通", color: "#9aa7b5" },
  { name: "稀有", color: "#68d8e8" },
  { name: "史诗", color: "#c56cf0" },
  { name: "传说", color: "#ff8a36" },
];

const MODE_LABELS = { pve: "合作生存", pvp: "竞技乱斗", endless: "无尽模式" };

function modeLabel(mode) {
  return MODE_LABELS[mode] ?? "合作生存";
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { hour12: false });
}

// 用 DOM API 构建节点（textContent），避免 innerHTML 注入
function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  const { className, text, attrs = {}, style } = options;
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) node.setAttribute(key, String(value));
  }
  if (style) {
    for (const [key, value] of Object.entries(style)) node.style[key] = value;
  }
  for (const child of children) {
    if (child != null) node.append(child);
  }
  return node;
}

const elements = {
  lobby: $("#lobby-screen"),
  room: $("#room-screen"),
  game: $("#game-screen"),
  name: $("#player-name"),
  playerClass: $("#player-class"),
  roomName: $("#room-name"),
  roomCode: $("#room-code"),
  maxPlayers: $("#max-players"),
  roomList: $("#room-list"),
  connection: $("#connection-status"),
  currentRoomName: $("#current-room-name"),
  currentRoomCode: $("#current-room-code"),
  roomCapacity: $("#room-capacity"),
  roomModeBadge: $("#room-mode-badge"),
  missionTitle: $("#mission-title"),
  missionDescription: $("#mission-description"),
  playerList: $("#player-list"),
  readyButton: $("#ready-button"),
  startButton: $("#start-button"),
  canvas: $("#game-canvas"),
  waveLabel: $("#wave-label"),
  timerLabel: $("#timer-label"),
  phaseLabel: $("#phase-label"),
  scoreboard: $("#scoreboard"),
  skillPanel: $("#skill-panel"),
  statsName: $("#stats-name"),
  statsLevel: $("#stats-level"),
  statsGold: $("#stats-gold"),
  statsHpFill: $("#stats-hp-fill"),
  statsXpFill: $("#stats-xp-fill"),
  openShop: $("#open-shop"),
  openBackpack: $("#open-backpack"),
  shopModal: $("#shop-modal"),
  shopGold: $("#shop-gold"),
  shopServices: $("#shop-services"),
  shopStock: $("#shop-stock"),
  closeShop: $("#close-shop"),
  backpackModal: $("#backpack-modal"),
  backpackContent: $("#backpack-content"),
  closeBackpack: $("#close-backpack"),
  upgradeModal: $("#upgrade-modal"),
  upgradeOptions: $("#upgrade-options"),
  resultModal: $("#result-modal"),
  resultTitle: $("#result-title"),
  resultNote: $("#result-note"),
  toast: $("#toast"),
  // —— 账号与存档 ——
  accountGuest: $("#account-guest"),
  accountUser: $("#account-user"),
  accountUsername: $("#account-username"),
  accountPassword: $("#account-password"),
  accountDisplay: $("#account-display"),
  accountLogin: $("#account-login"),
  accountRegister: $("#account-register"),
  accountLogout: $("#account-logout"),
  profileAvatar: $("#profile-avatar"),
  profileName: $("#profile-name"),
  profileUsername: $("#profile-username"),
  profileStats: $("#profile-stats"),
  saveList: $("#save-list"),
  refreshSaves: $("#refresh-saves"),
  passwordNew: $("#password-new"),
  passwordCurrent: $("#password-current"),
  changePassword: $("#account-change-password"),
  deletePassword: $("#account-delete-password"),
  deleteAccount: $("#account-delete"),
  savePointBox: $("#save-point-box"),
  savePointCurrent: $("#save-point-current"),
  roomSaveList: $("#room-save-list"),
  saveProgress: $("#save-progress"),
  // —— 管理员备份 ——
  adminKey: $("#admin-key"),
  adminInfo: $("#admin-info"),
  adminExport: $("#admin-export"),
  adminSnapshot: $("#admin-snapshot"),
  adminImportFile: $("#admin-import-file"),
  adminImportReplace: $("#admin-import-replace"),
  adminImportMerge: $("#admin-import-merge"),
  adminBackupList: $("#admin-backup-list"),
  adminRefreshBackups: $("#admin-refresh-backups"),
  adminOutput: $("#admin-output"),
};

const context = elements.canvas.getContext("2d");
const state = {
  selectedMode: "pve",
  room: null,
  map: null,
  services: [],
  stock: [],
  snapshot: null,
  keys: { left: false, right: false, jump: false, skill: false },
  toastTimer: null,
  selectedSaveId: null,
};

// 账号：令牌与数据都存在服务端（明文），这里只保留登录令牌用于自动恢复
const account = {
  token: localStorage.getItem("lanBattleAccountToken") || null,
  profile: null,
  saves: [],
};

elements.name.value = localStorage.getItem("lanBattleName") || "";
elements.adminKey.value = localStorage.getItem("lanBattleAdminKey") || "";

document.querySelectorAll(".mode-card").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".mode-card").forEach((candidate) => candidate.classList.remove("active"));
    button.classList.add("active");
    state.selectedMode = button.dataset.mode;
    if (state.selectedMode !== "endless") state.selectedSaveId = null;
    renderAccountSaves();
  });
});

$("#create-room").addEventListener("click", () => {
  const playerName = getPlayerName();
  if (!playerName) return;
  emitWithAck("room:create", {
    playerName,
    classId: elements.playerClass.value,
    roomName: elements.roomName.value,
    mode: state.selectedMode,
    maxPlayers: Number(elements.maxPlayers.value),
    saveId: state.selectedMode === "endless" ? state.selectedSaveId : null,
  });
});

$("#join-room").addEventListener("click", () => joinRoom(elements.roomCode.value));
elements.roomCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinRoom(elements.roomCode.value);
});

elements.roomList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-code]");
  if (button) joinRoom(button.dataset.code);
});

elements.readyButton.addEventListener("click", () => {
  const self = state.room?.players.find((player) => player.id === socket.id);
  socket.emit("room:ready", { ready: !self?.ready });
});

elements.startButton.addEventListener("click", () => emitWithAck("game:start"));
$("#leave-room").addEventListener("click", () => {
  socket.emit("room:leave");
  localStorage.removeItem("lanBattleSession");
  state.room = null;
  showScreen("lobby");
});
$("#return-room").addEventListener("click", () => emitWithAck("game:replay"));

// —— 账号操作 ——
elements.accountLogin.addEventListener("click", () => {
  const username = elements.accountUsername.value.trim();
  const password = elements.accountPassword.value;
  if (!username || !password) {
    showToast("请输入账号名和密码");
    return;
  }
  emitAccount("account:login", { username, password }, () => {
    elements.accountPassword.value = "";
  });
});

elements.accountRegister.addEventListener("click", () => {
  const username = elements.accountUsername.value.trim();
  const password = elements.accountPassword.value;
  if (!username || !password) {
    showToast("请输入账号名和密码");
    return;
  }
  emitAccount("account:register", {
    username,
    password,
    displayName: elements.accountDisplay.value.trim(),
  }, () => {
    elements.accountPassword.value = "";
    elements.accountDisplay.value = "";
  });
});

elements.accountLogout.addEventListener("click", () => emitAccount("account:logout"));
elements.refreshSaves.addEventListener("click", () => emitAccount("account:saves"));
elements.changePassword.addEventListener("click", () => {
  emitAccount("account:password", {
    currentPassword: elements.passwordCurrent.value,
    newPassword: elements.passwordNew.value,
  }, () => {
    elements.passwordCurrent.value = "";
    elements.passwordNew.value = "";
    showToast("密码已修改");
  });
});
elements.deleteAccount.addEventListener("click", () => {
  const password = elements.deletePassword.value;
  if (!password) {
    showToast("请输入当前密码以注销账号");
    return;
  }
  if (!window.confirm("注销账号会删除该账号及其全部存档，确定继续？")) return;
  emitAccount("account:delete", { password }, () => {
    elements.deletePassword.value = "";
    showToast("账号已注销");
  });
});

// —— 管理员备份操作 ——
elements.adminInfo.addEventListener("click", refreshAdminInfo);
elements.adminExport.addEventListener("click", exportBackupFile);
elements.adminSnapshot.addEventListener("click", async () => {
  const result = await adminRequest("/api/admin/backup", { method: "POST" });
  if (!result) return;
  adminLog(`已生成快照：${result.file}`);
  renderAdminBackups(result.backups);
});
elements.adminRefreshBackups.addEventListener("click", refreshAdminBackups);
elements.adminImportReplace.addEventListener("click", () => importBackupFile("replace"));
elements.adminImportMerge.addEventListener("click", () => importBackupFile("merge"));
elements.saveProgress.addEventListener("click", () => emitWithAck("save:now"));

elements.openShop.addEventListener("click", () => toggleShop());
elements.openBackpack.addEventListener("click", () => toggleBackpack());
elements.closeShop.addEventListener("click", () => elements.shopModal.classList.add("hidden"));
elements.closeBackpack.addEventListener("click", () => elements.backpackModal.classList.add("hidden"));

socket.on("connect", () => {
  elements.connection.textContent = "已连接";
  elements.connection.classList.add("online");
  // 用本地令牌恢复登录状态（服务器迁移后令牌依然有效）
  if (account.token) {
    socket.emit("account:auth", { token: account.token }, (response) => {
      if (!response?.ok) {
        account.token = null;
        account.profile = null;
        localStorage.removeItem("lanBattleAccountToken");
        renderAccount();
        renderAccountSaves();
      }
    });
  }
  // 断线后自动尝试恢复房间席位
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem("lanBattleSession") || "null");
  } catch {
    localStorage.removeItem("lanBattleSession");
  }
  if (saved?.code && saved?.playerKey) {
    socket.emit("room:rejoin", saved, (response) => {
      if (response?.ok && response.room) {
        state.room = response.room;
        renderRoom(response.room);
        showToast("已重新连接房间");
      } else if (response?.error) {
        localStorage.removeItem("lanBattleSession");
        showToast(response.error);
      }
    });
  }
});

socket.on("room:session", ({ code, playerKey }) => {
  localStorage.setItem("lanBattleSession", JSON.stringify({ code, playerKey }));
});

socket.on("disconnect", () => {
  elements.connection.textContent = "连接断开";
  elements.connection.classList.remove("online");
  showToast("与服务器的连接已断开");
});

socket.on("account:session", (payload = {}) => {
  const hadAccount = Boolean(account.profile);
  account.token = payload.token ?? null;
  account.profile = payload.account ?? null;
  account.saves = Array.isArray(payload.saves) ? payload.saves : [];
  if (account.token) {
    localStorage.setItem("lanBattleAccountToken", account.token);
    if (account.profile) {
      elements.name.value = account.profile.displayName;
      localStorage.setItem("lanBattleName", account.profile.displayName);
      if (payload.created) showToast("注册成功，已自动登录");
      else if (payload.passwordChanged) showToast("密码已修改");
      else if (!payload.resumed) showToast(`欢迎回来，${account.profile.displayName}`);
      else showToast("已恢复登录状态");
    }
  } else {
    localStorage.removeItem("lanBattleAccountToken");
    // 服务端主动失效（改密 / 导入还原覆盖数据）时会带上原因
    if (payload.reason) showToast(payload.reason);
    else if (hadAccount) showToast("已退出账号");
  }
  renderAccount();
  renderAccountSaves();
  renderRoomSavePoints();
});
socket.on("account:profile", ({ account: profile } = {}) => {
  if (!profile) return;
  account.profile = profile;
  renderAccount();
});
socket.on("account:saves", (saves) => {
  account.saves = Array.isArray(saves) ? saves : [];
  renderAccountSaves();
  renderRoomSavePoints();
});
socket.on("account:error", ({ message }) => showToast(message));
socket.on("save:error", ({ message }) => showToast(message));
socket.on("lobby:rooms", renderRoomList);
socket.on("room:state", (room) => {
  state.room = room;
  renderRoom(room);
  if (room.status === "waiting") {
    elements.resultModal.classList.add("hidden");
    showScreen("room");
  }
});
socket.on("game:start", ({ map, mode, resumed, wave }) => {
  state.map = map;
  state.snapshot = null;
  elements.upgradeModal.classList.add("hidden");
  elements.shopModal.classList.add("hidden");
  elements.backpackModal.classList.add("hidden");
  elements.resultModal.classList.add("hidden");
  elements.waveLabel.textContent = mode === "endless"
    ? `无尽 · 第 ${wave ?? 1} 波`
    : mode === "pve" ? "第 1 波" : "竞技乱斗";
  elements.phaseLabel.classList.add("hidden");
  const isHost = state.room?.hostId === socket.id;
  elements.saveProgress.classList.toggle("hidden", !(mode === "endless" && isHost));
  if (resumed) showToast(`已从存档点继续：第 ${wave ?? 1} 波`);
  showScreen("game");
  resizeCanvas();
});
socket.on("game:snapshot", (snapshot) => {
  state.snapshot = snapshot;
  renderHud(snapshot);
});
socket.on("shop:stock", ({ services, stock }) => {
  state.services = services ?? [];
  state.stock = stock ?? [];
  renderShopModal();
});
socket.on("game:event", (event) => {
  if (event.type === "wave") showToast(event.endless ? `第 ${event.wave} 波来袭` : `第 ${event.wave} 波来袭`);
  if (event.type === "peace") showToast(`第 ${event.wave} 波已清除，和平时间，可打开商店（Tab）`);
  if (event.type === "skill") showToast(`${event.skillName} 已释放`);
  if (event.type === "chest") showToast(`宝箱获得 ${event.gold} 金币与装备`);
  if (event.type === "pickup") showToast(event.label);
  if (event.type === "bossDefeated") showToast("Boss 已被击败，宝箱已掉落");
  if (event.type === "saved") showToast(`${event.reason === "manual" ? "已保存进度" : "已自动保存进度"}：${event.label}`);
  if (event.type === "resumed") showToast(`已从存档点继续：${event.label ?? `第 ${event.wave} 波`}`);
  if (event.type === "saveFailed") showToast(event.message);
});
socket.on("upgrade:choices", (choices) => {
  elements.upgradeOptions.replaceChildren();
  for (const choice of choices) {
    const tier = TIERS[choice.tier] ?? TIERS[1];
    const button = el("button", { className: "upgrade-card", style: { borderColor: tier.color } }, [
      el("span", { className: "tier-tag", text: `${tier.name} · Lv.${choice.level}`, style: { color: tier.color } }),
      el("strong", { text: choice.name }),
      el("span", { text: choice.description }),
    ]);
    button.addEventListener("click", () => {
      socket.emit("upgrade:choose", choice.id);
      elements.upgradeModal.classList.add("hidden");
    });
    elements.upgradeOptions.append(button);
  }
  elements.upgradeModal.classList.remove("hidden");
});
socket.on("upgrade:applied", () => elements.upgradeModal.classList.add("hidden"));
socket.on("shop:bought", ({ gold }) => {
  // 立即用服务端返回的最新金币刷新本地状态，避免等下一帧快照
  const self = state.snapshot?.players.find((player) => player.id === socket.id);
  if (self && typeof gold === "number") {
    self.gold = gold;
    elements.statsGold.textContent = gold;
  }
  showToast("购买成功");
  renderShopModal();
});
socket.on("shop:error", ({ message }) => showToast(message));
socket.on("game:end", (result) => {
  elements.resultTitle.textContent = result.title;
  elements.resultNote.textContent = result.endless
    ? `本次到达第 ${result.wave} 波。存档点已封存，重新开始会从第 1 波出发；也可以回到房间选择其它存档点。`
    : "";
  elements.resultModal.classList.remove("hidden");
  elements.shopModal.classList.add("hidden");
  elements.backpackModal.classList.add("hidden");
  elements.saveProgress.classList.add("hidden");
});
socket.on("server:error", ({ message }) => showToast(message));

window.addEventListener("resize", resizeCanvas);
window.addEventListener("keydown", (event) => updateKey(event, true));
window.addEventListener("keyup", (event) => updateKey(event, false));

function updateKey(event, active) {
  if (elements.game.classList.contains("hidden")) return;
  if (["KeyA", "KeyD", "KeyW", "KeyE", "KeyB", "ArrowLeft", "ArrowRight", "ArrowUp", "Space", "Tab"].includes(event.code)) {
    event.preventDefault();
  }
  if (event.code === "Tab" && active) {
    toggleShop();
    return;
  }
  if (event.code === "KeyB" && active) {
    toggleBackpack();
    return;
  }
  if (event.code === "KeyA" || event.code === "ArrowLeft") state.keys.left = active;
  if (event.code === "KeyD" || event.code === "ArrowRight") state.keys.right = active;
  if (event.code === "KeyW" || event.code === "ArrowUp" || event.code === "Space") state.keys.jump = active;
  if (event.code === "KeyE") state.keys.skill = active;
  socket.emit("game:input", state.keys);
}

function toggleShop() {
  const hidden = elements.shopModal.classList.toggle("hidden");
  if (!hidden) renderShopModal();
}

function toggleBackpack() {
  const hidden = elements.backpackModal.classList.toggle("hidden");
  if (!hidden) renderBackpack();
}

function emitAccount(event, payload, onSuccess) {
  socket.emit(event, payload, (response) => {
    if (!response?.ok) {
      showToast(response?.error || "操作失败");
      return;
    }
    if (typeof onSuccess === "function") onSuccess(response);
  });
}

function joinRoom(code) {
  const playerName = getPlayerName();
  if (!playerName) return;
  emitWithAck("room:join", { playerName, classId: elements.playerClass.value, code: String(code).trim().toUpperCase() });
}

function getPlayerName() {
  const name = elements.name.value.trim();
  if (!name) {
    showToast("请先输入战士代号");
    elements.name.focus();
    return null;
  }
  localStorage.setItem("lanBattleName", name);
  return name;
}

function emitWithAck(event, payload) {
  socket.emit(event, payload, (response) => {
    if (!response?.ok) {
      showToast(response?.error || "操作失败");
      return;
    }
    if (!response.room) return;
    state.room = response.room;
    renderRoom(response.room);
    // 只有进入房间的动作才切换界面；游戏内的操作（如手动存档）不应跳出战场
    if (event === "room:create" || event === "room:join" || event === "room:rejoin") showScreen("room");
  });
}

function renderRoomList(rooms) {
  elements.roomList.replaceChildren();
  if (!rooms.length) {
    elements.roomList.append(el("div", { className: "empty-state", text: "附近还没有房间，创建一个吧。" }));
    return;
  }
  for (const room of rooms) {
    const detail = `${modeLabel(room.mode)} · ${room.code}${room.saveLabel ? ` · 存档：${room.saveLabel}` : ""}`;
    elements.roomList.append(
      el("div", { className: "room-row" }, [
        el("div", {}, [
          el("strong", { text: room.name }),
          el("small", { text: detail }),
        ]),
        el("span", { text: `${room.players}/${room.maxPlayers}` }),
        el("button", { text: "加入", attrs: { "data-code": room.code } }),
      ]),
    );
  }
}

/* ------------------------------------------------------------- 账号与存档 */

function renderAccount() {
  const profile = account.profile;
  elements.accountGuest.classList.toggle("hidden", Boolean(profile));
  elements.accountUser.classList.toggle("hidden", !profile);
  if (!profile) return;
  elements.profileName.textContent = profile.displayName;
  elements.profileUsername.textContent = `@${profile.username}`;
  elements.profileAvatar.textContent = profile.displayName.slice(0, 1);
  const stats = profile.stats ?? {};
  elements.profileStats.replaceChildren();
  const entries = [
    ["出战", `${stats.games ?? 0} 场`],
    ["胜场", `${stats.wins ?? 0}`],
    ["击杀", `${stats.kills ?? 0}`],
    ["最高波次", `${stats.bestWave ?? 0}`],
    ["无尽最高", `${stats.endlessBestWave ?? 0} 波`],
    ["累计时长", formatClock(stats.playSeconds ?? 0)],
  ];
  for (const [label, value] of entries) {
    elements.profileStats.append(
      el("div", { className: "profile-stat" }, [
        el("span", { text: label }),
        el("strong", { text: value }),
      ]),
    );
  }
}

function saveRow(save, { selectable = false, selected = false, onSelect = null } = {}) {
  const finished = save.status === "finished";
  const row = el("div", { className: `save-row${selected ? " active" : ""}${finished ? " finished" : ""}` }, [
    el("div", { className: "save-row-main" }, [
      el("strong", { text: save.label }),
      el("small", {
        text: `${finished ? "已结束" : "进行中"} · ${formatDateTime(save.updatedAt)} · ${save.players.length} 人`,
      }),
    ]),
  ]);
  const actions = el("div", { className: "save-row-actions" });
  if (selectable && !finished) {
    const select = el("button", { className: "text-button", text: selected ? "已选择" : "选择" });
    select.addEventListener("click", () => onSelect?.(save));
    actions.append(select);
  }
  const remove = el("button", { className: "text-button danger", text: "删除" });
  remove.addEventListener("click", () => {
    if (!window.confirm(`删除存档「${save.label}」？该操作不可恢复。`)) return;
    emitAccount("account:delete-save", { saveId: save.id });
  });
  actions.append(remove);
  row.append(actions);
  return row;
}

function renderAccountSaves() {
  elements.saveList.replaceChildren();
  if (!account.profile) {
    elements.saveList.append(el("div", { className: "empty-state", text: "登录后可以查看并管理无尽模式存档。" }));
    return;
  }
  const saves = account.saves ?? [];
  if (!saves.length) {
    elements.saveList.append(el("div", { className: "empty-state", text: "暂无存档，进入无尽模式后会自动保存。" }));
    return;
  }
  for (const save of saves) {
    elements.saveList.append(
      saveRow(save, {
        selectable: true,
        selected: state.selectedSaveId === save.id,
        onSelect: (picked) => {
          state.selectedSaveId = state.selectedSaveId === picked.id ? null : picked.id;
          renderAccountSaves();
          showToast(state.selectedSaveId ? `已选择存档点「${picked.label}」，创建无尽房间后将从这里继续` : "已取消选择存档点");
        },
      }),
    );
  }
}

function renderRoomSavePoints() {
  const room = state.room;
  const visible = Boolean(room && room.mode === "endless" && room.status === "waiting");
  elements.savePointBox.classList.toggle("hidden", !visible);
  if (!visible) return;
  elements.savePointCurrent.textContent = room.saveLabel ? `当前：${room.saveLabel}` : "当前：新开始";
  elements.roomSaveList.replaceChildren();
  const isHost = room.hostId === socket.id;
  if (!isHost) {
    elements.roomSaveList.append(
      el("div", {
        className: "empty-state",
        text: room.saveLabel ? `房主选择的存档点：${room.saveLabel}` : "房主尚未选择存档点（从第 1 波开始）",
      }),
    );
    return;
  }
  if (!account.profile) {
    elements.roomSaveList.append(el("div", { className: "empty-state", text: "登录账号后可以选择存档点，并自动保存无尽进度。" }));
    return;
  }
  const saves = (account.saves ?? []).filter((save) => save.status === "active");
  const freshRow = el("div", { className: `save-row${room.saveId ? "" : " active"}` }, [
    el("div", { className: "save-row-main" }, [
      el("strong", { text: "新开始" }),
      el("small", { text: "从第 1 波出发，清空波次后自动存档" }),
    ]),
    el("div", { className: "save-row-actions" }, [
      (() => {
        const button = el("button", { className: "text-button", text: "选择" });
        button.addEventListener("click", () => emitWithAck("room:set-save", { saveId: null }));
        return button;
      })(),
    ]),
  ]);
  elements.roomSaveList.append(freshRow);
  if (!saves.length) {
    elements.roomSaveList.append(el("div", { className: "empty-state", text: "还没有存档点，先玩一局无尽模式就会自动生成。" }));
    return;
  }
  for (const save of saves) {
    elements.roomSaveList.append(
      saveRow(save, {
        selectable: true,
        selected: room.saveId === save.id,
        onSelect: (picked) => emitWithAck("room:set-save", { saveId: picked.id }),
      }),
    );
  }
}

/* --------------------------------------------------------------- 管理备份 */

function adminLog(message) {
  const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  elements.adminOutput.textContent = `[${stamp}] ${message}\n${elements.adminOutput.textContent}`.slice(0, 4000);
}

function adminKeyValue() {
  const key = elements.adminKey.value.trim();
  if (!key) {
    showToast("请先填写管理密钥（服务端启动时终端会打印）");
    return null;
  }
  localStorage.setItem("lanBattleAdminKey", key);
  return key;
}

async function adminRequest(path, options = {}) {
  const key = adminKeyValue();
  if (!key) return null;
  try {
    const response = await fetch(path, {
      ...options,
      headers: { "x-admin-key": key, "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { ok: false, error: text.slice(0, 300) || `HTTP ${response.status}` };
    }
    if (!response.ok || payload?.ok === false) {
      const message = payload?.error || `请求失败（HTTP ${response.status}）`;
      showToast(message);
      adminLog(`失败：${message}`);
      return null;
    }
    return payload;
  } catch (error) {
    showToast(`请求失败：${error.message}`);
    adminLog(`失败：${error.message}`);
    return null;
  }
}

async function refreshAdminInfo() {
  const info = await adminRequest("/api/admin/info");
  if (!info) return;
  const data = info.data ?? {};
  adminLog(
    `数据目录：${data.directory}\n账号 ${data.accounts} · 存档 ${data.saves}（进行中 ${data.activeSaves}） · 登录令牌 ${data.sessions}\n房间 ${info.rooms} · 在线玩家 ${info.players}\n最近备份：${data.server?.lastBackupFile ?? "无"}`,
  );
  renderAdminBackups(null);
  await refreshAdminBackups();
}

async function refreshAdminBackups() {
  const result = await adminRequest("/api/admin/backups");
  if (!result) return;
  renderAdminBackups(result.backups);
}

function renderAdminBackups(backups) {
  if (!backups) return;
  elements.adminBackupList.replaceChildren();
  if (!backups.length) {
    elements.adminBackupList.append(el("div", { className: "empty-state", text: "暂无本地快照。" }));
    return;
  }
  for (const backup of backups) {
    const row = el("div", { className: "save-row" }, [
      el("div", { className: "save-row-main" }, [
        el("strong", { text: backup.file }),
        el("small", { text: `${formatDateTime(backup.createdAt)} · ${Math.max(1, Math.round(backup.size / 1024))} KB` }),
      ]),
    ]);
    const actions = el("div", { className: "save-row-actions" });
    // 管理密钥通过请求头传递，不放进 URL（避免出现在历史记录、日志与 Referer 中）
    const download = el("button", { className: "text-button", text: "下载" });
    download.addEventListener("click", () => downloadBackupFile(backup.file));
    const restore = el("button", { className: "text-button danger", text: "还原" });
    restore.addEventListener("click", async () => {
      if (!window.confirm(`用快照 ${backup.file} 覆盖当前服务器数据？（会先自动备份当前数据）`)) return;
      const result = await adminRequest("/api/admin/restore-backup", {
        method: "POST",
        body: JSON.stringify({ file: backup.file }),
      });
      if (result) {
        adminLog(`已用快照还原：${result.fileName}`);
        await refreshAdminInfo();
      }
    });
    actions.append(download, restore);
    row.append(actions);
    elements.adminBackupList.append(row);
  }
}

/** 带管理密钥请求文件并用 blob 下载（密钥只走请求头，不进入 URL） */
async function downloadWithAdminKey(path, fallbackName) {
  const key = adminKeyValue();
  if (!key) return null;
  try {
    const response = await fetch(path, { headers: { "x-admin-key": key } });
    if (!response.ok) {
      showToast(`下载失败（HTTP ${response.status}）`);
      return null;
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disposition);
    const fileName = match?.[1] ?? fallbackName;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return fileName;
  } catch (error) {
    showToast(`下载失败：${error.message}`);
    return null;
  }
}

async function exportBackupFile() {
  const fileName = await downloadWithAdminKey("/api/admin/export", `lan-battle-backup-${Date.now()}.json`);
  if (fileName) adminLog(`已导出备份 ${fileName}（明文，包含账号与存档，请妥善保管）`);
}

async function downloadBackupFile(file) {
  const fileName = await downloadWithAdminKey(`/api/admin/backups/${encodeURIComponent(file)}`, file);
  if (fileName) adminLog(`已下载快照 ${fileName}`);
}

async function importBackupFile(mode) {
  const file = elements.adminImportFile.files?.[0];
  if (!file) {
    showToast("请先选择备份文件");
    return;
  }
  const label = mode === "merge" ? "合并导入" : "覆盖还原";
  if (mode === "replace" && !window.confirm("覆盖还原会替换服务器上现有的账号与存档（会先自动备份当前数据），确定继续？")) return;
  let payload = null;
  try {
    payload = JSON.parse(await file.text());
  } catch (error) {
    showToast(`备份文件不是有效的 JSON：${error.message}`);
    return;
  }
  const result = await adminRequest(`/api/admin/import?mode=${mode}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!result) return;
  const report = result.report ?? {};
  adminLog(
    `${label}完成：账号 +${report.accounts?.added ?? 0}/~${report.accounts?.updated ?? 0}，存档 +${report.saves?.added ?? 0}/~${report.saves?.updated ?? 0}，令牌恢复 ${report.sessions?.imported ?? 0}，覆盖清理 ${report.saves?.removed ?? 0}，清理孤立存档 ${report.saves?.orphaned ?? 0}；原数据快照 ${report.preImportBackup ?? "无"}`,
  );
  showToast(`${label}完成`);
  elements.adminImportFile.value = "";
  await refreshAdminBackups();
}

function renderRoom(room) {
  elements.currentRoomName.textContent = room.name;
  elements.currentRoomCode.textContent = room.code;
  elements.roomCapacity.textContent = `${room.players.length} / ${room.maxPlayers}`;
  const pve = room.mode === "pve";
  const endless = room.mode === "endless";
  elements.roomModeBadge.textContent = modeLabel(room.mode);
  elements.missionTitle.textContent = endless
    ? "无尽波次，挑战极限"
    : pve ? "坚守五个波次" : "成为最后的幸存者";
  elements.missionDescription.textContent = endless
    ? "波次无限递进，每清空一波进入和平时间并联机存档；房主可在下方选择存档点继续之前的进度。"
    : pve
      ? "自动锁定怪物射击，拾取能量升级，波次之间有和平时间可逛商店。"
      : "武器自动锁定附近对手，利用平台和升级建立优势。";
  elements.playerList.replaceChildren();
  for (const player of room.players) {
    const identity = el("div", { className: "player-identity" }, [
      el("span", { className: "avatar", text: player.name.slice(0, 1), style: { background: player.color } }),
      el("div", {}, [
        el("strong", { text: player.name }),
        el("small", { text: player.className ?? "突击手" }),
      ]),
    ]);
    if (player.id === room.hostId) identity.append(el("span", { className: "host-tag", text: "房主" }));
    if (player.disconnected) identity.append(el("span", { className: "ready-tag waiting", text: "已断线" }));
    elements.playerList.append(
      el("div", { className: "player-row" }, [
        identity,
        el("span", { className: `ready-tag ${player.ready ? "" : "waiting"}`, text: player.ready ? "已准备" : "等待中" }),
      ]),
    );
  }

  const self = room.players.find((player) => player.id === socket.id);
  const isHost = room.hostId === socket.id;
  elements.readyButton.classList.toggle("hidden", isHost);
  elements.readyButton.textContent = self?.ready ? "取消准备" : "准备";
  elements.startButton.classList.toggle("hidden", !isHost);
  elements.startButton.disabled =
    room.players.some((player) => !player.ready) || (room.mode === "pvp" && room.players.length < 2);
  if (endless && !isHost && room.saveLabel) {
    elements.missionDescription.textContent += ` 当前存档点：${room.saveLabel}。`;
  }
  renderRoomSavePoints();
}

function showScreen(name) {
  elements.lobby.classList.toggle("hidden", name !== "lobby");
  elements.room.classList.toggle("hidden", name !== "room");
  elements.game.classList.toggle("hidden", name !== "game");
  if (name === "lobby") {
    renderAccount();
    renderAccountSaves();
  }
  if (name === "room") renderRoomSavePoints();
}

function resizeCanvas() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  elements.canvas.width = Math.round(window.innerWidth * ratio);
  elements.canvas.height = Math.round(window.innerHeight * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function renderHud(snapshot) {
  if (snapshot.endless) {
    // 无尽模式没有终点，计时器改为显示已生存时间
    elements.timerLabel.textContent = formatClock(snapshot.elapsed);
    elements.timerLabel.title = "已生存时间";
    elements.waveLabel.textContent = `无尽 · 第 ${snapshot.wave} 波`;
  } else {
    elements.timerLabel.textContent = formatClock((snapshot.duration ?? 0) - snapshot.elapsed);
    elements.timerLabel.title = "剩余时间";
    if (state.room?.mode === "pve" || snapshot.mode === "pve") elements.waveLabel.textContent = `第 ${snapshot.wave} 波`;
  }
  if (snapshot.phase === "peace") {
    elements.phaseLabel.textContent = `和平时间 ${Math.ceil(snapshot.phaseTimer)}s · Tab 打开商店`;
    elements.phaseLabel.classList.remove("hidden");
  } else {
    elements.phaseLabel.classList.add("hidden");
  }
  elements.scoreboard.replaceChildren();
  for (const player of snapshot.players) {
    elements.scoreboard.append(
      el("div", { className: "score-row" }, [
        el("i", { style: { background: player.color } }),
        el("span", { text: `${player.name} · ${player.className} · Lv.${player.level}` }),
        el("strong", { text: `${player.kills} / ${player.gold}G` }),
      ]),
    );
  }
  const self = snapshot.players.find((player) => player.id === socket.id);
  if (self) {
    const cooldown = Math.ceil(self.skillCooldown);
    elements.skillPanel.replaceChildren(
      el("strong", { text: self.skillName }),
      el("span", { text: cooldown > 0 ? `${cooldown}s 后可用` : "E 键可用" }),
      document.createTextNode(` · 护盾 ${Math.ceil(self.shield)} · 护甲 ${self.armor}`),
    );
    elements.statsName.textContent = self.name;
    elements.statsLevel.textContent = `Lv.${self.level}`;
    elements.statsGold.textContent = self.gold;
    elements.statsHpFill.style.width = `${Math.max(0, Math.min(100, (self.hp / self.maxHp) * 100))}%`;
    elements.statsXpFill.style.width = `${Math.max(0, Math.min(100, (self.xp / self.xpNeeded) * 100))}%`;
  }
}

function renderShopModal() {
  const self = state.snapshot?.players.find((player) => player.id === socket.id);
  const gold = self?.gold ?? 0;
  const roomMode = state.room?.mode ?? state.snapshot?.mode;
  // 合作类玩法（固定波次 / 无尽）的商店只在和平时间开放，与服务端限制保持一致
  const coop = roomMode === "pve" || roomMode === "endless";
  const canShop = !coop || state.snapshot?.phase === "peace";
  elements.shopGold.textContent = `${gold} 金币${canShop ? "" : "（仅和平时间可购买）"}`;
  elements.shopServices.replaceChildren();
  for (const service of state.services) {
    const button = el("button", { className: "shop-item", attrs: { "data-buy": service.id } }, [
      el("strong", { text: `${service.name} · ${service.cost}G` }),
      el("span", { text: service.description }),
    ]);
    button.disabled = !canShop || gold < service.cost;
    button.addEventListener("click", () => socket.emit("shop:buy", service.id));
    elements.shopServices.append(button);
  }
  elements.shopStock.replaceChildren();
  for (const entry of state.stock) {
    const tier = TIERS[entry.tier] ?? TIERS[1];
    const strong = el("strong", { text: `${entry.name} · ${entry.cost}G` });
    strong.append(el("em", { className: "tier-tag", text: tier.name, style: { color: tier.color } }));
    const button = el("button", {
      className: "shop-item",
      attrs: { "data-buy": entry.id },
      style: { borderColor: `${tier.color}55` },
    }, [strong, el("span", { text: entry.description })]);
    button.disabled = !canShop || gold < entry.cost;
    button.addEventListener("click", () => socket.emit("shop:buy", entry.id));
    elements.shopStock.append(button);
  }
}

function invRow(kind, tier, name, detail) {
  const tierInfo = TIERS[tier] ?? TIERS[1];
  return el("div", { className: "inv-row" }, [
    el("span", { className: "inv-tag", text: kind, style: { color: tierInfo.color } }),
    el("strong", { text: name }),
    el("span", { text: detail }),
  ]);
}

function renderBackpack() {
  const self = state.snapshot?.players.find((player) => player.id === socket.id);
  if (!self) return;
  elements.backpackContent.replaceChildren();

  elements.backpackContent.append(el("div", { className: "inv-section-title", text: `武器（${self.weapons.length}）` }));
  if (!self.weapons.length) elements.backpackContent.append(el("div", { className: "inv-empty", text: "暂无武器" }));
  else for (const weapon of self.weapons) elements.backpackContent.append(invRow("武器", weapon.tier, weapon.name, `Lv.${weapon.level}`));

  elements.backpackContent.append(el("div", { className: "inv-section-title", text: `道具（${self.items.length}）` }));
  if (!self.items.length) elements.backpackContent.append(el("div", { className: "inv-empty", text: "暂无道具" }));
  else for (const item of self.items) elements.backpackContent.append(invRow("道具", item.tier, item.name, `×${item.count}`));

  elements.backpackContent.append(el("div", { className: "inv-section-title", text: `强化（${self.upgrades.length}）` }));
  if (!self.upgrades.length) elements.backpackContent.append(el("div", { className: "inv-empty", text: "暂无强化" }));
  else for (const upgrade of self.upgrades) elements.backpackContent.append(invRow("强化", upgrade.tier, upgrade.name, `Lv.${upgrade.level}`));
}

function draw() {
  requestAnimationFrame(draw);
  if (!state.map || !state.snapshot || elements.game.classList.contains("hidden")) return;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const localPlayer = state.snapshot.players.find((player) => player.id === socket.id);
  const cameraX = Math.max(0, Math.min(state.map.width - width, (localPlayer?.x ?? state.map.width / 2) - width / 2));
  const scaleY = height / state.map.height;

  context.clearRect(0, 0, width, height);
  drawBackground(width, height, cameraX);
  context.save();
  context.translate(-cameraX, 0);
  context.scale(1, scaleY);
  drawWorld();
  context.restore();
}

function drawBackground(width, height, cameraX) {
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#17283b");
  gradient.addColorStop(0.65, "#263a46");
  gradient.addColorStop(1, "#1a2028");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  context.fillStyle = "rgba(255, 163, 76, 0.72)";
  context.beginPath();
  context.arc(width * 0.78 - cameraX * 0.04, height * 0.22, 58, 0, Math.PI * 2);
  context.fill();

  for (let layer = 0; layer < 3; layer += 1) {
    context.beginPath();
    context.moveTo(0, height);
    const offset = -(cameraX * (0.05 + layer * 0.04)) % 420;
    for (let x = offset - 420; x < width + 420; x += 210) {
      context.lineTo(x, height * (0.58 + layer * 0.09));
      context.lineTo(x + 105, height * (0.46 + layer * 0.1));
      context.lineTo(x + 210, height * (0.58 + layer * 0.09));
    }
    context.lineTo(width, height);
    context.fillStyle = [`#1a2d38`, `#172832`, `#14232b`][layer];
    context.fill();
  }
}

function drawWorld() {
  // 背景装饰（立柱与岩石）
  for (const deco of state.map.decorations ?? []) {
    context.fillStyle = "rgba(30, 42, 52, 0.55)";
    if (deco.type === "pillar") {
      context.fillRect(deco.x, deco.y - deco.h, deco.w, deco.h);
      context.fillStyle = "rgba(45, 60, 70, 0.55)";
      context.fillRect(deco.x - 6, deco.y - deco.h, deco.w + 12, 8);
    } else {
      context.beginPath();
      context.ellipse(deco.x, deco.y, deco.w / 2, deco.h / 2, 0, Math.PI, 0);
      context.fill();
    }
  }

  context.fillStyle = "#263236";
  context.fillRect(0, state.map.groundY, state.map.width, state.map.height - state.map.groundY);
  context.fillStyle = "#3c4b48";
  context.fillRect(0, state.map.groundY, state.map.width, 7);

  for (const platform of state.map.platforms) {
    context.fillStyle = "#34444a";
    context.fillRect(platform.x, platform.y, platform.width, platform.height);
    context.fillStyle = "#65736a";
    context.fillRect(platform.x, platform.y, platform.width, 5);
  }

  for (const pickup of state.snapshot.pickups) {
    drawPickup(pickup);
  }

  for (const projectile of state.snapshot.projectiles) {
    context.fillStyle = projectile.color || "#ffd166";
    context.shadowColor = projectile.color || "#ff9f43";
    context.shadowBlur = 9;
    context.beginPath();
    context.arc(projectile.x, projectile.y, projectile.radius, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
  }

  for (const enemy of state.snapshot.enemies) drawEnemy(enemy);
  for (const player of state.snapshot.players) {
    drawPlayer(player);
    drawOrbs(player);
  }
}

function drawPickup(pickup) {
  context.save();
  if (pickup.type === "chest") {
    context.fillStyle = "#ffb86b";
    context.shadowColor = "#ff8a36";
    context.shadowBlur = 20;
    context.beginPath();
    context.arc(pickup.x, pickup.y, 13, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = "#3d220f";
    context.lineWidth = 3;
    context.strokeRect(pickup.x - 12, pickup.y - 9, 24, 18);
  } else if (pickup.type === "gold") {
    context.fillStyle = "#ffd166";
    context.shadowColor = "#ffd166";
    context.shadowBlur = 14;
    context.beginPath();
    context.arc(pickup.x, pickup.y, 8, 0, Math.PI * 2);
    context.fill();
  } else if (pickup.type === "weapon") {
    context.fillStyle = "#ff8a36";
    context.shadowColor = "#ff8a36";
    context.shadowBlur = 16;
    context.translate(pickup.x, pickup.y);
    context.rotate(Math.PI / 4);
    context.fillRect(-8, -8, 16, 16);
  } else if (pickup.type === "item") {
    context.fillStyle = "#c56cf0";
    context.shadowColor = "#c56cf0";
    context.shadowBlur = 16;
    context.fillRect(pickup.x - 8, pickup.y - 8, 16, 16);
  } else {
    context.fillStyle = "#79f2cb";
    context.shadowColor = "#79f2cb";
    context.shadowBlur = 14;
    context.beginPath();
    context.arc(pickup.x, pickup.y, 7, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawEnemy(enemy) {
  context.fillStyle = enemy.boss ? "#ff8a36" : enemy.elite ? "#c56cf0" : "#ff596d";
  context.beginPath();
  context.arc(enemy.x, enemy.y, enemy.radius, 0, Math.PI * 2);
  context.fill();
  if (enemy.boss) {
    context.strokeStyle = "#ffe0ad";
    context.lineWidth = 5;
    context.stroke();
  }
  context.fillStyle = "#10151b";
  context.beginPath();
  context.arc(enemy.x - 7, enemy.y - 4, 3, 0, Math.PI * 2);
  context.arc(enemy.x + 7, enemy.y - 4, 3, 0, Math.PI * 2);
  context.fill();
  drawHealthBar(enemy.x, enemy.y - enemy.radius - 13, enemy.hp / enemy.maxHp, enemy.radius * 2);
}

function drawPlayer(player) {
  context.save();
  context.globalAlpha = player.alive ? 1 : 0.32;
  context.fillStyle = player.color;
  context.beginPath();
  context.roundRect(player.x - 21, player.y - 25, 42, 50, 13);
  context.fill();
  context.fillStyle = "#121820";
  const eyeX = player.x + player.facing * 8;
  context.beginPath();
  context.arc(eyeX, player.y - 7, 4, 0, Math.PI * 2);
  context.fill();
  context.restore();
  drawHealthBar(player.x, player.y - 38, player.hp / player.maxHp, 50);
  context.fillStyle = "#fff";
  context.font = "600 12px Inter, sans-serif";
  context.textAlign = "center";
  context.fillText(player.alive ? player.name : `${player.name} (${Math.ceil(player.downFor)})`, player.x, player.y - 48);
  if (player.id === socket.id) {
    context.strokeStyle = "#fff";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(player.x, player.y, 30, 0, Math.PI * 2);
    context.stroke();
  }
  if (player.shield > 0) {
    context.strokeStyle = "rgba(104,216,232,.72)";
    context.lineWidth = 3;
    context.beginPath();
    context.arc(player.x, player.y, 35, 0, Math.PI * 2);
    context.stroke();
  }
}

function drawOrbs(player) {
  for (const orb of player.orbs ?? []) {
    context.fillStyle = orb.color || "#7bed9f";
    context.shadowColor = orb.color || "#7bed9f";
    context.shadowBlur = 12;
    context.beginPath();
    context.arc(orb.x, orb.y, orb.radius, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
  }
}

function drawHealthBar(x, y, ratio, width) {
  context.fillStyle = "rgba(0,0,0,.55)";
  context.fillRect(x - width / 2, y, width, 5);
  context.fillStyle = ratio > 0.35 ? "#6de09c" : "#ff596d";
  context.fillRect(x - width / 2, y, width * Math.max(0, ratio), 5);
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  state.toastTimer = setTimeout(() => elements.toast.classList.add("hidden"), 2600);
}

renderAccount();
renderAccountSaves();
resizeCanvas();
draw();
