export const SERVER_TICK_RATE = 30;
export const SNAPSHOT_RATE = 15;
export const MAP_WIDTH = 4200;
export const MAP_HEIGHT = 760;
export const GROUND_Y = 660;
export const PLAYER_RADIUS = 24;
export const MAX_PLAYERS = 8;
export const ROOM_CODE_LENGTH = 5;
export const WAVE_DURATION = 30;
export const PEACE_DURATION = 15;
export const MAX_WAVES = 5;
export const MAX_WEAPONS = 4;
export const MAX_WEAPON_LEVEL = 4;
export const MAX_ITEMS = 8;

// 稀有度分级（类似《土豆兄弟》的武器/道具品质）
export const TIERS = [
  { key: "common", name: "普通", color: "#9aa7b5" },
  { key: "rare", name: "稀有", color: "#68d8e8" },
  { key: "epic", name: "史诗", color: "#c56cf0" },
  { key: "legendary", name: "传说", color: "#ff8a36" },
];

export function tierInfo(tier) {
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, (tier ?? 1) - 1))];
}

// 游戏模式：pve 固定 5 波，pvp 乱斗，endless 无尽波次（可存档、可从存档点继续）
export const GAME_MODES = [
  { id: "pve", name: "合作生存", description: "并肩抵抗 5 波怪物" },
  { id: "pvp", name: "竞技乱斗", description: "自动射击，最后一人获胜" },
  { id: "endless", name: "无尽模式", description: "波次无限递进，进度自动存档，可从存档点继续" },
];

export function isGameMode(mode) {
  return GAME_MODES.some((entry) => entry.id === mode);
}

export function modeInfo(mode) {
  return GAME_MODES.find((entry) => entry.id === mode) ?? GAME_MODES[0];
}

// 无尽模式的成长曲线：波次越高，敌人越强、刷新越快、和平时间越短
export const ENDLESS = {
  baseCombatDuration: WAVE_DURATION,
  combatGrowth: 2, // 每波 +2 秒，最长 combatMax
  combatMax: 50,
  basePeaceDuration: PEACE_DURATION,
  peaceDecay: 0.6, // 每波 -0.6 秒，最短 peaceMin
  peaceMin: 7,
  hpGrowth: 0.33, // 与固定波次一致的每波血量成长
  lateHpGrowth: 0.12, // 第 lateWaveThreshold 波之后额外的血量成长
  lateWaveThreshold: 8,
  speedGrowth: 9,
  damageGrowth: 2.4,
  spawnRateCap: 6, // 每秒最多生成 6 只
  spawnRateGrowth: 0.42,
  maxEnemies: 96,
  bossEveryWaves: 5,
  eliteChanceCap: 0.4,
  catchUp: {
    // 中途加入（或未参与原存档）的玩家获得的基础补偿
    perWaveHpBonus: 0.05,
    perWaveDamageBonus: 0.05,
    maxMultiplier: 1.6,
    maxLevels: 5,
    goldPerWave: 5,
  },
};

export const MAX_SAVES_PER_ACCOUNT = 20;
export const SAVE_STATE_VERSION = 1;
export const AUTOSAVE_MIN_INTERVAL_MS = 3_000;

export const PLAYER_BASE = {
  maxHp: 100,
  speed: 310,
  jumpSpeed: 660,
  maxJumps: 2, // 支持二段跳
  damage: 18,
  attackRate: 1.6,
  projectileSpeed: 760,
  pickupRange: 120,
  armor: 0,
  regen: 0,
  critChance: 0.05,
  pierce: 0,
  lifesteal: 0,
  goldBonus: 0,
};

