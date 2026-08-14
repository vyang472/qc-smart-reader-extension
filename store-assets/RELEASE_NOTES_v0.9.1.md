# QC Smart Reader v0.9.1

QC Smart Reader now gets a new user from a valid Pairing Token to a persisted, quote-backed draft claim without an API key, Codex CLI, or external model call.

## First evidence, zero model setup

After pairing, open a normal article and choose **从当前页生成第一条证据** in the Chat tab. Quick Start will:

1. capture the active page and save it to the local Vault;
2. run deterministic local template extraction;
3. show a draft claim beside an exact quote copied from the stored source; and
4. wait for the user to inspect the quote and explicitly accept the claim.

The local template is not an AI summary. It produces deliberately simple draft wording, makes no external model call, and never marks the claim reviewed on the user's behalf. Reopening the side panel restores the saved evidence and human-review state.

New installations use this local template route by default. Codex CLI, OpenAI-compatible, and Anthropic providers remain available as explicit opt-ins; external-provider actions still require complete configuration and affirmative model-data consent, and do not silently fall back to the local template.

## Install

Prerequisites are macOS, Chrome 116+, Python 3.9+, and internet access during the first Companion install for hash-pinned Python wheels. Codex CLI, `yt-dlp`, and the Swift toolchain are optional.

1. Download `qc-smart-reader-companion-0.9.1.zip`, `qc-smart-reader-extension-0.9.1.zip`, and `SHA256SUMS` below.
2. From the download directory, run `shasum -a 256 -c SHA256SUMS` and confirm both ZIPs report `OK`.
3. Extract the Companion ZIP and double-click `install.command` (or run `bash install.command`). Keep the copied Pairing Token.
4. Extract the Extension ZIP, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the folder containing `manifest.json`.
5. In QC Smart Reader **设置**, enter `http://127.0.0.1:37621`, paste the Pairing Token, and choose **测试本地服务**.
6. Open an article, return to **聊天**, run Quick Start, compare the claim with its exact quote, and accept it only when the quote supports it.

## Upgrade and compatibility

Run the v0.9.1 `install.command` to upgrade the Companion. The installer verifies readiness and rolls back the service, database, token, and model settings if activation fails. API and schema versions remain at 1, so Companion v0.9.1 keeps the v0.9.0 extension as its minimum compatible version; using both v0.9.1 ZIPs is still the recommended path.

Uninstall preserves the Vault unless the explicit purge flow is confirmed. Back up the entire companion data directory—both `vault/` and `state/`—before an important upgrade.

## Current boundaries

- The supported packaged lifecycle is macOS-first, the UI is Simplified Chinese, and the extension still requires Chrome Developer mode until a Web Store release is approved.
- The local template is intended for onboarding and evidence-workflow validation, not nuanced analysis.
- Automatic YouTube import supports public captions only and does not import cookies or transcribe audio.
- Complex PDF tables, formulas, figures, and multi-column layouts may require manual review.

Please report security issues privately as described in [SECURITY.md](https://github.com/vyang472/qc-smart-reader-extension/blob/main/SECURITY.md). Use the repository issue forms for normal bugs and feature requests.
