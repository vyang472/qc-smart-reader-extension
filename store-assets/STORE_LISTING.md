# Chrome Web Store listing handoff — QC Smart Reader 0.9.1

**Status:** listing copy and v0.9.1 repository assets are ready; publisher-account checks and dashboard submission are still pending. This is not evidence of submission or approval.

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

QC Smart Reader 是一个本地优先的研究阅读器。使用扩展前，需要先安装同一版本、免费的 macOS Companion；扩展只通过本机回环地址与它通信，不依赖开发者托管的采集或存储服务。

它的单一用途是：把用户主动选择的网页、PDF 和公开视频字幕转成保存在本地、以原文 quote 支撑且等待人工核验的研究 claim。

它帮助你主动采集当前网页、选中文本、URL 批量任务、PDF，以及公开视频字幕；把材料保存到本地 SQLite 与可直接阅读的 Markdown Vault；再将结构化 claim 与原文中的精确 quote 绑定，供你逐条审阅。

核心能力：

- 读取当前网页或把选中的文字送入侧边栏
- 配对后用 Quick Start 把当前页保存到本地 Vault，并在一处核对第一条草稿 claim 与 exact quote
- 复用当前 Chrome 会话执行可暂停、重试、恢复的 URL 批量采集
- 按页导入文本型 PDF，并可在 macOS 上对低文本页面尝试 Vision OCR
- 手动导入字幕，或通过本机已有的 yt-dlp 获取无需登录的公开视频字幕
- 抽取 entities、claims、evidence、relations、risks 和 tasks
- 在 claim / evidence 审阅台查看原文上下文、接受、拒绝、合并或拆分
- 生成带引用回链的专题包、研究报告、PPT 大纲、视频脚本和策略任务书
- 用 Vault Doctor、lineage 与来源版本记录检查知识库一致性

QC Smart Reader 不会在后台被动采集浏览历史。只有当你点击读取、导入、批量处理或模型操作时，才会处理对应内容。

默认情况下，材料保存在你的 Mac 上。零配置的本地模板会用确定性规则生成结构化草稿，并引用已保存原文中的 exact quote；它不是 AI 总结，claim 必须经用户核对并明确接受。模型功能是可选的：你可以使用本机已登录的 Codex CLI，或配置自己的 OpenAI-compatible / Anthropic endpoint。首次把材料发送给模型前，扩展会要求明确同意。

当前支持路径为 macOS 与 Chrome 116+，产品界面为简体中文。复杂 PDF 排版、私有 YouTube 字幕和音频转写不在当前范围内。

## Single purpose

Turn user-selected web pages, PDFs, and public captions into locally stored, quote-backed research claims for human review.

## Permission justifications

### `scripting`

Run the maintained page extractor only in an HTTP(S) page the user intentionally selected or added to a batch. It is not used for passive monitoring.

### Host access: `http://*/*` and `https://*/*`

Read the URL, title, and content of user-selected HTTP(S) pages and run explicitly requested URL batches in temporary background tabs. HTTP access also covers the Companion at `127.0.0.1:37621` or `localhost:37621`. QC Smart Reader does not request file or other URL schemes and does not passively collect browsing history.

The extension intentionally does not request `tabs` or `activeTab`: its `chrome.tabs.query`, `create`, `get`, and `remove` operations do not require the `tabs` permission, and matching HTTP(S) host access supplies the URL and title needed for pages the user chooses to capture.

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
| Developer analytics | None in v0.9.1; onboarding milestones stay in local Chrome storage |
| Sale or advertising use | None |

## Assets

The repository images below were captured from the reviewed v0.9.1 extension and local Companion using a public deterministic fixture. Re-run the screenshot script and verify the images again if the release build changes before upload:

- Store icon: `assets/icons/icon-128.png`
- Screenshot 1: `store-assets/web-store/01-first-evidence-4-of-5.png` (640×400, real Quick Start UI)
- Screenshot 2: `store-assets/web-store/02-reviewed-exact-quote.png` (640×400, real reviewed-evidence UI)
- Screenshot 3: `store-assets/web-store/03-local-vault-detail.png` (640×400, real Vault-detail UI)
- Small promo tile: `store-assets/web-store/small-promo-tile-440x280.png` (440×280)
- Launch-page composites, not store screenshots: `store-assets/screenshots/`
- Repository social card, not a store screenshot: `store-assets/social-preview.png`

Before upload, confirm each screenshot matches the dashboard's current dimensions and shows no Pairing Token, API key, private URL, private source text, personal path, or browser profile data. Do not add awards, review scores, user counts, or performance claims without verifiable evidence.

## Publisher checklist

- [ ] Publish v0.9.1 and keep `PRIVACY.md`, `SUPPORT.md`, and `SECURITY.md` at stable public URLs.
- [ ] Verify the publisher identity and required contact details in the dashboard.
- [ ] Upload only screenshots captured from the reviewed v0.9.1 build.
- [ ] Complete privacy, permission, distribution, pricing, and tester declarations truthfully.
- [ ] Verify the v0.9.1 Companion and checksum links in `WEB_STORE_TEST_INSTRUCTIONS.md`, then paste those instructions into the dashboard.
- [ ] Explain why HTTP(S) host access is necessary for user-selected arbitrary research pages and requested URL batches.
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
