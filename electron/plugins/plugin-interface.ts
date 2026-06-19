/**
 * WeFlow 插件接口规范
 * 定义微信消息 Hook 插件的标准接口
 */

/**
 * 消息类型枚举
 */
export enum MessageType {
  Text = 1,
  Image = 3,
  Voice = 34,
  Video = 43,
  Emoji = 47,
  Link = 49,
  Location = 48,
  NameCard = 42,
  File = 6,
  System = 10000,
  Custom = 436207665,
}

/**
 * Hook 状态
 */
export enum HookStatus {
  Uninitialized = 'uninitialized',
  Initializing = 'initializing',
  Installed = 'installed',
  Uninstalled = 'uninstalled',
  Error = 'error',
}

/**
 * 插件元信息
 */
export interface PluginMetadata {
  name: string;
  version: string;
  description: string;
  author: string;
  platform: ('win32' | 'darwin' | 'linux')[];
  minWeChatVersion: string;
  minWeFlowVersion?: string;
}

/**
 * 插件能力声明
 */
export interface PluginCapabilities {
  canReadMessages: boolean;
  canSendMessage: boolean;
  canReadContacts: boolean;
  canReadGroups: boolean;
  supportedMessageTypes: MessageType[];
}

/**
 * 消息读取选项
 */
export interface ReadOptions {
  sessionId: string;
  limit?: number;
  offset?: number;
  startTime?: number;
  endTime?: number;
  messageTypes?: MessageType[];
}

/**
 * 消息发送选项
 */
export interface SendOptions {
  sessionId: string;
  content: string;
  type: MessageType;
  atUsers?: string[];
  replyTo?: string;
  imagePath?: string;
}

/**
 * 发送结果
 */
export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  timestamp: number;
}

/**
 * 消息对象
 */
export interface Message {
  messageId: string;
  sessionId: string;
  senderId: string;
  content: string;
  type: MessageType;
  timestamp: number;
  isSend: boolean;
  status?: string;
}

/**
 * Hook 状态信息
 */
export interface HookState {
  status: HookStatus;
  pid?: number;
  error?: string;
  lastActivity?: number;
}

/**
 * 插件事件回调
 */
export interface PluginEventCallbacks {
  onMessage?: (message: Message) => void;
  onStatusChange?: (status: HookState) => void;
  onError?: (error: Error) => void;
}

/**
 * WeChat Hook 插件接口
 */
export interface WeChatHookPlugin {
  /**
   * 插件元信息
   */
  metadata: PluginMetadata;

  /**
   * 插件能力声明
   */
  capabilities: PluginCapabilities;

  /**
   * 插件加载时调用
   */
  onLoad(): Promise<void>;

  /**
   * 插件卸载时调用
   */
  onUnload(): Promise<void>;

  /**
   * Hook 安装后调用
   */
  onHookInstalled(): Promise<void>;

  /**
   * Hook 卸载后调用
   */
  onHookUninstalled(): Promise<void>;

  /**
   * 安装 Hook
   * @param pid WeChat 进程 ID
   * @returns 是否安装成功
   */
  installHook(pid: number): Promise<boolean>;

  /**
   * 卸载 Hook
   * @returns 是否卸载成功
   */
  uninstallHook(): Promise<boolean>;

  /**
   * 获取 Hook 状态
   */
  getHookState(): HookState;

  /**
   * 读取消息
   * @param options 读取选项
   * @returns 消息列表
   */
  readMessages(options: ReadOptions): Promise<Message[]>;

  /**
   * 发送消息
   * @param options 发送选项
   * @returns 发送结果
   */
  sendMessage(options: SendOptions): Promise<SendResult>;

  /**
   * 注册事件监听
   */
  on(event: 'message', callback: (msg: Message) => void): void;
  on(event: 'status', callback: (status: HookState) => void): void;
  on(event: 'error', callback: (error: Error) => void): void;

  /**
   * 取消事件监听
   */
  off(event: string, callback: Function): void;
}

/**
 * 插件配置
 */
export interface PluginConfig {
  enabled: boolean;
  autoStart: boolean;
  hookPid?: number;
  options?: Record<string, any>;
}

/**
 * 插件管理器接口
 */
export interface IPluginManager {
  /**
   * 加载插件
   */
  loadPlugin(pluginPath: string): Promise<WeChatHookPlugin>;

  /**
   * 卸载插件
   */
  unloadPlugin(pluginName: string): Promise<void>;

  /**
   * 获取已加载的插件
   */
  getPlugin(pluginName: string): WeChatHookPlugin | undefined;

  /**
   * 获取所有已加载的插件
   */
  listPlugins(): WeChatHookPlugin[];

  /**
   * 安装 Hook
   */
  installHook(pluginName: string, pid: number): Promise<boolean>;

  /**
   * 卸载 Hook
   */
  uninstallHook(pluginName: string): Promise<boolean>;

  /**
   * 获取活跃的插件（支持消息发送的）
   */
  getActivePlugin(): WeChatHookPlugin | undefined;

  /**
   * 发送消息（使用活跃插件）
   */
  sendMessage(options: SendOptions): Promise<SendResult>;
}
