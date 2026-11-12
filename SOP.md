# niceRouter 运维、排障与发布 SOP

安装、登录和环境变量见 [README](README.md)，接口参数见 [API 说明](API.md)。

## 1. 每次开始前

1. 确认 Harness 的协议是 **OpenAI Chat Completions**，Base URL 以 `/v1` 结尾，启用鉴权时使用网关密钥。通过 `GET /v1/models` 选择实际返回的 `provider::model`，排障记录完整模型 ID。
2. 检查 `GET /health` 与 `GET /v1/status`，记录目标入口、`build`、`pid` 和 `startedAt`。经过局域网或中转时，在网关主机和客户端入口各查一次。双击 `start.bat` 可能复用已有进程，核对构建号和启动时间才能确认切换。
3. 核对目标账号和状态。右栏确认自动签到和积分，或用 `GET /v1/checkin` 与 `GET /v1/quota?provider=<通道>` 只读检查。Trae 和 SOLO 共用账号。自动签到在启动后检查并定时复查，同账号按周期去重。
4. 「今日已用」「本月已用」读网关本地账本，按北京时间分期。只按可观察的额度变动或实际计费记录累计，保留厂商单位。`—` 表示暂缺记录。更换电脑后从新账本开始。
5. 使用豆包时，先在当前 Windows 用户登录官方应用，正常退出后运行 `tools/refresh-doubao-auth.mjs` 刷新加密授权，再启动网关。应用可在刷新后重新打开。迁移或授权过期时重新刷新，操作步骤见 README。后台根据账号当前活动处理签到。

## 2. 发生故障时

先收集北京时间、入口、模型 ID、构建号和 Harness 错误原文。能拿到请求 ID 时一并记录；否则按时间和模型匹配项目目录下的 `gateway.log`，用同一 `chatcmpl-…` 的 `timing` 与 `completion` 行核对。日志中的请求开始和结束可能跨分钟，同时请求会交错。可用以下只读命令查找记录。

```powershell
Get-Content -LiteralPath .\gateway.log -Tail 200
Select-String -LiteralPath .\gateway.log -SimpleMatch 'chatcmpl-替换成请求ID'
```

| 现象 | 排查顺序 |
| --- | --- |
| `PI_AI_ERROR` 或「上游返回了未声明的工具调用」 | 查 `completion.error_code`。`upstream_unknown_tool` 表示解析出的工具候选未通过本轮允许范围。逐一核对文本标记解析、原生调用和 `tool_choice`，再用合成数据复现。保留工具白名单，待确认候选来源后修正解析或上游引导。 |
| 只显示思考，随后失败 | 查 `reasoning_chars`、`text_chars`、`tool_calls`、终止原因和补全次数。用脱敏样例核对第二轮是否带回上一轮思考、工具调用与匹配的工具结果。Windows 本机加密诊断默认关闭。 |
| `connect error`、连接中断 | 从 Harness 所在机检查 `/health` 和目标 `/v1/status`。核对中转、端口和鉴权，再看同一请求是否在网关产生 `completion` 或客户端取消。 |
| 工具很慢 | 对比 `queue_ms`、`cli_first_event_ms`、`first_text_ms`、`first_tool_call_ms`、`total_ms`。分别记录排队、上游启动和正文或工具生成耗时；字段缺失就标记未知。 |
| 模型缺失、签到或积分异常 | 先核对目标电脑对应版本的官方客户端登录与模型目录，再查单通道状态。登记是登录失效、目录刷新失败、当前无奖励还是暂缺账本记录。 |

流式接口建立后会先返回 HTTP 200，之后仍可能发出 SSE `error`。以 `gateway_completion.outcome`、错误帧和终止帧判定结果。分享排障记录时保留时序、通道、错误码和计数，脱敏账号、密钥、上下文和工具参数。

检查文本工具协议时，分别验证闭合标签、JSON 完整性和本轮工具声明。解析器兼容 `</|tool_call>` 和 `</call>` 等闭合写法。回归用脱敏或合成示例确认原参数、调用 ID 和工具结果续接。

Qoder CLI 自带的目录和平台提示属于转发主机。工具提示已明确外部执行边界，项目路径与执行环境以 Harness 提供的会话及其真实工具结果为准。排障时不要把模型生成的路径和结果当成实际执行证据。

