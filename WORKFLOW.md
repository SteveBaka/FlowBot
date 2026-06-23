# WeFlow 双向消息 Hook 开发工作流

> **本文件仅供写入操作和标记更改，不得删除条目**

---

## 项目概述

基于 WeFlow 项目实现双向消息读写功能，通过插件化 Hook 机制在 Win32 平台测试，后续扩展多平台支持和 Docker 容器化部署。

---

## 已实现功能

### 核心功能
- [x] 插件接口规范定义
- [x] 插件管理器实现
- [x] 消息发送 HTTP API
- [x] WebSocket 实时通信支持
- [ ] 独立服务入口 (Docker 可用)

### Win32 Hook 实现
- [x] WeChat 进程检测与定位
- [x] 消息读取 Hook DLL 开发 (基础框架)
- [x] 消息发送 Hook DLL 开发 (基础框架)
- [x] 进程注入器实现
- [x] Hook 生命周期管理
- [ ] 逆向微信消息收发函数 (需要实际逆向)

### 多平台支持
- [ ] 平台抽象层设计
- [ ] macOS Hook 实现
- [ ] Linux Hook 实现

### Docker 容器化
- [ ] Dockerfile 编写
- [ ] docker-compose.yml
- [ ] 部署文档

---

## 开发日志

### 2026-06-06

#### 新增内容
- 创建工作流文件
- 完成项目架构分析
- 设计插件接口规范
- 规划 Win32 Hook 实现路径

#### 已完成任务
- [x] 实现 `electron/plugins/plugin-interface.ts` - 定义插件接口规范
- [x] 实现 `electron/plugins/pluginManager.ts` - 插件管理器
- [x] 创建 `electron/plugins/messageHookService.ts` - 消息 Hook 服务
- [x] 创建 `electron/plugins/simpleMessageSender.ts` - 剪贴板方式发送 (最简实现)
- [x] 修改 `electron/services/httpService.ts` - 添加消息发送 API
- [x] 添加 WebSocket 实时通信支持
- [x] 创建 `resources/hooks/win32/x64/message_hook.cpp` - DLL 完整实现
- [x] 创建 `resources/hooks/win32/x64/message_hook.h` - DLL 头文件
- [x] 创建 `resources/hooks/win32/x64/build.bat` - 编译脚本
- [x] 创建 `resources/hooks/win32/x64/CMakeLists.txt` - CMake 编译配置
- [x] 创建 `src/components/MessageInput.tsx` - 消息输入组件
- [x] 创建 `src/components/MessageInput.css` - 消息输入样式
- [x] 创建 `src/services/messageService.ts` - 消息发送服务
- [x] 将 MessageInput 组件集成到 ChatPage
- [x] 创建 `scripts/patch-vite-sass.js` - Vite sass 解析器补丁
- [x] **修复 Vite sass 构建问题** - Vite 8 的 enhanced-resolve 在网络映射盘路径下无法解析 sass/sass-embedded，通过硬编码 sass.node.mjs 路径解决

#### 最简实现方案 (已实现)
**基于剪贴板的 UI 自动化**:
- 无需逆向微信函数
- 无需 DLL 注入
- 通过 Win32 API 找到微信窗口
- 使用剪贴板粘贴 + Enter 发送
- 自动保存/恢复剪贴板内容

#### 打包说明
- 运行 `npm run build` 打包正式版本
- 安装包位于 `release/` 目录
- 使用 npx 执行 tsc 避免 PATH 问题

#### 待完成任务
- [ ] 逆向微信 4.0 消息收发函数 (需要实际逆向，可选)
- [ ] 编译并测试 message_hook.dll (可选增强)
- [ ] 修复 electron-builder 在网络路径下的 EPERM 问题 (建议本地路径构建)

---

### 2026-06-11

#### 新增内容
- 分析 `wcdb_api.dll` 安全验证机制（二进制逆向分析）
- 发现 DLL 进程名检查（electron.exe / weflow.exe / wechatdataanalysis.exe）
- 创建本地鉴权服务器 `electron/services/localAuthServer.ts`
- 创建 hosts 重定向工具 `electron/utils/hostsRedirect.ts`（备用）
- 创建 DLL URL 补丁脚本 `scripts/patch-dll.js`
- 改进 WCDB 错误消息（formatInitProtectionError 添加 -1006/-101/-102 描述）