export const PLAYER_CLASSES = [
  {
    id: "assault",
    name: "突击手",
    description: "均衡火力，主动技能会向前方倾泻弹幕。",
    skillName: "弹幕爆发",
    skillDescription: "E：朝最近目标或面朝方向连射 8 发弹丸。",
    skillCooldown: 7,
    stats: {
      maxHp: 105,
      speed: 315,
      damage: 20,
      attackRate: 1.75,
      armor: 1,
      critChance: 0.08,
    },
  },
  {
    id: "guardian",
    name: "守卫",
    description: "高生命和护甲，能展开临时护盾顶住怪潮。",
    skillName: "能量护盾",
    skillDescription: "E：获得 55 护盾并短暂无敌。",
    skillCooldown: 12,
    stats: {
      maxHp: 145,
      speed: 260,
      damage: 16,
      attackRate: 1.35,
      armor: 5,
    },
  },
  {
    id: "medic",
    name: "医师",
    description: "伤害较低，可治疗附近队友并扶起倒地队友。",
    skillName: "急救脉冲",
    skillDescription: "E：治疗 460 范围内队友，合作模式可扶起倒地者。",
    skillCooldown: 10,
    stats: {
      maxHp: 95,
      speed: 305,
      damage: 15,
      attackRate: 1.55,
      regen: 0.8,
      pickupRange: 150,
    },
  },
  {
    id: "scout",
    name: "游侠",
    description: "高速高攻速，主动技能可以穿梭战场。",
    skillName: "闪避冲刺",
    skillDescription: "E：向面朝方向快速冲刺并短暂无敌。",
    skillCooldown: 5,
    stats: {
      maxHp: 82,
      speed: 395,
      damage: 17,
      attackRate: 2.05,
      critChance: 0.15,
    },
  },
];

// 武器：敌人掉落 / 商店购买。rate 为相对玩家攻速的倍率。
export const WEAPONS = [
  {
    id: "pistol",
    name: "手枪",
    tier: 1,
    kind: "shot",
    color: "#ffd166",
    description: "可靠的初始武器。",
    damageMul: 1,
    rate: 1.0,
    projSpeed: 760,
    count: 1,
    spread: 0,
    pierce: 0,
    radius: 6,
    life: 1.25,
    aoe: 0,
    critBonus: 0,
  },
  {
    id: "smg",
    name: "冲锋枪",
    tier: 1,
    kind: "shot",
    color: "#ffb86b",
    description: "极高射速，单发伤害较低。",
    damageMul: 0.5,
    rate: 2.4,
    projSpeed: 820,
    count: 1,
    spread: 0.18,
    pierce: 0,
    radius: 5,
    life: 1.0,
    aoe: 0,
    critBonus: 0,
  },
  {
    id: "shotgun",
    name: "霰弹枪",
    tier: 2,
    kind: "spread",
    color: "#ff9f43",
    description: "一次喷出多发弹丸。",
    damageMul: 0.5,
    rate: 0.55,
    projSpeed: 700,
    count: 5,
    spread: 0.4,
    pierce: 0,
    radius: 5,
    life: 0.7,
    aoe: 0,
    critBonus: 0,
  },
  {
    id: "revolver",
    name: "左轮手枪",
    tier: 2,
    kind: "shot",
    color: "#ff8a36",
    description: "高伤害并可穿透一个目标。",
    damageMul: 2.4,
    rate: 0.7,
    projSpeed: 900,
    count: 1,
    spread: 0,
    pierce: 1,
    radius: 6,
    life: 1.3,
    aoe: 0,
    critBonus: 0.15,
  },
  {
    id: "laser",
    name: "激光枪",
    tier: 3,
    kind: "laser",
    color: "#68d8e8",
    description: "高速穿透光束。",
    damageMul: 1.0,
    rate: 1.3,
    projSpeed: 1150,
    count: 1,
    spread: 0,
    pierce: 2,
    radius: 4,
    life: 0.55,
    aoe: 0,
    critBonus: 0,
  },
  {
    id: "rocket",
    name: "火箭炮",
    tier: 3,
    kind: "rocket",
    color: "#ff647c",
    description: "爆炸造成范围伤害。",
    damageMul: 2.6,
    rate: 0.45,
    projSpeed: 560,
    count: 1,
    spread: 0,
    pierce: 0,
    radius: 10,
    life: 1.6,
    aoe: 95,
    critBonus: 0,
  },
  {
    id: "blade",
    name: "能量刃",
    tier: 4,
    kind: "orbit",
    color: "#7bed9f",
    description: "环绕玩家的旋转刀刃。",
    damageMul: 1.2,
    rate: 0,
    projSpeed: 0,
    count: 1,
    spread: 0,
    pierce: 0,
    radius: 14,
    life: 0,
    aoe: 0,
    critBonus: 0,
    orbitSpeed: 2.6,
    orbitRadius: 72,
  },
];

