# QC Smart Reader 实战版升级工单

This tracker turns the current Chrome Extension MVP into a practical research, learning, and strategy-production tool.

## 实战原则

- The browser is the collector, not the database. Chrome storage only keeps UI state, service URL, and temporary queue state.
- The companion service is the durable state owner: SQLite, Markdown Vault, jobs, LLM runs, citations, exports, and logs.
- Every durable conclusion must trace to `source_id + chunk_id + quote + URL/floor/PDF page`.
- Uncited conclusions must be marked `待验证` and cannot enter final deliverables as facts.
- Site support is only considered done when it has fixtures and failure-mode tests.
- Human review is a core workflow, not a later polish item.

## Current State

Implemented:

- Chrome MV3 side panel, current-page reading, selected-text right click, settings, and multi-role reading prompt.
- Companion service on `127.0.0.1:37621` with SQLite + Markdown Vault.
- Source, document, chunk, note, agent run, job, job item, and job event base tables.
- `/health`, `/v1/captures`, `/v1/sources`, `/v1/notes`, `/v1/search`, `/v1/jobs/read`, `/v1/jobs`, `/v1/jobs/:id`, `/v1/jobs/:id/status`, `/v1/jobs/:id/events`, `/v1/jobs/:id/recover`, `/v1/jobs/:id/retry-failed`, `/v1/jobs/:id/pause`, `/v1/jobs/:id/resume`, `/v1/jobs/:id/cancel`, `/v1/jobs/:id/clear-completed`, `/v1/jobs/:id/claim-next`, `/v1/jobs/:id/items/:item_id/status`, `/v1/jobs/:id/items/:item_id/retry`, `/v1/jobs/:id/items/:item_id/heartbeat`.
- Vault bootstrap: `README.md`, `schema.md`, `CLAUDE.md`, `index.md`, `log.md`, `原始资料/`, `wiki/`.
- Site profile prototype for QuantClass/BBS, Zhihu, WeChat article, Substack, Medium, HN, Reddit, arXiv, GitHub Issues/Discussions, and generic pages.
- QuantClass/BBS extension capture payload preserves attachments/download links in blocks, markdown, stats, and companion request content.
- Standalone site profile registry in `extractors/site_profiles.mjs` with fixture tests for QuantClass/BBS, Zhihu, WeChat article, Substack, Medium, Hacker News, Reddit, arXiv, GitHub Issues/Discussions, and generic fallback.
- Batch URL queue from pasted URLs and current Chrome window tabs.
- PDF ingestion endpoint `/v1/pdfs/extract` for local path or PDF URL, using a bundled Python worker when available.
- PDF page-level chunks with `page_start` and `page_end`, low-text detection, and original PDF copy into `原始资料/papers/`.
- Provider-backed structured extraction for `POST /v1/sources/:id/extract-knowledge` with `auto`, `provider`, and `mock` modes, JSON repair retry, strict `source_id + chunk_id + quote` citation validation, and adversarial fixtures for fake quotes, cross-source chunk ids, missing evidence, source-only citations, and over-limit outputs.
- Extraction `agent_runs` record prompt/schema/model/provider metadata plus token estimates, provider usage, latency, provider call count, and optional cost estimates when model pricing is configured.
- Companion service integration tests for capture/Vault/search, job lifecycle controls, and generated text-layer PDF ingest.

Not yet practical-grade:

- Browser site extraction, 100 URL browser recovery, PDF text-layer parsing, and advanced citation failure modes now have automated coverage; scanned PDF/OCR and full golden-project fixtures remain pending.
- Jobs now have a durable item/event ledger, pipeline phase events for capture/quality gate/review-or-extract routing, lease-based `claim-next`, heartbeat, stale-running recovery, retry endpoints, pause/resume/cancel, clear-completed support, visible ETA/last-heartbeat progress, configurable 1-3 extension concurrency, and an extension executor that claims work from the service before falling back to local iteration.
- API keys now live in companion service `state/model_settings.json`; extension sends prompts to service-side `/v1/llm/chat`.
- Source detail/edit/delete/reprocess UI is incomplete.
- Structured knowledge tables and API are implemented for entities, claims, evidence, relations, assumptions, risks, strategy ideas, and tasks.
- Topic package foundation is implemented for canonical claims, duplicate claim ids, supporting/contradicting evidence ids, open questions, evidence strength, review/stale status, Vault `wiki/topics/` pages, index, and export.
- Deliverable endpoint/table/template layer is implemented for Markdown reports, PPT outlines, video scripts, and strategy task briefs; claims without valid citations are marked `待验证`.
- Extension Deliver tab can create those deliverables from the current source and latest reading result, then create strategy handoffs, manage strategy implementation tickets, import backtest results, and submit paper/live review checklists.
- Extension export now uses companion service `GET /v1/export?format=json|markdown` before falling back to Chrome local storage.
- Deterministic mock extraction and provider-backed extraction can create structured knowledge records from source chunks and record `agent_runs` rows.
- Extension Knowledge tab can trigger automatic structured extraction for the current source and list recent records; it uses provider mode when model settings are configured and mock mode as a deterministic fallback.
- Extension Knowledge tab has a source library with detail view for raw/summary paths, chunks, text preview, linked notes, and "set as current" reload.
- Extension Knowledge tab can search sources, chunk text, notes, and tags through `/v1/search`, then open matching source details.
- Sources have `new/needs_review/read/extracted/reviewed/rejected/archived` status, status filtering, UI status actions, and status visibility in source summaries/index/export.
- Source-level review queue is available for `needs_review/new/extracted` sources with accept/reject/detail/reload actions; claim/evidence review workbench is available for quote context, claim editing, reviewer notes, rejection reasons, evidence status, current quote recheck, status/source/topic/evidence-strength/quote-validity filters, batch claim review, duplicate-claim merge, over-broad claim split, and claim history event/diff review.
- Project API, default Inbox project, extension project selector, project-scoped sources/notes/search/knowledge/deliverables/export, project-scoped capture writes, project brief/rubric, capture plan approval gate, project dashboard, and human stage confirmation are implemented.
- Universal lineage/dependency records are implemented for `source/chunk -> evidence -> claim -> topic -> deliverable -> handoff -> ticket/backtest/review`, with rebuild/query APIs, export coverage, and a side panel rebuild summary.
- Advanced claim history replay UI, full quality-weighted stage gates, budget tracking, vault doctor rebuild/repair mode, async source edit/chunk-regeneration rerun queues, historical claim/evidence auto-revalidation, and external strategy workspace export are not implemented. Claim/evidence review workbench, duplicate-claim merge, over-broad claim split, claim event export/doctor checks, claim history event/diff foundation, source version diff, synchronous source re-extraction job/event ledger, vault doctor diagnostic checks, review-time quote recheck, canonical source-version stale marking, and source/claim/evidence lineage stale gates are implemented.
- Local API now has pairing token auth and CORS origin allowlist; model API key storage moved to companion service config. File allowlists, backup/restore, and sensitive-data controls remain incomplete.

## 实战版更新带总工单

This is the update ladder from the current MVP to a tool that can support the user's real workflow: collect 100+ forum posts, let AI screen relationships/value/reasoning chains, deep-research a domain, generate PPT/video material, and hand off a strategy that can be backtested and reviewed.

### U1 Data Reliability: 来源库和批量采集可依赖

Goal: make collection boring and recoverable. The user should trust that 100 posts can be captured, deduped, retried, and audited without babysitting every tab.

P0:

- [x] Finish browser smoke coverage for service-owned batch dispatch, heartbeat, and pause/resume/cancel.
- [x] Finish browser smoke coverage for close/restart recovery in the live extension flow.
- [x] Add per-item failure categories: auth required, timeout, empty extraction, parse failed, duplicate, service error, pagination needed, attachment missing.
- [x] Add no-silent-truncation policy for comments/code/images/attachments, with exact counts and `truncated` metadata.
- [x] Add manual selector fallback when profile extraction is poor.
- [x] Add job-level quality gate/blocker counts so successful captures that still need review are visible in job summaries and batch progress.
- [x] Finish shared site profile migration so live MV3 extraction and fixture extraction use the same logic where feasible.
- [x] Add QuantClass multi-page/pagination fixture and browser smoke test.

