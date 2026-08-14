# QC Smart Reader v0.9.1 launch kit

**Status:** ready-to-edit drafts. Nothing in this file means a post, submission, endorsement, or store approval has happened.

The launch goal is to find real users who care about verifiable research and learn where the workflow fails. It is not to manufacture a ranking.

## Non-negotiable launch rules

- Never buy stars, votes, reviews, comments, installs, or followers.
- Never join vote rings, coordinate reciprocal voting, use bots, or ask friends and communities to upvote.
- Never conceal that you built the project.
- Do not mass-DM, repeatedly repost, or paste identical copy across unrelated communities.
- Read each community's current rules before posting; adapt the post to its audience.
- Ask for use and feedback. A neutral link to the repository is enough; people can decide whether to star it.
- Correct inaccurate claims publicly and update the docs when a real limitation appears.

## Launch prerequisites

- [ ] Public repository has v0.9.1 source, passing CI, license, privacy policy, security policy, support guide, and contribution guide.
- [ ] GitHub Release contains both ZIPs and `SHA256SUMS`.
- [x] README and launch images were recaptured from the reviewed v0.9.1 build and passed visual and sensitive-data checks.
- [ ] A clean macOS account completes install → pair → capture → evidence review → restart recovery → uninstall.
- [ ] Issues and Discussions are enabled and monitored for the first launch week.
- [ ] Chrome Web Store status is described accurately; do not say “available in the store” before approval.

## Canonical positioning

**One line**

QC Smart Reader turns web pages, PDFs, and public YouTube captions into quote-backed claims in a local evidence graph.

**Who it is for**

Researchers, students, analysts, and technical readers who want an auditable local record instead of an uncheckable AI summary.

**What makes it different**

Every reviewed claim must still match an exact quote in the stored source chunk. When the source changes, affected evidence and downstream outputs become stale instead of silently remaining “trusted.”

**Honest qualifier**

The v0.9.1 public preview is macOS-first, loaded through Chrome Developer mode, and has a Simplified Chinese product UI. Complex PDFs and sites still need real-world testing.

## Product Hunt draft

### Fields

- **Name:** QC Smart Reader
- **Tagline:** Turn research into quote-backed claims
- **Topics:** Productivity, Artificial Intelligence, Chrome Extensions, Knowledge Management
- **Website:** https://github.com/vyang472/qc-smart-reader-extension
- **Thumbnail:** `store-assets/product-hunt-thumbnail.png`
- **Gallery:** `store-assets/screenshots/01-capture.png`, `02-evidence-review.png`, `03-local-vault.png`

### Short description

Capture web pages, PDFs, and public YouTube captions; verify every reviewed claim against an exact source quote; and keep the evidence graph in a local Markdown + SQLite Vault. macOS-first, open source, and usable with Codex CLI, your own API, or no model.

### Maker comment

Hi Product Hunt — I built QC Smart Reader because fluent AI summaries made my research faster but not easier to audit.

The core rule is deliberately strict: a claim cannot become reviewed unless it points to an exact quote that still exists in the stored source chunk. If a source changes, invalid evidence and dependent outputs become stale.

The product is a Chrome side panel plus a local Python Companion. It captures pages in your live browser session, imports PDFs and public captions, and stores the durable record as SQLite plus readable Markdown. Quick Start can create a first draft claim with an exact stored-source quote through deterministic local template extraction. That draft is not an AI summary and remains unreviewed until the user accepts it. Model use is optional: Codex CLI or an OpenAI-compatible or Anthropic endpoint.

This is a v0.9.1 public preview. It is macOS-first, the UI is Simplified Chinese, and Chrome Developer mode is required until a Chrome Web Store release is approved. I would especially value reports from people who try the zero-configuration First Evidence path, a difficult forum thread, a real paper, or the evidence-review workflow. Which step feels least trustworthy or most cumbersome?

### Gallery captions

1. **Capture with context** — read the page you selected or recover a URL batch in the Chrome side panel.
2. **Review the evidence** — compare every claim with its exact quote and source context before accepting it.
3. **Keep the record** — retain sources, decisions, lineage, and outputs in a local Markdown + SQLite Vault.

### Maker Q&A notes

- **Is it fully offline?** Current-page capture and local template extraction can remain local. Web retrieval, public-caption discovery, and optional model providers require network access.
- **Does Codex CLI mean no API cost?** QC Smart Reader does not require a separate API key for that route, but the user's Codex/OpenAI account terms and limits still apply.
- **Why `<all_urls>`?** To extract arbitrary pages only after the user chooses them; there is no passive history collection.
- **Why Developer mode?** The Web Store listing is a separate publisher review step and must not be presented as approved early.

## Show HN draft

### Title

Show HN: QC Smart Reader – A local evidence graph for web pages and PDFs

### Post

I built QC Smart Reader, a macOS-first Chrome side panel and local Python service for research that needs to be checked later.

The design rule is that a claim cannot become “reviewed” unless it has a source id, chunk id, and exact quote that still matches the stored text. Re-capturing changed material invalidates mismatched evidence and marks dependent topic packages and outputs stale.

It captures the current page or recoverable URL batches using the live Chrome session, imports text PDFs with page citations (plus macOS Vision OCR), and can ingest manual or public YouTube captions. The record stays in local SQLite plus readable Markdown. The zero-configuration local template produces a deliberately simple draft claim with a real stored-source quote and waits for human acceptance; it is not an AI summary. Codex CLI and OpenAI-compatible / Anthropic providers are optional.

