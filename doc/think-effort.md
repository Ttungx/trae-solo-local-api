# Think Effort 注入（曲线救国）

> 状态：已落地（2026-07-23）
> 实现：`src/think-effort.js` · 请求参数 `think_effort` / `reasoning_effort`
> 实验脚本：`scripts/probe-reasoning-effort.js` · `scripts/probe-reasoning-deepen.js`

## 1. 背景与方案

SOLO `llm_utils_chat` 不提供原生 `reasoning_effort` / `enable_thinking` 参数，只稳定接受 `messages`、`function` 和 `config_name`。本项目因此在网关层按模型族把固定的 reasoning 前缀添加到 system 消息最前面。

设计原则：

1. 前缀固定并置于 system 第一个字节，减少动态文本对缓存和模板匹配的影响。
2. 按模型族选择前缀，不跨模型复用未经验证的指令。
3. fallback 或换模时先移除旧 marker，再按新的 `config_name` 重新计算。
4. 不支持的模型或档位静默 no-op，请求仍正常返回。
5. 实验指标是 reasoning 长度与耗时，不代表答题质量或事实正确率。

所有网关注入内容包在以下 marker 中，便于重复请求和换模时清理：

```text
<<think_effort>>
…prefix…
<</think_effort>>
```

## 2. 当前支持矩阵

| SOLO `config_name` | `think_effort` | 注入内容 |
|---|---|---|
| `glm-5.2` | `high` | `Reasoning Effort: High` |
| `glm-5.2` | `max` | `Reasoning Effort: Max` |
| `DeepSeek-V4-Pro` | `max` | Absolute-maximum 长前缀 |
| `kimi-k2.7-code` | `max` | Absolute-maximum 长前缀 |
| `kimi-k2.7-code` | `low` | `<critical_constraints>…never draft…` |
| 其它模型 | 任意 | 不注入 |

`auto` 和 `off` 均不注入；`off` 还会清理历史 marker。

## 3. 配置与 API

### 3.1 全局开关与优先级

主开关由环境变量控制，读取于服务启动时：

```env
THINK_EFFORT_INJECTION=true
THINK_EFFORT=auto
```

- `THINK_EFFORT_INJECTION=false`：完全关闭网关注入，恢复模型原生行为。
- 注入开启且未指定档位时，默认档位为 `max`。
- 请求体优先级：body `think_effort` / `reasoning_effort` > session `think_effort` > 环境变量 `THINK_EFFORT`。
- 可用值：`off`、`auto`、`low`、`high`、`max`；别名 `none`→`off`、`medium`→`high`、`deep`/`ultra`→`max`。
- 修改环境变量后必须重启 API。

### 3.2 OpenAI 兼容接口

```bash
curl -s http://localhost:19900/v1/chat/completions \
  -H "Authorization: Bearer trae-solo-local-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "think_effort": "max",
    "messages": [{"role":"user","content":"prove why mid vs right"}],
    "stream": false
  }'
```

### 3.3 Anthropic 兼容接口

```bash
curl -s http://localhost:19900/v1/messages \
  -H "Authorization: Bearer trae-solo-local-api-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "DeepSeek-V4-Pro",
    "max_tokens": 2048,
    "think_effort": "max",
    "messages": [{"role":"user","content":"findMin rotated array"}]
  }'
```

### 3.4 能力查询与日志

```http
GET /v1/think-effort
Authorization: Bearer …
```

成功注入时日志类似：

```text
[think_effort] model=DeepSeek-V4-Pro family=deepseek effort=max injected=yes
```

## 4. 实现位置

| 文件 | 职责 |
|---|---|
| `src/think-effort.js` | 前缀、档位解析、marker 清理、注入和能力矩阵 |
| `src/server.js` | 解析请求参数，并在每次 `llmUtilsChat` 前按当前 config 重算 |
| `src/config-schema.js` | session 默认值与参数校验 |
| `tests/server/think-effort.test.js` | 注入、清理和解析的单元测试 |

注入发生在 tool 协议处理之后、实际 SOLO 请求之前；fallback / race 切换 `config_name` 后会重新应用。

## 5. 实验设计

### 5.1 任务与条件

统一实验使用 `scripts/probe-reasoning-deepen.js`，固定任务为：

```text
nums is a rotated sorted array with UNIQUE ints. Write findMin(nums) binary search O(log n). One counterexample if you used mid vs left instead of mid vs right. English. Code + 3-6 sentence proof. No fluff.
```

每次请求使用相同基础 system prompt：

```text
You are a careful coding assistant. Prefer correct algorithms.
```

四个条件只改变 system 前缀：

| 条件 | 前缀 | 用途 |
|---|---|---|
| `base` | 无 | 基线 |
| `max_short` | `Reasoning Effort: Max` | 短模型标签 |
| `max_abs` | `Reasoning Effort: Absolute maximum...`，要求充分拆解、检查边界和中间步骤 | 长模型专属候选 |
| `thorough` | `Thinking Mode: Maximum depth...`，要求完整推理链、边界和被排除方案 | 通用加深对照 |

### 5.2 控制变量与统计口径

