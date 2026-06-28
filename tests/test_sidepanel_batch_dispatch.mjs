import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

async function projectFile(name) {
  return readFile(new URL(`../${name}`, import.meta.url), "utf8");
}

function createMockNode(id = "") {
  return {
    id,
    children: [],
    className: "",
    dataset: {},
    disabled: false,
    innerHTML: "",
    textContent: "",
    value: "",
    classList: {
      add() {},
      remove() {}
    },
    addEventListener() {},
    appendChild(child) {
      this.children.push(child);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

async function createSidepanelHarness({ fetchHandler, extractionResult } = {}) {
  const js = (await projectFile("sidepanel.js")).replace("\ninit();\n", "\n");
  const nodes = new Map();
  const storageState = {};
  const intervalCallbacks = [];
  let nextTimerId = 1;
  let nextUuid = 1;
  const fetchCalls = [];

  const context = {
    console: {
      ...console,
      warn() {}
    },
    Date,
    Error,
    JSON,
    Map,
    Number,
    Promise,
    RegExp,
    Set,
    String,
    URL,
    URLSearchParams,
    Array,
    Boolean,
    Math,
    Object,
    crypto: {
      randomUUID: () => `uuid-${nextUuid++}`
    },
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, createMockNode(id));
        return nodes.get(id);
      },
      createElement(tagName) {
        return createMockNode(tagName);
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      }
    },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            if (Array.isArray(keys)) {
              return Object.fromEntries(keys.map((key) => [key, storageState[key]]));
            }
            if (typeof keys === "string") return { [keys]: storageState[keys] };
            if (keys && typeof keys === "object") return { ...keys, ...storageState };
            return { ...storageState };
          },
          async set(values) {
            Object.assign(storageState, values);
          }
        },
        session: {
          async get() {
            return {};
          },
          async remove() {}
        }
      },
      tabs: {
        async create({ url }) {
          return { id: 42, url, title: "Fixture Page", windowId: 7 };
        },
        async get() {
          return { status: "complete" };
        },
        async remove() {}
      },
      scripting: {
        async executeScript() {
          const override = typeof extractionResult === "function" ? await extractionResult() : extractionResult || {};
          return [{
            result: {
              title: "Fixture Page",
              url: "https://example.com/a",
              canonicalUrl: "https://example.com/a",
              text: "This fixture page has enough body text to be saved by the companion service.",
              markdown: "# Fixture Page\n\nThis fixture page has enough body text to be saved.",
              kind: "page",
              site: "example",
              blocks: [],
              images: [],
              attachments: [],
              links: [],
              nextPages: [],
              stats: { quality: 90 },
              ...override
            }
          }];
        }
      },
      downloads: {
        async download() {}
      }
    },
    async fetch(url, options = {}) {
      const parsed = new URL(url);
      const call = {
        path: parsed.pathname,
        search: parsed.search,
        searchParams: Object.fromEntries(parsed.searchParams.entries()),
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null,
        headers: options.headers || {}
      };
      fetchCalls.push(call);
      const data = await fetchHandler?.(call);
      return {
        ok: data?.ok !== false,
        status: data?.status || 200,
        async text() {
          return JSON.stringify(data || { ok: true });
        }
      };
    },
    setTimeout(callback, _ms, ...args) {
      const timerId = nextTimerId++;
      Promise.resolve().then(() => callback(...args));
      return timerId;
    },
    clearTimeout() {},
    setInterval(callback, _ms, ...args) {
      const timerId = nextTimerId++;
      intervalCallbacks.push({ timerId, callback, args });
      Promise.resolve().then(() => callback(...args));
      return timerId;
    },
    clearInterval() {}
  };

  createContext(context);
  runInContext(js, context);

  return {
    context,
    fetchCalls,
    nodes,
    storageState,
    intervalCallbacks,
    run(expression) {
      return runInContext(expression, context);
    },
    stateSnapshot() {
      return JSON.parse(runInContext("JSON.stringify({ queue: state.batchQueue, metrics: state.batchMetrics, running: state.batchRunning, paused: state.batchPaused, cancelRequested: state.batchCancelRequested })", context));
    },
    setState(values) {
      runInContext(`Object.assign(state, ${JSON.stringify(values)})`, context);
    }
  };
}

