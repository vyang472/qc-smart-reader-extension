# QC Smart Reader Companion Service

Local service for the practical QC Smart Reader workflow. It keeps long-lived data out of Chrome storage and writes a Markdown Vault plus SQLite index on disk.

## Run

```bash
cd qc-smart-reader-extension
python3 companion_service/server.py
```

Default URL:

```text
http://127.0.0.1:37621
```

Default data location:

```text
~/Documents/QC Smart Reader Vault
```

Override the data directory:

```bash
python3 companion_service/server.py --data-dir "/path/to/my-vault-data"
```

## Test

Run the offline integration tests from the extension root:

```bash
cd qc-smart-reader-extension
python3 -m unittest discover -s tests -v
```

The tests start a temporary local service and cover source capture/Vault writes/search, job lifecycle controls, and basic text-layer PDF ingest.

## Endpoints

- `GET /health`
- `POST /v1/captures`
- `GET /v1/sources`
- `GET /v1/sources/:id`
- `POST /v1/notes`
- `GET /v1/notes`
- `GET /v1/notes/:id`
- `POST /v1/search`
- `POST /v1/deliverables`
- `GET /v1/deliverables`
- `GET /v1/deliverables/:id`
- `POST /v1/knowledge/records`
- `GET /v1/knowledge/records`
- `POST /v1/sources/:id/extract-knowledge`
- `POST /v1/sources/:id/learning-pack`
- `GET /v1/learning/items`
- `POST /v1/claims/:id/review`
- `GET /v1/export?format=json|markdown`
- `POST /v1/pdfs/extract`
- `POST /v1/youtube/transcripts`
- `POST /v1/jobs/read`
- `GET /v1/jobs`
- `GET /v1/jobs/:id`
- `GET /v1/jobs/:id/events`
- `POST /v1/jobs/:id/status`
- `POST /v1/jobs/:id/recover`
- `POST /v1/jobs/:id/retry-failed`
- `POST /v1/jobs/:id/pause`
- `POST /v1/jobs/:id/resume`
- `POST /v1/jobs/:id/cancel`
- `POST /v1/jobs/:id/clear-completed`
- `POST /v1/jobs/:id/items/:item_id/status`
- `POST /v1/jobs/:id/items/:item_id/retry`

## Batch Jobs

Create a read job:

```json
{
  "items": [
    {
      "id": "extension-local-id",
      "url": "https://example.com/thread/1",
      "title": "Optional title",
      "kind": "url"
    }
  ],
  "source": "extension-batch"
}
```

The service stores one `job_items` row per unique URL and returns the item ids. The extension is still the browser executor, but it should report item state transitions:

```json
{
  "status": "running"
}
```

```json
{
  "status": "success",
  "title": "Extracted title",
  "source_id": "src_abc123",
  "result": {
    "text_length": 1234,
    "next_pages": ["https://example.com/thread/1?page=2"],
    "pagination_checkpoint": {
      "status": "pagination_needed",
      "source_id": "src_abc123",
      "source_url": "https://example.com/thread/1",
      "source_title": "Extracted title",
      "job_id": "job_abc123",
      "job_item_id": "jit_abc123",
      "next_pages": ["https://example.com/thread/1?page=2"],
      "next_page_count": 1,
      "captured_at": "2026-06-28T01:02:03Z"
    }
  }
}
```

```json
{
  "status": "failed",
  "error": "page timeout"
}
```

Recover stale `running` rows after a browser/service restart:

```json
{
  "max_age_seconds": 300
}
```

Retry all failed/skipped items:

```text
POST /v1/jobs/:id/retry-failed
```

Retry one item:

```text
POST /v1/jobs/:id/items/:item_id/retry
```

Pause or resume a job:

```text
POST /v1/jobs/:id/pause
POST /v1/jobs/:id/resume
```

Cancel remaining active items:

```text
POST /v1/jobs/:id/cancel
```

Hide completed items from active queue recovery while keeping audit rows:

```text
POST /v1/jobs/:id/clear-completed
```

Current task-runner scope:

- Durable job, item, and event records are supported.
- Item attempts, status, source id, errors, started time, and completed time are persisted.
- Recovering stale `running` items and retrying failed items are supported.
- Pause, resume, cancel, and clear completed are supported.
- Service-owned `claim-next`, lease heartbeat, richer failure categories including pagination and missing attachments, extension-side ETA/last-heartbeat progress, configurable 1-3 extension concurrency, multi-page pagination checkpoints in job item `result_json` plus `item_checkpoint` events, `quality_gate_counts` for success-but-needs-review captures, and service-restart recovery fixtures for 100 URL jobs are supported; browser-level smoke recovery fixtures remain future work.

## PDF Ingest

Local PDF path:

```json
{
  "path": "/Users/me/Documents/paper.pdf",
  "title": "Optional title"
}
```

Remote PDF URL:

```json
{
  "url": "https://example.com/report.pdf",
  "title": "Optional title"
}
```

The service extracts text with the bundled Python worker when available, stores the source in SQLite, writes Markdown into the Vault, creates page-scoped chunks with `page_start` and `page_end`, and copies the original PDF to `vault/原始资料/papers/`.

Current parser scope:

- Text-layer PDFs are supported.
- Low-text PDFs are marked with `pdf.low_text: true`.
- Scanned PDFs, two-column cleanup, table/figure extraction, formula extraction, and OCR are future work.

## YouTube Transcript Ingest

Manual transcript text or timestamped segments can be ingested without audio transcription:

```json
{
  "url": "https://www.youtube.com/watch?v=abc123",
  "title": "Optional title",
  "segments": [
    {"start": 0, "duration": 8, "text": "First caption."},
    {"start": 8, "duration": 12, "text": "Second caption."}
  ]
}
```

The service stores the transcript as a `video/youtube` source, chunks by timestamp, and preserves timestamp metadata for citations. Audio transcription is intentionally out of scope for this version.

## Deliverables

Create a deterministic Markdown deliverable:

```json
{
  "kind": "report",
  "title": "Topic Research Report",
  "source_ids": ["src_abc123"],
  "claims": [
    {
      "text": "Every final claim needs source evidence.",
      "citations": [
        {
          "source_id": "src_abc123",
          "chunk_id": "chk_abc123_0000",
          "quote": "Every final claim needs source evidence."
        }
      ]
    },
    {
      "text": "This still needs validation."
    }
  ]
}
```

Supported `kind` values:

- `report`
- `ppt_outline`
- `video_script`
- `strategy_task_brief`

The service writes Markdown to `vault/wiki/deliverables/`, records a row in SQLite, and marks any claim without a valid source/chunk citation as `待验证`. This is a deterministic template layer; model-driven synthesis, editing, PPTX export, and reviewer passes are future work.

## Structured Knowledge

Write reviewed or model-extracted records:

```json
{
  "source_id": "src_abc123",
  "entities": [
    {"name": "Factor rotation", "kind": "strategy"}
  ],
  "claims": [
    {
      "id": "claim-local-id",
      "text": "Durable conclusions need source evidence.",
      "evidence": [
        {
          "source_id": "src_abc123",
          "chunk_id": "chk_abc123_0000",
          "quote": "Durable conclusions need source evidence."
        }
      ]
    }
  ],
  "relations": [
    {"subject": "Factor rotation", "predicate": "requires", "object": "Risk checks", "claim_id": "claim-local-id"}
  ],
  "risks": [
    {"text": "Overfitting the rotation rule.", "severity": "high"}
  ],
  "tasks": [
    {"title": "Backtest factor rotation", "acceptance": "Report source-linked metrics."}
  ]
}
```

The service validates source/chunk/quote citations. Claims with valid evidence are stored as `extracted`; claims without valid evidence are stored as `pending_validation`. Entity pages are written under `wiki/entities/`, and structured import summaries are written under `wiki/analyses/`.

Review a claim after checking evidence:

```text
POST /v1/claims/:id/review
```

```json
{
  "status": "reviewed",
  "reviewer": "vincent",
  "review_note": "Quote and source checked."
}
```

Automatically extract draft records from an existing source with the deterministic mock extractor:

```text
POST /v1/sources/:id/extract-knowledge
```

```json
{
  "mode": "mock",
  "max_claims": 5
}
```

The mock extractor reads source chunks, creates source-linked claims and evidence quotes, infers simple entities/risks/tasks, writes the same structured records, and records an `agent_runs` row with `agent_id: mock_structured_extractor`. Provider-backed extraction is available through `mode: "provider"` or `mode: "auto"` when model settings are configured.

## Learning Pack

Create a learning pack for a source:

```text
POST /v1/sources/:id/learning-pack
```

The output includes retrieval questions, Anki candidates, a Feynman prompt, confusion checkpoints, and 1/3/7/15-day review items. Items are stored in SQLite and written to `vault/wiki/learning/`.

## Export

Export the companion service state as one package:

```text
GET /v1/export?format=json
GET /v1/export?format=markdown
```

The export package includes source summaries, notes, structured knowledge records, and deliverables from SQLite/Vault. The Chrome extension export buttons use this endpoint first, and only fall back to Chrome local storage when the companion service is unavailable.

## Vault Layout

```text
vault/
  README.md
  schema.md
  CLAUDE.md
  index.md
  log.md
  原始资料/
    inbox/
    articles/
    papers/
    threads/
    assets/
  wiki/
    overview/
    sources/
    topics/
    entities/
    analyses/
    deliverables/
    共享/
```
