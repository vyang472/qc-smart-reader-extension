import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

async function projectFile(name) {
  return readFile(new URL(`../${name}`, import.meta.url), "utf8");
}

function createMockNode(id = "") {
  const classes = new Set();
  return {
    id,
    children: [],
    className: "",
    dataset: {},
    disabled: false,
    hidden: false,
    innerHTML: "",
    textContent: "",
    value: "",
    focused: false,
    scrolled: false,
    classList: {
      add(...names) {
        names.forEach((name) => classes.add(name));
      },
      remove(...names) {
        names.forEach((name) => classes.delete(name));
      },
      toggle(name, force) {
        if (force === true) {
          classes.add(name);
          return true;
        }
        if (force === false) {
          classes.delete(name);
          return false;
        }
        if (classes.has(name)) {
          classes.delete(name);
          return false;
        }
        classes.add(name);
        return true;
      },
      contains(name) {
        return classes.has(name);
      }
    },
    addEventListener() {},
    appendChild(child) {
      this.children.push(child);
    },
    focus() {
      this.focused = true;
    },
    scrollIntoView() {
      this.scrolled = true;
    },
    setAttribute(name, value) {
      this[name] = String(value);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

async function createSidepanelHarness({
  fetchHandler,
  extractionResult,
  runtimeMessageHandler,
  confirmHandler = () => true,
  currentTab = { id: 41, windowId: 7, url: "https://example.com/current", title: "Current tab" }
} = {}) {
  const js = (await projectFile("sidepanel.js")).replace("\ninit();\n", "\n");
  const nodes = new Map();
  const storageState = {};
  const intervalCallbacks = [];
  let nextTimerId = 1;
  let nextUuid = 1;
  const fetchCalls = [];
  const runtimeListeners = [];

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
    AbortController,
    Math,
    Object,
    confirm: confirmHandler,
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
      runtime: {
        onMessage: {
          addListener(listener) {
            runtimeListeners.push(listener);
          }
        },
        async sendMessage(message) {
          return runtimeMessageHandler ? runtimeMessageHandler(message) : { ok: true, selection: null };
        }
      },
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
        async query() {
          return [currentTab];
        },
        async create({ url }) {
          return { id: 42, url, title: "Fixture Page", windowId: 7 };
        },
        async get() {
          return { status: "complete" };
        },
        async remove() {}
      },
      windows: {
        async getCurrent() {
          return { id: currentTab.windowId };
        }
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
    runtimeListeners,
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
  assert.match(js, /preparation\.ready[\s\S]*processBatchQueueFromService\(processable, concurrency\)/);
  assert.match(js, /processBatchQueue[\s\S]*processBatchQueueLocally\(processable, concurrency, \{/);
  assert.match(js, /prepareServiceBackedBatch[\s\S]*\/recover/);
  assert.match(js, /prepareServiceBackedBatch[\s\S]*\/retry-failed/);
  assert.match(js, /prepareServiceBackedBatch[\s\S]*\/resume/);
  assert.match(js, /processBatchQueueFromService[\s\S]*while \(!state\.batchCancelRequested && !state\.batchPaused\)/);
  assert.match(js, /function batchWorkerExecutorId/);
  assert.match(js, /worker\(workerIndex\)[\s\S]*batchWorkerExecutorId\(workerIndex\)/);
  assert.match(js, /claimNextBatchJobItem[\s\S]*\/claim-next/);
  assert.match(js, /claimNextBatchJobItem[\s\S]*executor_id: executorId/);
  assert.match(js, /claimNextBatchJobItem[\s\S]*lease_seconds: 180/);
  assert.match(js, /processClaimedBatchItem[\s\S]*startBatchItemHeartbeat\(item, executorId\)/);
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

test("batch completion summaries report outcomes truthfully in service and local fallback paths", async () => {
  const localHarness = await createSidepanelHarness({
    extractionResult: {
      text: "",
      markdown: "",
      stats: { authRequired: true },
      quality_flags: { auth_required: true }
    },
    fetchHandler: async (call) => {
      if (call.path === "/v1/jobs/read") {
        return { ok: false, status: 503, error: "job service unavailable" };
      }
      return { ok: true };
    }
  });
  localHarness.setState({
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-1", pairingToken: "pair-token" },
    batchQueue: [{
      id: "local-failure",
      projectId: "project-1",
      url: "https://example.com/login",
      canonicalUrl: "https://example.com/login",
      title: "Login required",
      status: "pending",
      error: "",
      errorCategory: "",
      browserAttempts: 0,
      addedAt: "2026-06-28T01:00:00.000Z",
      updatedAt: "2026-06-28T01:00:00.000Z"
    }]
  });

  await localHarness.context.processBatchQueue();

  assert.match(localHarness.nodes.get("batchStatus").textContent, /服务端批量准备失败/);
  assert.match(localHarness.nodes.get("batchStatus").textContent, /成功 0.*失败 1.*可重试 0.*已取消 0/);
  assert.doesNotMatch(localHarness.nodes.get("batchStatus").textContent, /完成：1 个 URL/);

  let claimCount = 0;
  const job = {
    id: "job-all-failed",
    type: "read",
    status: "running",
    items: [{
      id: "job-item-all-failed",
      url: "https://example.com/login",
      status: "pending",
      input: { client_id: "service-failure", canonical_url: "https://example.com/login" },
      result: {}
    }]
  };
  const serviceHarness = await createSidepanelHarness({
    extractionResult: {
      text: "",
      markdown: "",
      stats: { authRequired: true },
      quality_flags: { auth_required: true }
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
      if (call.path.endsWith("/heartbeat")) return { ok: true, job, item: job.items[0] };
      if (call.path.endsWith("/status")) {
        job.items[0].status = call.body.status;
        job.items[0].error = call.body.error || "";
        job.items[0].error_category = call.body.error_category || "";
        job.items[0].result = call.body.result || {};
        return { ok: true, job, item: job.items[0] };
      }
      return { ok: true };
    }
  });
  serviceHarness.setState({
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-1", pairingToken: "pair-token" },
    batchQueue: [{
      id: "service-failure",
      projectId: "project-1",
      url: "https://example.com/login",
      canonicalUrl: "https://example.com/login",
      title: "Login required",
      status: "pending",
      error: "",
      errorCategory: "",
      browserAttempts: 0,
      addedAt: "2026-06-28T01:00:00.000Z",
      updatedAt: "2026-06-28T01:00:00.000Z"
    }]
  });

  await serviceHarness.context.processBatchQueue();

  assert.match(serviceHarness.nodes.get("batchStatus").textContent, /成功 0.*失败 1.*可重试 0.*已取消 0/);
  assert.doesNotMatch(serviceHarness.nodes.get("batchStatus").textContent, /完成：1 个 URL/);
  assert.equal(
    serviceHarness.context.formatBatchCompletionSummary([
      { status: "success" },
      { status: "failed", retryable: true },
      { status: "failed", retryable: false },
      { status: "canceled" }
    ]),
    "成功 1 · 失败 2 · 可重试 1 · 已取消 1"
  );
});

test("destructive controls require confirmation and preserve queues when server cancellation fails", async () => {
  const queueHarness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/jobs/job-1/cancel") {
        return { ok: false, status: 503, error: "cancel unavailable" };
      }
      return { ok: true };
    }
  });
  queueHarness.setState({
    settings: { serviceUrl: "http://127.0.0.1:37621", pairingToken: "pair-token", projectId: "project-1" },
    batchQueue: [{
      id: "item-1",
      projectId: "project-1",
      jobId: "job-1",
      jobItemId: "job-item-1",
      url: "https://example.com/pending",
      status: "pending"
    }]
  });
  await queueHarness.context.cancelBatchQueue();
  assert.equal(queueHarness.stateSnapshot().queue[0].status, "pending");
  assert.match(queueHarness.nodes.get("batchStatus").textContent, /取消失败|再次取消/);

  await queueHarness.context.clearBatchQueue();
  assert.equal(queueHarness.stateSnapshot().queue.length, 1);
  assert.match(queueHarness.nodes.get("batchStatus").textContent, /清空未执行|原样保留/);

  const deniedHarness = await createSidepanelHarness({ confirmHandler: () => false });
  deniedHarness.setState({
    settings: { serviceUrl: "http://127.0.0.1:37621", pairingToken: "pair-token", projectId: "project-1" }
  });
  await deniedHarness.context.clearServiceApiKey();
  assert.equal(deniedHarness.fetchCalls.some((call) => call.path === "/v1/model-settings"), false);
});

test("sidepanel maps extractor empty and auth flags to batch failure categories", async () => {
  const authHarness = await createSidepanelHarness({
    extractionResult: {
      text: "",
      markdown: "",
      stats: { authRequired: true, emptyContent: false },
      quality_flags: { auth_required: true, empty_content: false }
    }
  });
  await assert.rejects(
    authHarness.context.captureBatchItemWithRetries({
      id: "auth-item",
      url: "https://example.com/login",
      status: "pending"
    }),
    (error) => error.errorCategory === "auth_required"
  );
  assert.equal(authHarness.fetchCalls.some((call) => call.path === "/v1/captures"), false);

  const emptyHarness = await createSidepanelHarness({
    extractionResult: {
      text: "",
      markdown: "",
      stats: { emptyContent: true, authRequired: false },
      quality_flags: { empty_content: true, auth_required: false }
    }
  });
  await assert.rejects(
    emptyHarness.context.captureBatchItemWithRetries({
      id: "empty-item",
      url: "https://example.com/empty",
      status: "pending"
    }),
    (error) => error.errorCategory === "extraction_empty"
  );
  assert.equal(emptyHarness.fetchCalls.some((call) => call.path === "/v1/captures"), false);
});

test("settings panel shows authenticated connection feedback and persists Codex CLI controls", async () => {
  const html = await projectFile("sidepanel.html");
  for (const id of ["settingsStatus", "codexCommandInput", "codexTimeoutInput"]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }

  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/health") {
        return {
          ok: true,
          app: "QC Smart Reader",
          version: "0.9.0",
          service_version: "0.9.0",
          api_version: 1,
          pairing_required: true,
          vault_dir: "/tmp/qc-vault"
        };
      }
      if (call.path === "/v1/projects") {
        return { ok: false, status: 403, error: "invalid pairing token" };
      }
      if (call.path === "/v1/model-settings" && call.method === "GET") {
        return {
          ok: true,
          settings: {
            provider: "codex",
            base_url: "",
            model: "",
            temperature: 0.2,
            codex_command: "/opt/homebrew/bin/codex exec",
            codex_timeout_seconds: 420,
            has_api_key: false
          }
        };
      }
      if (call.path === "/v1/model-settings" && call.method === "POST") {
        return {
          ok: true,
          settings: {
            ...call.body,
            base_url: call.body.base_url,
            codex_command: call.body.codex_command,
            codex_timeout_seconds: call.body.codex_timeout_seconds,
            has_api_key: false
          }
        };
      }
      return { ok: true };
    }
  });
  harness.storageState.settings = {
    serviceUrl: "http://127.0.0.1:37621",
    pairingToken: "bad-token",
    projectId: "project-1",
    provider: "codex",
    codexCommand: "/usr/local/bin/codex exec",
    codexTimeoutSeconds: 360
  };

  await harness.context.loadSettings();
  assert.equal(harness.nodes.get("baseUrlInput").value, "");
  assert.equal(harness.nodes.get("modelInput").value, "");
  assert.equal(harness.nodes.get("codexCommandInput").value, "/opt/homebrew/bin/codex exec");
  assert.equal(harness.nodes.get("codexTimeoutInput").value, 420);
  assert.equal(harness.nodes.get("baseUrlInput").disabled, true);
  assert.equal(harness.nodes.get("apiKeyInput").disabled, true);
  assert.equal(harness.nodes.get("codexCommandInput").disabled, false);
  assert.equal(harness.nodes.get("codexTimeoutInput").disabled, false);

  harness.nodes.get("codexCommandInput").value = "/custom/codex exec";
  harness.nodes.get("codexTimeoutInput").value = "600";
  await harness.context.saveSettings();
  const saveCall = harness.fetchCalls.find((call) => call.path === "/v1/model-settings" && call.method === "POST");
  assert.equal(saveCall.body.codex_command, "/custom/codex exec");
  assert.equal(saveCall.body.codex_timeout_seconds, 600);
  assert.match(harness.nodes.get("settingsStatus").textContent, /设置已保存/);

  harness.nodes.get("providerSelect").value = "openai";
  harness.context.syncProviderControls();
  assert.equal(harness.nodes.get("baseUrlInput").disabled, false);
  assert.equal(harness.nodes.get("apiKeyInput").disabled, false);
  assert.equal(harness.nodes.get("codexCommandInput").disabled, true);
  assert.equal(harness.nodes.get("codexTimeoutInput").disabled, true);

  harness.nodes.get("providerSelect").value = "codex";
  harness.nodes.get("pairingTokenInput").value = "bad-token";
  await harness.context.testCompanion();
  assert.ok(harness.fetchCalls.some((call) => call.path === "/v1/projects"), "authenticated probe was not called");
  assert.match(harness.nodes.get("settingsStatus").textContent, /invalid pairing token|Pairing Token|配对失败/i);
  assert.doesNotMatch(harness.nodes.get("settingsStatus").textContent, /本地服务正常/);
});

