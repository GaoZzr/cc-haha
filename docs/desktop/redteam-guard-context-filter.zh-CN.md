# 红队守门误触发修复说明

## 背景

cc-haha 的真实桌面会话会把工具列表、Skills 列表、全局 `CLAUDE.md` 和其他 SDK 上下文放进模型输入。这些上下文常以 `<available-deferred-tools>`、`<system-reminder>`、`<user-prompt-submit-hook>` 等块出现。

本地红队工作流守门逻辑原先直接扫描整段最新用户消息。真实会话中，即使用户只输入“请只回复 OK”，SDK 上下文里也可能包含 `red-team`、`redteam-commander`、`github.com` 等字样，导致守门逻辑把普通请求误判为红队请求，并注入 `CC_HAHA_REDTEAM_WORKFLOW_CONTRACT`。

## 影响

误注入会让普通任务携带大段红队 workflow contract，造成三类问题：

- 输入 token 明显增加。
- 非官方模型容易被多余上下文带偏，例如 MiMo 会把 contract 当作提示注入并偏离“只回复 OK”的用户请求。
- Claude/Anthropic 类链路更容易触发供应商侧 cyber/usage policy 拦截。

## 修复

红队守门逻辑现在先提取真实用户意图文本，再做红队意图和目标检测：

- 剥离 `<available-deferred-tools>...</available-deferred-tools>`
- 剥离 `<system-reminder>...</system-reminder>`
- 剥离 `<user-prompt-submit-hook>...</user-prompt-submit-hook>`
- 只在过滤后的文本里识别红队意图、目标、确认回复、报告格式和截图选项

这样不会降低真正红队请求的安全门槛，只是避免框架自身注入的上下文触发红队工作流。

## 验证

新增回归测试模拟真实 cc-haha SDK 输入：

- system reminder 中包含 `red-team` 和 `https://github.com`
- 真实用户输入只有 `Return exactly OK.`
- 期望不注入 `CC_HAHA_REDTEAM_WORKFLOW_CONTRACT`

验证命令：

```powershell
cd E:\cchaha_desktop\cc-haha
& 'C:\Users\83964\.bun\bin\bun.exe' test src/server/__tests__/redteamWorkflowGuard.test.ts src/server/__tests__/providers.test.ts -t "redteam workflow|redteam|SDK context|injects the redteam workflow contract"
```

本地验证结果：

- 12 pass
- 0 fail

## 实测结果

修复前，中性 OK 测试中 MiMo 能看到 `CC_HAHA_REDTEAM_WORKFLOW_CONTRACT`，并把它解释为提示注入。

修复后，同样测试的 trace 中不再出现 contract：

| 链路 | 修复后输入 token | 状态 |
|---|---:|---|
| ChatGPT Official GPT-5.5/max | 16,203 | 成功 |
| Micu GPT-5.5/max | 3,662 | 成功 |
| MiMo 2.5 Pro/max | 4,944 | 成功 |
| Claude Opus 4.8 via Micu | - | 仍被供应商策略拒绝 |

Claude 拒绝在修复后仍存在，且 trace 已确认没有 redteam contract，因此更像供应商/模型对真实 cc-haha 自带 Skills、工具和全局指令上下文整体敏感，而不是本次误注入导致。
