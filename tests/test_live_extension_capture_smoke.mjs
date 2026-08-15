import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { extensionServiceWorker, launchPersistentChromium } from "./browser_runtime.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_PYTHON = process.env.QC_TEST_PYTHON || "python3";
const COMPANION_START_TIMEOUT_MS = Number(process.env.QC_COMPANION_START_TIMEOUT_MS || 30000);

function extensionLaunchOptions(hostResolverRule, locale = "") {
  const options = {
    headless: true,
    channel: "chromium",
    args: [
      `--host-resolver-rules=${hostResolverRule}`,
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`
    ]
  };
  if (locale) {
    options.locale = locale;
    options.args.unshift(`--lang=${locale}`);
  }
  return options;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function waitForServer(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function startFixtureServer(routes) {
  const server = createServer((request, response) => {
    const route = routes.get(request.url);
    if (route !== undefined) {
      const spec = typeof route === "string" ? { body: route } : route;
      const body = spec.body || "";
      const delayMs = Number(spec.delayMs || 0);
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(body);
      }, delayMs);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  const port = await waitForServer(server);
  return { server, port };
}

function startCompanion(dataDir, port) {
  const child = spawn(
    TEST_PYTHON,
    ["companion_service/server.py", "--host", "127.0.0.1", "--port", String(port), "--data-dir", dataDir],
    {
      cwd: ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  let spawnError;
  let exitStatus;
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("exit", (code, signal) => {
    exitStatus = { code, signal };
  });
  return {
    child,
    output: () => output.trim(),
    failure: () => {
      if (spawnError) return `${TEST_PYTHON} could not start: ${spawnError.message}`;
      if (exitStatus) {
        const result = exitStatus.signal ? `signal ${exitStatus.signal}` : `code ${exitStatus.code}`;
        return `${TEST_PYTHON} exited before becoming healthy (${result})`;
      }
      return "";
    }
  };
}

async function waitForHealth(serviceUrl, companion, timeoutMs = COMPANION_START_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const failure = companion.failure();
    if (failure) {
      throw new Error(`${failure}\nservice output:\n${companion.output()}`);
    }
    try {
      const response = await fetch(`${serviceUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response.json();
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const state = companion.failure() || `${TEST_PYTHON} was still running after ${timeoutMs} ms`;
  throw new Error(
    `service did not become healthy: ${serviceUrl}\nservice state: ${state}\nservice output:\n${companion.output()}`
  );
}

async function waitForInteractiveSidepanel(sidepanel) {
  await sidepanel.waitForFunction(() => (
    document.documentElement.dataset.qcInteractiveReady === "true" &&
    document.body.inert === false &&
    document.body.getAttribute("aria-busy") === "false"
  ));
}

async function waitForSources(serviceUrl, token, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const data = await serviceJson(serviceUrl, token, "/v1/sources?limit=10");
      if ((data.sources || []).length) return data.sources;
    } catch {
      // Service is still committing the capture.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("source was not captured by live extension smoke");
}

async function serviceJson(serviceUrl, token, path, options = {}) {
  const requestOptions = { ...options };
  const headers = {
    ...(options.headers || {}),
    "x-qc-pairing-token": token
  };
  if (
    requestOptions.body &&
    typeof requestOptions.body !== "string" &&
    !(requestOptions.body instanceof ArrayBuffer) &&
    !(ArrayBuffer.isView(requestOptions.body))
  ) {
    requestOptions.body = JSON.stringify(requestOptions.body);
    headers["content-type"] = headers["content-type"] || "application/json";
  }
  const response = await fetch(`${serviceUrl}${path}`, {
    ...requestOptions,
    headers
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`invalid JSON from ${path}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(`service request failed ${response.status} ${path}: ${text.slice(0, 500)}`);
  }
  return data;
}

async function waitForBatchJobSuccess(serviceUrl, token, fixtureUrl, timeoutMs = 15000) {
  const started = Date.now();
  let lastState = "no job";
  while (Date.now() - started < timeoutMs) {
    const found = await findBatchJobItem(serviceUrl, token, fixtureUrl);
    if (found) {
      const { job, item } = found;
      lastState = `${job.id}/${item.id}: ${item.status}${item.error ? ` (${item.error})` : ""}`;
      if (item.status === "success" && item.source_id) {
        return { job, item };
      }
      if (["failed", "skipped", "canceled"].includes(item.status)) {
        throw new Error(`batch item ended unexpectedly: ${lastState}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`service-owned batch job did not complete; last state: ${lastState}`);
}

async function findBatchJobItem(serviceUrl, token, fixtureUrl) {
  const listing = await serviceJson(serviceUrl, token, "/v1/jobs?limit=10");
  for (const summary of listing.jobs || []) {
    const detail = await serviceJson(serviceUrl, token, `/v1/jobs/${encodeURIComponent(summary.id)}`);
    const job = detail.job || {};
    const item = (job.items || []).find((candidate) => (
      candidate.url === fixtureUrl ||
      candidate.input?.url === fixtureUrl
    ));
    if (item) return { job, item };
  }
  return null;
}

async function waitForBatchJobItem(serviceUrl, token, fixtureUrl, predicate, timeoutMs = 15000) {
  const started = Date.now();
  let lastState = "no job";
  while (Date.now() - started < timeoutMs) {
    const found = await findBatchJobItem(serviceUrl, token, fixtureUrl);
    if (found) {
      const { job, item } = found;
      lastState = `${job.id}/${item.id}: job=${job.status} item=${item.status}${item.error ? ` (${item.error})` : ""}`;
      if (predicate(found)) return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`batch item did not reach expected state; last state: ${lastState}`);
}

async function waitForJobEvent(serviceUrl, token, jobId, eventType, predicate = () => true, timeoutMs = 15000) {
  const started = Date.now();
  let lastTypes = "";
  while (Date.now() - started < timeoutMs) {
    const events = await serviceJson(serviceUrl, token, `/v1/jobs/${encodeURIComponent(jobId)}/events?limit=300`);
    lastTypes = (events.events || []).map((event) => event.event_type).join(", ");
    const match = (events.events || []).find((event) => event.event_type === eventType && predicate(event));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`job event ${eventType} was not recorded; events: ${lastTypes}`);
}

async function waitForKnowledgeRecords(serviceUrl, token, predicate, timeoutMs = 15000) {
  const started = Date.now();
  let lastCounts = "no records";
  while (Date.now() - started < timeoutMs) {
    const records = await serviceJson(serviceUrl, token, "/v1/knowledge/records?limit=50&project_id=default");
    lastCounts = `claims=${(records.claims || []).length} evidence=${(records.evidence || []).length}`;
    if (predicate(records)) return records;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`knowledge records did not reach expected state; last counts: ${lastCounts}`);
}

async function createQualityCaseCapture(serviceUrl, token, suffix, contentOverrides = {}) {
  const text = contentOverrides.text || `${suffix} quality gate source text. `.repeat(40);
  return serviceJson(serviceUrl, token, "/v1/captures", {
    method: "POST",
    body: {
      project_id: "default",
      source: {
        kind: "article",
        url: `https://quality.example/${suffix}`,
        title: `Quality Gate ${suffix}`,
        site: "quality-fixture",
        captured_at: new Date().toISOString()
      },
      content: {
        text,
        markdown: text,
        blocks: contentOverrides.blocks || [{ type: "paragraph", text }],
        images: contentOverrides.images || [],
        attachments: contentOverrides.attachments || [],
        links: contentOverrides.links || [],
        next_pages: contentOverrides.next_pages || [],
        stats: contentOverrides.stats || {}
      },
      browser: {}
    }
  });
}

async function markRunningJobItemsStale(dataDir, jobId) {
  const script = `
import sqlite3
import sys

db_path, job_id = sys.argv[1], sys.argv[2]
old = "2000-01-01T00:00:00+00:00"
db = sqlite3.connect(db_path)
try:
    db.execute(
        """
        UPDATE job_items
        SET started_at = ?, updated_at = ?, lease_expires_at = ?, heartbeat_at = ?
        WHERE job_id = ? AND status = 'running'
        """,
        (old, old, old, old, job_id),
    )
    db.commit()
finally:
    db.close()
`;
  await execFilePromise(TEST_PYTHON, ["-c", script, join(dataDir, "state", "qc_smart_reader.sqlite3"), jobId], { cwd: ROOT });
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    }, 2000);
    child.once("exit", () => {
      clearTimeout(forceTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

test("live extension routes queued selections to the matching open side-panel window", async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-selection-chrome-"));
  let browserContext;
  try {
    browserContext = await launchPersistentChromium(
      t,
      userDataDir,
      extensionLaunchOptions("MAP selection-fixture.localhost 127.0.0.1")
    );
    if (!browserContext) return;

    const worker = await extensionServiceWorker(t, browserContext);
    if (!worker) return;
    const extensionId = new URL(worker.url()).host;
    assert.ok(extensionId, "extension id was not available");
    const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;

    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        settings: {
          serviceUrl: "http://127.0.0.1:9",
          pairingToken: "",
          projectId: "default",
          provider: "openai",
          baseUrl: "",
          model: ""
        }
      });
      await chrome.storage.session.remove(["pendingSelection", "pendingSelections"]);
    });

    const sidepanelA = await browserContext.newPage();
    await sidepanelA.goto(sidepanelUrl);
    const sidepanelBPromise = browserContext.waitForEvent("page");
    await sidepanelA.evaluate((url) => chrome.windows.create({ url, type: "normal" }), sidepanelUrl);
    const sidepanelB = await sidepanelBPromise;
    await sidepanelB.waitForLoadState("domcontentloaded");
    await Promise.all([
      waitForInteractiveSidepanel(sidepanelA),
      waitForInteractiveSidepanel(sidepanelB)
    ]);

    const panelA = await sidepanelA.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      const window = await chrome.windows.getCurrent();
      return { tabId: tab?.id, windowId: window?.id };
    });
    const panelB = await sidepanelB.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      const window = await chrome.windows.getCurrent();
      return { tabId: tab?.id, windowId: window?.id };
    });
    assert.notEqual(panelA.windowId, panelB.windowId, "fixture did not create two browser windows");

    const selections = [
      {
        id: "live-selection-a",
        text: "Selected only for window A",
        title: "Selection A",
        url: "https://selection-fixture.localhost/a",
        tabId: panelA.tabId,
        windowId: panelA.windowId,
        projectId: "default",
        capturedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "live-selection-b",
        text: "Selected only for window B",
        title: "Selection B",
        url: "https://selection-fixture.localhost/b",
        tabId: panelB.tabId,
        windowId: panelB.windowId,
        projectId: "default",
        capturedAt: "2026-01-01T00:00:01.000Z"
      }
    ];
    await worker.evaluate(async (items) => {
      await chrome.storage.session.set({ pendingSelections: items });
    }, selections);

    for (const selection of selections) {
      await worker.evaluate(async (item) => {
        try {
          await chrome.runtime.sendMessage({
            type: "qc-smart-reader-selection-queued",
            selectionId: item.id,
            tabId: item.tabId,
            windowId: item.windowId
          });
        } catch (_error) {
          // Delivery is asserted in the side-panel DOM below.
        }
      }, selection);
    }

    // First-run onboarding may intentionally keep the capture panel hidden until
    // the local service is paired. Selection routing must still hydrate the
    // project-bound source without forcing users away from onboarding.
    await sidepanelA.waitForFunction(() => document.querySelector("#sourceTitle")?.textContent === "Selection A");
    await sidepanelB.waitForFunction(() => document.querySelector("#sourceTitle")?.textContent === "Selection B");
    assert.equal(await sidepanelA.locator("#sourceUrl").textContent(), "https://selection-fixture.localhost/a");
    assert.equal(await sidepanelB.locator("#sourceUrl").textContent(), "https://selection-fixture.localhost/b");
    assert.notEqual(await sidepanelA.locator("#sourceTitle").textContent(), "Selection B");
    assert.notEqual(await sidepanelB.locator("#sourceTitle").textContent(), "Selection A");
    const remaining = await worker.evaluate(async () => {
      const { pendingSelections = [] } = await chrome.storage.session.get("pendingSelections");
      return pendingSelections;
    });
    assert.deepEqual(remaining, [], "live side panels did not atomically consume both selections");
  } finally {
    if (browserContext) await browserContext.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("live extension batch capture smoke saves a QuantClass fixture through companion service", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const companion = startCompanion(dataDir, servicePort);
  const service = companion.child;
  let browserContext;
  let fixtureServer;

  try {
    await waitForHealth(serviceUrl, companion);
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const fixtureHtml = await readFile(new URL("./fixtures/quantclass_thread.html", import.meta.url), "utf8");
    const fixture = await startFixtureServer(new Map([["/thread/87030", fixtureHtml]]));
    fixtureServer = fixture.server;
    const fixturePort = fixture.port;
    const fixtureUrl = `http://bbs.quantclass.localhost:${fixturePort}/thread/87030`;

    browserContext = await launchPersistentChromium(
      t,
      userDataDir,
      extensionLaunchOptions("MAP bbs.quantclass.localhost 127.0.0.1")
    );
    if (!browserContext) return;

    const worker = await extensionServiceWorker(t, browserContext);
    if (!worker) return;
    const extensionId = new URL(worker.url()).host;
    assert.ok(extensionId, "extension id was not available");

    const sidepanel = await browserContext.newPage();
    await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await sidepanel.evaluate(
      ({ serviceUrl: targetServiceUrl, token: pairingToken }) => chrome.storage.local.set({
        settings: {
          serviceUrl: targetServiceUrl,
          pairingToken,
          projectId: "default",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5",
          temperature: 0.2
        }
      }),
      { serviceUrl, token }
    );
    await sidepanel.reload({ waitUntil: "domcontentloaded" });
    await waitForInteractiveSidepanel(sidepanel);
    await sidepanel.locator('button[data-tab="batch"]').click();
    await sidepanel.locator("#batchUrlsInput").fill(fixtureUrl);
    await sidepanel.locator("#enqueueBatchBtn").click();
    await sidepanel.locator("#processBatchBtn").click();

    const { job, item } = await waitForBatchJobSuccess(serviceUrl, token, fixtureUrl);
    const events = await serviceJson(serviceUrl, token, `/v1/jobs/${encodeURIComponent(job.id)}/events?limit=100`);
    const itemEvents = (events.events || []).filter((event) => event.item_id === item.id);
    const itemEventTypes = new Set(itemEvents.map((event) => event.event_type));
    assert.ok(itemEventTypes.has("item_claimed"), "service-owned claim-next path was not used");
    assert.ok(itemEventTypes.has("item_capture"), "capture pipeline event was not recorded");
    assert.ok(itemEventTypes.has("item_quality_gate"), "quality gate pipeline event was not recorded");
    assert.ok(item.result?.pagination_checkpoint?.next_pages?.length, "pagination checkpoint was not persisted on the job item");

    const sources = await waitForSources(serviceUrl, token);
    const captured = sources.find((source) => source.url === fixtureUrl || source.title.includes("长上影线"));
    assert.ok(captured, `captured source not found in ${JSON.stringify(sources)}`);
    assert.equal(captured.site, "quantclass");
    assert.match(captured.title, /长上影线/);
    assert.ok(["new", "needs_review"].includes(captured.status));
    assert.equal(captured.id, item.source_id);

    const detail = (await serviceJson(serviceUrl, token, `/v1/sources/${encodeURIComponent(item.source_id)}`)).source;
    assert.equal(detail.site, "quantclass");
    assert.equal(detail.kind, "thread");
    assert.match(detail.text, /cadmean/);
    assert.match(detail.text, /upper_shadow_count_5d/);
    assert.equal(detail.quality_flags.pagination_needed, true);
    assert.equal(detail.quality_flags.attachment_missing, true);
    assert.deepEqual(detail.quality_flags.next_pages, ["https://bbs.quantclass.cn/thread/87030?page=2"]);
    assert.ok((detail.chunks || []).length, "source chunks were not persisted");
    assert.equal((detail.attachments || [])[0]?.filename, "upper-shadow.zip");

    await createQualityCaseCapture(serviceUrl, token, "low-text", {
      text: "too short for source quality gate",
      stats: { lowText: true }
    });
    await createQualityCaseCapture(serviceUrl, token, "truncated", {
      text: "Truncated quality gate source with enough body text for dashboard visibility. ".repeat(20),
      stats: {
        quality: 80,
        truncated: true,
        truncation: {
          comments: { total: 130, kept: 119, limit: 119, truncated: true }
        }
      }
    });
    await createQualityCaseCapture(serviceUrl, token, "login-wall", {
      text: "Login wall quality gate source with enough body text for dashboard visibility. ".repeat(20),
      stats: { quality: 80, authRequired: true }
    });

    const dashboard = (await serviceJson(serviceUrl, token, "/v1/projects/default/dashboard")).dashboard;
    const issueCounts = dashboard.metrics.source_quality_issue_counts || {};
    assert.equal(dashboard.metrics.source_quality_blocker_count, 4);
    for (const key of ["low_quality", "low_text", "truncated", "auth_required", "pagination_needed", "attachment_missing"]) {
      assert.equal(issueCounts[key], 1, `expected one ${key} blocker`);
    }

    await sidepanel.locator('button[data-tab="settings"]').click();
    await sidepanel.locator("#refreshProjectsBtn").click();
    await sidepanel.waitForFunction(() => {
      const text = document.querySelector("#projectDashboard")?.textContent || "";
      return (
        text.includes("抽取质量问题") &&
        text.includes("low_quality=1") &&
        text.includes("low_text=1") &&
        text.includes("truncated=1") &&
        text.includes("auth_required=1") &&
        text.includes("pagination_needed=1") &&
        text.includes("attachment_missing=1")
      );
    }, null, { timeout: 15000 });
  } finally {
    if (browserContext) await browserContext.close();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    await terminate(service);
    await rm(dataDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("live extension reads current page and renders structured knowledge records", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const companion = startCompanion(dataDir, servicePort);
  const service = companion.child;
  let browserContext;
  let fixtureServer;

  try {
    await waitForHealth(serviceUrl, companion);
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const fixtureHtml = (await readFile(new URL("./fixtures/quantclass_thread.html", import.meta.url), "utf8"))
      .replace(/长上影线是卖出还是买入信号？/g, "Knowledge UI 结构化抽取")
      .replace(
        "所以做了简单验证。",
        "所以做了简单验证。 Knowledge UI evidence chain strategy backtest risk validation should be extracted as a cited claim."
      );
    const fixture = await startFixtureServer(new Map([["/thread/knowledge-ui", fixtureHtml]]));
    fixtureServer = fixture.server;
    const fixtureUrl = `http://bbs.quantclass.localhost:${fixture.port}/thread/knowledge-ui`;

    browserContext = await launchPersistentChromium(
      t,
      userDataDir,
      extensionLaunchOptions("MAP bbs.quantclass.localhost 127.0.0.1")
    );
    if (!browserContext) return;

    const worker = await extensionServiceWorker(t, browserContext);
    if (!worker) return;
    const extensionId = new URL(worker.url()).host;
    assert.ok(extensionId, "extension id was not available");

    const sidepanel = await browserContext.newPage();
    await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await sidepanel.evaluate(
      ({ serviceUrl: targetServiceUrl, token: pairingToken }) => chrome.storage.local.set({
        settings: {
          serviceUrl: targetServiceUrl,
          pairingToken,
          projectId: "default",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5",
          temperature: 0.2
        }
      }),
      { serviceUrl, token }
    );
    await sidepanel.reload({ waitUntil: "domcontentloaded" });
    await waitForInteractiveSidepanel(sidepanel);

    const fixturePage = await browserContext.newPage();
    await fixturePage.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
    await fixturePage.bringToFront();
    await sidepanel.evaluate(() => document.querySelector("#readPageBtn")?.click());
    await sidepanel.waitForFunction(() => document.querySelector("#sourceTitle")?.textContent.includes("Knowledge UI 结构化抽取"), null, { timeout: 15000 });
    await sidepanel.waitForFunction(() => document.querySelector("#sourcePreview")?.textContent.includes("quantclass"), null, { timeout: 15000 });

    await sidepanel.locator('button[data-tab="knowledge"]').click();
    await sidepanel.locator("#extractKnowledgeBtn").click();
    await sidepanel.waitForFunction(() => document.querySelector("#knowledgeRecordStatus")?.textContent.includes("已抽取草稿"), null, { timeout: 20000 });
    await sidepanel.waitForFunction(() => {
      const text = document.querySelector("#knowledgeRecordList")?.textContent || "";
      return text.includes("结构化记录") && text.includes("主张") && text.includes("证据");
    }, null, { timeout: 15000 });

    const records = await waitForKnowledgeRecords(
      serviceUrl,
      token,
      (data) => (data.claims || []).length > 0 && (data.evidence || []).length > 0,
      15000
    );
    const claim = records.claims.find((item) => (item.text || "").includes("Knowledge UI evidence chain"));
    assert.ok(claim, `expected extracted claim in ${JSON.stringify(records.claims)}`);
    assert.equal(claim.evidence_count, 1);
    const evidence = records.evidence.find((item) => item.claim_id === claim.id);
    assert.ok(evidence, "claim evidence was not persisted");
    assert.ok(evidence.chunk_id, "evidence chunk id was not persisted");
    assert.match(evidence.quote, /Knowledge UI evidence chain/);

    const sources = await waitForSources(serviceUrl, token);
    const source = sources.find((item) => item.url === fixtureUrl || item.title.includes("Knowledge UI"));
    assert.ok(source, `captured source not found in ${JSON.stringify(sources)}`);
    assert.ok(["extracted", "needs_review"].includes(source.status));
    const detail = (await serviceJson(serviceUrl, token, `/v1/sources/${encodeURIComponent(source.id)}`)).source;
    assert.match(detail.text, /Knowledge UI evidence chain/);
    assert.ok((detail.chunks || []).length, "source chunks were not available after UI extraction");

    const statusText = await sidepanel.locator("#knowledgeRecordStatus").textContent();
    assert.match(statusText || "", /run arun_/);
    const listText = await sidepanel.locator("#knowledgeRecordList").textContent();
    assert.match(listText || "", /Knowledge UI evidence chain/);
  } finally {
    if (browserContext) await browserContext.close();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    await terminate(service);
    await rm(dataDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

async function exerciseCleanProfileFirstEvidence(t, { browserLocale, htmlLang, decisionStatus }) {
  const dataDir = await mkdtemp(join(tmpdir(), `qc-live-first-evidence-${htmlLang}-service-`));
  const userDataDir = await mkdtemp(join(tmpdir(), `qc-live-first-evidence-${htmlLang}-chrome-`));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const companion = startCompanion(dataDir, servicePort);
  const service = companion.child;
  let browserContext;
  let fixtureServer;

  try {
    await waitForHealth(serviceUrl, companion);
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const localizedTitle = htmlLang === "zh-CN"
      ? "First Evidence 简体中文 clean-profile 验收"
      : "First Evidence en-US clean-profile acceptance";
    const localizedQuote = htmlLang === "zh-CN"
      ? "First Evidence 中文路径必须保留来源中的 exact quote，并让用户明确做出支持或不支持判断。"
      : "First Evidence must preserve the exact source quote and wait for the user to mark the claim supported or unsupported.";
    const fixtureHtml = (await readFile(new URL("./fixtures/quantclass_thread.html", import.meta.url), "utf8"))
      .replace(/长上影线是卖出还是买入信号？/g, localizedTitle)
      .replace("所以做了简单验证。", localizedQuote);
    const fixture = await startFixtureServer(new Map([["/thread/first-evidence", fixtureHtml]]));
    fixtureServer = fixture.server;
    const fixtureUrl = `http://bbs.quantclass.localhost:${fixture.port}/thread/first-evidence`;

    browserContext = await launchPersistentChromium(
      t,
      userDataDir,
      extensionLaunchOptions("MAP bbs.quantclass.localhost 127.0.0.1", browserLocale)
    );
    if (!browserContext) return null;

    const worker = await extensionServiceWorker(t, browserContext);
    if (!worker) return null;
    const extensionId = new URL(worker.url()).host;
    assert.ok(extensionId, "extension id was not available");
    const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;

    const sidepanel = await browserContext.newPage();
    await sidepanel.goto(sidepanelUrl);
    await waitForInteractiveSidepanel(sidepanel);
    await sidepanel.waitForFunction((expected) => document.documentElement.lang === expected, htmlLang);
    assert.equal(await sidepanel.locator("html").getAttribute("lang"), htmlLang);
    assert.equal(await sidepanel.locator("#uiLocaleSelect").inputValue(), "auto");
    assert.equal(
      await worker.evaluate(async () => (await chrome.storage.local.get("uiLocale")).uiLocale),
      undefined,
      "clean-profile Auto locale must not persist an explicit language preference"
    );
    assert.equal(await sidepanel.locator("#providerSelect").inputValue(), "mock");
    assert.equal(await sidepanel.locator("#quickStartCard").isHidden(), true);

    await sidepanel.locator("#serviceUrlInput").fill(serviceUrl);
    await sidepanel.locator("#pairingTokenInput").fill(token);
    await sidepanel.locator("#testCompanionBtn").click();
    await sidepanel.waitForFunction(() => {
      const status = document.querySelector("#settingsStatus");
      const quickStart = document.querySelector("#quickStartCard");
      return status?.dataset.i18nDynamicKey === "settings.status.success" && !quickStart?.hidden;
    }, null, { timeout: 15000 });
    const pairingStatus = await sidepanel.locator("#settingsStatus").textContent();
    assert.match(
      pairingStatus || "",
      htmlLang === "zh-CN"
        ? /本地服务和 Pairing Token 均正常/
        : /Local Companion and Pairing Token are ready/
    );
    assert.equal(await sidepanel.locator("#modelDataConsentRow").isHidden(), true);

    const fixturePage = await browserContext.newPage();
    await fixturePage.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
    await fixturePage.bringToFront();
    await sidepanel.evaluate(() => document.querySelector("#quickStartBtn")?.click());
    await sidepanel.waitForFunction(() => {
      const card = document.querySelector("#quickStartEvidence");
      const claim = document.querySelector("#quickStartClaimText")?.textContent || "";
      const quote = document.querySelector("#quickStartQuoteText")?.textContent || "";
      return card && !card.hidden && claim.length > 10 && quote.length > 10;
    }, null, { timeout: 30000 });
    assert.equal(await sidepanel.locator("#quickStartProgress").textContent(), "2 / 3");
    assert.equal(
      await sidepanel.evaluate(() => document.activeElement?.id || ""),
      "quickStartEvidence",
      "First Evidence must receive focus when it is revealed"
    );

    const firstEvidence = await sidepanel.evaluate(() => ({
      claimId: document.querySelector("#quickStartEvidence")?.dataset.claimId || "",
      evidenceId: document.querySelector("#quickStartEvidence")?.dataset.evidenceId || "",
      claim: document.querySelector("#quickStartClaimText")?.textContent || "",
      quote: document.querySelector("#quickStartQuoteText")?.textContent || "",
      reviewStatus: document.querySelector("#quickStartReviewStatus")?.textContent || "",
      reviewStatusKey: document.querySelector("#quickStartReviewStatus")?.dataset.i18nDynamicKey || ""
    }));
    assert.ok(firstEvidence.claimId, "Quick Start did not expose a real claim id");
    assert.ok(firstEvidence.evidenceId, "Quick Start did not expose a real evidence id");
    assert.equal(firstEvidence.reviewStatusKey, "firstEvidence.review.pending");
    assert.match(
      firstEvidence.reviewStatus,
      htmlLang === "zh-CN" ? /这段原文是否支持这条 claim/ : /Does this exact quote support the claim/
    );
    assert.equal(await sidepanel.locator("#quickStartAcceptClaimBtn").isVisible(), true);
    assert.equal(await sidepanel.locator("#quickStartRejectClaimBtn").isVisible(), true);
    assert.equal(await sidepanel.locator("#quickStartAcceptClaimBtn").isDisabled(), false);
    assert.equal(await sidepanel.locator("#quickStartRejectClaimBtn").isDisabled(), false);

    const capturedSources = await waitForSources(serviceUrl, token);
    const capturedSource = capturedSources.find((source) => source.url === fixtureUrl);
    assert.ok(capturedSource, "Quick Start did not persist the current page before extraction");
    const capturedDetail = (
      await serviceJson(serviceUrl, token, `/v1/sources/${encodeURIComponent(capturedSource.id)}`)
    ).source;
    assert.ok(
      capturedDetail.text.includes(firstEvidence.quote),
      `displayed quote was not exact source text: ${JSON.stringify(firstEvidence.quote)}`
    );

    assert.equal(await sidepanel.locator("#quickStartReplayBtn").isVisible(), true);
    assert.equal(await sidepanel.locator("#quickStartReplayBtn").getAttribute("aria-expanded"), "false");
    assert.equal(await sidepanel.locator("#quickStartReplayPanel").isHidden(), true);
    await sidepanel.locator("#quickStartReplayBtn").click();
    await sidepanel.waitForFunction(() => {
      const panel = document.querySelector("#quickStartReplayPanel");
      return panel
        && !panel.hidden
        && Boolean(panel.dataset.replayStatus);
    }, null, { timeout: 15000 });
    const replaySnapshot = await sidepanel.evaluate(() => {
      const panel = document.querySelector("#quickStartReplayPanel");
      return {
        status: panel?.dataset.replayStatus || "",
        reason: panel?.querySelector(".replay-reason")?.textContent || "",
        locator: panel?.querySelector("[data-replay-locator]")?.textContent || "",
        quote: panel?.querySelector("[data-replay-exact-quote]")?.textContent || "",
        context: panel?.querySelector("[data-replay-context]")?.textContent || "",
        sourceUrl: panel?.querySelector("[data-replay-source-link]")?.getAttribute("href") || ""
      };
    });
    assert.equal(
      replaySnapshot.status,
      "resolved",
      `Source Replay was not resolved: ${JSON.stringify(replaySnapshot)}`
    );
    assert.ok(replaySnapshot.locator, "Source Replay did not expose a captured locator");
    assert.equal(replaySnapshot.quote, firstEvidence.quote);
    assert.ok(
      replaySnapshot.context.includes(firstEvidence.quote),
      "Source Replay context did not contain the exact stored quote"
    );
    assert.match(replaySnapshot.sourceUrl, /^https?:\/\//);

    let records = await waitForKnowledgeRecords(
      serviceUrl,
      token,
      (data) => (data.claims || []).some((claim) => claim.id === firstEvidence.claimId),
      15000
    );
    assert.equal(
      ["reviewed", "rejected"].includes(
        records.claims.find((claim) => claim.id === firstEvidence.claimId)?.status
      ),
      false,
      "Quick Start made a decision before the user chose supported or unsupported"
    );

    const decisionButton = decisionStatus === "rejected"
      ? "#quickStartRejectClaimBtn"
      : "#quickStartAcceptClaimBtn";
    const savedStatusKey = decisionStatus === "rejected"
      ? "firstEvidence.review.rejectedSaved"
      : "firstEvidence.review.accepted";
    await sidepanel.locator(decisionButton).click();
    await sidepanel.waitForFunction(({ expectedStatus, expectedStatusKey }) => {
      const card = document.querySelector("#quickStartEvidence");
      const status = document.querySelector("#quickStartReviewStatus");
      const accept = document.querySelector("#quickStartAcceptClaimBtn");
      const reject = document.querySelector("#quickStartRejectClaimBtn");
      const progress = document.querySelector("#quickStartProgress");
      return card?.dataset.claimStatus === expectedStatus
        && status?.dataset.i18nDynamicKey === expectedStatusKey
        && accept?.disabled
        && reject?.disabled
        && progress?.textContent === "3 / 3";
    }, { expectedStatus: decisionStatus, expectedStatusKey: savedStatusKey }, { timeout: 15000 });

    records = await waitForKnowledgeRecords(
      serviceUrl,
      token,
      (data) => (data.claims || []).some((claim) => (
        claim.id === firstEvidence.claimId && claim.status === decisionStatus
      )),
      15000
    );
    const decided = records.claims.find((claim) => claim.id === firstEvidence.claimId);
    assert.equal(decided?.status, decisionStatus);

    const localProgress = await worker.evaluate(async () => (
      await chrome.storage.local.get("onboardingMilestones")
    ).onboardingMilestones);
    assert.ok(localProgress.capturedAt);
    assert.ok(localProgress.claimReadyAt);
    assert.ok(localProgress.firstDecisionAt);
    assert.equal(localProgress.firstDecisionStatus, decisionStatus);
    assert.equal(Boolean(localProgress.firstReviewedAt), decisionStatus === "reviewed");
    assert.equal(localProgress.projectId, "default");
    assert.equal(localProgress.firstClaimId, firstEvidence.claimId);
    assert.equal("claim" in localProgress, false, "claim content should not be copied into local milestones");
    assert.equal("quote" in localProgress, false, "quote content should not be copied into local milestones");

    await sidepanel.close();
    const reopened = await browserContext.newPage();
    await reopened.goto(sidepanelUrl);
    await waitForInteractiveSidepanel(reopened);
    await reopened.waitForFunction((claimId) => {
      const card = document.querySelector("#quickStartEvidence");
      return card && !card.hidden && card.dataset.claimId === claimId;
    }, firstEvidence.claimId, { timeout: 20000 });
    assert.equal(await reopened.locator("html").getAttribute("lang"), htmlLang);
    assert.equal(await reopened.locator("#uiLocaleSelect").inputValue(), "auto");
    assert.equal(await reopened.locator("#quickStartClaimText").textContent(), firstEvidence.claim);
    assert.equal(await reopened.locator("#quickStartQuoteText").textContent(), firstEvidence.quote);
    assert.equal(await reopened.locator("#quickStartProgress").textContent(), "3 / 3");
    await reopened.locator('button[data-tab="knowledge"]').click();
    assert.equal(
      await reopened.locator("#quickStartReplayBtn").isVisible(),
      true,
      "restored Source Replay controls were hidden in the Knowledge tab"
    );
    await reopened.locator("#quickStartReplayBtn").click();
    await reopened.waitForFunction((expectedQuote) => {
      const panel = document.querySelector("#quickStartReplayPanel");
      return panel
        && !panel.hidden
        && panel.dataset.replayStatus === "resolved"
        && panel.querySelector("[data-replay-exact-quote]")?.textContent === expectedQuote;
    }, firstEvidence.quote, { timeout: 15000 });
    assert.equal(
      await reopened.locator("#quickStartEvidence").getAttribute("data-claim-status"),
      decisionStatus
    );
    assert.equal(
      await reopened.locator("#quickStartReviewStatus").getAttribute("data-i18n-dynamic-key"),
      decisionStatus === "rejected"
        ? "firstEvidence.review.rejected"
        : "firstEvidence.review.reviewed"
    );
    assert.equal(await reopened.locator("#quickStartAcceptClaimBtn").isDisabled(), true);
    assert.equal(await reopened.locator("#quickStartRejectClaimBtn").isDisabled(), true);
    assert.equal(
      await reopened.locator("#quickStartStatus").getAttribute("data-i18n-dynamic-key"),
      "quickStart.restore.prefix"
    );
    assert.match(
      await reopened.locator("#quickStartStatus").textContent() || "",
      htmlLang === "zh-CN" ? /已恢复本地进度/ : /Restored local progress/
    );
    return { firstEvidence, decisionStatus };
  } finally {
    if (browserContext) await browserContext.close();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    await terminate(service);
    await rm(dataDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
}

test("en-US Auto locale clean profile accepts supported First Evidence and restores reviewed state", async (t) => {
  await exerciseCleanProfileFirstEvidence(t, {
    browserLocale: "en-US",
    htmlLang: "en",
    decisionStatus: "reviewed"
  });
});

test("zh-CN Auto locale clean profile rejects unsupported First Evidence and restores rejected state", async (t) => {
  await exerciseCleanProfileFirstEvidence(t, {
    browserLocale: "zh-CN",
    htmlLang: "zh-CN",
    decisionStatus: "rejected"
  });
});

test("live extension current page uses browser site profile bundle for GitHub issue threads", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const companion = startCompanion(dataDir, servicePort);
  const service = companion.child;
  let browserContext;
  let fixtureServer;

  try {
    await waitForHealth(serviceUrl, companion);
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const fixtureHtml = await readFile(new URL("./fixtures/github_issue.html", import.meta.url), "utf8");
    const fixture = await startFixtureServer(new Map([["/org/repo/issues/34", fixtureHtml]]));
    fixtureServer = fixture.server;
    const fixtureUrl = `http://github.com.localhost:${fixture.port}/org/repo/issues/34`;

    browserContext = await launchPersistentChromium(
      t,
      userDataDir,
      extensionLaunchOptions("MAP github.com.localhost 127.0.0.1")
    );
    if (!browserContext) return;

    const worker = await extensionServiceWorker(t, browserContext);
    if (!worker) return;
    const extensionId = new URL(worker.url()).host;
    assert.ok(extensionId, "extension id was not available");

    const sidepanel = await browserContext.newPage();
    await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await sidepanel.evaluate(
      ({ serviceUrl: targetServiceUrl, token: pairingToken }) => chrome.storage.local.set({
        settings: {
          serviceUrl: targetServiceUrl,
          pairingToken,
          projectId: "default",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5",
          temperature: 0.2
        }
      }),
      { serviceUrl, token }
    );
    await sidepanel.reload({ waitUntil: "domcontentloaded" });
    await waitForInteractiveSidepanel(sidepanel);

    const fixturePage = await browserContext.newPage();
    await fixturePage.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
    await fixturePage.bringToFront();
    await sidepanel.evaluate(() => document.querySelector("#readPageBtn")?.click());
    await sidepanel.waitForFunction(() => document.querySelector("#sourceTitle")?.textContent.includes("Fix stale source quality blockers"), null, { timeout: 15000 });
    await sidepanel.waitForFunction(() => {
      const text = document.querySelector("#sourcePreview")?.textContent || "";
      return text.includes("profile: github-issue")
        && /(?:comments|评论): 1/.test(text)
        && /(?:attachments|附件): 1/.test(text);
    }, null, { timeout: 15000 });

    await sidepanel.locator('button[data-tab="knowledge"]').click();
    await sidepanel.locator("#extractKnowledgeBtn").click();
    await sidepanel.waitForFunction(() => document.querySelector("#knowledgeRecordStatus")?.textContent.includes("已抽取草稿"), null, { timeout: 20000 });

    const sources = await waitForSources(serviceUrl, token);
    const source = sources.find((item) => item.url === fixtureUrl || item.title.includes("Fix stale source quality blockers"));
    assert.ok(source, `captured GitHub issue source not found in ${JSON.stringify(sources)}`);
    const detail = (await serviceJson(serviceUrl, token, `/v1/sources/${encodeURIComponent(source.id)}`)).source;
    assert.equal(detail.site, "github");
    assert.equal(detail.kind, "thread");
    assert.equal(detail.quality_flags.attachment_missing, true);
    assert.notEqual(detail.quality_flags.missing_title, true);
    assert.notEqual(detail.quality_flags.missing_url, true);
    assert.notEqual(detail.quality_flags.truncated, true);
    assert.deepEqual(detail.quality_flags.next_pages || [], []);
    assert.notEqual(detail.quality_flags.pagination_needed, true);
    assert.notEqual(detail.quality_flags.auth_required, true);
    assert.notEqual(detail.quality_flags.low_text, true);
    assert.notEqual(detail.quality_flags.low_quality, true);
    assert.equal(detail.alias_urls[0].canonical_url, fixtureUrl);
    assert.equal(detail.versions[0].version_index, 1);
    assert.equal(detail.attachments[0].filename, "quality-gate-repro.zip");
    assert.equal(detail.chunks.length >= 1, true);
    assert.match(detail.text, /Expected behavior/);
    assert.match(detail.text, /source\.status/);
    assert.equal((detail.attachments || []).length, 1);
  } finally {
    if (browserContext) await browserContext.close();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    await terminate(service);
    await rm(dataDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("live extension service-owned batch emits heartbeat while a background tab is slow", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const companion = startCompanion(dataDir, servicePort);
  const service = companion.child;
  let browserContext;
  let fixtureServer;

  try {
    await waitForHealth(serviceUrl, companion);
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const fixtureHtml = await readFile(new URL("./fixtures/quantclass_thread.html", import.meta.url), "utf8");
    const fixture = await startFixtureServer(new Map([[
      "/thread/heartbeat",
      { body: fixtureHtml.replace("长上影线是卖出还是买入信号？", "Heartbeat 慢页面测试"), delayMs: 900 }
    ]]));
    fixtureServer = fixture.server;
    const fixtureUrl = `http://bbs.quantclass.localhost:${fixture.port}/thread/heartbeat`;

    browserContext = await launchPersistentChromium(
      t,
      userDataDir,
      extensionLaunchOptions("MAP bbs.quantclass.localhost 127.0.0.1")
    );
    if (!browserContext) return;

    const worker = await extensionServiceWorker(t, browserContext);
    if (!worker) return;
    const extensionId = new URL(worker.url()).host;
    assert.ok(extensionId, "extension id was not available");

    const sidepanel = await browserContext.newPage();
    await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await sidepanel.evaluate(
      ({ serviceUrl: targetServiceUrl, token: pairingToken }) => chrome.storage.local.set({
        settings: {
          serviceUrl: targetServiceUrl,
          pairingToken,
          projectId: "default",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5",
          temperature: 0.2,
          batchHeartbeatIntervalMs: 100
        }
      }),
      { serviceUrl, token }
    );
    await sidepanel.reload({ waitUntil: "domcontentloaded" });
    await waitForInteractiveSidepanel(sidepanel);
    await sidepanel.locator('button[data-tab="batch"]').click();
    await sidepanel.locator("#batchUrlsInput").fill(fixtureUrl);
    await sidepanel.locator("#enqueueBatchBtn").click();
    await sidepanel.locator("#processBatchBtn").click();

    const { job, item } = await waitForBatchJobSuccess(serviceUrl, token, fixtureUrl, 20000);
    const events = await serviceJson(serviceUrl, token, `/v1/jobs/${encodeURIComponent(job.id)}/events?limit=200`);
    const itemEvents = (events.events || []).filter((event) => event.item_id === item.id);
    const heartbeatEvents = itemEvents.filter((event) => event.event_type === "item_heartbeat");
    assert.ok(heartbeatEvents.length >= 1, `expected item_heartbeat event, got ${itemEvents.map((event) => event.event_type).join(", ")}`);
    assert.ok(itemEvents.some((event) => event.event_type === "item_claimed"), "claim event was not recorded");
    assert.ok(itemEvents.some((event) => event.event_type === "item_status" && event.data?.status === "success"), "success status event was not recorded");
    assert.equal(item.status, "success");
    assert.ok(item.source_id, "slow page source id was not persisted");
  } finally {
    if (browserContext) await browserContext.close();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    await terminate(service);
    await rm(dataDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("live extension service-owned batch pauses and resumes through companion job state", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const companion = startCompanion(dataDir, servicePort);
  const service = companion.child;
  let browserContext;
  let fixtureServer;

  try {
    await waitForHealth(serviceUrl, companion);
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const fixtureHtml = await readFile(new URL("./fixtures/quantclass_thread.html", import.meta.url), "utf8");
    const firstHtml = fixtureHtml
      .replace("长上影线是卖出还是买入信号？", "Pause Resume 慢页面 A")
      .replace("</body>", "<p>pause-resume-unique-a</p></body>");
    const secondHtml = fixtureHtml
      .replace("长上影线是卖出还是买入信号？", "Pause Resume 后续页面 B")
      .replace("</body>", "<p>pause-resume-unique-b</p></body>");
    const fixture = await startFixtureServer(new Map([
      ["/thread/pause-a", { body: firstHtml, delayMs: 1200 }],
      ["/thread/pause-b", secondHtml]
    ]));
    fixtureServer = fixture.server;
    const firstUrl = `http://bbs.quantclass.localhost:${fixture.port}/thread/pause-a`;
    const secondUrl = `http://bbs.quantclass.localhost:${fixture.port}/thread/pause-b`;

    browserContext = await launchPersistentChromium(
      t,
      userDataDir,
      extensionLaunchOptions("MAP bbs.quantclass.localhost 127.0.0.1")
    );
    if (!browserContext) return;

    const worker = await extensionServiceWorker(t, browserContext);
    if (!worker) return;
    const extensionId = new URL(worker.url()).host;
    assert.ok(extensionId, "extension id was not available");

    const sidepanel = await browserContext.newPage();
    await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await sidepanel.evaluate(
      ({ serviceUrl: targetServiceUrl, token: pairingToken }) => chrome.storage.local.set({
        settings: {
          serviceUrl: targetServiceUrl,
          pairingToken,
          projectId: "default",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5",
          temperature: 0.2,
          batchHeartbeatIntervalMs: 100
        }
      }),
      { serviceUrl, token }
    );
    await sidepanel.reload({ waitUntil: "domcontentloaded" });
    await waitForInteractiveSidepanel(sidepanel);
    await sidepanel.locator('button[data-tab="batch"]').click();
    await sidepanel.locator("#batchUrlsInput").fill(`${firstUrl}\n${secondUrl}`);
    await sidepanel.locator("#enqueueBatchBtn").click();
    await sidepanel.locator("#processBatchBtn").click();

    const running = await waitForBatchJobItem(serviceUrl, token, firstUrl, ({ item }) => item.status === "running");
    await sidepanel.locator("#pauseBatchBtn").click();
    await waitForJobEvent(serviceUrl, token, running.job.id, "job_paused");
    await waitForBatchJobSuccess(serviceUrl, token, firstUrl, 20000);
    await waitForBatchJobItem(
      serviceUrl,
      token,
      secondUrl,
      ({ job, item }) => job.status === "paused" && item.status === "pending",
      20000
    );

    await sidepanel.waitForFunction(() => !document.querySelector("#processBatchBtn")?.disabled, null, { timeout: 10000 });
    await sidepanel.locator("#processBatchBtn").click();
    const resumedSecond = await waitForBatchJobSuccess(serviceUrl, token, secondUrl, 20000);
    await waitForJobEvent(serviceUrl, token, resumedSecond.job.id, "job_resumed");

    const events = await serviceJson(serviceUrl, token, `/v1/jobs/${encodeURIComponent(resumedSecond.job.id)}/events?limit=300`);
    const jobEventTypes = new Set((events.events || []).filter((event) => !event.item_id).map((event) => event.event_type));
    assert.ok(jobEventTypes.has("job_paused"), "pause event was not recorded");
    assert.ok(jobEventTypes.has("job_resumed"), "resume event was not recorded");
    assert.equal(resumedSecond.job.items.filter((item) => item.status === "success").length, 2);
  } finally {
    if (browserContext) await browserContext.close();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    await terminate(service);
    await rm(dataDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("live extension service-owned batch cancel keeps unclaimed items canceled", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const companion = startCompanion(dataDir, servicePort);
  const service = companion.child;
  let browserContext;
  let fixtureServer;

  try {
    await waitForHealth(serviceUrl, companion);
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const fixtureHtml = await readFile(new URL("./fixtures/quantclass_thread.html", import.meta.url), "utf8");
    const firstHtml = fixtureHtml
      .replace("长上影线是卖出还是买入信号？", "Cancel 慢页面 A")
      .replace("</body>", "<p>cancel-unique-a</p></body>");
    const secondHtml = fixtureHtml
      .replace("长上影线是卖出还是买入信号？", "Cancel 未开始页面 B")
      .replace("</body>", "<p>cancel-unique-b</p></body>");
    const fixture = await startFixtureServer(new Map([
      ["/thread/cancel-a", { body: firstHtml, delayMs: 1200 }],
      ["/thread/cancel-b", secondHtml]
    ]));
    fixtureServer = fixture.server;
    const firstUrl = `http://bbs.quantclass.localhost:${fixture.port}/thread/cancel-a`;
    const secondUrl = `http://bbs.quantclass.localhost:${fixture.port}/thread/cancel-b`;

    browserContext = await launchPersistentChromium(
      t,
      userDataDir,
      extensionLaunchOptions("MAP bbs.quantclass.localhost 127.0.0.1")
    );
    if (!browserContext) return;

    const worker = await extensionServiceWorker(t, browserContext);
    if (!worker) return;
    const extensionId = new URL(worker.url()).host;
    assert.ok(extensionId, "extension id was not available");

    const sidepanel = await browserContext.newPage();
    await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await sidepanel.evaluate(
      ({ serviceUrl: targetServiceUrl, token: pairingToken }) => chrome.storage.local.set({
        settings: {
          serviceUrl: targetServiceUrl,
          pairingToken,
          projectId: "default",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5",
          temperature: 0.2,
          batchHeartbeatIntervalMs: 100
        }
      }),
      { serviceUrl, token }
    );
    await sidepanel.reload({ waitUntil: "domcontentloaded" });
    await waitForInteractiveSidepanel(sidepanel);
    await sidepanel.locator('button[data-tab="batch"]').click();
    await sidepanel.locator("#batchUrlsInput").fill(`${firstUrl}\n${secondUrl}`);
    await sidepanel.locator("#enqueueBatchBtn").click();
    await sidepanel.locator("#processBatchBtn").click();

    const running = await waitForBatchJobItem(serviceUrl, token, firstUrl, ({ item }) => item.status === "running");
    sidepanel.once("dialog", (dialog) => dialog.accept());
    await sidepanel.locator("#cancelBatchBtn").click();
    await waitForJobEvent(serviceUrl, token, running.job.id, "job_canceled");
    await waitForBatchJobItem(serviceUrl, token, firstUrl, ({ job, item }) => job.status === "canceled" && item.status === "canceled");
    await waitForBatchJobItem(serviceUrl, token, secondUrl, ({ job, item }) => job.status === "canceled" && item.status === "canceled");
    await waitForJobEvent(
      serviceUrl,
      token,
      running.job.id,
      "item_status_ignored",
      (event) => event.item_id === running.item.id && event.data?.status === "success",
      20000
    );

    const events = await serviceJson(serviceUrl, token, `/v1/jobs/${encodeURIComponent(running.job.id)}/events?limit=300`);
    const secondItem = (await findBatchJobItem(serviceUrl, token, secondUrl)).item;
    const secondItemEvents = (events.events || []).filter((event) => event.item_id === secondItem.id);
    assert.ok(secondItemEvents.some((event) => event.event_type === "item_canceled"), "unclaimed item cancel event was not recorded");
    assert.ok(!secondItemEvents.some((event) => event.event_type === "item_claimed"), "unclaimed item should not be claimed after cancel");
    assert.ok((events.events || []).some((event) => event.event_type === "job_canceled"), "job cancel event was not recorded");
  } finally {
    if (browserContext) await browserContext.close();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    await terminate(service);
    await rm(dataDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("live extension restores and resumes a service-owned batch after Chromium closes mid-job", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const restartedUserDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-restart-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const companion = startCompanion(dataDir, servicePort);
  const service = companion.child;
  let browserContext;
  let restartedBrowserContext;
  let fixtureServer;

  try {
    await waitForHealth(serviceUrl, companion);
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const fixtureHtml = await readFile(new URL("./fixtures/quantclass_thread.html", import.meta.url), "utf8");
    const firstHtml = fixtureHtml
      .replace("长上影线是卖出还是买入信号？", "Restart 恢复慢页面 A")
      .replace("所以做了简单验证。", "所以做了简单验证。 restart-unique-a");
    const secondHtml = fixtureHtml
      .replace("长上影线是卖出还是买入信号？", "Restart 恢复页面 B")
      .replace("所以做了简单验证。", "所以做了简单验证。 restart-unique-b");
    const fixture = await startFixtureServer(new Map([
      ["/thread/restart-a", { body: firstHtml, delayMs: 2500 }],
      ["/thread/restart-b", secondHtml]
    ]));
    fixtureServer = fixture.server;
    const firstUrl = `http://bbs.quantclass.localhost:${fixture.port}/thread/restart-a`;
    const secondUrl = `http://bbs.quantclass.localhost:${fixture.port}/thread/restart-b`;

    const launchExtension = async (profileDir) => {
      return launchPersistentChromium(
        t,
        profileDir,
        extensionLaunchOptions("MAP bbs.quantclass.localhost 127.0.0.1")
      );
    };

    const openConfiguredSidepanel = async (context) => {
      const worker = await extensionServiceWorker(t, context);
      if (!worker) return null;
      const extensionId = new URL(worker.url()).host;
      assert.ok(extensionId, "extension id was not available");
      const sidepanel = await context.newPage();
      await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await sidepanel.evaluate(
        ({ serviceUrl: targetServiceUrl, token: pairingToken }) => chrome.storage.local.set({
          settings: {
            serviceUrl: targetServiceUrl,
            pairingToken,
            projectId: "default",
            provider: "openai",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-5",
            temperature: 0.2,
            batchHeartbeatIntervalMs: 100
          }
        }),
        { serviceUrl, token }
      );
      await sidepanel.reload({ waitUntil: "domcontentloaded" });
      await waitForInteractiveSidepanel(sidepanel);
      await sidepanel.locator('button[data-tab="batch"]').click();
      return sidepanel;
    };

    browserContext = await launchExtension(userDataDir);
    if (!browserContext) return;
    const sidepanel = await openConfiguredSidepanel(browserContext);
    if (!sidepanel) return;
    await sidepanel.locator("#batchUrlsInput").fill(`${firstUrl}\n${secondUrl}`);
    await sidepanel.locator("#enqueueBatchBtn").click();
    await sidepanel.locator("#processBatchBtn").click();

    const running = await waitForBatchJobItem(serviceUrl, token, firstUrl, ({ item }) => item.status === "running");
    await browserContext.close();
    browserContext = null;
    await markRunningJobItemsStale(dataDir, running.job.id);

    restartedBrowserContext = await launchExtension(restartedUserDataDir);
    if (!restartedBrowserContext) return;
    const restartedSidepanel = await openConfiguredSidepanel(restartedBrowserContext);
    if (!restartedSidepanel) return;
    await restartedSidepanel.locator("#restoreBatchBtn").click();
    await waitForJobEvent(serviceUrl, token, running.job.id, "item_recovered", (event) => event.item_id === running.item.id);
    await waitForBatchJobItem(
      serviceUrl,
      token,
      firstUrl,
      ({ job, item }) => job.id === running.job.id && item.status === "failed" && item.error_category === "stuck_running"
    );

    const eventsBeforeRestartProcess = await serviceJson(
      serviceUrl,
      token,
      `/v1/jobs/${encodeURIComponent(running.job.id)}/events?limit=400`
    );
    const priorEventIds = new Set((eventsBeforeRestartProcess.events || []).map((event) => event.id));
    assert.ok(
      (eventsBeforeRestartProcess.events || []).some((event) => (
        event.event_type === "job_retry_failed" && event.data?.reset_count === 0
      )),
      "initial batch preparation did not record its zero-item retry event"
    );
    assert.ok(
      (eventsBeforeRestartProcess.events || []).some((event) => event.event_type === "job_resumed"),
      "initial batch preparation did not record its resume event"
    );

    await restartedSidepanel.waitForFunction(() => !document.querySelector("#processBatchBtn")?.disabled, null, { timeout: 10000 });
    await restartedSidepanel.locator("#processBatchBtn").click();
    await waitForJobEvent(
      serviceUrl,
      token,
      running.job.id,
      "job_retry_failed",
      (event) => !priorEventIds.has(event.id) && event.data?.reset_count === 1
    );
    await waitForJobEvent(
      serviceUrl,
      token,
      running.job.id,
      "job_resumed",
      (event) => !priorEventIds.has(event.id)
    );

    const finalFirst = await waitForBatchJobItem(serviceUrl, token, firstUrl, ({ item }) => item.status === "success" && item.source_id, 30000);
    const finalSecond = await waitForBatchJobItem(serviceUrl, token, secondUrl, ({ item }) => item.status === "success" && item.source_id, 30000);
    const finalJob = await waitForBatchJobItem(
      serviceUrl,
      token,
      firstUrl,
      ({ job }) => job.status === "success" && job.progress === 1 && job.items.every((item) => item.status === "success"),
      30000
    );
    assert.equal(finalFirst.job.id, running.job.id);
    assert.equal(finalSecond.job.id, running.job.id);
    assert.equal(finalJob.job.id, running.job.id);
    assert.equal(finalJob.job.status, "success");
    assert.equal(finalJob.job.progress, 1);
    assert.ok(finalFirst.item.attempts >= 2, `expected recovered item to be claimed again, got attempts=${finalFirst.item.attempts}`);
    assert.equal(finalJob.job.items.filter((item) => item.status === "running").length, 0);

    const firstDetail = (await serviceJson(serviceUrl, token, `/v1/sources/${encodeURIComponent(finalFirst.item.source_id)}`)).source;
    const secondDetail = (await serviceJson(serviceUrl, token, `/v1/sources/${encodeURIComponent(finalSecond.item.source_id)}`)).source;
    assert.equal(firstDetail.site, "quantclass");
    assert.equal(firstDetail.kind, "thread");
    assert.match(firstDetail.text, /restart-unique-a/);
    assert.equal(secondDetail.site, "quantclass");
    assert.equal(secondDetail.kind, "thread");
    assert.match(secondDetail.text, /restart-unique-b/);

    const events = await serviceJson(serviceUrl, token, `/v1/jobs/${encodeURIComponent(running.job.id)}/events?limit=400`);
    const eventTypes = new Set((events.events || []).map((event) => event.event_type));
    assert.ok(eventTypes.has("job_recover"), "job recover event was not recorded");
    assert.ok(eventTypes.has("item_recovered"), "stuck running item recovery event was not recorded");
    assert.ok(eventTypes.has("job_retry_failed"), "failed-item retry event was not recorded");
    assert.ok(eventTypes.has("job_resumed"), "job resumed event was not recorded");
    assert.ok((events.events || []).some((event) => event.item_id === running.item.id && event.event_type === "item_retry"));
    assert.ok((events.events || []).some((event) => event.item_id === running.item.id && event.event_type === "item_capture"));
    assert.ok((events.events || []).some((event) => event.item_id === running.item.id && event.event_type === "item_quality_gate"));
    assert.ok((events.events || []).filter((event) => event.item_id === running.item.id && event.event_type === "item_claimed").length >= 2);
  } finally {
    if (browserContext) await browserContext.close();
    if (restartedBrowserContext) await restartedBrowserContext.close();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    await terminate(service);
    await rm(dataDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
    await rm(restartedUserDataDir, { recursive: true, force: true });
  }
});

test("live extension batch capture smoke preserves QuantClass multi-page continuation", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const companion = startCompanion(dataDir, servicePort);
  const service = companion.child;
  let browserContext;
  let fixtureServer;

  try {
    await waitForHealth(serviceUrl, companion);
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const page1Html = await readFile(new URL("./fixtures/quantclass_thread_multipage_page1.html", import.meta.url), "utf8");
    const page2Html = await readFile(new URL("./fixtures/quantclass_thread_multipage_page2.html", import.meta.url), "utf8");
    const fixture = await startFixtureServer(new Map([
      ["/thread/88000", page1Html],
      ["/thread/88000?page=2", page2Html]
    ]));
    fixtureServer = fixture.server;
    const page1Url = `http://bbs.quantclass.localhost:${fixture.port}/thread/88000`;
    const page2Url = `http://bbs.quantclass.localhost:${fixture.port}/thread/88000?page=2`;

    browserContext = await launchPersistentChromium(
      t,
      userDataDir,
      extensionLaunchOptions("MAP bbs.quantclass.localhost 127.0.0.1")
    );
    if (!browserContext) return;

    const worker = await extensionServiceWorker(t, browserContext);
    if (!worker) return;
    const extensionId = new URL(worker.url()).host;
    assert.ok(extensionId, "extension id was not available");

    const sidepanel = await browserContext.newPage();
    await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await sidepanel.evaluate(
      ({ serviceUrl: targetServiceUrl, token: pairingToken }) => chrome.storage.local.set({
        settings: {
          serviceUrl: targetServiceUrl,
          pairingToken,
          projectId: "default",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5",
          temperature: 0.2
        }
      }),
      { serviceUrl, token }
    );
    await sidepanel.reload({ waitUntil: "domcontentloaded" });
    await waitForInteractiveSidepanel(sidepanel);
    await sidepanel.locator('button[data-tab="batch"]').click();
    await sidepanel.locator("#batchUrlsInput").fill(`${page1Url}\n${page2Url}`);
    await sidepanel.locator("#enqueueBatchBtn").click();
    await sidepanel.locator("#processBatchBtn").click();

    const first = await waitForBatchJobSuccess(serviceUrl, token, page1Url);
    const second = await waitForBatchJobSuccess(serviceUrl, token, page2Url);
    assert.notEqual(first.item.source_id, second.item.source_id);
    assert.deepEqual(first.item.result?.pagination_checkpoint?.next_pages, [page2Url]);

    const firstDetail = (await serviceJson(serviceUrl, token, `/v1/sources/${encodeURIComponent(first.item.source_id)}`)).source;
    const secondDetail = (await serviceJson(serviceUrl, token, `/v1/sources/${encodeURIComponent(second.item.source_id)}`)).source;
    assert.equal(firstDetail.quality_flags.pagination_needed, true);
    assert.deepEqual(firstDetail.quality_flags.next_pages, [page2Url]);
    assert.equal(secondDetail.quality_flags.pagination_needed, false);
    assert.match(secondDetail.text, /### 评论 · #4/);
    assert.match(secondDetail.text, /### 评论 · #5/);
    assert.match(secondDetail.text, /### 评论 · #6/);
    assert.doesNotMatch(secondDetail.text, /### 主帖 · #4/);
    assert.match(secondDetail.text, /revised_filter/);
    assert.equal((secondDetail.attachments || [])[0]?.filename, "multipage-page2.xlsx");
  } finally {
    if (browserContext) await browserContext.close();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    await terminate(service);
    await rm(dataDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});