P1:

- [x] Add list-page source discovery: collect candidate thread/article links from a forum/list page into capture plans.
- [x] Add attachment download ledger: URL, filename, context/floor, downloaded path, status, retry error.
- [x] Add canonical URL normalization and source alias/version records.

P2:

- [ ] Add monitoring inbox for selected authors/keywords/sites.
- [ ] Add OCR queue placeholder for images and scanned PDFs.

Acceptance:

- [ ] 100 URLs can run through queue, pause/resume, survive browser/service restart, and export a job/event audit.
- [x] A QuantClass-like thread preserves main post, comments, floors, code blocks, images, attachment links, and pagination state.
- [x] Low-quality or incomplete captures become review items instead of silently entering research.

Risks and tradeoffs:

- Browser-side extraction is fragile across sites; fixtures and failure categories are more valuable than adding many unsupported sites.
- Full attachment downloading should wait for file allowlists; until then, store links and context reliably.

### U2 Evidence Trust: 单来源抽取和审阅可证明

Goal: every extracted claim must be grounded in exact source text, and weak evidence must be blocked before it contaminates topic packages.

P0:

- [x] Add claim/evidence review workbench: preview quote in chunk context, accept/reject/edit, rejection reason, reviewer note, batch actions.
- [x] Add merge foundation for duplicate claims: move evidence/linked records to canonical claim, archive merged claims, and stale affected downstream lineage.
- [x] Add split foundation for over-broad claims: archive source claim, clone evidence as pending validation, write claim events, and stale affected downstream lineage.
- [x] Add claim history event/diff foundation for review/merge/split decisions.
- [ ] Add advanced claim history replay UI for side-by-side diffs, evidence assignment changes, and decision rollback planning.
- [x] Add evidence-level status and review-time quote recheck for edited/stale source chunks.
- [x] Add explicit source version diff and synchronous re-extraction job/event ledger for existing sources.
- [ ] Add async source edit/chunk-regeneration rerun queue that revalidates prior claims/evidence after source text regeneration.
- [x] Add provider output fixtures for malformed JSON, fake quotes, cross-source chunk ids, missing evidence, and overlong outputs.
- [x] Record prompt/schema/model/provider version and token/cost on every extraction run.

P1:

- [x] Add reviewer queue filters by status, source, topic package, evidence strength, and quote validity.
- [ ] Add reviewer queue filtering by extraction run once claim/evidence records store extraction run ids.
- [x] Add source version diff view in the source detail panel.
- [ ] Add claim text diff view beyond the current claim event foundation.
- [ ] Add role-specific extraction passes: Extractor, Reviewer, Domain Expert, Engineer, Synthesizer after single-run reliability is proven.

P2:

- [ ] Add keyboard shortcuts and batch UI polish for high-volume review.

Acceptance:

- [x] No claim can become `reviewed` without at least one valid `source_id + chunk_id + quote`.
- [x] Edited claims/evidence and stale source chunks trigger review-time evidence revalidation; same-canonical new source versions stale old reviewed lineage.
- [x] Explicit source re-extraction jobs produce a reviewer-visible source diff and auditable job/event ledger.
- [ ] Source edit/chunk-regeneration jobs automatically queue affected claims/evidence for revalidation.
- [ ] A 30-source fixture produces accepted/rejected/pending claims with reviewer notes and reproducible audit rows.

Risks and tradeoffs:

- Human review is slower, but skipping it makes final strategy briefs untrustworthy.
- Multi-agent extraction should not expand until the citation validator and review queue are stable.

### U3 Research Package: 多文档研判和推演链

Goal: implement the uncle's core value proposition: AI identifies relationships, value, conflicts, and reasoning chains across many sources.

P0:

- [ ] Add semantic clustering for similar claims and themes across sources.
- [ ] Add conflict matrix: supporting evidence, contradicting evidence, weak evidence, stale evidence, unresolved questions.
- [ ] Add reasoning chain records: evidence -> judgment -> assumption -> conclusion -> strategy implication -> validation experiment.
- [ ] Add entity/topic incremental maintenance so `wiki/topics`, `wiki/entities`, `wiki/sources`, and `wiki/analyses` update existing pages instead of creating isolated files.
- [x] Add stale marking driven by lineage when source, claim, evidence, or canonical source-version changes invalidate downstream topic packages and deliverables.
- [ ] Extend stale marking to full source text edit diffs, chunk regeneration, topic package edits, deliverable section regeneration, async rerun queues, and claim/evidence-level stale records.

P1:

- [ ] Add relationship graph, timeline, evidence matrix, and open-question table.
- [ ] Add topic package comparison: before/after new sources, strengthened claims, weakened claims, newly contradicted claims.

P2:

- [ ] Add project RAG Q&A over reviewed sources only, with citation-required answers.

Acceptance:

- [ ] 30-100 reviewed sources produce topic clusters, canonical claims, duplicate claims, contradictions, open questions, and reasoning chains.
- [ ] Any topic conclusion can trace through lineage to exact chunks and quotes.
- [x] Source/claim invalidation marks affected topic packages and deliverables stale through lineage.
- [ ] New sources update existing topic/entity pages instead of creating isolated pages.

Risks and tradeoffs:

- Semantic clustering can overmerge. Keep manual split/merge and canonical claim review as the final authority.
- Reasoning chains must separate evidence, inference, assumption, and strategy implication; otherwise they become plausible but unauditable prose.

### U4 Deliverable Studio: 报告/PPT/视频/策略稿可交付

Goal: generate usable deliverables from reviewed topic packages, with gates that prevent unsupported conclusions from becoming final.

P0:

- [ ] Add deliverable section editor: rewrite, expand, compress, regenerate, lock section, reviewer note.
- [ ] Add Reviewer pass for evidence quality, logic gaps, overclaiming, stale dependencies, and unresolved conflicts.
- [ ] Add finalization checklist for report, PPT outline, video script, and strategy task brief.
- [ ] Add deliverable-section lineage to claims/evidence, not only deliverable-level links.
- [ ] Add manual risk acceptance scoped to affected claim ids and sections.

P1:

- [ ] Add PPTX draft export from the PPT outline.
- [ ] Add HTML share site export under `wiki/共享/`.
- [ ] Add voice/video script timing estimates and slide-to-script alignment.

P2:

- [ ] Add visual evidence appendix and media asset manifest for screenshots/images/videos.

Acceptance:

- [ ] From a reviewed topic package, generate final report, 10-15 slide PPT outline, 5-10 minute video script, and strategy task brief.
- [ ] Final deliverables pass citation/staleness/review gates or record explicit, scoped risk acceptance.
- [ ] A regenerated section preserves citations or marks new unsupported text as pending validation.

Risks and tradeoffs:

- PPTX fidelity can wait until Markdown/PPT-outline content is reliable.
- A section editor is more important than fully automatic final prose because the user will iterate on conclusions.

### U5 Strategy Execution Bridge: 从研究到可回测策略

Goal: close the loop from research insight to implementation tickets, backtest import, risk review, and knowledge-base feedback.

P0:

- [ ] Add deliverable-section links to `backtest_results` and strategy feedback.
- [ ] Update topic package open questions, assumptions, and risks directly from failed or weakened backtests.
- [ ] Add configurable numerical thresholds for drawdown, turnover, capacity, paper-trading duration, out-of-sample length, and cost assumptions.
- [ ] Add allowlisted external strategy workspace export after file safety controls land.
- [ ] Weight project strategy-stage progress by ticket status and review status, not only record presence.

P1:

- [ ] Add backtest artifact parser for Markdown/JSON summaries from notebooks or strategy repos.
- [ ] Add strategy comparison page: hypothesis, expected edge, evidence strength, backtest outcome, next action.

P2:

- [ ] Add external tracker export after network/file allowlists and dry-run previews.

Acceptance:

- [ ] A final strategy task brief creates handoff + implementation tickets + backtest import path + review checklist.
- [ ] Failed backtests update linked risks/open questions and mark affected topic/deliverable nodes stale.
- [ ] A strategy cannot become paper/live-ready without passed checklist, artifacts, and configured threshold checks.

