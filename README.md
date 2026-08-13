# QC Smart Reader

![QC Smart Reader — turn web pages, PDFs, and public YouTube captions into quote-backed claims](store-assets/social-preview.png)

[![CI](https://github.com/vyang472/qc-smart-reader-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/vyang472/qc-smart-reader-extension/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/vyang472/qc-smart-reader-extension?display_name=tag)](https://github.com/vyang472/qc-smart-reader-extension/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-0f766e.svg)](LICENSE)
[![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-2563eb.svg)](manifest.json)

**English · [简体中文](README.zh-CN.md)**

Turn web pages, PDFs, and public YouTube captions into quote-backed claims in a local evidence graph.

QC Smart Reader is a macOS-first Chrome extension and local Python companion. It captures research in your live browser session, stores it as SQLite plus readable Markdown, and makes every reviewed claim point back to an exact quotation. Use it with Codex CLI, an OpenAI-compatible or Anthropic endpoint, or no model at all.

> The model may summarize. The evidence decides what can be trusted.

## See it in action

| Capture in your browser | Review the exact evidence | Keep a durable local Vault |
| --- | --- | --- |
| ![Capture a page in the QC Smart Reader side panel](store-assets/screenshots/01-capture.png) | ![Review a claim against its exact source quotation](store-assets/screenshots/02-evidence-review.png) | ![Inspect the local Markdown and SQLite Vault](store-assets/screenshots/03-local-vault.png) |

## Why it is different

- **Evidence before fluency.** A claim cannot become `reviewed` unless its `source_id`, `chunk_id`, and exact quote still match the stored source text.
- **Staleness is automatic.** Re-capturing changed material invalidates mismatched evidence and marks dependent topic packages and deliverables stale.
- **Local-first by default.** The companion binds to loopback, uses a pairing token, and stores the research record on your Mac. Model use is optional and requires explicit consent.
- **Your signed-in browser does the capture.** Batch jobs reuse the Chrome session you already control and retain item-level status, leases, heartbeats, retries, and restart recovery.
- **Auditable outputs.** Reports, deck outlines, video scripts, and strategy briefs retain their path back through claims and evidence to the source.
- **No API key required to try it.** Deterministic mock extraction exercises the complete evidence workflow locally. Codex CLI can use an existing signed-in Codex setup; direct API providers remain optional.

## Install v0.9.0

The supported release path currently targets **macOS, Chrome 116+, and a Chinese-language product UI**.

1. Download both files from [QC Smart Reader v0.9.0](https://github.com/vyang472/qc-smart-reader-extension/releases/tag/v0.9.0):
   - `qc-smart-reader-companion-0.9.0.zip`
   - `qc-smart-reader-extension-0.9.0.zip`
2. Extract the Companion ZIP, then double-click `install.command` (or run `bash install.command`). It installs a per-user background service, verifies readiness, and copies the Pairing Token.
3. Extract the Extension ZIP. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`.
4. Open the QC Smart Reader side panel. In **设置**, enter `http://127.0.0.1:37621`, paste the Pairing Token, and click **测试本地服务**.

That is enough to capture and run deterministic local extraction. To use a model, select one route in **设置 → 模型设置**:

- **Codex CLI:** uses the locally installed, signed-in `codex` command; no separate API key is required by QC Smart Reader.
- **OpenAI-compatible or Anthropic:** uses the endpoint and API key you provide.
- **No model:** keeps extraction local and clearly labels deterministic mock output.

For source checkouts, upgrades, recovery, uninstall, and troubleshooting, see [从零到能用](上手指南.md).

## The evidence chain

```text
Chrome capture / PDF / captions
              │
              ▼
      source → chunk → exact quote
                          │
                          ▼
                       claim
                          │
                          ▼
           topic package → deliverable
```

The extension sends authenticated requests only to the loopback companion. The companion keeps a queryable SQLite index and a plain Markdown Vault under `~/Documents/QC Smart Reader Vault/`. Optional model calls are made by the companion to the provider the user selected; source material included in that action then leaves the device under that provider's terms.

## What v0.9.0 handles

| Workflow | Current behavior |
| --- | --- |
| Web capture | Current page, selected text, and recoverable URL batches using the live Chrome session |
| Site extraction | Dedicated profiles for common forums and publishing sites, plus a generic page profile |
| PDFs | Text-layer extraction with page citations; low-text pages can use macOS Vision OCR |
| YouTube | Manual captions or public captions discovered through an existing `yt-dlp`; no audio transcription or cookie import |
| Knowledge | Entities, claims, evidence, relations, assumptions, risks, tasks, review history, merge/split, and quote re-validation |
| Outputs | Evidence-backed topic packages, reports, deck outlines, video scripts, and strategy handoffs |
| Integrity | Vault Doctor, lineage rebuild, source versioning, stale propagation, deterministic release archives, and upgrade rollback |

## Trust and privacy boundaries

- The project is single-user and local-only; it has no hosted QC Smart Reader account or cloud sync.
- The companion listens on `127.0.0.1` by default and requires a random pairing token for data APIs.
- Web content is untrusted input. Provider output is also untrusted until its evidence passes validation.
- Local PDF imports are restricted to allowed directories. Remote PDF and caption fetches reject private, loopback, link-local, and reserved network targets.
- QC Smart Reader does not bypass paywalls, import browser cookies for captions, or transcribe video audio.
- The Vault contains the user's research material. Back up both `vault/` and `state/`; Markdown alone does not preserve every relationship and review state.

Read the complete [Privacy Policy](PRIVACY.md) and [Security Policy](SECURITY.md) before using sensitive material.

## Known limits

- The installer, background service lifecycle, and scanned-PDF OCR path are macOS-first. Windows and Linux packaging are not yet supported.
- The product UI is currently Simplified Chinese; the project documentation is bilingual.
- Installation uses Chrome Developer mode until a Chrome Web Store release is approved.
- Complex PDF layouts, tables, figures, and formulas may need manual review.
- Public YouTube captions depend on an existing `yt-dlp`; private captions and audio transcription are out of scope.
- Batch capture needs Chrome to remain available because the extension is the browser executor.

See [ROADMAP.md](ROADMAP.md) for planned work and explicit non-goals.

## Development and verification

```bash
git clone https://github.com/vyang472/qc-smart-reader-extension.git
cd qc-smart-reader-extension
bash scripts/test_all.sh
```

The release gate checks Python, JavaScript, and shell syntax; Python service behavior; launcher and macOS install/upgrade/rollback/uninstall lifecycles; site-profile and side-panel behavior; real Chromium extension capture and restart recovery; and a temporary-Vault end-to-end evidence chain. The v0.9.0 release candidate passed 86 Python tests, 91 Node/Chromium tests with zero browser skips, 12 launcher tests, 10 lifecycle tests, and the end-to-end smoke test on macOS.

Release archives are built from an explicit allowlist with stable order, timestamps, permissions, and SHA-256 checksums:

```bash
python3 scripts/release.py --check
python3 scripts/release.py
shasum -a 256 -c dist/release/SHA256SUMS
```

## Contributing

Issues and focused pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), use [GitHub Discussions](https://github.com/vyang472/qc-smart-reader-extension/discussions) for design questions, and report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

If QC Smart Reader makes your research easier to verify, a GitHub star helps other local-first researchers find it. More importantly, tell us which source, claim-review, or installation workflow still breaks for you.

## License

[MIT](LICENSE) © Vincent Yang and contributors.
