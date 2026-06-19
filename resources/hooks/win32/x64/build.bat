@echo off
REM WeFlow Message Hook DLL 编译脚本
REM 需要安装 Visual Studio 2019 或更高版本和 Microsoft Detours

echo ========================================
echo WeFlow Message Hook DLL 编译脚本
echo ========================================

REM 检查编译器
where cl >nul 2>nul
if %errorlevel% neq 0 (
    echo 错误: 找不到 cl.exe
    echo 请确保已安装 Visual Studio 2019 或更高版本
    echo 并运行 "Developer Command Prompt for VS"
    pause
    exit /b 1
)

REM 设置 Detours 路径 (默认 C:\Detours)
if "%DETOURS_PATH%"=="" (
    set DETOURS_PATH=C:\Detours
)

echo 使用 Detours 路径: %DETOURS_PATH%

REM 检查 Detours 是否存在
if not exist "%DETOURS_PATH%\include\detours.h" (
    echo 警告: 未找到 Detours 库
    echo 请从 https://github.com/microsoft/Detours 下载并安装
    echo 或设置 DETOURS_PATH 环境变量
    echo.
    echo 继续编译 (功能可能受限)...
)

REM 创建输出目录
if not exist "output" mkdir output

REM 编译 DLL
echo 正在编译 message_hook.dll...

if exist "%DETOURS_PATH%\include\detours.h" (
    echo 使用 Detours 库编译...
    cl /LD /O2 /DWIN32 /D_WINDOWS /D_USRDLL /DMESSAGE_HOOK_EXPORTS /I"%DETOURS_PATH%\include" message_hook.cpp /Fe:output\message_hook.dll /link /LIBPATH:"%DETOURS_PATH%\lib" detours.lib user32.lib kernel32.lib ws2_32.lib /EXPORT:InitializeHook /EXPORT:SendMessageToWeChat /EXPORT:PollMessages /EXPORT:CleanupHook /EXPORT:GetHookStatus /EXPORT:GetMessageCount /EXPORT:FreeString /EXPORT:SetLogLevel /EXPORT:GetLastActivityTime /EXPORT:ClearMessageBuffer
) else (
    echo 不使用 Detours 编译 (功能受限)...
    cl /LD /O2 /DWIN32 /D_WINDOWS /D_USRDLL /DMESSAGE_HOOK_EXPORTS message_hook.cpp /Fe:output\message_hook.dll /link user32.lib kernel32.lib ws2_32.lib /EXPORT:InitializeHook /EXPORT:SendMessageToWeChat /EXPORT:PollMessages /EXPORT:CleanupHook /EXPORT:GetHookStatus /EXPORT:GetMessageCount /EXPORT:FreeString /EXPORT:SetLogLevel /EXPORT:GetLastActivityTime /EXPORT:ClearMessageBuffer
)

if %errorlevel% equ 0 (
    echo 编译成功!
    echo 输出文件: output\message_hook.dll
    
    REM 复制到 WeFlow resources 目录
    echo 正在复制到 WeFlow resources 目录...
    copy /Y output\message_hook.dll ..\..\..\..\resources\hooks\win32\x64\message_hook.dll
    if %errorlevel% equ 0 (
        echo 复制成功!
    ) else (
        echo 复制失败，请手动复制
    )
    
    echo.
    echo 编译完成!
    echo.
    echo 注意: 完整功能需要逆向微信消息收发函数
    echo 请参考 message_hook.cpp 中的 TODO 注释
) else (
    echo 编译失败!
    echo.
    echo 常见问题:
    echo 1. 确保已安装 Visual Studio 2019+
    echo 2. 确保已安装 Microsoft Detours
    echo 3. 确保在 "Developer Command Prompt for VS" 中运行
)

echo.
pause
