# trae-solo-local-api

> 项目说明（2026-07-31）：TRAE WORK 已改用积分制并取消免费政策，本项目后续随缘更新。仓库中的模型思考 prompt 前缀注入方案可能仍有一定研究价值，欢迎自行研究和验证。

把 **TRAE SOLO (Trae Work)** 包装成本地 OpenAI / Anthropic 兼容 API，供 Claude Code、Cursor、Cline、OpenCode 等调用 SOLO 底层模型。

- **本仓库**：https://github.com/Ttungx/trae-solo-local-api  
- **上游**：https://github.com/ZedeX/trae-local-api  

本仓库是 SOLO 适配分支，不是官方上游。

## 主要改动

| 改动 | 说明 |
|---|---|
| 数据目录 | 优先 `%APPDATA%\TRAE SOLO CN`，支持 `APPDATA` 重定向 |
| 功能池 | 指定模型走 `solo_work_lite`（轻排队），避免 `chat_v3` |
| Think effort | 按模型注入 reasoning-effort 前缀（见下） |
| Auto-continue | 思考后空结束时自动再请求（OpenAI + Anthropic） |
| 排队降级 | OpenAI 端点支持超阈值换模型 |
| 模型表 | 补充真实 SOLO `config_name` + fallback |

> 默认按 SOLO 轻路径。未完成：完整 `create_agent_task` 对齐（见 `TODO.md`）。

## 快速开始

```bash
git clone https://github.com/Ttungx/trae-solo-local-api.git
cd trae-solo-local-api
npm install
cp .env.example .env   # TRAE_PRODUCT=solo
npm start
```

服务：`http://localhost:19900`  
Key：`.env` 的 `API_KEY`

## 验证

```bash
curl -s http://localhost:19900/v1/status \
  -H "Authorization: Bearer trae-solo-local-api-key"

curl -s http://localhost:19900/v1/chat/completions \
  -H "Authorization: Bearer trae-solo-local-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

日志应出现 `function=solo_work_lite, config_name=glm-5.2`。

## 接口目录（推荐 MCP / 客户端使用）

| 端点 | 说明 |
|---|---|
| `GET /v1` | JSON 路由目录 + 功能矩阵 |
| `GET /v1/openapi.json` | 最小 OpenAPI 3.0 |
| `GET /v1/info` | 需鉴权，含 endpoints + features |
| `GET /v1/status` | token 状态 + auto_continue 配置 |
| `GET /health` | 存活探针（无鉴权） |

主对话端点：

| 协议 | 路径 |
|---|---|
| OpenAI | `POST /v1/chat/completions` |
| Anthropic | `POST /v1/messages` |

鉴权（三选一）：
- `Authorization: Bearer <API_KEY>`
- `x-api-key: <API_KEY>`
- `?key=<API_KEY>`

错误体（OpenAI 兼容路径）：
```json
{ "error": { "message": "...", "type": "invalid_request_error", "code": "..." } }
```

`/v1/messages` 仍使用 Anthropic 错误格式。

## 客户端

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:19900"
$env:ANTHROPIC_API_KEY = "trae-solo-local-api-key"
claude
```

Cursor / Cline / OpenCode：Base URL `http://localhost:19900/v1`，Key 同上，Model 推荐 `auto` 或 `glm-5.2`。

## Think effort（推理深度控制）

SOLO `llm_utils_chat` **没有**原生 `reasoning_effort` 参数。本项目在网关层按模型族把**固定字符串** prepend 到 system 顶部，实现“曲线救国”。

> 灵感来源：[Controlling Reasoning Effort in LLMs](https://magazine.sebastianraschka.com/p/controlling-reasoning-effort-in-llms)

### 参数

| 字段 | 说明 |
|---|---|
| `think_effort` | **主字段** |
| `reasoning_effort` | 别名 |

取值：`auto`（默认，不注入） | `off` | `low` | `high` | `max`

不支持的模型/档位 → 静默 no-op，请求仍成功。换模/降级时会按新 `config_name` 重新计算前缀。

能力查询：`GET /v1/think-effort`

### 支持模型与档位

| SOLO 模型 (`config_name`) | 支持 `think_effort` | 注入前缀（来源见下） |
|---|---|---|
| `glm-5.2` | `high`, `max` | `Reasoning Effort: High` / `Max`（短标签；**不要用 Absolute 长串**） |
| `DeepSeek-V4-Pro` | `max` | Absolute maximum **长串**（短 `Max` 无效） |
| `kimi-k2.7-code` | `low`, `max` | `low` = `<critical_constraints>` 压 overthink；`max` = Absolute 长串加深 |

**来源说明**（注入字符串来源于官方仓库与技术报告，本地 probe 验证有效）：

- **DeepSeek-V4** Absolute-max 长串：官方 HF encoding/README  
  https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/main/encoding/README.md

- **GLM-5.2**：官方 HF chat_template.jinja  
  https://huggingface.co/zai-org/GLM-5.2/blob/main/chat_template.jinja

- **通用 reasoning effort 训练机制**：Sebastian Raschka - Controlling Reasoning Effort in LLMs  
  https://magazine.sebastianraschka.com/p/controlling-reasoning-effort-in-llms

- **Kimi 低思考约束**：社区逆向 + 训练技术（截断暴露疗法等），详见 `think effort/AI模型推理指令挖掘.md`

其他模型（含 `auto`）：`think_effort` 忽略。

### 示例

```bash
curl -s http://localhost:19900/v1/chat/completions \
  -H "Authorization: Bearer trae-solo-local-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "DeepSeek-V4-Pro",
    "think_effort": "max",
    "messages": [{"role": "user", "content": "findMin in rotated sorted array"}],
    "stream": false
  }'
```

日志应出现 `[think_effort ...] injected=yes`。

## Auto-continue（长思考不空结束）

SOLO 有时只输出 reasoning 就结束，导致 OpenCode 等客户端“正常结束但没答案”。

本项目在服务端统一处理（OpenAI + Anthropic 共用逻辑）：

- **只有思考、无正文、无 tool** → 自动再请求
- **半截输出**（未闭合代码块、句尾断裂等）→ 自动续
- `finish_reason=length` → 自动续
- 上限默认 **10** 次（`MAX_CONTINUES`）

配置（.env）：

```bash
AUTO_CONTINUE=true
MAX_CONTINUES=10
```

日志关键字：`auto_continue ... reason=reasoning_only`

## 目录结构

```
src/           核心服务 + 客户端
  think-effort.js
  auto-continue.js
  api-catalog.js
  errors.js
web/           Dashboard
scripts/       模型拉取 / probe
doc/           设计文档
model-config.json
SOLO_PARITY.md
TODO.md
.env.example
```

## FAQ

| 问题 | 处理 |
|---|---|
| 无 auth | 登录 SOLO；检查 storage 或设 `TRAE_DATA_DIR` |
| 指定模型慢 | 日志必须是 `solo_work_lite` |
| `Error 4001` | `config_name` 不在 SOLO 目录；用真实名 |
| `think_effort` 无效果 | 只支持表中三模型；看日志 `injected=yes/no` |
| OpenCode 思考后没下文 | 已开 auto-continue；日志应有 `reason=reasoning_only` |

同步官方模型表：

```bash
node scripts/dump-model-detail.js
# 结果在 output/（已 gitignore）
```

---

**仅供学习研究。遵守 SOLO / Trae 服务条款。**

