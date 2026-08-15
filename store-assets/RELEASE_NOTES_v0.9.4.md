# QC Smart Reader v0.9.4

QC Smart Reader v0.9.4 is the first Chrome Web Store candidate. Its only runtime change is a version-matched setup call to action: Settings now links directly to the exact Companion ZIP required by the installed extension and keeps the matching `SHA256SUMS` verification link beside it.

This repository state prepares the candidate; it does not claim that the Chrome Web Store item has been uploaded, submitted, reviewed, or approved.

## Version-matched Companion setup

Before pairing, open **Settings / 设置** and use:

- **Download Companion v0.9.4 / 下载 Companion v0.9.4** — `https://github.com/vyang472/qc-smart-reader-extension/releases/download/v0.9.4/qc-smart-reader-companion-0.9.4.zip`
- **Verify SHA256SUMS / 校验 SHA256SUMS** — `https://github.com/vyang472/qc-smart-reader-extension/releases/download/v0.9.4/SHA256SUMS`

The extension derives both targets from its own manifest version. The links contain no Pairing Token, API key, query string, or fragment, and they open the public GitHub Release assets in a separate tab.

## Existing evidence workflow

v0.9.4 carries forward the v0.9.3 Source Replay workflow without changing its API or schema. A saved claim can still be inspected against its captured context, locator, source version, and exact quote, with deterministic `resolved`, `stale`, and `unresolved` states. Human supported or unsupported decisions remain separate from Replay verification.

The localized Web Store screenshots were regenerated twice from independent clean profiles against the real v0.9.4 Companion. All Replay, sensitive-data, layout, RGB, and deterministic-hash checks passed. Their pixels remain identical to v0.9.3 because the only new UI is the Settings setup CTA, outside the captured First Evidence views.

## Install

After the v0.9.4 GitHub Release is published:

1. Download `qc-smart-reader-companion-0.9.4.zip`, `qc-smart-reader-extension-0.9.4.zip`, and `SHA256SUMS`.
2. Run `shasum -a 256 -c SHA256SUMS` and confirm both ZIPs report `OK`.
3. Extract the Companion ZIP and run `bash install.command`; retain the copied Pairing Token.
4. Install the extension through its eventual Chrome Web Store listing, or load the extracted Extension ZIP through Developer mode while store review is pending.
5. In Settings, verify that the Companion and checksum actions target v0.9.4, then pair with `http://127.0.0.1:37621`.

## Upgrade and compatibility

Run the v0.9.4 `install.command` to upgrade the Companion. The installer verifies readiness and rolls back the service, database, token, and model settings if activation fails. `API_VERSION` and `SCHEMA_VERSION` remain at 1, and `MIN_EXTENSION_VERSION` remains v0.9.0.

Uninstall preserves the Vault unless the explicit purge flow is confirmed. Back up both `vault/` and `state/` before an important upgrade.

## Current boundaries

- The supported packaged lifecycle is macOS-first. Chrome Developer mode remains necessary until a Chrome Web Store release is approved.
- Core setup, pairing, Quick Start, current-page feedback, First Evidence, and Replay controls are bilingual. Advanced workspaces remain primarily in Simplified Chinese.
- Replay verifies the locally captured snapshot and does not guarantee a deep link into the current remote page.
- Complex PDF layouts, private YouTube captions, and audio transcription remain outside the supported path.

Please report security issues privately as described in [SECURITY.md](https://github.com/vyang472/qc-smart-reader-extension/blob/main/SECURITY.md). Use the repository issue forms for normal bugs and feature requests.
