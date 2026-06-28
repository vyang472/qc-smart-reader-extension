---
name: qc-smart-reader
description: Operate and audit the local QC Smart Reader project. Use when Codex is asked to work on the QC Smart Reader Chrome extension, companion service, Markdown Vault, forum/PDF/article ingestion, source review gates, citation-backed deliverables, or the research workflow that turns 100+ sources into reports, PPT outlines, video scripts, and strategy task briefs.
---

# QC Smart Reader

Use this skill to work inside the local QC Smart Reader project as an operator and auditor, not as a generic web scraper.

## First Checks

1. Locate the project root. The expected repo is `qc-smart-reader-extension`.
2. Read `WORK_ORDERS.md`, `README.md`, and `companion_service/README.md` before changing behavior.
3. If the task touches the data model, API contracts, Vault layout, or acceptance gates, read `references/project-contract.md`.
4. Treat the companion service SQLite database and Markdown Vault as the source of truth for project state.

## Companion Service

Start the local service from the project root:

```bash
python3 companion_service/server.py --host 127.0.0.1 --port 37621
```

Use `--data-dir <path>` for isolated tests or a project-specific Vault. The service writes the pairing token to:

```text
<data-dir>/state/pairing_token.txt
```

Use `/health` to verify the service, then include `x-qc-pairing-token` for protected endpoints.

## Research Workflow

Follow this order unless the user asks for a narrower task:

1. Collect sources through capture plans, current-page extraction, PDF ingest, or read jobs.
2. Review quality gates before extraction. Do not treat `needs_review`, `pagination_needed`, `attachment_missing`, truncation, login walls, or low-text captures as final evidence.
3. Extract structured knowledge only when source/chunk evidence can be cited.
4. Build topic packages from reviewed claims and evidence.
5. Generate report, PPT outline, video script, and strategy task brief only from reviewed sources or clearly mark unsupported claims as pending validation.
6. For strategy handoff work, require data contract, signal definition, backtest plan, risk checks, implementation tasks, and traceability.

## Audit Rules

- Every durable conclusion must cite `source_id`, `chunk_id`, and quote; use page, floor, or URL when available.
- Prefer updating existing Vault pages over creating duplicate topic/entity pages.
- Never rewrite raw files in `原始资料/` during cleanup.
- Keep `index.md` and `log.md` current after durable ingest or analysis work.
- Treat browser/extension restart, service restart, failed retry, and quality-gate event ledgers as required evidence for batch reliability claims.

## Verification

For code changes, run the smallest relevant tests first, then the full checks before handoff:

```bash
python3 -m unittest discover -s tests -v
node --test tests/test_quantclass_extractor.mjs tests/test_site_profiles.mjs tests/test_sidepanel_strategy_tickets.mjs tests/test_sidepanel_project_dashboard.mjs tests/test_sidepanel_batch_dispatch.mjs
node --check sidepanel.js
python3 -m py_compile companion_service/server.py companion_service/pdf_extract_worker.py
```

Do not mark the workflow complete until live or fixture evidence covers the requirement being claimed.