test("sidepanel wires service-owned batch dispatch and heartbeat controls", async () => {
  const html = await projectFile("sidepanel.html");
  const js = await projectFile("sidepanel.js");

  for (const id of ["processBatchBtn", "restoreBatchBtn", "pauseBatchBtn", "cancelBatchBtn", "batchProgress", "batchConcurrencyInput"]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }

  assert.match(js, /BATCH_MAX_CONCURRENCY = 3/);
  assert.match(js, /DEFAULT_BATCH_HEARTBEAT_INTERVAL_MS = 30000/);
  assert.match(js, /function normalizeBatchConcurrency/);
  assert.match(js, /function batchHeartbeatIntervalMs/);
  assert.match(js, /state\.settings\?\.batchHeartbeatIntervalMs/);
  assert.match(js, /function batchConcurrencyLimit/);
  assert.match(js, /function updateBatchConcurrency/);
  assert.match(js, /function normalizeBatchQualityGateCounts/);
  assert.match(js, /function updateBatchQualityGateFromJob/);
  assert.match(js, /function formatBatchQualityReasonCounts/);
  assert.match(js, /function normalizeBatchPaginationCheckpoint/);
  assert.match(js, /function buildBatchPaginationCheckpoint/);
  assert.match(js, /function createBatchItemNextPageCapturePlans/);
  assert.match(js, /data-batch-next-pages-id/);
  assert.match(js, /pagination_checkpoint: paginationCheckpoint/);
  assert.match(js, /updateBatchJobItem[\s\S]*mergeJobIntoBatchQueue\(response\.job\)/);
  assert.match(js, /batchConcurrencyInput"\)\.addEventListener\("change", updateBatchConcurrency\)/);
  assert.match(js, /processBatchQueue[\s\S]*prepareServiceBackedBatch\(processable\)/);
  assert.match(js, /serviceReady[\s\S]*processBatchQueueFromService\(processable, concurrency\)/);
  assert.match(js, /processBatchQueue[\s\S]*processBatchQueueLocally\(processable, concurrency\)/);
  assert.match(js, /prepareServiceBackedBatch[\s\S]*\/recover/);
  assert.match(js, /prepareServiceBackedBatch[\s\S]*\/retry-failed/);
  assert.match(js, /prepareServiceBackedBatch[\s\S]*\/resume/);
  assert.match(js, /processBatchQueueFromService[\s\S]*while \(!state\.batchCancelRequested && !state\.batchPaused\)/);
  assert.match(js, /claimNextBatchJobItem[\s\S]*\/claim-next/);
  assert.match(js, /claimNextBatchJobItem[\s\S]*executor_id: batchExecutorId\(\)/);
  assert.match(js, /claimNextBatchJobItem[\s\S]*lease_seconds: 180/);
  assert.match(js, /processClaimedBatchItem[\s\S]*startBatchItemHeartbeat\(item\)/);
  assert.match(js, /processClaimedBatchItem[\s\S]*clearInterval\(heartbeat\)/);
  assert.match(js, /startBatchItemHeartbeat[\s\S]*\/heartbeat/);
  assert.match(js, /startBatchItemHeartbeat[\s\S]*recordBatchHeartbeat\(item, heartbeatAt\)/);
  assert.match(js, /startBatchItemHeartbeat[\s\S]*batchHeartbeatIntervalMs\(\)/);
  assert.match(js, /serviceItemStatusToLocal[\s\S]*status === "canceled"[\s\S]*return "canceled"/);
  assert.match(js, /pauseBatchQueue[\s\S]*state\.batchPaused = true/);
  assert.match(js, /pauseBatchQueue[\s\S]*pauseBatchJobForItems\(state\.batchQueue\)/);
  assert.match(js, /cancelBatchQueue[\s\S]*state\.batchCancelRequested = true/);
  assert.match(js, /cancelBatchQueue[\s\S]*postBatchJobActionForItems\(state\.batchQueue, "cancel"\)/);
  assert.match(js, /id === "pauseBatchBtn" \|\| id === "cancelBatchBtn"[\s\S]*node\.disabled = !state\.batchRunning/);
});

test("sidepanel renders batch progress, ETA, and item timing metadata", async () => {
  const js = await projectFile("sidepanel.js");
  const css = await projectFile("sidepanel.css");

  assert.match(js, /batchMetrics: \{/);
  assert.match(js, /chrome\.storage\.local\.get\(\["batchQueue", "batchMetrics", "batchConcurrency"\]\)/);
  assert.match(js, /batchConcurrency: state\.batchConcurrency/);
  for (const fn of [
    "normalizeBatchMetrics",
    "startBatchRun",
    "finishBatchRun",
    "markBatchItemRunning",
    "markBatchItemCompleted",
    "recordBatchHeartbeat",
    "renderBatchProgress",
    "batchProgressSnapshot",
    "formatDurationMs"
  ]) {
    assert.match(js, new RegExp(`function ${fn}`), `missing ${fn}`);
  }
  assert.match(js, /startedAt: ""/);
  assert.match(js, /completedAt: ""/);
  assert.match(js, /lastHeartbeatAt: ""/);
  assert.match(js, /concurrency: 1/);
  assert.match(js, /qualityGateCounts: \{/);
  assert.match(js, /并发 \$\{snapshot\.concurrency\}/);
  assert.match(js, /需审查 \$\{snapshot\.qualityNeedsReview\}/);
  assert.match(js, /质量原因 \$\{qualityReasonSummary\}/);
  assert.match(js, /预计剩余 \$\{formatDurationMs\(snapshot\.etaMs\)\}/);
  assert.match(js, /最后心跳 \$\{formatClockTime\(snapshot\.lastHeartbeatAt\)\}/);
  assert.match(js, /开始：\$\{escapeHtml\(formatClockTime\(item\.startedAt\)\)\}/);
  assert.match(js, /结束：\$\{escapeHtml\(formatClockTime\(item\.completedAt\)\)\}/);
  assert.match(js, /心跳：\$\{escapeHtml\(formatClockTime\(item\.lastHeartbeatAt\)\)\}/);
  assert.match(css, /\.batch-progress/);
  assert.match(css, /\.batch-progress:empty/);
  assert.match(css, /\.compact-field/);
});

test("sidepanel review queue filters statuses so historical reviewed sources cannot hide pending review", async () => {
  const oldReviewedSources = Array.from({ length: 130 }, (_, index) => ({
    id: `reviewed-${index}`,
    title: `Reviewed ${index}`,
    status: "reviewed",
    created_at: `2026-06-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`
  }));
  const sourcesByStatus = {
    needs_review: [{
      id: "needs-review-1",
      title: "Needs Review Source",
      status: "needs_review",
      kind: "thread",
      site: "quantclass",
      captured_at: "2026-06-28T01:00:00.000Z",
      text_length: 1200,
      quality_flags: { low_text: true }
    }],
    new: [{
      id: "new-1",
      title: "New Source",
      status: "new",
      kind: "article",
      site: "substack",
      captured_at: "2026-06-28T03:00:00.000Z",
      text_length: 2400,
      quality_flags: {}
    }],
    extracted: [{
      id: "extracted-1",
      title: "Extracted Source",
      status: "extracted",
      kind: "paper",
      site: "arxiv",
      captured_at: "2026-06-28T02:00:00.000Z",
      text_length: 3600,
      quality_flags: {}
    }]
  };
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path !== "/v1/sources") return { ok: true };
      const status = call.searchParams.status || "";
      if (!status) {
        return { ok: true, sources: oldReviewedSources };
      }
      return { ok: true, sources: sourcesByStatus[status] || [] };
    }
  });

  harness.setState({
    settings: { serviceUrl: "http://service.local", projectId: "project-1", pairingToken: "pair-token" }
  });

  await harness.context.loadReviewQueue();

  const sourceCalls = harness.fetchCalls.filter((call) => call.path === "/v1/sources");
  assert.deepEqual(
    sourceCalls.map((call) => call.searchParams.status).sort(),
    ["extracted", "needs_review", "new"]
  );
  assert.ok(sourceCalls.every((call) => call.searchParams.project_id === "project-1"));
  assert.ok(sourceCalls.every((call) => call.searchParams.limit === "100"));
  assert.ok(!sourceCalls.some((call) => !call.searchParams.status), "review queue made an unfiltered source request");

  const list = harness.nodes.get("reviewQueueList");
  assert.equal(list.children.length, 3);
  assert.match(list.children[0].innerHTML, /New Source/);
  assert.match(list.children[1].innerHTML, /Extracted Source/);
  assert.match(list.children[2].innerHTML, /Needs Review Source/);
  assert.doesNotMatch(list.children.map((child) => child.innerHTML).join("\n"), /Reviewed 0/);
  assert.equal(harness.nodes.get("reviewQueueStatus").textContent, "3 条待审来源。");
});

