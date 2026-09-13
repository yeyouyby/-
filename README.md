# 荒原小队

一个面向局域网的多人 2D 横版生存乱斗网页游戏。服务端采用权威状态同步，玩家只发送输入，移动、战斗、敌人和胜负均由服务端计算。

## 功能

- 创建、搜索、邀请码加入房间，支持 2–8 人
- 合作 PvE：5 个逐渐增强的怪物波次，波次之间有和平时间用于逛商店
- 多人 PvP：自动锁定射击、最后存活者获胜
- 横版移动、跳跃（含二段跳）、平台碰撞和镜头跟随
- 4 个职业：突击手、守卫、医师、游侠，各自拥有 E 键主动技能
- 类幸存者游戏成长：自动攻击、经验升级、三选一强化、穿透/暴击/护甲/自愈
- 升级条目带稀有度等级（普通/稀有/史诗/传说），可多次选择直至满级
- 武器与道具系统：7 种武器、14 种被动道具，可由敌人掉落或商店购买
- 金币、商店（自我升级 + 购买武器/道具）、背包、精英怪、Boss 和宝箱掉落
- 敌人掉落经验球、金币，以及武器/道具；Boss 掉落宝箱
- 程序化生成的地图：随机平台、塔楼、立柱与岩石装饰
- 房主迁移、断线清理、15Hz 状态广播、30Hz 权威游戏循环
- Canvas 网页客户端，无需安装客户端

## Windows 启动

1. 安装 [Node.js 20 LTS](https://nodejs.org/) 或更高版本。
2. 解压项目后双击 `start-windows.bat`。
3. 第一次启动会自动执行 `npm install`。
4. 如果 Windows 防火墙弹窗询问，选择允许“专用网络”访问。
5. 开服电脑访问 `http://localhost:3000`，其他同局域网设备访问终端打印的 `局域网访问` 地址。

如果没有弹出防火墙提示，可用管理员 PowerShell 执行一次：

```powershell
New-NetFirewallRule -DisplayName "Lan Battle 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```

也可以右键 `start-windows.ps1` 选择“使用 PowerShell 运行”。如果系统阻止脚本，可在当前窗口执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-windows.ps1
```

## 通用启动

要求 Node.js 20 或更高版本。

```bash
npm install
npm start
```

服务默认监听所有网卡的 `3000` 端口，并在终端打印可用地址。

- 开服电脑访问：`http://localhost:3000`
- 同一局域网设备访问：`http://<开服电脑局域网IP>:3000`

如果其他设备无法访问，请允许 TCP `3000` 端口通过系统防火墙。可通过环境变量修改监听配置：

```bash
HOST=0.0.0.0 PORT=8080 npm start
```

## 操作

- `A` / `D` 或方向键：左右移动
- `W` / `空格` / 上方向键：跳跃，空中可再次按下进行二段跳
- `E`：释放职业主动技能
- `Tab`：打开/关闭商店
- `B`：打开/关闭背包
- 武器自动锁定射程内最近目标并攻击
- 拾取绿色能量球升级，每次升级在带品质等级的三项强化中选择一项
- 拾取金币、宝箱、武器与道具（敌人掉落），在和平时间打开商店购买恢复或永久强化

## 职业

| 职业 | 定位 | 主动技能 |
| --- | --- | --- |
| 突击手 | 均衡输出 | 弹幕爆发：朝最近目标或面朝方向连射 8 发弹丸 |
| 守卫 | 高生命、高护甲 | 能量护盾：获得临时护盾并短暂无敌 |
| 医师 | 团队续航 | 急救脉冲：治疗附近队友，合作模式可扶起倒地队友 |
| 游侠 | 高机动、高攻速 | 闪避冲刺：向面朝方向冲刺并短暂无敌 |

## 服务端协议

Socket.IO 客户端连接后可使用以下事件：

| 方向 | 事件 | 数据 |
| --- | --- | --- |
| 客户端 → 服务端 | `room:create` | `{ playerName, classId, roomName, mode, maxPlayers }` |
| 客户端 → 服务端 | `room:join` | `{ playerName, classId, code }` |
| 客户端 → 服务端 | `room:ready` | `{ ready }` |
| 客户端 → 服务端 | `game:start` | 无 |
| 客户端 → 服务端 | `game:input` | `{ left, right, jump, skill }` |
| 客户端 → 服务端 | `upgrade:choose` | 强化 ID |
| 客户端 → 服务端 | `shop:buy` | 商品 ID |
| 服务端 → 客户端 | `room:state` | 完整房间状态 |
| 服务端 → 客户端 | `game:start` | 地图和模式 |
| 服务端 → 客户端 | `game:snapshot` | 玩家、敌人、弹丸、掉落状态 |
| 服务端 → 客户端 | `upgrade:choices` | 三个强化选项 |
| 服务端 → 客户端 | `game:end` | 胜负结果 |

需要回执的房间操作采用 Socket.IO acknowledgement，格式为 `{ ok, room?, error? }`。

## 项目结构

```text
src/
  server.js          HTTP 与 Socket.IO 入口
  room-manager.js    房间生命周期和玩家管理
  game.js            权威游戏循环与战斗逻辑
  config.js          游戏数值和强化池
public/
  index.html         大厅、房间和游戏界面
  client.js          输入、网络同步和 Canvas 渲染
test/                核心房间与游戏逻辑测试
```

## 检查

```bash
npm test
npm run check
```
