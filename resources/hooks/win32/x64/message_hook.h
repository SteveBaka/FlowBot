/**
 * WeFlow Message Hook DLL Header
 * 
 * 定义消息 Hook DLL 的导出函数接口
 * 
 * 编译要求:
 * - Visual Studio 2019+
 * - Microsoft Detours 库
 * - x64 编译
 */

#ifndef MESSAGE_HOOK_H
#define MESSAGE_HOOK_H

#include <windows.h>

#ifdef MESSAGE_HOOK_EXPORTS
#define MESSAGE_HOOK_API __declspec(dllexport)
#else
#define MESSAGE_HOOK_API __declspec(dllimport)
#endif

#ifdef __cplusplus
extern "C" {
#endif

// ============================================================
// 消息类型常量
// ============================================================
#define MSG_TYPE_TEXT    1
#define MSG_TYPE_IMAGE   3
#define MSG_TYPE_VOICE   34
#define MSG_TYPE_VIDEO   43
#define MSG_TYPE_EMOJI   47
#define MSG_TYPE_LINK    49
#define MSG_TYPE_FILE    6

// ============================================================
// 核心函数
// ============================================================

/**
 * 初始化消息 Hook
 * 
 * @param targetPid 目标微信进程 ID
 * @return 是否成功
 */
MESSAGE_HOOK_API BOOL InitializeHook(DWORD targetPid);

/**
 * 清理 Hook
 * 
 * @return 是否成功
 */
MESSAGE_HOOK_API BOOL CleanupHook();

/**
 * 获取 Hook 状态
 * 
 * @param buffer 输出缓冲区 (JSON 格式)
 * @param bufferSize 缓冲区大小
 * @return 是否成功
 */
MESSAGE_HOOK_API BOOL GetHookStatus(char* buffer, int bufferSize);

// ============================================================
// 消息发送
// ============================================================

/**
 * 发送消息到微信
 * 
 * @param sessionId 会话 ID (wxid 或群 ID)
 * @param content 消息内容
 * @param type 消息类型 (MSG_TYPE_*)
 * @param outResult 输出结果 JSON 字符串 (需要调用 FreeString 释放)
 * @return 是否成功
 */
MESSAGE_HOOK_API BOOL SendMessageToWeChat(const char* sessionId, const char* content, int type, char** outResult);

// ============================================================
// 消息轮询
// ============================================================

/**
 * 轮询新消息
 * 
 * @param buffer 输出缓冲区 (JSON 数组格式)
 * @param bufferSize 缓冲区大小
 * @return 是否有新消息
 */
MESSAGE_HOOK_API BOOL PollMessages(char* buffer, int bufferSize);

/**
 * 获取消息数量
 * 
 * @return 缓冲区中的消息数量
 */
MESSAGE_HOOK_API int GetMessageCount(void);

/**
 * 清空消息缓冲区
 */
MESSAGE_HOOK_API void ClearMessageBuffer(void);

// ============================================================
// 内存管理
// ============================================================

/**
 * 释放 DLL 分配的字符串内存
 * 
 * @param ptr 要释放的字符串指针
 */
MESSAGE_HOOK_API void FreeString(char* ptr);

// ============================================================
// 辅助函数
// ============================================================

/**
 * 设置日志级别
 * 
 * @param level 日志级别 (0=info, 1=warn, 2=error)
 */
MESSAGE_HOOK_API void SetLogLevel(int level);

/**
 * 获取最后活动时间戳
 * 
 * @return 最后活动时间 (毫秒，系统启动后)
 */
MESSAGE_HOOK_API DWORD GetLastActivityTime(void);

#ifdef __cplusplus
}
#endif

#endif // MESSAGE_HOOK_H
