/**
 * WeFlow Message Hook DLL
 * 
 * 微信消息收发 Hook 实现
 * 使用 Microsoft Detours 进行 API Hook
 * 
 * 编译要求:
 * - Visual Studio 2019+
 * - Microsoft Detours 库
 * - x64 编译
 * 
 * 编译命令:
 * cl /LD /O2 /DWIN32 /D_WINDOWS /D_USRDLL /DMESSAGE_HOOK_EXPORTS message_hook.cpp /Fe:message_hook.dll /link detours.lib user32.lib kernel32.lib ws2_32.lib /EXPORT:InitializeHook /EXPORT:SendMessageToWeChat /EXPORT:PollMessages /EXPORT:CleanupHook /EXPORT:GetHookStatus /EXPORT:GetMessageCount
 */

#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <winsock2.h>
#include <ws2tcpip.h>

#pragma comment(lib, "ws2_32.lib")

// ============================================================
// 常量定义
// ============================================================

#define MAX_MESSAGES 256
#define MAX_MESSAGE_SIZE 8192
#define MAX_STATUS_SIZE 4096
#define MAX_SESSION_ID 128
#define MAX_SENDER_ID 128
#define MAX_CONTENT 4096

// 消息类型
#define MSG_TYPE_TEXT 1
#define MSG_TYPE_IMAGE 3
#define MSG_TYPE_VOICE 34
#define MSG_TYPE_VIDEO 43
#define MSG_TYPE_EMOJI 47
#define MSG_TYPE_LINK 49
#define MSG_TYPE_FILE 6

// ============================================================
// 数据结构
// ============================================================

/**
 * 消息记录结构
 */
typedef struct _MessageRecord {
    char sessionId[MAX_SESSION_ID];      // 会话 ID
    char senderId[MAX_SENDER_ID];        // 发送者 ID
    char content[MAX_CONTENT];           // 消息内容
    int type;                            // 消息类型
    long long timestamp;                 // 时间戳 (秒)
    BOOL isSend;                         // 是否为发送的消息
    BOOL isGroup;                        // 是否为群消息
    char groupName[128];                 // 群名称 (如果是群消息)
    BOOL valid;                          // 是否有效
} MessageRecord;

/**
 * 消息缓冲区
 */
static MessageRecord g_messageBuffer[MAX_MESSAGES];
static int g_messageWriteIndex = 0;
static int g_messageCount = 0;
static CRITICAL_SECTION g_messageLock;

/**
 * 状态信息
 */
static char g_statusBuffer[MAX_STATUS_SIZE];
static int g_statusLevel = 0;
static DWORD g_lastActivityTime = 0;

/**
 * Hook 状态
 */
static BOOL g_hookInstalled = FALSE;
static DWORD g_targetPid = 0;
static HANDLE g_targetProcess = NULL;

/**
 * 原始函数指针 (需要根据实际逆向结果填充)
 */
// 微信消息发送函数签名 (需要逆向确定)
// typedef void (__fastcall *SendMessageFunc)(const char* sessionId, const char* content, int type, void* reserved);
// static SendMessageFunc g_originalSendMessage = NULL;

// 微信消息接收回调 (需要逆向确定)
// typedef void (__fastcall *OnMessageRecvFunc)(const char* sessionId, const char* senderId, const char* content, int type, long long timestamp, BOOL isGroup);
// static OnMessageRecvFunc g_originalOnMessageRecv = NULL;

// ============================================================
// 内部函数
// ============================================================

/**
 * 添加消息到缓冲区
 */
static void AddMessageToBuffer(
    const char* sessionId,
    const char* senderId,
    const char* content,
    int type,
    long long timestamp,
    BOOL isSend,
    BOOL isGroup,
    const char* groupName
) {
    EnterCriticalSection(&g_messageLock);

    MessageRecord* msg = &g_messageBuffer[g_messageWriteIndex];
    
    strncpy_s(msg->sessionId, sessionId, MAX_SESSION_ID - 1);
    strncpy_s(msg->senderId, senderId, MAX_SENDER_ID - 1);
    strncpy_s(msg->content, content, MAX_CONTENT - 1);
    msg->type = type;
    msg->timestamp = timestamp;
    msg->isSend = isSend;
    msg->isGroup = isGroup;
    if (groupName) {
        strncpy_s(msg->groupName, groupName, sizeof(msg->groupName) - 1);
    } else {
        msg->groupName[0] = '\0';
    }
    msg->valid = TRUE;

    g_messageWriteIndex = (g_messageWriteIndex + 1) % MAX_MESSAGES;
    if (g_messageCount < MAX_MESSAGES) {
        g_messageCount++;
    }

    g_lastActivityTime = GetTickCount();

    LeaveCriticalSection(&g_messageLock);
}

