# QC Smart Reader Project Contract

## Local Components

- Chrome extension: `manifest.json`, `sidepanel.html`, `sidepanel.js`, `sidepanel.css`, `background.js`.
- Shared extractors: `extractors/site_profiles.mjs`, `extractors/quantclass_bbs.mjs`.
- Companion service: `companion_service/server.py`.
- PDF worker: `companion_service/pdf_extract_worker.py`.
- Work orders and acceptance state: `WORK_ORDERS.md`.

## Companion Service API Surface

- `GET /health`
- `POST /v1/captures`
- `GET /v1/sources`
- `GET /v1/sources/:id`
- `POST /v1/sources/:id/status`
- `POST /v1/sources/:id/extract-knowledge`
- `POST /v1/jobs/read`
- `GET /v1/jobs/:id`
- `GET /v1/jobs/:id/events`
- `POST /v1/jobs/:id/claim-next`
- `POST /v1/jobs/:id/items/:item_id/heartbeat`
- `POST /v1/jobs/:id/items/:item_id/status`
- `POST /v1/pdfs/extract`
- `POST /v1/deliverables`
- `POST /v1/topic-packages`
- `POST /v1/strategy-handoffs`
- `POST /v1/strategy-tickets`
- `POST /v1/backtest-results`
- `POST /v1/strategy-reviews`
- `GET /v1/vault/doctor`
- `POST /v1/lineage/rebuild`

Protected endpoints require `x-qc-pairing-token`.

## Vault Contract

Expected Vault files:

- `README.md`
- `schema.md`
- `CLAUDE.md`
- `AGENTS.md`
- `index.md`
- `log.md`

Expected Vault directories:

- `原始资料/inbox`
- `原始资料/articles`
- `原始资料/papers`
- `原始资料/threads`
- `原始资料/videos`
- `原始资料/assets`
- `wiki/sources`
- `wiki/topics`
- `wiki/entities`
- `wiki/analyses`
- `wiki/deliverables`
- `wiki/strategies`
- `wiki/共享`

## Review Gates

The screen stage is blocked by unreviewed sources and by quality flags on non-rejected, non-archived sources:

- `low_text`
- `truncated`
- `auth_required`
- `pagination_needed`
- `attachment_missing`
- `missing_title`
- `missing_url`
- `missing_fields`
- extraction quality below 50

Final deliverables must not treat unsupported claims as reviewed evidence. Unsupported claims stay pending validation.

## Batch Reliability Evidence

A reliable batch claim needs evidence from job items and events:

- `item_claimed`
- `item_heartbeat`
- `item_status`
- `item_capture`
- `item_quality_gate`
- `item_review_queue` or `item_extract`
- `item_checkpoint` when pagination remains
- `job_recover`
- `job_retry_failed`
- `job_resumed`

`failure_category_counts` should classify auth, timeout, empty extraction, parse failure, duplicate, service/network errors, pagination needed, attachment missing, and stuck running recovery.

## Deliverable Evidence

Research reports, PPT outlines, video scripts, and strategy task briefs should preserve:

- `source_id`
- `chunk_id`
- quotes
- URL, floor, or page metadata when available
- reviewed/pending/rejected status
- risk and open-question lists

Strategy handoffs additionally require data contract, signal definition, backtest plan, risk checks, implementation tasks, monitoring, and traceability.
