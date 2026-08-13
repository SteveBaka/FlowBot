# 发送延时控制 — 分析报告与实施方案

> 创建时间：2026-08-13
> 基线分支：`main`
> 状态：**P0 已实施（代码完成 + vite 构建通过）**，待 asar 重打包部署容器
> 目的：控制/缩短 Linux 容器发送消息的延时，借助身份库减少定位开销，为后期制作提供定位排查索引。

## 一、现状：发送链路与耗时拆解

### 1.1 发送链路（HTTP 插件通道）

```
AstrBot 适配器 → POST /api/v1/messages/send (7400 插件 API)
  → httpService.handleSendMessage
  → sendViaLinuxSender                        (electron/services/httpService.ts:2854)
    → resolveSessionDisplayName               (electron/services/httpService.ts:2935)
        ├─ chatService.getContact(id)         ← WCDB 查询 ①
        └─ getDisplayNames([id])              ← WCDB 查询 ②
    → getEnhancedMessageSender().sendMessage  (electron/plugins/enhancedMessageSender)
      → LinuxSender.sendMessage               (electron/plugins/platforms/linux.ts:366)
        → 入队 queue                           (linux.ts:103, 390)
        → processQueue                         (linux.ts:396)
          → doSend                             (linux.ts:282)
            → searchAndSelectContact           (linux.ts:204)
            → ensureFocusInInput               (linux.ts:234)
            → pasteAndSend                     (linux.ts:253)
```

### 1.2 耗时拆解（单条消息）

| 阶段 | 位置 | 固定延时 | 说明 |
|---|---|---|---|
| 队列间隔 | `linux.ts:18` `INTER_MESSAGE_DELAY_MS` | **800ms** | 每条消息固定间隔（基于 lastSendTime） |
| 激活窗口 | `linux.ts:161-184` `activateWindow` | 150–400ms | windowactivate/focus + 校验重试 |
| 打开搜索 | `linux.ts:206` | 400ms | Ctrl+F |
| 输入名字 | `linux.ts:210-224` | 100+600ms | Ctrl+A + 打字（`--delay 30`/字符）或**拼音子进程** |
| 选中联系人 | `linux.ts:227-228` | 400ms | Enter |
| 聚焦输入框 | `linux.ts:247-250` | 80+200ms | 计算坐标(0.70w, h-100) + 点击(`INPUT_CLICK_DELAY_MS`) |
| 粘贴 | `linux.ts:266-272` | 文本 100+300ms / 图片 200+500ms | xclip + Ctrl+V |
| 发送+稳定 | `linux.ts:275-276` | 500ms | Enter + `POST_SEND_SETTLE_MS` |

**单条文本 ≈ 3.5–5s**；图片 +0.5s；中文名拼音慢时最多 +3s。

### 1.3 关键常量（linux.ts 顶部）

```typescript
const MAX_RETRIES = 3                       // 失败重试次数
const RETRY_DELAY_MS = 1500                 // 重试间隔（固定）
const INTER_MESSAGE_DELAY_MS = 800          // 队列消息间隔（固定）
const POST_SEND_SETTLE_MS = 500             // 发送后稳定等待
const INPUT_CLICK_DELAY_MS = 200            // 点击输入框后等待
```

### 1.4 每次发送的固定开销（可消除部分）

- `resolveSessionDisplayName`（httpService:2935）：每次 **2 次 WCDB 查询**（getContact + getDisplayNames），且返回结果只在本次使用，无跨发送缓存。
- 中文名每次调用 `python3 /opt/pinyin.py`（linux.ts:193，子进程，timeout 3s）做拼音转换，无缓存。

## 二、身份库如何加速"定位"（降延时核心）

身份库 `/opt/weflow/data/identity.db`（WebUI server.js 维护，`docker/webui/server.js:1234` 起）已存：

- `contacts` 表：`real_wxid / custom_wxid / display_name / nickname / avatar_url / type / numeric_id / updated_at / dirty`
- `group_nicknames` 表：`session_id / member_wxid / nickname / avatar_url`
- `meta` 表：`self_wxid` 等
- 同步机制：30min 全量（`fullSyncIdentityDb`）+ 5min 群名（`syncBotGroupNicknames`）+ 消息推送实时（`rememberSelfWxid`/`rememberAvatar`）

**当前 electron 发送侧不读身份库**（仅 WebUI 进程持有）。同容器同文件系统，electron 可用 `node:sqlite` 直接读 `/opt/weflow/data/identity.db`。

| 加速点 | 现状开销 | 身份库方案 |
|---|---|---|
| 显示名解析 | 每次 2 次 WCDB | 读 `contacts.display_name/custom_wxid` 一次命中 |
| 拼音转换 | 每次中文名起子进程（≤3s） | 新增 `pinyin(display_name→pinyin)` 缓存表 |
| 群昵称定位 | @ 目标名每次 WCDB 群昵称查询 | 读 `group_nicknames` 直接取 |
| 自定义 wxid | alias↔real_wxid 反查 | `customWxidLibrary` 双向映射一次命中 |
| 首发成功率 | 名字错/重名 → 重试 | 身份库精确名 + 目标校验 → 少重试 |

## 三、发送延时控制方案（三层）

### L1 参数化延时（P0，推荐先行）