test("sidepanel claim evidence workbench renders context and submits review actions", async () => {
  const html = await projectFile("sidepanel.html");
  const js = await projectFile("sidepanel.js");
  for (const id of [
    "claimReviewStatusFilter",
    "claimReviewQuoteFilter",
    "claimReviewStrengthFilter",
    "claimReviewSourceFilter",
    "claimReviewTopicFilter",
    "claimReviewerInput",
    "claimReviewNoteInput",
    "claimRejectionReasonInput",
    "claimSplitTextInput",
	    "refreshClaimReviewQueueBtn",
	    "batchAcceptClaimsBtn",
	    "batchPendingClaimsBtn",
	    "batchRejectClaimsBtn",
    "mergeSelectedClaimsBtn",
    "splitSelectedClaimBtn",
	    "claimReviewList"
	  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
		  assert.match(js, /\/v1\/claims\/review-queue/);
		  assert.match(js, /\/v1\/claims\/review-batch/);
  assert.match(js, /\/v1\/claims\/merge/);
  assert.match(js, /\/v1\/claims\/split/);
		  assert.match(js, /\/v1\/evidence\/\$\{encodeURIComponent\(evidenceId\)\}\/review/);

  const workbenchClaim = {
    id: "claim-1",
    project_id: "project-1",
    source_id: "source-1",
    text: "Original claim",
    status: "extracted",
    confidence: 0.82,
    reasoning_chain: "source quote -> claim",
    evidence_count: 1,
    valid_evidence_count: 1,
	    evidence: [{
	      id: "ev-1",
	      claim_id: "claim-1",
      status: "pending_validation",
      citation_valid: true,
      strength: "supporting",
      quote: "source quote supports the claim",
      source_id: "source-1",
      source_title: "Source A",
      source_url: "https://example.com/source-a",
      chunk_id: "chunk-1",
      chunk_context: "Before context. source quote supports the claim. After context.",
	      page: "4",
	      floor: "12"
	    }],
    events: [{
      id: "clev-1",
      claim_id: "claim-1",
      event_type: "review",
      reviewer: "reviewer-a",
      note: "tightened wording",
      related_claim_ids: ["claim-2"],
      metadata: {
        previous_status: "pending_validation",
        next_status: "reviewed",
        text_changed: true,
        previous_text: "Old claim wording",
        next_text: "Original claim"
      },
      created_at: "2026-06-28T10:00:00Z"
    }]
	  };
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/claims/review-queue") {
        return { ok: true, claims: [workbenchClaim], count: 1, statuses: ["extracted"] };
      }
      if (call.path === "/v1/knowledge/records") {
        return { ok: true, claims: [], evidence: [], entities: [], relations: [], assumptions: [], risks: [], strategy_ideas: [], tasks: [] };
      }
      if (call.path === "/v1/claims/claim-1/review" && call.method === "POST") {
        return { ok: true, claim: { ...workbenchClaim, text: call.body.text || workbenchClaim.text, status: call.body.status } };
      }
	      if (call.path === "/v1/claims/review-batch" && call.method === "POST") {
	        return { ok: true, claims: [{ ...workbenchClaim, status: call.body.status }], errors: [], success_count: 1, error_count: 0 };
	      }
      if (call.path === "/v1/claims/merge" && call.method === "POST") {
        return {
          ok: true,
          target_claim_id: call.body.target_claim_id,
          merged_claim_ids: call.body.claim_ids.slice(1),
          moved_evidence_count: 2,
          target_claim: { ...workbenchClaim, id: call.body.target_claim_id },
          merged_claims: []
        };
      }
      if (call.path === "/v1/claims/split" && call.method === "POST") {
        return {
          ok: true,
          source_claim_id: call.body.claim_id,
          split_claim_ids: ["claim-split-a", "claim-split-b"],
          cloned_evidence_count: 2,
          source_claim: { ...workbenchClaim, status: "archived" },
          split_claims: call.body.splits.map((split, index) => ({ ...workbenchClaim, id: `claim-split-${index}`, text: split.text }))
        };
      }
      if (call.path === "/v1/evidence/ev-1/review" && call.method === "POST") {
        return { ok: true, evidence: { ...workbenchClaim.evidence[0], status: call.body.status } };
      }
      return { ok: true };
    }
  });

  harness.setState({
    settings: { serviceUrl: "http://service.local", projectId: "project-1", pairingToken: "pair-token" }
  });
  harness.nodes.get("claimReviewStatusFilter") ?? harness.context.document.getElementById("claimReviewStatusFilter");
  harness.nodes.get("claimReviewQuoteFilter") ?? harness.context.document.getElementById("claimReviewQuoteFilter");
  harness.nodes.get("claimReviewStrengthFilter") ?? harness.context.document.getElementById("claimReviewStrengthFilter");
  harness.nodes.get("claimReviewSourceFilter") ?? harness.context.document.getElementById("claimReviewSourceFilter");
  harness.nodes.get("claimReviewTopicFilter") ?? harness.context.document.getElementById("claimReviewTopicFilter");
  harness.nodes.get("claimReviewerInput") ?? harness.context.document.getElementById("claimReviewerInput");
  harness.nodes.get("claimReviewNoteInput") ?? harness.context.document.getElementById("claimReviewNoteInput");
  harness.nodes.get("claimRejectionReasonInput") ?? harness.context.document.getElementById("claimRejectionReasonInput");
  harness.nodes.get("claimSplitTextInput") ?? harness.context.document.getElementById("claimSplitTextInput");
  harness.nodes.get("claimReviewStatusFilter").value = "extracted,pending_validation";
  harness.nodes.get("claimReviewQuoteFilter").value = "invalid";
  harness.nodes.get("claimReviewStrengthFilter").value = "supporting";
  harness.nodes.get("claimReviewSourceFilter").value = "source-1";
  harness.nodes.get("claimReviewTopicFilter").value = "topic-1";
  harness.nodes.get("claimReviewerInput").value = "vincent";
		  harness.nodes.get("claimReviewNoteInput").value = "checked in workbench";
		  harness.nodes.get("claimRejectionReasonInput").value = "quote mismatch";
  harness.nodes.get("claimSplitTextInput").value = "Split claim A\nSplit claim B";
  let selectedClaimIds = ["claim-1"];
	  harness.context.document.querySelectorAll = (selector) => {
    if (selector === "[data-claim-edit-text]") {
      return [{ dataset: { claimEditText: "claim-1" }, value: "Edited claim" }];
	    }
	    if (selector === "[data-claim-workbench-select]:checked") {
      return selectedClaimIds.map((value) => ({ value }));
	    }
    return [];
  };

  await harness.context.loadClaimReviewQueue();

  const queueCall = harness.fetchCalls.find((call) => call.path === "/v1/claims/review-queue");
  assert.equal(queueCall.searchParams.project_id, "project-1");
  assert.equal(queueCall.searchParams.status, "extracted,pending_validation");
  assert.equal(queueCall.searchParams.quote_validity, "invalid");
  assert.equal(queueCall.searchParams.evidence_strength, "supporting");
  assert.equal(queueCall.searchParams.source_id, "source-1");
  assert.equal(queueCall.searchParams.topic_package_id, "topic-1");
  const list = harness.nodes.get("claimReviewList");
  assert.equal(list.children.length, 1);
  assert.match(list.children[0].innerHTML, /Original claim/);
  assert.match(list.children[0].innerHTML, /source quote supports the claim/);
	  assert.match(list.children[0].innerHTML, /Before context/);
	  assert.match(list.children[0].innerHTML, /Source A/);
	  assert.match(list.children[0].innerHTML, /quote valid/);
  assert.match(list.children[0].innerHTML, /Claim history/);
  assert.match(list.children[0].innerHTML, /pending_validation -&gt; reviewed/);
  assert.match(list.children[0].innerHTML, /Old claim wording/);

  await harness.context.reviewClaimFromWorkbench("claim-1", "reviewed");
  const claimReviewCall = harness.fetchCalls.find((call) => call.path === "/v1/claims/claim-1/review");
  assert.equal(claimReviewCall.body.status, "reviewed");
  assert.equal(claimReviewCall.body.text, "Edited claim");
  assert.equal(claimReviewCall.body.reviewer, "vincent");
  assert.equal(claimReviewCall.body.review_note, "checked in workbench");
  assert.equal(claimReviewCall.body.rejection_reason, undefined);

  await harness.context.reviewSelectedClaims("rejected");
  const batchCall = harness.fetchCalls.find((call) => call.path === "/v1/claims/review-batch");
	  assert.deepEqual(batchCall.body.claim_ids, ["claim-1"]);
	  assert.equal(batchCall.body.status, "rejected");
	  assert.equal(batchCall.body.rejection_reason, "quote mismatch");

  selectedClaimIds = ["claim-1", "claim-2"];
  await harness.context.mergeSelectedClaims();
  const mergeCall = harness.fetchCalls.find((call) => call.path === "/v1/claims/merge");
  assert.equal(mergeCall.body.target_claim_id, "claim-1");
  assert.deepEqual(mergeCall.body.claim_ids, ["claim-1", "claim-2"]);
  assert.equal(mergeCall.body.reviewer, "vincent");
  assert.equal(mergeCall.body.review_note, "checked in workbench");
  assert.equal(mergeCall.body.reason, "quote mismatch");

  selectedClaimIds = ["claim-1"];
  await harness.context.splitSelectedClaim();
  const splitCall = harness.fetchCalls.find((call) => call.path === "/v1/claims/split");
  assert.equal(splitCall.body.claim_id, "claim-1");
  assert.deepEqual(splitCall.body.splits, [{ text: "Split claim A" }, { text: "Split claim B" }]);
  assert.equal(splitCall.body.reviewer, "vincent");
  assert.equal(splitCall.body.review_note, "checked in workbench");
  assert.equal(splitCall.body.reason, "quote mismatch");
  assert.equal(splitCall.body.clone_evidence, true);

  await harness.context.reviewEvidenceFromWorkbench("ev-1", "rejected");
  const evidenceCall = harness.fetchCalls.find((call) => call.path === "/v1/evidence/ev-1/review");
  assert.equal(evidenceCall.body.status, "rejected");
  assert.equal(evidenceCall.body.reviewer, "vincent");
  assert.equal(evidenceCall.body.rejection_reason, "quote mismatch");
});

