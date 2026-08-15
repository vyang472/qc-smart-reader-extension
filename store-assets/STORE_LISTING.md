# Chrome Web Store listing handoff — QC Smart Reader v0.9.5

**Status:** v0.9.5 is a Chrome Web Store candidate. The public GitHub Release and anonymous asset-link verification are complete. The bilingual listing copy, permission explanations, data-use answers, and version-neutral small promo tile are prepared. The locale-specific Replay screenshots are verified v0.9.4 **prior-release references**, not v0.9.5 captures. Publisher-account checks, the clean-account test, screenshot decision or recapture, asset upload, dashboard submission, and approval are still pending. This file is not evidence that any of those remaining steps happened.

This file records the listing copy, permission explanations, data-use answers, assets, and clean-install checks for the publisher account. Re-check the Chrome Web Store dashboard requirements on submission day.

## Listing fields

- **Name:** QC Smart Reader
- **Category:** Productivity
- **Primary language:** English
- **Website:** https://github.com/vyang472/qc-smart-reader-extension
- **Support:** https://github.com/vyang472/qc-smart-reader-extension/issues
- **Privacy policy:** https://github.com/vyang472/qc-smart-reader-extension/blob/main/PRIVACY.md

### Short description — English (primary)

Capture web research, verify claims against exact quotes, and keep a local Markdown + SQLite knowledge Vault.

### Short description — 简体中文（localized listing）

采集网页、PDF 与公开视频字幕，用原文引用核验主张，并沉淀到本地 Markdown + SQLite 知识库。

### Detailed description — English (primary)

QC Smart Reader is a local-first research reader. Before pairing, Settings links directly to the free, version-matched macOS Companion and its `SHA256SUMS` file. The extension communicates with that Companion only through the loopback interface; it does not depend on developer-hosted capture or storage infrastructure.

Its single purpose is to turn web pages, PDFs, and public captions that the user intentionally selects into locally stored research claims backed by exact source quotes and held for human review.

QC Smart Reader can capture the current page, explicitly save a right-clicked selection as pending local evidence, run recoverable URL batches in the user's existing Chrome session, import text PDFs, and ingest manually supplied or publicly available captions. It stores source material in SQLite plus a readable Markdown Vault, then links structured claims to exact quotations so each decision can be inspected against the saved source.

Core capabilities:

- Save the current page to a local research Vault
- Right-click selected text to save one exact quote as pending evidence locally, without a model call
- Use Quick Start to create a deterministic, quote-backed draft without an API key or external model
- Decide whether a claim is supported or unsupported beside its exact quote
- Replay saved evidence against its captured context, locator, source version, and exact quote, with explicit stale or unresolved states
- Pause, retry, and recover requested URL batches in the current Chrome session
- Import text PDFs, with optional macOS Vision OCR for low-text pages
- Import manual captions or public captions through an existing local yt-dlp
- Review claims, evidence, source quality, versions, and lineage
- Produce evidence-linked topic packages and research deliverables

QC Smart Reader does not passively collect browsing history. It processes content only after the user chooses a read, context-menu selection save, import, batch, review, export, or model action.

By default, research stays on the user's Mac. Selection saving makes no model or agent call and leaves the new evidence pending until the user explicitly accepts or rejects it. Until the local Companion confirms the durable write and the extension acknowledges it, a bounded exact quote and captured context remain in `chrome.storage.local` for restart recovery; failed or unpaired saves remain queued, while a successful write and ACK delete the item. This queue is not telemetry and is not sent to the developer. The zero-configuration local template creates a clearly labeled deterministic draft and copies an exact quote from the saved source; it is not an AI summary and cannot mark a claim reviewed without a human decision. Optional model routes include a locally signed-in Codex CLI or a user-configured OpenAI-compatible or Anthropic endpoint. Sending source material to a model is blocked until the user gives explicit consent.

The supported path is macOS with Chrome 116 or later. Setup, pairing, Quick Start, core current-page feedback, selection saving, First Evidence, and Replay controls are available in English and Simplified Chinese. Advanced Batch, Agents, most of Knowledge, Deliverables, and project/model controls currently remain in Simplified Chinese and are labeled accordingly. Complex PDF layout, private YouTube captions, and audio transcription remain out of scope.

### Detailed description — 简体中文（localized listing）

