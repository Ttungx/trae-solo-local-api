# CLAUDE.md — trae-solo-local-api

commit message 采用中文

注意使用 codegraph mcp

## 项目

TRAE SOLO → 本地 OpenAI/Anthropic API。  
本仓库：https://github.com/Ttungx/trae-solo-local-api  
上游：https://github.com/ZedeX/trae-local-api

## 怎么跑

```bash
cp .env.example .env   # TRAE_PRODUCT=solo
npm install
npm start              # http://localhost:19900
```

需本机已登录 TRAE SOLO；读 `%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json`。

## 技术栈

Node.js (Express)、node-fetch、dotenv；无打包步骤。

## 约定

- **默认产品线 SOLO**：指定模型 `function=solo_work_lite`，勿改回 `chat_v3` 作主路径（排队重）。
- 数据路径用 `APPDATA` / `TRAE_DATA_DIR`，不要写死 `homedir\AppData`。
- SOLO device id 来自 `iCubeAuthInfo://icube-dc:<id>`。
- 勿提交 `.env`、`logs/`、`captures/`、含 `encrypted_model_params` 的临时 JSON。
- 权威文档：`README.md`、`SOLO_PARITY.md`、`TODO.md`。

## 状态

- 可用：解密 + `solo_work_lite` 对话 + OpenAI 排队降级 + 4001/4023 换模  
- `model-config.json` 的 tiers/fallback **必须**是 SOLO `get_detail_param` 里真实 `config_name`（无 `glm-5.1` 等幽灵名）  
- Think effort：`src/think-effort.js` + body `think_effort`；仅 `glm-5.2` / `DeepSeek-V4-Pro` / `kimi-k2.7-code`（见 `doc/think-effort.md`）  
- Auto-continue：`src/auto-continue.js`；OpenAI+Anthropic；默认 `MAX_CONTINUES=10`；只有思考无正文必续  
- API 目录：`GET /v1`、`GET /v1/openapi.json`（`src/api-catalog.js`）；错误形 `src/errors.js`  
- 待做：模型表自动同步、SOLO 完整 `create_agent_task` 对齐（见 `TODO.md`）
