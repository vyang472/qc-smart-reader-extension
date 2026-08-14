#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { extensionServiceWorker, launchPersistentChromium } from "../tests/browser_runtime.mjs";

process.env.QC_REQUIRE_BROWSER = "1";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_STORE_DIR = join(ROOT, "store-assets", "web-store");
const WEB_STORE_VIEWPORT = { width: 640, height: 400 };
const FIXTURE_TITLE = "Human review is required before a quote-backed claim becomes trusted";
const FIXTURE_QUOTE = "A valid quotation proves that cited text exists in the captured source. Human review still decides whether the text supports the draft claim.";
const PRODUCT_VERSION = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8")).version;
const PYTHON = process.env.QC_TEST_PYTHON
  || (existsSync(join(ROOT, ".venv", "bin", "python")) ? join(ROOT, ".venv", "bin", "python") : "python3");
const COMPANION_START_TIMEOUT_MS = Number(process.env.QC_COMPANION_START_TIMEOUT_MS || 90_000);
const T = {
  skip(reason) {
    throw new Error(reason);
  }
};

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

function startFixtureServer(html) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.url === "/qc-reader/demo/issues/1") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function startCompanion(dataDir, port) {
  const child = spawn(
    PYTHON,
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
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  child.once("error", (error) => { spawnError = error; });
  child.once("exit", (code, signal) => { exitStatus = { code, signal }; });
  return {
    child,
    output: () => output.trim(),
    failure: () => {
      if (spawnError) return `${PYTHON} could not start: ${spawnError.message}`;
      if (exitStatus) {
        const result = exitStatus.signal ? `signal ${exitStatus.signal}` : `code ${exitStatus.code}`;
        return `${PYTHON} exited before becoming healthy (${result})`;
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
      const response = await fetch(`${serviceUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response.json();
    } catch {
      // The local service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const state = companion.failure() || `${PYTHON} was still running after ${timeoutMs} ms`;
  throw new Error(
    `Companion service did not become healthy: ${serviceUrl}\nservice state: ${state}\nservice output:\n${companion.output()}`
  );
}

async function serviceJson(serviceUrl, token, path) {
  const response = await fetch(`${serviceUrl}${path}`, {
    headers: { "x-qc-pairing-token": token }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Companion request failed ${response.status} ${path}: ${text.slice(0, 500)}`);
  }
  return data;
}

async function waitForServiceRecord(load, predicate, label, timeoutMs = 15_000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await load();
    if (predicate(lastValue)) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(lastValue).slice(0, 1_000)}`);
}

function terminate(child) {
  if (!child || child.pid == null || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(forceTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function extensionLaunchOptions(browserLocale) {
  return {
    headless: true,
    channel: "chromium",
    locale: browserLocale,
    viewport: WEB_STORE_VIEWPORT,
    deviceScaleFactor: 1,
    args: [
      `--lang=${browserLocale}`,
      "--host-resolver-rules=MAP github.com.localhost 127.0.0.1",
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`
    ]
  };
}

async function redactVisibleLocalValues(page) {
  await page.evaluate(() => {
    const redact = (value) => String(value || "")
      .replace(/http:\/\/github\.com\.localhost:\d+\/qc-reader\/demo\/issues\/1/g, "https://demo.qc-reader.local/evidence-first-workflow")
      .replace(/http:\/\/(?:127\.0\.0\.1|localhost):\d+/g, "LOCAL_COMPANION")
      .replace(/\/(?:private\/)?var\/folders\/\S+/g, "LOCAL_VAULT/…")
      .replace(/\/(?:Users|home)\/[^\s/]+\/\S+/g, "LOCAL_VAULT/…")
      .replace(/\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "PUBLIC_FIXTURE_TIME")
      .replace(/\b(src|chk|chunk|claim|ev|evidence|arun|doc|note|job|topic)_[A-Za-z0-9_-]+\b/g, "$1_demo");
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      node.textContent = redact(node.textContent);
    }
    document.querySelectorAll("input, textarea").forEach((input) => {
      input.value = input.type === "password" ? "" : redact(input.value);
    });
    document.activeElement?.blur?.();
  });
}