Risks and tradeoffs:

- Do not auto-write into strategy code repos until path allowlists and previews are in place.
- Backtest quality depends on outside data/code; the tool should track contracts, assumptions, and outcomes rather than pretending to validate every market claim itself.

### U6 Project Operating System: 项目制流水线

Goal: make the whole workflow operable as a project with stage gates, budgets, version history, diagnostics, and exports.

P0:

- [x] Add stale topic/deliverable dependency blockers to project research/deliver/strategy stages.
- [ ] Expand remaining stage blockers beyond source quality: attachments missing, unresolved conflicts, unreviewed evidence, citation coverage, failed-item rate, ticket status, review status.
- [ ] Add model/token/cost budget tracking by project, source, extraction run, deliverable, and rerun.
- [ ] Add version history for claims/topic packages/deliverables: created, edited, merged, split, contradicted, stale, superseded.
- [ ] Extend Vault Doctor to orphan files, duplicate pages, stale deliverables, missing lineage, dry-run rebuild, and repair plan output.
- [ ] Add full project package export: sources, chunks, claims, relations, topics, brief, deck, script, strategy, tickets, backtests, reviews, lineage.

P1:

- [ ] Add dashboard for cost, review backlog, unresolved conflicts, stale outputs, and next recommended action.
- [ ] Add project templates: forum research, paper reading, strategy research, course knowledge base.

P2:

- [ ] Add backup/restore and archive/purge workflow.

Acceptance:

- [x] Project stages show stale topic/deliverable blockers.
- [ ] A project can pause/resume across days and show every ready, blocked, stale, or awaiting-review state across all gates.
- [ ] Project export is self-contained enough for Codex/Claude/Obsidian review.
- [ ] Stage confirmations require evidence or scoped risk acceptance.

Risks and tradeoffs:

- More dashboard numbers are not useful unless each number maps to a concrete action or blocker.
- Version history should start coarse and durable before adding visual diffs.

### U7 Safety and Installability: 可以长期个人使用

Goal: make the local tool safe to run every day on a real machine with private forum content and model keys.

P0:

- [ ] Add one-command macOS start script/app wrapper with logs, port conflict handling, and data-dir selection.
- [ ] Add local file allowlist for PDF paths, vault paths, exports, external workspace writes, and destructive operations.
- [ ] Add token rotation, pairing reset, and extension health panel.
- [ ] Move API key storage to macOS Keychain or encrypted local config.
- [ ] Add backup/restore for SQLite + Vault.
- [ ] Add purge/export audit for sensitive data.

P1:

- [ ] Add structured local logs and diagnostics bundle with secrets redacted.
- [ ] Add versioned migrations and compatibility checks.

P2:

- [ ] Add optional local-only mode with all network model calls disabled.

Acceptance:

- [ ] Fresh install can start service, pair extension, choose vault, pass health checks, and ingest a sample source.
- [ ] Random web pages cannot call write APIs without pairing token and allowed origin.
- [ ] Destructive writes and external workspace writes require allowlisted paths and preview.

Risks and tradeoffs:

- Convenience should not bypass local write safety. The tool is handling private messages, forum content, and strategy ideas.

### U8 Golden Project E2E: 实战验收样板

Goal: keep one realistic project fixture that proves the whole system still works.

P0:

- [ ] Build golden dataset: 30 forum posts, 3 PDFs, screenshots/media, conflicting claims, mock LLM outputs, review decisions, deliverables, strategy handoff, tickets, backtest imports, reviews.
- [ ] Add one command/test flow: collect -> extract -> review -> topic package -> deliverables -> strategy handoff -> tickets -> backtest import -> knowledge update -> export.
- [ ] Gate releases on citation tracing, Ready Gate, lineage, stale marking, strategy handoff, backtest feedback, and Vault Doctor.

P1:

- [ ] Add performance/cost budget assertions for the golden flow.
- [x] Add browser smoke subset for extension-side capture.

P2:

- [ ] Add visual snapshot checks for side panel project/dashboard/deliverable states.

Acceptance:

- [ ] A full project can be paused, resumed, exported, and audited end to end.
- [ ] Every final conclusion, deliverable section, strategy ticket, and backtest outcome has traceable evidence or explicit risk acceptance.
- [ ] Regression tests fail when a final artifact loses citations or stale dependency detection.

Risks and tradeoffs:

- Golden fixtures must be small enough to run locally but realistic enough to catch regressions. Prefer 30 good fixtures over 300 noisy ones at this stage.

## 从当前 MVP 到实战工具的更新包

This is the practical upgrade ladder from the current MVP. Each package should ship with API tests, Vault output, and one human-readable acceptance example.

### V0.6.1 Research Package Hardening

Goal: turn a pile of extracted claims into a reliable research package.

P0:

- [ ] Add semantic clustering for claims across sources, not only exact duplicate detection.
- [ ] Add conflict matrix: supporting claims, counter claims, weak evidence, missing evidence, stale evidence.
- [ ] Add reasoning chain records: evidence -> judgment -> assumption -> conclusion -> strategy implication -> validation experiment.
- [ ] Add split/edit review for over-broad claims and evidence, with reviewer notes and rejection reason taxonomy.
- [ ] Add source/topic/entity incremental updates instead of always creating isolated pages.

Acceptance:

- [ ] 30 reviewed sources produce topic clusters, conflict matrix, top claims, open questions, and a traceable evidence table.
- [ ] A reviewer can merge duplicate claims, reject weak claims, and keep the canonical topic page updated.

### V0.7.1 Strategy Brief Strictness

Goal: make `strategy_task_brief` specific enough for implementation and backtest work.

P0:

- [x] Add field-level Ready Gate for strategy briefs: hypothesis, data contract, signal, backtest window, metrics, risk checks, implementation steps, and acceptance.
- [x] Block `final` strategy briefs when required fields are empty, placeholder-like, or too vague.
- [x] Validate that data contract names universe, frequency, fields, adjustment rules, missing-data policy, and data availability timing.
- [x] Validate that signal definition includes formula/logic, parameters, direction, rebalance cadence, and expected failure modes.
- [ ] Add a UI helper that highlights missing strategy fields before the user tries to finalize.

Acceptance:

- [x] A generic “待定义” strategy brief cannot become `final`.
- [x] A final strategy brief can be handed to an engineer without needing another research conversation to infer data/signal/metrics at the API/Vault handoff level.

### V0.8.0 Strategy Handoff Foundation

Goal: turn a final strategy task brief into a durable implementation handoff.

P0:

- [x] Add `strategy_handoffs` table/API/detail/list.
- [x] Generate Vault handoff Markdown under `wiki/strategies/` from a final `strategy_task_brief`.
- [x] Bind handoff to deliverable, source ids, topic package ids, claim ids, and evidence ids.
- [x] Add status tracking foundation: drafted, implementing, backtested, rejected, paper-ready, live-ready.
- [x] Include implementation tickets and strategy review checklist in the handoff.
- [x] Include strategy handoffs in export and `index.md`.
- [ ] Add allowlisted external workspace write/copy after local file safety controls land.

Acceptance:

- [x] A reviewed research package can produce a Vault strategy handoff with runnable implementation tasks.
- [ ] A chosen external strategy workspace can receive the handoff only after file allowlist approval.

### V0.8.1 Backtest Result Import

Goal: import real experiment results and connect them back to the original research.

P0:

- [x] Add `backtest_results` schema/API: handoff id, period, universe, benchmark, metrics, costs, slippage, drawdown, turnover, capacity, artifacts, and failure notes.
- [x] Add result artifact links for notebook, CSV, chart images, logs, and report Markdown.
- [x] Add hypothesis outcome: supported, weakened, falsified, needs-more-data.
- [x] Link result rows back to originating handoff, claims, assumptions, and risks.
- [x] Add backtest result Vault output, export coverage, and index coverage.
- [ ] Link result rows back to individual deliverable sections.
- [ ] Update topic package open questions directly from failed backtest results.

Acceptance:

