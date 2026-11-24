# Native OpenCodeReview for pi

Run [Alibaba OpenCodeReview](https://github.com/alibaba/open-code-review) on Git changes with your pi model. Get line-level findings in the conversation without switching models or copying a report. This is an independent pi extension; it does not bundle the OCR CLI.

## 安装

需要 Node.js ≥22.19、Git ≥2.41、pi 和 PATH 中的 `ocr`。已验证的组合是 **pi 1.6.0 / OCR 1.14.2**。在系统终端执行：

```sh
npm install -g @alibaba-group/open-code-review@1.14.2  # 已有该版本可跳过
pi install npm:pi-native-open-code-review
```

需要固定本版时，将安装来源写成 `npm:pi-native-open-code-review@0.2.6`。也可以直接从源码安装：`pi install git:github.com/Meowooh/pi-open-code-review@v0.2.6`。只选一种来源，避免重复加载。

在要审查的 Git 仓库启动 pi（已打开的会话可执行 `/reload`），输入 **`/ocr-review --preview`** 检查选择了哪些文件。这一步不调用模型。正式审查需要在 pi 中配置模型，不必单独配置 OCR provider。

## 审查改动

| 在 pi 中输入 | 行为 |
| --- | --- |
| `/ocr-review` | 后台审查工作区的暂存、未暂存和未跟踪改动。 |
| `/ocr-review --commit HEAD` | 审查一个提交。 |
| `/ocr-review --from main --to HEAD` | 审查从 merge-base 到目标提交的改动；省略 `--to` 时默认为 HEAD。 |
| `/ocr-review --commit HEAD --background "重点看退款金额"` | 把业务要求交给 OCR；也可用 `--background-file docs/refunds.md`，两者不能同时使用。 |
| `/ocr-review --model` | 在 TUI 中选择审查模型，不切换会话模型。也支持 `--model provider/id` 或 `--model @review`。 |
| `/ocr-review 审查刚提交的改动，把退款相关的问题列出来` | 当前 agent 调用 `ocr_review`，读取原生报告并回答。 |
| `/ocr-fleet` | 打开最近一次审查的进度与问题列表。 |

**裸命令和选项模式不需要主模型解析或总结**；OCR 审查本身仍会调用所选模型。完成后，对话中留下一行可展开的报告，例如：

```text
▸ OCR · 5 findings · 2 High · 2 Medium · 1 Low
```

在 fullscreen 模式启用鼠标后，点击标题只切换这一份报告；两种终端模式都支持 pi 的全局 `Ctrl+O`。展开显示原顺序的问题、文件位置和可用代码，不再调用模型。发送下一条普通消息只清除已结束的状态行，不删除报告。你可以直接追问「解释第二条」，不用复制。

在 Fleet 中用 ↑/↓ 选择、Enter 展开、PgUp/PgDn 或滚轮翻页。Esc 只关闭面板；`x` 才停止正在运行的审查。每个会话同一时间只运行一个审查；切换会话、退出或重载会取消运行中的任务。审查不会自动修复或委派。

## 模型与数据

默认沿用当前 pi 模型。需要固定审查模型时，可在 `~/.pi/agent/open-code-review.json`（或自定义 pi agent 目录下的同名文件）设置别名，并将示例值替换成实际可用的模型：

```json
{
  "defaultModel": "current",
  "aliases": { "review": "provider/model-id" }
}
```

- `--model` 优先于 `defaultModel`。别名键不带 `@`；使用时带 `@`。工具路径不弹模型选择器。
- OCR 在本地执行，通过本次运行专用的 loopback 连接使用 pi 的认证。审查涉及的代码、差异和背景会发往**所选模型的 provider**，不会附带整段 pi 会话。只在可信仓库中使用：临时 HOME 隔离配置，**不是文件系统沙箱**。项目级 OCR 规则仍然生效，用户级 OCR 规则和 MCP 配置不会加载。
- 背景文件须为审查目录内的 UTF-8 Markdown，最多 8,000 个字符。OCR 的行级报告会进入发起会话；超过 50 KiB 的报告给模型提供摘要和临时 JSON 路径，文件随会话清理。非交互直接命令会等待结束；print 模式输出原生 JSON。
- 插件使用低 effort、单并发；单任务限时 3 分钟，整次限时 5 分钟。OCR 的 120,000-token 预算按轮检查，不是计费硬上限。

## 开发验证

```sh
npm ci --ignore-scripts
npm run check && npm test
npm run smoke
```

Smoke 使用临时 Git 仓库、真实 pi/OCR 和本机模拟模型，覆盖直接命令、模型别名与自然语言工具调用；不需要 provider key。插件直接加载 TypeScript，无需构建。开源许可见 [LICENSE](LICENSE)。
