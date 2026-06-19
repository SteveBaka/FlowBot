/**
 * WeFlow 插件管理器
 * 管理微信消息 Hook 插件的加载、卸载和生命周期
 */
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import {
  WeChatHookPlugin,
  IPluginManager,
  SendOptions,
  SendResult,
  HookState,
} from './plugin-interface';

/**
 * 插件管理器实现
 */
export class PluginManager extends EventEmitter implements IPluginManager {
  private plugins: Map<string, WeChatHookPlugin> = new Map();
  private pluginConfigs: Map<string, PluginConfig> = new Map();
  private activePluginName: string | null = null;
  private pluginDir: string;

  constructor(pluginDir?: string) {
    super();
    this.pluginDir = pluginDir || path.join(process.cwd(), 'plugins');
    this.ensurePluginDir();
  }

  /**
   * 确保插件目录存在
   */
  private ensurePluginDir(): void {
    if (!fs.existsSync(this.pluginDir)) {
      fs.mkdirSync(this.pluginDir, { recursive: true });
    }
  }

  /**
   * 加载插件
   */
  async loadPlugin(pluginPath: string): Promise<WeChatHookPlugin> {
    try {
      // 检查插件文件是否存在
      if (!fs.existsSync(pluginPath)) {
        throw new Error(`Plugin file not found: ${pluginPath}`);
      }

      // 动态加载插件模块
      const pluginModule = require(pluginPath);
      const PluginClass = pluginModule.default || pluginModule;

      // 实例化插件
      const plugin: WeChatHookPlugin = new PluginClass();

      // 验证插件接口
      this.validatePlugin(plugin);

      // 调用插件加载回调
      await plugin.onLoad();

      // 注册插件
      this.plugins.set(plugin.metadata.name, plugin);

      // 设置默认配置
      this.pluginConfigs.set(plugin.metadata.name, {
        enabled: true,
        autoStart: false,
      });

      console.log(`[PluginManager] Plugin loaded: ${plugin.metadata.name} v${plugin.metadata.version}`);
      this.emit('plugin:loaded', plugin.metadata);

      return plugin;
    } catch (error) {
      console.error('[PluginManager] Failed to load plugin:', error);
      throw error;
    }
  }

  /**
   * 验证插件接口
   */
  private validatePlugin(plugin: WeChatHookPlugin): void {
    if (!plugin.metadata) {
      throw new Error('Plugin missing metadata');
    }

    if (!plugin.metadata.name) {
      throw new Error('Plugin missing name');
    }

    if (!plugin.metadata.version) {
      throw new Error('Plugin missing version');
    }

    if (!plugin.capabilities) {
      throw new Error('Plugin missing capabilities');
    }

    // 验证必要方法
    const requiredMethods = [
      'onLoad',
      'onUnload',
      'installHook',
      'uninstallHook',
      'getHookState',
      'readMessages',
      'sendMessage',
    ];

    for (const method of requiredMethods) {
      if (typeof (plugin as any)[method] !== 'function') {
        throw new Error(`Plugin missing required method: ${method}`);
      }
    }
  }

