# API 调用说明

这个网关本身就是 **OpenAI 兼容 API**，不是只能通过网页用。任何支持 OpenAI 协议的
SDK / 工具（openai-python、openai-node、LangChain、Cherry Studio、Chatbox、
Cursor、Dify、n8n……）把 `base_url` 指过来就能直接跑。

## Base URL

| 场景 | 地址 |
| --- | --- |
| 本机 | `http://127.0.0.1:8787/v1` |
| 局域网（别的电脑 / 手机上的 App） | `http://<这台机器的局域网IP>:8787/v1` |

具体 IP 看启动窗口里打印的「局域网(网卡名)」那几行，或者打开网页
「设置 → 局域网访问」。

## 鉴权

默认在本机免密。`Authorization` 头写什么都行，但很多 SDK 强制要求非空，
所以随便填一个占位值即可：

```
Authorization: Bearer sk-any
```

启动时设了 `GATEWAY_KEY` 就必须填对应的值。启用局域网访问时，请在目标机设置自己的网关密钥。[迁移与启动](README.md)

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/models` | 已启用通道的真实模型列表 |
| `POST` | `/v1/chat/completions` | 对话，支持 `stream` |
| `GET` | `/v1/status` | 适配器、客户端接入状态、模型、可用地址及 build/pid/startedAt |
| `GET` | `/v1/quota` | 各通道积分 / 套餐 / 签到奖励包 |
| `GET` | `/v1/checkin` | 只读签到状态；可加 `?provider=trae` |
| `POST` | `/v1/checkin` | 默认查询；body `{provider, action:"claim"}` 才领取。trae/solo 共享签到 |
| `GET` | `/health` | 存活探针（无鉴权） |

`/v1/completions`、`/v1/embeddings`、`/v1/images/*` **没有实现**，调用会 404。

`/v1/status.clients` 列出支持的桌面客户端，每项有 `name`、`installed`、`providers`、`state` 和 `message`。`installed` 表示找到本机安装，`providers` 列出该客户端当前接入的模型通道，`state` 区分 `enabled`、`setup_required`、`not_detected` 和 `disabled`。额度或签到缺配置时，已接入的模型仍可出现在 `/v1/models`。Trae IDE 与 SOLO 合在一个客户端条目中。

按用户授权，网关启动即补签，运行期间每15分钟自动检查并领取可领奖励。
`GET /v1/quota` 和 `GET /v1/checkin` 保持只读，顶层 `automation` 提供启用状态、检查时间和各通道结果。
Trae/SOLO共享账号去重；后台运行不依赖网页打开。`AUTO_CHECKIN_ENABLED=0` 可关闭。

`/v1/quota` 的账户条目包含 `usagePeriods.today`、`usagePeriods.month` 和 `usagePeriods.since`，表示按北京时间统计的本地已用积分与记录起点。账本保存在网关本机，重启后继续累计。
Qoder 记录网关实际收到的请求扣费。Trae / SOLO 共用一份账本，和 WorkBuddy、MiniMax Code 一样，利用原有余额刷新中可匹配的累计消耗差额估算。跨日的快照差额只计入当月，跨月差额不计入。`null` 表示尚无有效记录。统计不另查官网用量明细，也不回填启用前的消耗。

## 通道与模型 ID

模型 ID 用 `通道::模型` 前缀路由，不带前缀走启动时的 `ADAPTER`，默认是 SOLO。默认通道未启用时，请选择模型列表中的完整 ID。无效的 `ADAPTER` 会阻止网关启动。

| 通道 | 前缀 | 模型 | 特点 |
| --- | --- | --- | --- |
| Qoder CN | `qoder::` | Auto / Fast / Qwen3.8-Max / Qwen3.8-Flash / DeepSeek-V4-Pro / DeepSeek-Flash / GLM-5.3 / GLM-5.3-Flash / Kimi-K3.1-Pro / Kimi-K2.8-Preview / Step-5-Preview / MiniMax-M3.1-Flash | 复用官方 CLI，冷启动约 1.5s，按积分计费（响应里带 `gateway_status: 本次消耗 x 积分`） |
| Qoder 国际版 | `qoder-intl::` | 官方清单14项，例如 efficient / ultimate / auto | 独立账号；复用官方CLI，支持正文/思考真增量。上游token usage当前为0 |
| WorkBuddy | `workbuddy::` | 官方实时清单，以 `/v1/models` 为准 | 复用官方CLI及桌面登录；真实usage；自动检查签到，当前无活动时跳过 |
| MiniMax Code | `minimax-code::` | `MiniMax-M3` / `MiniMax-M3.1-Flash` | 复用本机 MiniMax Code 登录，支持流式和原生工具调用，自动签到 |
| 豆包 | `doubao::` | `0` 快速 / `3` 专家 | 复用当前 Windows 用户的豆包加密授权，流式聊天与文本工具协议，后台检查并执行可用签到 |
| Trae SOLO | `solo::` | 110 个真实模型 | 免费额度充足，但可能要排队 |
| Trae IDE | `trae::` | 5 个基础模型 | 秒回，不排队 |

例：`qoder::GLM-5.3`、`solo::glm-5__max`、`trae::deepseek-V3`。

DeepSeek Harness 使用 **OpenAI Chat Completions** 协议，Base URL 填网关的 `/v1` 地址。调用方声明的工具会返回为 `tool_calls`，Harness 执行后用原 `tool_call_id` 回传 `role: tool` 消息。SOLO 和 MiniMax Code 走原生工具协议，Qoder 两版、WorkBuddy、豆包和 Trae IDE 由网关解析文本工具协议。

Qoder 两版的 CLI 禁用本机工具和 MCP，只负责生成当前回复。首批工具后的普通正文会结束本轮，紧邻的并行工具块仍可保留；完整助手消息或消息结束事件已确认该批调用时，网关直接交还 Harness，不等待 CLI 后续续写。历史正文与工具结果按数据引用，调用 ID 保留。Qoder 适配层没有自动补全、重试或改选模型。

DSH 的上下文压缩调用会保留工具声明以复用缓存，同时在最后一条 user 消息要求只输出摘要。对已核对的 `compaction-basic` 模板，Qoder 和 WorkBuddy 以共享的精确内容指纹识别并保持摘要为正文，历史工具例子不再提升为新调用；日志标记 `request_purpose: "compaction"`。不会凭章节标题或“总结”等词猜测用途，也不覆盖显式的强制工具选择。Qoder 普通正文中的代码、围栏和引号引用保留文字含义。Qoder 的 `message_stop` 到来但工具帧尚未完整时，会等待随后完整快照补齐。

Qoder SDK 可能将同一消息的思考块和文本块拆成多个 `assistant` 事件。只有思考、没有文本块的事件不会触发工具帧结束校验；参数及闭合标记可继续由后面的文本增量或完整快照补齐。

Qoder 已观察到以行首 `<tool_call>` 包住完整单次调用 JSON，却用 `</｜｜DSML｜｜ parameter>` 收尾的混合格式。该通道仅在单层包装、JSON 和对象参数完整、本轮工具名已声明时将这个收尾识别为调用结束；保留原调用 ID 与参数，不补残缺 JSON。内联引用、代码围栏及其他通道不启用这项兼容。

WorkBuddy 支持说明文字后以 Markdown JSON 代码块包装的完整 `{ "tool_calls": [...] }`。只有完整闭合、参数合法且本轮全部已声明的调用才会转换；普通代码、schema、嵌套示例和不完整块保持数据。`tool_choice: "none"` 以及已识别的 DSH 压缩请求保留原文。最终快照仅在与已收到的原文前缀完全一致时补齐缺失尾部，不猜参数；强制工具缺失明确报错。

`tool_choice: "required"` 或指定函数却没有得到有效调用时，Qoder 返回明确错误；无法解析的明确工具标记及流式前缀与完整快照冲突也不作为正常正文完成。已观察到的输出长度终止原因以 `length` 保留。提前结束时，尚未收到的终态 token 用量不补零；本地积分账本只累计实际收到的收费回执，缺失回执的轮次不会补记。

豆包的 `GET /v1/quota?provider=doubao` 与 `GET /v1/checkin?provider=doubao` 使用本机加密授权读取当前账号的额度和活动状态。自动签到由后台处理。授权刷新和迁移步骤见 [README](README.md)。

MiniMax Code 默认使用本机国内版登录，模型 ID 示例为 `minimax-code::MiniMax-M3.1-Flash`。
网关优先向桌面客户端获取官方短期凭据。桌面客户端关闭后，网关仍可使用当前有效凭据直至到期。
免密网关上的 MiniMax Code 签到由后台执行。启用 `GATEWAY_KEY` 后，可通过 API 手动领取。
`MINIMAX_CODE_ENABLED=0` 可关闭该通道。

## 先取模型名

```bash
curl -s http://127.0.0.1:8787/v1/models
```

模型 ID 一定要用这里返回的原样字符串，**后缀 `__dev` / `__max` 不能省**：

```
glm-5__max
deepseek-v4.1-flash__dev
Doubao-Seed-2.1-Pro__max
```

同一个模型的两个后缀是两套后端配置（不同上下文 / 是否带思考链），
传裸名 `glm-5` 会返回 404。

## curl

非流式：

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-any" \
  -H "content-type: application/json" \
  -d '{
    "model": "glm-5__max",
    "messages": [
      {"role": "system", "content": "回答尽量简洁"},
      {"role": "user", "content": "用一句话介绍你自己"}
    ],
    "temperature": 0.3
  }'
```

返回标准 `chat.completion`，另外多一个 `reasoning_content`（模型思考链）：

```json
{
  "id": "chatcmpl-5b2544fba14d45219afe4572",
  "object": "chat.completion",
  "model": "glm-5__max",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "我是字节跳动开发的 AI 豆包，可以帮你解答问题。",
      "reasoning_content": "用户要一句话介绍……"
    },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 20, "completion_tokens": 35, "total_tokens": 55 }
}
```

流式（`-N` 关掉 curl 缓冲，否则看着像卡住）：

```bash
curl -sN http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"glm-5__max","stream":true,
       "messages":[{"role":"user","content":"数到五"}]}'
```

> Windows 上用 curl 记得加 `--noproxy '*'`，否则系统代理会把 127.0.0.1 也劫走。

## Python（openai 官方 SDK）

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="sk-any",          # 免密时随便填，不能空
    timeout=600,               # solo 通道会排队，别用默认的 60 秒
)

r = client.chat.completions.create(
    model="glm-5__max",
    messages=[{"role": "user", "content": "你好"}],
)
print(r.choices[0].message.content)

# 流式
stream = client.chat.completions.create(
    model="glm-5__max",
    messages=[{"role": "user", "content": "数到五"}],
    stream=True,
)
for chunk in stream:
    d = chunk.choices[0].delta
    if getattr(d, "reasoning_content", None):
        print(f"[思考] {d.reasoning_content}")
    if d.content:
        print(d.content, end="", flush=True)
```

## Node（openai 官方 SDK）

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8787/v1',
  apiKey: 'sk-any',
  timeout: 600000,
});

const stream = await client.chat.completions.create({
  model: 'glm-5__max',
  messages: [{ role: 'user', content: '数到五' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

## 原生 fetch（不装 SDK）

```js
const res = await fetch('http://127.0.0.1:8787/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'glm-5__max',
    messages: [{ role: 'user', content: '你好' }],
  }),
});
const data = await res.json();
console.log(data.choices[0].message.content);
```

## 工具调用（tools / function calling）

标准 OpenAI 用法，`tools`、`tool_choice`、旧版 `functions` 都收，返回标准 `tool_calls`。

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "solo::deepseek-v4.1-flash__max",
    "messages": [{"role":"user","content":"杭州天气怎么样？"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市的当前天气",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }]
  }'
```

非流式返回：

```json
{
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "",
      "tool_calls": [{
        "id": "call_i1ax7upkkwcnrsitg4dnljxu",
        "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\": \"杭州\"}" }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

流式按官方语义下发：首帧带 `id` / `type` / `function.name`，后续帧只带 `function.arguments` 增量。

```json
{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}
{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]},"finish_reason":null}]}
{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"杭州\"}"}}]},"finish_reason":null}]}
{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
```

工具结果回灌就是标准 OpenAI 写法，**必须带 `tool_call_id`**，上一轮的 `tool_calls`
原样放回 `messages` 里（网关会翻成上游要的 `function_call` 键）：

```json
{"model":"solo::deepseek-v4.1-flash__max","tools":[ ... ],
 "messages":[
   {"role":"user","content":"杭州天气怎么样？"},
   {"role":"assistant","content":null,"tool_calls":[{ "id":"call_x","type":"function",
     "function":{"name":"get_weather","arguments":"{\"city\": \"杭州\"}"}}]},
   {"role":"tool","tool_call_id":"call_x","content":"晴，28℃"}
 ]}
```

各通道差异：

| 通道 | 实现 |
| --- | --- |
| `solo::` | 原生。上游 `tools[].function.parameters` 必须是 JSON **字符串**，网关自动转换；`tool_calls` 帧里键名是 `function_call`，网关翻成 `function` |
| `openai::` | 原生透传 |
| `trae::` `qoder::` `qoder-intl::` `workbuddy::` | 走文本协议：函数清单注入提示词，模型输出调用标记，网关还原。可靠性不如原生；客户端负责执行工具 |

### 标记解析引擎（2026-11-10 起）

文本协议通道全部走同一个引擎 `src/markup.js`。它的语义和旧实现有两处关键差别：

1. **看到标记就整段扣留到轮末再判定**，不再逐字符边到边解析。所以同一个调用无论被
   怎么切帧（逐字符、7 字节、整块）结果完全一致 —— 分帧边界不再是 bug 来源。
2. **解析不出调用就降级成正文，不再整轮失败**。旧行为是返回 502
   `upstream_invalid_tool_markup`「上游返回了无法解析的工具调用标记」，用户会丢掉整段
   上下文；现在最坏情况是这一轮没有工具调用。

底线没有放宽：工具名必须在本轮 `tools` 声明里，参数必须是完整 JSON 对象；不补括号、不猜参数。

认得的拼写（同一份数据可以用任意一种写，混着写也行）：

| 形态 | 例子 |
| --- | --- |
| 标准 JSON | `<tool_call>{"name":"read","arguments":{"file_path":"a.js"}}</tool_call>` |
| 只有开头 | `<tool_call>{"name":"read","arguments":{"file_path":"a.js"}}` |
| DeepSeek DSML | `<｜｜DSML｜｜invoke name="read"><｜｜DSML｜｜parameter name="file_path" string="true">a.js</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>`（管道数量、全/半角任意） |
| 混合闭合 | `<tool_call>{…}</｜｜DSML｜｜ parameter>` ← 2026-11-10 线上失败的真实形状 |
| Claude / MiniMax | `<function_calls><invoke name="read"><parameter name="file_path">a.js</parameter></invoke></function_calls>`、`<minimax:tool_call>`、裸 `<invoke>` |
| GLM | `<tool_call>read<arg_key>file_path</arg_key><arg_value>a.js</arg_value></tool_call>` |
| 豆包 Seed | `<seed:tool_call>{…}</seed:tool_call>` |
| 批量数组 | `<tool_calls>[{…},{…}]</tool_calls>`、`{"tool_calls":[…]}` |
| 围栏信封 | ` ```json\n{"tool_calls":[…]}\n``` `（仅 workbuddy 文本模式开启） |
| 裸 JSON | 行首 `{"name":"read","arguments":{…}}`，值一闭合就判定 |

`<seed:tool_call></seed:tool_call>` 这类**空标记**会被整段丢掉（留着会被模型学回去）；
调用之后的「我自己编的工具结果」和后续角色行（`<tool_result>`、`User:`、`Assistant:`、`[工具结果]`）
会被截断，不会回流成下一轮历史。

验证：`node tools/test_markup.mjs` —— 32 个真实工具签名 × 16 种拼写，每条在所有分割点各回放一次，
共 8.8 万次分帧回放；另有负样本（截断、未声明工具、非对象参数、围栏示例）与垃圾输入鲁棒性检查。

## 非标准扩展字段

为了展示进度和诊断延迟，响应在标准 OpenAI 字段之外提供以下扩展。
标准 SDK 会忽略它们，不影响兼容性。

**`gateway_status`**：上游排队进度。`delta` 为空，只做状态提示。
solo 通道高峰期会排队 1~3 分钟，前端靠它显示「前方还有 N 个请求」。

```json
{"choices":[{"index":0,"delta":{},"finish_reason":null}],
 "gateway_status":"排队中，前面还有 42 个请求"}
```

**`delta.reasoning_content`**：思考链增量。DeepSeek / GLM 这类推理模型会先吐思考再吐正文。
只想要最终答案就忽略它；想在终端里区分就用上面 Python 示例的写法。

**`gateway_timing`**：出现在流式结束帧和非流式结果，单位毫秒。
`queue_ms` 是上游报告的排队时间；`upstream_headers_ms` 是上游响应头到达时间；
`first_tool_call_ms`、`first_text_ms`、`first_reasoning_ms` 是网关首次收到相应内容的时间；
`total_ms` 是适配器消费完毕的时间。未观测到的字段省略。
CLI通道的 `cli_first_event_ms` 仅表示首次CLI事件，不能当作上游HTTP响应时间。
这些时间不包含调用方实际执行工具或下一轮请求的耗时。

## 错误码

| 状态 | `error.type` | 常见原因 |
| --- | --- | --- |
| 401 | `authentication_error` | 服务端设了 `GATEWAY_KEY` 但没传或传错 |
| 400 | `authentication_error` | 上游 Trae token 缺失 / 过期（约 14 天） |
| 404 | `invalid_request_error` | 模型名不存在（看 `available:` 后面那串） |
| 400 | `invalid_request_error` | `messages` 为空 |
| 502 | `upstream_error` | 上游返回异常，看 `gateway.log` |
| 500 | `upstream_error` | 网关内部错误 |

错误体是标准 OpenAI 格式：

```json
{"error": {"message": "unknown model 'glm-5'. available: ...", "type": "invalid_request_error", "code": 404}}
```

## 接第三方客户端

凡是让填「OpenAI API」的地方都这么配：

| 字段 | 值 |
| --- | --- |
| API Base / Base URL | `http://<IP>:8787/v1` |
| API Key | `sk-any`（免密时随便填） |
| Model | 从 `/v1/models` 里挑，例如 `glm-5__max` |

Cherry Studio / Chatbox / Open WebUI / LobeChat / Dify / n8n 都是这一套。
有些客户端会强制要求「测试连接」通过，它打的是 `/v1/models`，正常就能过。

## 注意事项

- **超时设长一点。** solo 通道是公共调度池，空闲时段 1~3 秒，高峰能排到几分钟。
  SDK 默认 60 秒会提前断开，建议 600 秒。
- **别频繁中断重发。** 排队中取消，上游任务不会立刻释放，立刻重发等于重新排队尾。
- **上下文要自己控制。** 网关不做历史裁剪，`messages` 多长就传多长，超长会被上游截断。
- 会话过期后，按 README 中对应通道的步骤更新本机配置并重启。[通道与账号配置](README.md#通道与账号配置)
- **仅供自用。** 这是拿你的个人账号额度在跑，不要对外提供服务。
