/**
 * 简单消息发送器
 * 
 * 基于剪贴板和 Win32 API 的最简单消息发送实现
 * 无需逆向微信函数，无需 DLL 注入
 * 
 * 原理：
 * 1. 找到微信窗口句柄
 * 2. 激活微信窗口到前台
 * 3. 将消息内容复制到剪贴板
 * 4. 模拟 Ctrl+V 粘贴
 * 5. 模拟 Enter 发送
 */
import { clipboard } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';

/**
 * Win32 常量
 */
const SW_RESTORE = 9;
const SW_SHOW = 5;
const SW_SHOWNORMAL = 1;
const KEYEVENTF_KEYUP = 0x0002;
const VK_CONTROL = 0x11;
const VK_RETURN = 0x0D;

/**
 * 简单消息发送器类
 */
export class SimpleMessageSender {
  private static instance: SimpleMessageSender;
  private koffi: any = null;
  private user32: any = null;
  private kernel32: any = null;
  private initialized = false;

  // Win32 函数
  private FindWindowW: any = null;
  private SetForegroundWindow: any = null;
  private ShowWindow: any = null;
  private IsWindow: any = null;
  private GetClassNameW: any = null;
  private EnumWindows: any = null;
  private GetWindowThreadProcessId: any = null;
  private PostMessageW: any = null;
  private SendMessageW: any = null;
  private keybd_event: any = null;
  private GetForegroundWindow: any = null;

  // 发送互斥锁
  private sending = false;
  private sendQueue: Array<{
    content: string;
    resolve: (success: boolean) => void;
  }> = [];

  // 微信窗口类名和标题关键词
  private static readonly WECHAT_CLASS_NAMES = [
    'WeChatMainWndForPC',
    'WeixinMainWnd',
    'ChatWnd',
    'WeChat',
    'Weixin',
  ];

  private static readonly WECHAT_TITLE_KEYWORDS = [
    '微信',
    'WeChat',
    'Weixin',
    'wechat',
    'weixin',
  ];

  private constructor() {}

  static getInstance(): SimpleMessageSender {
    if (!SimpleMessageSender.instance) {
      SimpleMessageSender.instance = new SimpleMessageSender();
    }
    return SimpleMessageSender.instance;
  }