test("companion requests enforce bounded operation-aware timeouts", async () => {
  const harness = await createSidepanelHarness();
  harness.setState({ settings: { codexTimeoutSeconds: 420 } });
  assert.equal(harness.context.companionRequestTimeoutMs("/v1/projects", {}), 45000);
  assert.equal(harness.context.companionRequestTimeoutMs("/v1/pdfs/extract", {}), 240000);
  assert.equal(harness.context.companionRequestTimeoutMs("/v1/llm/chat", {}), 450000);
  assert.equal(harness.context.companionRequestTimeoutMs("/v1/projects", { timeoutMs: 1234 }), 1234);
});

test("privacy consent is explicit, versioned, and required before model calls", async () => {
  const html = await projectFile("sidepanel.html");
  assert.match(html, /id="modelDataConsentInput"/);
  assert.match(html, /我同意把我主动提交的材料发送给所选模型/);
  assert.match(html, /href="PRIVACY\.md"/);

  const harness = await createSidepanelHarness();
  harness.storageState.settings = {
    serviceUrl: "http://127.0.0.1:37621",
    pairingToken: "pair-token",
    projectId: "project-1",
    provider: "openai",
    modelDataConsent: true,
    modelDataConsentVersion: "obsolete-notice"
  };
  await harness.context.loadSettings();
  assert.equal(harness.nodes.get("modelDataConsentInput").checked, false, "stale consent must not remain active");

  harness.setState({
    source: {
      projectId: "project-1",
      title: "Private source",
      url: "https://example.com/private",
      kind: "page",
      text: "Sensitive source material that must not be sent without affirmative consent."
    }
  });
  await harness.context.askAgents();
  assert.equal(harness.fetchCalls.some((call) => call.path === "/v1/llm/chat"), false);
  assert.match(harness.nodes.get("status").textContent, /同意/);

  harness.nodes.get("modelDataConsentInput").checked = true;
  await harness.context.persistModelDataConsent();
  assert.equal(harness.storageState.settings.modelDataConsent, true);
  assert.equal(harness.storageState.settings.modelDataConsentVersion, "2026-08-14-v1");
  assert.match(harness.storageState.settings.modelDataConsentAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.throws(
    () => harness.context.assertCompatibleCompanion({ ok: true, app: "QC Smart Reader", api_version: 2 }),
    /版本不兼容/
  );
  assert.throws(
    () => harness.context.assertCompatibleCompanion({
      ok: true,
      app: "QC Smart Reader",
      api_version: 1,
      min_extension_version: "0.10.0"
    }),
    /扩展版本过旧/
  );
  assert.equal(harness.context.compareProductVersions("0.9.0", "0.9"), 0);
});

test("local Mock is the zero-config default and external extraction never silently falls back", async () => {
  const html = await projectFile("sidepanel.html");
  assert.match(html, /<option value="mock" selected>本地模板/);
  for (const id of [
    "modelRouteHint",
    "remoteProviderFields",
    "codexProviderFields",
    "externalModelFields",
    "modelDataConsentRow",
    "externalModelActions"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }

  const harness = await createSidepanelHarness();
  await harness.context.loadSettings();
  assert.equal(harness.nodes.get("providerSelect").value, "mock");
  assert.equal(harness.nodes.get("remoteProviderFields").hidden, true);
  assert.equal(harness.nodes.get("codexProviderFields").hidden, true);
  assert.equal(harness.nodes.get("externalModelFields").hidden, true);
  assert.equal(harness.nodes.get("modelDataConsentRow").hidden, true);
  assert.equal(harness.nodes.get("externalModelActions").hidden, true);
  assert.equal(harness.context.resolveKnowledgeExtractionMode(), "mock");

  harness.setState({
    settings: {
      serviceUrl: "http://127.0.0.1:37621",
      pairingToken: "pair-token",
      projectId: "default",
      provider: "openai",
      modelSettingsProvider: "openai",
      modelReady: false,
      modelRoute: "provider",
      modelDataConsent: false,
      modelDataConsentVersion: ""
    }
  });
  harness.nodes.get("providerSelect").value = "openai";
  assert.throws(
    () => harness.context.resolveKnowledgeExtractionMode(),
    /未就绪.*未同意.*不会自动改用本地模板（Mock 模式）/
  );

  harness.setState({
    settings: {
      serviceUrl: "http://127.0.0.1:37621",
      pairingToken: "pair-token",
      projectId: "default",
      provider: "openai",
      modelSettingsProvider: "openai",
      modelReady: true,
      modelRoute: "provider",
      modelDataConsent: true,
      modelDataConsentVersion: "2026-08-14-v1"
    }
  });
  assert.equal(harness.context.resolveKnowledgeExtractionMode(), "provider");
});

test("an invalid stored pairing token cannot unlock or restore Quick Start", async () => {
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/health") {
        return {
          ok: true,
          app: "QC Smart Reader",
          api_version: 1,
          service_version: "0.9.0"
        };
      }
      if (call.path === "/v1/projects") {
        return { ok: false, status: 403, error: "invalid pairing token" };
      }
      if (call.path === "/v1/model-settings") {
        return { ok: true, settings: { provider: "mock", ready: true, route: "mock" } };
      }
      return { ok: true };
    }
  });
  harness.storageState.settings = {
    serviceUrl: "http://127.0.0.1:37621",
    pairingToken: "stale-token",
    projectId: "default",
    provider: "mock"
  };
  harness.storageState.onboardingMilestones = {
    pairedAt: "2026-08-14T00:00:00.000Z",
    claimReadyAt: "2026-08-14T00:01:00.000Z"
  };

  await harness.context.loadOnboardingMilestones();
  await harness.context.loadSettings();
  const startup = await harness.context.authenticateCompanionForStartup();

  assert.equal(startup, null);
  assert.equal(harness.nodes.get("quickStartCard").hidden, true);
  assert.match(harness.nodes.get("settingsStatus").textContent, /Pairing Token.*失效|invalid pairing token/i);
  assert.ok(harness.fetchCalls.some((call) => call.path === "/v1/projects"), "startup did not probe an authenticated endpoint");
});

