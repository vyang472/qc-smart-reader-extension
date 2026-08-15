# QC Smart Reader v0.9.3

QC Smart Reader can now replay saved evidence against the exact record captured in the local Vault. Source Replay keeps the historical snapshot distinct from the current remote page and fails closed whenever a precise match cannot be established.

## Source Replay

Open **Replay** from First Evidence, Knowledge, or claim review to inspect:

- the saved source title, capture time, version, and content hash;
- a page, forum-floor, timestamp, or chunk locator when that metadata exists;
- the stored exact quote highlighted inside its captured context; and
- a canonical public HTTP(S) source link as a fallback, without claiming a precise remote scroll position.

Replay reports one of three deterministic states:

- **Captured snapshot verified (`resolved`)** — the exact quote occurs once in the saved captured context.
- **Source changed (`stale`)** — a newer source version exists, while Replay deliberately shows the historical snapshot used by the evidence.
- **Exact locator unresolved (`unresolved`)** — the source, chunk, or quote is missing or mismatched, or the quote is too long or appears more than once. QC Smart Reader shows only the saved record and does not guess a precise occurrence.

Switching projects clears the previous project's evidence views before new data arrives. A cross-project mismatch hides source details and remains unresolved. Switching the interface language preserves unsaved claim drafts, selections, expanded Replay panels, and their scroll positions.

Evidence API responses and JSON exports now include one additive versioned `replay` record. Generated Markdown deliverables include an **Evidence Replay** section with safely represented source metadata, quote, and context.

## Privacy and trust boundary

Replay reads only the source and chunk already stored by the local Companion. Opening a Replay panel performs no remote fetch, model call, or telemetry. The optional canonical-source link opens only after the user chooses it and does not prove that the live page still contains the captured text.

Source Replay helps inspect provenance; it does not decide that a claim is supported. Human supported or unsupported decisions remain separate, and ambiguous or missing quote matches never become resolved.

## Install

Prerequisites are macOS, Chrome 116+, Python 3.9+, and internet access during the first Companion install for hash-pinned Python wheels. Codex CLI, `yt-dlp`, and the Swift toolchain are optional.

1. Download `qc-smart-reader-companion-0.9.3.zip`, `qc-smart-reader-extension-0.9.3.zip`, and `SHA256SUMS` below.
2. From the download directory, run `shasum -a 256 -c SHA256SUMS` and confirm both ZIPs report `OK`.
3. Extract the Companion ZIP and double-click `install.command` (or run `bash install.command`). Keep the copied Pairing Token.
4. Extract the Extension ZIP, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the folder containing `manifest.json`.
5. In QC Smart Reader **Settings / 设置**, enter `http://127.0.0.1:37621`, paste the Pairing Token, and choose **Test local Companion / 测试本地服务**.
6. Open an article, run Quick Start, compare the draft claim with its exact quote, save a supported or unsupported decision, then choose **Replay** to verify the captured context.

## Upgrade and compatibility

Run the v0.9.3 `install.command` to upgrade the Companion. The installer verifies readiness and rolls back the service, database, token, and model settings if activation fails. API and schema versions remain at 1, so Companion v0.9.3 keeps the v0.9.0 extension as its minimum compatible version. Source Replay depends on changes in both packages, so use both v0.9.3 ZIPs for this feature.

Uninstall preserves the Vault unless the explicit purge flow is confirmed. Back up the entire Companion data directory—both `vault/` and `state/`—before an important upgrade.

## Current boundaries

- The supported packaged lifecycle is macOS-first, and the extension still requires Chrome Developer mode until a Web Store release is approved.
- English covers setup, pairing, Quick Start, core current-page feedback, First Evidence, and Replay controls. Advanced Batch, Agents, most of Knowledge, Deliverables, and project/model controls remain in Simplified Chinese and are labeled accordingly.
- The localized Web Store screenshots now use independent clean profiles and the real v0.9.3 Companion to show pending review and the same resolved Replay restored after a human decision. They are reproducible release assets; Chrome Web Store upload and approval remain separate publisher steps.
- Replay is anchored to the local captured snapshot and does not guarantee a deep link into the current remote page.
- Automatic YouTube import supports public captions only and does not import cookies or transcribe audio.
- Complex PDF tables, formulas, figures, and multi-column layouts may require manual review.

Please report security issues privately as described in [SECURITY.md](https://github.com/vyang472/qc-smart-reader-extension/blob/main/SECURITY.md). Use the repository issue forms for normal bugs and feature requests.
