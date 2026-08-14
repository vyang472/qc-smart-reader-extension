# QC Smart Reader v0.9.2

QC Smart Reader's core First Evidence path is now available in English and Simplified Chinese, with an explicit human decision for both supported and unsupported claims.

## Bilingual first evidence

The interface follows the browser language by default and offers local **Auto (browser)**, **English**, and **简体中文** choices. Setup, pairing, Quick Start, core current-page feedback, First Evidence, and their primary errors switch immediately without sending telemetry, source text, claims, or quotes anywhere.

After pairing, open a normal article and start Quick Start from **Read / 聊天**. First Evidence presents three user steps:

1. connect the local Companion;
2. capture the current page; and
3. compare the draft claim with its exact stored-source quote, then save a supported or unsupported decision.

Deterministic local template extraction still happens internally, makes no external model call, and is not presented as an AI summary. QC Smart Reader does not accept or reject a claim for the user. Reopening the side panel checks the claim's server-owned status and restores the supported or unsupported decision; a status mismatch returns it to review.

The release includes real localized screenshots captured from clean Chrome profiles against the real Companion and a public deterministic fixture:

- [English pending review](web-store/en-US/01-first-evidence-pending-review.png)
- [English reviewed evidence](web-store/en-US/02-reviewed-exact-quote.png)
- [Simplified Chinese pending review](web-store/zh-CN/01-first-evidence-pending-review.png)
- [Simplified Chinese reviewed evidence](web-store/zh-CN/02-reviewed-exact-quote.png)

## Startup reliability

The side panel now accepts input only after its locale, event handlers, Companion authentication result, and project batch queue are ready. Slow Dashboard, Knowledge, Deliverables, and other optional workspace loads continue after that point without blocking the interface, preventing early clicks from being silently lost on slower machines.

## Install

Prerequisites are macOS, Chrome 116+, Python 3.9+, and internet access during the first Companion install for hash-pinned Python wheels. Codex CLI, `yt-dlp`, and the Swift toolchain are optional.

1. Download `qc-smart-reader-companion-0.9.2.zip`, `qc-smart-reader-extension-0.9.2.zip`, and `SHA256SUMS` below.
2. From the download directory, run `shasum -a 256 -c SHA256SUMS` and confirm both ZIPs report `OK`.
3. Extract the Companion ZIP and double-click `install.command` (or run `bash install.command`). Keep the copied Pairing Token.
4. Extract the Extension ZIP, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the folder containing `manifest.json`.
5. In QC Smart Reader **Settings / 设置**, enter `http://127.0.0.1:37621`, paste the Pairing Token, and choose **Test local Companion / 测试本地服务**.
6. Open an article, run Quick Start, compare the claim with its exact quote, and choose supported only when the quote supports it; otherwise choose unsupported.

## Upgrade and compatibility

Run the v0.9.2 `install.command` to upgrade the Companion. The installer verifies readiness and rolls back the service, database, token, and model settings if activation fails. API and schema versions remain at 1, so Companion v0.9.2 keeps the v0.9.0 extension as its minimum compatible version; using both v0.9.2 ZIPs is the recommended path.

Uninstall preserves the Vault unless the explicit purge flow is confirmed. Back up the entire Companion data directory—both `vault/` and `state/`—before an important upgrade.

## Current boundaries

- The supported packaged lifecycle is macOS-first, and the extension still requires Chrome Developer mode until a Web Store release is approved.
- English covers setup, pairing, Quick Start, core current-page feedback, and First Evidence. Advanced Batch, Agents, most of Knowledge, Deliverables, and project/model controls remain in Simplified Chinese and are labeled accordingly.
- The local template is intended for onboarding and evidence-workflow validation, not nuanced analysis.
- Automatic YouTube import supports public captions only and does not import cookies or transcribe audio.
- Complex PDF tables, formulas, figures, and multi-column layouts may require manual review.

Please report security issues privately as described in [SECURITY.md](https://github.com/vyang472/qc-smart-reader-extension/blob/main/SECURITY.md). Use the repository issue forms for normal bugs and feature requests.