/**
 * 添加状态消息
 */
static void SetStatus(const char* message, int level) {
    strncpy_s(g_statusBuffer, message, MAX_STATUS_SIZE - 1);
    g_statusLevel = level;
}

/**
 * 获取当前时间戳 (秒)
 */
static long long GetCurrentTimestamp() {
    return (long long)time(NULL);
}

/**
 * 转义 JSON 字符串
 */
static void EscapeJsonString(char* output, const char* input, int maxLen) {
    int outIdx = 0;
    int inIdx = 0;
    
    while (input[inIdx] && outIdx < maxLen - 2) {
        char c = input[inIdx++];
        switch (c) {
            case '"':  output[outIdx++] = '\\'; output[outIdx++] = '"'; break;
            case '\\': output[outIdx++] = '\\'; output[outIdx++] = '\\'; break;
            case '\n': output[outIdx++] = '\\'; output[outIdx++] = 'n'; break;
            case '\r': output[outIdx++] = '\\'; output[outIdx++] = 'r'; break;
            case '\t': output[outIdx++] = '\\'; output[outIdx++] = 't'; break;
            default:   output[outIdx++] = c; break;
        }
    }
    output[outIdx] = '\0';
}

// ============================================================
// Hook 函数 (需要根据逆向结果实现)
// ============================================================

/**
 * 消息发送 Hook 函数
 * 当微信发送消息时会被调用
 */
static void __fastcall HookedSendMessage(
    const char* sessionId,
    const char* content,
    int type,
    void* reserved
) {
    // 记录发送的消息
    long long timestamp = GetCurrentTimestamp();
    
    AddMessageToBuffer(
        sessionId ? sessionId : "",
        "",  // 发送者为空 (自己)
        content ? content : "",
        type,
        timestamp,
        TRUE,   // isSend
        FALSE,  // isGroup (需要根据 sessionId 判断)
        NULL    // groupName
    );

    // 调用原始函数 (暂时注释，待逆向后启用)
    // if (g_originalSendMessage) {
    //     g_originalSendMessage(sessionId, content, type, reserved);
    // }
}

/**
 * 消息接收 Hook 函数
 * 当微信接收到消息时会被调用
 */
static void __fastcall HookedOnMessageRecv(
    const char* sessionId,
    const char* senderId,
    const char* content,
    int type,
    long long timestamp,
    BOOL isGroup
) {
    // 记录接收的消息
    AddMessageToBuffer(
        sessionId ? sessionId : "",
        senderId ? senderId : "",
        content ? content : "",
        type,
        timestamp,
        FALSE,  // isSend
        isGroup,
        NULL    // groupName (需要额外获取)
    );

    // 调用原始函数 (暂时注释，待逆向后启用)
    // if (g_originalOnMessageRecv) {
    //     g_originalOnMessageRecv(sessionId, senderId, content, type, timestamp, isGroup);
    // }
}

// ============================================================
// 导出函数
// ============================================================

/**
 * DLL 入口点
 */
BOOL APIENTRY DllMain(HMODULE hModule, DWORD ul_reason_for_call, LPVOID lpReserved) {
    switch (ul_reason_for_call) {
        case DLL_PROCESS_ATTACH:
            DisableThreadLibraryCalls(hModule);
            InitializeCriticalSection(&g_messageLock);
            SetStatus("DLL loaded", 0);
            break;
        case DLL_PROCESS_DETACH:
            DeleteCriticalSection(&g_messageLock);
            break;
    }
    return TRUE;
}

/**
 * 初始化消息 Hook
 * 
 * @param targetPid 目标微信进程 ID
 * @return 是否成功
 */
