# Native OpenCodeReview for pi

Review Git changes with [Alibaba OpenCodeReview](https://github.com/alibaba/open-code-review) using a model you've configured in pi. Findings appear in the conversation with file and line references, so you can ask about a finding without copying the report or switching models. This independent pi extension uses the `ocr` CLI; it does not bundle it.

## Install

You need Node.js 22.19 or later, Git 2.41 or later, pi, and `ocr` on your `PATH`. The extension has been tested with **pi 1.6.0 and OCR 1.14.2**.

Run these commands in your terminal. The first installs the OCR CLI; skip it if you already have that version. The second installs the extension from its GitHub tag.

```sh
npm install -g @alibaba-group/open-code-review@1.14.2
pi install git:github.com/Meowooh/pi-open-code-review@v0.2.6
```

Start pi in the Git repository you want to review, or run `/reload` in an existing session. Then enter **`/ocr-review --preview`** to see which files OCR would review. A preview makes no model calls. For a full review, configure a model in pi; you don't need a separate OCR provider configuration.

## Review changes

| Enter in pi | What it does |
| --- | --- |
| `/ocr-review` | Review staged, unstaged, and untracked changes in the background. |
| `/ocr-review --commit HEAD` | Review a single commit. |
| `/ocr-review --from main --to HEAD` | Review committed changes from the merge base to the target commit. If you omit `--to`, the target is `HEAD`. |
| `/ocr-review --commit HEAD --background "Focus on refund amounts"` | Give OCR a review requirement. To read it from a file instead, use `--background-file docs/refunds.md`. Use one option or the other. |
| `/ocr-review --model` | Pick a review model in the terminal UI without changing the session model. You can also specify `--model provider/id` or `--model @review`. |
| `/ocr-review Review the last commit and list any refund issues.` | Ask the current agent to call `ocr_review`, read the native report, and reply in the conversation. |
| `/ocr-fleet` | Open the progress and findings panel for the most recent review. |

**A bare `/ocr-review` or one that starts with a flag runs OCR directly.** The review uses the selected model, but pi does not start an extra agent turn to interpret the command or summarize the result. When the review finishes, a collapsed report appears in the conversation:

```text
▸ OCR · 5 findings · 2 High · 2 Medium · 1 Low
```

Expand the report to see findings in their original order, with file locations and any code OCR supplied. In fullscreen mode with mouse support enabled, click the heading to toggle just that report. In both terminal modes, `Ctrl+O` is pi's global expand/collapse shortcut. Expanding makes no model calls. Sending your next chat message clears the finished status line, not the report: you can still ask “Explain finding 2.”

In `/ocr-fleet`, use the arrow keys (`↑`/`↓`) to select a finding, `Enter` to expand or collapse it, and `PgUp`/`PgDn` or the mouse wheel to scroll. `Esc` closes the panel without stopping the review; `x` stops a running review. Each session runs at most one review at a time. Switching sessions, exiting pi, or reloading the extension cancels a running review. A review does not automatically edit files or delegate fixes.

## Choose a review model

By default, OCR uses the current pi model. To use a different model without typing its full ID each time, define an alias in `~/.pi/agent/open-code-review.json` (or in the same file under your custom pi agent directory). Replace `provider/model-id` with a model available to you:

```json
{
  "defaultModel": "current",
  "aliases": { "review": "provider/model-id" }
}
```

Run `/ocr-review --model @review` to use the alias once, or set `defaultModel` to `"@review"` to use it by default. `--model` overrides `defaultModel`. The `ocr_review` tool does not open an interactive model picker.

## Data and limits

- **What leaves your machine:** OCR runs locally and connects to pi over a loopback connection created for each review. The **selected model's provider** receives the relevant code, diffs, and review background. The extension does not add your pi conversation history to OCR's requests.
- **What OCR can access:** Use the extension only in repositories you trust. Its temporary home directory isolates configuration; it is **not a filesystem sandbox**. Project-level OCR rules still apply. User-level OCR rules and MCP configuration are not loaded.
- **Background and reports:** A background file must be UTF-8 Markdown inside the directory being reviewed, with at most 8,000 characters. The report goes back to the session that requested it. For reports larger than 50 KiB, the model receives a summary and a path to the full JSON; the temporary file is removed when the session ends. Non-interactive direct commands wait for completion, and print mode outputs native OCR JSON.
- **Review limits:** OCR runs at low effort with one concurrent task, a three-minute timeout per task, and a five-minute timeout for the whole review. OCR checks its 120,000-token budget between rounds; it is not a hard billing limit.

## Development

```sh
npm ci --ignore-scripts
npm run check && npm test
npm run smoke
```

The smoke tests use a temporary Git repository, the real pi and OCR executables, and a local model fixture. They cover direct reviews, model aliases, and natural-language tool calls without a provider key. Pi loads the TypeScript extension directly; no build step is required.

[MIT License](LICENSE)
