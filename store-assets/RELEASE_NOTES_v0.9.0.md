# QC Smart Reader v0.9.0

QC Smart Reader turns web pages, PDFs, public YouTube captions, and selected text into a local research Vault where structured claims stay tied to exact source quotations.

This is the first packaged public release. It is macOS-first, runs as a Chrome 116+ extension plus a loopback companion service, and keeps its Markdown + SQLite Vault on your computer.

## Install

Prerequisites are macOS, Chrome 116+, Python 3.9+, and internet access during the first Companion install for hash-pinned Python wheels. Codex CLI, `yt-dlp`, and the Swift toolchain are optional.

1. Download `qc-smart-reader-companion-0.9.0.zip`, `qc-smart-reader-extension-0.9.0.zip`, and `SHA256SUMS` below.
2. Verify both ZIPs from their download directory:

   ```bash
   shasum -a 256 -c SHA256SUMS
   ```

3. Unzip the companion package and double-click `install.command` (or run `bash install.command`). Keep the copied pairing token.
4. Unzip the extension package, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select that folder.
5. In QC Smart Reader settings, enter `http://127.0.0.1:37621`, paste the pairing token, and test the connection.

## What is included

- User-initiated capture for articles, forum threads, selected text, PDFs, and public YouTube captions.
- Quote validation before a structured claim can be marked reviewed.
- Versioned source captures, stale propagation, lineage inspection, and project-isolated records.
- Restart-safe batch jobs with leases, heartbeats, pause/resume, retry, cancel, and recovery.
- Local Markdown + SQLite storage with schema backup and upgrade checks.
- Optional Codex CLI, OpenAI-compatible, or Anthropic model providers with explicit consent; deterministic local mock mode remains available.
- macOS Vision OCR fallback for scanned or low-text PDFs.
- Hash-locked companion dependencies, deterministic release archives, and rollback-aware install/update/uninstall scripts.

## Upgrade and data safety

Running the new `install.command` validates the old service, stops it, creates a verified SQLite backup before the schema upgrade, and rolls back the service, database, token, and model settings if readiness checks fail. Uninstall preserves the Vault unless the explicit purge flow is confirmed.

Back up the entire companion data directory—especially `vault/` and `state/`—before any important upgrade.

## Current boundaries

- The supported packaged companion lifecycle is macOS-first; the extension UI is currently Simplified Chinese.
- Automatic YouTube import supports public captions only. It does not bypass login, cookies, private captions, or perform audio transcription.
- PDF extraction does not yet reconstruct complex tables, formulas, figures, or every multi-column layout.
- Model use is optional and may send the selected source material to the provider chosen by the user under that provider's terms.
- The Chrome Web Store listing is not part of this GitHub release; install the extension as unpacked for now.

Please report security issues privately as described in [SECURITY.md](https://github.com/vyang472/qc-smart-reader-extension/blob/main/SECURITY.md). For normal bugs and feature requests, use the repository issue forms.