test("reading the current page persists it to Vault immediately and records only local progress", async () => {
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/captures" && call.method === "POST") {
        return {
          ok: true,
          source: {
            id: "source-first",
            project_id: "default",
            markdown_path: "wiki/sources/source-first.md"
          },
          chunks: [{ id: "chunk-first" }]
        };
      }
      return { ok: true };
    }
  });
  harness.setState({
    settings: {
      serviceUrl: "http://127.0.0.1:37621",
      pairingToken: "pair-token",
      projectId: "default",
      provider: "mock",
      modelReady: true,
      modelRoute: "mock"
    }
  });

  const capture = await harness.context.readCurrentPage();
  assert.equal(capture.source.id, "source-first");
  const captureCall = harness.fetchCalls.find((call) => call.path === "/v1/captures");
  assert.ok(captureCall, "read-current-page did not persist a capture");
  assert.equal(captureCall.body.source.title, "Fixture Page");
  assert.equal(captureCall.body.project_id, "default");
  assert.match(harness.nodes.get("status").textContent, /已保存到本地 Vault/);
  assert.match(harness.storageState.onboardingMilestones.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(harness.storageState.onboardingMilestones.lastSourceId, "source-first");
  assert.equal(harness.storageState.onboardingMilestones.projectId, "default");
  assert.equal(
    harness.fetchCalls.some((call) => /telemetry|analytics|event/i.test(call.path)),
    false,
    "local milestones must not be emitted as telemetry"
  );
});

