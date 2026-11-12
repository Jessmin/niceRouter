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

`start.bat` 会寻找可用的 Node.js，启动开发监听并打开本机网页。改动 `src/` 下的运行代码、WorkBuddy CLI 封装或随附模型配置时，网关会自动重载。运行 `stop.bat` 可以停止这份项目的监听进程及其网关。请从独立的 PowerShell 启动，避免让网关继承上层 AI 客户端的沙盒环境。[本机网页](http://127.0.0.1:8787/)

如需指定 Node.js 路径，在启动前设置 `$env:NODE_EXE = 'C:\path\to\node.exe'`。从旧版普通进程切换时，先退出旧实例，再运行 `start.bat`。要改 `.env`，请先运行 `stop.bat`，修改后再启动。也可以用 `npm start` 在前台运行固定版本，并用 `Ctrl+C` 停止。

## 通道与账号配置

用运行网关的 Windows 用户登录所需的官方客户端，再启动网关。Qoder 两版、WorkBuddy 和 MiniMax Code 会查找并复用当前用户的登录。通过 `/v1/models` 查看可用的完整模型 ID。

首页计数表示已接入的模型通道。Windows 会先检查常见安装目录和注册信息。在网关所在电脑打开网页时，首次发现客户端安装目录缺失会弹窗列出这些客户端。已安装的可以点「选择文件夹」，未安装或暂时不用的可以跳过。选中的目录在重启网关后生效。

之后可从「设置 → 客户端接入状态」补选目录或查看登录提示。用自定义路径变量配置过的客户端继续采用显式配置。

| 通道 | 模型前缀 | 本机准备 |
| --- | --- | --- |
| Trae IDE | `trae::` | 识别 Trae CN 后填入转发接口的 `Cloud-IDE-JWT` |
| Trae SOLO | `solo::` | 与 Trae IDE 共用 Trae CN 账号和会话 |
| Qoder CN | `qoder::` | 登录 Qoder CN，启动时自动读取本机额度与签到授权 |
| Qoder 国际版 | `qoder-intl::` | 登录 Qoder 国际版，启动时自动读取该版本的本机会话 |
| WorkBuddy | `workbuddy::` | 登录 WorkBuddy，网关复用官方 CLI 和登录信息，自动加载模型目录 |
| MiniMax Code | `minimax-code::` | 登录 MiniMax Code 桌面端。国际区可设 `MINIMAX_CODE_REGION=global` |
| 豆包 | `doubao::` | 登录豆包桌面端并刷新本机加密授权 |

### Trae CN 与 SOLO

网关会从已识别的 Trae CN 安装读取应用 ID 和构建信息，补齐转发请求头。Trae IDE 与 SOLO 的转发需要单独的 `Cloud-IDE-JWT` 授权。已有有效令牌时，可通过 `.env` 的 `TRAE_TOKEN` 配置，也可在本机网页的「设置」中填入。网页填写的令牌只在本次运行中保留。

已有 `config/trae-session.json` 或 `.env` 中的 `TRAE_HEADERS`、`TRAE_DEVICE_ID` 会优先使用。手工配置会话时，`headers.authorization` 使用 `Cloud-IDE-JWT <本机令牌>`，`headers.x-ide-token` 使用同一令牌。[Trae 会话模板](config/trae-session.example.json)

### Qoder CN 与国际版

登录对应的官方应用后启动网关。网关会将当前 Windows 用户的有效授权读入内存，优先采用显式 Token 或未标明过期的会话文件。桌面会话过期时，在官方客户端重新登录并重启网关。

自定义数据目录可设 `QODER_CN_USER_DATA` 或 `QODER_INTL_USER_DATA`。如需手动导出会话，以下工具分别生成 `config/qoder-session.json` 和 `config/qoder-intl-session.json`，也支持 `--user-data`。

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

- WorkBuddy 登录读取已验证 5.5.6、5.6.2、5.8.3 和 5.9.4 的会话格式。首次启动缺少模型缓存时，网关先显示随附目录，再后台向官方服务刷新目录。
- WorkBuddy 的非默认安装或配置目录可设置 `WORKBUDDY_INSTALL_DIR`、`WORKBUDDY_CONFIG_DIR`。MiniMax Code 可设置 `MINIMAX_CODE_INSTALL_DIR`、`MINIMAX_CODE_DATA_DIR`。
- 其他 OpenAI 兼容上游可配置 `UPSTREAM_BASE`、`UPSTREAM_KEY`，然后使用 `openai::` 前缀。`MODELS_FILE` 可指定一份与上游匹配的清单。[模型清单格式](config/models.json)

## 接入 DeepSeek Harness

在运行网关的电脑上打开本机网页，到「设置 → API 密钥管理」创建密钥并复制。完整密钥只在创建后显示，可为不同客户端分别创建，撤销后立即拒绝该密钥的新请求。网页聊天和 `/v1/*` 接口都需要有效密钥。

在 DeepSeek Harness 新建自定义模型 API，协议选择 **OpenAI Chat Completions**。同一台电脑的 Base URL 使用 `http://127.0.0.1:8787/v1`，从内网或 ZeroTier 连接时改用网关对应的内网地址。API Key 填创建的密钥，模型 ID 从 `/v1/models` 复制。

```powershell
$gateway = 'http://127.0.0.1:8787'
$headers = @{ Authorization = "Bearer $env:NICEROUTER_API_KEY" }
Invoke-RestMethod "$gateway/health"
Invoke-RestMethod "$gateway/v1/status" -Headers $headers
(Invoke-RestMethod "$gateway/v1/models" -Headers $headers).data
```

对话接口为 `POST /v1/chat/completions`。调用方可声明工具并执行返回的 `tool_calls`，随后用相同的 `tool_call_id` 回传 `role: tool` 消息。当前版本已在 DeepSeek Harness 实测七条桌面通道的流式正文与工具结果回传。[API 调用示例](API.md)

## 签到、额度与运行配置

| 配置 | 用途 |
| --- | --- |
| `HOST`、`PORT` | 默认监听 `0.0.0.0:8787`，按实际连接来源允许本机、私有内网和 ZeroTier。旧配置若设了 `HOST=127.0.0.1`，可改为 `HOST=0.0.0.0` 启用内网访问 |
| `GATEWAY_KEY` | 已配置的旧密钥仍可调用 API。在 `.env` 清除该值并重启即可停用它 |
| `ADAPTER` | 无前缀模型 ID 的默认通道，默认为 `solo`。带前缀时按前缀路由 |
| `AUTO_CHECKIN_ENABLED` | 默认在启动后检查签到，运行期间每 15 分钟复查。设为 `0` 可关闭 |
| `AUTO_DISCOVER_DESKTOP_AUTH` | 设为 `0` 可关闭 Qoder 桌面授权的自动读取 |
| `GATEWAY_OPEN_BROWSER` | 设为 `0` 可禁止 `start.bat` 自动打开浏览器 |

额度和签到结果可在网页或 `/v1/quota`、`/v1/checkin` 查看。用量账本记录网关观察到的扣费或可匹配的累计消耗变化，按北京时间分日和分月，重启后在本机继续记录。

**豆包签到的已知问题**。部分领取请求返回 `710010702`，官方活动页点击签到也曾失败。网关保留失败状态，并在下一个检查周期复查。

`.env`、`config/api-keys.json`、`config/*-session.json`、DPAPI 授权、登录缓存、日志与账本请留在本机。迁移时在目标电脑上登录所需客户端，创建 API 密钥，并按上文准备需要单独配置的会话。[运维与故障定位](SOP.md)