#### 已完成任务
- [x] **DLL 安全验证问题排查** — 通过二进制分析发现 DLL 检查进程名
- [x] **进程名匹配修复** — 产品名从 `WeFlow Alpha` 改为 `WeFlow`，exe 名匹配 DLL 检查的 `weflow.exe`
- [x] **本地鉴权服务器** — `electron/services/localAuthServer.ts`，模拟 `api.weflow.top/api/token`
- [x] **数据库成功连接** — `open ok handle=1`，InitProtection 通过，wcdb_init 成功
- [x] **NSIS 安装包构建** — `release-build/WeFlow-4.5.1-Setup.exe`
- [x] **WCDB 错误消息改进** — formatInitProtectionError 添加 -1006/-101/-102 描述

#### 关键发现
1. `wcdb_api.dll` 内部检查进程名是否为 `weflow.exe`、`electron.exe` 或 `wechatdataanalysis.exe`
2. 产品名 `WeFlow Alpha` → exe `WeFlow Alpha.exe` 不匹配 → DLL 返回 -1006
3. 产品名 `WeFlow` → exe `WeFlow.exe` 匹配 `weflow.exe`（Windows 不区分大小写）→ 成功
4. `api.weflow.top/api/token` API 已下线（返回 404），工作版本因之前成功获取 token 并缓存而正常
5. DLL 的 `InitProtection` 是多层安全验证：进程名检查 → API token 验证 → wcdb_init 安全状态检查

#### 待完成任务
- [ ] **~~消息发送功能不可用~~** — 已修复：添加发送开关、错误反馈，需要在另一台机器上验证
- [ ] 恢复原版 WeFlow 安装（产品名冲突问题）
- [ ] 恢复原版 WeFlow 安装（产品名冲突问题）
- [ ] 逆向微信 4.0 消息收发函数
- [ ] 编译并测试 message_hook.dll

---

## 技术规范

### 插件接口

```typescript
interface WeChatHookPlugin {
  metadata: PluginMetadata;
  capabilities: PluginCapabilities;
  
  // 生命周期
  onLoad(): Promise<void>;
  onUnload(): Promise<void>;
  
  // Hook 控制
  installHook(pid: number): Promise<boolean>;
  uninstallHook(): Promise<boolean>;
  
  // 消息操作
  readMessages(options: ReadOptions): Promise<Message[]>;
  sendMessage(options: SendOptions): Promise<SendResult>;
  
  // 事件
  on(event: string, callback: Function): void;
  off(event: string, callback: Function): void;
}
```

### API 端点

| 方法 | 端点 | 描述 |
|------|------|------|
| `POST` | `/api/v1/messages/send` | 发送消息 |
| `GET` | `/api/v1/plugins` | 获取插件列表 |
| `POST` | `/api/v1/plugins/:name/hook` | 安装 Hook |
| `DELETE` | `/api/v1/plugins/:name/hook` | 卸载 Hook |
| `GET` | `/api/v1/hooks/status` | Hook 状态 |
| `WS` | `/api/v1/ws` | WebSocket 通信 |

---

## 文件变更记录