You can try the v0.9.1 release here: https://github.com/vyang472/qc-smart-reader-extension

Current limits: macOS-first installer, Simplified Chinese UI, unpacked Chrome extension, and imperfect complex-PDF handling. I would appreciate technical feedback on the evidence invariant, local service boundary, and the roughest part of installation. The repository includes the complete release gate and threat boundaries.

## Reddit draft

Post only in a community where self-promotion and project links are allowed. Read the current rules, disclose that you are the maker, and answer questions there rather than duplicating the same post elsewhere.

### Title

I built an open-source, local-first Chrome reader that rejects claims without exact source quotes

### Body

I am the maker of QC Smart Reader. I wanted the speed of AI-assisted reading without making a fluent summary the artifact of record.

The extension captures pages in the Chrome session I already use. A local Python Companion stores the source, chunks, evidence, claims, review decisions, and outputs in SQLite plus Markdown. A claim only reaches reviewed when its exact quote still matches the current source chunk; changed sources make dependent work stale.

v0.9.1 can also import PDFs with page citations, use macOS Vision OCR for low-text pages, ingest public/manual YouTube captions, recover long URL batches, and produce evidence-backed research outputs. Model use is optional; deterministic local template extraction can exercise the evidence workflow without pretending to be an AI summary, and every draft still needs human review.

Repository and release: https://github.com/vyang472/qc-smart-reader-extension

The honest limitations are macOS-first packaging, a Simplified Chinese UI, Developer-mode installation, and incomplete complex-PDF handling. If this matches your workflow, I would value a real test and a blunt report about where trust or usability breaks.

## X / Mastodon draft

I built QC Smart Reader: an open-source, local-first Chrome reader where a claim cannot become “reviewed” unless its exact quote still exists in the source. Web/PDF/public captions → evidence graph → Markdown + SQLite Vault. macOS-first v0.9.1: https://github.com/vyang472/qc-smart-reader-extension

## LinkedIn draft

I have released QC Smart Reader v0.9.1, an open-source Chrome extension and local Companion for research that needs an audit trail.

Instead of treating an AI summary as the record, QC Smart Reader stores an evidence graph: source → chunk → exact quote → claim → topic package → deliverable. A reviewed claim must still match its source; if the source changes, affected work becomes stale.

The public preview supports a zero-configuration First Evidence path, browser capture, restart-safe URL batches, PDF page citations with macOS OCR, public/manual YouTube captions, local Markdown + SQLite storage, and optional Codex CLI or API providers. Its local template creates only an unreviewed draft with a real quote; it does not impersonate an AI summary.

It is intentionally honest about its current edges: macOS-first, Simplified Chinese UI, Developer-mode Chrome installation, and more work needed on complex PDFs.

Source, release, tests, and architecture: https://github.com/vyang472/qc-smart-reader-extension

I am looking for feedback from people who need to verify research later: where does the evidence workflow help, and where does it create too much friction?

## GitHub announcement draft

### Title

QC Smart Reader v0.9.1: zero-config first evidence

### Body

The first public preview is ready for real research workflows.

Highlights:

- exact-quote validation before claims can be reviewed;
- pairing-gated Quick Start that persists the current page and waits for human acceptance of its local-template draft;
- local SQLite + readable Markdown Vault;
- current-page, selected-text, and restart-safe batch capture;
- PDF page citations and macOS Vision OCR;
- public/manual YouTube captions;
- optional Codex CLI or API providers, plus deterministic local template extraction without an external model;
- verified installer upgrade, rollback, uninstall, and reproducible release ZIPs.

The supported path is currently macOS + Chrome 116+, with a Simplified Chinese UI and Developer-mode installation. Please use public or synthetic fixtures in reports and keep secrets and private Vault content out of issues.

Start with the release: https://github.com/vyang472/qc-smart-reader-extension/releases/tag/v0.9.1

## Awesome-list proposal draft

Before opening a pull request, confirm the target list accepts this project and follow its entry format exactly.

```markdown
- [QC Smart Reader](https://github.com/vyang472/qc-smart-reader-extension) — Local-first Chrome research reader that validates reviewed claims against exact source quotes and stores an auditable Markdown + SQLite evidence graph. (macOS, Chrome)
```

Do not submit to many loosely related lists. One relevant, maintained list with an accurate category is better than broad link placement.

## Respectful direct outreach

Contact only people who have publicly asked for tools in this problem area or who already know the project. Personalize the note and ask permission to share details.

> You mentioned needing auditable source notes. I built an open-source macOS/Chrome preview that requires each reviewed claim to match an exact source quote. If you are still exploring this workflow, may I send the repository? No expectation to promote it; a short usability critique would help.

Never turn this into a bulk message, scraped mailing list, or request for a star.

## First-week operating checklist

- Reply to every substantive question with reproducible facts.
- Convert repeated confusion into README or onboarding fixes.
- Label confirmed defects and publish known workarounds quickly.
- Record installs, capture success, evidence-review completion, issue quality, and returning contributors only when the data is actually available and collected with appropriate consent.
- Do not quote a star count as product validation; look for successful workflows and retained users.
- Post a short retrospective that includes failures, not only launch highlights.
