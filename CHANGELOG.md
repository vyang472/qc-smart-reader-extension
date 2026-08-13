# Changelog

All notable changes to QC Smart Reader will be documented here. The project follows [Semantic Versioning](https://semver.org/) for public releases.

## [Unreleased]

No unreleased changes have been announced.

## [0.9.0] - 2026-08-14

First public preview.

### Added

- Local-first Chrome side-panel workflow for current-page, selected-text, and recoverable batch capture.
- Python Companion with pairing-token authentication, origin restrictions, SQLite state, and a readable Markdown Vault.
- Evidence-gated entities, claims, evidence, relations, assumptions, risks, tasks, review history, claim merge/split, and quote re-validation.
- Source versioning, stale dependency propagation, lineage rebuild, and Vault Doctor consistency checks.
- Topic packages and traceable report, deck-outline, video-script, and strategy-handoff deliverables.
- Text-layer PDF extraction with page citations and optional macOS Vision OCR for low-text pages.
- Manual YouTube caption import and public-caption discovery through an existing restricted `yt-dlp` command.
- Codex CLI, OpenAI-compatible, and Anthropic model routes with explicit model-data consent, plus a deterministic local mock mode.
- Per-user macOS installer, LaunchAgent lifecycle, verified upgrade, database backup, rollback, and data-preserving uninstall.
- Deterministic split release archives with an explicit allowlist and SHA-256 manifest.
- End-to-end smoke coverage plus real Chromium extension, batch recovery, installer lifecycle, and provider contract tests.

### Changed

- Structured re-extraction now re-validates historical evidence, reuses records idempotently, and preserves still-valid review decisions.
- Batch jobs retain server-owned leases, heartbeats, failure categories, pagination checkpoints, pause/resume/cancel state, and restart recovery.
- Model credentials live in the Companion rather than Chrome extension storage.

### Fixed

- Restored Python 3.9–3.11 startup compatibility by removing Python 3.12-only f-string syntax.
- Prevented late batch success events from overwriting cancellation and prevented recovery from reclaiming an item with a fresh heartbeat.
- Added explicit failures for missing browser-test prerequisites instead of silently skipping release-gate coverage.

### Security

- Restricted the default service to loopback and protected data endpoints with a random Pairing Token.
- Added allowed-directory enforcement for local PDFs and redirect-aware public-network validation with size limits for remote downloads.
- Isolated Codex CLI runs in an ephemeral restricted environment and disabled shell, web, plugin, and delegation capabilities for provider calls.
- Added archive/input validation, dependency integrity checks, cautious installer path handling, and rollback verification.

[Unreleased]: https://github.com/vyang472/qc-smart-reader-extension/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/vyang472/qc-smart-reader-extension/releases/tag/v0.9.0