// 被动道具：敌人掉落 / 商店购买，可叠加。
export const ITEMS = [
  { id: "muscle", name: "肌肉纤维", tier: 1, description: "伤害 +8%", apply: (p) => { p.damage *= 1.08; } },
  { id: "boots", name: "疾风之靴", tier: 1, description: "移速 +10%", apply: (p) => { p.speed *= 1.1; } },
  { id: "armorplate", name: "装甲板", tier: 1, description: "护甲 +1", apply: (p) => { p.armor += 1; } },
  { id: "vitality", name: "活力胶囊", tier: 1, description: "最大生命 +15 并恢复", apply: (p) => { p.maxHp += 15; p.hp = Math.min(p.maxHp, p.hp + 15); } },
  { id: "magnet", name: "磁力线圈", tier: 2, description: "拾取范围 +30%", apply: (p) => { p.pickupRange *= 1.3; } },
  { id: "scope", name: "精准瞄准镜", tier: 2, description: "暴击率 +8%", apply: (p) => { p.critChance = Math.min(0.75, p.critChance + 0.08); } },
  { id: "battery", name: "能量电池", tier: 2, description: "技能冷却 -10%", apply: (p) => { p.skillCooldownMax *= 0.9; p.skillCooldown = Math.min(p.skillCooldown, p.skillCooldownMax); } },
  { id: "regen", name: "再生细胞", tier: 2, description: "每秒恢复 +1 生命", apply: (p) => { p.regen += 1; } },
  { id: "adrenaline", name: "肾上腺素", tier: 2, description: "攻速 +12%", apply: (p) => { p.attackRate *= 1.12; } },
  { id: "piercer", name: "穿甲弹头", tier: 3, description: "弹丸穿透 +1", apply: (p) => { p.pierce = Math.min(4, p.pierce + 1); } },
  { id: "lifesteal", name: "吸血獠牙", tier: 3, description: "击杀回复 2 生命", apply: (p) => { p.lifesteal += 2; } },
  { id: "greed", name: "拾荒者徽章", tier: 3, description: "金币掉落 +40%", apply: (p) => { p.goldBonus += 0.4; } },
  { id: "berserk", name: "狂战士之血", tier: 4, description: "伤害 +20%，最大生命 -10", apply: (p) => { p.damage *= 1.2; p.maxHp = Math.max(50, p.maxHp - 10); p.hp = Math.min(p.hp, p.maxHp); } },
  { id: "giantheart", name: "巨人之心", tier: 4, description: "最大生命 +30，每秒恢复 +1", apply: (p) => { p.maxHp += 30; p.regen += 1; } },
];