test("sidepanel keeps source status mutation successful when post-write refresh fails", async () => {
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/sources/source-1/status" && call.method === "POST") {
        return {
          ok: true,
          source: {
            id: "source-1",
            status: call.body.status,
            markdown_path: "vault/wiki/sources/source-1.md"
          }
        };
      }
      if (call.path === "/v1/sources") {
        return { ok: false, status: 503, error: "source list unavailable after mutation" };
      }
      return { ok: true };
    }
  });

  harness.setState({
    settings: { serviceUrl: "http://service.local", projectId: "project-1", pairingToken: "pair-token" },
    source: {
      sourceId: "source-1",
      sourceStatus: "new",
      title: "Current Source",
      url: "https://example.com/current",
      kind: "page",
      text: "This current source has enough text to keep it bound while updating status."
    }
  });

  await harness.context.updateSourceStatus("source-1", "reviewed");

  const statusCall = harness.fetchCalls.find((call) => call.path === "/v1/sources/source-1/status");
  assert.ok(statusCall, "source status mutation was not called");
  assert.equal(statusCall.body.status, "reviewed");
  assert.ok(harness.fetchCalls.some((call) => call.path === "/v1/sources"), "post-mutation list refresh was not attempted");
  assert.equal(harness.nodes.get("sourceLibraryStatus").textContent, "已标记为 reviewed。");
  const source = JSON.parse(harness.run("JSON.stringify(state.source)"));
  assert.equal(source.sourceStatus, "reviewed");
  assert.equal(source.markdownPath, "vault/wiki/sources/source-1.md");
});

