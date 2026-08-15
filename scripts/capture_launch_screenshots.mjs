#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
// The current page URL is persisted in captured text and therefore changes the
// real content hash shown by Replay. A stable fixture port keeps API data and
// pixels deterministic without redacting or fabricating that protected hash.
const FIXTURE_PORT = Number(process.env.QC_SCREENSHOT_FIXTURE_PORT || 41_783);
const PUBLIC_FIXTURE_URL = "https://demo.qc-reader.local/evidence-first-workflow";
const FIXTURE_CAPTURED_AT = "2026-08-15T08:00:00.000Z";
const FIXTURE_TITLE = "Review captured evidence";
const FIXTURE_QUOTE = "Evidence stays pending until a person reviews the exact source quote.";
const REVIEWED_CAPTURE_CSS = `
  #quickStartReplayContainer {
    gap: 4px !important;
    margin-top: 0 !important;
    padding-top: 1px !important;
  }
  #quickStartReplayBtn {
    min-height: 28px !important;
    padding: 4px 9px !important;
    font-size: 11px !important;
  }
  #quickStartReplayPanel {
    gap: 3px !important;
    padding: 6px !important;
  }
  #quickStartReplayPanel .replay-status-row {
    gap: 3px 7px !important;
  }
  #quickStartReplayPanel .replay-status {
    padding: 2px 6px !important;
    font-size: 9px !important;
  }
  #quickStartReplayPanel .replay-locator,
  #quickStartReplayPanel .replay-source-meta,
  #quickStartReplayPanel .replay-provenance,
  #quickStartReplayPanel .replay-reason,
  #quickStartReplayPanel .replay-source-fallback,
  #quickStartReplayPanel .replay-source-link {
    font-size: 9px !important;
    line-height: 1.2 !important;
  }
  #quickStartReplayPanel .replay-source-title {
    font-size: 11px !important;
    line-height: 1.2 !important;
  }
  #quickStartReplayPanel .replay-snapshot-label {
    font-size: 9px !important;
    line-height: 1.15 !important;
  }
  #quickStartReplayPanel .replay-context {
    max-height: 58px !important;
    padding: 5px !important;
    font-size: 10px !important;
    line-height: 1.3 !important;
  }
  #quickStartEvidence .first-evidence-prompt {
    margin: 5px 0 3px !important;
    font-size: 10px !important;
    line-height: 1.2 !important;
  }
  #quickStartEvidence .first-evidence-actions {
    gap: 5px !important;
  }
  #quickStartEvidence .first-evidence-actions button {
    min-height: 28px !important;
    padding: 4px 7px !important;
    font-size: 10px !important;
  }
  #quickStartReviewStatus {
    margin-top: 3px !important;
    font-size: 9px !important;
    line-height: 1.2 !important;
  }
`;
const PRODUCT_VERSION = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8")).version;
const PYTHON = process.env.QC_TEST_PYTHON
  || (existsSync(join(ROOT, ".venv", "bin", "python")) ? join(ROOT, ".venv", "bin", "python") : "python3");
const COMPANION_START_TIMEOUT_MS = Number(process.env.QC_COMPANION_START_TIMEOUT_MS || 90_000);
const T = {
  skip(reason) {
    throw new Error(reason);
  }
};
assert.ok(
  Number.isInteger(FIXTURE_PORT) && FIXTURE_PORT >= 1 && FIXTURE_PORT <= 65_535,
  "QC_SCREENSHOT_FIXTURE_PORT must be an integer from 1 to 65535"
);

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function redactExpectedVisibleText(value) {
  return String(value || "")
    .replace(
      /http:\/\/demo\.qc-reader\.localhost:\d+\/qc-reader\/demo\/issues\/1/g,
      PUBLIC_FIXTURE_URL
    )
    .replace(/http:\/\/(?:127\.0\.0\.1|localhost):\d+/g, "LOCAL_COMPANION")
    .replace(/\/(?:private\/)?var\/folders\/\S+/g, "LOCAL_VAULT/…")
    .replace(/\/(?:Users|home)\/[^\s/]+\/\S+/g, "LOCAL_VAULT/…")
    .replace(/\b(src|chk|chunk|claim|ev|evidence|arun|doc|note|job|topic)_[A-Za-z0-9_-]+\b/g, "$1_demo");
}