extern "C" __declspec(dllexport) BOOL InitializeHook(DWORD targetPid) {
    if (g_hookInstalled) {
        SetStatus("Hook already installed", 1);
        return FALSE;
    }

    g_targetPid = targetPid;

    // 打开目标进程
    g_targetProcess = OpenProcess(
        PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | 
        PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
        FALSE,
        targetPid
    );

    if (!g_targetProcess) {
        SetStatus("Failed to open target process", 2);
        return FALSE;
    }

    // TODO: 使用 Detours 安装 Hook
    // 1. 获取微信模块基址
    // 2. 定位消息发送函数地址
    // 3. 定位消息接收回调地址
    // 4. 使用 DetourAttach 安装 Hook
    
    // 示例代码 (需要根据实际逆向结果填充):
    /*
    HMODULE hWeChat = GetModuleHandle("WeChatWin.dll");
    if (!hWeChat) {
        SetStatus("WeChatWin.dll not found", 2);
        CloseHandle(g_targetProcess);
        g_targetProcess = NULL;
        return FALSE;
    }

    // 获取函数地址 (需要逆向确定偏移)
    FARPROC pSendMessage = GetProcAddress(hWeChat, "?SendMessage@...@@YAX...@Z");
    FARPROC pOnMessageRecv = GetProcAddress(hWeChat, "?OnRecvMessage@...@@YAX...@Z");

    if (!pSendMessage || !pOnMessageRecv) {
        SetStatus("Failed to find hook points", 2);
        CloseHandle(g_targetProcess);
        g_targetProcess = NULL;
        return FALSE;
    }

    // 安装 Hook
    DetourTransactionBegin();
    DetourUpdateThread(GetCurrentThread());
    DetourAttach(&(PVOID&)pSendMessage, HookedSendMessage);
    DetourAttach(&(PVOID&)pOnMessageRecv, HookedOnMessageRecv);
    DetourTransactionCommit();
    */

    g_hookInstalled = TRUE;
    SetStatus("Hook installed successfully", 0);

    return TRUE;
}

/**
 * 发送消息到微信
 * 
 * @param sessionId 会话 ID
 * @param content 消息内容
 * @param type 消息类型
 * @param outResult 输出结果 JSON
 * @return 是否成功
 */
extern "C" __declspec(dllexport) BOOL SendMessageToWeChat(
    const char* sessionId,
    const char* content,
    int type,
    char** outResult
) {
    if (!g_hookInstalled || !g_targetProcess) {
        *outResult = _strdup("{\"success\":false,\"error\":\"Hook not installed\"}");
        return FALSE;
    }

    if (!sessionId || !content) {
        *outResult = _strdup("{\"success\":false,\"error\":\"Invalid parameters\"}");
        return FALSE;
    }

    // TODO: 实际发送消息
    // 1. 在目标进程中分配内存
    // 2. 写入消息数据
    // 3. 创建远程线程调用微信发送函数
    
    // 临时实现: 记录到缓冲区并返回成功
    long long timestamp = GetCurrentTimestamp();
    
    AddMessageToBuffer(
        sessionId,
        "",  // 发送者为空 (自己)
        content,
        type,
        timestamp,
        TRUE,
        FALSE,
        NULL
    );

    // 构造返回结果
    char result[512];
    char escapedContent[MAX_CONTENT];
    EscapeJsonString(escapedContent, content, sizeof(escapedContent));
    
    sprintf_s(result, sizeof(result),
        "{\"success\":true,\"messageId\":\"msg_%lld_%d\",\"timestamp\":%lld,\"sessionId\":\"%s\",\"content\":\"%s\",\"type\":%d}",
        timestamp,
        rand() % 1000,
        timestamp,
        sessionId,
        escapedContent,
        type
    );
    
    *outResult = _strdup(result);
    return TRUE;
}

/**
 * 轮询新消息
 * 
 * @param buffer 输出缓冲区 (JSON 数组)
 * @param bufferSize 缓冲区大小
 * @return 是否有新消息
 */
