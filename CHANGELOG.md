# Changelog

All notable changes to QC Smart Reader will be documented here. The project follows [Semantic Versioning](https://semver.org/) for public releases.

## [Unreleased]

No unreleased changes have been announced.

## [0.9.4] - 2026-08-15

This release prepares the first Chrome Web Store candidate and removes a setup dead end by linking each extension build to its exact matching Companion archive and checksum file.

### Added

- A bilingual setup call to action in Settings that derives the direct Companion ZIP and `SHA256SUMS` links from the installed extension manifest version.

### Changed

- Extension, Companion, installer, plugin, and package metadata now identify v0.9.4 consistently. `API_VERSION` and `SCHEMA_VERSION` remain at 1, and Companion v0.9.4 continues to accept extensions from v0.9.0 onward.
- Store and reviewer handoff documents now describe v0.9.4 as a candidate. Chrome Web Store upload, submission, and approval remain separate publisher actions.

### Trust boundary

- Setup links point only to the repository's version-matched GitHub Release assets, carry no Pairing Token or other secret, and keep checksum verification visible beside the download action.

## [0.9.3] - 2026-08-15

This release adds Source Replay so a saved evidence decision can be inspected against the exact captured record later, without guessing a live-page position or fetching the source again.

### Added

- Source Replay in First Evidence, Knowledge, and claim review, with the saved source title, capture time, version and content hash; a page, floor, timestamp, or chunk locator when available; and the exact quote highlighted in its captured context.
- Deterministic `resolved`, `stale`, and `unresolved` Replay states. Changed sources show the captured historical snapshot, while missing, mismatched, oversized, or ambiguous quotes fail closed instead of being presented as a precise match.
- An additive versioned Replay record in evidence API responses and JSON exports, plus an Evidence Replay section in generated Markdown deliverables.

### Changed

- Canonical-source links are explicitly a fallback: they open the saved public HTTP(S) source but do not promise a precise remote scroll position.
- Companion v0.9.3 keeps the v0.9.0 extension as its minimum compatible version because `API_VERSION` and `SCHEMA_VERSION` remain at 1; using both v0.9.3 archives is recommended.

### Fixed

- Project changes now clear evidence views before new data arrives and discard stale asynchronous responses, preventing Replay details from the previous project from remaining visible.
- Interface-language changes preserve unsaved claim drafts, selected claims, expanded Replay panels, and their local scroll positions.
- Markdown Replay output safely represents titles, locators, sites, legal HTTP(S) URLs, exact quotes, and context without letting their content alter document structure.

### Trust boundary

- Replay uses only the locally captured source and chunk. It performs no remote fetch, model call, or telemetry, hides source details on project mismatch, and never treats an ambiguous or missing exact quote as resolved.

## [0.9.2] - 2026-08-15

This release makes the core path to a first reviewed piece of evidence available in English and Simplified Chinese, and makes the user's support decision explicit.

### Added

- Browser-locale-aware core onboarding with local Auto, English, and Simplified Chinese choices. Changing the interface language is side-effect-free and does not send telemetry or source content anywhere.
- Final English and Simplified Chinese Web Store screenshots captured from clean browser profiles against the real local Companion and a public deterministic fixture.
- Equal-weight actions to mark the First Evidence claim supported or unsupported after comparing it with the exact stored-source quote.

### Changed

- First Evidence now presents three user steps: connect the Companion, capture the current page, then review and save. Deterministic local extraction remains an internal operation rather than a separate user task.
- Core setup, pairing, Quick Start, current-page feedback, First Evidence, and their primary errors are bilingual. Advanced Batch, Agents, most of Knowledge, Deliverables, and project/model controls remain in Simplified Chinese and are identified at that boundary.
- Companion v0.9.2 keeps the v0.9.0 extension as its minimum compatible version because `API_VERSION` and `SCHEMA_VERSION` remain at 1.

### Fixed

- Side-panel controls now remain inert until locale, event handlers, Companion authentication, and the project batch queue are ready; slow optional workspace hydration no longer blocks interaction or drops early clicks.
- Restoring First Evidence now checks the server-owned claim status: `reviewed` restores supported, `rejected` restores unsupported, and any mismatch returns the claim to review instead of trusting stale local progress.
- First Evidence decisions and completion milestones remain isolated by project, while claim and quote text are preserved verbatim across language changes.
- Current-page, selector, pagination, and Companion setup failures now keep their dynamic context when rendered in either supported language.

### Trust boundary

- QC Smart Reader never decides whether a claim is supported on the user's behalf. Both choices are human decisions persisted by the local Companion; the local template remains deterministic draft generation, not an AI summary.

## [0.9.1] - 2026-08-15

This release removes model setup from the path to a first persisted, reviewable piece of evidence.

### Added

- Pairing-gated Quick Start that captures the active page, saves it to the local Vault, runs deterministic local template extraction, and presents a draft claim beside an exact source quote.
- Local onboarding milestones that restore the first-evidence and human-review state after the side panel is reopened, without developer analytics or telemetry.

### Changed

- New installations default to the zero-configuration local template route. Codex CLI, OpenAI-compatible, and Anthropic providers are explicit opt-ins and retain their model-data consent boundary.
- Reading the current page now persists the capture immediately instead of keeping it only in transient side-panel state.
- Companion v0.9.1 remains compatible with the v0.9.0 extension because the API and database schema stay at version 1.

### Fixed

- Startup and manual pairing now authenticate the stored Pairing Token against a protected API before onboarding is marked ready.
- External-provider extraction fails closed when configuration or consent is incomplete and never silently substitutes the local template route.

### Trust boundary

- Local template extraction is deterministic draft generation, not an AI summary. Its quote comes from the stored source, but the claim remains unreviewed until the user checks the quote and explicitly accepts it.

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

[Unreleased]: https://github.com/vyang472/qc-smart-reader-extension/compare/v0.9.4...HEAD
[0.9.4]: https://github.com/vyang472/qc-smart-reader-extension/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/vyang472/qc-smart-reader-extension/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/vyang472/qc-smart-reader-extension/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/vyang472/qc-smart-reader-extension/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/vyang472/qc-smart-reader-extension/releases/tag/v0.9.0