test("sidepanel wires source version diff and reextract controls", async () => {
  const js = await projectFile("sidepanel.js");
  const css = await projectFile("sidepanel.css");

  assert.match(js, /function loadSourceVersionDiff/);
  assert.match(js, /function reextractSource/);
  assert.match(js, /data-source-diff-id/);
  assert.match(js, /data-source-reextract-id/);
  assert.match(js, /companionRequest\(`\/v1\/sources\/\$\{encodeURIComponent\(sourceId\)\}\/diff`/);
  assert.match(js, /companionRequest\(`\/v1\/sources\/\$\{encodeURIComponent\(sourceId\)\}\/reextract`/);
  assert.match(css, /\.source-version-diff/);
});

test("sidepanel loads source diff and keeps reextract mutation successful when refresh fails", async () => {
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/sources/source-1/diff" && call.method === "GET") {
        return {
          ok: true,
          diff: {
            has_compare: true,
            changed: true,
            source_id: "source-1",
            compare_source_id: "source-0",
            similarity: 0.82,
            added_chars: 12,
            removed_chars: 4,
            unified_diff: "--- source-0\n+++ source-1\n@@\n-old\n+new <b>safe</b>"
          }
        };
      }
      if (call.path === "/v1/sources/source-1/reextract" && call.method === "POST") {
        return {
          ok: true,
          diff: { has_compare: true, changed: true, source_id: "source-1", compare_source_id: "source-0" },
          job: {
            id: "job-1",
            type: "reextract",
            items: [{ id: "item-1", status: "success", source_id: "source-1" }]
          },
          result: {
            source: {
              id: "source-1",
              status: "extracted",
              chunks: [{ id: "chunk-rerun" }],
              markdown_path: "vault/wiki/sources/source-1-rerun.md"
            },
            records: {
              claims: [{ id: "claim-rerun", text: "Rerun claim", evidence_count: 1 }],
              evidence: [{ id: "evidence-rerun", claim_id: "claim-rerun", quote: "rerun quote" }]
            },
            agent_run: { id: "run-rerun" }
          }
        };
      }
      if (call.path === "/v1/sources/source-1" && call.method === "GET") {
        return {
          ok: true,
          source: {
            id: "source-1",
            title: "Source 1",
            status: "extracted",
            markdown_path: "vault/wiki/sources/source-1-rerun.md",
            text: "Source text",
            chunks: [{ id: "chunk-rerun" }],
            versions: [{ source_id: "source-1", version_index: 2, is_current: true }]
          }
        };
      }
      if (call.path === "/v1/sources" || call.path === "/v1/knowledge/records") {
        return { ok: false, status: 503, error: "list refresh unavailable after reextract" };
      }
      return { ok: true };
    }
  });

  harness.setState({
    settings: { serviceUrl: "http://service.local", projectId: "project-1", pairingToken: "pair-token" },
    currentSourceDetailId: "source-1",
    currentSourceDetail: { id: "source-1", title: "Source 1", text: "Source text", chunks: [] },
    source: {
      sourceId: "source-1",
      title: "Current Source",
      url: "https://example.com/current",
      kind: "page",
      text: "This current source has enough text to re-extract structured knowledge from it."
    }
  });

  await harness.context.loadSourceVersionDiff("source-1");

  const diffCall = harness.fetchCalls.find((call) => call.path === "/v1/sources/source-1/diff");
  assert.ok(diffCall, "source diff request was not called");
  assert.match(harness.nodes.get("sourceDetail").innerHTML, /版本 Diff/);
  assert.match(harness.nodes.get("sourceDetail").innerHTML, /&lt;b&gt;safe&lt;\/b&gt;/);

  await harness.context.reextractSource("source-1");

  const reextractCall = harness.fetchCalls.find((call) => call.path === "/v1/sources/source-1/reextract");
  assert.ok(reextractCall, "source reextract mutation was not called");
  assert.equal(reextractCall.body.mode, "auto");
  assert.equal(reextractCall.body.project_id, "project-1");
  assert.ok(harness.fetchCalls.some((call) => call.path === "/v1/knowledge/records"), "post-reextract knowledge refresh was not attempted");
  assert.ok(harness.fetchCalls.some((call) => call.path === "/v1/sources/source-1"), "source detail refresh was not attempted");
  assert.match(harness.nodes.get("knowledgeRecordStatus").textContent, /^已重跑抽取：/);
  assert.match(harness.nodes.get("knowledgeRecordStatus").textContent, /run run-rerun/);
  const source = JSON.parse(harness.run("JSON.stringify(state.source)"));
  assert.equal(source.sourceStatus, "extracted");
  assert.deepEqual(source.chunks, [{ id: "chunk-rerun" }]);
  assert.equal(source.markdownPath, "vault/wiki/sources/source-1-rerun.md");
});

test("sidepanel keeps extraction mutation successful when post-write refresh fails", async () => {
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/sources/source-1/extract-knowledge" && call.method === "POST") {
        return {
          ok: true,
          source: {
            id: "source-1",
            status: "extracted",
            chunks: [{ id: "chunk-1" }],
            markdown_path: "vault/wiki/sources/source-1.md"
          },
          records: {
            claims: [{ id: "claim-1", text: "Actionable claim", evidence_count: 1 }],
            evidence: [{ id: "evidence-1", claim_id: "claim-1", quote: "source quote" }]
          },
          agent_run: { id: "run-1" }
        };
      }
      if (call.path === "/v1/sources" || call.path === "/v1/knowledge/records") {
        return { ok: false, status: 503, error: "list refresh unavailable after extraction" };
      }
      return { ok: true };
    }
  });

  harness.setState({
    settings: { serviceUrl: "http://service.local", projectId: "project-1", pairingToken: "pair-token" },
    source: {
      sourceId: "source-1",
      title: "Current Source",
      url: "https://example.com/current",
      kind: "page",
      text: "This current source has enough text to extract structured knowledge from it.",
      markdown: "This current source has enough text to extract structured knowledge from it."
    }
  });

  await harness.context.extractKnowledgeFromCurrentSource();

  const extractCall = harness.fetchCalls.find((call) => call.path === "/v1/sources/source-1/extract-knowledge");
  assert.ok(extractCall, "extract-knowledge mutation was not called");
  assert.ok(harness.fetchCalls.some((call) => call.path === "/v1/knowledge/records"), "post-extraction knowledge refresh was not attempted");
  assert.match(harness.nodes.get("knowledgeRecordStatus").textContent, /^已抽取草稿：/);
  assert.match(harness.nodes.get("knowledgeRecordStatus").textContent, /run run-1/);
  const source = JSON.parse(harness.run("JSON.stringify(state.source)"));
  assert.equal(source.sourceStatus, "extracted");
  assert.deepEqual(source.chunks, [{ id: "chunk-1" }]);
  assert.equal(source.markdownPath, "vault/wiki/sources/source-1.md");
});

test("sidepanel recaptures current source when title url or text no longer matches bound source id", async () => {
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/captures" && call.method === "POST") {
        return {
          ok: true,
          source: {
            id: "source-new",
            project_id: call.body.project_id,
            markdown_path: "vault/wiki/sources/source-new.md"
          },
          chunks: [{ id: "chunk-new" }]
        };
      }
      return { ok: true };
    }
  });

  harness.setState({
    settings: { serviceUrl: "http://service.local", projectId: "project-1", pairingToken: "pair-token" },
    source: {
      sourceId: "source-old",
      title: "Old Source",
      url: "https://example.com/source",
      kind: "page",
      site: "example",
      text: "Old source text that was previously captured and fingerprinted.",
      markdown: "Old source text that was previously captured and fingerprinted.",
      chunks: [{ id: "chunk-old" }],
      markdownPath: "vault/wiki/sources/source-old.md"
    }
  });
  harness.run("markCurrentSourceFingerprint()");
  harness.run(`
    state.source.title = "New Source";
    state.source.text = "New source text with different evidence that must not reuse the old source id.";
    state.source.markdown = state.source.text;
  `);

  const capture = await harness.context.ensureCurrentSourceCaptured();

  const captureCall = harness.fetchCalls.find((call) => call.path === "/v1/captures");
  assert.ok(captureCall, "changed source was not recaptured");
  assert.equal(captureCall.body.project_id, "project-1");
  assert.equal(captureCall.body.source.title, "New Source");
  assert.match(captureCall.body.content.text, /different evidence/);
  assert.equal(capture.source.id, "source-new");
  const source = JSON.parse(harness.run("JSON.stringify(state.source)"));
  assert.equal(source.sourceId, "source-new");
  assert.deepEqual(source.chunks, [{ id: "chunk-new" }]);
  assert.equal(source.markdownPath, "vault/wiki/sources/source-new.md");
  assert.notEqual(source.sourceFingerprint, "");
});