test("Quick Start creates a real quote-backed first evidence chain and restores its local milestone", async () => {
  const js = await projectFile("sidepanel.js");
  assert.doesNotMatch(js, /[12] \/ 4/, "Quick Start progress copy drifted from its five visible steps");
  const records = {
    claims: [{ id: "claim-first", status: "extracted", text: "The fixture supports a verifiable first claim.", evidence_count: 1 }],
    evidence: [{
      id: "evidence-first",
      claim_id: "claim-first",
      quote: "This fixture page has enough body text to be saved by the companion service."
    }]
  };
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/captures" && call.method === "POST") {
        return {
          ok: true,
          source: { id: "source-first", project_id: "default", markdown_path: "wiki/sources/source-first.md" },
          chunks: [{ id: "chunk-first" }]
        };
      }
      if (call.path === "/v1/sources/source-first/extract-knowledge" && call.method === "POST") {
        return {
          ok: true,
          source: { id: "source-first", status: "extracted", chunks: [{ id: "chunk-first" }] },
          records,
          agent_run: {
            id: "run-first",
            agent_id: "mock_structured_extractor",
            input: { effective_mode: "mock", provider: "mock" }
          }
        };
      }
      if (call.path === "/v1/knowledge/records") return { ok: true, ...records };
      if (call.path === "/v1/sources") return { ok: true, sources: [] };
      if (call.path === "/v1/claims/review-queue") return { ok: true, claims: [] };
      if (call.path === "/v1/claims/claim-first/review") {
        records.claims[0].status = "reviewed";
        return { ok: true, claim: { ...records.claims[0] } };
      }
      return { ok: true };
    }
  });
  harness.setState({
    settings: {
      serviceUrl: "http://127.0.0.1:37621",
      pairingToken: "pair-token",
      projectId: "default",
      provider: "mock",
      modelSettingsProvider: "mock",
      modelReady: true,
      modelRoute: "mock"
    }
  });

  await harness.context.runQuickStart();

  const captureIndex = harness.fetchCalls.findIndex((call) => call.path === "/v1/captures");
  const extractIndex = harness.fetchCalls.findIndex((call) => call.path === "/v1/sources/source-first/extract-knowledge");
  assert.ok(captureIndex >= 0 && extractIndex > captureIndex, "Quick Start must capture before extracting");
  assert.equal(harness.fetchCalls[extractIndex].body.mode, "mock");
  assert.equal(harness.nodes.get("quickStartClaimText").textContent, records.claims[0].text);
  assert.equal(harness.nodes.get("quickStartQuoteText").textContent, records.evidence[0].quote);
  assert.equal(harness.nodes.get("quickStartEvidence").hidden, false);
  assert.match(harness.storageState.onboardingMilestones.claimReadyAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(harness.storageState.onboardingMilestones.firstClaimId, "claim-first");
  assert.equal(harness.storageState.onboardingMilestones.firstEvidenceId, "evidence-first");
  assert.equal(harness.storageState.onboardingMilestones.firstReviewedAt, undefined);
  assert.match(harness.nodes.get("quickStartReviewStatus").textContent, /尚未人工接受/);

  await harness.context.acceptQuickStartClaim();
  const reviewCall = harness.fetchCalls.find((call) => call.path === "/v1/claims/claim-first/review");
  assert.ok(reviewCall, "the user's explicit accept action was not persisted");
  assert.equal(reviewCall.body.status, "reviewed");
  assert.match(harness.storageState.onboardingMilestones.firstReviewedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(harness.nodes.get("quickStartReviewStatus").textContent, /已人工接受/);
  assert.equal(harness.nodes.get("quickStartProgress").textContent, "5 / 5");
  assert.equal(harness.nodes.get("quickStartProgress").classList.contains("done"), true);

  const restored = await createSidepanelHarness();
  restored.storageState.onboardingMilestones = structuredClone(harness.storageState.onboardingMilestones);
  restored.setState({ settings: { pairingToken: "pair-token", projectId: "default" } });
  await restored.context.loadOnboardingMilestones();
  restored.context.restoreQuickStartEvidenceFromRecords(records);
  assert.equal(restored.nodes.get("quickStartProgress").textContent, "5 / 5");
  assert.equal(restored.nodes.get("quickStartProgress").classList.contains("done"), true);
  assert.match(restored.nodes.get("quickStartStatus").textContent, /已恢复.*人工核对/);
});

test("Quick Start restore requires the server claim to remain reviewed", async () => {
  const firstReviewedAt = "2026-08-14T00:03:00.000Z";
  const harness = await createSidepanelHarness();
  harness.setState({
    settings: { pairingToken: "pair-token", projectId: "default" },
    onboardingMilestones: {
      pairedAt: "2026-08-14T00:00:00.000Z",
      projectId: "default",
      capturedAt: "2026-08-14T00:01:00.000Z",
      extractedAt: "2026-08-14T00:01:30.000Z",
      claimReadyAt: "2026-08-14T00:02:00.000Z",
      firstReviewedAt,
      firstClaimId: "claim-first",
      firstEvidenceId: "evidence-first"
    }
  });

  const restored = harness.context.restoreQuickStartEvidenceFromRecords({
    claims: [{ id: "claim-first", project_id: "default", status: "pending_validation", text: "Needs revalidation" }],
    evidence: [{ id: "evidence-first", claim_id: "claim-first", quote: "Exact source quote" }]
  });

  assert.equal(restored, true);
  assert.equal(harness.nodes.get("quickStartProgress").textContent, "4 / 5");
  assert.equal(harness.nodes.get("quickStartProgress").classList.contains("done"), false);
  assert.match(harness.nodes.get("quickStartStatus").textContent, /pending_validation.*重新人工核对/);
  assert.match(harness.nodes.get("quickStartReviewStatus").textContent, /服务端当前状态为 pending_validation/);
  assert.equal(harness.storageState.onboardingMilestones.firstReviewedAt, undefined);
  assert.equal(harness.storageState.onboardingMilestones.reviewInvalidatedFromReviewedAt, firstReviewedAt);
  assert.equal(harness.storageState.onboardingMilestones.reviewInvalidatedStatus, "pending_validation");
});

test("Quick Start evidence and review actions stay isolated to their project", async () => {
  const harness = await createSidepanelHarness();
  harness.setState({
    settings: {
      serviceUrl: "http://127.0.0.1:37621",
      pairingToken: "pair-token",
      projectId: "project-b",
      provider: "mock"
    },
    onboardingMilestones: {
      pairedAt: "2026-08-14T00:00:00.000Z",
      projectId: "project-a",
      capturedAt: "2026-08-14T00:01:00.000Z",
      claimReadyAt: "2026-08-14T00:02:00.000Z",
      firstClaimId: "claim-a",
      firstEvidenceId: "evidence-a"
    }
  });
  harness.context.revealQuickStartEvidence(
    { id: "claim-a", project_id: "project-a", status: "extracted", text: "Project A claim" },
    { id: "evidence-a", claim_id: "claim-a", quote: "Exact quote from project A" },
    { focus: false, projectId: "project-a" }
  );
  const card = harness.nodes.get("quickStartEvidence");

  const review = await harness.context.acceptQuickStartClaim();
  assert.equal(review, null);
  assert.equal(
    harness.fetchCalls.some((call) => call.path === "/v1/claims/claim-a/review"),
    false,
    "a stale evidence card reviewed a claim from another project"
  );
  assert.match(harness.nodes.get("quickStartReviewStatus").textContent, /另一个项目|跨项目/);

  const restored = harness.context.restoreQuickStartEvidenceFromRecords({
    claims: [{ id: "claim-a", project_id: "project-a", text: "Project A claim" }],
    evidence: [{ id: "evidence-a", claim_id: "claim-a", quote: "Exact quote from project A" }]
  });
  assert.equal(restored, false);
  assert.equal(card.hidden, true);
  assert.equal(card.dataset.claimId, "");
  assert.equal(card.dataset.evidenceId, "");
  assert.equal(card.dataset.projectId, "");
  assert.equal(card.dataset.claimStatus, "");

  await harness.context.markOnboardingMilestone("extractedAt", {
    projectId: "project-b",
    lastSourceId: "source-b"
  });
  assert.equal(harness.storageState.onboardingMilestones.projectId, "project-b");
  assert.equal(harness.storageState.onboardingMilestones.claimReadyAt, undefined);
  assert.equal(harness.storageState.onboardingMilestones.firstClaimId, undefined);
});