- [x] A failed backtest updates linked risks instead of disappearing as an untracked experiment.
- [ ] A failed backtest updates the original topic package open questions.
- [x] A successful backtest cannot become paper-ready without attached metrics, costs, drawdown, and artifacts.

### V0.8.2 Strategy Risk Gate

Goal: prevent weak backtests from being promoted into paper/live workflow.

P0:

- [x] Add paper-ready gate: no data leakage, acceptable out-of-sample result, costs included, drawdown bounded, turnover feasible, liquidity/capacity checked.
- [x] Add live-ready gate: paper trading record, monitoring plan, kill switch, max exposure, operational failure plan, manual reviewer approval.
- [x] Add risk checklist history with reviewer, timestamp, note, pass/fail, and linked artifacts.
- [x] Prevent direct paper-ready/live-ready promotion from raw backtest result import; require a passed strategy review.
- [ ] Add configurable numerical thresholds for drawdown, turnover, capacity, paper-trading duration, and out-of-sample minimums.
- [x] Add UI workbench for paper/live review checklist completion.

Acceptance:

- [x] A strategy with missing cost model, leakage risk, or no out-of-sample period cannot become paper-ready.
- [x] A strategy without paper trading evidence cannot become live-ready.

### V0.8.3 Implementation Ticketing

Goal: split strategy handoff into executable engineering tasks.

P0:

- [x] Generate tickets for data ingestion, feature/signal code, portfolio construction, risk controls, backtest report, and monitoring.
- [x] Each ticket includes objective, inputs, outputs, acceptance criteria, linked claims/evidence, and owner/status.
- [x] Allow tickets to be exported as Markdown files and JSON through Vault/export.
- [x] Add ticket status update API and update handoff to `implementing`/`implemented` from ticket status.
- [x] Add UI workbench for ticket ownership/status editing.
- [ ] Export tickets to external trackers after file/network allowlists are available.

Acceptance:

- [x] An engineer can pick up one ticket and implement it without reading the whole research vault.
- [x] Ticket completion updates strategy handoff status.
- [ ] Ticket completion status weights project strategy-stage progress instead of count-only ticket presence.

### V1.0 Golden Project E2E

Goal: prove the entire workflow works on a fixed realistic project.

P0:

- [ ] Maintain a golden dataset: 30 forum posts, 3 PDFs, conflicting claims, mock LLM outputs, reviewed topic packages, deliverables, strategy handoff, strategy tickets, and backtest import fixture.
- [ ] Add one command/test flow: collect -> extract -> review -> topic package -> deliverables -> strategy handoff -> strategy tickets -> backtest import -> knowledge update -> export.
- [ ] Fail the release if citation tracing, Ready Gate, strategy handoff, or backtest feedback regress.

Acceptance:

- [ ] A full project can be paused, resumed, exported, and audited end to end.
- [ ] Every final conclusion, deliverable section, strategy ticket, and backtest outcome has a traceable source or explicit risk acceptance.

## V0.2A Source Vault Hardening

Goal: make one-off captures durable, searchable, inspectable, editable, and safe enough for daily use.

P0:

- [x] Add local companion service bound to `127.0.0.1:37621`.
- [x] Add SQLite schema for `projects`, `sources`, `documents`, `chunks`, `notes`, `agent_runs`, and `jobs`.
- [x] Add Markdown Vault bootstrap with `README.md`, `schema.md`, `CLAUDE.md`, `index.md`, `log.md`.
- [x] Add `/health`, `/v1/captures`, `/v1/sources`, `/v1/notes`, and `/v1/search`.
- [x] Save full captured source text into `原始资料/inbox/`.
- [x] Save analysis notes into `wiki/analyses/`.
- [x] Wire extension save/load flow to companion service with Chrome storage fallback.
- [x] Chunk long source text by paragraph for later map-reduce and citation work.
- [x] Add source detail UI: full text preview, metadata, raw file path, source summary path, chunks, and linked notes.
- [x] Add project selector and default Inbox project so every capture belongs to a project from day one.
- [x] Add project-scoped source views and cross-project isolation for sources, notes, jobs, knowledge records, export, and deliverables.
- [ ] Add editable title, tags, summary, status, project, and manual notes.
- [ ] Add delete, archive, and reprocess controls for sources and notes.
- [x] Fix extension export so Markdown/JSON export reads companion service data, not only Chrome local `knowledgeBase`.
- [x] Add Codex plugin/skill contract: `.codex-plugin/plugin.json`, `skills/qc-smart-reader/SKILL.md`, project contract reference, Vault `AGENTS.md`, and regression tests.
- [ ] Add migration/export from existing Chrome storage notes into Vault.

P1:

- [x] Add local search UI over sources, chunks, notes, and tags.
- [x] Add source status: `new`, `needs_review`, `read`, `extracted`, `reviewed`, `rejected`, `archived`.
- [x] Add source confidence fields: extraction quality, low-text flag, truncation flag, missing-fields list.
- [x] Add source aliases for same content from different URLs or versions, so dedupe does not lose source context.

Acceptance:

- [ ] Saving 50 pages/selections creates durable source and note records without data loss.
- [ ] Every note can be traced to original URL, source id, raw Markdown file, and chunks.
- [ ] Vault can be opened directly by Codex/Claude/Obsidian.
- [x] Exported Markdown/JSON contains companion service sources, notes, and deliverables.

## V0.2B Local Service Safety and Installability

Goal: make the local companion service reliable and safe for non-fragile personal use.

P0:

- [ ] Add one-command start script for macOS with clear logs and data-dir selection.
- [ ] Add service health panel in the extension: running, URL, data dir, Vault dir, DB path, version.
- [ ] Detect port conflicts and service-not-running states with actionable UI.
- [x] Add CORS origin allowlist and reject unknown browser origins.
- [x] Add pairing token between extension and local service.
- [x] Move API keys out of Chrome storage into companion service config or macOS Keychain.
- [x] Add model settings UI in the extension/service: provider, base URL, model, test key, last validation time, clear/revoke key.
- [ ] Add local file access allowlist for PDF paths, Vault paths, exports, and destructive writes.
- [x] Add explicit CSRF/DNS-rebinding defenses for localhost write APIs through token-gated `/v1/*` APIs and non-wildcard CORS.
- [ ] Add sensitive-data export/delete controls.

P1:

- [ ] Add structured error codes across APIs: validation, permission, duplicate, download failed, parse failed, too large, service unavailable.
- [ ] Add service logs endpoint or local log file path shown in UI.
- [ ] Add backup/restore for SQLite + Vault.

Acceptance:

- [ ] Fresh machine setup can install extension, start service, choose Vault location, and pass `/health`.
- [x] A random webpage cannot call write APIs without the extension pairing token.
- [ ] Service failures show clear remediation instead of silent Chrome fallback.

## V0.3 Website Collectors and Batch Queue

Goal: reliably collect Chinese and English knowledge-sharing sites with login-state reuse, preview, fixtures, retries, and no silent truncation.

P0:

- [x] Define in-page site profile routing with site inference, extraction, pagination hints, and normalized output.
- [x] Add QuantClass/BBS-style forum extraction for title, author, published time, floors/comments, code blocks, images, and next-page hints.
- [x] Add generic article extraction using readability-style root scoring.
- [x] Add profiles for Zhihu, WeChat article pages, Substack, Medium, HN, Reddit, arXiv, and GitHub Issues/Discussions.
- [x] Add batch URL queue in the extension with `pending/running/success/failed` states.
- [x] Process batch URLs through background Chrome tabs so current browser login state is reused without storing credentials.
- [x] Add companion job tracking endpoints.
- [ ] Split site profiles out of the monolithic `sidepanel.js` injected function into testable modules or fixtures.
- [x] Add standalone site profile module with fixtures for every supported profile.
- [ ] Finish migrating extension extraction from inline `sidepanel.js` profiles to the shared site profile registry where MV3 injection allows it.
- [x] Add basic fixture tests for every supported site profile before claiming stable support.
- [x] Add manual continuation for paginated threads.
- [x] Add list-page link extraction: collect all candidate thread/article links from a forum/list page.
- [x] Add capture plan and source discovery review queue: seed URL, source type, reason to collect, screen/reject reason, and approved-to-queue state.
- [x] Add no-silent-truncation policy: when comments/code/images/links are capped, store `truncated: true` and exact counts.
- [x] Add extraction quality gate: low-quality captures go to review instead of normal ingestion.
- [x] Add manual body selector fallback for pages where automatic extraction fails.
- [ ] Add browser-level extraction smoke tests comparing MV3 injected extraction with shared fixtures and real DOM failure modes.