test("sidepanel executes service-owned batch claim, heartbeat, and success flow in a VM smoke", async () => {
  let claimCount = 0;
  const job = {
    id: "job-1",
    type: "read",
    status: "running",
    items: [{
      id: "job-item-1",
      url: "https://example.com/a",
      status: "pending",
      input: {
        client_id: "queue-1",
        canonical_url: "https://example.com/a",
        title: "Example A"
      },
      result: {}
    }]
  };
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/jobs/read") return { ok: true, job };
      if (call.path.endsWith("/recover") || call.path.endsWith("/retry-failed") || call.path.endsWith("/resume")) {
        return { ok: true, job };
      }
      if (call.path.endsWith("/claim-next")) {
        claimCount += 1;
        if (claimCount === 1) {
          job.items[0].status = "running";
          return { ok: true, job, item: job.items[0] };
        }
        return { ok: true, job, item: null, reason: "drained" };
      }
      if (call.path.endsWith("/heartbeat")) {
        job.items[0].heartbeat_at = "2026-06-28T01:02:03.000Z";
        return { ok: true, job, item: job.items[0] };
      }
      if (call.path === "/v1/captures") {
        return { ok: true, source: { id: "source-1" } };
      }
      if (call.path.endsWith("/status")) {
        job.items[0].status = call.body.status;
        job.items[0].source_id = call.body.source_id || "";
        job.items[0].result = call.body.result || {};
        job.quality_gate_counts = {
          total: 1,
          passed: 0,
          needs_review: 1,
          reason_counts: { pagination_needed: 1 }
        };
        return { ok: true, job, item: job.items[0] };
      }
      return { ok: true };
    }
  });

  harness.setState({
    settings: { serviceUrl: "http://service.local", projectId: "project-1", pairingToken: "pair-token" },
    batchQueue: [{
      id: "queue-1",
      url: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      title: "Example A",
      status: "pending",
      error: "",
      errorCategory: "",
      browserAttempts: 0,
      lastAttemptAt: "",
      startedAt: "",
      completedAt: "",
      lastHeartbeatAt: "",
      sourceId: "",
      jobId: "",
      jobItemId: "",
      addedAt: "2026-06-28T01:00:00.000Z",
      updatedAt: "2026-06-28T01:00:00.000Z"
    }]
  });

  await harness.context.processBatchQueue();
  await Promise.resolve();

  const calls = harness.fetchCalls;
  assert.ok(calls.some((call) => call.path === "/v1/jobs/read"), "job creation was not called");
  assert.ok(calls.some((call) => call.path.endsWith("/recover")), "job recovery was not called");
  assert.ok(calls.some((call) => call.path.endsWith("/retry-failed")), "failed item retry reset was not called");
  assert.ok(calls.some((call) => call.path.endsWith("/resume")), "job resume was not called");
  assert.ok(calls.some((call) => call.path.endsWith("/claim-next")), "claim-next was not called");
  assert.ok(calls.some((call) => call.path.endsWith("/heartbeat")), "heartbeat was not called");
  assert.ok(calls.some((call) => call.path === "/v1/captures"), "capture save was not called");
  assert.ok(calls.some((call) => call.path.endsWith("/status") && call.body.status === "success"), "success status was not written");

  for (const call of calls.filter((item) => item.path.includes("/v1/jobs/") && item.body)) {
    if (call.path.endsWith("/claim-next") || call.path.endsWith("/heartbeat") || call.path.endsWith("/status")) {
      assert.equal(call.body.executor_id, "extension-uuid-1");
    }
  }

  const snapshot = harness.stateSnapshot();
  assert.equal(snapshot.queue[0].status, "success");
  assert.equal(snapshot.queue[0].sourceId, "source-1");
  assert.equal(snapshot.queue[0].jobId, "job-1");
  assert.equal(snapshot.queue[0].jobItemId, "job-item-1");
  assert.ok(snapshot.queue[0].startedAt, "item start time was not recorded");
  assert.ok(snapshot.queue[0].completedAt, "item completion time was not recorded");
  assert.equal(snapshot.queue[0].lastHeartbeatAt, "2026-06-28T01:02:03.000Z");
  assert.equal(snapshot.metrics.total, 1);
  assert.equal(snapshot.metrics.qualityGateCounts.needsReview, 1);
  assert.equal(snapshot.metrics.qualityGateCounts.reasonCounts.pagination_needed, 1);
  assert.match(harness.nodes.get("batchProgress").innerHTML, /需审查 1/);
  assert.match(harness.nodes.get("batchProgress").innerHTML, /质量原因 需分页 1/);
  assert.ok(snapshot.metrics.completedAt, "batch completion time was not recorded");
  assert.equal(snapshot.running, false);
});