  /**
   * 卸载插件
   */
  async unloadPlugin(pluginName: string): Promise<void> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginName}`);
    }

    // 如果是活跃插件，先卸载 Hook
    if (this.activePluginName === pluginName) {
      await this.uninstallHook(pluginName);
    }

    // 调用插件卸载回调
    await plugin.onUnload();

    // 移除插件
    this.plugins.delete(pluginName);
    this.pluginConfigs.delete(pluginName);

    console.log(`[PluginManager] Plugin unloaded: ${pluginName}`);
    this.emit('plugin:unloaded', { name: pluginName });
  }

  /**
   * 获取已加载的插件
   */
  getPlugin(pluginName: string): WeChatHookPlugin | undefined {
    return this.plugins.get(pluginName);
  }

  /**
   * 获取所有已加载的插件
   */
  listPlugins(): WeChatHookPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * 安装 Hook
   */
  async installHook(pluginName: string, pid: number): Promise<boolean> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginName}`);
    }

    // 卸载其他插件的 Hook（如果有）
    if (this.activePluginName && this.activePluginName !== pluginName) {
      await this.uninstallHook(this.activePluginName);
    }

    // 安装新 Hook
    const success = await plugin.installHook(pid);
    if (success) {
      this.activePluginName = pluginName;

      // 更新配置
      const config = this.pluginConfigs.get(pluginName) || {
        enabled: true,
        autoStart: false,
      };
      config.hookPid = pid;
      this.pluginConfigs.set(pluginName, config);

      // 注册事件监听
      this.setupPluginEvents(plugin);

      console.log(`[PluginManager] Hook installed: ${pluginName} (PID: ${pid})`);
      this.emit('hook:installed', { plugin: pluginName, pid });

      await plugin.onHookInstalled();
    }

    return success;
  }

  /**
   * 卸载 Hook
   */
  async uninstallHook(pluginName: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginName}`);
    }

    const success = await plugin.uninstallHook();
    if (success) {
      if (this.activePluginName === pluginName) {
        this.activePluginName = null;
      }

      // 更新配置
      const config = this.pluginConfigs.get(pluginName);
      if (config) {
        config.hookPid = undefined;
        this.pluginConfigs.set(pluginName, config);
      }

      console.log(`[PluginManager] Hook uninstalled: ${pluginName}`);
      this.emit('hook:uninstalled', { plugin: pluginName });

      await plugin.onHookUninstalled();
    }

    return success;
  }

  /**
   * 设置插件事件监听
   */
  private setupPluginEvents(plugin: WeChatHookPlugin): void {
    plugin.on('message', (msg) => {
      this.emit('message', msg);
    });

    plugin.on('status', (status) => {
      this.emit('hook:status', status);
    });

    plugin.on('error', (error) => {
      this.emit('error', error);
    });
  }

  /**
   * 获取活跃的插件
   */
  getActivePlugin(): WeChatHookPlugin | undefined {
    if (!this.activePluginName) {
      return undefined;
    }
    return this.plugins.get(this.activePluginName);
  }

  /**
   * 发送消息
   */
  async sendMessage(options: SendOptions): Promise<SendResult> {
    const plugin = this.getActivePlugin();
    if (!plugin) {
      return {
        success: false,
        error: 'No active plugin available',
        timestamp: Date.now(),
      };
    }

    if (!plugin.capabilities.canSendMessage) {
      return {
        success: false,
        error: 'Active plugin does not support sending messages',
        timestamp: Date.now(),
      };
    }

    try {
      return await plugin.sendMessage(options);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
    }
  }

  /**
   * 获取 Hook 状态
   */
  getHookState(pluginName?: string): HookState | null {
    const pluginNameToUse = pluginName || this.activePluginName;
    if (!pluginNameToUse) {
      return null;
    }

    const plugin = this.plugins.get(pluginNameToUse);
    if (!plugin) {
      return null;
    }

    return plugin.getHookState();
  }

  /**
   * 获取插件配置
   */
  getPluginConfig(pluginName: string): PluginConfig | undefined {
    return this.pluginConfigs.get(pluginName);
  }

  /**
   * 更新插件配置
   */
  updatePluginConfig(pluginName: string, config: Partial<PluginConfig>): void {
    const existingConfig = this.pluginConfigs.get(pluginName) || {
      enabled: true,
      autoStart: false,
    };

    this.pluginConfigs.set(pluginName, {
      ...existingConfig,
      ...config,
    });
  }

  /**
   * 加载所有插件
   */
  async loadAllPlugins(): Promise<void> {
    if (!fs.existsSync(this.pluginDir)) {
      return;
    }

    const entries = fs.readdirSync(this.pluginDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pluginPath = path.join(this.pluginDir, entry.name);
        const indexFile = path.join(pluginPath, 'index.js');
        const packageFile = path.join(pluginPath, 'package.json');

        if (fs.existsSync(indexFile) && fs.existsSync(packageFile)) {
          try {
            await this.loadPlugin(pluginPath);
          } catch (error) {
            console.error(`[PluginManager] Failed to load plugin from ${pluginPath}:`, error);
          }
        }
      }
    }
  }

  /**
   * 清理所有插件
   */
  async cleanup(): Promise<void> {
    for (const [name, plugin] of this.plugins) {
      try {
        const state = plugin.getHookState();
        if (state.status === 'installed') {
          await this.uninstallHook(name);
        }
        await plugin.onUnload();
      } catch (error) {
        console.error(`[PluginManager] Error cleaning up plugin ${name}:`, error);
      }
    }

    this.plugins.clear();
    this.pluginConfigs.clear();
    this.activePluginName = null;
  }
}

/**
 * 插件配置接口
 */
interface PluginConfig {
  enabled: boolean;
  autoStart: boolean;
  hookPid?: number;
  options?: Record<string, any>;
}

/**
 * 单例实例
 */
let instance: PluginManager | null = null;

export function getPluginManager(pluginDir?: string): PluginManager {
  if (!instance) {
    instance = new PluginManager(pluginDir);
  }
  return instance;
}