QC Smart Reader 是一个本地优先的研究阅读器。配对前，设置页会直达同版本、免费的 macOS Companion 与对应的 `SHA256SUMS`；扩展只通过本机回环地址与它通信，不依赖开发者托管的采集或存储服务。

它的单一用途是：把用户主动选择的网页、PDF 和公开视频字幕转成保存在本地、以原文 quote 支撑且等待人工核验的研究 claim。

它帮助你主动采集当前网页、把右键选中文本显式保存为本地待核验证据、运行 URL 批量任务、导入 PDF 与公开视频字幕；把材料保存到本地 SQLite 与可直接阅读的 Markdown Vault；再将结构化 claim 与原文中的精确 quote 绑定，供你逐条审阅。

核心能力：

- 读取当前网页
- 右键显式把一段选文保存为本地 pending evidence，不调用模型
- 配对后用 Quick Start 把当前页保存到本地 Vault，并在一处核对第一条草稿 claim 与 exact quote
- 复用当前 Chrome 会话执行可暂停、重试、恢复的 URL 批量采集
- 按页导入文本型 PDF，并可在 macOS 上对低文本页面尝试 Vision OCR
- 手动导入字幕，或通过本机已有的 yt-dlp 获取无需登录的公开视频字幕
- 抽取 entities、claims、evidence、relations、risks 和 tasks
- 在 claim / evidence 审阅台查看原文上下文、接受、拒绝、合并或拆分
- 从捕获时上下文、定位、来源版本与 exact quote 回放 evidence，并明确显示 stale 或 unresolved
- 生成带引用回链的专题包、研究报告、PPT 大纲、视频脚本和策略任务书
- 用 Vault Doctor、lineage 与来源版本记录检查知识库一致性

QC Smart Reader 不会在后台被动采集浏览历史。只有当你点击读取、右键选文保存、导入、批量处理或模型操作时，才会处理对应内容。

默认情况下，材料保存在你的 Mac 上。选文保存不调用模型或 Agent，新 evidence 会保持 pending，直到用户明确接受或拒绝。在本地 Companion 确认持久化并 ACK 前，有界 exact quote 与捕获上下文只为重启恢复保存在 `chrome.storage.local`；未配对或保存失败时保留，成功写入并 ACK 后删除。该队列不是遥测，不会发给开发者。零配置的本地模板会用确定性规则生成结构化草稿，并引用已保存原文中的 exact quote；它不是 AI 总结，claim 必须经用户核对并明确判断为支持或不支持。模型功能是可选的：你可以使用本机已登录的 Codex CLI，或配置自己的 OpenAI-compatible / Anthropic endpoint。首次把材料发送给模型前，扩展会要求明确同意。

当前支持路径为 macOS 与 Chrome 116+。首次设置、配对、Quick Start、当前页核心反馈、First Evidence 与 Replay 控件已支持 English / 简体中文；批量、Agent、大部分知识库、交付以及项目/模型控制仍为中文，并有明确提示。复杂 PDF 排版、私有 YouTube 字幕和音频转写不在当前范围内。

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

Keep extension settings, Pairing Token, consent state, and bounded project-scoped recovery queues on the user's device. A pending selection's bounded exact quote and captured context stay in `chrome.storage.local` after an unpaired or failed save and are deleted after the Companion write succeeds and the extension acknowledges it. Clearing the extension's stored data or uninstalling it also lets Chrome remove the queue. Model API keys are not stored in Chrome extension storage.

### `contextMenus`

Provide the explicit user-triggered action that saves selected text as pending local evidence without invoking a model.

### `sidePanel`

Host the product's capture, review, knowledge, delivery, batch, and settings workflows.

## User-data disclosure worksheet

| Data category | Handling |
| --- | --- |
| Website content | Processed only after a user-initiated capture, context-menu selection save, or batch action; stored in the user's local Vault after Companion confirmation |
| Pending selection recovery | Bounded exact quote and captured context stay in `chrome.storage.local` after an unpaired or failed save; successful Companion write + ACK deletes the item; no developer telemetry or model call |
| Browsing activity | URL/title handled only for selected captures or batches; not sold, used for ads, or sent to the developer |
| User activity | Project settings, review decisions, and generated artifacts stay local unless included in a model action selected by the user |
| Authentication information | Random loopback Pairing Token stored locally; no website login passwords or cookies are collected |
| Model credentials | Stored by the local Companion with owner-only permissions, never in Chrome storage or developer infrastructure |
| Model data sharing | Optional; blocked until affirmative versioned consent; sent only to Codex/OpenAI or the endpoint selected by the user |
| Developer analytics | None; onboarding milestones and interface-language preference stay in local Chrome storage |
| Sale or advertising use | None |

