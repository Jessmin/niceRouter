# niceRouter

niceRouter 是运行在本机的 OpenAI Chat Completions 网关。它把多个已配置的 AI 通道统一到一个 API 和网页，供 DeepSeek Harness 等客户端调用。

- 使用 `provider::model` 选择通道，模型目录由 `/v1/models` 提供。
- 支持流式和非流式对话、工具调用及按原调用 ID 回传结果。上游提供思考内容时，网关会随响应转发。
- 网页可查看账户额度、自动签到结果，以及按北京时间汇总的本机今日和本月用量。

## 快速启动

在 Windows 上准备 **Node.js 22.9 或更新版本**，并安装要使用的官方客户端。网关本身无需安装 npm 依赖。[Node.js 下载](https://nodejs.org/en/download)

```powershell
git clone https://github.com/Jessmin/niceRouter.git
Set-Location .\niceRouter
Copy-Item .env.example .env
.\start.bat
```

`start.bat` 会寻找可用的 Node.js，并打开本机网页。也可以在项目目录执行 `npm start` 前台运行，或用 `node --env-file-if-exists=.env src/server.js` 直接启动。保持终端运行，用 `Ctrl+C` 停止。请从独立的 PowerShell 启动，避免让网关继承上层 AI 客户端的沙盒环境。[本机网页](http://127.0.0.1:8787/)

如需指定 Node.js 路径，在启动前设置 `$env:NODE_EXE = 'C:\path\to\node.exe'`。如果 `start.bat` 发现已有网关，它会打开该实例。更新源码后请重启，并通过 `/v1/status` 确认构建已切换。

## 通道与账号配置

在运行网关的 Windows 用户下登录所需的官方客户端，再按表准备本机会话。完成配置后重启网关，通过 `/v1/models` 查看当前可用的完整模型 ID。

首页计数表示已接入的模型通道。打开「设置 → 客户端接入状态」，可以查看本机识别到的应用、待配置原因和接入步骤。Windows 安装定位会核对常见目录和安装注册信息。安装位置特殊时，按下文设置对应的路径变量并重启网关。

| 通道 | 模型前缀 | 本机准备 |
| --- | --- | --- |
| Trae IDE | `trae::` | 登录 Trae CN，配置有效的本机会话 |
| Trae SOLO | `solo::` | 与 Trae IDE 共用 Trae CN 账号和会话 |
| Qoder CN | `qoder::` | 登录 Qoder CN，网关使用本机官方 worker。额度和签到需要刷新本机会话 |
| Qoder 国际版 | `qoder-intl::` | 登录 Qoder 国际版并刷新独立会话，网关使用本机官方 worker |
| WorkBuddy | `workbuddy::` | 登录 WorkBuddy 并完成初始化，网关使用官方 CLI 和本机产品配置 |
| MiniMax Code | `minimax-code::` | 登录 MiniMax Code 桌面端。国际区可设 `MINIMAX_CODE_REGION=global` |
| 豆包 | `doubao::` | 登录豆包桌面端并刷新本机加密授权 |

### Trae CN 与 SOLO

将 `config/trae-session.example.json` 复制为 `config/trae-session.json`，填写本机的 `deviceId` 和 `headers`。其中 `headers.authorization` 使用 `Cloud-IDE-JWT <本机令牌>`，`headers.x-ide-token` 使用同一令牌。也可通过 `.env` 的 `TRAE_TOKEN` 统一填入这两个授权头，用 `TRAE_HEADERS`（JSON 对象）和 `TRAE_DEVICE_ID` 补充本机客户端字段。[Trae 会话模板](config/trae-session.example.json)

### Qoder CN 与国际版

登录对应的官方应用后，在项目目录运行对应的刷新命令。它们分别生成 `config/qoder-session.json` 和 `config/qoder-intl-session.json`。会话过期时，重新登录后再刷新。

```powershell
# Qoder CN
node --env-file-if-exists=.env tools/refresh-qoder-auth.mjs

# Qoder 国际版
node --env-file-if-exists=.env tools/refresh-qoder-intl-auth.mjs
```

安装在其他目录时，CN 可设置 `QODER_EXE` 和 `QODER_WORKER`，国际版可设置 `QODER_INTL_EXE` 和 `QODER_INTL_WORKER`。CN worker 如需单独登录，可运行 `tools/qoder-cli-login.bat`。

### 豆包

登录官方桌面端后退出豆包，包括托盘后台，让本机登录数据库解除占用，再执行刷新。刷新完成后可重新打开豆包。此命令需要支持 `node:sqlite` 的 Node.js，已在 Node.js 22.22.2 验证。

```powershell
node --env-file-if-exists=.env tools/refresh-doubao-auth.mjs
```

授权文件由当前 Windows 用户的 DPAPI 加密。更换电脑或 Windows 用户时，需要在目标机重新登录并刷新。模型 ID 通常为 `doubao::0`（快速）和 `doubao::3`（专家），以当前模型列表为准。

### 其他本机配置

- WorkBuddy 的非默认安装或配置目录可设置 `WORKBUDDY_INSTALL_DIR`、`WORKBUDDY_CONFIG_DIR`。MiniMax Code 可设置 `MINIMAX_CODE_INSTALL_DIR`、`MINIMAX_CODE_DATA_DIR`。
- 其他 OpenAI 兼容上游可配置 `UPSTREAM_BASE`、`UPSTREAM_KEY`，然后使用 `openai::` 前缀。`MODELS_FILE` 可指定一份与上游匹配的清单。[模型清单格式](config/models.json)

## 接入 DeepSeek Harness

在 DeepSeek Harness 新建自定义模型 API，协议选择 **OpenAI Chat Completions**。Base URL 使用 `http://127.0.0.1:8787/v1`，模型 ID 从 `/v1/models` 复制。设置了 `GATEWAY_KEY` 时填入该密钥，本机免密时可使用占位值 `sk-any`。

```powershell
$gateway = 'http://127.0.0.1:8787'
$headers = @{ Authorization = 'Bearer sk-any' }
Invoke-RestMethod "$gateway/health"
Invoke-RestMethod "$gateway/v1/status" -Headers $headers
(Invoke-RestMethod "$gateway/v1/models" -Headers $headers).data
```

对话接口为 `POST /v1/chat/completions`。调用方可声明工具并执行返回的 `tool_calls`，随后用相同的 `tool_call_id` 回传 `role: tool` 消息。当前版本已在 DeepSeek Harness 实测七条桌面通道的流式正文与工具结果回传。[API 调用示例](API.md)

## 签到、额度与运行配置

| 配置 | 用途 |
| --- | --- |
| `HOST`、`PORT` | 默认监听 `127.0.0.1:8787`。通过局域网访问时，将 `HOST` 设为 `0.0.0.0` 并配置强随机 `GATEWAY_KEY` |
| `ADAPTER` | 无前缀模型 ID 的默认通道，默认为 `solo`。带前缀时按前缀路由 |
| `AUTO_CHECKIN_ENABLED` | 默认在启动后检查签到，运行期间每 15 分钟复查。设为 `0` 可关闭 |
| `GATEWAY_OPEN_BROWSER` | 设为 `0` 可禁止 `start.bat` 自动打开浏览器 |

额度和签到结果可在网页或 `/v1/quota`、`/v1/checkin` 查看。用量账本记录网关观察到的扣费或可匹配的累计消耗变化，按北京时间分日和分月，重启后在本机继续记录。

**豆包签到的已知问题**。部分领取请求返回 `710010702`，官方活动页点击签到也曾失败。网关保留失败状态，并在下一个检查周期复查。

`.env`、`config/*-session.json`、DPAPI 授权、登录缓存、日志与账本请留在本机。迁移时在目标电脑上登录所需客户端并重新生成账号配置。[运维与故障定位](SOP.md)
