# 验证记录：OCR 能否使用 pi 当前会话以外的模型？

**结论：可以。** 2026-11-23 在 macOS arm64、Node 26.7.0、pi **1.6.0**、[OpenCodeReview 1.14.2 (`e74f2c6b`)](https://github.com/alibaba/open-code-review/tree/e74f2c6bd4422bd1e12d257d1725bcce1d6b9ddd) 上实测。不是委派模式，没有让 pi 主 agent 代替 OCR 审查。以下都是临时仓库中的合成代码。

## 真实模型

```sh
npm run smoke -- --live openai-codex/gpt-6.2-astra openai-codex/gpt-6.2-sol
```

| 观察点 | 实际结果 |
|---|---|
| 新建测试会话的当前模型，审查前 → 后 | `openai-codex/gpt-6.2-astra` → `openai-codex/gpt-6.2-astra` |
| `--model` 指定的审查模型 / pi 返回消息上的模型 | 均为 `openai-codex/gpt-6.2-sol` |
| 通过桥的模型请求 | 4 |
| 原生 OCR 工具调用 | `file_read`、`code_comment`、`task_done`、`approve_all_comments` 各 1 次 |
| 在后续模型请求中看到的工具结果 | `file_read`、`code_comment` 各 1 次 |
| 原生报告状态和覆盖 | `complete`，选中并完成 `pricing.py`，1/1 |
| 报告定位 | `pricing.py:3` |

模型引用了未改动的 `pricing-cases.md` 中的用例 `SUBTOTAL-417`：单价 137 分、数量 6 时，改动后的加法得到 **143**，应为 **822**。这些验收数据不在 diff 中。未开启 pi 主会话的文件或 shell 工具。

**为何需要这个用例：** 第一次实际运行已定位同一个缺陷，也收到 `code_comment` 的回执，但只靠 diff 就能判断，不需要读文件；因此严格的读文件回环断言未通过。之后只修改 smoke fixture，在基线提交中加入验收文档和要求读取它的 OCR 项目规则。第二次运行通过，没有改变插件的提示、调用模型的逻辑或放宽验收条件。

## 无需真实凭据的验证

- `npm run check` 通过；`npm test` **12/12** 通过。覆盖精确模型、模糊搜索及歧义处理、别名、补全、只读命令参数、桥的鉴权以及 Pi 原生工具 ID 和签名的保留。
- `npm run smoke` 启动真实 pi 和真实 `ocr review`，**只把上游模型替换为本机的确定性 HTTP/SSE fixture**。裸命令选 `fixture/author`；`--model @review` 选 `fixture/reviewer`。两次都由 fixture 服务端独立记录实际请求的模型 ID，各收到 4 次请求，都在 `pricing.py:3` 返回一条评论；两次会话模型前后都为 `fixture/author`。
- Fixture 验证收到的是它自己发起的 `file_read` 对应的、带行号的真实文件内容，并检查 `code_comment` 的成功回执；不仅断言 CLI 退出码。使用预置了另一份 OCR provider 配置的临时用户目录，配置文件保持原样。
- 另在没有任何已配置模型的临时 pi 目录运行 `/open-code-review --preview`：正确列出 `sample.py`，没有启动模型桥。

**边界：** 已验证一个真实 provider 和一个本地 Chat Completions 适配器。没有据此确认所有 provider、虚拟路由、平台、大仓库或失败恢复场景。计数是本次观测值，不是对未来模型输出的承诺。完整原始 prompts、模型认证、一次性令牌及 OCR 会话日志不入库。