- 固定 `model` 与 `config_name`，有效响应的返回模型必须匹配目标模型。
- 服务端 `THINK_EFFORT_INJECTION=false`，脚本手动注入前缀，避免双重注入。
- `autoFallback=false`、tier fallback/race 关闭、`queueThreshold=99999`。
- `max_tokens=2048`；单请求超时 300 秒。
- 主要指标：`reasoning_content` 字符数；同时记录耗时、可见正文字符数、completion tokens 和失败原因。
- **有效实验**：在超时前成功返回完整 JSON；失败不计入有效样本，也不按 0 计入统计。
- **实验成功**：有效样本的 reasoning 字符数高于同模型 base 的 5 次均值。
- 均值、范围、CV（样本标准差/均值）用于主报告；原始样本方差和标准差保留在 JSON，可复算。

## 6. 最终实验结果（2026-07-30 至 2026-07-31）

### 6.1 汇总表

| 模型 / 条件 | 有效实验 / 总请求 | 实验成功 | reasoning 均值 | 最小–最大 | CV | 最大/最小 | 平均耗时 |
|---|---:|---:|---:|---:|---:|---:|---:|
| **GLM base** | 5/5 | 3/5 | 8,101 | 3,792–13,227 | 50.9% | 3.49× | 33.0 s |
| GLM `max_short` | 5/7 | 5/5 | 29,586 | 11,569–52,048 | 51.0% | 4.50× | 134.3 s |
| GLM `max_abs` | 5/9 | 4/5 | 45,852 | 4,036–70,869 | 60.0% | 17.56× | 201.2 s |
| GLM `thorough` | 5/6 | 4/5 | 39,785 | 1,958–59,459 | 56.5% | 30.37× | 185.1 s |
| **DeepSeek base** | 5/5 | — | 3,361 | 1,302–5,380 | 43.5% | 4.13× | 23.6 s |
| DeepSeek `max_short` | 5/5 | 5/5 | 4,849 | 3,607–5,997 | 19.8% | 1.66× | 32.7 s |
| DeepSeek `max_abs` | 5/5 | 5/5 | 4,792 | 4,091–6,462 | 19.9% | 1.58× | 33.3 s |
| DeepSeek `thorough` | 5/5 | 4/5 | 5,342 | 3,280–8,438 | 36.1% | 2.57× | 35.5 s |
| **Kimi base** | 5/5 | — | 4,458 | 1,313–5,995 | 40.7% | 4.57× | 39.3 s |
| Kimi `max_short` | 5/5 | 1/5 | 3,026 | 1,358–5,419 | 49.7% | 3.99× | 34.5 s |
| Kimi `max_abs` | 5/5 | 2/5 | 5,642 | 2,480–13,231 | 77.1% | 5.34× | 50.2 s |
| Kimi `thorough` | 5/5 | 3/5 | 5,226 | 3,242–8,373 | 39.7% | 2.58× | 46.2 s |

注：base 是比较基线，不把 base 本身标为“成功”；若需要，按同一规则 base 中高于 base 均值的次数分别为 GLM 3/5、DeepSeek 2/5、Kimi 2/5。

### 6.2 结果解读

- **GLM-5.2**：三种前缀都提高了平均 reasoning，但代价显著。`max_short`、`max_abs`、`thorough` 的有效率分别为 5/7、5/9、5/6；长前缀伴随高延迟和超时风险。生产映射保留短 `Reasoning Effort: Max`，不建议使用 `max_abs` / `thorough`。
- **DeepSeek-V4-Pro**：三种前缀均 5/5 有效，平均 reasoning 分别比 base 高 44%、43%、59%；`max_short` 和 `max_abs` 的 CV 约 20%，相对稳定。当前 `max → max_abs` 有实验支持。
- **kimi-k2.7-code**：`max_short` 平均下降 32%；`max_abs` 上升 27% 但 CV 达 77.1%；`thorough` 上升 17%。当前 `max → max_abs` 方向有信号，但稳定性不足，后续应扩大样本后再强化结论。

### 6.3 失败说明

GLM 的失败均为实验客户端的 300 秒超时：`AbortSignal.timeout(300000)` 主动终止未完成的 HTTP 请求，并记录 `The operation was aborted due to timeout`。这不表示模型返回错误答案，也不表示发生了换模；由于没有完整 JSON，无法取得 reasoning 字符数，因此不计入有效样本。GLM 补跑使每个处理条件达到 5 个有效样本，但付出了额外请求：`max_short` 失败 2 次、`max_abs` 失败 4 次、`thorough` 失败 1 次。

## 7. 限制与后续

- 这是 SOLO 特定 `config_name` 的行为实验，不等价于模型官方 API。
- 样本量为每格 5 个有效样本，只能做描述性判断，不能宣称统计显著性。
- reasoning 字符数是深度代理指标，不代表答案质量、正确率或用户体验；尤其 GLM 的超时造成了可用性风险。
- `max_tokens` 在 SOLO 路径上不一定严格限制 reasoning 输出；本实验观测到 GLM 的 reasoning 远超 2048 token 的请求值。
- 未覆盖 `enable_thinking:false` 等模型原生开关；如需进一步验证，应单独设计实验。

## 8. 参考来源

- [DeepSeek-V4 encoding README](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/main/encoding/README.md)：Absolute maximum reasoning effort 前缀
- [GLM-5.2 chat template](https://huggingface.co/zai-org/GLM-5.2/blob/main/chat_template.jinja)：`Reasoning Effort: Max|High`
- [Sebastian Raschka — Controlling Reasoning Effort in LLMs](https://magazine.sebastianraschka.com/p/controlling-reasoning-effort-in-llms)：system 标签与推理条件化
- Kimi `<critical_constraints>`：见仓库 `think effort/AI模型推理指令挖掘.md`