- `INTER_MESSAGE_DELAY_MS` 及各 UI step 延时（搜索 settle 600ms / 点击 200ms / 粘贴 / 发送 settle 500ms）全部**配置化**。
- 三档预设：`安全 / 标准 / 激进`（激进档缩 30–50%，靠失败自动回退兜底）。
- 配置入口：WebUI 设置页（复用现有 config 机制）或 config 文件。

### L2 自适应背压（P1）

- 连续成功 → 间隔动态缩短（下限保护，如 300ms）。
- 失败 → 指数退避（1.5s→3s→6s，替代固定 `RETRY_DELAY_MS`）。
- 连续失败 N 次 → 队列冷却暂停（如 30s），避免雪崩。

### L3 队列优化（P1）

- 同联系人连续文本**合并**（可配置开关，省多次"搜索+选人"）。
- **优先级队列**（重要消息插队）。
- **去重**（同目标同内容合并，避免重复发送）。

## 四、与身份库的衔接（数据流）

```
identity.db（WebUI 维护，30min 全量 + 5min 群名同步）
  ├─ contacts.display_name / custom_wxid / nickname / avatar_url
  ├─ group_nicknames（成员群昵称）
  └─ 新增：pinyin 缓存表（display_name → pinyin）
        ↓ electron 发送侧 node:sqlite 直读（同容器文件系统）
  sendViaLinuxSender
  ├─ 显示名一次命中（免 WCDB）→ 缩短定位
  ├─ 拼音一次命中（免子进程）→ 缩短输入
  └─ 目标校验（wxid/群名/自定义 wxid）→ 提高首发成功率（少重试）
```

## 五、风险与边界

| 风险 | 边界/缓解 |
|---|---|
| 微信 UI 稳定性 | 延时过小易"搜索未完成/选错人/未发出" → 分级预设 + 失败自动回退到慢档 |
| 身份库新鲜度 | display_name/群名变更 → 现有 30min/5min 同步 + 发送失败回退 WCDB 兜底 |
| 拼音准确性 | `pinyin.py` 为唯一权威源，缓存需与之一致（同步时计算，失效随群名同步） |
| OneBot 兼容性 | OneBot 走 `botManager`，不经 LinuxSender 队列 → 零影响 |
| 并发/重入 | `processQueue` 有 `this.processing` 防重入锁（linux.ts:397-398），优化时需保持 |

## 六、落地路线

- **P0（已实施）**：延时参数化（三档预设）+ 身份库显示名/拼音缓存 → 单条发送 3.5–5s → 2–3s
  - 实施文件：`electron/services/config.ts`（新增 `sendDelayMode` schema+默认值）
  - `electron/plugins/platforms/linux.ts`（`DELAY_PROFILES` 三档、`getDelayMode()`、`toPinyin` 拼音缓存 + 持久化 `pinyin-cache.json`）
  - `electron/services/httpService.ts`（`queryIdentityName()` 直读 identity.db，`resolveSessionDisplayName` 优先命中）
  - 档位切换：环境变量 `SEND_DELAY_MODE` 或 config `sendDelayMode`（safe/standard/aggressive），默认 standard
- **P1**：自适应背压 + 队列合并/优先级
- **P2**：WebUI 可视化控制面板（延时档位/间隔/队列状态）

## 七、排查定位索引（后期制作/排查用）

### 关键文件与行号（main）

| 关注点 | 位置 |
|---|---|
| 队列间隔常量 | `electron/plugins/platforms/linux.ts:18` |
| 队列结构/入队 | `linux.ts:103`、`linux.ts:379-393` |
| 队列处理/重试 | `linux.ts:396-438` |
| 搜索+选人 | `linux.ts:204-232` |
| 聚焦输入框 | `linux.ts:234-251` |
| 粘贴+发送 | `linux.ts:253-280` |
| 拼音子进程 | `linux.ts:190-202` |
| 发送入口(HTTP) | `electron/services/httpService.ts:2829-2853`（sendViaLinuxSender） |
| 显示名解析 | `httpService.ts:2935-2961`（resolveSessionDisplayName） |
| 图片输入归一化 | `httpService.ts:2963+`（prepareImageInput） |
| 身份库（WebUI） | `docker/webui/server.js:1234-1410`（identityMemory/表/同步） |
| 会话头像/群名 enrich | `docker/webui/server.js:1120-1136` |
| 群成员 API | `httpService.ts:1394-1436`（handleGroupMembers） |
| 会话 API | `httpService.ts:1248-1302`（handleSessions） |

### 排查要点

1. 发送慢：先看 `container.log` 的 `[LinuxSender]` 每步日志（"Waiting Xms before next send"、"Search complete"、"Message sent"）定位是队列间隔还是某 UI 步骤耗时。
2. 发送失败/重试：看 `[LinuxSender] ... failed (attempt N/3), retrying` → 排查 `RETRY_DELAY_MS` 与目标定位是否准确。
3. 中文名慢：日志中 `→ pinyin "..."` 前后时间差即拼音子进程耗时（>3s 命中 timeout）。
4. 身份库未命中：检查 `identity.db` 中该 wxid 的 `display_name`/`custom_wxid` 是否存在；确认同步任务运行（`fullSyncIdentityDb`/`syncBotGroupNicknames`）。