async function replayDomSnapshot(page) {
  return page.evaluate(() => {
    const button = document.querySelector("#quickStartReplayBtn");
    const panel = document.querySelector("#quickStartReplayPanel");
    return {
      expanded: button?.getAttribute("aria-expanded") || "",
      replayId: button?.dataset.replayId || "",
      panelReplayId: panel?.dataset.replayPanel || "",
      panelStatus: panel?.dataset.replayStatus || "",
      panelHidden: Boolean(panel?.hidden),
      status: panel?.querySelector("[data-replay-status]")?.textContent || "",
      locator: panel?.querySelector("[data-replay-locator]")?.textContent || "",
      sourceTitle: panel?.querySelector(".replay-source-title")?.textContent || "",
      sourceMeta: panel?.querySelector(".replay-source-meta")?.textContent || "",
      provenance: panel?.querySelector(".replay-provenance")?.textContent || "",
      quote: panel?.querySelector("[data-replay-exact-quote]")?.textContent || "",
      context: panel?.querySelector("[data-replay-context]")?.textContent || "",
      reason: panel?.querySelector(".replay-reason")?.textContent || "",
      sourceUrl: panel?.querySelector("[data-replay-source-link]")?.getAttribute("href") || "",
      claimStatus: document.querySelector("#quickStartEvidence")?.dataset.claimStatus || "",
      reviewStatusKey: document.querySelector("#quickStartReviewStatus")?.dataset.i18nDynamicKey || "",
      bodyText: document.body.textContent || ""
    };
  });
}

