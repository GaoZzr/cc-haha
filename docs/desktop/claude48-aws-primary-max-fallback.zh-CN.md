# Claude 4.8：AWS 默认、MAX 回退

## 当前结论

`MicuAPI Claude Opus 4.8 MAX` 是目前本地实测确认带 thinking 的高价/高配路线；`MicuAPI Claude AWS Reverse free_2` 也会返回 thinking block，但更像 AWS/反代包装，成本更低，适合做默认首选。

因此本地默认策略是：

| 角色 | Provider | Provider ID | 模型 |
| --- | --- | --- | --- |
| 默认首选 | MicuAPI Claude AWS Reverse free_2 | `micuapi-claude-aws-reverse-free2` | `claude-opus-4-8` |
| 自动回退 | MicuAPI Claude Opus 4.8 MAX | `214f8ce5-a6b6-49c2-bfa2-464ca3358bb0` | `claude-opus-4-8` |

## 行为说明

- `providers.json.activeId` 指向 AWS Reverse 后，新会话默认走便宜的 AWS route。
- AWS provider 显式配置 `fallbackProviderId = 214f8ce5-a6b6-49c2-bfa2-464ca3358bb0`。
- 同一轮里如果 AWS route 返回明显的 provider/API 类错误，例如 AUP/Usage Policy、429/529、5xx、网络或上游错误，桌面端会吞掉这次错误，切到 MAX provider，重启当前 session 的 CLI，并把原用户消息重发一次。
- 回退只做一次；MAX 再失败时会正常把错误显示给前端，避免 AWS 和 MAX 来回循环。
- fallback 是 provider 级别，不是模型名级别。因为 AWS 和 MAX 的模型名都可以是 `claude-opus-4-8`，真正差异在 provider 的 base URL、账号池和上游通道。

## thinking 说明

新 Opus 系列的 thinking 参数走 adaptive thinking：`thinking.type = adaptive`，并通过 `output_config.effort` 控制强度。旧的 `thinking.enabled + budget_tokens` 写法对新 Opus 可能无效。

本地实测口径：

| Route | thinking 现象 | 备注 |
| --- | --- | --- |
| AWS Reverse free_2 | 返回可见 thinking 文本 | 有时会出现英文“意图分析/包装感”，像 AWS/反代层额外暴露了思考块 |
| MAX | 返回 thinking token，但 thinking 文本常被隐藏或 redacted | 更像正规高配渠道，价格更高 |

## 维护提醒

- 无损升级后优先检查 `C:\Users\83964\.claude\cc-haha\providers.json` 是否仍保留 AWS 的 `fallbackProviderId`。
- 不要把 API key 写进文档、日志或提交。
- 如果供应商改名或 provider ID 变动，需要同步更新本文件和本地 `providers.json`。
