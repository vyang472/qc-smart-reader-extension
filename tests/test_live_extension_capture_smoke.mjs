import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    // Continue to the bundled Codex runtime path used in this desktop environment.
  }
  const pnpmRoot = join(
    homedir(),
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "node",
    "node_modules",
    ".pnpm"
  );
  try {
    const entry = readdirSync(pnpmRoot).find((name) => name.startsWith("playwright@"));
    if (!entry) return null;
    return require(join(pnpmRoot, entry, "node_modules", "playwright"));
  } catch {
    return null;
  }
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

async function waitForHealth(serviceUrl, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${serviceUrl}/health`);
      if (response.ok) return response.json();
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`service did not become healthy: ${serviceUrl}`);
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
  await execFilePromise("python3", ["-c", script, join(dataDir, "state", "qc_smart_reader.sqlite3"), jobId], { cwd: ROOT });
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    timeout.unref?.();
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}

test("live extension batch capture smoke saves a QuantClass fixture through companion service", async (t) => {
  const playwright = loadPlaywright();
  if (!playwright?.chromium) {
    t.skip("Playwright is unavailable");
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const service = spawn("python3", ["companion_service/server.py", "--host", "127.0.0.1", "--port", String(servicePort), "--data-dir", dataDir], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serviceOutput = "";
  service.stdout.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  service.stderr.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  let browserContext;
  let fixtureServer;

  try {
    try {
      await waitForHealth(serviceUrl);
    } catch (error) {
      throw new Error(`${error.message}\nservice output:\n${serviceOutput.trim()}`);
    }
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const fixtureHtml = await readFile(new URL("./fixtures/quantclass_thread.html", import.meta.url), "utf8");
    const fixture = await startFixtureServer(new Map([["/thread/87030", fixtureHtml]]));
    fixtureServer = fixture.server;
    const fixturePort = fixture.port;
    const fixtureUrl = `http://bbs.quantclass.localhost:${fixturePort}/thread/87030`;

    try {
      browserContext = await playwright.chromium.launchPersistentContext(userDataDir, {
        headless: true,
        channel: "chromium",
        args: [
          "--host-resolver-rules=MAP bbs.quantclass.localhost 127.0.0.1",
          `--disable-extensions-except=${ROOT}`,
          `--load-extension=${ROOT}`
        ]
      });
    } catch (error) {
      t.skip(`Chromium extension launch is unavailable: ${error.message}`);
      return;
    }

    let worker = browserContext.serviceWorkers()[0];
    try {
      if (!worker) {
        worker = await browserContext.waitForEvent("serviceworker", { timeout: 10000 });
      }
    } catch (error) {
      t.skip(`Chromium did not expose the extension service worker: ${error.message}`);
      return;
    }
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
  const playwright = loadPlaywright();
  if (!playwright?.chromium) {
    t.skip("Playwright is unavailable");
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const service = spawn("python3", ["companion_service/server.py", "--host", "127.0.0.1", "--port", String(servicePort), "--data-dir", dataDir], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serviceOutput = "";
  service.stdout.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  service.stderr.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  let browserContext;
  let fixtureServer;

  try {
    try {
      await waitForHealth(serviceUrl);
    } catch (error) {
      throw new Error(`${error.message}\nservice output:\n${serviceOutput.trim()}`);
    }
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

    try {
      browserContext = await playwright.chromium.launchPersistentContext(userDataDir, {
        headless: true,
        channel: "chromium",
        args: [
          "--host-resolver-rules=MAP bbs.quantclass.localhost 127.0.0.1",
          `--disable-extensions-except=${ROOT}`,
          `--load-extension=${ROOT}`
        ]
      });
    } catch (error) {
      t.skip(`Chromium extension launch is unavailable: ${error.message}`);
      return;
    }

    let worker = browserContext.serviceWorkers()[0];
    try {
      if (!worker) {
        worker = await browserContext.waitForEvent("serviceworker", { timeout: 10000 });
      }
    } catch (error) {
      t.skip(`Chromium did not expose the extension service worker: ${error.message}`);
      return;
    }
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

test("live extension current page uses browser site profile bundle for GitHub issue threads", async (t) => {
  const playwright = loadPlaywright();
  if (!playwright?.chromium) {
    t.skip("Playwright is unavailable");
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const service = spawn("python3", ["companion_service/server.py", "--host", "127.0.0.1", "--port", String(servicePort), "--data-dir", dataDir], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serviceOutput = "";
  service.stdout.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  service.stderr.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  let browserContext;
  let fixtureServer;

  try {
    try {
      await waitForHealth(serviceUrl);
    } catch (error) {
      throw new Error(`${error.message}\nservice output:\n${serviceOutput.trim()}`);
    }
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const fixtureHtml = await readFile(new URL("./fixtures/github_issue.html", import.meta.url), "utf8");
    const fixture = await startFixtureServer(new Map([["/org/repo/issues/34", fixtureHtml]]));
    fixtureServer = fixture.server;
    const fixtureUrl = `http://github.com.localhost:${fixture.port}/org/repo/issues/34`;

    try {
      browserContext = await playwright.chromium.launchPersistentContext(userDataDir, {
        headless: true,
        channel: "chromium",
        args: [
          "--host-resolver-rules=MAP github.com.localhost 127.0.0.1",
          `--disable-extensions-except=${ROOT}`,
          `--load-extension=${ROOT}`
        ]
      });
    } catch (error) {
      t.skip(`Chromium extension launch is unavailable: ${error.message}`);
      return;
    }

    let worker = browserContext.serviceWorkers()[0];
    try {
      if (!worker) {
        worker = await browserContext.waitForEvent("serviceworker", { timeout: 10000 });
      }
    } catch (error) {
      t.skip(`Chromium did not expose the extension service worker: ${error.message}`);
      return;
    }
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

    const fixturePage = await browserContext.newPage();
    await fixturePage.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
    await fixturePage.bringToFront();
    await sidepanel.evaluate(() => document.querySelector("#readPageBtn")?.click());
    await sidepanel.waitForFunction(() => document.querySelector("#sourceTitle")?.textContent.includes("Fix stale source quality blockers"), null, { timeout: 15000 });
    await sidepanel.waitForFunction(() => {
      const text = document.querySelector("#sourcePreview")?.textContent || "";
      return text.includes("profile: github-issue") && text.includes("评论: 1") && text.includes("附件: 1");
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
  const playwright = loadPlaywright();
  if (!playwright?.chromium) {
    t.skip("Playwright is unavailable");
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const service = spawn("python3", ["companion_service/server.py", "--host", "127.0.0.1", "--port", String(servicePort), "--data-dir", dataDir], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serviceOutput = "";
  service.stdout.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  service.stderr.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  let browserContext;
  let fixtureServer;

  try {
    try {
      await waitForHealth(serviceUrl);
    } catch (error) {
      throw new Error(`${error.message}\nservice output:\n${serviceOutput.trim()}`);
    }
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const fixtureHtml = await readFile(new URL("./fixtures/quantclass_thread.html", import.meta.url), "utf8");
    const fixture = await startFixtureServer(new Map([[
      "/thread/heartbeat",
      { body: fixtureHtml.replace("长上影线是卖出还是买入信号？", "Heartbeat 慢页面测试"), delayMs: 900 }
    ]]));
    fixtureServer = fixture.server;
    const fixtureUrl = `http://bbs.quantclass.localhost:${fixture.port}/thread/heartbeat`;

    try {
      browserContext = await playwright.chromium.launchPersistentContext(userDataDir, {
        headless: true,
        channel: "chromium",
        args: [
          "--host-resolver-rules=MAP bbs.quantclass.localhost 127.0.0.1",
          `--disable-extensions-except=${ROOT}`,
          `--load-extension=${ROOT}`
        ]
      });
    } catch (error) {
      t.skip(`Chromium extension launch is unavailable: ${error.message}`);
      return;
    }

    let worker = browserContext.serviceWorkers()[0];
    try {
      if (!worker) {
        worker = await browserContext.waitForEvent("serviceworker", { timeout: 10000 });
      }
    } catch (error) {
      t.skip(`Chromium did not expose the extension service worker: ${error.message}`);
      return;
    }
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
  const playwright = loadPlaywright();
  if (!playwright?.chromium) {
    t.skip("Playwright is unavailable");
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const service = spawn("python3", ["companion_service/server.py", "--host", "127.0.0.1", "--port", String(servicePort), "--data-dir", dataDir], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serviceOutput = "";
  service.stdout.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  service.stderr.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  let browserContext;
  let fixtureServer;

  try {
    try {
      await waitForHealth(serviceUrl);
    } catch (error) {
      throw new Error(`${error.message}\nservice output:\n${serviceOutput.trim()}`);
    }
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

    try {
      browserContext = await playwright.chromium.launchPersistentContext(userDataDir, {
        headless: true,
        channel: "chromium",
        args: [
          "--host-resolver-rules=MAP bbs.quantclass.localhost 127.0.0.1",
          `--disable-extensions-except=${ROOT}`,
          `--load-extension=${ROOT}`
        ]
      });
    } catch (error) {
      t.skip(`Chromium extension launch is unavailable: ${error.message}`);
      return;
    }

    let worker = browserContext.serviceWorkers()[0];
    try {
      if (!worker) {
        worker = await browserContext.waitForEvent("serviceworker", { timeout: 10000 });
      }
    } catch (error) {
      t.skip(`Chromium did not expose the extension service worker: ${error.message}`);
      return;
    }
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
  const playwright = loadPlaywright();
  if (!playwright?.chromium) {
    t.skip("Playwright is unavailable");
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const service = spawn("python3", ["companion_service/server.py", "--host", "127.0.0.1", "--port", String(servicePort), "--data-dir", dataDir], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serviceOutput = "";
  service.stdout.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  service.stderr.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  let browserContext;
  let fixtureServer;

  try {
    try {
      await waitForHealth(serviceUrl);
    } catch (error) {
      throw new Error(`${error.message}\nservice output:\n${serviceOutput.trim()}`);
    }
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

    try {
      browserContext = await playwright.chromium.launchPersistentContext(userDataDir, {
        headless: true,
        channel: "chromium",
        args: [
          "--host-resolver-rules=MAP bbs.quantclass.localhost 127.0.0.1",
          `--disable-extensions-except=${ROOT}`,
          `--load-extension=${ROOT}`
        ]
      });
    } catch (error) {
      t.skip(`Chromium extension launch is unavailable: ${error.message}`);
      return;
    }

    let worker = browserContext.serviceWorkers()[0];
    try {
      if (!worker) {
        worker = await browserContext.waitForEvent("serviceworker", { timeout: 10000 });
      }
    } catch (error) {
      t.skip(`Chromium did not expose the extension service worker: ${error.message}`);
      return;
    }
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
    await sidepanel.locator('button[data-tab="batch"]').click();
    await sidepanel.locator("#batchUrlsInput").fill(`${firstUrl}\n${secondUrl}`);
    await sidepanel.locator("#enqueueBatchBtn").click();
    await sidepanel.locator("#processBatchBtn").click();

    const running = await waitForBatchJobItem(serviceUrl, token, firstUrl, ({ item }) => item.status === "running");
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
  const playwright = loadPlaywright();
  if (!playwright?.chromium) {
    t.skip("Playwright is unavailable");
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const restartedUserDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-restart-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const service = spawn("python3", ["companion_service/server.py", "--host", "127.0.0.1", "--port", String(servicePort), "--data-dir", dataDir], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serviceOutput = "";
  service.stdout.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  service.stderr.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  let browserContext;
  let restartedBrowserContext;
  let fixtureServer;

  try {
    try {
      await waitForHealth(serviceUrl);
    } catch (error) {
      throw new Error(`${error.message}\nservice output:\n${serviceOutput.trim()}`);
    }
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
      try {
        return await playwright.chromium.launchPersistentContext(profileDir, {
          headless: true,
          channel: "chromium",
          args: [
            "--host-resolver-rules=MAP bbs.quantclass.localhost 127.0.0.1",
            `--disable-extensions-except=${ROOT}`,
            `--load-extension=${ROOT}`
          ]
        });
      } catch (error) {
        t.skip(`Chromium extension launch is unavailable: ${error.message}`);
        return null;
      }
    };

    const openConfiguredSidepanel = async (context) => {
      let worker = context.serviceWorkers()[0];
      try {
        if (!worker) {
          worker = await context.waitForEvent("serviceworker", { timeout: 10000 });
        }
      } catch (error) {
        t.skip(`Chromium did not expose the extension service worker: ${error.message}`);
        return null;
      }
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

    await restartedSidepanel.waitForFunction(() => !document.querySelector("#processBatchBtn")?.disabled, null, { timeout: 10000 });
    await restartedSidepanel.locator("#processBatchBtn").click();
    await waitForJobEvent(serviceUrl, token, running.job.id, "job_retry_failed");
    await waitForJobEvent(serviceUrl, token, running.job.id, "job_resumed");

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
  const playwright = loadPlaywright();
  if (!playwright?.chromium) {
    t.skip("Playwright is unavailable");
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), "qc-live-service-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-live-chrome-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const service = spawn("python3", ["companion_service/server.py", "--host", "127.0.0.1", "--port", String(servicePort), "--data-dir", dataDir], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serviceOutput = "";
  service.stdout.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  service.stderr.on("data", (chunk) => {
    serviceOutput += chunk.toString();
  });
  let browserContext;
  let fixtureServer;

  try {
    try {
      await waitForHealth(serviceUrl);
    } catch (error) {
      throw new Error(`${error.message}\nservice output:\n${serviceOutput.trim()}`);
    }
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

    try {
      browserContext = await playwright.chromium.launchPersistentContext(userDataDir, {
        headless: true,
        channel: "chromium",
        args: [
          "--host-resolver-rules=MAP bbs.quantclass.localhost 127.0.0.1",
          `--disable-extensions-except=${ROOT}`,
          `--load-extension=${ROOT}`
        ]
      });
    } catch (error) {
      t.skip(`Chromium extension launch is unavailable: ${error.message}`);
      return;
    }

    let worker = browserContext.serviceWorkers()[0];
    try {
      if (!worker) {
        worker = await browserContext.waitForEvent("serviceworker", { timeout: 10000 });
      }
    } catch (error) {
      t.skip(`Chromium did not expose the extension service worker: ${error.message}`);
      return;
    }
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