test("sidepanel records and enqueues batch pagination checkpoints in a VM smoke", async () => {
  let claimCount = 0;
  const job = {
    id: "job-pagination",
    type: "read",
    status: "running",
    items: [{
      id: "job-item-pagination",
      url: "https://example.com/a",
      status: "pending",
      input: {
        client_id: "queue-1",
        canonical_url: "https://example.com/a",
        title: "Example A"
      },
      result: {}
    }]
  };
  const harness = await createSidepanelHarness({
    extractionResult: {
      title: "Thread Page 1",
      url: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      nextPages: ["https://example.com/a?page=2&utm_source=forum"]
    },
    fetchHandler: async (call) => {
      if (call.path === "/v1/jobs/read") return { ok: true, job };
      if (call.path.endsWith("/recover") || call.path.endsWith("/retry-failed") || call.path.endsWith("/resume")) {
        return { ok: true, job };
      }
      if (call.path.endsWith("/claim-next")) {
        claimCount += 1;
        if (claimCount === 1) {
          job.items[0].status = "running";
          return { ok: true, job, item: job.items[0] };
        }
        return { ok: true, job, item: null, reason: "drained" };
      }
      if (call.path.endsWith("/heartbeat")) {
        return { ok: true, job, item: job.items[0] };
      }
      if (call.path === "/v1/captures") {
        return { ok: true, source: { id: "source-pagination" } };
      }
      if (call.path.endsWith("/status")) {
        job.items[0].status = call.body.status;
        job.items[0].source_id = call.body.source_id || "";
        job.items[0].title = call.body.title || job.items[0].title;
        job.items[0].result = call.body.result || {};
        return { ok: true, job, item: job.items[0] };
      }
      if (call.path === "/v1/capture-plans" && call.method === "POST") {
        return {
          ok: true,
          plans: call.body.items.map((item, index) => ({ id: `plan-${index + 1}`, ...item }))
        };
      }
      return { ok: true };
    }
  });

  harness.setState({
    settings: { serviceUrl: "http://service.local", projectId: "project-1", pairingToken: "pair-token" },
    batchQueue: [{
      id: "queue-1",
      url: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      title: "Example A",
      status: "pending",
      error: "",
      errorCategory: "",
      browserAttempts: 0,
      lastAttemptAt: "",
      startedAt: "",
      completedAt: "",
      lastHeartbeatAt: "",
      sourceId: "",
      jobId: "",
      jobItemId: "",
      nextPages: [],
      paginationCheckpoint: null,
      addedAt: "2026-06-28T01:00:00.000Z",
      updatedAt: "2026-06-28T01:00:00.000Z"
    }]
  });

  await harness.context.processBatchQueue();

  const successCall = harness.fetchCalls.find((call) => call.path.endsWith("/status") && call.body.status === "success");
  assert.ok(successCall, "success status was not written");
  assert.deepEqual(successCall.body.result.next_pages, ["https://example.com/a?page=2"]);
  assert.equal(successCall.body.result.pagination_checkpoint.source_id, "source-pagination");
  assert.equal(successCall.body.result.pagination_checkpoint.source_url, "https://example.com/a");
  assert.equal(successCall.body.result.pagination_checkpoint.job_id, "job-pagination");
  assert.equal(successCall.body.result.pagination_checkpoint.job_item_id, "job-item-pagination");
  assert.equal(successCall.body.result.pagination_checkpoint.next_page_count, 1);

  let snapshot = harness.stateSnapshot();
  assert.deepEqual(snapshot.queue[0].nextPages, ["https://example.com/a?page=2"]);
  assert.equal(snapshot.queue[0].paginationCheckpoint.source_id, "source-pagination");

  harness.setState({ batchQueue: [] });
  assert.equal(harness.context.mergeJobIntoBatchQueue(job), 1);
  snapshot = harness.stateSnapshot();
  assert.equal(snapshot.queue[0].id, "queue-1");
  assert.deepEqual(snapshot.queue[0].paginationCheckpoint.next_pages, ["https://example.com/a?page=2"]);

  await harness.context.createBatchItemNextPageCapturePlans("queue-1");
  const planCall = harness.fetchCalls.find((call) => call.path === "/v1/capture-plans" && call.method === "POST");
  assert.ok(planCall, "pagination checkpoint capture-plan write was not called");
  assert.equal(planCall.body.items[0].url, "https://example.com/a?page=2");
  assert.equal(planCall.body.items[0].metadata.pagination_checkpoint, true);
  assert.equal(planCall.body.items[0].metadata.pagination_source_id, "source-pagination");
  assert.equal(planCall.body.items[0].metadata.pagination_job_id, "job-pagination");
  assert.equal(planCall.body.items[0].metadata.pagination_job_item_id, "job-item-pagination");
});

test("sidepanel restores a 100 URL service job after extension restart and resumes completion", async () => {
  const job = {
    id: "job-restart",
    type: "read",
    status: "running",
    items: Array.from({ length: 100 }, (_, index) => {
      const status = index < 30 ? "success" : index < 35 ? "running" : "pending";
      return {
        id: `job-item-${index}`,
        url: `https://example.com/restart-${index}`,
        title: `Restart ${index}`,
        status,
        source_id: status === "success" ? `source-done-${index}` : "",
        started_at: status === "running" ? "2026-06-28T01:00:00.000Z" : "",
        completed_at: status === "success" ? "2026-06-28T01:01:00.000Z" : "",
        heartbeat_at: status === "running" ? "2026-06-28T01:02:00.000Z" : "",
        input: {
          client_id: `queue-${index}`,
          canonical_url: `https://example.com/restart-${index}`,
          title: `Restart ${index}`
        },
        result: {}
      };
    })
  };
  let captureCount = 0;
  let claimIndex = 0;
  const itemFromPath = (path) => {
    const segments = path.split("/").map((part) => decodeURIComponent(part));
    return job.items.find((candidate) => segments.includes(candidate.id));
  };
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/jobs" && call.method === "GET") {
        return { ok: true, jobs: [{ id: job.id, type: "read", status: job.status }] };
      }
      if (call.path === `/v1/jobs/${job.id}` && call.method === "GET") {
        return { ok: true, job };
      }
      if (call.path.endsWith("/recover")) {
        for (const item of job.items) {
          if (item.status === "running") {
            item.status = "failed";
            item.error = "stuck running for more than 300 seconds";
            item.error_category = "stuck_running";
            item.heartbeat_at = "";
          }
        }
        return { ok: true, job };
      }
      if (call.path.endsWith("/retry-failed")) {
        for (const item of job.items) {
          if (item.status === "failed") {
            item.status = "pending";
            item.error = "";
            item.error_category = "";
            item.started_at = "";
            item.completed_at = "";
          }
        }
        return { ok: true, job };
      }
      if (call.path.endsWith("/resume")) {
        job.status = "accepted";
        return { ok: true, job };
      }
      if (call.path.endsWith("/claim-next")) {
        const item = job.items.find((candidate, index) => index >= claimIndex && candidate.status === "pending");
        if (!item) return { ok: true, job, item: null, reason: "empty" };
        claimIndex = job.items.indexOf(item) + 1;
        item.status = "running";
        item.lease_owner = call.body.executor_id;
        item.heartbeat_at = "2026-06-28T01:03:00.000Z";
        return { ok: true, job, item };
      }
      if (call.path.endsWith("/heartbeat")) {
        const item = itemFromPath(call.path);
        if (item) item.heartbeat_at = "2026-06-28T01:04:00.000Z";
        return { ok: true, job, item };
      }
      if (call.path === "/v1/captures") {
        captureCount += 1;
        return { ok: true, source: { id: `source-resumed-${captureCount}` } };
      }
      if (call.path.endsWith("/status")) {
        const item = itemFromPath(call.path);
        if (item) {
          item.status = call.body.status;
          item.source_id = call.body.source_id || "";
          item.title = call.body.title || item.title;
          item.result = call.body.result || {};
          item.completed_at = "2026-06-28T01:05:00.000Z";
          item.lease_owner = "";
          item.heartbeat_at = "";
        }
        if (job.items.every((candidate) => candidate.status === "success")) job.status = "success";
        return { ok: true, job, item };
      }
      return { ok: true };
    }
  });

  harness.setState({
    settings: { serviceUrl: "http://service.local", projectId: "project-1", pairingToken: "pair-token" },
    batchQueue: []
  });

  await harness.context.restoreBatchFromCompanion();
  let snapshot = harness.stateSnapshot();
  assert.equal(snapshot.queue.length, 100);
  assert.equal(snapshot.queue.filter((item) => item.status === "success").length, 30);
  assert.equal(snapshot.queue.filter((item) => item.status === "failed").length, 5);
  assert.equal(snapshot.queue.filter((item) => item.status === "pending").length, 65);

  await harness.context.processBatchQueue();
  snapshot = harness.stateSnapshot();
  assert.equal(snapshot.queue.length, 100);
  assert.equal(snapshot.queue.filter((item) => item.status === "success").length, 100);
  assert.equal(captureCount, 70);
  assert.equal(snapshot.running, false);
  assert.ok(harness.fetchCalls.some((call) => call.path.endsWith("/recover")), "recover was not called");
  assert.ok(harness.fetchCalls.some((call) => call.path.endsWith("/retry-failed")), "retry-failed was not called");
  assert.ok(harness.fetchCalls.some((call) => call.path.endsWith("/resume")), "resume was not called");
  assert.ok(harness.fetchCalls.some((call) => call.path.endsWith("/claim-next")), "claim-next was not called");
});