test("stale model answers cannot be rebound to another source or deliverable", async () => {
  const harness = await createSidepanelHarness();
  const sharedPrefix = "a".repeat(512);
  const sharedSuffix = "z".repeat(512);
  const firstText = `${sharedPrefix}middle-one${sharedSuffix}`;
  const secondText = `${sharedPrefix}middle-two${sharedSuffix}`;
  assert.equal(firstText.length, secondText.length);
  const firstFingerprint = harness.run(`sourceFingerprint(${JSON.stringify({
    projectId: "project-1",
    title: "Collision check",
    url: "https://example.com/current",
    kind: "page",
    text: firstText
  })})`);
  const secondFingerprint = harness.run(`sourceFingerprint(${JSON.stringify({
    projectId: "project-1",
    title: "Collision check",
    url: "https://example.com/current",
    kind: "page",
    text: secondText
  })})`);
  assert.notEqual(firstFingerprint, secondFingerprint, "equal-length middle changes collided");

  harness.setState({
    settings: { serviceUrl: "http://127.0.0.1:37621", pairingToken: "pair-token", projectId: "project-1" },
    source: {
      projectId: "project-1",
      title: "Current source",
      url: "https://example.com/current",
      kind: "page",
      text: "Current source text is long enough to form a valid source-backed deliverable."
    },
    lastAnswer: "This answer belongs to a previous source and must never be rebound.",
    lastAnswerSourceFingerprint: "previous-source-fingerprint"
  });

  await harness.context.createDeliverableFromCurrentSource();

  assert.equal(harness.fetchCalls.some((call) => call.path === "/v1/deliverables"), false);
  assert.match(harness.nodes.get("deliverableStatus").textContent, /另一个来源|错绑|阻止/);

  harness.context.markCurrentSourceFingerprint();
  assert.equal(harness.run("state.lastAnswer"), "");
  assert.equal(harness.run("state.lastAnswerSourceFingerprint"), "");
});

test("primary navigation exposes keyboard-accessible tab semantics and live status", async () => {
  const html = await projectFile("sidepanel.html");
  assert.match(html, /<nav class="tabs" role="tablist"/);
  assert.match(html, /id="tab-chat"[^>]*role="tab"[^>]*aria-selected="true"/);
  assert.match(html, /id="chat"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-chat"/);
  assert.match(html, /id="status"[^>]*(?:role="status"|aria-live="polite")/);
});

test("overlapping operations keep controls disabled until the final task releases busy state", async () => {
  const harness = await createSidepanelHarness();
  harness.context.setBusy(true);
  harness.context.setBusy(true);
  harness.context.setBusy(false);
  assert.equal(harness.run("state.busy"), true);
  assert.equal(harness.nodes.get("readPageBtn").disabled, true);

  harness.context.setBusy(false);
  assert.equal(harness.run("state.busy"), false);
  assert.equal(harness.nodes.get("readPageBtn").disabled, false);
});

test("PDF import requests OCR by default and reports applied, unnecessary, and fallback outcomes", async () => {
  const html = await projectFile("sidepanel.html");
  assert.match(html, /id="pdfOcrInput"[^>]*type="checkbox"[^>]*checked/);
  assert.match(html, /id="pdfImportStatus"/);

  const pdfResults = [
    {
      source: { id: "source-pdf-ocr", title: "Scanned PDF", text: "OCR text", project_id: "project-1" },
      pdf: {
        pages: 3,
        low_text: false,
        profile: "pdf-pypdf+macos-vision-ocr",
        ocr: { attempted: true, applied: true, engine: "tesseract", error: "", pages_replaced: 2 }
      }
    },
    {
      source: { id: "source-pdf-text", title: "Text PDF", text: "Text layer", project_id: "project-1" },
      pdf: {
        pages: 2,
        low_text: false,
        ocr: { attempted: false, applied: false, engine: "", error: "" }
      }
    },
    {
      source: { id: "source-pdf-fallback", title: "Fallback PDF", text: "Partial text", project_id: "project-1" },
      pdf: {
        pages: 4,
        low_text: true,
        ocr: { attempted: true, applied: false, engine: "tesseract", error: "OCR runtime unavailable" }
      }
    },
    {
      source: { id: "source-pdf-no-ocr", title: "OCR disabled PDF", text: "Text layer", project_id: "project-1" },
      pdf: {
        pages: 1,
        low_text: false,
        ocr: { attempted: false, applied: false, engine: "", error: "" }
      }
    }
  ];
  let pdfResultIndex = 0;
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/pdfs/extract") return { ok: true, ...pdfResults[pdfResultIndex++] };
      return { ok: true };
    }
  });
  harness.run("loadKnowledgeBase = async () => {};");
  harness.setState({
    settings: { serviceUrl: "http://127.0.0.1:37621", pairingToken: "pair-token", projectId: "project-1" }
  });
  harness.context.document.getElementById("pdfInput").value = "/tmp/scanned.pdf";
  harness.context.document.getElementById("pdfOcrInput").checked = true;

  await harness.context.ingestPdf();
  const firstPdfCall = harness.fetchCalls.find((call) => call.path === "/v1/pdfs/extract");
  assert.equal(firstPdfCall.body.ocr, true);
  assert.equal(firstPdfCall.body.path, "/tmp/scanned.pdf");
  assert.match(harness.nodes.get("batchStatus").textContent, /OCR 已应用.*tesseract/i);
  assert.match(harness.nodes.get("pdfImportStatus").textContent, /OCR 已应用.*tesseract/i);
  const ocrStats = JSON.parse(harness.run("JSON.stringify(state.source.stats)"));
  assert.equal(ocrStats.profile, "pdf-pypdf+macos-vision-ocr");
  assert.equal(ocrStats.ocrPagesReplaced, 2);

  await harness.context.ingestPdf();
  assert.match(harness.nodes.get("batchStatus").textContent, /未需 OCR/i);

  await harness.context.ingestPdf();
  assert.match(harness.nodes.get("batchStatus").textContent, /OCR 失败.*回退.*OCR runtime unavailable/i);
  assert.doesNotMatch(harness.nodes.get("batchStatus").textContent, /OCR 已应用/i);

  harness.nodes.get("pdfOcrInput").checked = false;
  await harness.context.ingestPdf();
  const pdfCalls = harness.fetchCalls.filter((call) => call.path === "/v1/pdfs/extract");
  assert.equal(pdfCalls[3].body.ocr, false);
  assert.match(harness.nodes.get("pdfImportStatus").textContent, /OCR 已关闭/i);
});

