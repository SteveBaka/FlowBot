# WeFlow OneBot Docker

将 WeFlow（微信聊天记录管理）+ OneBot v11 协议 + 微信 Linux 客户端打包为 Docker 容器，提供 WebUI 管理面板。

## 架构图

```
┌───────────────────────────────────────────────────────────────┐
│                      Docker Container                          │
│                                                               │
│  ┌──────────┐   ┌──────────┐   ┌────────────────────┐       │
│  │   Xvfb   │──▶│  x11vnc  │──▶│     noVNC          │       │
│  │ :99      │   │ :5900    │   │   :6080 (Web)      │       │
│  └──────────┘   └──────────┘   └────────────────────┘       │
│       │                                              ↑        │
│       ▼                                              │        │
│  ┌──────────┐   ┌─────────────────┐   ┌─────────────────┐   │
│  │  WeChat  │◀──│  messagePush    │──▶│   BotManager     │   │
│  │ (Weixin) │   │  Service        │   │  (OneBotServer)  │   │
│  │ GUI窗口  │   │  (消息检测)      │   │   :3001          │   │
│  └──────────┘   └────────┬────────┘   └────────┬────────┘   │
│       ▲                   │                      │            │
│       │                   ▼                      │            │
│       │           ┌──────────────┐               │            │
│       └───────────│  WeFlow      │◀──────────────┘            │
│                   │  (Electron)  │  send_private_msg          │
│                   │  :5031 API   │  send_group_msg             │
│                   └──────┬───────┘  send_msg                   │
│                          │                                     │
│                 ┌────────▼────────┐                            │
│                 │    WebUI        │◀──── Vue 3 SPA             │
│                 │  :5099 (Web)    │     voice_studio style     │
│                 └─────────────────┘                            │
└───────────────────────────────────────────────────────────────┘

外部服务:
  http://IP:5099  ──▶ WebUI 管理面板
  http://IP:6080  ──▶ noVNC 虚拟桌面（操作微信 GUI）
  http://IP:3001  ──▶ OneBot v11 API（AstrBot/NapCat 等对接）
  http://IP:5031  ──▶ WeFlow HTTP API（可选，容器内通信）
```

## OneBot 双向消息链路

```
入站（外部 → 微信）:
  AstrBot/NapCat
    │ HTTP POST /send_private_msg 或 WebSocket 帧
    ▼
  OneBotServer (:3001)
    │ emit('api:send_private_msg', { user_id, message })
    ▼
  BotManager callback → main.ts
    │ getEnhancedMessageSender().sendMessage(content, contactName)
    ▼
  LinuxSender (xdotool)
    │ xdotool search → 窗口激活 → xclip → Ctrl+V → Enter
    ▼
  WeChat 窗口发送消息

出站（微信 → 外部）:
  WeChat DB 文件变更
    │ wcdbService.setMonitor callback
    ▼
  messagePushService.handleDbMonitorChange
    │ 检测新消息 → broadcastToAllBots()
    ▼
  OneBotServer → WS/HTTP clients
    │ { post_type: 'messages:batch', data: [...] }
    ▼
  AstrBot/NapCat 接收消息
```

## 端口说明

| 端口 | 用途 | 映射 | 说明 |
|------|------|------|------|
| **5099** | WebUI 管理面板 | 必须 | 浏览器管理配置、Bot 管理、日志查看 |
| **6080** | noVNC 虚拟桌面 | 必须 | 浏览器操作微信 GUI（登录、搜索联系人） |
| **3001** | OneBot v11 API | 必须 | 机器人框架（AstrBot/NapCat 等）双向对接 |
| **5031** | WeFlow HTTP API | 可选 | RESTful 接口，容器内自动启用，外部按需映射 |
| **5900** | VNC 内部 | 不映射 | 仅 noVNC 通过 6080 代理访问 |

## 快速开始

### 1. 构建镜像

```bash
cd /path/to/WeFlow
docker build -f docker/Dockerfile -t weflow-onebot .
```

### 2. 启动容器

```bash
docker run -d --name weflow \
  --cap-add=SYS_PTRACE \
  -p 3001:3001 \
  -p 5099:5099 \
  -p 6080:6080 \
  weflow-onebot
```

> `--cap-add=SYS_PTRACE` 是获取数据库密钥时 ptrace hook 微信进程所必需的。

### 3. 首次配置

1. 浏览器打开 `http://IP:5099` — WebUI 管理面板
2. 接受免责声明
3. 浏览器打开 `http://IP:6080/vnc.html` — noVNC 虚拟桌面
4. 在虚拟桌面中登录微信
5. 回到 WebUI → 账号管理 → 添加账号 → 配置密钥
6. 配置完成后，OneBot API 即可使用

## WebUI 管理面板

访问 `http://IP:5099`，使用 voice_studio 样式 + capsule 主题切换（深色/浅色/系统）。