| 日期 | 文件 | 操作 | 描述 |
|------|------|------|------|
| 2026-06-06 | `WORKFLOW.md` | 新增 | 创建工作流文件 |
| 2026-06-06 | `electron/plugins/plugin-interface.ts` | 新增 | 插件接口规范定义 |
| 2026-06-06 | `electron/plugins/pluginManager.ts` | 新增 | 插件管理器实现 |
| 2026-06-06 | `electron/plugins/messageHookService.ts` | 新增 | 消息 Hook 服务实现 (含降级策略) |
| 2026-06-06 | `electron/plugins/simpleMessageSender.ts` | 新增 | 剪贴板方式发送 (最简实现) |
| 2026-06-06 | `electron/services/httpService.ts` | 修改 | 添加消息发送、插件管理 API 和 WebSocket 支持 |
| 2026-06-06 | `resources/hooks/win32/x64/message_hook.cpp` | 新增 | Win32 Hook DLL 完整实现 |
| 2026-06-06 | `resources/hooks/win32/x64/message_hook.h` | 新增 | Win32 Hook DLL 头文件 |
| 2026-06-06 | `resources/hooks/win32/x64/build.bat` | 新增 | DLL 编译脚本 |
| 2026-06-06 | `resources/hooks/win32/x64/CMakeLists.txt` | 新增 | CMake 编译配置 |
| 2026-06-06 | `src/components/MessageInput.tsx` | 新增 | 消息输入组件 |
| 2026-06-06 | `src/components/MessageInput.css` | 新增 | 消息输入样式 |
| 2026-06-06 | `src/services/messageService.ts` | 新增 | 消息发送服务 |
| 2026-06-06 | `src/pages/ChatPage.tsx` | 修改 | 集成 MessageInput 组件 |
| 2026-06-06 | `scripts/build-alpha.js` | 新增 | Alpha 版本打包脚本 |
| 2026-06-06 | `docs/ALPHA-BUILD-GUIDE.md` | 新增 | Alpha 版本打包和启动指南 |
| 2026-06-06 | `package.json` | 修改 | 添加 build:alpha 脚本 |
| 2026-06-11 | `electron/services/localAuthServer.ts` | 新增 | 本地鉴权服务器（模拟 api.weflow.top/api/token） |
| 2026-06-11 | `electron/utils/hostsRedirect.ts` | 新增 | hosts 重定向工具（备用） |
| 2026-06-11 | `scripts/patch-dll.js` | 新增 | DLL URL 补丁脚本 |
| 2026-06-11 | `electron/services/wcdbCore.ts` | 修改 | 改进 formatInitProtectionError 错误消息 |
| 2026-06-11 | `electron/main.ts` | 修改 | 添加本地鉴权服务器启动逻辑 |
| 2026-06-11 | `package.json` | 修改 | 产品名改为 WeFlow，版本 4.5.1 |
| 2026-06-11 | `electron/services/config.ts` | 修改 | ConfigSchema 添加 messageSendEnabled |
| 2026-06-11 | `src/services/config.ts` | 修改 | 添加 MESSAGE_SEND_ENABLED 配置项和 getter/setter |
| 2026-06-11 | `src/pages/SettingsPage.tsx` | 修改 | 添加发送消息开关 UI |
| 2026-06-11 | `src/pages/ChatPage.tsx` | 修改 | 发送框跟随开关 + 错误弹窗反馈 |
| 2026-06-11 | `electron/main.ts` | 修改 | 新增 chat:sendMessage IPC handler |
| 2026-06-11 | `electron/preload.ts` | 修改 | 新增 chat.sendMessage IPC 桥接 |
| 2026-06-11 | `src/services/messageService.ts` | 重写 | 消息发送改用 IPC 直连（移除 HTTP API 依赖） |
| 2026-06-11 | `src/types/electron.d.ts` | 修改 | 新增 chat.sendMessage 类型 |
| 2026-06-11 | `electron/plugins/enhancedMessageSender.ts` | 新增 | 增强消息发送器（队列、批量、前台/后台模式） |
| 2026-06-11 | `electron/main.ts` | 修改 | 新增 sendBatch/cancelSendQueue/sendProgress/isWeChatRunning IPC |
| 2026-06-11 | `electron/preload.ts` | 修改 | 新增批量发送和队列管理 IPC 桥接 |
| 2026-06-11 | `src/services/messageService.ts` | 重写 | 支持单条/批量发送、队列管理 |
| 2026-06-11 | `electron/services/wcdbCore.ts` | 恢复 | 恢复为原版 formatInitProtectionError 和 initialize 逻辑 |
| 2026-06-11 | `electron/main.ts` | 清理 | 移除 localAuthServer/hostsRedirect 引用 |
| 2026-06-11 | `resources/wcdb/win32/x64/wcdb_api.dll` | 恢复 | 恢复为原始版本 |
| 2026-06-11 | `electron/services/config.ts` | 修改 | ConfigSchema 添加 messageSendMode |
| 2026-06-11 | `src/services/config.ts` | 修改 | 添加 MESSAGE_SEND_MODE 配置项 |

---

## 注意事项

1. **封号风险**：Hook 操作可能导致微信封号，需用户自行承担风险
2. **版本兼容**：WeChat 版本更新可能导致 Hook 失效
3. **权限要求**：Hook 注入需要管理员权限
4. **测试环境**：建议在测试账号上先验证

---

## 消息发送功能

### 平台架构

```
electron/plugins/
├── enhancedMessageSender.ts     ← 工厂 + IPlatformSender 接口
├── platforms/
│   ├── types.ts                 ← 共享类型定义
│   └── windows.ts               ← Windows 实现（koffi FFI）
├── enhancedMessageSender.foreground-only.ts  ← Windows 前台模式快照（备份）
```