test("YouTube import automatically fetches captions when optional transcript is empty and preserves manual input", async () => {
  const html = await projectFile("sidepanel.html");
  assert.match(html, /for="youtubeTranscriptInput"[^>]*>[^<]*可选/i);
  assert.match(html, /id="youtubeLanguageInput"/);
  assert.match(html, /id="youtubeImportStatus"/);

  let resolveAutomatic;
  let youtubeRequestCount = 0;
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path !== "/v1/youtube/transcripts") return { ok: true };
      youtubeRequestCount += 1;
      if (youtubeRequestCount === 1) {
        return new Promise((resolve) => {
          resolveAutomatic = () => resolve({
            ok: true,
            source: {
              id: "source-youtube-auto",
              title: "Automatic captions",
              text: "Automatically fetched captions",
              project_id: "project-1"
            },
            youtube: { segments: 8, caption_source: "automatic", language: "zh-Hans" }
          });
        });
      }
      return {
        ok: true,
        source: {
          id: "source-youtube-manual",
          title: "Manual captions",
          text: "[00:00] pasted transcript",
          project_id: "project-1"
        },
        youtube: { segments: 1, source: "manual", language: "en" }
      };
    }
  });
  harness.run("refreshKnowledgeWorkspace = async () => {};");
  harness.setState({
    settings: { serviceUrl: "http://127.0.0.1:37621", pairingToken: "pair-token", projectId: "project-1" }
  });
  harness.context.document.getElementById("youtubeUrlInput").value = "";
  harness.context.document.getElementById("youtubeTitleInput").value = "Title without a URL";
  harness.context.document.getElementById("youtubeTranscriptInput").value = "[00:00] traceability still requires a URL";
  await harness.context.ingestYoutubeTranscript();
  assert.equal(youtubeRequestCount, 0, "title-only manual import reached the service");
  assert.match(harness.nodes.get("youtubeImportStatus").textContent, /有效.*YouTube URL/i);

  harness.nodes.get("youtubeUrlInput").value = "https://example.com/not-youtube";
  harness.nodes.get("youtubeTranscriptInput").value = "";
  await harness.context.ingestYoutubeTranscript();
  assert.equal(youtubeRequestCount, 0, "non-YouTube automatic import reached the service");
  assert.match(harness.nodes.get("batchStatus").textContent, /有效.*YouTube URL/i);

  harness.nodes.get("youtubeUrlInput").value = "https://www.youtube.com/watch?v=too-short";
  await harness.context.ingestYoutubeTranscript();
  assert.equal(youtubeRequestCount, 0, "short invalid video id reached automatic caption retrieval");
  assert.match(harness.nodes.get("youtubeImportStatus").textContent, /有效.*YouTube URL/i);

  harness.nodes.get("youtubeUrlInput").value = "https://www.youtube.com/watch?v=abc123xyz01";
  harness.nodes.get("youtubeTitleInput").value = "";
  harness.nodes.get("youtubeTranscriptInput").value = "";
  harness.nodes.get("youtubeLanguageInput").value = "zh-Hans,en";
  harness.context.syncYoutubeImportMode();
  assert.match(harness.nodes.get("ingestYoutubeBtn").textContent, /automatic/i);

  const automaticImport = harness.context.ingestYoutubeTranscript();
  await Promise.resolve();
  assert.match(harness.nodes.get("ingestYoutubeBtn").textContent, /automatic/i);
  assert.match(harness.nodes.get("batchStatus").textContent, /automatic.*zh-Hans,en/i);
  assert.match(harness.nodes.get("youtubeImportStatus").textContent, /automatic.*zh-Hans,en/i);
  resolveAutomatic();
  await automaticImport;

  const automaticCall = harness.fetchCalls.find((call) => call.path === "/v1/youtube/transcripts");
  assert.equal(automaticCall.body.transcript, "");
  assert.equal(automaticCall.body.language, "zh-Hans,en");
  assert.match(harness.nodes.get("batchStatus").textContent, /automatic.*zh-Hans/i);

  harness.nodes.get("youtubeTranscriptInput").value = "[00:00] pasted transcript";
  harness.nodes.get("youtubeLanguageInput").value = "en";
  harness.context.syncYoutubeImportMode();
  assert.match(harness.nodes.get("ingestYoutubeBtn").textContent, /manual/i);
  await harness.context.ingestYoutubeTranscript();

  const youtubeCalls = harness.fetchCalls.filter((call) => call.path === "/v1/youtube/transcripts");
  assert.equal(youtubeCalls[1].body.transcript, "[00:00] pasted transcript");
  assert.equal(youtubeCalls[1].body.language, "en");
  assert.match(harness.nodes.get("batchStatus").textContent, /manual.*en/i);
});

test("batch storage migrates legacy items once and isolates queues and sources by project", async () => {
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/captures") return { ok: true, source: { id: "unexpected-capture" } };
      return { ok: true };
    }
  });
  harness.storageState.batchQueue = [{
    id: "legacy-item",
    url: "https://example.com/legacy",
    status: "pending"
  }];
  harness.storageState.batchMetrics = { total: 1, concurrency: 2 };
  harness.storageState.batchConcurrency = 2;
  harness.setState({ settings: { serviceUrl: "http://127.0.0.1:37621", pairingToken: "pair-token", projectId: "project-a" } });

  await harness.context.loadBatchQueue();
  let snapshot = harness.stateSnapshot();
  assert.equal(snapshot.queue.length, 1);
  assert.equal(snapshot.queue[0].projectId, "project-a");
  assert.equal(harness.storageState.batchQueue[0].projectId, "project-a");

  harness.setState({ settings: { serviceUrl: "http://127.0.0.1:37621", pairingToken: "pair-token", projectId: "project-b" } });
  await harness.context.loadBatchQueue();
  snapshot = harness.stateSnapshot();
  assert.equal(snapshot.queue.length, 0, "project B inherited project A's legacy queue");
  harness.context.addUrlsToQueue(["https://example.com/project-b"]);
  await harness.context.saveBatchQueue();

  harness.setState({ settings: { serviceUrl: "http://127.0.0.1:37621", pairingToken: "pair-token", projectId: "project-a" } });
  await harness.context.loadBatchQueue();
  snapshot = harness.stateSnapshot();
  assert.deepEqual(snapshot.queue.map((item) => item.url), ["https://example.com/legacy"]);
  assert.ok(harness.storageState.batchQueue.some((item) => item.projectId === "project-b"));

  harness.setState({
    settings: { serviceUrl: "http://127.0.0.1:37621", pairingToken: "pair-token", projectId: "project-b" },
    source: {
      title: "Project A source",
      text: "This source belongs only to project A.",
      url: "https://example.com/project-a-source",
      kind: "page",
      projectId: "project-a",
      sourceId: "source-a"
    }
  });
  await assert.rejects(
    harness.context.ensureCurrentSourceCaptured(),
    /project-a|当前项目|属于/i
  );
  assert.equal(harness.fetchCalls.filter((call) => call.path === "/v1/captures").length, 0);
  assert.equal(
    harness.context.resetCurrentSourceAfterProjectChange("project-a", "project-b"),
    true
  );
  assert.equal(harness.run("state.source === null"), true, "project switch kept the previous source bound");

  const js = await projectFile("sidepanel.js");
  assert.match(js, /changeProject[\s\S]*resetCurrentSourceAfterProjectChange\(previousProjectId, nextProjectId\)/);
});