test("sidepanel executes pause and cancel job actions in a VM smoke", async () => {
  const harness = await createSidepanelHarness({
    fetchHandler: async () => ({ ok: true })
  });
  harness.setState({
    settings: { serviceUrl: "http://service.local", projectId: "project-1", pairingToken: "pair-token" },
    batchRunning: true,
    batchQueue: [{
      id: "queue-1",
      url: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      title: "Example A",
      status: "running",
      error: "",
      errorCategory: "",
      browserAttempts: 1,
      lastAttemptAt: "",
      startedAt: "2026-06-28T01:00:00.000Z",
      completedAt: "",
      lastHeartbeatAt: "",
      sourceId: "",
      jobId: "job-1",
      jobItemId: "job-item-1",
      addedAt: "2026-06-28T01:00:00.000Z",
      updatedAt: "2026-06-28T01:00:00.000Z"
    }, {
      id: "queue-2",
      url: "https://example.com/b",
      canonicalUrl: "https://example.com/b",
      title: "Example B",
      status: "pending",
      error: "",
      errorCategory: "",
      browserAttempts: 0,
      lastAttemptAt: "",
      startedAt: "",
      completedAt: "",
      lastHeartbeatAt: "",
      sourceId: "",
      jobId: "job-1",
      jobItemId: "job-item-2",
      addedAt: "2026-06-28T01:00:00.000Z",
      updatedAt: "2026-06-28T01:00:00.000Z"
    }]
  });

  await harness.context.pauseBatchQueue();
  let snapshot = harness.stateSnapshot();
  assert.equal(snapshot.paused, true);
  assert.ok(harness.fetchCalls.some((call) => call.path === "/v1/jobs/job-1/pause"));

  await harness.context.cancelBatchQueue();
  snapshot = harness.stateSnapshot();
  assert.equal(snapshot.cancelRequested, true);
  assert.equal(snapshot.queue[0].status, "running");
  assert.equal(snapshot.queue[1].status, "canceled");
  assert.ok(snapshot.queue[1].completedAt, "canceled item completion time was not recorded");
  assert.ok(harness.fetchCalls.some((call) => call.path === "/v1/jobs/job-1/cancel"));
});

test("sidepanel honors batch concurrency limit in the service-owned VM smoke", async () => {
  let claimCount = 0;
  let captureCount = 0;
  let activeCaptures = 0;
  let maxActiveCaptures = 0;
  const job = {
    id: "job-concurrent",
    type: "read",
    status: "running",
    items: ["a", "b"].map((suffix) => ({
      id: `job-item-${suffix}`,
      url: `https://example.com/${suffix}`,
      status: "pending",
      input: {
        client_id: `queue-${suffix}`,
        canonical_url: `https://example.com/${suffix}`,
        title: `Example ${suffix.toUpperCase()}`
      },
      result: {}
    }))
  };
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/jobs/read") return { ok: true, job };
      if (call.path.endsWith("/recover") || call.path.endsWith("/retry-failed") || call.path.endsWith("/resume")) {
        return { ok: true, job };
      }
      if (call.path.endsWith("/claim-next")) {
        const item = job.items[claimCount] || null;
        claimCount += 1;
        if (item) {
          item.status = "running";
          return { ok: true, job, item };
        }
        return { ok: true, job, item: null, reason: "drained" };
      }
      if (call.path.endsWith("/heartbeat")) {
        return { ok: true, job, item: job.items.find((item) => call.path.includes(item.id)) || job.items[0] };
      }
      if (call.path === "/v1/captures") {
        activeCaptures += 1;
        maxActiveCaptures = Math.max(maxActiveCaptures, activeCaptures);
        await new Promise((resolve) => setImmediate(resolve));
        activeCaptures -= 1;
        captureCount += 1;
        return { ok: true, source: { id: `source-${captureCount}` } };
      }
      if (call.path.endsWith("/status")) {
        const item = job.items.find((candidate) => call.path.includes(candidate.id));
        if (item) {
          item.status = call.body.status;
          item.source_id = call.body.source_id || "";
          item.result = call.body.result || {};
        }
        return { ok: true, job, item };
      }
      return { ok: true };
    }
  });

  harness.setState({
    settings: { serviceUrl: "http://service.local", projectId: "project-1", pairingToken: "pair-token" },
    batchConcurrency: 2,
    batchQueue: ["a", "b"].map((suffix) => ({
      id: `queue-${suffix}`,
      url: `https://example.com/${suffix}`,
      canonicalUrl: `https://example.com/${suffix}`,
      title: `Example ${suffix.toUpperCase()}`,
      status: "pending",
      error: "",
      errorCategory: "",
      browserAttempts: 0,
      lastAttemptAt: "",
      startedAt: "",
      completedAt: "",
      lastHeartbeatAt: "",
      sourceId: "",
      jobId: "",
      jobItemId: "",
      addedAt: "2026-06-28T01:00:00.000Z",
      updatedAt: "2026-06-28T01:00:00.000Z"
    }))
  });

  await harness.context.processBatchQueue();

  const snapshot = harness.stateSnapshot();
  assert.equal(snapshot.metrics.concurrency, 2);
  assert.equal(maxActiveCaptures, 2);
  assert.equal(snapshot.queue.filter((item) => item.status === "success").length, 2);
  assert.equal(harness.fetchCalls.filter((call) => call.path === "/v1/captures").length, 2);
});