P1:

- [x] Add extraction preview and quality score: profile, quality, image count, code block count, comment count, pagination count.
- [x] Add next-page discovery hints.
- [x] Preserve code block language when detectable, indentation, and source block context.
- [x] Save image URL, alt text, and surrounding paragraph in capture payload.
- [x] Preserve attachments with URL, filename, floor/context, and download status.
- [x] Add duplicate URL normalization for tracking parameters and canonical URLs.
- [x] Add retry/backoff for slow pages and failed background tabs.

Acceptance:

- [ ] 100 URLs can be imported, deduplicated, processed, retried, paused, and resumed.
- [ ] QuantClass-like posts preserve main post, comments, code, floor metadata, images, attachments, and source links.
- [x] English site fixtures cover Substack, HN, Reddit, arXiv, and GitHub Issues/Discussions title/body/comment/code/image/attachment basics.
- [ ] English sites support Substack, HN, Reddit, arXiv, and GitHub Issues/Discussions at usable quality in the live extension flow.
- [ ] Fixture suite catches DOM extraction regressions before manual use.

## V0.3B Durable Task Runner

Goal: make batch collection survive browser/service restarts and become auditable.

P0:

- [x] Add `job_items` table with URL/path, project, attempt count, status, error, source id, started_at, completed_at.
- [x] Add `job_events` table and `GET /v1/jobs/:id/events`.
- [x] Add `POST /v1/jobs/:id/items/:item_id/status` for per-item running/success/failed updates.
- [x] Update extension batch processing to write job item status back to the companion service.
- [x] Add stuck-running recovery via `POST /v1/jobs/:id/recover`.
- [x] Add retry failed and retry one item endpoints.
- [x] Add extension UI to restore the latest service-side read job into the local queue.
- [x] Add one-click retry for failed/running local queue items.
- [x] Add pause, resume, cancel, and clear completed.
- [x] Make companion service the source of truth for queued work; extension becomes executor/client when service is available.
- [x] Add lease protocol: `claim next item`, executor id, lease expiry, heartbeat, idempotent completion, and cancelled/paused enforcement.
- [x] Switch extension batch executor to consume `/v1/jobs/:id/claim-next` as the source of truth instead of iterating a local pending snapshot.
- [x] Add executable sidepanel VM smoke for service-owned claim-next, heartbeat, success writeback, pause, and cancel.
- [x] Add browser smoke fixture for service-owned dispatch and heartbeat in the live extension flow.
- [x] Add browser smoke fixture for pause, cancel, and resume in the live extension flow.
- [x] Add job pipeline hooks: capture -> quality gate -> review queue/extract-pending routing, with each phase recorded as item events.
- [x] Add per-item failure categories: auth required, page timeout, extraction empty, parse failed, duplicate, service error.

P1:

- [x] Add concurrency limit controls.
- [x] Add estimated remaining time and last heartbeat.
- [x] Add resumable checkpoints for multi-page threads.

Acceptance:

- [ ] A 100 URL job can be interrupted at item 30 by killing Chrome or the service, then resumed without stuck `running` items.
  Service restart and sidepanel VM extension restart are covered by offline fixtures; live Chrome/browser restart smoke remains open.
- [x] Duplicate, failed, skipped, successful, and success-but-needs-review items are counted correctly in service-side fixtures.
- [x] Failure rows are actionable and one-click retryable.

## V0.4 PDF and Paper Reading

Goal: read PDF reports and papers with page-level references and explicit failure modes.

P0:

- [x] Add PDF parser in the companion service using an equivalent parser to PDF.js (`pypdf` worker).
- [x] Support local PDF path ingestion.
- [x] Support web PDF URL ingestion.
- [x] Extract text, page number, title, author, and basic PDF metadata.
- [x] Chunk by page and preserve `page_start`, `page_end`, and `chunk_id`.
- [x] Mark low-text PDFs for OCR/manual review.
- [x] Save PDFs and webpages into the unified `sources/documents/chunks` model.
- [x] Copy original PDFs into `原始资料/papers/`.
- [ ] Extract abstract, table of contents, references, and figure/table captions when text layout allows it.
- [ ] Add paper-reading template: research question, method, data, experiments, conclusion, reproducibility, transferable hypotheses.
- [ ] Add PDF source detail view with pages/chunks and original file link.
- [ ] Add scan/image-only OCR queue placeholder.
- [ ] Add OCR/visual review queue fields: page, image asset, OCR confidence, manual correction status, and second-pass review status.

P1:

- [ ] Add PDF fixture tests: normal 20-40 page text PDF, two-column paper, scanned PDF, encrypted PDF, over-limit PDF, table-heavy PDF, formula-heavy PDF, fake PDF URL returning HTML.
- [ ] Add page-header/footer cleanup and noise detection.
- [ ] Save formulas/tables/images as referenced assets for later visual-model work.

Acceptance:

- [ ] A 20-40 page paper can be summarized with page citations.
- [ ] Key report claims link back to PDF page and source excerpt.
- [ ] Failure modes are explicit: no text layer, download failed, permission denied, file too large, encrypted PDF, fake PDF.

## V0.5 LLM Runtime, Retrieval, and Citation Enforcement

Goal: move AI work from one-shot extension calls into a service-side, auditable, reusable analysis runtime.

P0:

- [x] Move model calls from extension to companion service.
- [x] Add provider/model config in service: OpenAI-compatible, Anthropic, DeepSeek/OpenRouter-compatible endpoints.
- [x] Add secure API key storage via service config or macOS Keychain.
- [x] Add `agent_runs` execution records for mock structured extraction: prompt version, model, input source/chunks, output, and status.
- [x] Extend `agent_runs` for provider calls with token estimate, usage/cost/latency, repair call count, and error metadata.
- [x] Add provider-backed single-source structured extraction with `mock`, `provider`, and `auto` modes.
- [x] Add structured output schema prompt and normalization for entities, claims, evidence, relations, assumptions, risks, strategy ideas, and tasks.
- [x] Add JSON repair/retry for invalid single-source structured extraction outputs.
- [x] Reject or mark as `待验证` any structured claim without valid `source_id + chunk_id + quote`.
- [x] Add provider extraction prompt-injection handling: source text is explicitly treated as untrusted data that cannot override extraction rules.
- [ ] Extend structured output schemas and validation beyond source extraction to summary, tags, project RAG answers, and deliverables.
- [ ] Add provider fixture coverage for timeout, HTTP error, empty output, extra fields, over-token input, Anthropic response shape, and partial failure status.
- [ ] Add map-reduce for long pages/PDFs: chunk summaries first, global synthesis second.
- [ ] Add project RAG search with citation-required answers.
- [x] Add provider usage/cost/latency capture when providers return usage metadata.

P1:

- [ ] Add rate limiting, retry/backoff, timeout, and cancellation for model calls.
- [ ] Add token/cost budget per job and per project.
- [x] Add mock-model mode for deterministic structured extraction tests.

Acceptance:

- [ ] Long documents do not rely on a single huge prompt.
- [x] A single-source structured claim cannot enter as `extracted` unless it has valid `source_id + chunk_id + quote`; otherwise it becomes `pending_validation`.
- [ ] Model failures are retryable and auditable from `agent_runs`.

## V0.6 Multi-Document Reasoning and Knowledge Maintenance

Goal: implement the uncle's core requirement: AI identifies relationships, value, and reasoning chains across many sources.

P0:

- [x] Add tables/schema: `entities`, `claims`, `evidence`, `relations`, `assumptions`, `risks`, `strategy_ideas`, `tasks`.
- [x] Add `POST /v1/knowledge/records` and `GET /v1/knowledge/records`.
- [x] Store structured records with source/chunk/quote citation validation; unsupported claims become `pending_validation`.
- [x] Extract structured records from each source automatically with deterministic service-side mock runtime.
- [x] Wire extension Knowledge tab to trigger automatic structured extraction for the current source and display recent records.
- [x] Add source-level review queue: `new/extracted` sources can be accepted as `reviewed` or rejected.
- [x] Replace/augment mock extraction with provider-backed service-side LLM runtime.
- [x] Add canonical topic package model foundation: canonical claim, duplicate claims, supporting evidence, contradicting evidence, open questions, evidence strength, review status, and stale status.
- [x] Wire extension Knowledge tab to create topic packages from selected claims.
- [ ] Cluster duplicate themes, entities, repeated claims, and conflicting claims.
- [ ] Generate reasoning chains: evidence -> judgment -> assumption -> conclusion -> strategy implication -> validation experiment.
- [ ] Add research brief per project: research question, target output, inclusion/exclusion rubric, evidence strength threshold, and review policy.
- [x] Add claim review foundation: accept, reject, mark pending validation, reviewer note, evidence count display, and service-side guard against accepting unsupported claims.
- [x] Add over-broad claim split foundation on top of the implemented claim/evidence review/merge workbench.
- [x] Add claim history event/diff foundation in the claim/evidence review workbench.
- [ ] Add full rejection reason taxonomy and advanced claim history replay UI.
- [x] Add quote verification in review foundation: accepted claims must have at least one validated `source_id + chunk_id + quote` evidence row; unsupported claims remain blocked from `reviewed`.
- [x] Add review-time citation recheck for edited/stale source text and evidence-level review status.
- [x] Add universal lineage/dependency records and rebuild/query/export support.
- [x] Add stale marking from lineage when a reviewed source/claim/evidence is rejected, archived, superseded, or otherwise invalidated; dependent topic packages and deliverables are marked stale.
- [x] Add source version diff and synchronous re-extraction ledger foundation.
- [ ] Extend stale marking to full source edit diffs, async re-extraction, chunk regeneration, explicit rerun queues, and claim/evidence-level stale records.
- [x] Add `vault doctor` diagnostic API/UI: validate DB-to-Markdown paths, Markdown frontmatter/id presence, source/chunk/evidence quotes, claim events, and topic/deliverable/strategy/backtest/ticket backrefs.
- [ ] Extend `vault doctor` to detect orphan files, duplicate topic/entity pages, stale deliverables, and provide dry-run rebuild/repair output.
- [x] Write entity pages under `wiki/entities/`, structured import summaries under `wiki/analyses/`, and update `index.md`/`log.md`.
- [x] Write topic package pages under `wiki/topics/` and include them in export/index.
- [ ] Incrementally update existing `wiki/sources`, `wiki/topics`, and other long-lived pages from reviewed records instead of creating new pages every time.
- [ ] Prefer updating existing wiki pages over creating isolated duplicate pages.

P1:

- [ ] Replace simulated multi-agent output with independent Extractor, Teacher, Domain Expert, Engineer, Reviewer, and Synthesizer runs after single-source structured extraction is stable.
- [ ] Add evidence matrix, conflict matrix, and open-question table.

P2:

- [ ] Add relationship graph and timeline views.

Acceptance:

- [ ] 100 posts/articles generate topic clusters, entity table, top claims, citations, conflicts, and open questions.
- [ ] New sources update old wiki pages instead of creating unlimited isolated pages.
- [ ] Long-lived conclusions remain traceable to primary sources.

## V0.7 Deliverable Workbench

Goal: turn reviewed knowledge packages into usable outputs: report, PPT outline, video script, and strategy task brief.

P0:

- [x] Add `POST /v1/deliverables`.
- [x] Add `GET /v1/deliverables` and `GET /v1/deliverables/:id`.
- [x] Add deliverable table and file output under `wiki/deliverables/`.
- [x] Add deterministic templates for research report, PPT outline, video script, and strategy task brief.
- [x] Report template: background, core conclusions, evidence matrix, reasoning chain, counter-evidence, risks, next steps.
- [x] PPT outline template: 10-15 slides, each with title, bullets, speaker notes, citations.
- [x] Video script template: opening, sections, examples, transitions, closing actions.
- [x] Strategy task brief template: hypothesis, input data, signal/factor, backtest window, metrics, risk checks, implementation steps, acceptance.
- [x] Enforce citations for provided key deliverable claims through the same strict `source_id + chunk_id + quote` validator.
- [x] Mark uncited or invalid-citation claims as `待验证` in generated Markdown.
- [x] Add deliverable Ready Gate foundation: citation coverage, unsupported claims, unresolved conflicts, source review status, and stale dependency checks.
- [x] Extend deliverable Ready Gate to linked topic packages: draft/needs_review/conflicted/stale topic packages block `final`.
- [x] Add deliverable status machine foundation: `draft -> reviewed -> final`; generated deliverables default to `draft`, not `ready`.
- [x] Add evidence appendix export for every final deliverable.
- [x] Prevent deliverables from being marked `final` until Ready Gate passes or unresolved items are explicitly accepted as risk.
- [x] Store manual risk acceptance reason, reviewer, and timestamp when a deliverable bypasses a gate.
- [ ] Store affected claim ids for manual risk acceptance once claim-level review is available.
- [x] Connect deterministic deliverable creation to the extension UI.
- [x] Allow service-side deliverable creation from reviewed `topic_package_ids`, expanding topic claims/evidence into strict citations.
- [x] Add extension-side topic package selector for deliverable creation.
- [ ] Connect deliverable creation to service-side LLM runtime.

P1:

- [ ] Add section editor: rewrite, expand, compress, re-review.
- [ ] Add Reviewer pass for evidence quality, logic gaps, and overclaiming.
- [x] Export Markdown through Vault file output and detail API.
- [ ] Export JSON.

P2:

- [ ] Export PPTX draft.
- [ ] Export project package zip.

Acceptance:

- [x] A topic package can generate a research report, 10-15 slide outline, 5-10 minute video script, and strategy task brief through the service API.
- [x] Every key conclusion links to source evidence or is explicitly marked pending validation in deterministic deliverables.
- [ ] Strategy task brief is specific enough for implementation/backtest work.

## V0.8 Strategy Implementation Bridge

Goal: close the loop from research insight to a strategy that can be implemented, backtested, reviewed, and fed back into the knowledge base.

P0:

- [x] Add Vault strategy handoff export: write hypothesis, data contract, signal definition, backtest TODO, risk checks, and acceptance criteria under `wiki/strategies/`.
- [ ] Add allowlisted external strategy project export: copy/write the handoff into a chosen strategy workspace after file safety controls are available.
- [x] Add strategy status tracking foundation: drafted, implementing, backtested, rejected, paper-ready, live-ready.
- [x] Add backtest result import schema: period, universe, metrics, costs, drawdown, turnover, failure notes, and artifacts.
- [x] Add extension UI for importing backtest results from a strategy handoff.
- [x] Link each strategy handoff back to originating deliverable, topic packages, sources, claims, and evidence.
- [x] Link each strategy result back to originating claims, evidence, assumptions, risks, and deliverable sections.
- [x] Mark strategy hypotheses as supported, weakened, falsified, or needs more data after backtest review.

P1:

- [x] Generate implementation ticket foundation for data ingestion, factor/signal code, portfolio construction, risk controls, and report generation.
- [x] Add strategy review checklist foundation: data leakage, overfitting, liquidity, regime dependence, transaction costs, and operational risk.
- [x] Add editable implementation tickets with owner/status/export through local API and Vault/package export.
- [x] Add UI workbench for implementation ticket editing.
- [x] Add UI workbench for paper/live strategy review checklist completion.

Acceptance:

- [x] A reviewed research package can produce a Vault strategy handoff with runnable implementation tasks.
- [ ] A reviewed research package can produce an allowlisted external strategy workspace handoff.
- [x] Backtest results can be imported and linked back to original claims, assumptions, and risks.
- [x] A failed strategy improves the knowledge base with a linked risk instead of disappearing as an untracked experiment.
- [ ] A failed strategy directly updates topic package open questions and assumption statuses.