| 标签页 | 功能 |
|--------|------|
| 首页 | 登录状态、OneBot 状态、账号信息、数据库连接、系统信息 |
| Bot 配置 | 添加/管理多个 Bot（HTTP/WS 模式、服务端/客户端），实际启动 OneBotServer 实例 |
| 聊天 & 消息过滤 | 消息推送开关、过滤模式（全部/白名单/黑名单）、发送模式 |
| 账号管理 | 添加/删除/切换账号，跳转 noVNC 登录 |
| 设置 | WeFlow HTTP API 配置、消息设置、日志开关 |
| 关于 | 版本信息、免责声明、端口映射、Docker 提示 |

## Bot 配置流程

### WebUI 操作

1. 进入"Bot 配置"页面
2. 点击"+ 添加 Bot"按钮
3. 选择连接模式（HTTP / WebSocket）
4. WebSocket 模式下选择方向（服务端 / 客户端）
5. 填写名称、地址（默认 127.0.0.1）、端口（默认 3001）、Token（自动生成）
6. 保存后，Bot 实例自动启动

### 实际启动逻辑

```
WebUI 保存 bots 配置
  │ POST /api/v1/mgmt/config { bots: "[{...}]" }
  ▼
httpService → electron-store 写入 'bots' 键
  │ WeFlow 启动时读取 bots 配置
  ▼
main.ts → botManager.startBotManager(rawBots)
  │ 遍历 enabled=true 的 bot
  ▼
botManager → 为每个 bot 创建 OneBotServer 实例
  │ 监听指定端口，处理 HTTP/WS 请求
  ▼
外部服务 (AstrBot等) 连接 :3001
```

### API 端点

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/api/v1/mgmt/bots/start` | 启动所有 bot 实例 |
| POST | `/api/v1/mgmt/bots/stop` | 停止所有/指定 bot |
| POST | `/api/v1/mgmt/bots/restart` | 重启指定 bot |
| GET | `/api/v1/mgmt/bots/status` | 查询所有 bot 运行状态 |

## WeFlow HTTP API

RESTful 接口，Docker 内自动启用（无需 token）：

```
GET  /health                        健康检查
GET  /api/v1/sessions               会话列表
GET  /api/v1/messages?talker=xxx    消息查询
GET  /api/v1/contacts               联系人列表
POST /api/v1/messages/send          发送消息
GET  /api/v1/mgmt/config            读取配置
POST /api/v1/mgmt/config            写入配置
GET  /api/v1/mgmt/system            系统信息
```

## 操作流程

```
start.sh 启动容器
  │
  ├── dbus-daemon --system          （DBus 服务）
  ├── WebUI server.js               （:5099 Vue SPA + API 代理 → :5031）
  ├── Xvfb :99                      （虚拟显示 1600x900）
  ├── Fluxbox                       （窗口管理器 + 底部任务栏）
  ├── x11vnc :5900                  （VNC 服务）
  ├── noVNC :6080                   （Web VNC 客户端）
  ├── WeChat                        （/opt/wechat/wechat）
  ├── WeFlow Electron               （:5031 HTTP API + :3001 OneBot）
  │     ├── 自动启用 HTTP API (:5031)
  │     ├── 读取 bots 配置 → 启动 OneBotServer 实例
  │     └── 生成 API Token（写入 /opt/weflow/data/http-api-token.txt）
  └── 所有服务就绪
```

## 数据持久化

```bash
docker run -d --name weflow \
  --cap-add=SYS_PTRACE \
  -v weflow-data:/opt/weflow/data \
  -v weflow-config:/root/.config \
  -p 3001:3001 \
  -p 5099:5099 \
  -p 6080:6080 \
  weflow-onebot
```

| 挂载点 | 内容 |
|--------|------|
| `/opt/weflow/data` | WeFlow 运行数据、WebUI 配置、Bot 配置、API Token |
| `/root/.config` | WeFlow 配置文件（electron-store，含数据库密钥等） |

## Git 分支

| 分支 | 说明 |
|------|------|
| `feat/windows-message-sending` | Windows 消息发送插件（不包含 Linux/Docker 改动） |
| `feat/linux-docker-webui` | Linux/Docker 容器化 + Vue WebUI + OneBot 双向链路 |

所有 Linux/Docker 相关改动均在 `feat/linux-docker-webui` 分支上。

## 关键技术决策

| 决策 | 说明 |
|------|------|
| **消息发送** | 使用 xdotool + xclip 模拟键盘操作，无需 Wine/CrossOver |
| **密钥获取** | xkey_helper_linux 通过 ptrace hook 微信进程内存，需要 `SYS_PTRACE` 权限 |
| **OneBot 双向** | OneBotServer 实现 HTTP + 自定义 WebSocket，支持外部框架发送/接收消息 |
| **配置存储** | electron-store JSON 文件，WebUI 通过 HTTP API 管理端点读写 |
| **Vue SPA** | 本地化 vendor 文件（vue/vue-router），无需外网 CDN |
