# Chrome Web Store listing handoff — QC Smart Reader 0.9.0

**Status:** publisher-ready draft; not evidence of submission or approval.

This file records the listing copy, permission explanations, data-use answers, assets, and clean-install checks for the publisher account. Re-check the Chrome Web Store dashboard requirements on submission day.

## Listing fields

- **Name:** QC Smart Reader
- **Category:** Productivity
- **Primary language:** Chinese (Simplified)
- **Website:** https://github.com/vyang472/qc-smart-reader-extension
- **Support:** https://github.com/vyang472/qc-smart-reader-extension/issues
- **Privacy policy:** https://github.com/vyang472/qc-smart-reader-extension/blob/main/PRIVACY.md

### Short description — 简体中文

采集网页、PDF 与公开视频字幕，用原文引用核验主张，并沉淀到本地 Markdown + SQLite 知识库。

### Short description — English reference

Capture web research, verify claims against exact quotes, and keep a local Markdown + SQLite knowledge Vault.

### Detailed description — 简体中文

QC Smart Reader 是一个本地优先的研究阅读器，由 Chrome 侧边栏扩展和运行在本机的 Companion 服务组成。

它帮助你主动采集当前网页、选中文本、URL 批量任务、PDF，以及公开视频字幕；把材料保存到本地 SQLite 与可直接阅读的 Markdown Vault；再将结构化 claim 与原文中的精确 quote 绑定，供你逐条审阅。

核心能力：

- 读取当前网页或把选中的文字送入侧边栏
- 复用当前 Chrome 会话执行可暂停、重试、恢复的 URL 批量采集
- 按页导入文本型 PDF，并可在 macOS 上对低文本页面尝试 Vision OCR
- 手动导入字幕，或通过本机已有的 yt-dlp 获取无需登录的公开视频字幕
- 抽取 entities、claims、evidence、relations、risks 和 tasks
- 在 claim / evidence 审阅台查看原文上下文、接受、拒绝、合并或拆分
- 生成带引用回链的专题包、研究报告、PPT 大纲、视频脚本和策略任务书
- 用 Vault Doctor、lineage 与来源版本记录检查知识库一致性

QC Smart Reader 不会在后台被动采集浏览历史。只有当你点击读取、导入、批量处理或模型操作时，才会处理对应内容。

默认情况下，材料保存在你的 Mac 上。模型功能是可选的：你可以使用本机已登录的 Codex CLI，配置自己的 OpenAI-compatible / Anthropic endpoint，也可以使用明确标注的本地 deterministic mock 验证完整流程。首次把材料发送给模型前，扩展会要求明确同意。

当前支持路径为 macOS 与 Chrome 116+，产品界面为简体中文。复杂 PDF 排版、私有 YouTube 字幕和音频转写不在当前范围内。

## Single purpose

Help a user intentionally collect research sources, analyze them with a user-selected or deterministic local workflow, verify claims against exact source quotations, and save durable local research artifacts.

## Permission justifications

### `activeTab`

Read the active page only after the user chooses **读取当前页** or invokes a selected capture action.

### `scripting`

Run the maintained page extractor in the page the user intentionally selected. It is not used for passive monitoring.

### `tabs`

Enumerate tabs the user explicitly adds to a batch and manage temporary background tabs used to execute that batch in the user's existing Chrome session.

### Host access: `<all_urls>`

Support user-initiated research capture on arbitrary sites. QC Smart Reader does not passively collect browsing history. Host access also allows retrieval of explicitly selected public source URLs; local service communication is separately limited to loopback origins in the manifest.

### `downloads`

Save a project export only after the user clicks an export action.

### `storage`

Keep extension settings, Pairing Token, consent state, and bounded project-scoped recovery queues on the user's device. Model API keys are not stored in Chrome extension storage.

### `contextMenus`

Provide the user-triggered action that sends selected text to the side panel.

### `sidePanel`

Host the product's capture, review, knowledge, delivery, batch, and settings workflows.

## User-data disclosure worksheet

| Data category | Handling |
| --- | --- |
| Website content | Processed only after a user-initiated capture or batch action; stored in the user's local Vault |
| Browsing activity | URL/title handled only for selected captures or batches; not sold, used for ads, or sent to the developer |
| User activity | Project settings, review decisions, and generated artifacts stay local unless included in a model action selected by the user |
| Authentication information | Random loopback Pairing Token stored locally; no website login passwords or cookies are collected |
| Model credentials | Stored by the local Companion with owner-only permissions, never in Chrome storage or developer infrastructure |
| Model data sharing | Optional; blocked until affirmative versioned consent; sent only to Codex/OpenAI or the endpoint selected by the user |
| Developer analytics | None in v0.9.0 |
| Sale or advertising use | None |

## Assets

Use only current v0.9.0 product images:

- Store icon: `assets/icons/icon-128.png`
- Screenshot 1: `store-assets/screenshots/01-capture.png`
- Screenshot 2: `store-assets/screenshots/02-evidence-review.png`
- Screenshot 3: `store-assets/screenshots/03-local-vault.png`
- Repository social card, not a store screenshot: `store-assets/social-preview.png`

Before upload, confirm each screenshot matches the dashboard's current dimensions and shows no Pairing Token, API key, private URL, private source text, personal path, or browser profile data. Do not add awards, review scores, user counts, or performance claims without verifiable evidence.

## Publisher checklist

- [ ] Publish v0.9.0 and keep `PRIVACY.md`, `SUPPORT.md`, and `SECURITY.md` at stable public URLs.
- [ ] Verify the publisher identity and required contact details in the dashboard.
- [ ] Upload only screenshots captured from the v0.9.0 build.
- [ ] Complete privacy, permission, distribution, pricing, and tester declarations truthfully.
- [ ] Explain why broad host access is necessary for user-selected arbitrary research pages.
- [ ] Confirm there is no remotely hosted executable code and no undisclosed analytics.
- [ ] Install both release ZIPs on a clean macOS user account.
- [ ] Pair the extension, capture a public fixture, review an exact quote, restart Chrome, and verify recovery.
- [ ] Run the Companion uninstall and confirm the Vault is preserved by default.
- [ ] Verify the release checksums and retain the test record.
- [ ] Submit through the owner's publisher account; record the submission date and dashboard version here only after it happens.

## Release verification

```bash
bash scripts/test_all.sh
python3 scripts/release.py --check
python3 scripts/release.py
shasum -a 256 -c dist/release/SHA256SUMS
```

`scripts/release.py` refuses dirty or untracked runtime inputs. Official assets should be created from the reviewed release commit, not from an uncommitted worktree.