## V1.0 Project Research Pipeline

Goal: reproduce the full workflow: collect 100+ sources -> screen -> deep research -> deliverables -> strategy handoff.

P0:

- [x] Add project dashboard with five stages: collect, screen, research, deliver, strategy.
- [x] Move project/inbox basics earlier, then expand here into full stage gates.
- [x] Add stage exit criteria and human confirmation buttons.
- [x] Add project brief/rubric: research question, target output, inclusion/exclusion rules, evidence-strength threshold, review policy, and strategy applicability scope.
- [x] Add capture plan/source discovery gate: seed URL, source type, reason to collect, priority, screen/reject reason, and approved-to-queue state.
- [x] Add source extraction quality blockers to the screen stage: low quality, low-text, truncation, auth-required, pagination-needed, and missing metadata block non-rejected/non-archived sources.
- [x] Add stale dependency blockers for topic packages and deliverables.
- [ ] Expand remaining stage blockers beyond source quality: attachments not downloaded, unresolved conflicts, unreviewed evidence, citation coverage, failed-item rate, ticket status, and review status.
- [ ] Finish remaining claim/evidence review gate dependencies: split/edit/reject taxonomy, evidence preview refinements, and batch actions beyond the implemented merge foundation.
- [x] Add universal lineage/dependency records: source/chunk -> evidence -> claim -> topic -> deliverable -> handoff -> ticket/backtest/review.
- [x] Add stale dependency gating from lineage into project stages and topic-backed deliverable Ready Gates.
- [ ] Extend stale gating to deliverable sections, backtest feedback, async rerun queues, and direct non-topic citations.
- [x] Add `vault doctor` as a V1 diagnostic gate for DB/Markdown/frontmatter/backref consistency.
- [ ] Extend `vault doctor` release gate to orphan files, duplicate pages, stale deliverables, and dry-run rebuild.
- [ ] Track model choice, token budget, estimated cost, actual cost, failures, reruns, and reviewed outputs.
- [ ] Export full project package: sources, chunks, claims, relations, topics, brief, deck, script, strategy.
- [ ] Add full end-to-end acceptance dataset: 30 forum posts + 3 PDFs + conflicting viewpoints.
- [ ] Add Golden Project E2E harness: static site fixtures, 30 posts, 3 PDFs, conflicting claims, mock LLM outputs, review gates, deliverables, strategy package, and citation tracing.

P1:

- [ ] Add version history for claim changes caused by new evidence.
- [ ] Add incremental monitoring for selected sites, authors, and keywords.

P2:

- [ ] Generate shareable HTML pages under `wiki/共享/`.

Acceptance:

- [ ] A user can import 100+ Chinese/English sources and run the whole project flow.
- [ ] The final package is portable and auditable.
- [ ] Every stage can pause, resume, and rerun without depending on one browser tab.

## Required Fixture/Test Matrix

Implemented automated tests:

- [x] Companion service capture fixture: writes SQLite source/document/chunk rows, Vault files, index entry, search result, and duplicate detection.
- [x] Companion service source detail fixture: returns raw text, documents, chunks, linked notes, and Markdown paths.
- [x] Companion service source status fixture: default `new`, update to `reviewed`, filter by status, and update source summary Markdown.
- [x] Companion service auth fixture: `/health` is open, `/v1/*` requires pairing token, Chrome extension Origin is allowed, unknown Origin is rejected.
- [x] Companion service model fixture: service-side model settings store API key without exposing it, proxy OpenAI-compatible chat, and write provider `agent_runs`.
- [x] Companion service project fixture: project creation, scoped captures, source list, search, notes, and export.
- [x] Companion service project dashboard fixture: five-stage metrics, source screening readiness, stage confirmation, and project export dashboard coverage.
- [x] Companion service project brief/capture plan fixture: complete rubric blocks collect stage until saved, approved plans enqueue read jobs, job success marks plans captured, and export includes brief/plans.
- [x] Companion service source quality gate fixture: low-quality reviewed sources block the screen stage until rejected or archived.
- [x] Companion service vault doctor fixture: valid project passes, report Markdown is written, deleted Markdown is detected as a missing-file error.
- [x] Companion service mock extraction fixture advances `new/read` sources to `extracted` for source-level review.
- [x] Companion service provider extraction fixture: fake OpenAI-compatible endpoint, invalid JSON repair retry, strict source/chunk/quote evidence, pending source-only/fake-quote/cross-source/missing-evidence claims, max-claim truncation, and no API key leak into `agent_runs`.
- [x] Companion service job fixture: URL dedupe, lease claim-next, heartbeat, executor mismatch rejection, pause dispatch blocking, expired lease reclaim, stuck-running recovery, retry one, retry failed, clear completed, cancel, and event log.
- [x] Companion service PDF fixture: generated two-page text-layer PDF, PDF ingest, page chunks, low-text check, and original PDF copy.
- [x] Companion service export fixture: sources, notes, and deliverables are included in JSON and Markdown exports.
- [x] Companion service deliverable Ready Gate fixture: draft default, unsupported/unreviewed gate failures, final blocked until gate passes, and final allowed after reviewed source plus cited claims.
- [x] Companion service structured knowledge fixture: validates source/chunk/quote evidence, marks unsupported claims pending validation, writes entities/claims/relations/risks/tasks, and updates Vault files.
- [x] Companion service claim review fixture: extraction cannot directly create reviewed claims, unsupported claims cannot be accepted, reviewer notes persist, and final deliverables are blocked until linked claims are reviewed.
- [x] Companion service claim/evidence recheck fixture: changed chunk text makes prior evidence `citation_valid=false`, blocks claim/evidence review, downgrades stale reviewed evidence, and allows repair with a new valid quote.
- [x] Companion service source-version stale fixture: same canonical URL with new content marks old reviewed source lineage topic packages stale.
- [x] Companion service claim review queue filter fixture: source, topic package, evidence strength, and quote validity filters return the expected claims.
- [x] Companion service claim merge fixture: duplicate claim evidence and linked risk/task records move to the canonical claim, merged claims archive with reviewer metadata, and dependent topic packages become stale.
- [x] Companion service claim split fixture: over-broad source claim archives, split children clone evidence as pending validation, claim events export/doctor cleanly, and dependent topic packages become stale.
- [x] Companion service claim history fixture: review and failed revalidation events are queryable through `GET /v1/claims/:id/events` and embedded in claim detail payloads.
- [x] Companion service topic package fixture: reviewed claims from multiple sources generate a topic package with duplicate claim ids, supporting/counter evidence ids, open questions, Vault `wiki/topics/` output, index entry, and export coverage.
- [x] Companion service topic deliverable fixture: reviewed topic packages can generate final report/deck/video/strategy deliverables, while draft topic packages are blocked from final.
- [x] Companion service deliverable evidence appendix fixture: every final deliverable includes a centralized source/chunk/quote appendix.
- [x] Companion service strategy handoff fixture: final strategy briefs generate Vault handoffs with data contract, signal definition, backtest plan, risk checks, implementation tasks, traceability, index, and export coverage.
- [x] Companion service strategy ticket fixture: handoffs generate idempotent data/signal/backtest/risk/report/monitoring tickets with owner/status, Markdown, export/index coverage, validation, and handoff status progression.
- [x] Companion service backtest feedback fixture: imported backtest outcomes link back to handoff/claims/risks, enforce paper/live promotion rules, and create linked risks for failed or weakened results.
- [x] Companion service strategy review fixture: paper-ready/live-ready reviews require checklist evidence, record reviewer history, and gate handoff/backtest status promotion.
- [x] Extension strategy ticket static fixture: Deliver tab exposes handoff selection, ticket generation, owner/status controls, and strategy ticket API wiring.
- [x] Extension strategy feedback static fixture: Deliver tab exposes backtest import, paper/live review checklist controls, and backtest/review API wiring.
- [x] Extension project dashboard static fixture: Settings tab exposes project stage reviewer/note/dashboard controls and dashboard/confirm API wiring.
- [x] Extension project brief/capture plan static fixture: Settings tab exposes rubric fields, candidate source controls, approval buttons, and brief/capture-plan API wiring.
- [x] QuantClass/BBS single-page HTML fixture: title, author/time, floors, comments, code block, image, attachment, next page, and quality score.
- [x] QuantClass/BBS generated 105-floor fixture: verifies 100+ floor preservation and next-page detection.
- [x] Browser site profile bundle fixture: Chromium loads `extractors/browser_site_profiles.js` against QuantClass HTML and matches shared registry core thread structure.
- [x] Live extension batch capture smoke: Chromium loads the unpacked extension, opens the sidepanel batch tab, captures a QuantClass fixture through a background tab, uses service-owned `claim-next`, and persists source detail, pagination checkpoint, job events, chunks, and attachment ledger through the companion service.
- [x] Live extension heartbeat smoke: delayed background-tab capture emits `item_heartbeat` into the companion service job event ledger before success writeback.
- [x] Live extension pause/resume/cancel smoke: delayed background-tab capture pauses a service-owned job, resumes pending work, cancels another job, and verifies unclaimed items stay canceled with late success writeback ignored.
- [x] Live extension close/restart smoke: Chromium closes while a service-owned item is running, a fresh extension profile restores the same companion job, recovers the stale lease, retries, resumes, and finishes pending work.
- [x] QuantClass multi-page browser smoke: standalone registry, browser DOM bundle, and live extension batch capture preserve relative next links, continuation comment floors, code, images, attachments, and pagination checkpoint state.
- [x] Extension UI smoke fixture: read current page -> trigger structured extraction -> render claims/evidence/page-or-floor metadata -> refresh records after side panel reload.
- [x] Extension review queue fixture: more than 100 reviewed/rejected sources must not hide older `new/extracted` sources.
- [x] Extension mutation fixture: successful status/extraction writes remain successful even if a later list refresh fails.
- [x] Extension source binding fixture: changed title/URL/text invalidates old `sourceId` and re-captures before extraction/deliverables.
- [x] Extension capture plan fixture: discovered/seeded sources must be approved before entering the 100 URL queue.
- [x] Extension quality gate fixture: low-quality, truncated, login-wall, paginated, or attachment-incomplete captures visibly surface as screen-stage blockers in the live side panel.