test("sidepanel consumes targeted selection claims live without overwriting an active source", async () => {
  let queued = [{
    id: "selection-a",
    text: "Window A selected text",
    title: "Window A title",
    url: "https://example.com/a",
    tabId: 41,
    windowId: 7,
    projectId: "project-a",
    capturedAt: "2026-01-01T00:00:00.000Z"
  }];
  const claimCalls = [];
  const harness = await createSidepanelHarness({
    runtimeMessageHandler: async (message) => {
      claimCalls.push(message);
      if (message.type !== "qc-smart-reader-claim-selection") return undefined;
      const index = queued.findIndex((item) => !message.selectionId || item.id === message.selectionId);
      if (index < 0) return { ok: true, selection: null, pendingCount: queued.length };
      const item = queued[index];
      if (item.projectId !== message.projectId) {
        return {
          ok: true,
          selection: null,
          pendingCount: queued.length,
          reason: "project_mismatch",
          selectionProjectId: item.projectId
        };
      }
      if (item.windowId !== message.windowId) {
        return { ok: true, selection: null, pendingCount: queued.length, reason: "target_mismatch" };
      }
      queued.splice(index, 1);
      return { ok: true, selection: item, pendingCount: queued.length };
    }
  });
  harness.setState({
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-a", pairingToken: "pair-token" }
  });

  assert.equal(await harness.context.hydratePendingSelection(), true);
  assert.equal(harness.run("state.source.title"), "Window A title");
  assert.equal(harness.run("state.source.projectId"), "project-a");
  assert.equal(queued.length, 0);
  assert.equal(claimCalls[0].tabId, 41);
  assert.equal(claimCalls[0].windowId, 7);

  queued = [{
    id: "selection-b",
    text: "Second selected text",
    title: "Second title",
    url: "https://example.com/b",
    tabId: 41,
    windowId: 7,
    projectId: "project-a",
    capturedAt: "2026-01-01T00:00:01.000Z"
  }];
  const callsBeforeNotification = claimCalls.length;
  harness.context.bindPendingSelectionMessages();
  assert.equal(harness.runtimeListeners.length, 1);
  harness.runtimeListeners[0]({
    type: "qc-smart-reader-selection-queued",
    selectionId: "selection-b",
    tabId: 41,
    windowId: 7
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.run("state.source.title"), "Window A title", "live delivery silently overwrote the active source");
  assert.equal(queued.length, 1, "an automatically deferred selection was removed from the queue");
  assert.equal(claimCalls.length, callsBeforeNotification, "automatic delivery claimed before checking the active source");
  assert.match(harness.nodes.get("status").textContent, /待载入|使用选中文本/);

  assert.equal(await harness.context.hydratePendingSelection(), true, "manual hydration did not consume the next queued selection");
  assert.equal(harness.run("state.source.title"), "Second title");
  assert.equal(queued.length, 0);

  harness.setState({ source: null });
  queued = [{
    id: "selection-other-window",
    text: "Other window text",
    title: "Other window title",
    url: "https://example.com/other-window",
    tabId: 202,
    windowId: 22,
    projectId: "project-a",
    capturedAt: "2026-01-01T00:00:02.000Z"
  }];
  const claimsBeforeOtherWindow = claimCalls.length;
  harness.runtimeListeners[0]({
    type: "qc-smart-reader-selection-queued",
    selectionId: "selection-other-window",
    tabId: 202,
    windowId: 22
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.run("state.source === null"), true, "a selection for another window was rendered");
  assert.equal(queued.length, 1, "a selection for another window was consumed");
  assert.equal(claimCalls.length, claimsBeforeOtherWindow, "another window's selection reached the claim endpoint");

  queued = [{
    id: "selection-live",
    text: "Live selected text",
    title: "Live title",
    url: "https://example.com/live",
    tabId: 41,
    windowId: 7,
    projectId: "project-a",
    capturedAt: "2026-01-01T00:00:03.000Z"
  }];
  harness.runtimeListeners[0]({
    type: "qc-smart-reader-selection-queued",
    selectionId: "selection-live",
    tabId: 41,
    windowId: 7
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.run("state.source.title"), "Live title", "same-window live selection was not rendered");
  assert.equal(harness.run("state.source.projectId"), "project-a");
  assert.equal(queued.length, 0, "same-window live selection was not atomically removed");
});

test("sidepanel surfaces queue overflow instead of pretending the newest selection was loaded", async () => {
  const harness = await createSidepanelHarness({
    runtimeMessageHandler: async (message) => {
      if (message.type !== "qc-smart-reader-claim-selection") return undefined;
      return { ok: true, selection: null, pendingCount: 20, reason: "queue_full" };
    }
  });
  harness.setState({
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-a", pairingToken: "pair-token" },
    source: null
  });

  assert.equal(await harness.context.hydratePendingSelection({ noticeId: "notice-1" }), false);
  assert.match(harness.nodes.get("status").textContent, /已达上限.*20|20.*未入队|没有覆盖/);
  assert.equal(harness.run("state.source === null"), true);
});

test("fallback knowledge base migrates legacy notes and isolates save, load, export, and clear by project", async () => {
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/notes" || call.path === "/v1/export" || call.path === "/v1/captures") {
        return { ok: false, status: 503, error: "companion unavailable" };
      }
      return { ok: true };
    }
  });
  harness.storageState.knowledgeBase = [
    { id: "legacy", title: "Legacy note", answer: "legacy secret" },
    { id: "note-a", projectId: "project-a", title: "Project A note", answer: "A secret" },
    { id: "note-b", project_id: "project-b", title: "Project B note", answer: "B visible" }
  ];
  harness.setState({
    settings: { serviceUrl: "http://127.0.0.1:37621", pairingToken: "pair-token", projectId: "project-b" }
  });

  await harness.context.loadKnowledgeBase();
  const rendered = harness.nodes.get("kbList").children.map((node) => node.innerHTML).join("\n");
  assert.match(rendered, /Project B note/);
  assert.doesNotMatch(rendered, /Project A note|Legacy note/);
  assert.equal(
    harness.storageState.knowledgeBase.find((note) => note.id === "legacy").projectId,
    "default",
    "legacy fallback notes must migrate deterministically to the original default project"
  );
  assert.equal(harness.storageState.knowledgeBase.find((note) => note.id === "note-b").projectId, "project-b");

  harness.run(`
    globalThis.__fallbackDownload = null;
    downloadTextFile = async (content, filename, mime) => {
      globalThis.__fallbackDownload = { content, filename, mime };
    };
  `);
  await harness.context.exportKnowledgeBase("json");
  const exported = JSON.parse(harness.run("globalThis.__fallbackDownload.content"));
  assert.deepEqual(exported.map((note) => note.id), ["note-b"]);

  await harness.context.clearKnowledgeBase();
  assert.deepEqual(
    harness.storageState.knowledgeBase.map((note) => note.id).sort(),
    ["legacy", "note-a"],
    "clearing project B removed fallback notes belonging to another project"
  );

  harness.setState({
    source: {
      title: "Project B source",
      text: "Offline source text",
      url: "https://example.com/project-b",
      kind: "page",
      projectId: "project-b"
    },
    lastAnswer: "Offline answer"
  });
  harness.context.document.getElementById("questionInput").value = "Offline question";
  harness.run("state.lastAnswerSourceFingerprint = sourceFingerprint(state.source)");
  await harness.context.saveCurrentNote();
  const saved = harness.storageState.knowledgeBase.find((note) => note.title === "Project B source");
  assert.equal(saved.projectId, "project-b");
});