## Assets

The localized screenshots below were regenerated twice from independent clean browser profiles using the v0.9.4 extension, the real v0.9.4 Companion, and a public deterministic fixture. The pending screenshots show an undecided quote-backed claim with equal supported and unsupported actions and a folded Replay control. The reviewed screenshots restore the saved human decision after reopening the side panel, then expand the same service-backed Replay record to show its exact quote in captured context, locator, capture time, and current source version. The capture harness added no labels, overlays, or fabricated state, and the v0.9.4 Replay-contract, sensitive-data, layout, RGB, and deterministic-hash checks passed.

These files are **prior-release v0.9.4 references only**. They were not recaptured from v0.9.5, do not show the new context-menu selection flow, and must not be described as v0.9.5 screenshots or as evidence of Chrome Web Store upload, submission, or approval.

- Store icon: `assets/icons/icon-128.png`
- English screenshot 1: [`store-assets/web-store/en-US/01-first-evidence-pending-review.png`](web-store/en-US/01-first-evidence-pending-review.png) (640×400)
- English screenshot 2: [`store-assets/web-store/en-US/02-reviewed-exact-quote.png`](web-store/en-US/02-reviewed-exact-quote.png) (640×400)
- Simplified Chinese screenshot 1: [`store-assets/web-store/zh-CN/01-first-evidence-pending-review.png`](web-store/zh-CN/01-first-evidence-pending-review.png) (640×400)
- Simplified Chinese screenshot 2: [`store-assets/web-store/zh-CN/02-reviewed-exact-quote.png`](web-store/zh-CN/02-reviewed-exact-quote.png) (640×400)
- Small promo tile: [`store-assets/web-store/small-promo-tile-440x280.png`](web-store/small-promo-tile-440x280.png) (440×280; locale- and version-neutral)
  - Reproducible vector source: [`store-assets/web-store/small-promo-tile-440x280.svg`](web-store/small-promo-tile-440x280.svg)
  - Deterministic renderer: [`scripts/render_small_promo_tile.mjs`](../scripts/render_small_promo_tile.mjs)
- Launch-page composites, not store screenshots: `store-assets/screenshots/`
- Repository social card, not a store screenshot: `store-assets/social-preview.png`

The PNGs currently stored directly under `store-assets/web-store/` are v0.9.1 Chinese-interface reference captures. Do not upload them as evidence of the English primary listing, and do not use the advanced Vault screenshot there while that workspace remains Chinese. The publisher must either recapture the locale-specific pairs from v0.9.5 or explicitly document the v0.9.4 pair as prior-release references after verifying that the dashboard accepts them; neither action has happened yet.

Before upload, confirm each screenshot matches the dashboard's current dimensions and shows no Pairing Token, API key, private URL, private source text, personal path, or browser profile data. Do not add awards, review scores, user counts, or performance claims without verifiable evidence.

## Publisher checklist

- [x] Publish the v0.9.5 GitHub Release, and keep `PRIVACY.md`, `SUPPORT.md`, and `SECURITY.md` at stable public URLs.
- [x] Render the locale- and version-neutral small promo tile from its tracked SVG source; verify dimensions, visible-text/version scanning, and deterministic hashes.
- [ ] Verify the publisher identity and required contact details in the dashboard.
- [ ] Recapture all four localized screenshots from the v0.9.5 build, or record an explicit publisher decision to use the verified v0.9.4 files only as prior-release references; re-run dimension and sensitive-data checks before upload.
- [ ] Upload the final approved en-US pair to the English primary listing and the zh-CN pair to the Simplified Chinese localized listing.
- [ ] Complete privacy, permission, distribution, pricing, and tester declarations truthfully.
- [x] Verify the v0.9.5 extension derives the direct Companion ZIP and `SHA256SUMS` targets from its manifest version without carrying a Pairing Token or other secret.
- [x] Verify both v0.9.5 reviewer-instruction links without authentication.
- [ ] Paste the reviewer instructions into the dashboard only after the remaining clean-account test.
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
