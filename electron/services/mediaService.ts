/**
 * mediaService 独立模块 —— 媒体出站统一入口（阶段 1 空壳网关）
 *
 * 定位：把散落在 outboundMediaService / linux.ts / main.ts / httpService 的媒体处理
 * 收敛为独立模块。按 MEDIA-SERVICE-DESIGN.md §六 阶段规划推进，当前为"阶段 1 空壳"：
 * 仅作为 outboundMediaService 的 re-export 网关，不改任何接口行为。
 *
 * 未来演进（MEDIA-SERVICE-DESIGN.md §3.1/§9.4）：
 *   - 阶段 1：整体迁入 outboundMediaService（视频/文件四来源归一），本文件取代其 import 位；
 *   - 阶段 2：迁入图片两套归一（main.ts prepareImageForSend + httpService prepareImageInput），
 *            统一 15s 超时 + imageMaxBytes 闸，TTL 消费起算；
 *   - 阶段 3：预压缩管线（detectVideoSpec + precompressVideo + 收益评估）；
 *   - 阶段 4：入站闭环（/api/media?token= 泛化 + 推送视频字段）。
 *
 * 接线约定：剪贴板装载（xclip 写入）必须在发送线程同步执行，故"准备"在 mediaService
 * 产出信号，装载作为信号消费点留在 linux.ts（§3.1 关键约束）。
 */
import { prepareVideoForSend, detectVideoExt } from './outboundMediaService'

// 阶段 1 暂只转发出站视频归一；图片归一（prepareImageForSend / prepareImageInput）
// 属阶段 2，届时迁入后再补充导出。
export { prepareVideoForSend, detectVideoExt }
