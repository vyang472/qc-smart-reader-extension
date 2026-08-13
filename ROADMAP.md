# QC Smart Reader Roadmap

QC Smart Reader is aiming to become a dependable local evidence workspace, not a general-purpose chatbot. This roadmap communicates direction, not promised dates. Priorities will follow reproducible user problems and contributor capacity.

## Current foundation — v0.9

- Chrome capture, selected text, and restart-safe URL batches.
- Text PDFs, macOS Vision OCR, and public/manual YouTube captions.
- Exact-quote evidence validation and stale propagation.
- Claim/evidence review, topic packages, lineage, Vault Doctor, and evidence-backed deliverables.
- Local SQLite + Markdown storage, optional providers, and deterministic mock mode.
- Verified macOS install, upgrade, rollback, uninstall, and reproducible release archives.

## Near term — make the public preview easier to adopt

- Publish and maintain the Chrome Web Store listing after policy review.
- Reduce first-run friction and make service, Pairing Token, provider-consent, and Vault state easier to diagnose.
- Add English UI localization without replacing the existing Simplified Chinese copy.
- Expand real-world fixtures for login walls, long forum threads, deleted replies, pagination, and malformed pages.
- Document compatibility and migration behavior for every supported release.
- Improve accessibility, keyboard navigation, and narrow-screen behavior in the side panel.

## Platform reach

- Design verified Windows and Linux Companion installation and lifecycle paths.
- Add cross-platform OCR adapters while retaining page-level provenance and explicit failure states.
- Keep release artifacts reproducible and make platform-specific limitations visible before installation.

## Research depth

- Improve reading order and citations for multi-column PDFs, tables, figures, formulas, and references.
- Add asynchronous, inspectable re-extraction queues and finer-grained source-edit/chunk regeneration.
- Improve cross-source clustering, contradiction surfacing, entity/topic maintenance, and claim-history replay.
- Add optional project retrieval and map-reduce workflows with visible token/cost budgets.
- Expand export formats only when citations and Ready Gates survive the export.

## Not planned as hidden behavior

- Passive browsing-history collection or background capture without a user action.
- Buying, exchanging, automating, or otherwise manipulating stars, votes, reviews, or community engagement.
- Bypassing paywalls, authentication, private-caption controls, robots protections, or provider terms.
- Treating model-generated prose as reviewed evidence.
- Uploading the Vault to a QC Smart Reader cloud account by default.
- Executing trades or presenting a generated strategy brief as investment advice.

## How priorities are chosen

A roadmap proposal is strongest when it includes a real user workflow, a minimal public fixture, expected trust/privacy behavior, and an acceptance test. Start that discussion in [GitHub Discussions](https://github.com/vyang472/qc-smart-reader-extension/discussions) before implementing a large change.