async function assertSafePage(page, label, blockedValues) {
  const snapshot = await page.evaluate(() => ({
    text: document.body.textContent || "",
    values: [...document.querySelectorAll("input, textarea")].map((node) => node.value || "").join("\n")
  }));
  const rendered = `${snapshot.text}\n${snapshot.values}`;
  for (const value of blockedValues.filter(Boolean)) {
    assert.equal(rendered.includes(value), false, `${label} still contains blocked local value`);
  }
  assert.doesNotMatch(rendered, /\/(?:Users|home)\/[^\s/]+\//, `${label} contains a user path`);
  assert.doesNotMatch(rendered, /\/(?:private\/)?var\/folders\//, `${label} contains a temporary macOS path`);
  assert.doesNotMatch(rendered, /github\.com\.localhost:\d+/, `${label} contains the fixture port`);
}

async function captureViewport(
  page,
  path,
  anchor = null,
  blockedValues = [],
  viewport = { width: 480, height: 800 }
) {
  await page.setViewportSize(viewport);
  await page.addStyleTag({
    content: `
      * {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }
      html { scroll-behavior: auto !important; }
      .quick-start-highlight {
        box-shadow: none !important;
        outline: none !important;
      }
      ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
    `
  });
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });
  await redactVisibleLocalValues(page);
  await assertSafePage(page, path, blockedValues);
  const alignViewport = async () => {
    if (anchor) {
      await page.locator(anchor).first().evaluate((node) => {
        const top = node.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top, left: 0, behavior: "instant" });
      });
    } else {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (anchor) {
      let anchorTop = await page.locator(anchor).first().evaluate((node) => node.getBoundingClientRect().top);
      if (Math.abs(anchorTop) >= 0.01) {
        await page.evaluate((delta) => window.scrollBy({ top: delta, left: 0, behavior: "instant" }), anchorTop);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        anchorTop = await page.locator(anchor).first().evaluate((node) => node.getBoundingClientRect().top);
      }
      assert.ok(Math.abs(anchorTop) < 0.01, `${path} anchor did not align to the viewport: ${anchorTop}`);
    }
  };
  await alignViewport();
  // The first raster of a fresh headless profile can differ by a subpixel. Discard one
  // real render so the persisted capture uses the settled compositor and font cache.
  await page.screenshot({ animations: "disabled" });
  await alignViewport();
  await page.screenshot({ path, animations: "disabled" });
}

async function assertPngDimensions(path, width = 1280, height = 800) {
  const data = await readFile(path);
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path} is not a PNG`);
  assert.equal(data.readUInt32BE(16), width, `${path} width`);
  assert.equal(data.readUInt32BE(20), height, `${path} height`);
  assert.ok([2, 6].includes(data[25]), `${path} must use RGB or RGBA PNG color`);
}

function fixtureHtml() {
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <title>${FIXTURE_TITLE}</title>
      </head>
      <body>
        <main class="application-main">
          <div class="discussion-timeline js-discussion">
            <h1><bdi class="js-issue-title markdown-title">${FIXTURE_TITLE}</bdi></h1>
            <div class="js-comment">
              <a class="author Link--primary">QC Reader Demo</a>
              <relative-time datetime="2026-08-15T08:00:00Z">Aug 15, 2026</relative-time>
              <div class="comment-body markdown-body">
                <p>Local template extraction can draft a claim and attach an exact quotation from the stored source. The draft remains undecided until a person checks whether that quotation really supports the claim.</p>
                <p>Local-first storage keeps raw captures, structured records, review decisions, and lineage under the user's control.</p>
              </div>
            </div>
            <div class="js-comment">
              <a class="author Link--primary">Human Reviewer</a>
              <relative-time datetime="2026-08-15T09:15:00Z">Aug 15, 2026</relative-time>
              <div class="comment-body markdown-body">
                <p>${FIXTURE_QUOTE}</p>
                <p>A reviewer can mark the claim supported or unsupported without losing its source context.</p>
              </div>
            </div>
          </div>
        </main>
      </body>
    </html>`;
}