- `getEnhancedMessageSender()` 根据 `process.platform` 自动选择平台实现
- 各平台必须实现 `IPlatformSender` 接口（sendMessage / sendBatch / cancelPending / getProgress / isWeChatRunning）
- 新增平台（macOS / Linux）只需在 `platforms/` 下添加实现，并在工厂中注册

### 发送模式状态

| 模式 | Windows | macOS | Linux |
|------|---------|-------|-------|
| 前台模式 | ✅ 已验证 | 待实现 | 待实现 |
| 后台模式 | ⚠️ 测试中（UWP 限制） | 待实现 | 待实现 |

后台模式在 Windows 上受限于 WeChat 4.0 (UWP) 架构：PostMessage/SendMessage 无法注入键盘输入。当前复用前台逻辑，后续可通过 UI Automation 实现。

### 完整发送流程

```
前端 ChatPage → messageService.sendMessage(sessionId, content)
    → IPC chat:sendMessage(sessionId, content)
        → main.ts: 解析搜索关键词
            - 个人联系人（wxid_xxx）：直接用 sessionId
            - 群聊（xxx@chatroom）：chatService.getContact() → remark || nickName
        → enhancedMessageSender.sendMessage(content, searchName)
            1. findWeChatWindow()
               - FindWindowW 按类名查找（WeChatMainWndForPC 等）
               - 失败则 EnumWindows 按进程名查找（weixin.exe / wechat.exe）
            2. activateWindow(hWnd)
               - ShowWindow(SW_RESTORE) + SetForegroundWindow
            3. searchAndSelectContact(searchName)
               - Ctrl+F 打开搜索框
               - 剪贴板写入搜索词 → Ctrl+V 粘贴
               - Enter 选中第一个搜索结果
            4. pasteAndSend(content)
               - 剪贴板写入消息内容 → Ctrl+V 粘贴
               - Enter 发送
```

### 搜索关键词规则

| 类型 | sessionId 格式 | 搜索词 | 原因 |
|------|---------------|--------|------|
| 个人 | `wxid_xxxxx` | 直接用 wxid | wxid 唯一，WeChat 搜索支持 |
| 群聊 | `xxxxx@chatroom` | 群名（remark > nickName） | `@chatroom` 格式无法搜索 |

### koffi FFI 关键约束

1. **类型一致性**：所有 Win32 窗口句柄（hWnd）统一用 `void*`，不能混用 `uintptr_t`（`FindWindowW` 返回 `uintptr_t` 会得到 0）
2. **回调调用**：带函数指针参数的函数（如 `EnumWindows`）直接传 JS 回调，koffi 自动包装，但必须传够参数数量
3. **proto 复用**：`koffi.proto()` 创建的类型对象唯一，`EnumWindows` 绑定和调用必须用同一个 proto 实例（存为类属性）
4. **指针对象**：`void*` 返回值是 koffi 指针对象，不能用模板字符串 `` `${hWnd}` `` 转换

### WeChat 4.0 窗口特性

- WeChat 4.0 是 UWP/WinUI 应用（进程名 `weixin.exe`）
- `FindWindowW` 按类名查找全部返回 null（不再使用传统 Win32 类名）
- `EnumWindows` 按窗口标题匹配会找到错误子窗口（如 "WeChatAppEx.exe 的捷徑清單"）
- **必须通过进程名查找**：`GetWindowThreadProcessId` → `OpenProcess` → `QueryFullProcessImageNameW` → 匹配进程名

### 文件清单

| 文件 | 作用 |
|------|------|
| `electron/plugins/enhancedMessageSender.ts` | 核心：窗口查找、搜索选中、粘贴发送 |
| `electron/main.ts` | IPC handler：解析 sessionId → 搜索关键词 |
| `electron/services/chatService.ts` | `getContact()`：获取群名（remark/nickName） |

### 已知限制

- 后台模式当前复用前台逻辑（需要激活窗口）
- `sendBatch` 在搜索模式下不支持（每次发送都需要搜索切换会话）
- 搜索依赖 WeChat 的 Ctrl+F 功能，WeChat 版本更新可能影响

---

## 参考资源

- [WeFlow HTTP API 文档](./docs/HTTP-API.md)
- [koffi FFI 文档](https://koffi.dev/)
- [Windows API Hook 技术](https://docs.microsoft.com/en-us/windows/win32/api/)
