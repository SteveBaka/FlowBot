# WeFlow OneBot Docker

将 WeFlow（微信聊天记录管理）+ OneBot v11 协议 + 微信 Linux 客户端打包为 Docker 容器，提供 WebUI 管理面板。

## 架构图

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Container                      │
│                                                         │
│  ┌──────────┐   ┌──────────┐   ┌──────────────────┐   │
│  │   Xvfb   │──▶│  x11vnc  │──▶│     noVNC        │   │
│  │ :99      │   │ :5900    │   │   :6080 (Web)    │   │
│  └──────────┘   └──────────┘   └──────────────────┘   │
│       │                                            ↑    │
│       ▼                                            │    │
│  ┌──────────┐        ┌──────────────┐        WebSocket │
│  │  WeChat  │◀──────▶│   WeFlow     │─────────────────┘
│  │ (Weixin) │  FFI   │  (Electron)  │
│  │ GUI窗口  │  hook  │  :5031 API   │
│  └──────────┘        └──────┬───────┘
│                             │
│                    ┌────────▼────────┐
│                    │    WebUI        │
│                    │  管理面板       │
│                    │   :5099 (Web)   │
│                    └─────────────────┘
└─────────────────────────────────────────────────────────┘

外部访问:
  http://IP:5099  ──▶ WebUI 管理面板
  http://IP:6080  ──▶ noVNC 虚拟桌面（操作微信 GUI）
  http://IP:3001  ──▶ OneBot v11 API（机器人框架对接）
  http://IP:5031  ──▶ WeFlow HTTP API（可选，容器内通信）
```

## 端口说明

| 端口 | 用途 | 映射 | 说明 |
|------|------|------|------|
| **5099** | WebUI 管理面板 | 必须 | 浏览器管理配置、查看日志、设置、免责声明 |
| **6080** | noVNC 虚拟桌面 | 必须 | 浏览器操作微信 GUI（聊天、登录、搜索联系人） |
| **3001** | OneBot v11 API | 必须 | 机器人框架（NapCat/go-cqhttp 等）对接微信 |
| **5031** | WeFlow HTTP API | 可选 | RESTful 接口（会话/消息/联系人查询），容器内自动启用，外部按需映射 |
| **5900** | VNC 内部 | 不映射 | 仅 noVNC 通过 6080 代理访问，无需暴露 |

> **5031 端口说明**：容器内 WeFlow 自动启用 HTTP API 并绑定 `0.0.0.0:5031`，WebUI 通过 `127.0.0.1:5031` 与 WeFlow 通信。如需从宿主机直接调用 API，添加 `-p 5031:5031`。

## 快速开始

### 1. 构建镜像

```bash
cd /path/to/WeFlow
docker build -f docker/Dockerfile -t weflow-onebot .
```

> 首次构建约 5-10 分钟（下载微信 deb 包 + 安装依赖）。

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

1. 浏览器打开 `http://你的IP:5099` — WebUI 管理面板
2. 阅读并接受免责声明
3. 浏览器打开 `http://你的IP:6080` — noVNC 虚拟桌面
4. 在虚拟桌面中登录微信
5. 回到 WebUI → 账号管理 → 添加账号 → 自动获取密钥
6. 配置完成后，OneBot API 即可使用

## 功能模块

### WebUI 管理面板 (:5099)

| 标签页 | 功能 |
|--------|------|
| 聊天 & 消息过滤 | 消息推送开关、过滤模式（全部/白名单/黑名单）、发送模式、通知设置 |
| Bot 配置 | OneBot v11 服务启用/端口/Token/性能参数 |
| 账号管理 | 添加/删除/切换账号、数据库密钥获取 |
| 数据库 | 数据库路径配置、连接状态、图片密钥 |
| 设置 | WeFlow 配置同步（HTTP API、主题、语言）、免责声明 |
| 日志 | 多源日志查看（WeChat/WeFlow/VNC/LinuxSender）、分类过滤、自动刷新 |
| 关于 | 版本信息、系统状态、端口映射、API Token |

### OneBot v11 API (:3001)

标准 OneBot v11 协议，支持以下事件：
- 消息接收（文本、图片、语音等）
- 消息发送（通过 xdotool 模拟键盘操作）
- 会话管理
- 联系人查询

### WeFlow HTTP API (:5031)

RESTful 接口，Docker 内自动启用：

```
GET  /health                        健康检查
GET  /api/v1/sessions               会话列表
GET  /api/v1/messages?talker=xxx    消息查询
GET  /api/v1/contacts               联系人列表
POST /api/v1/messages/send          发送消息
```

## 操作流程

```
启动容器
  │
  ├── 启动 DBus
  ├── 启动 WebUI (:5099)
  ├── 启动 Xvfb 虚拟显示
  ├── 启动 Fluxbox 窗口管理器（提供任务栏）
  ├── 启动 x11vnc (:5900)
  ├── 启动 noVNC (:6080)
  ├── 启动 WeChat（自动安装于 /opt/wechat）
  ├── 启动 WeFlow Electron
  │     ├── 自动启用 HTTP API (:5031)
  │     ├── 自动启用 OneBot (:3001)
  │     └── 生成 API Token
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
| `/opt/weflow/data` | WeFlow 运行数据、WebUI 配置 |
| `/root/.config` | WeFlow 配置文件（electron-store） |

## 注意事项

- **SYS_PTRACE 权限**：获取数据库密钥需要 ptrace 能力，缺少此权限则无法自动获取密钥
- **微信窗口名**：Linux 微信窗口名为 `Weixin`，消息发送通过 xdotool 模拟键盘操作
- **数据库路径**：默认自动检测 `~/xwechat_files`，支持手动配置
- **首次启动**：需要在 noVNC 中手动登录微信，然后在 WebUI 中完成账号配置
- **HTTP API Token**：首次启动自动生成，可在 WebUI 设置页查看和修改