async function captureLocalizedAssets(spec, fixtureUrl) {
  const outputDir = join(WEB_STORE_DIR, spec.outputLocale);
  await mkdir(outputDir, { recursive: true });
  const dataDir = await mkdtemp(join(tmpdir(), `qc-store-${spec.outputLocale}-data-`));
  const userDataDir = await mkdtemp(join(tmpdir(), `qc-store-${spec.outputLocale}-chrome-`));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const companion = startCompanion(dataDir, servicePort);
  let context;

  try {
    const health = await waitForHealth(serviceUrl, companion);
    assert.equal(health.service_version || health.version, PRODUCT_VERSION, "Companion and extension versions differ");

    context = await launchPersistentChromium(T, userDataDir, extensionLaunchOptions(spec.browserLocale));
    const worker = await extensionServiceWorker(T, context);
    const extensionId = new URL(worker.url()).host;
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const blockedValues = [token, dataDir, userDataDir, process.env.HOME, serviceUrl, fixtureUrl];
    const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;

    const sidepanel = await context.newPage();
    await sidepanel.goto(sidepanelUrl, { waitUntil: "domcontentloaded" });
    await sidepanel.waitForFunction((expected) => document.documentElement.lang === expected, spec.htmlLang);
    assert.equal(await sidepanel.locator("#uiLocaleSelect").inputValue(), "auto");
    assert.equal(
      await worker.evaluate(async () => (await chrome.storage.local.get("uiLocale")).uiLocale),
      undefined,
      `${spec.outputLocale} clean profile persisted an explicit locale`
    );
    assert.equal(await sidepanel.locator("#providerSelect").inputValue(), "mock", "clean profile must default local");
    assert.equal(await sidepanel.locator("#quickStartCard").isHidden(), true, "Quick Start must wait for pairing");

    await sidepanel.locator("#serviceUrlInput").fill(serviceUrl);
    await sidepanel.locator("#pairingTokenInput").fill(token);
    await sidepanel.locator("#testCompanionBtn").click();
    await sidepanel.waitForFunction(() => {
      const status = document.querySelector("#settingsStatus");
      const quickStart = document.querySelector("#quickStartCard");
      return status?.dataset.i18nDynamicKey === "settings.status.success" && !quickStart?.hidden;
    }, null, { timeout: 15_000 });

    const fixturePage = await context.newPage();
    await fixturePage.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
    await fixturePage.bringToFront();
    await sidepanel.evaluate(() => document.querySelector("#quickStartBtn")?.click());
    await sidepanel.waitForFunction(() => {
      const card = document.querySelector("#quickStartEvidence");
      const claim = document.querySelector("#quickStartClaimText")?.textContent || "";
      const quote = document.querySelector("#quickStartQuoteText")?.textContent || "";
      return card && !card.hidden && claim.length > 10 && quote.length > 10;
    }, null, { timeout: 30_000 });
    assert.equal(await sidepanel.locator("#quickStartProgress").textContent(), "2 / 3");
    assert.equal(await sidepanel.locator("#quickStartAcceptClaimBtn").isDisabled(), false);
    assert.equal(await sidepanel.locator("#quickStartRejectClaimBtn").isDisabled(), false);

    const firstEvidence = await sidepanel.evaluate(() => ({
      claimId: document.querySelector("#quickStartEvidence")?.dataset.claimId || "",
      evidenceId: document.querySelector("#quickStartEvidence")?.dataset.evidenceId || "",
      claim: document.querySelector("#quickStartClaimText")?.textContent || "",
      quote: document.querySelector("#quickStartQuoteText")?.textContent || "",
      reviewStatusKey: document.querySelector("#quickStartReviewStatus")?.dataset.i18nDynamicKey || ""
    }));
    assert.ok(firstEvidence.claimId, "Quick Start did not expose a persisted claim id");
    assert.ok(firstEvidence.evidenceId, "Quick Start did not expose a persisted evidence id");
    assert.equal(firstEvidence.claim, FIXTURE_TITLE, "the deterministic claim drifted from the public fixture");
    assert.equal(firstEvidence.quote, FIXTURE_TITLE, "the exact quote drifted from the public fixture");
    assert.equal(firstEvidence.reviewStatusKey, "firstEvidence.review.pending");

    const sourcePayload = await waitForServiceRecord(
      () => serviceJson(serviceUrl, token, "/v1/sources?limit=10"),
      (data) => (data.sources || []).some((source) => source.url === fixtureUrl),
      `${spec.outputLocale} persisted Quick Start source`
    );
    const capturedSource = sourcePayload.sources.find((source) => source.url === fixtureUrl);
    const sourceDetail = (
      await serviceJson(serviceUrl, token, `/v1/sources/${encodeURIComponent(capturedSource.id)}`)
    ).source;
    assert.ok(sourceDetail.text.includes(firstEvidence.quote), "displayed quote is not exact stored source text");
    const beforeReview = await waitForServiceRecord(
      () => serviceJson(serviceUrl, token, "/v1/knowledge/records?limit=50&project_id=default"),
      (data) => (data.claims || []).some((claim) => claim.id === firstEvidence.claimId),
      `${spec.outputLocale} pending claim`
    );
    assert.equal(
      ["reviewed", "rejected"].includes(
        beforeReview.claims.find((claim) => claim.id === firstEvidence.claimId)?.status
      ),
      false,
      "Quick Start decided the claim before a human action"
    );
    assert.equal(
      beforeReview.evidence.find((evidence) => evidence.id === firstEvidence.evidenceId)?.quote,
      firstEvidence.quote,
      "stored evidence quote differs from the visible exact quote"
    );

    await sidepanel.bringToFront();
    const pendingPath = join(outputDir, "01-first-evidence-pending-review.png");
    await captureViewport(sidepanel, pendingPath, "#quickStartEvidence", blockedValues, WEB_STORE_VIEWPORT);

    await sidepanel.locator("#quickStartAcceptClaimBtn").click();
    await sidepanel.waitForFunction(() => {
      const card = document.querySelector("#quickStartEvidence");
      const accept = document.querySelector("#quickStartAcceptClaimBtn");
      const reject = document.querySelector("#quickStartRejectClaimBtn");
      return card?.dataset.claimStatus === "reviewed"
        && accept?.disabled
        && reject?.disabled
        && document.querySelector("#quickStartProgress")?.textContent === "3 / 3";
    }, null, { timeout: 15_000 });
    await waitForServiceRecord(
      () => serviceJson(serviceUrl, token, "/v1/knowledge/records?limit=50&project_id=default"),
      (data) => (data.claims || []).some((claim) => (
        claim.id === firstEvidence.claimId && claim.status === "reviewed"
      )),
      `${spec.outputLocale} reviewed claim`
    );

    await sidepanel.close();
    const reopened = await context.newPage();
    await reopened.goto(sidepanelUrl, { waitUntil: "domcontentloaded" });
    await reopened.waitForFunction((claimId) => {
      const card = document.querySelector("#quickStartEvidence");
      return card && !card.hidden && card.dataset.claimId === claimId;
    }, firstEvidence.claimId, { timeout: 20_000 });
    assert.equal(await reopened.locator("html").getAttribute("lang"), spec.htmlLang);
    assert.equal(await reopened.locator("#quickStartProgress").textContent(), "3 / 3");
    assert.equal(await reopened.locator("#quickStartClaimText").textContent(), firstEvidence.claim);
    assert.equal(await reopened.locator("#quickStartQuoteText").textContent(), firstEvidence.quote);
    assert.equal(await reopened.locator("#quickStartAcceptClaimBtn").isDisabled(), true);
    assert.equal(await reopened.locator("#quickStartRejectClaimBtn").isDisabled(), true);
    assert.equal(
      await reopened.locator("#quickStartReviewStatus").getAttribute("data-i18n-dynamic-key"),
      "firstEvidence.review.reviewed"
    );
    await reopened.locator("#tab-knowledge").click();
    assert.equal(await reopened.locator("#quickStartEvidence").isVisible(), true);

    const reviewedPath = join(outputDir, "02-reviewed-exact-quote.png");
    await captureViewport(reopened, reviewedPath, "#quickStartEvidence", blockedValues, WEB_STORE_VIEWPORT);
    await assertPngDimensions(pendingPath, WEB_STORE_VIEWPORT.width, WEB_STORE_VIEWPORT.height);
    await assertPngDimensions(reviewedPath, WEB_STORE_VIEWPORT.width, WEB_STORE_VIEWPORT.height);
    return [pendingPath, reviewedPath];
  } finally {
    if (context) await context.close();
    await terminate(companion.child);
    await rm(dataDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
}

async function main() {
  await mkdir(WEB_STORE_DIR, { recursive: true });
  const fixture = await startFixtureServer(fixtureHtml());
  const fixtureUrl = `http://github.com.localhost:${fixture.port}/qc-reader/demo/issues/1`;
  const outputs = [];
  try {
    for (const spec of [
      { browserLocale: "en-US", htmlLang: "en", outputLocale: "en-US" },
      { browserLocale: "zh-CN", htmlLang: "zh-CN", outputLocale: "zh-CN" }
    ]) {
      outputs.push(...await captureLocalizedAssets(spec, fixtureUrl));
    }
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }

  console.log("Generated real Chrome Web Store screenshots from clean profiles:");
  for (const outputPath of outputs) {
    console.log(`- ${outputPath} (${WEB_STORE_VIEWPORT.width}x${WEB_STORE_VIEWPORT.height}, RGB/RGBA)`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