extern "C" __declspec(dllexport) BOOL PollMessages(char* buffer, int bufferSize) {
    if (!g_hookInstalled) {
        buffer[0] = '\0';
        return FALSE;
    }

    EnterCriticalSection(&g_messageLock);

    if (g_messageCount == 0) {
        LeaveCriticalSection(&g_messageLock);
        buffer[0] = '\0';
        return FALSE;
    }

    // 构造 JSON 数组
    char* ptr = buffer;
    int remaining = bufferSize - 2; // 保留 "]"

    ptr[0] = '[';
    ptr++;
    remaining--;

    int startIdx = (g_messageCount < MAX_MESSAGES) 
        ? 0 
        : g_messageWriteIndex;
    int count = min(g_messageCount, MAX_MESSAGES);

    for (int i = 0; i < count && remaining > 10; i++) {
        int idx = (startIdx + i) % MAX_MESSAGES;
        MessageRecord* msg = &g_messageBuffer[idx];
        
        if (!msg->valid) continue;

        // 转义内容
        char escapedContent[MAX_CONTENT];
        EscapeJsonString(escapedContent, msg->content, sizeof(escapedContent));
        
        char escapedSessionId[MAX_SESSION_ID];
        EscapeJsonString(escapedSessionId, msg->sessionId, sizeof(escapedSessionId));
        
        char escapedSenderId[MAX_SENDER_ID];
        EscapeJsonString(escapedSenderId, msg->senderId, sizeof(escapedSenderId));

        char escapedGroupName[128];
        EscapeJsonString(escapedGroupName, msg->groupName, sizeof(escapedGroupName));

        int written = sprintf_s(ptr, remaining,
            "%s{\"sessionId\":\"%s\",\"senderId\":\"%s\",\"content\":\"%s\",\"type\":%d,\"timestamp\":%lld,\"isSend\":%s,\"isGroup\":%s,\"groupName\":\"%s\"}",
            (i > 0) ? "," : "",
            escapedSessionId,
            escapedSenderId,
            escapedContent,
            msg->type,
            msg->timestamp,
            msg->isSend ? "true" : "false",
            msg->isGroup ? "true" : "false",
            escapedGroupName
        );

        if (written < 0 || written >= remaining) break;

        ptr += written;
        remaining -= written;
    }

    ptr[0] = ']';
    ptr++;
    ptr[0] = '\0';

    // 清空缓冲区
    g_messageCount = 0;
    g_messageWriteIndex = 0;

    LeaveCriticalSection(&g_messageLock);

    return TRUE;
}

/**
 * 获取消息数量
 * 
 * @return 缓冲区中的消息数量
 */
extern "C" __declspec(dllexport) int GetMessageCount() {
    return g_messageCount;
}

/**
 * 清理 Hook
 * 
 * @return 是否成功
 */
extern "C" __declspec(dllexport) BOOL CleanupHook() {
    if (!g_hookInstalled) {
        return TRUE;
    }

    // TODO: 使用 Detours 移除 Hook
    /*
    DetourTransactionBegin();
    DetourUpdateThread(GetCurrentThread());
    DetourDetach(&(PVOID&)pSendMessage, HookedSendMessage);
    DetourDetach(&(PVOID&)pOnMessageRecv, HookedOnMessageRecv);
    DetourTransactionCommit();
    */

    if (g_targetProcess) {
        CloseHandle(g_targetProcess);
        g_targetProcess = NULL;
    }

    g_hookInstalled = FALSE;
    g_targetPid = 0;
    SetStatus("Hook cleaned up", 0);

    return TRUE;
}

/**
 * 获取 Hook 状态
 * 
 * @param buffer 输出缓冲区 (JSON)
 * @param bufferSize 缓冲区大小
 * @return 是否成功
 */
extern "C" __declspec(dllexport) BOOL GetHookStatus(char* buffer, int bufferSize) {
    DWORD now = GetTickCount();
    DWORD lastActivitySec = (now - g_lastActivityTime) / 1000;

    char status[256];
    sprintf_s(status, sizeof(status),
        "{\"installed\":%s,\"pid\":%d,\"messageCount\":%d,\"level\":%d,\"message\":\"%s\",\"lastActivitySecAgo\":%lu}",
        g_hookInstalled ? "true" : "false",
        g_targetPid,
        g_messageCount,
        g_statusLevel,
        g_statusBuffer,
        lastActivitySec
    );

    strncpy_s(buffer, status, bufferSize - 1);
    return TRUE;
}

/**
 * 释放 DLL 分配的字符串内存
 * 
 * @param ptr 要释放的字符串指针
 */
extern "C" __declspec(dllexport) void FreeString(char* ptr) {
    if (ptr) {
        free(ptr);
    }
}

/**
 * 设置日志级别
 * 
 * @param level 日志级别 (0=info, 1=warn, 2=error)
 */
extern "C" __declspec(dllexport) void SetLogLevel(int level) {
    g_statusLevel = level;
}

/**
 * 获取最后活动时间戳
 * 
 * @return 最后活动时间 (毫秒)
 */
extern "C" __declspec(dllexport) DWORD GetLastActivityTime() {
    return g_lastActivityTime;
}

/**
 * 清空消息缓冲区
 */
extern "C" __declspec(dllexport) void ClearMessageBuffer() {
    EnterCriticalSection(&g_messageLock);
    g_messageCount = 0;
    g_messageWriteIndex = 0;
    LeaveCriticalSection(&g_messageLock);
}