function assertResolvedReplayContract({ evidence, sourceDetail, firstEvidence, fixtureUrl }) {
  assert.ok(evidence, "the persisted First Evidence record is missing");
  assert.equal(evidence.id, firstEvidence.evidenceId, "the service returned a different evidence record");
  assert.equal(evidence.claim_id, firstEvidence.claimId, "evidence and visible claim ids differ");
  assert.equal(evidence.source_id, sourceDetail.id, "evidence and captured source ids differ");
  assert.equal(evidence.citation_valid, true, "the exact citation must remain valid");
  assert.equal(evidence.quote, firstEvidence.quote, "stored evidence quote differs from the visible quote");

  const replay = evidence.replay;
  assert.ok(replay && typeof replay === "object", "the service did not return evidence.replay");
  assert.equal(replay.version, 1, "the screenshot contract requires Source Replay v1");
  assert.equal(replay.replay_id, `rpl_${sha256(evidence.id).slice(0, 16)}`, "replay id is not evidence-bound");
  assert.equal(replay.evidence_id, evidence.id, "replay and evidence ids differ");
  assert.equal(replay.claim_id, evidence.claim_id, "replay and claim ids differ");
  assert.equal(replay.source_id, evidence.source_id, "replay and source ids differ");
  assert.equal(
    replay.status,
    "resolved",
    `the captured fixture must resolve exactly (reason: ${replay.reason || "missing"})`
  );
  assert.equal(replay.reason, "exact_quote_match", "the resolved replay reason drifted");

  assert.equal(replay.quote?.text, evidence.quote, "replay quote differs from stored evidence");
  assert.equal(replay.quote?.sha256, sha256(evidence.quote), "replay quote digest differs from exact text");
  assert.equal(replay.source?.url, fixtureUrl, "replay source URL differs from the captured fixture");
  assert.equal(replay.source?.canonical_url, sourceDetail.canonical_url, "replay canonical URL drifted");
  assert.equal(replay.source?.open_url, sourceDetail.canonical_url, "replay fallback URL drifted");
  assert.equal(replay.source?.title, sourceDetail.title, "replay source title drifted");
  assert.equal(replay.source?.kind, sourceDetail.kind, "replay source kind drifted");
  assert.equal(replay.source?.site, sourceDetail.site, "replay source site drifted");
  assert.equal(replay.source?.content_hash, sourceDetail.content_hash, "replay content hash drifted");
  assert.equal(replay.source?.captured_at, FIXTURE_CAPTURED_AT, "replay did not preserve the public fixture time");
  assert.equal(sourceDetail.captured_at, FIXTURE_CAPTURED_AT, "Companion did not persist the public fixture time");
  assert.equal(replay.source?.version_index, 1, "the first clean-profile capture must be source v1");
  assert.equal(replay.source?.is_current, true, "the captured replay must be the current source version");
  assert.equal(replay.source?.current_source_id, sourceDetail.id, "current source id differs from Replay");

  const sourceVersion = (sourceDetail.versions || []).find((version) => version.source_id === sourceDetail.id);
  assert.ok(sourceVersion, "source detail did not expose its version record");
  assert.equal(sourceVersion.version_index, replay.source.version_index, "Replay and source version indexes differ");
  assert.equal(sourceVersion.is_current, replay.source.is_current, "Replay and source current states differ");
  assert.equal(sourceVersion.content_hash, replay.source.content_hash, "Replay and version content hashes differ");
  assert.equal(sourceVersion.captured_at, replay.source.captured_at, "Replay and version capture times differ");

  const locator = replay.locator || {};
  const sourceChunk = (sourceDetail.chunks || []).find((chunk) => chunk.id === evidence.chunk_id);
  assert.ok(sourceChunk, "the replay locator chunk is absent from source detail");
  assert.equal(locator.type, "chunk", "the Web fixture must use a chunk locator");
  assert.equal(locator.provenance, "chunk.index", "the locator provenance drifted");
  assert.equal(locator.chunk_id, evidence.chunk_id, "locator and evidence chunk ids differ");
  assert.equal(locator.chunk_index, sourceChunk.index, "locator and source chunk indexes differ");
  assert.equal(locator.start_offset, sourceChunk.start_offset, "locator start offset drifted");
  assert.equal(locator.end_offset, sourceChunk.end_offset, "locator end offset drifted");

  const context = replay.context || {};
  assert.equal(
    sourceChunk.snippet.slice(context.chunk_start_offset, context.chunk_end_offset),
    context.text,
    "Replay context is not the persisted chunk slice"
  );
  assert.equal(
    context.text.slice(context.quote_start_offset, context.quote_end_offset),
    replay.quote.text,
    "Replay offsets do not select the exact quote"
  );
  assert.ok(context.text.includes(replay.quote.text), "Replay context does not contain the exact quote");
  return replay;
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
    server.listen(FIXTURE_PORT, "127.0.0.1", () => resolve({ server, port: server.address().port }));
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
      "--host-resolver-rules=MAP demo.qc-reader.localhost 127.0.0.1",
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`
    ]
  };
}

async function installFixedCaptureDate(context) {
  await context.addInitScript((capturedAt) => {
    const NativeDate = globalThis.Date;
    globalThis.Date = new Proxy(NativeDate, {
      construct(target, args) {
        return Reflect.construct(target, args.length ? args : [capturedAt]);
      }
    });
  }, FIXTURE_CAPTURED_AT);
}

async function redactVisibleLocalValues(page) {
  await page.evaluate((publicFixtureUrl) => {
    const redact = (value) => String(value || "")
      .replace(/http:\/\/demo\.qc-reader\.localhost:\d+\/qc-reader\/demo\/issues\/1/g, publicFixtureUrl)
      .replace(/http:\/\/(?:127\.0\.0\.1|localhost):\d+/g, "LOCAL_COMPANION")
      .replace(/\/(?:private\/)?var\/folders\/\S+/g, "LOCAL_VAULT/…")
      .replace(/\/(?:Users|home)\/[^\s/]+\/\S+/g, "LOCAL_VAULT/…")
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
  }, PUBLIC_FIXTURE_URL);
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
  assert.doesNotMatch(rendered, /demo\.qc-reader\.localhost:\d+/, `${label} contains the fixture port`);
  assert.doesNotMatch(rendered, /PUBLIC_FIXTURE_TIME/, `${label} contains a development placeholder`);
}

async function captureViewport(
  page,
  path,
  anchor = null,
  blockedValues = [],
  viewport = { width: 480, height: 800 },
  captureOptions = {}
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
      ${captureOptions.extraCss || ""}
    `
  });
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });
  await redactVisibleLocalValues(page);
  await assertSafePage(page, path, blockedValues);
  const alignViewport = async () => {
    if (anchor) {
      await page.locator(anchor).first().evaluate((node, anchorBlock) => {
        const bounds = node.getBoundingClientRect();
        const targetTop = anchorBlock === "end" ? window.innerHeight - bounds.height - 1 : 0;
        const top = node.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top: top - targetTop, left: 0, behavior: "instant" });
      }, captureOptions.anchorBlock || "start");
    } else {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (anchor) {
      const anchorPosition = await page.locator(anchor).first().evaluate((node, anchorBlock) => {
        const bounds = node.getBoundingClientRect();
        return {
          actualTop: bounds.top,
          targetTop: anchorBlock === "end" ? window.innerHeight - bounds.height - 1 : 0
        };
      }, captureOptions.anchorBlock || "start");
      let anchorDelta = anchorPosition.actualTop - anchorPosition.targetTop;
      if (Math.abs(anchorDelta) >= 0.01) {
        await page.evaluate((delta) => window.scrollBy({ top: delta, left: 0, behavior: "instant" }), anchorDelta);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const alignedPosition = await page.locator(anchor).first().evaluate((node, anchorBlock) => {
          const bounds = node.getBoundingClientRect();
          return {
            actualTop: bounds.top,
            targetTop: anchorBlock === "end" ? window.innerHeight - bounds.height - 1 : 0
          };
        }, captureOptions.anchorBlock || "start");
        anchorDelta = alignedPosition.actualTop - alignedPosition.targetTop;
      }
      assert.ok(
        Math.abs(anchorDelta) <= 0.5,
        `${path} anchor did not align to the nearest device pixel: ${anchorDelta}`
      );
    }
  };
  const alignReplayQuote = async () => {
    if (!captureOptions.focusReplayQuote) return;
    await page.evaluate(() => {
      const context = document.querySelector("#quickStartReplayPanel [data-replay-context]");
      const quote = context?.querySelector?.("[data-replay-exact-quote]");
      if (!context || !quote) return;
      const contextRect = context.getBoundingClientRect();
      const quoteRect = quote.getBoundingClientRect();
      const quoteTopInContent = context.scrollTop + quoteRect.top - contextRect.top - context.clientTop;
      context.scrollTop = Math.max(
        0,
        quoteTopInContent - Math.floor((context.clientHeight - quoteRect.height) / 2)
      );
    });
  };
  await alignViewport();
  await alignReplayQuote();
  // The first raster of a fresh headless profile can differ by a subpixel. Discard one
  // real render so the persisted capture uses the settled compositor and font cache.
  await page.screenshot({ animations: "disabled" });
  await alignViewport();
  await alignReplayQuote();
  await page.screenshot({ path, animations: "disabled" });
}