  /**
   * 初始化 Win32 API
   */
  private ensureInitialized(): boolean {
    if (this.initialized) return true;

    try {
      this.koffi = require('koffi');
      
      // 加载 user32.dll
      this.user32 = this.koffi.load('user32.dll');
      
      // 绑定函数
      this.FindWindowW = this.user32.func('void* FindWindowW(uint16* className, uint16* windowName)');
      this.SetForegroundWindow = this.user32.func('bool SetForegroundWindow(void* hWnd)');
      this.ShowWindow = this.user32.func('bool ShowWindow(void* hWnd, int nCmdShow)');
      this.IsWindow = this.user32.func('bool IsWindow(void* hWnd)');
      this.GetClassNameW = this.user32.func('int GetClassNameW(void* hWnd, uint16* lpClassName, int nMaxCount)');
      this.PostMessageW = this.user32.func('bool PostMessageW(void* hWnd, uint32 msg, uintptr_t wParam, intptr_t lParam)');
      this.SendMessageW = this.user32.func('intptr_t SendMessageW(void* hWnd, uint32 msg, uintptr_t wParam, intptr_t lParam)');
      this.keybd_event = this.user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)');
      this.GetForegroundWindow = this.user32.func('void* GetForegroundWindow()');

      // 定义 EnumWindows 回调
      const WNDENUMPROC = this.koffi.proto('bool __stdcall (void* hWnd, intptr_t lParam)');
      this.EnumWindows = this.user32.func('EnumWindows', 'bool', [this.koffi.pointer(WNDENUMPROC), 'intptr_t']);

      // 加载 kernel32.dll
      this.kernel32 = this.koffi.load('kernel32.dll');
      this.GetWindowThreadProcessId = this.user32.func('uint32 GetWindowThreadProcessId(void* hWnd, uint32* lpdwProcessId)');

      this.initialized = true;
      console.log('[SimpleMessageSender] Win32 API initialized');
      return true;
    } catch (error) {
      console.error('[SimpleMessageSender] Failed to initialize Win32 API:', error);
      return false;
    }
  }

  /**
   * 查找微信窗口句柄
   */
  private findWeChatWindow(): number | null {
    if (!this.ensureInitialized()) return null;

    // 方法 1: 通过类名查找
    for (const className of SimpleMessageSender.WECHAT_CLASS_NAMES) {
      const classNameBuf = Buffer.from(className + '\0', 'ucs2');
      const hWnd = this.FindWindowW(classNameBuf, null);
      if (hWnd && hWnd !== 0) {
        console.log(`[SimpleMessageSender] Found WeChat window by class: ${className}`);
        return hWnd;
      }
    }

    // 方法 2: 通过标题关键词查找
    for (const keyword of SimpleMessageSender.WECHAT_TITLE_KEYWORDS) {
      const keywordBuf = Buffer.from(keyword + '\0', 'ucs2');
      const hWnd = this.FindWindowW(null, keywordBuf);
      if (hWnd && hWnd !== 0) {
        console.log(`[SimpleMessageSender] Found WeChat window by title: ${keyword}`);
        return hWnd;
      }
    }

    // 方法 3: 枚举所有窗口查找
    let foundHwnd: number | null = null;
    
    try {
      const callback = this.koffi.register((hWnd: number, lParam: number) => {
        if (foundHwnd) return false; // 已找到，停止枚举

        // 检查窗口是否可见
        const isVisible = this.IsWindow(hWnd);
        if (!isVisible) return true;

        // 获取窗口类名
        const classNameBuf = Buffer.alloc(256 * 2);
        const classNameLen = this.GetClassNameW(hWnd, classNameBuf, 256);
        if (classNameLen > 0) {
          const className = classNameBuf.toString('ucs2', 0, classNameLen * 2).replace(/\0/g, '');
          
          // 检查是否是微信窗口类
          for (const wechatClass of SimpleMessageSender.WECHAT_CLASS_NAMES) {
            if (className.toLowerCase().includes(wechatClass.toLowerCase())) {
              foundHwnd = hWnd;
              return false;
            }
          }
        }

        return true;
      }, this.koffi.pointer(this.koffi.proto('bool __stdcall (void* hWnd, intptr_t lParam)')));

      this.EnumWindows(callback, 0);
    } catch (error) {
      console.error('[SimpleMessageSender] EnumWindows failed:', error);
    }

    if (foundHwnd) {
      console.log('[SimpleMessageSender] Found WeChat window by enumeration');
    }

    return foundHwnd;
  }

  /**
   * 激活微信窗口到前台
   */
  private activateWindow(hWnd: number): boolean {
    if (!this.ensureInitialized()) return false;

    try {
      // 先恢复窗口（如果最小化）
      this.ShowWindow(hWnd, SW_RESTORE);
      
      // 设置为前台窗口
      const success = this.SetForegroundWindow(hWnd);
      
      // 短暂等待窗口激活
      return new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(true);
        }, 100);
      }) as any;
    } catch (error) {
      console.error('[SimpleMessageSender] Failed to activate window:', error);
      return false;
    }
  }

  /**
   * 模拟按键
   */
  private simulateKeyPress(vk: number, delay: number = 50): Promise<void> {
    return new Promise((resolve) => {
      // 按下键
      this.keybd_event(vk, 0, 0, 0);
      
      setTimeout(() => {
        // 释放键
        this.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
        
        setTimeout(resolve, delay);
      }, delay);
    });
  }

  /**
   * 模拟 Ctrl+V 粘贴
   */
  private async simulatePaste(): Promise<void> {
    // 按下 Ctrl
    this.keybd_event(VK_CONTROL, 0, 0, 0);
    await new Promise(r => setTimeout(r, 30));
    
    // 按下 V
    this.keybd_event(0x56, 0, 0, 0); // VK_V = 0x56
    await new Promise(r => setTimeout(r, 30));
    
    // 释放 V
    this.keybd_event(0x56, 0, KEYEVENTF_KEYUP, 0);
    await new Promise(r => setTimeout(r, 30));
    
    // 释放 Ctrl
    this.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
    await new Promise(r => setTimeout(r, 50));
  }

  /**
   * 通过剪贴板发送消息
   */
  private async sendViaClipboard(content: string, hWnd: number): Promise<boolean> {
    try {
      // 保存当前剪贴板内容
      const originalClipboard = clipboard.readText();

      // 将消息内容复制到剪贴板
      clipboard.writeText(content);
      
      // 短暂等待剪贴板更新
      await new Promise(r => setTimeout(r, 50));

      // 确保窗口在前台
      this.activateWindow(hWnd);
      await new Promise(r => setTimeout(r, 100));

      // 模拟 Ctrl+V 粘贴
      await this.simulatePaste();
      
      // 等待粘贴完成
      await new Promise(r => setTimeout(r, 100));

      // 模拟 Enter 发送
      await this.simulateKeyPress(VK_RETURN, 50);
      
      // 等待消息发送
      await new Promise(r => setTimeout(r, 200));

      // 恢复原始剪贴板内容
      if (originalClipboard) {
        clipboard.writeText(originalClipboard);
      }

      console.log('[SimpleMessageSender] Message sent via clipboard');
      return true;
    } catch (error) {
      console.error('[SimpleMessageSender] Failed to send via clipboard:', error);
      return false;
    }
  }

  /**
   * 发送消息
   * 
   * @param content 消息内容
   * @param sessionId 会话 ID (可选，用于切换会话)
   * @returns 是否成功
   */
  async sendMessage(content: string, sessionId?: string): Promise<{
    success: boolean;
    error?: string;
    method: string;
  }> {
    // 防止并发发送
    if (this.sending) {
      return {
        success: false,
        error: 'Another message is being sent',
        method: 'clipboard',
      };
    }

    this.sending = true;

    try {
      // 查找微信窗口
      const hWnd = this.findWeChatWindow();
      if (!hWnd) {
        return {
          success: false,
          error: 'WeChat window not found. Please open WeChat first.',
          method: 'clipboard',
        };
      }

      // 发送消息
      const success = await this.sendViaClipboard(content, hWnd);

      return {
        success,
        method: 'clipboard',
        error: success ? undefined : 'Failed to send message',
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        method: 'clipboard',
      };
    } finally {
      this.sending = false;
    }
  }

  /**
   * 检查微信是否运行
   */
  isWeChatRunning(): boolean {
    return this.findWeChatWindow() !== null;
  }

  /**
   * 获取当前前台窗口是否是微信
   */
  isWeChatForeground(): boolean {
    if (!this.ensureInitialized()) return false;

    try {
      const foregroundHwnd = this.GetForegroundWindow();
      if (!foregroundHwnd) return false;

      const classNameBuf = Buffer.alloc(256 * 2);
      const classNameLen = this.GetClassNameW(foregroundHwnd, classNameBuf, 256);
      
      if (classNameLen > 0) {
        const className = classNameBuf.toString('ucs2', 0, classNameLen * 2).replace(/\0/g, '');
        
        for (const wechatClass of SimpleMessageSender.WECHAT_CLASS_NAMES) {
          if (className.toLowerCase().includes(wechatClass.toLowerCase())) {
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      return false;
    }
  }
}

/**
 * 获取单例实例
 */
export function getSimpleMessageSender(): SimpleMessageSender {
  return SimpleMessageSender.getInstance();
}
