#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { extensionServiceWorker, launchPersistentChromium } from "../tests/browser_runtime.mjs";

process.env.QC_REQUIRE_BROWSER = "1";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT_DIR = join(ROOT, "store-assets", "screenshots");
const PRODUCT_VERSION = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8")).version;
const PYTHON = process.env.QC_TEST_PYTHON
  || (existsSync(join(ROOT, ".venv", "bin", "python")) ? join(ROOT, ".venv", "bin", "python") : "python3");
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

async function waitForHealth(serviceUrl, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${serviceUrl}/health`);
      if (response.ok) return response.json();
    } catch {
      // The local service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Companion service did not become healthy: ${serviceUrl}`);
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
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    timeout.unref?.();
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}

function extensionLaunchOptions() {
  return {
    headless: true,
    channel: "chromium",
    viewport: { width: 480, height: 800 },
    deviceScaleFactor: 1,
    args: [
      "--host-resolver-rules=MAP github.com.localhost 127.0.0.1",
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`
    ]
  };
}

async function redactVisibleLocalValues(page) {
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      node.textContent = String(node.textContent || "")
        .replace(/http:\/\/github\.com\.localhost:\d+\/qc-reader\/demo\/issues\/1/g, "https://demo.qc-reader.local/evidence-first-workflow")
        .replace(/http:\/\/(?:127\.0\.0\.1|localhost):\d+/g, "LOCAL_COMPANION")
        .replace(/\/(?:private\/)?var\/folders\/\S+/g, "LOCAL_VAULT/…")
        .replace(/\/(?:Users|home)\/[^\s/]+\/\S+/g, "LOCAL_VAULT/…")
        .replace(/\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "PUBLIC_FIXTURE_TIME")
        .replace(/\b(src|chk|chunk|claim|ev|evidence|arun|doc|note|job|topic)_[A-Za-z0-9_-]+\b/g, "$1_demo");
    }
    document.querySelectorAll("input[type=password]").forEach((input) => {
      input.value = "";
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

async function captureViewport(page, path, anchor = null, blockedValues = []) {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.addStyleTag({
    content: `
      * { caret-color: transparent !important; }
      html { scroll-behavior: auto !important; }
      ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
    `
  });
  if (anchor) {
    await page.locator(anchor).first().evaluate((node) => {
      const top = node.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, top));
    });
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await redactVisibleLocalValues(page);
  await assertSafePage(page, path, blockedValues);
  await page.screenshot({ path, animations: "disabled" });
}

async function assertPngDimensions(path, width = 1280, height = 800) {
  const data = await readFile(path);
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path} is not a PNG`);
  assert.equal(data.readUInt32BE(16), width, `${path} width`);
  assert.equal(data.readUInt32BE(20), height, `${path} height`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function composeLaunchScreenshot(context, rawPath, outputPath, copy) {
  const [rawImage, iconSource] = await Promise.all([
    readFile(rawPath),
    readFile(join(ROOT, "assets", "branding", "icon-source.svg"))
  ]);
  const rawUrl = `data:image/png;base64,${rawImage.toString("base64")}`;
  const iconUrl = `data:image/svg+xml;base64,${iconSource.toString("base64")}`;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent(`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body { width: 1280px; height: 800px; margin: 0; overflow: hidden; }
          body {
            position: relative;
            color: #142538;
            background:
              radial-gradient(circle at 92% 5%, rgb(18 103 227 / 14%), transparent 34%),
              radial-gradient(circle at 75% 95%, rgb(8 122 88 / 13%), transparent 38%),
              linear-gradient(135deg, #F8FBFE, #EEF7F3);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          .copy { position: absolute; top: 166px; left: 70px; width: 620px; }
          .brand { display: flex; gap: 14px; align-items: center; margin-bottom: 68px; }
          .brand img { width: 54px; height: 54px; }
          .brand strong { display: block; font-size: 18px; letter-spacing: 1.8px; }
          .brand span { display: block; margin-top: 4px; color: #687B8D; font-size: 14px; }
          .eyebrow {
            width: fit-content;
            margin-bottom: 18px;
            padding: 8px 13px;
            border-radius: 999px;
            color: #087A58;
            background: #DFF5EC;
            font-size: 13px;
            font-weight: 800;
            letter-spacing: .7px;
          }
          h1 { width: 620px; margin: 0; font-size: 48px; line-height: 1.08; letter-spacing: -1.4px; }
          .subtitle { width: 590px; margin: 24px 0 27px; color: #536A7F; font-size: 19px; line-height: 1.5; }
          ul { display: grid; gap: 13px; margin: 0; padding: 0; list-style: none; }
          li { display: flex; gap: 11px; align-items: center; color: #294459; font-size: 16px; font-weight: 650; }
          li::before { content: "✓"; display: grid; width: 24px; height: 24px; place-items: center; border-radius: 50%; color: #087A58; background: #DFF5EC; font-size: 13px; font-weight: 900; }
          .shot-shell {
            position: absolute;
            top: 28px;
            right: 58px;
            width: 468px;
            height: 744px;
            overflow: hidden;
            border: 1px solid #C6D6E3;
            border-radius: 25px;
            background: #FFF;
            box-shadow: 0 28px 70px rgb(28 54 77 / 23%);
          }
          .shot-shell img { width: 100%; height: 100%; object-fit: cover; object-position: top center; }
          .version { position: absolute; left: 70px; bottom: 30px; color: #7B8D9E; font-size: 13px; }
        </style>
      </head>
      <body>
        <section class="copy">
          <div class="brand">
            <img src="${iconUrl}" alt="">
            <div><strong>QC SMART READER</strong><span>Open-source · local-first</span></div>
          </div>
          <div class="eyebrow">${escapeHtml(copy.eyebrow)}</div>
          <h1>${escapeHtml(copy.title)}</h1>
          <p class="subtitle">${escapeHtml(copy.subtitle)}</p>
          <ul>${copy.points.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>
        </section>
        <div class="shot-shell"><img src="${rawUrl}" alt="Actual QC Smart Reader extension UI"></div>
        <div class="version">QC Smart Reader v${escapeHtml(PRODUCT_VERSION)} · Actual extension + local Companion · Public fixture</div>
      </body>
    </html>`);
  await page.locator(".shot-shell img").waitFor({ state: "visible" });
  await page.screenshot({ path: outputPath, animations: "disabled" });
  await page.close();
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), "qc-launch-data-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "qc-launch-chrome-"));
  const rawDir = await mkdtemp(join(tmpdir(), "qc-launch-shots-"));
  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const service = spawn(
    PYTHON,
    ["companion_service/server.py", "--host", "127.0.0.1", "--port", String(servicePort), "--data-dir", dataDir],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );
  let serviceOutput = "";
  service.stdout.on("data", (chunk) => { serviceOutput += chunk.toString(); });
  service.stderr.on("data", (chunk) => { serviceOutput += chunk.toString(); });
  let fixture;
  let context;

  try {
    let health;
    try {
      health = await waitForHealth(serviceUrl);
    } catch (error) {
      throw new Error(`${error.message}\n${serviceOutput.trim()}`);
    }
    assert.equal(health.service_version || health.version, PRODUCT_VERSION, "Companion and extension versions differ");

    // This public, deterministic fixture contains no network-loaded assets and no
    // private data. The extension still captures it through its real page path.
    const fixtureTitle = "Human review is required before a quote-backed claim becomes trusted";
    const fixtureHtml = `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>${fixtureTitle}</title>
        </head>
        <body>
          <main class="application-main">
            <div class="discussion-timeline js-discussion">
              <h1><bdi class="js-issue-title markdown-title">${fixtureTitle}</bdi></h1>
              <div class="js-comment">
                <a class="author Link--primary">QC Reader Demo</a>
                <relative-time datetime="2026-08-15T08:00:00Z">Aug 15, 2026</relative-time>
                <div class="comment-body markdown-body">
                  <p>Local template extraction can draft a claim and attach an exact quotation from the stored source. The draft remains unreviewed until a person checks whether that quotation really supports the claim.</p>
                  <p>Local-first storage keeps raw captures, structured records, review decisions, and lineage under the user's control. A readable Markdown layer supports long-term access while SQLite keeps queries fast and consistent.</p>
                  <p>Restart-safe batch jobs persist their checkpoints before the next item begins. Interrupted work can resume without silently duplicating completed captures.</p>
                  <pre><code class="language-text">source -&gt; chunk -&gt; claim -&gt; evidence -&gt; review</code></pre>
                </div>
              </div>
              <div class="js-comment">
                <a class="author Link--primary">Human Reviewer</a>
                <relative-time datetime="2026-08-15T09:15:00Z">Aug 15, 2026</relative-time>
                <div class="comment-body markdown-body">
                  <p>A valid quotation proves that cited text exists in the captured source. Human review still decides whether the text supports the draft claim.</p>
                  <p>Source quality checks surface missing text, truncation, authentication walls, pagination, and attachments before downstream synthesis begins. Reviewers can accept, keep pending, or reject each claim without losing the source context.</p>
                </div>
              </div>
            </div>
          </main>
        </body>
      </html>`;
    fixture = await startFixtureServer(fixtureHtml);
    const fixtureUrl = `http://github.com.localhost:${fixture.port}/qc-reader/demo/issues/1`;

    context = await launchPersistentChromium(T, userDataDir, extensionLaunchOptions());
    const worker = await extensionServiceWorker(T, context);
    const extensionId = new URL(worker.url()).host;
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const blockedValues = [token, dataDir, userDataDir, process.env.HOME];
    const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;

    const sidepanel = await context.newPage();
    await sidepanel.goto(sidepanelUrl, { waitUntil: "domcontentloaded" });
    assert.equal(await sidepanel.locator("#providerSelect").inputValue(), "mock", "clean profile must default local");
    assert.equal(await sidepanel.locator("#quickStartCard").isHidden(), true, "Quick Start must wait for pairing");
    await sidepanel.locator("#serviceUrlInput").fill(serviceUrl);
    await sidepanel.locator("#pairingTokenInput").fill(token);
    await sidepanel.locator("#testCompanionBtn").click();
    await sidepanel.waitForFunction(() => (
      document.querySelector("#settingsStatus")?.textContent || ""
    ).includes("Pairing Token 均正常"), null, { timeout: 15_000 });
    await sidepanel.waitForFunction(() => !document.querySelector("#quickStartCard")?.hidden);
    assert.match(await sidepanel.locator("#modelRouteHint").textContent(), /零配置模式/);

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
    assert.equal(await sidepanel.locator("#quickStartProgress").textContent(), "4 / 5");

    const firstEvidence = await sidepanel.evaluate(() => ({
      claimId: document.querySelector("#quickStartEvidence")?.dataset.claimId || "",
      evidenceId: document.querySelector("#quickStartEvidence")?.dataset.evidenceId || "",
      claim: document.querySelector("#quickStartClaimText")?.textContent || "",
      quote: document.querySelector("#quickStartQuoteText")?.textContent || "",
      reviewStatus: document.querySelector("#quickStartReviewStatus")?.textContent || ""
    }));
    assert.ok(firstEvidence.claimId, "Quick Start did not expose a persisted claim id");
    assert.ok(firstEvidence.evidenceId, "Quick Start did not expose a persisted evidence id");
    assert.match(firstEvidence.reviewStatus, /尚未人工接受/);

    const sourcePayload = await waitForServiceRecord(
      () => serviceJson(serviceUrl, token, "/v1/sources?limit=10"),
      (data) => (data.sources || []).some((source) => source.url === fixtureUrl),
      "persisted Quick Start source"
    );
    const capturedSource = sourcePayload.sources.find((source) => source.url === fixtureUrl);
    const sourceDetail = (
      await serviceJson(serviceUrl, token, `/v1/sources/${encodeURIComponent(capturedSource.id)}`)
    ).source;
    assert.ok(sourceDetail.text.includes(firstEvidence.quote), "displayed quote is not exact stored source text");
    const beforeReview = await serviceJson(serviceUrl, token, "/v1/knowledge/records?limit=50&project_id=default");
    assert.notEqual(
      beforeReview.claims.find((claim) => claim.id === firstEvidence.claimId)?.status,
      "reviewed",
      "Quick Start auto-reviewed the claim"
    );

    await sidepanel.bringToFront();
    await sidepanel.locator("#tab-chat").click();
    assert.equal(await sidepanel.locator("#quickStartProgress").textContent(), "4 / 5");

    const rawCapture = join(rawDir, "01-capture-raw.png");
    await captureViewport(sidepanel, rawCapture, "#quickStartCard", blockedValues);
    await composeLaunchScreenshot(
      context,
      rawCapture,
      join(OUTPUT_DIR, "01-capture.png"),
      {
        eyebrow: "ZERO-CONFIG FIRST EVIDENCE",
        title: "Persist the first evidence without a model.",
        subtitle: "The real Quick Start captures the active page, saves it locally, and prepares one quote-backed draft.",
        points: ["Current page saved to the Vault", "Deterministic local template", "No external model or telemetry"]
      }
    );

    await sidepanel.locator("#tab-knowledge").click();
    await sidepanel.locator("#quickStartAcceptClaimBtn").click();
    await sidepanel.waitForFunction(() => (
      document.querySelector("#quickStartReviewStatus")?.textContent || ""
    ).includes("已人工接受"), null, { timeout: 15_000 });
    assert.equal(await sidepanel.locator("#quickStartProgress").textContent(), "5 / 5");
    await waitForServiceRecord(
      () => serviceJson(serviceUrl, token, "/v1/knowledge/records?limit=50&project_id=default"),
      (data) => (data.claims || []).some((claim) => (
        claim.id === firstEvidence.claimId && claim.status === "reviewed"
      )),
      "human-reviewed claim"
    );

    await sidepanel.close();
    const reopened = await context.newPage();
    await reopened.goto(sidepanelUrl, { waitUntil: "domcontentloaded" });
    await reopened.waitForFunction((claimId) => {
      const card = document.querySelector("#quickStartEvidence");
      return card && !card.hidden && card.dataset.claimId === claimId;
    }, firstEvidence.claimId, { timeout: 20_000 });
    assert.equal(await reopened.locator("#quickStartAcceptClaimBtn").isDisabled(), true);
    assert.match(await reopened.locator("#quickStartReviewStatus").textContent(), /reviewed|人工核对/);
    assert.match(await reopened.locator("#quickStartStatus").textContent(), /已恢复.*人工核对/);
    await reopened.locator("#tab-knowledge").click();

    const rawReview = join(rawDir, "02-evidence-review-raw.png");
    await captureViewport(reopened, rawReview, "#quickStartEvidence", blockedValues);
    await composeLaunchScreenshot(
      context,
      rawReview,
      join(OUTPUT_DIR, "02-evidence-review.png"),
      {
        eyebrow: "HUMAN REVIEW",
        title: "A person—not the template—accepts the claim.",
        subtitle: "The restored First Evidence card shows the exact quote and the review decision saved by the user.",
        points: ["Exact quote from stored source", "No automatic acceptance", "Reviewed state survives reopen"]
      }
    );

    const detailButton = reopened.locator("#sourceList [data-source-detail-id]").first();
    await detailButton.waitFor({ state: "visible", timeout: 15_000 });
    await detailButton.click();
    await reopened.locator("#sourceDetail .source-detail-card").waitFor({ state: "visible", timeout: 15_000 });

    const rawVault = join(rawDir, "03-local-vault-raw.png");
    await captureViewport(reopened, rawVault, "#sourceDetail .source-detail-card", blockedValues);
    await composeLaunchScreenshot(
      context,
      rawVault,
      join(OUTPUT_DIR, "03-local-vault.png"),
      {
        eyebrow: "LOCAL VAULT",
        title: "Inspect the stored source behind the claim.",
        subtitle: "The actual source detail view exposes capture quality, versions, chunks, raw text, and local artifact links.",
        points: ["Markdown + SQLite", "Source versions and lineage", "Local paths and run metadata redacted"]
      }
    );

    console.log("Generated launch screenshots:");
    for (const name of ["01-capture.png", "02-evidence-review.png", "03-local-vault.png"]) {
      const outputPath = join(OUTPUT_DIR, name);
      await assertPngDimensions(outputPath);
      console.log(`- ${outputPath} (1280x800)`);
    }
  } finally {
    if (context) await context.close();
    if (fixture?.server) await new Promise((resolve) => fixture.server.close(resolve));
    await terminate(service);
    await rm(dataDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
    await rm(rawDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