async function assertPngDimensions(path, width = 1280, height = 800) {
  const data = await readFile(path);
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path} is not a PNG`);
  assert.equal(data.readUInt32BE(16), width, `${path} width`);
  assert.equal(data.readUInt32BE(20), height, `${path} height`);
  assert.equal(data[25], 2, `${path} must use RGB PNG color`);
}

function fixtureHtml() {
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <title>${FIXTURE_TITLE}</title>
      </head>
      <body>
        <main>
          <article class="content">
            <h1>${FIXTURE_TITLE}</h1>
            <p>${FIXTURE_QUOTE}</p>
            <p>Local-first storage keeps raw captures, structured records, review decisions, and lineage under the user's control.</p>
            <p>Source Replay returns the stored locator, captured context, exact quotation, and source version without contacting the live page.</p>
            <p>A reviewer can mark the draft supported or unsupported without losing that captured evidence.</p>
          </article>
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
    await installFixedCaptureDate(context);
    const worker = await extensionServiceWorker(T, context);
    const extensionId = new URL(worker.url()).host;
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    const blockedValues = [token, dataDir, userDataDir, process.env.HOME, serviceUrl, fixtureUrl];
    const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;

    const sidepanel = await context.newPage();
    await sidepanel.goto(sidepanelUrl, { waitUntil: "domcontentloaded" });
    await sidepanel.waitForFunction((expected) => document.documentElement.lang === expected, spec.htmlLang);
    const fixtureClock = await sidepanel.evaluate(() => ({
      constructedAt: new Date().toISOString(),
      realNow: Date.now()
    }));
    assert.equal(fixtureClock.constructedAt, FIXTURE_CAPTURED_AT, "the public fixture clock was not installed");
    assert.ok(
      Math.abs(fixtureClock.realNow - Date.now()) < 5_000,
      "Date.now() must remain real while no-argument new Date() is fixed"
    );
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
    assert.equal(firstEvidence.claim, FIXTURE_QUOTE, "the deterministic claim drifted from the public fixture");
    assert.equal(firstEvidence.quote, FIXTURE_QUOTE, "the exact quote drifted from the public fixture");
    assert.equal(firstEvidence.reviewStatusKey, "firstEvidence.review.pending");
    assert.equal(await sidepanel.locator("#quickStartReplayBtn").isVisible(), true, "pending Replay is hidden");
    assert.equal(
      await sidepanel.locator("#quickStartReplayBtn").getAttribute("aria-expanded"),
      "false",
      "pending Replay must start folded"
    );
    assert.equal(await sidepanel.locator("#quickStartReplayPanel").isHidden(), true, "pending Replay panel is open");

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
      (data) => (
        (data.claims || []).some((claim) => claim.id === firstEvidence.claimId)
          && (data.evidence || []).some((evidence) => evidence.id === firstEvidence.evidenceId)
      ),
      `${spec.outputLocale} pending claim`
    );
    assert.equal(
      ["reviewed", "rejected"].includes(
        beforeReview.claims.find((claim) => claim.id === firstEvidence.claimId)?.status
      ),
      false,
      "Quick Start decided the claim before a human action"
    );
    const listedEvidence = beforeReview.evidence.find((evidence) => evidence.id === firstEvidence.evidenceId);
    const detailedEvidence = (
      await serviceJson(serviceUrl, token, `/v1/evidence/${encodeURIComponent(firstEvidence.evidenceId)}`)
    ).evidence;
    assert.deepEqual(detailedEvidence.replay, listedEvidence.replay, "detail and list Replay payloads differ");
    const expectedReplay = assertResolvedReplayContract({
      evidence: detailedEvidence,
      sourceDetail,
      firstEvidence,
      fixtureUrl
    });
    assert.equal(
      await sidepanel.locator("#quickStartReplayBtn").getAttribute("data-replay-id"),
      expectedReplay.replay_id,
      "pending Replay control is not linked to the service replay"
    );
    assert.equal(
      await sidepanel.locator("#quickStartReplayPanel").getAttribute("data-replay-panel"),
      expectedReplay.replay_id,
      "pending Replay panel is not linked to the service replay"
    );

    await sidepanel.bringToFront();
    const pendingPath = join(outputDir, "01-first-evidence-pending-review.png");
    await captureViewport(
      sidepanel,
      pendingPath,
      "#quickStartEvidence",
      blockedValues,
      WEB_STORE_VIEWPORT,
      { anchorBlock: "end" }
    );
    const pendingLayout = await sidepanel.evaluate(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const bounds = node.getBoundingClientRect();
        return {
          top: bounds.top,
          bottom: bounds.bottom,
          left: bounds.left,
          right: bounds.right,
          width: bounds.width,
          height: bounds.height
        };
      };
      const replayButton = document.querySelector("#quickStartReplayBtn");
      const replayPanel = document.querySelector("#quickStartReplayPanel");
      return {
        viewport: { width: innerWidth, height: innerHeight },
        evidenceCard: rect("#quickStartEvidence"),
        replayAction: rect("#quickStartReplayBtn"),
        prompt: rect("#quickStartEvidence .first-evidence-prompt"),
        acceptedDecision: rect("#quickStartAcceptClaimBtn"),
        rejectedDecision: rect("#quickStartRejectClaimBtn"),
        reviewStatus: rect("#quickStartReviewStatus"),
        toolbar: rect("#knowledge > .toolbar"),
        replayExpanded: replayButton?.getAttribute("aria-expanded") || "",
        replayPanelHidden: Boolean(replayPanel?.hidden),
        reviewStatusKey: document.querySelector("#quickStartReviewStatus")?.dataset.i18nDynamicKey || ""
      };
    });
    assert.deepEqual(pendingLayout.viewport, WEB_STORE_VIEWPORT);
    for (const name of [
      "evidenceCard",
      "replayAction",
      "prompt",
      "acceptedDecision",
      "rejectedDecision",
      "reviewStatus"
    ]) {
      const rect = pendingLayout[name];
      assert.ok(rect && rect.width > 0 && rect.height > 0, `${name} is absent from the pending screenshot`);
      assert.ok(
        rect.top >= 0
          && rect.bottom <= WEB_STORE_VIEWPORT.height
          && rect.left >= 0
          && rect.right <= WEB_STORE_VIEWPORT.width,
        `${name} is clipped in the pending screenshot: ${JSON.stringify(rect)}`
      );
    }
    assert.ok(
      Math.abs(pendingLayout.acceptedDecision.width - pendingLayout.rejectedDecision.width) <= 0.01,
      "pending accept and reject controls do not have equal width"
    );
    assert.ok(
      Math.abs(pendingLayout.acceptedDecision.height - pendingLayout.rejectedDecision.height) <= 0.01,
      "pending accept and reject controls do not have equal height"
    );
    assert.equal(pendingLayout.replayExpanded, "false", "redaction expanded the pending Replay control");
    assert.equal(pendingLayout.replayPanelHidden, true, "redaction exposed the pending Replay panel");
    assert.equal(pendingLayout.reviewStatusKey, "firstEvidence.review.pending");
    assert.ok(
      pendingLayout.toolbar?.top >= WEB_STORE_VIEWPORT.height,
      `the non-core toolbar entered the pending screenshot: ${JSON.stringify(pendingLayout.toolbar)}`
    );

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
    const reviewedRecords = await waitForServiceRecord(
      () => serviceJson(serviceUrl, token, "/v1/knowledge/records?limit=50&project_id=default"),
      (data) => (data.claims || []).some((claim) => (
        claim.id === firstEvidence.claimId && claim.status === "reviewed"
      )),
      `${spec.outputLocale} reviewed claim`
    );
    assert.equal(
      reviewedRecords.claims.find((claim) => claim.id === firstEvidence.claimId)?.status,
      "reviewed",
      "Companion did not persist the supported decision"
    );
    const reviewedEvidence = (
      await serviceJson(serviceUrl, token, `/v1/evidence/${encodeURIComponent(firstEvidence.evidenceId)}`)
    ).evidence;
    assert.deepEqual(reviewedEvidence.replay, expectedReplay, "human review mutated the protected Replay record");

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
    assert.equal(await reopened.locator("#quickStartReplayBtn").isVisible(), true, "restored Replay is hidden");
    assert.equal(
      await reopened.locator("#quickStartReplayBtn").getAttribute("aria-expanded"),
      "false",
      "restored Replay must start folded"
    );
    assert.equal(await reopened.locator("#quickStartReplayPanel").isHidden(), true, "restored Replay starts open");
    assert.equal(
      await reopened.locator("#quickStartReplayBtn").getAttribute("data-replay-id"),
      expectedReplay.replay_id,
      "restored Replay control points at another service record"
    );

    await reopened.locator("#quickStartReplayBtn").click();
    await reopened.waitForFunction(({ replayId, quote }) => {
      const button = document.querySelector("#quickStartReplayBtn");
      const panel = document.querySelector("#quickStartReplayPanel");
      return button?.getAttribute("aria-expanded") === "true"
        && panel
        && !panel.hidden
        && panel.dataset.replayPanel === replayId
        && panel.dataset.replayStatus === "resolved"
        && panel.querySelector("[data-replay-exact-quote]")?.textContent === quote;
    }, { replayId: expectedReplay.replay_id, quote: expectedReplay.quote.text }, { timeout: 15_000 });
    const replayDom = await replayDomSnapshot(reopened);
    assert.equal(replayDom.expanded, "true");
    assert.equal(replayDom.replayId, expectedReplay.replay_id);
    assert.equal(replayDom.panelReplayId, expectedReplay.replay_id);
    assert.equal(replayDom.panelStatus, expectedReplay.status);
    assert.equal(replayDom.panelHidden, false);
    assert.equal(
      replayDom.status,
      spec.htmlLang === "zh-CN" ? "已核验捕获快照" : "Captured snapshot verified"
    );
    assert.match(replayDom.locator, spec.htmlLang === "zh-CN" ? /^网页/ : /^Web/);
    assert.ok(
      replayDom.locator.includes(`Chunk ${Number(expectedReplay.locator.chunk_index) + 1}`),
      "rendered locator differs from the protected Replay locator"
    );
    assert.equal(replayDom.sourceTitle, expectedReplay.source.title);
    assert.ok(replayDom.sourceMeta.includes(FIXTURE_CAPTURED_AT), "rendered source meta lost its capture time");
    assert.ok(replayDom.sourceMeta.includes("v1"), "rendered source meta lost its version");
    assert.ok(replayDom.sourceMeta.includes(expectedReplay.source.content_hash), "rendered source meta lost its hash");
    assert.ok(
      replayDom.sourceMeta.includes(spec.htmlLang === "zh-CN" ? "当前捕获版本" : "Current captured version"),
      "rendered source meta lost its current-version state"
    );
    assert.ok(replayDom.provenance.includes(expectedReplay.locator.provenance));
    assert.equal(replayDom.quote, expectedReplay.quote.text);
    assert.equal(replayDom.context, expectedReplay.context.text);
    assert.ok(replayDom.reason, "resolved Replay did not explain its exact match");
    assert.equal(replayDom.sourceUrl, expectedReplay.source.open_url);
    assert.equal(replayDom.claimStatus, "reviewed");
    assert.equal(replayDom.reviewStatusKey, "firstEvidence.review.reviewed");

    const reviewedPath = join(outputDir, "02-reviewed-exact-quote.png");
    await captureViewport(
      reopened,
      reviewedPath,
      "#quickStartReplayContainer",
      blockedValues,
      WEB_STORE_VIEWPORT,
      { extraCss: REVIEWED_CAPTURE_CSS, focusReplayQuote: true }
    );
    const redactedReplayDom = await replayDomSnapshot(reopened);
    assert.equal(redactedReplayDom.expanded, "true", "redaction folded the reviewed Replay control");
    assert.equal(redactedReplayDom.replayId, expectedReplay.replay_id, "redaction changed the Replay id");
    assert.equal(
      redactedReplayDom.panelReplayId,
      expectedReplay.replay_id,
      "redaction disconnected the Replay panel"
    );
    assert.equal(redactedReplayDom.panelStatus, expectedReplay.status, "redaction changed Replay status");
    assert.equal(redactedReplayDom.panelHidden, false, "redaction hid the reviewed Replay panel");
    assert.equal(redactedReplayDom.status, replayDom.status, "redaction changed the localized resolved status");
    assert.equal(redactedReplayDom.quote, expectedReplay.quote.text, "redaction changed the exact quote");
    assert.equal(
      redactedReplayDom.context,
      redactExpectedVisibleText(expectedReplay.context.text),
      "redaction changed captured context beyond the declared public fixture substitution"
    );
    assert.ok(
      redactedReplayDom.sourceMeta.includes(expectedReplay.source.captured_at),
      "redaction changed the protected captured_at value"
    );
    assert.ok(
      redactedReplayDom.sourceMeta.includes(expectedReplay.source.content_hash),
      "redaction changed the protected source hash"
    );
    assert.doesNotMatch(
      `${redactedReplayDom.bodyText}\n${redactedReplayDom.context}\n${redactedReplayDom.sourceMeta}`,
      /PUBLIC_FIXTURE_TIME/,
      "post-redaction DOM contains a development time placeholder"
    );
    const reviewedLayout = await reopened.evaluate(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const bounds = node.getBoundingClientRect();
        return {
          top: bounds.top,
          bottom: bounds.bottom,
          left: bounds.left,
          right: bounds.right,
          width: bounds.width,
          height: bounds.height
        };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        replayAction: rect("#quickStartReplayBtn"),
        status: rect("#quickStartReplayPanel [data-replay-status]"),
        locator: rect("#quickStartReplayPanel [data-replay-locator]"),
        sourceMeta: rect("#quickStartReplayPanel .replay-source-meta"),
        context: rect("#quickStartReplayPanel [data-replay-context]"),
        exactQuote: rect("#quickStartReplayPanel [data-replay-exact-quote]"),
        acceptedDecision: rect("#quickStartAcceptClaimBtn"),
        rejectedDecision: rect("#quickStartRejectClaimBtn"),
        reviewStatus: rect("#quickStartReviewStatus")
      };
    });
    assert.deepEqual(reviewedLayout.viewport, WEB_STORE_VIEWPORT);
    for (const [name, rect] of Object.entries(reviewedLayout).filter(([key]) => key !== "viewport")) {
      assert.ok(rect && rect.width > 0 && rect.height > 0, `${name} is absent from the reviewed screenshot`);
      assert.ok(
        rect.top >= -0.01
          && rect.bottom <= WEB_STORE_VIEWPORT.height + 0.01
          && rect.left >= -0.01
          && rect.right <= WEB_STORE_VIEWPORT.width + 0.01,
        `${name} is clipped in the reviewed screenshot: ${JSON.stringify(rect)}`
      );
    }
    assert.ok(
      reviewedLayout.exactQuote.top >= reviewedLayout.context.top
        && reviewedLayout.exactQuote.bottom <= reviewedLayout.context.bottom,
      `the highlighted exact quote is clipped inside the captured context: ${JSON.stringify({
        context: reviewedLayout.context,
        exactQuote: reviewedLayout.exactQuote
      })}`
    );
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
  const fixtureUrl = `http://demo.qc-reader.localhost:${fixture.port}/qc-reader/demo/issues/1`;
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
    console.log(`- ${outputPath} (${WEB_STORE_VIEWPORT.width}x${WEB_STORE_VIEWPORT.height}, RGB)`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
