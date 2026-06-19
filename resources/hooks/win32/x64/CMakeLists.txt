cmake_minimum_required(VERSION 3.10)
project(message_hook)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 定义导出宏
add_definitions(-DMESSAGE_HOOK_EXPORTS)

# 查找 Detours 库
# 需要设置 DETOURS_PATH 环境变量
if(DEFINED ENV{DETOURS_PATH})
    set(DETOURS_PATH $ENV{DETOURS_PATH})
else()
    set(DETOURS_PATH "C:/Detours" CACHE PATH "Detours library path")
endif()

# 包含目录
include_directories(${DETOURS_PATH}/include)

# 链接库目录
link_directories(${DETOURS_PATH}/lib)

# 添加源文件
add_library(message_hook SHARED message_hook.cpp)

# 链接库
target_link_libraries(message_hook
    detours
    user32
    kernel32
    ws2_32
)

# 设置输出名称
set_target_properties(message_hook PROPERTIES
    OUTPUT_NAME "message_hook"
    PREFIX ""
)

# 安装规则
install(TARGETS message_hook
    RUNTIME DESTINATION bin
    LIBRARY DESTINATION lib
)