// 升级条目：带稀有度等级，可多次选择直至满级。
export const UPGRADE_POOL = [
  { id: "power", name: "力量训练", tier: 1, maxLevel: 5, description: "伤害 +20%", apply: (p) => { p.damage *= 1.2; } },
  { id: "rapid", name: "快速装填", tier: 1, maxLevel: 5, description: "攻速 +12%", apply: (p) => { p.attackRate *= 1.12; } },
  { id: "boots", name: "轻盈战靴", tier: 1, maxLevel: 4, description: "移速 +10%", apply: (p) => { p.speed *= 1.1; } },
  { id: "vitality", name: "生命强化", tier: 1, maxLevel: 5, description: "最大生命 +20 并恢复", apply: (p) => { p.maxHp += 20; p.hp = Math.min(p.maxHp, p.hp + 20); } },
  { id: "magnet", name: "经验磁铁", tier: 1, maxLevel: 3, description: "拾取范围 +25%", apply: (p) => { p.pickupRange *= 1.25; } },
  { id: "multishot", name: "多重射击", tier: 2, maxLevel: 3, description: "额外发射 1 枚弹丸", apply: (p) => { p.projectileCount = Math.min(6, p.projectileCount + 1); } },
  { id: "pierce", name: "穿透弹头", tier: 2, maxLevel: 3, description: "弹丸额外穿透 1 个目标", apply: (p) => { p.pierce = Math.min(4, p.pierce + 1); } },
  { id: "plating", name: "复合护甲", tier: 2, maxLevel: 4, description: "护甲 +2", apply: (p) => { p.armor += 2; } },
  { id: "regeneration", name: "自愈因子", tier: 2, maxLevel: 3, description: "每秒恢复 +1 生命", apply: (p) => { p.regen += 1; } },
  { id: "precision", name: "精准瞄具", tier: 2, maxLevel: 4, description: "暴击率 +8%", apply: (p) => { p.critChance = Math.min(0.6, p.critChance + 0.08); } },
  { id: "jetpack", name: "喷气背包", tier: 2, maxLevel: 1, description: "额外获得一次跳跃（三连跳）", apply: (p) => { p.maxJumps = Math.min(4, p.maxJumps + 1); } },
  { id: "giant", name: "巨人之力", tier: 3, maxLevel: 2, description: "伤害 +35%，攻速 -10%", apply: (p) => { p.damage *= 1.35; p.attackRate *= 0.9; } },
  { id: "swift", name: "疾风步", tier: 3, maxLevel: 2, description: "移速 +25%", apply: (p) => { p.speed *= 1.25; } },
  { id: "lifesteal", name: "吸血獠牙", tier: 3, maxLevel: 3, description: "击杀回复 2 生命", apply: (p) => { p.lifesteal += 2; } },
  { id: "greed", name: "贪婪", tier: 3, maxLevel: 3, description: "金币掉落 +50%", apply: (p) => { p.goldBonus += 0.5; } },
  { id: "overload", name: "超载核心", tier: 4, maxLevel: 1, description: "伤害 +50%", apply: (p) => { p.damage *= 1.5; } },
  { id: "titan", name: "泰坦之躯", tier: 4, maxLevel: 1, description: "最大生命 +40，护甲 +2", apply: (p) => { p.maxHp += 40; p.armor += 2; } },
  { id: "splitfire", name: "分裂弹", tier: 4, maxLevel: 1, description: "额外发射 2 枚弹丸", apply: (p) => { p.projectileCount = Math.min(8, p.projectileCount + 2); } },
];

// 商店中的“自我升级”服务：使用金钱永久强化自身（保持固定价格，可重复购买）。
export const SHOP_SERVICES = [
  { id: "heal", name: "战地医疗包", description: "花费 8 金币，恢复 35 生命。", cost: 8, apply: (p) => { p.hp = Math.min(p.maxHp, p.hp + 35); } },
  { id: "damage", name: "武器校准", description: "花费 14 金币，伤害 +10%。", cost: 14, apply: (p) => { p.damage *= 1.1; } },
  { id: "armor", name: "装甲插片", description: "花费 12 金币，护甲 +1。", cost: 12, apply: (p) => { p.armor += 1; } },
  { id: "haste", name: "冷却模块", description: "花费 16 金币，主动技能冷却 -12%。", cost: 16, apply: (p) => { p.skillCooldownMax *= 0.88; p.skillCooldown = Math.min(p.skillCooldown, p.skillCooldownMax); } },
  { id: "vitality", name: "生命扩容", description: "花费 12 金币，最大生命 +15。", cost: 12, apply: (p) => { p.maxHp += 15; p.hp = Math.min(p.maxHp, p.hp + 15); } },
  { id: "speed", name: "动力外骨骼", description: "花费 12 金币，移速 +8%。", cost: 12, apply: (p) => { p.speed *= 1.08; } },
];

export const WEAPON_COST = [0, 25, 45, 70, 100];
export const ITEM_COST = [0, 20, 38, 60, 90];

export function getPlayerClass(classId) {
  return PLAYER_CLASSES.find((playerClass) => playerClass.id === classId) ?? PLAYER_CLASSES[0];
}

export function getWeapon(weaponId) {
  return WEAPONS.find((weapon) => weapon.id === weaponId) ?? null;
}

export function getItem(itemId) {
  return ITEMS.find((item) => item.id === itemId) ?? null;
}

export function getUpgrade(upgradeId) {
  return UPGRADE_POOL.find((upgrade) => upgrade.id === upgradeId) ?? null;
}