test("offline notes reject 4xx fallback, remain visible with Vault notes, and sync idempotently after ACK", async () => {
  const html = await projectFile("sidepanel.html");
  for (const id of ["pendingNotesStatus", "syncPendingNotesBtn"]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }

  let mode = "auth";
  let notePosts = 0;
  const vaultNotes = [{
    id: "vault-note",
    project_id: "project-b",
    title: "Vault note",
    answer: "Already durable",
    tags: []
  }];
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/captures") {
        if (mode === "auth") return { ok: false, status: 401, error: "invalid pairing token" };
        if (mode === "offline") return { ok: false, status: 503, error: "companion unavailable" };
        return { ok: true, source: { id: "source-synced", project_id: "project-b" } };
      }
      if (call.path === "/v1/notes" && call.method === "GET") {
        return { ok: true, notes: vaultNotes };
      }
      if (call.path === "/v1/notes" && call.method === "POST") {
        notePosts += 1;
        const created = {
          id: "vault-from-pending",
          project_id: call.body.project_id,
          source_id: call.body.source_id,
          title: call.body.title,
          answer: call.body.answer,
          tags: call.body.tags
        };
        vaultNotes.unshift(created);
        return { ok: false, status: 503, error: "response lost after commit" };
      }
      return { ok: true };
    }
  });
  assert.equal(harness.run(`(() => { const error = new Error("HTTP 409"); error.status = 409; return isOfflineFallbackError(error); })()`), false);
  assert.equal(harness.run(`(() => { const error = new Error("版本不兼容"); error.status = 503; return isOfflineFallbackError(error); })()`), false);
  assert.equal(harness.run(`(() => { const error = new Error("service unavailable"); error.status = 503; return isOfflineFallbackError(error); })()`), true);
  harness.setState({
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-b", pairingToken: "pair-token" },
    source: {
      title: "Auth rejected source",
      text: "This note must not silently fall back when authentication is invalid.",
      url: "https://example.com/auth",
      kind: "page",
      projectId: "project-b"
    },
    lastAnswer: "Auth answer"
  });
  harness.nodes.get("questionInput") ?? harness.context.document.getElementById("questionInput");
  harness.nodes.get("questionInput").value = "Auth question";
  harness.run("state.lastAnswerSourceFingerprint = sourceFingerprint(state.source)");

  await harness.context.saveCurrentNote();

  assert.equal((harness.storageState.knowledgeBase || []).length, 0, "401 created an offline fallback note");
  assert.match(harness.nodes.get("status").textContent, /保存失败.*未.*待同步/);

  mode = "offline";
  harness.setState({
    source: {
      title: "Offline source",
      text: "This note is durable in Chrome until the companion service acknowledges it.",
      url: "https://example.com/offline",
      kind: "page",
      projectId: "project-b"
    },
    lastAnswer: "Offline answer"
  });
  harness.nodes.get("questionInput").value = "Offline question";
  harness.run("state.lastAnswerSourceFingerprint = sourceFingerprint(state.source)");
  await harness.context.saveCurrentNote();

  const pending = harness.storageState.knowledgeBase.find((note) => note.title === "Offline source");
  assert.equal(pending.projectId, "project-b");
  assert.equal(pending.pendingSync, true);
  harness.storageState.knowledgeBase.push({
    id: "other-project-pending",
    projectId: "project-a",
    title: "Other project pending",
    answer: "Must remain isolated",
    pendingSync: true
  });

  mode = "recovered";
  await harness.context.loadKnowledgeBase();
  const rendered = harness.nodes.get("kbList").children.map((node) => node.innerHTML).join("\n");
  assert.match(rendered, /Vault note/);
  assert.match(rendered, /Offline source/);
  assert.doesNotMatch(rendered, /Other project pending/);
  assert.match(harness.nodes.get("pendingNotesStatus").textContent, /待同步 1 条/);
  assert.equal(harness.nodes.get("syncPendingNotesBtn").disabled, false);

  await harness.context.syncPendingNotes();
  assert.equal(notePosts, 1);
  assert.ok(harness.storageState.knowledgeBase.some((note) => note.id === pending.id), "pending cleared without ACK");

  await harness.context.syncPendingNotes();
  assert.equal(notePosts, 1, "ambiguous retry posted a duplicate note instead of recognizing its sync tag");
  assert.ok(!harness.storageState.knowledgeBase.some((note) => note.id === pending.id));
  assert.ok(harness.storageState.knowledgeBase.some((note) => note.id === "other-project-pending"));
  assert.match(harness.nodes.get("pendingNotesStatus").textContent, /待同步 0 条/);
});

test("restore selects only the current project's service-owned batch", async () => {
  const jobs = [
    {
      id: "job-a",
      type: "read",
      status: "accepted",
      input: { project_id: "project-a" }
    },
    {
      id: "job-b",
      type: "read",
      status: "accepted",
      input: { project_id: "project-b" }
    }
  ];
  const details = Object.fromEntries(jobs.map((summary) => [summary.id, {
    ...summary,
    items: [{
      id: `item-${summary.id}`,
      url: `https://example.com/${summary.id}`,
      status: "pending",
      input: { project_id: summary.input.project_id }
    }]
  }]));
  const harness = await createSidepanelHarness({
    fetchHandler: async (call) => {
      if (call.path === "/v1/jobs") return { ok: true, jobs };
      const jobId = call.path.split("/")[3];
      if (call.path.endsWith("/recover")) return { ok: true, job: details[jobId] };
      if (details[jobId]) return { ok: true, job: details[jobId] };
      return { ok: true };
    }
  });
  harness.setState({
    settings: { serviceUrl: "http://127.0.0.1:37621", pairingToken: "pair-token", projectId: "project-b" },
    batchQueue: []
  });

  await harness.context.restoreBatchFromCompanion();

  const snapshot = harness.stateSnapshot();
  assert.deepEqual(snapshot.queue.map((item) => item.url), ["https://example.com/job-b"]);
  assert.ok(snapshot.queue.every((item) => item.projectId === "project-b"));
  assert.ok(!harness.fetchCalls.some((call) => call.path.startsWith("/v1/jobs/job-a")));
});

test("sidepanel renders batch progress, ETA, and item timing metadata", async () => {
  const js = await projectFile("sidepanel.js");
  const css = await projectFile("sidepanel.css");

  assert.match(js, /batchMetrics: \{/);
  assert.match(js, /chrome\.storage\.local\.get\(\[[\s\S]*"batchQueue"[\s\S]*"batchMetricsByProject"[\s\S]*"batchConcurrencyByProject"[\s\S]*\]\)/);
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
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-1", pairingToken: "pair-token" }
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
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-1", pairingToken: "pair-token" }
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
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-1", pairingToken: "pair-token" },
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
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-1", pairingToken: "pair-token" },
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
  assert.equal(reextractCall.body.mode, "mock");
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
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-1", pairingToken: "pair-token" },
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
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-1", pairingToken: "pair-token" },
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
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-1", pairingToken: "pair-token" },
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
      assert.equal(call.body.executor_id, "extension-uuid-1-worker-1");
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
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-1", pairingToken: "pair-token" },
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
    input: { project_id: "project-1" },
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
        return { ok: true, jobs: [{ id: job.id, type: "read", status: job.status, input: job.input }] };
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
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-1", pairingToken: "pair-token" },
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
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-1", pairingToken: "pair-token" },
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
  let captureCount = 0;
  let activeCaptures = 0;
  let maxActiveCaptures = 0;
  const claimAssignments = [];
  const heartbeatOwners = [];
  const statusOwners = [];
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
        const owner = call.body.executor_id;
        let item = job.items.find((candidate) => candidate.status === "running" && candidate.lease_owner === owner) || null;
        if (!item) item = job.items.find((candidate) => candidate.status === "pending") || null;
        if (item) {
          item.status = "running";
          item.lease_owner = owner;
          claimAssignments.push({ itemId: item.id, owner });
          return { ok: true, job, item };
        }
        return { ok: true, job, item: null, reason: "drained" };
      }
      if (call.path.endsWith("/heartbeat")) {
        const item = job.items.find((candidate) => call.path.includes(candidate.id)) || job.items[0];
        heartbeatOwners.push({ itemId: item.id, owner: call.body.executor_id, leaseOwner: item.lease_owner });
        return { ok: true, job, item };
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
          statusOwners.push({ itemId: item.id, owner: call.body.executor_id, leaseOwner: item.lease_owner });
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
    settings: { serviceUrl: "http://127.0.0.1:37621", projectId: "project-1", pairingToken: "pair-token" },
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
  const firstOwnerByItem = new Map(claimAssignments.map((entry) => [entry.itemId, entry.owner]));
  assert.equal(new Set(firstOwnerByItem.values()).size, 2, "concurrent workers reused one executor id");
  assert.equal(firstOwnerByItem.size, 2, "one service item was claimed by multiple workers");
  assert.ok(heartbeatOwners.length >= 2);
  assert.ok(heartbeatOwners.every((entry) => entry.owner === firstOwnerByItem.get(entry.itemId)));
  assert.ok(statusOwners.every((entry) => entry.owner === firstOwnerByItem.get(entry.itemId)));
});