## 3. 改动与验收

1. 用独立目录和空闲端口跑候选版本，监听 `127.0.0.1`。使用空白配置和 `AUTO_CHECKIN_ENABLED=0` 检查健康与空模型列表，再按需要接入本机模拟上游。临时实例使用单独的日志和账本。模拟上游只用于开发验收。
2. 从仓库根目录运行相关离线回归。以下测试使用合成输入或本机模拟上游。

   ```powershell
   node tools/test_markup.mjs
   node tools/test_dsml_mixed.mjs
   node tools/test_tool_history.mjs
   node tools/test_completion_gateway.mjs
   node tools/test_harness_reasoning_gateway.mjs
   node tools/test_stream_cancellation.mjs
   node tools/test_workbuddy_models.mjs
   node tools/test_auto_checkin.mjs
   node tools/test_usage_periods.mjs
   ```

3. 涉及工具时，用本机安装的 Harness 和临时会话验证实际链路。首轮检查工具名、调用 ID、JSON 对象参数和 `tool_calls` 结束帧。让 Harness 读取临时测试文件，再检查下一轮按相同 ID 回灌并返回文件里的值。离线回归使用合成工具结果，覆盖无工具、`tool_choice=none`、强制工具、未声明工具、普通文本引用、分片 DSML/JSON、仅思考和断连。
4. 涉及某个通道时，优先复用目标机官方 CLI、SDK 或现有原生协议。核对模型清单、两轮工具、取消、授权失效提示。Qoder 另测完整工具批次后继续普通正文或保持 CLI 不退出、并行调用的消息末尾提交、裸工具标记、强制工具缺失、快照冲突和长度终止，不能只用含显式 tool_result 的样本验收边界。WorkBuddy 另测说明后 JSON 围栏的完整 tool_calls、逐字符分片、assistant/result 补尾及原参数/ID续接。DSH 还须测试保留工具声明的真实压缩请求：摘要中的引用和历史工具帧全部保持文字，不产生新调用；模型结束标记先于完整快照时须允许补齐。支持额度和签到的通道另外核对账号归并、周期去重和本地账本；真实上游实测记录模型与入口，注明验证范围。
5. 发布前从候选 ZIP 解压到含空格路径，用空白用户配置验证网页、`/health`、`/v1/models` 和缺少在线账号时的提示，再用独立模拟上游验证流式结束。按允许名单打包源码、网页、公开模板和启动文档。核对清单、SHA-256，并保留上一版安装包。实际 `.env`、会话、客户端缓存、账本、日志和诊断单独留在本机。

## 4. 线上切换和回滚

1. 记录旧构建、PID、启动参数、入口、日志位置和上一版文件。保持本地配置和账本分离，候选版本先过上一节验收。
2. 选请求空闲时段切换。需要立即切换且有流式请求时，先由使用者确认可中断。Windows 上从本机独立的 PowerShell 运行 `start.bat`。从 WorkBuddy 沙盒启动的网关曾长时间等不到下游 CLI 首个事件。启动后核对预期 build、新 PID、实际入口和自动签到状态，再用已配置的在线模型确认 SSE 能完整结束。
3. 若健康、模型、流式结束或签到状态异常，使用上一版程序与原启动配置恢复，保留原账户数据和账本。重新检查入口，记录切换与回滚时间及可复现证据。

## 5. 下一轮优化顺序

| 优先级 | 工作 | 完成标准 |
| --- | --- | --- |
| P0 | Harness 工具兼容与错误定位 | 客户端可见请求 ID。日志记录时间、通道、调用来源、候选格式和声明匹配结果。各通道选择代表模型验证两轮调用，另用合成案例验证未知工具拦截。 |
| P1 | 延迟统计与安全重启 | 按通道区分排队、首字、首工具和总耗时，展示样本量与 P50/P95；可查询活跃请求数并在切换前等待已有流自然结束。 |
| P1 | 账户面板读本地快照 | 后台按账户合并刷新，网页读缓存和本地账本。上游失败保留最后成功值并标示更新时间与过期状态；签到由后台照常处理。 |
| P2 | 一键回归与可重复打包 | 统一离线回归入口，自动生成白名单 ZIP 和校验值，在空白配置验证后发布。 |