Site fixtures:

- [x] QuantClass/BBS: basic single-page post with floors, code, image, attachment, and next-page hint.
- [x] QuantClass/BBS: generated 100+ floor fixture.
- [x] QuantClass/BBS: multi-page post with relative next link, continuation comments, nested quote, code, image, attachment, and live extension smoke.
- [ ] QuantClass/BBS degraded cases: long code, login-only content, folded content, deleted floors.
- [x] Articles: Zhihu, WeChat article, Substack, Medium; include normal code/image/formula-style cases.
- [ ] Articles: Zhihu, WeChat article, Substack, Medium; include login wall, folded content, and other degraded/edge cases.
- [ ] Threads: HN, Reddit, GitHub Issues/Discussions; include nested comments, collapsed comments, code, quotes, pagination/more-load.
- [x] GitHub Issues: dedicated profile and basic fixture.
- [ ] arXiv: abstract page, PDF link, version changes, PDF download failure.
- [ ] Negative web: 404, 403, timeout, non-HTML, redirect loop, CAPTCHA, empty body, huge page.

PDF fixtures:

- [x] Basic generated text-layer PDF with page-level chunk assertions.
- [ ] Text-layer 20-40 page paper.
- [ ] Two-column paper.
- [ ] Scanned/image-only PDF.
- [ ] Encrypted PDF.
- [ ] Over-limit PDF.
- [ ] Table-heavy, formula-heavy, and figure-caption-heavy PDFs.
- [ ] Fake PDF URL returning HTML.

Batch fixtures:

- [x] Basic service-side job lifecycle fixture with duplicate, failed, recovered, retried, cleared, and canceled items.
- [x] Basic service-side job pipeline fixture: success item records capture, quality gate, review queue, extract-pending events, attachment-missing quality blockers, and job-level quality gate counts.
- [x] Static and VM sidepanel batch dispatch fixtures cover claim-next, heartbeat, pause/cancel/resume wiring, ETA, last-heartbeat UI, concurrency limit, service-owned success path, and batch pagination checkpoint recovery/enqueue.
- [x] Sidepanel batch progress fixture displays service-reported `needs_review` quality blockers and top quality reasons.
- [x] Service-side job checkpoint fixture: `result_json.pagination_checkpoint` persists and emits an `item_checkpoint` audit event.
- [x] Service-side 100 URL job fixture with 70 success, 10 duplicate input rows deduped, 10 failure, 10 slow/stuck recovered, retry-failed, pause/resume, and claim-next completion.
- [x] Kill service at item 30, restart, recover stuck running items, retry, resume, and finish a 100 URL job with the same SQLite/Vault data dir.
- [x] Sidepanel VM extension restart fixture: empty local queue restores a 100 URL service job, recovers stuck rows, retries failed rows, resumes, and completes via claim-next.
- [x] Browser DOM profile bundle smoke: QuantClass fixture validates browser-injected profile extraction for title, author/time, floors, code, image, attachment, and next page.
- [x] Live extension capture smoke: sidepanel batch queue captures a QuantClass fixture from a real Chromium extension context and verifies service-owned job events, pagination checkpoint, chunks, and attachment ledger in the local companion service.
- [x] Live extension heartbeat smoke: slow background-tab capture verifies a real `item_heartbeat` event in the local companion service.
- [x] Live extension pause/resume/cancel smoke: real Chromium sidepanel buttons drive companion `job_paused`, `job_resumed`, `job_canceled`, and `item_status_ignored` events.
- [x] Live extension close/restart smoke: real Chromium closes mid-job, a clean extension profile restores from companion service, and the same job records `job_recover`, `job_retry_failed`, and `job_resumed` before succeeding.
- [x] Live extension multi-page smoke: sidepanel batch queue captures page 1 and page 2 of a QuantClass fixture and verifies continuation comments, source detail, pagination checkpoint, chunks, and attachment ledger.
- [x] Browser smoke: close Chrome/extension mid-job, restart, resume.

Vault fixtures:

- [x] Basic capture fixture validates SQLite rows, Markdown files, and index/search linkage.
- [ ] Validate SQLite rows, Markdown files, frontmatter, index/log updates, source-note-chunk references, and Obsidian/Codex-readable links.
- [x] Vault doctor fixture: detect missing DB-linked Markdown files and validate source/document/note/capture-plan backrefs.
- [ ] Vault doctor fixture: detect broken frontmatter, missing topic/deliverable backrefs, orphan files, duplicate topic/entity pages, and stale deliverables.

AI/citation fixtures:

- [ ] Mock LLM returns no citations.
- [ ] Mock LLM returns fake citations.
- [ ] Mock LLM cites wrong chunk.
- [ ] Page contains prompt injection text.
- [ ] Deliverable contains unsupported claims.
- [x] Deliverable fixture marks unsupported claims as `待验证`.
- [ ] Project budget fixture records model, prompt/schema version, token estimate/actual, cost estimate/actual, latency, failure category, and rerun reason.

## End-to-End Practical Acceptance

- [ ] Start with a fresh temporary Vault and companion service.
- [ ] Run offline fixtures first; do not rely on live websites for regression tests.
- [ ] Import 100 mixed URLs and 5 PDFs.
- [ ] Interrupt service and browser once mid-run, then resume.
- [ ] Review 15 samples manually: 5 forum, 5 article/thread, 5 PDF.
- [ ] Generate topics, entities, claims, evidence, conflicts, risks, and strategy tasks from a multi-source project.
- [ ] Generate report, PPT outline, video script, and strategy task brief.
- [ ] Confirm every final conclusion has source evidence or `待验证`.
- [ ] Run Golden Project E2E harness and fail the release if capture, review, citation, deliverable, or strategy package checks regress.
- [ ] Move/export the Vault and project package; confirm Codex/Claude/Obsidian can read it independently.
