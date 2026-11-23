# pi-open-code-review · native bridge spike

在 pi 中运行 Alibaba [OpenCodeReview](https://github.com/alibaba/open-code-review) 的 **`ocr review`**。OCR 负责选择文件、执行工具及生成行级报告，pi 负责选择模型和认证。不使用 `ocr delegate`，也不把当前会话历史拼进审查提示。

这是基于 **pi 1.6.0 / OCR 1.14.2** 的可行性原型，不是正式发布。实测记录见 [VALIDATION.md](VALIDATION.md)。

## 试用（不改全局配置）

需要 Node ≥22.19、Git ≥2.41、已配置聊天模型的 pi，以及 PATH 中的 `ocr`。可以用 `npm install -g @alibaba-group/open-code-review@1.14.2` 安装对应 CLI；不用再执行 `ocr config provider`。

先检出 `spike/native-model-bridge`，再到**要审查的 Git 仓库**中，用 `pi -e /absolute/path/to/pi-open-code-review` 启动。然后输入：

```text
/open-code-review --preview                # 只列文件，不调用模型
/open-code-review                          # 工作区：暂存、未暂存和未跟踪的改动
/open-code-review --model                  # 交互选择；取消不会发请求
/open-code-review --model sonnet           # 模糊搜索；多个结果须选择
/open-code-review --from main --model @review
/open-code-review --commit HEAD
```

`--model` 后支持补全；也可输入完整 `provider/model-id`。精确 ID 或别名不存在直接报错，不自动换 provider。非交互模式下，模糊查询必须唯一匹配。`--from main` 只审从 merge-base 到 `HEAD` 的**已提交**改动，与默认工作区模式不同。TUI 审查期间可按 Esc 取消。插件不会调用 `pi.setModel()`，审完不必切回原模型。

**可选配置**：在用户级 pi agent 目录创建 `open-code-review.json`（默认 `~/.pi/agent/open-code-review.json`）：

```json
{
  "defaultModel": "current",
  "aliases": {
    "review": "anthropic/claude-sonnet-4-6"
  }
}
```

替换为你自己可用的完整 ID。优先级：命令 `--model` > `defaultModel` > 当前会话模型。把默认值改成 `"@review"` 可固定审查模型。别名键不带 `@`，调用时带 `@`。不读取项目里的模型配置文件作为插件默认值，也不在这里存 key。

## 模型请求怎么走

```text
/open-code-review → 原生 ocr review 子进程
                      └─ 本次运行专用的 127.0.0.1:<随机端口>/v1/chat/completions
                          └─ ctx.modelRegistry.streamSimple(所选模型, OCR 上下文, …)
```

- 子进程使用临时 HOME 和环境变量白名单，只有访问本地桥的随机令牌，不向它传递 pi 的 provider key。这避免本机已有的 `~/.opencodereview/config.json`（优先级比 OCR 环境变量高）抢走请求；也意味着本原型**不加载用户的全局 OCR 规则、MCP 配置及历史会话**。项目内的 OCR 规则仍由 OCR 处理。这是配置隔离，不是文件系统沙箱。
- OCR 看到的是普通的 OpenAI 工具调用；桥在内存中把调用 ID 关联到 pi 的原始消息。工具结果回传时能保留 provider 的原生 ID 和签名，不要求 pi 主会话暴露 `read` 或 `bash`。仅结果摘要回到主会话，不自动修代码。
- OCR 侧仅实现当前版本实际使用的非流式、文本 Chat Completions；pi 到 provider 仍可流式。按运行关闭监听并清除临时 OCR 报告。框架退出或审查取消时中止模型请求；不要把此实现当作通用 OpenAI 代理。
- 原型固定 `--effort low --concurrency 1`，单任务 3 分钟、整次 5 分钟、OCR 累计 token 预算 120,000（OCR 按轮检查，不是计费硬上限）。不支持 `--resume`、PR 回写、自动修复或上传。大型仓库、Windows 及各 provider 的组合未做兼容性认证。

## 重现验证

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run smoke
```

`smoke` 自建临时 Git 仓库和本地 fixture provider，不需要真实 key；真实模型测试单独显式运行，会消耗额度：

```sh
npm run smoke -- --live <当前会话模型的完整ID> <另一个审查模型的完整ID>
```

两种验证都只审临时仓库中的示例，不审插件仓库或当前工作目录中的项目。建议先用不带 `--live` 的命令确认本地链路。
