# FlowBOT 

<p align="center">
  <img src="docker/webui/public/icon.png" alt="FlowBOT" width="60" style="vertical-align: middle;" />&nbsp;&nbsp;<i>We Chat with AI Bot.</i>
</p>

FlowBot 是一个基于 [WeFlow](https://github.com/hicccc77/WeFlow) 的基础之上，增加了[OneBot v11](https://github.com/botuniverse/onebot-11) 协议，旨在为 `WeFlow` Linux 客户端增加聊天协议转换，并提供 WebSocket/HTTP 支持及 WebUI 管理。 

关于[WeFlow](https://github.com/hicccc77/WeFlow)的使用说明敬请移步至 WeFlow 的仓库，并且可以的话为原仓库点亮Star。
<p align="center">
  <a href="https://github.com/SteveBaka/FlowBot/stargazers"><img src="https://img.shields.io/github/stars/SteveBaka/FlowBot?style=flat&label=Stars&labelColor=2A3B4C&color=60A5FA" alt="Stargazers"></a>
  <a href="https://github.com/SteveBaka/FlowBot/network/members"><img src="https://img.shields.io/github/forks/SteveBaka/FlowBot?style=flat&label=Forks&labelColor=2A3B4C&color=60A5FA" alt="Forks"></a>
  <a href="https://github.com/SteveBaka/FlowBot/releases"><img src="https://img.shields.io/github/downloads/SteveBaka/FlowBot/total?style=flat&label=Downloads&labelColor=2A3B4C&color=60A5FA" alt="Downloads"></a>
  <a href="https://t.me/ffffflowbot"><img src="https://img.shields.io/badge/Telegram-通知-60A5FA?style=flat&logo=telegram&logoColor=white&labelColor=2A3B4C&color=60A5FA" alt="Telegram Notification" style="height: 24px; vertical-align: middle;"></a>
</p>

<p align="center">
  <img src="app.jpg" alt="WeFlow 应用预览" width="90%">
</p>

镜像内置 Linux 微信 v4.1.1.7  + WeFlow v4.5.1 (支持消息发送的修改版本) + noVNC 力求做到开箱即用的体验。

> ⚠️免责声明：FlowBot 旨在提供了一个能够让用户**学习并研究**能够与AI机器人进行聊天的协议，请在使用中注意平台的用户协议和规范，使用风险自负。

## 核心功能

| 功能 | 说明 |
|------|------|
| 文字双向传输 | 微信 ↔ AstrBot 文字消息实时同步 |
| 图片发送 | 微信图片推送到外部适配器（支持 base64 / URL 模式） |
| 图片接收 | 外部适配器图片推送到微信（仅v1.2版本之后支持） |
| 表情解析 | 支持推送GIF以及多种表情推送到外部适配器 |
| 视频接收 | 视频推送到外部适配器（支持 base64 / URL 模式） |
| 语音发送 | 外部适配器视频完整推送到微信 |
| 视频发送（实验性） | 视频推送到外部适配器（支持 base64 / URL 模式）【先行适配封面图和长度发送】 |

> ⚠️由于兼容 *图片双向发送功能* ， Onebot 协议目前无法在 Astrbot 中显示真实的账号，如介意且不在意图片发送至微信的情况，可以选用 V1.2 前的版本。
> 
> 经过多轮开发和测试， `AstrBot` 目前推荐使用 [FlowBot适配器](https://github.com/SteveBaka/astrbot_plugin_flowbot_adapter) 。
> 可在 `AstrBot 插件市场` 搜索 `FlowBot适配器` 并安装使用，解决了显示正确的 `xxx@Chatroom` 、`wxid` 的痛点。

## 快速开始

### 1. 启动容器（docker-compose 推荐）

创建项目目录，并放入 [`docker-compose.yml`](docker/docker-compose.yml)文件：

启动：

```bash
cd /path/to/FlowBOT
docker compose up -d
```

或手动 docker run：

```bash
docker run -d --name FlowBOT \
  --cap-add=SYS_PTRACE \
  --restart=always \
  -e TZ=Asia/Shanghai \
  -e VNC_PASSWORD=your_password_here \
  -v /your_folder_here/FlowBOT/data:/opt/weflow/data \
  -v /your_folder_here/FlowBOT/config:/root/.config \
  -v /your_folder_here/FlowBOT/xwechat_files:/root/xwechat_files \
  -p 7100:7100 \
  -p 7300:7300 \
  -p 7400:7400 \
  -p 7600:7600 \
  unsuited/flowbot:latest
```

> **注意**：首次使用前请修改 `VNC_PASSWORD` 为自定义强密码，避免他人通过 noVNC 登录。

> 使用 docker run指令时，请将 `/path/to` 修改为你想要存储的持久化的数据的文件夹路径。

> `--cap-add=SYS_PTRACE` 是获取数据库密钥时 ptrace hook 微信进程所必需的。

### 2. 查看日志和密码

```bash
# 查看容器日志（含 WebUI 登录密码）
docker logs FlowBOT 2>&1 | grep "WebUI Login Password"

# 查看完整日志
docker logs FlowBOT 2>&1
```

### 3. 首次配置

1. 浏览器打开 `http://你的IP:7300` — FlowBOT WebUI 管理面板
2. 按照账号管理页面的说明，在 `noVNC` 中先登录微信后再完成WeFlow的配置
3. 回到 WebUI → Bot 配置 → 添加Bot → 根据适配器的要求进行配置
4. 配置完成后，OneBot API 即可使用

### AstrBot 插件适配器（插件 API，端口 7400）

在「Bot 配置」页选择 **HTTP** 模式，在「服务类型」下拉中选择 **插件 API（AstrBot 适配器）**（默认端口 **7400**）：

```
HTTP API: http://你的IP:7400     鉴权: Authorization: Bearer <Bot Token>
WS 推送:  ws://你的IP:7400/api/v1/ws/messages?token=<Bot Token>
```

关闭该 bot 即停用插件 API，不影响 WebUI(7300) / OneBot(7100)。

## Bot 配置流程

1. 进入"Bot 配置"页面
2. 点击"+ 添加 Bot"按钮
3. 选择连接模式（HTTP / WebSocket）
4. WebSocket 模式下选择方向（服务端 / 客户端）
5. HTTP 模式下选择服务类型（OneBot HTTP 服务端 / 插件 API）
6. 填写名称、端口、Token（自动生成）
7. 保存后，Bot 实例自动启动

V1.4.0新增： Astrbot 插件[astrbot_plugin_flowbot_adapter](https://github.com/SteveBaka/astrbot_plugin_flowbot_adapter)，以获取实际账号。

## 构建镜像

如果你没有预构建的镜像，可以自行构建：

```bash
cd /path/to/WeFlow
docker build -f docker/Dockerfile -t flowbot:latest .
```

> 本地构建若 apt 无法直连 `archive.ubuntu.com`（如防火墙阻断 80 端口），可借助本地 apt-cacher-ng 代理：
> ```bash
> docker build --build-arg APT_PROXY=http://<apt-proxy-ip>:3142 -f docker/Dockerfile -t flowbot:latest .
> ```
> CI（GitHub Actions）构建默认使用官方源，无需该参数。

> 首次构建约 5-10 分钟（下载微信 deb 包 + 安装系统依赖）。

构建完成后更新 `docker-compose.yml` 中的 `image: flowbot:latest`，然后启动容器。

## 数据持久化

所有数据映射到项目目录下（docker-compose 使用相对路径）：

```
FlowBOT/
├── data/              ← /opt/weflow/data（运行数据、Bot 配置、容器日志）
│   ├── logs/
│   │   └── container.log
│   ├── webui-auth.json    ← WebUI 登录密码哈希（每次重启重新生成）
│   └── .vncpasswd         ← VNC 密码文件（VNC_PASSWORD 设置时生成）
├── config/            ← /root/.config（WeFlow 配置，含数据库密钥）
│   └── weflow/
│       ├── WeFlow-config.json
│       └── logs/
├── xwechat_files/     ← /root/xwechat_files（微信数据库）
│   └── all_users/
└── docker-compose.yml
```

> **容器更新时**：只需 `docker compose down && docker compose up -d`，数据不会丢失。

## OneBot 双向消息链路

```
入站（外部 → 微信）:
  AstrBot
    │ HTTP POST /send_private_msg 或 WebSocket 帧
    ▼
  OneBotServer (:7100)
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
  AstrBot 接收消息
```

## FlowBOT WebUI 管理面板

| 标签页 | 功能 |
|--------|------|
| 首页 | 登录状态、OneBot 状态、账号信息、数据库连接、系统信息 |
| Bot 配置 | 添加/管理多个 Bot（HTTP/WS 模式、服务端/客户端） |
| 聊天 & 消息过滤 | 消息推送开关、过滤模式（全部/白名单/黑名单） |
| 账号管理 | 添加/删除/切换账号，跳转 noVNC 登录 |
| 设置 | WeFlow HTTP API 配置、消息设置、日志开关 |
| 关于 | 版本信息、免责声明、端口映射 |

## 端口说明

| 端口 | 用途 | 映射 | 说明 |
|------|------|------|------|
| **7300** | FlowBOT WebUI | 必须 | 浏览器管理配置、Bot 管理、日志查看 |
| **7600** | noVNC 虚拟桌面 | 必须 | 浏览器操作微信 GUI（登录、搜索联系人） |
| **7100** | OneBot v11 API | 可选 | 机器人框架（AstrBot 等）双向对接 |
| **7400** | 插件 API | 可选 | AstrBot 适配器统一消息 API（Bot 配置中可开关） |
| **5031** | WeFlow HTTP API | 可选 | RESTful 接口，容器内自动启用，外部按需映射 |

## 操作流程

```
start.sh 启动容器
  │
  ├── dbus-daemon --system          （DBus 服务）
  ├── Xvfb :99                      （虚拟显示 1600x900）
  ├── Fluxbox                       （窗口管理器）
  ├── x11vnc :5900                  （VNC 服务）
  ├── noVNC :7600                   （Web VNC 客户端）
  ├── WeChat                        （/opt/wechat/wechat）
  ├── WeFlow Electron               （:5031 HTTP API + :7100 OneBot）
  │     ├── 自动启用 HTTP API (:5031)
  │     ├── 读取 bots 配置 → 启动 OneBotServer 实例（mode=plugin 跳过）
  │     └── 生成 API Token（写入 /opt/weflow/data/http-api-token.txt）
  ├── FlowBOT WebUI server.js       （:7300 Vue SPA + API 代理 → :5031）
  │     ├── 插件 API 服务（:7400，按 mode=plugin bot 配置启停）
  │     ├── SSE 消费 :5031/api/v1/push/messages → WS 推送 :7400
  │     └── 图片 token 自建（/api/image）
  └── 所有服务就绪，输出 banner（含 WebUI 登录密码）
```

## 架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Docker Container: FlowBOT                     │
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────┐              │
│  │   Xvfb   │───▶│  x11vnc  │───▶│     noVNC        │              │
│  │  :99     │    │  :5900   │    │   :7600 (Web)    │              │
│  └──────────┘    └──────────┘    └──────────────────┘              │
│       │                                                    │        │
│       ▼                                                    │        │
│  ┌──────────┐    ┌──────────────────┐    ┌──────────────┐ │        │
│  │  WeChat  │◀───│  messagePush     │───▶│ BotManager   │ │        │
│  │ (Weixin) │    │  Service         │    │ (OneBot)     │ │        │
│  │ GUI 窗口  │    │  (DB 监听)       │    │  :7100       │ │        │
│  └──────────┘    └────────┬─────────┘    └──────┬───────┘ │        │
│       ▲                   │                      │         │        │
│       │                   ▼                      │         │        │
│       │           ┌──────────────┐               │         │        │
│       └───────────│  WeFlow      │◀──────────────┘         │        │
│                   │  (Electron)  │  send_private_msg        │        │
│                   │  :5031 API   │  send_group_msg           │        │
│                   └──────┬───────┘  send_msg                 │        │
│                          │                                   │        │
│                 ┌────────▼────────┐                          │        │
│                 │  FlowBOT WebUI  │◀─────────────────────────┘        │
│                 │  :7300 (Vue)    │   voice_studio style             │
│                 │  :7400 (插件API) │                                   │
│                 └─────────────────┘                                  │
└─────────────────────────────────────────────────────────────────────┘

外部访问:
  http://IP:7300  ──▶ FlowBOT WebUI 管理面板
  http://IP:7600  ──▶ noVNC 虚拟桌面（操作微信 GUI）
  http://IP:7100  ──▶ OneBot v11 API（AstrBot 等对接）
  http://IP:7400  ──▶ 插件 API（AstrBot 适配器，Bot 配置中可开关）
  http://IP:5031  ──▶ WeFlow HTTP API（容器内通信，不建议外部访问）
```

## 关键技术决策

| 决策 | 说明 |
|------|------|
| **消息发送** | 使用 xdotool + xclip 模拟键盘操作，无需 Wine/CrossOver |
| **密钥获取** | xkey_helper_linux 通过 ptrace hook 微信进程内存，需要 `SYS_PTRACE` 权限 |
| **OneBot 双向** | OneBotServer 实现 HTTP + 自定义 WebSocket，支持外部框架发送/接收消息 |
| **配置存储** | electron-store JSON 文件，WebUI 通过 HTTP API 管理端点读写 |
| **WebUI** | 本地化 vendor 文件（vue/vue-router），无需外网 CDN |
| **VNC 安全** | 通过 `VNC_PASSWORD` 环境变量设置密码，建议修改为自定义强密码 |

## 致谢

感谢以下开源项目的贡献：

- [WeFlow](https://github.com/hicccc77/WeFlow) 为项目提供了基础的软件和消息协议支持，在此对作者表示衷心的感谢
- [NapCat](https://github.com/NapNeko/NapCatQQ) 为OneBot协议的实现提供了重要的思路
- [OneBot v11](https://github.com/botuniverse/onebot-11)