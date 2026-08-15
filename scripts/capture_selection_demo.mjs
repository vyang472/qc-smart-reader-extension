#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { extensionServiceWorker, launchPersistentChromium } from "../tests/browser_runtime.mjs";

process.env.QC_REQUIRE_BROWSER = "1";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT_DIR = join(ROOT, "store-assets", "demo");
const OUTPUT_GIF = join(OUTPUT_DIR, "selection-first-evidence.gif");
const OUTPUT_SUMS = join(OUTPUT_DIR, "SHA256SUMS");
const PRODUCT_VERSION = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8")).version;
const PYTHON = process.env.QC_TEST_PYTHON
  || (existsSync(join(ROOT, ".venv", "bin", "python")) ? join(ROOT, ".venv", "bin", "python") : "python3");
const FFMPEG = process.env.QC_DEMO_FFMPEG || "ffmpeg";
const START_TIMEOUT_MS = Number(process.env.QC_COMPANION_START_TIMEOUT_MS || 90_000);
const FIXTURE_PORT = Number(process.env.QC_SELECTION_DEMO_FIXTURE_PORT || 41_784);
const FIXTURE_PATH = "/evidence-first-workflow";
const FIXTURE_HOST = "selection-demo.localhost";
const FIXTURE_URL = `http://${FIXTURE_HOST}:${FIXTURE_PORT}${FIXTURE_PATH}`;
const PUBLIC_FIXTURE_URL = "https://demo.qc-reader.local/evidence-first-workflow";
const CAPTURED_AT = "2026-08-15T08:00:00.000Z";
const QUOTE = "A claim is trustworthy only when its exact source quote remains available for review.";
const CONTEXT_PREFIX = "Evidence-first research keeps the source beside every conclusion.";
const CONTEXT_SUFFIX = "The reader—not the model—makes the final supported or unsupported decision.";
const FRAME_SIZE = { width: 960, height: 540 };
const FRAME_DURATIONS = [7, 7, 8, 7, 8];
const T = { skip(reason) { throw new Error(reason); } };

assert.ok(Number.isInteger(FIXTURE_PORT) && FIXTURE_PORT >= 1 && FIXTURE_PORT <= 65_535);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForHealth(serviceUrl, companion) {
  const started = Date.now();
  while (Date.now() - started < START_TIMEOUT_MS) {
    const failure = companion.failure();
    if (failure) throw new Error(`${failure}\nservice output:\n${companion.output()}`);
    try {
      const response = await fetch(`${serviceUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response.json();
    } catch {
      // The clean Companion is still starting.
    }
    await sleep(100);
  }
  throw new Error(
    `Companion did not become healthy in ${START_TIMEOUT_MS} ms\nservice output:\n${companion.output()}`
  );
}

async function serviceJson(serviceUrl, token, path, options = {}) {
  const request = { ...options };
  const headers = { ...(options.headers || {}), "x-qc-pairing-token": token };
  if (request.body && typeof request.body !== "string") {
    request.body = JSON.stringify(request.body);
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${serviceUrl}${path}`, { ...request, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Companion ${response.status} ${path}: ${text.slice(0, 500)}`);
  return data;
}

async function waitForRecords(serviceUrl, token, predicate, label, timeoutMs = 20_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await serviceJson(serviceUrl, token, "/v1/knowledge/records?limit=50&project_id=default");
    if (predicate(last)) return last;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last).slice(0, 1_000)}`);
}

function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function startFixtureServer() {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Public evidence review fixture</title>
<style>
  :root { color-scheme: light; font-family: Arial, sans-serif; color: #132238; background: #eef4fa; }
  body { margin: 0; padding: 36px; }
  article { width: 800px; margin: 0 auto; padding: 36px 44px; background: white; border: 1px solid #cbd9e8; border-radius: 18px; box-shadow: 0 18px 50px rgba(21,47,76,.12); }
  .eyebrow { color: #087b62; font-size: 13px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  h1 { margin: 10px 0 12px; font-size: 32px; }
  p { font-size: 18px; line-height: 1.55; color: #405570; }
  blockquote { margin: 24px 0; padding: 20px 22px; border-left: 5px solid #169b7b; border-radius: 0 12px 12px 0; background: #eaf8f4; font-size: 23px; font-weight: 750; line-height: 1.45; color: #142f2a; }
  ::selection { color: #071525; background: #f9d66b; }
</style></head><body><article>
<div class="eyebrow">Public synthetic fixture · no private data</div>
<h1>Review the evidence, not the fluency</h1>
<p id="prefix">${CONTEXT_PREFIX}</p>
<blockquote id="quote">${QUOTE}</blockquote>
<p id="suffix">${CONTEXT_SUFFIX}</p>
</article></body></html>`;
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.url === FIXTURE_PATH) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    });
    server.once("error", reject);
    server.listen(FIXTURE_PORT, "127.0.0.1", () => resolve(server));
  });
}

function extensionOptions() {
  return {
    headless: true,
    channel: "chromium",
    locale: "en-US",
    viewport: FRAME_SIZE,
    deviceScaleFactor: 1,
    args: [
      "--lang=en-US",
      `--host-resolver-rules=MAP ${FIXTURE_HOST} 127.0.0.1`,
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
  }, CAPTURED_AT);
}

async function waitForInteractiveSidepanel(page) {
  await page.waitForFunction(() => (
    document.documentElement.dataset.qcInteractiveReady === "true"
      && document.body.inert === false
      && document.body.getAttribute("aria-busy") === "false"
  ));
}

async function installCaptureOnlyStyle(page) {
  await page.addStyleTag({ content: `
    * { animation: none !important; caret-color: transparent !important; transition: none !important; }
    html { scroll-behavior: auto !important; }
    .quick-start-highlight { box-shadow: none !important; outline: none !important; }
    #quickStartReplayContainer { gap: 4px !important; margin-top: 0 !important; padding-top: 1px !important; }
    #quickStartReplayBtn { min-height: 28px !important; padding: 4px 9px !important; font-size: 11px !important; }
    #quickStartReplayPanel { gap: 3px !important; padding: 6px !important; }
    #quickStartReplayPanel .replay-status-row { gap: 3px 7px !important; }
    #quickStartReplayPanel .replay-status { padding: 2px 6px !important; font-size: 9px !important; }
    #quickStartReplayPanel .replay-locator,
    #quickStartReplayPanel .replay-source-meta,
    #quickStartReplayPanel .replay-provenance,
    #quickStartReplayPanel .replay-reason,
    #quickStartReplayPanel .replay-source-link { font-size: 9px !important; line-height: 1.2 !important; }
    #quickStartReplayPanel .replay-source-title { font-size: 11px !important; line-height: 1.2 !important; }
    #quickStartReplayPanel .replay-snapshot-label { font-size: 9px !important; line-height: 1.15 !important; }
    #quickStartReplayPanel .replay-context { max-height: 68px !important; padding: 5px !important; font-size: 10px !important; line-height: 1.3 !important; }
    #quickStartEvidence .first-evidence-prompt { margin: 5px 0 3px !important; font-size: 10px !important; line-height: 1.2 !important; }
    #quickStartEvidence .first-evidence-actions { gap: 5px !important; }
    #quickStartEvidence .first-evidence-actions button { min-height: 28px !important; padding: 4px 7px !important; font-size: 10px !important; }
    #quickStartReviewStatus { margin-top: 3px !important; font-size: 9px !important; line-height: 1.2 !important; }
    ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
  ` });
}

async function redactSidepanel(page, blockedValues) {
  await page.evaluate(({ actualUrl, publicUrl }) => {
    const redact = (value) => String(value || "")
      .replaceAll(actualUrl, publicUrl)
      .replace(/http:\/\/(?:127\.0\.0\.1|localhost):\d+/g, "LOCAL_COMPANION")
      .replace(/\/(?:private\/)?var\/folders\/\S+/g, "LOCAL_VAULT/…")
      .replace(/\/(?:Users|home)\/[^\s/]+\/\S+/g, "LOCAL_VAULT/…")
      .replace(/\b(src|chk|claim|ev|evidence|doc)_[A-Za-z0-9_-]+\b/g, "$1_demo");
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) node.textContent = redact(node.textContent);
    document.querySelectorAll("input, textarea").forEach((node) => {
      node.value = node.type === "password" ? "" : redact(node.value);
    });
    document.querySelectorAll("a[href]").forEach((node) => {
      if (node.href === actualUrl) node.href = publicUrl;
    });
    document.activeElement?.blur?.();
  }, { actualUrl: FIXTURE_URL, publicUrl: PUBLIC_FIXTURE_URL });

  const visible = await page.evaluate(() => [
    document.body.textContent || "",
    ...[...document.querySelectorAll("input, textarea")].map((node) => node.value || "")
  ].join("\n"));
  for (const value of blockedValues.filter(Boolean)) {
    assert.equal(visible.includes(value), false, "demo frame still contains a blocked local value");
  }
  assert.doesNotMatch(visible, /\/(?:Users|home)\/[^\s/]+\//);
  assert.doesNotMatch(visible, /\/(?:private\/)?var\/folders\//);
  assert.doesNotMatch(visible, /(?:127\.0\.0\.1|localhost):\d+/);
}

async function captureEvidenceCard(page, outputPath, blockedValues) {
  await page.setViewportSize({ width: 680, height: 800 });
  await installCaptureOnlyStyle(page);
  await redactSidepanel(page, blockedValues);
  const card = page.locator("#quickStartEvidence");
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });
  await card.screenshot({ path: outputPath, animations: "disabled" });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function renderStageFrame(page, screenshotPath, outputPath, { step, title, subtitle }) {
  const image = (await readFile(screenshotPath)).toString("base64");
  await page.setViewportSize(FRAME_SIZE);
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 960px; height: 540px; overflow: hidden; }
    body { font-family: Arial, sans-serif; color: #ecf5ff; background: linear-gradient(135deg,#07192d 0%,#0c2943 56%,#0b4a43 100%); }
    main { height: 100%; display: grid; grid-template-rows: 104px 386px 50px; }
    header { padding: 22px 34px 10px; display: grid; grid-template-columns: 110px 1fr; column-gap: 18px; align-items: center; }
    .step { width: 104px; padding: 9px 10px; border: 1px solid #48d9b0; border-radius: 999px; color: #68ecc6; font-weight: 800; text-align: center; letter-spacing: .04em; }
    h1 { margin: 0 0 6px; font-size: 26px; line-height: 1.1; }
    header p { margin: 0; color: #bad0e4; font-size: 15px; line-height: 1.35; }
    .media { margin: 0 28px; border: 1px solid rgba(136,184,220,.52); border-radius: 16px; background: rgba(239,248,255,.96); display: flex; align-items: center; justify-content: center; overflow: hidden; box-shadow: 0 14px 34px rgba(0,0,0,.26); }
    .media img { display: block; max-width: 900px; max-height: 374px; object-fit: contain; }
    footer { display: flex; align-items: center; justify-content: center; gap: 22px; color: #b9cde0; font-size: 14px; font-weight: 700; }
    footer span::before { content: "✓"; margin-right: 6px; color: #47deb3; }
  </style></head><body><main>
    <header><div class="step">${escapeHtml(step)}</div><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div></header>
    <div class="media"><img src="data:image/png;base64,${image}" alt=""></div>
    <footer><span>Exact quote</span><span>Human-reviewed</span><span>Local-first</span><span>No model required</span></footer>
  </main></body></html>`);
  await page.waitForFunction(() => [...document.images].every((imageNode) => imageNode.complete));
  await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
  await page.screenshot({ path: outputPath, animations: "disabled" });
}

async function buildGif(frames, outputPath, workDir) {
  const concatPath = join(workDir, "frames.txt");
  const palettePath = join(workDir, "palette.png");
  const lines = [];
  for (let index = 0; index < frames.length; index += 1) {
    lines.push(`file '${frames[index].replaceAll("'", "'\\''")}'`);
    lines.push(`duration ${FRAME_DURATIONS[index]}`);
  }
  lines.push(`file '${frames.at(-1).replaceAll("'", "'\\''")}'`);
  await writeFile(concatPath, `${lines.join("\n")}\n`, "utf8");

  await execFilePromise(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-vf", "palettegen=max_colors=96:stats_mode=diff",
    "-frames:v", "1", palettePath
  ]);
  await execFilePromise(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-i", palettePath,
    "-lavfi", "paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    "-loop", "0", "-fps_mode", "vfr", outputPath
  ]);
}

async function captureRun(runRoot) {
  const dataDir = join(runRoot, "companion-data");
  const userDataDir = join(runRoot, "chrome-profile");
  const rawDir = join(runRoot, "raw");
  const frameDir = join(runRoot, "frames");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(rawDir, { recursive: true }),
    mkdir(frameDir, { recursive: true })
  ]);

  const servicePort = await freePort();
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const companion = startCompanion(dataDir, servicePort);
  let context;
  let fixtureServer;
  try {
    const health = await waitForHealth(serviceUrl, companion);
    assert.equal(health.service_version, PRODUCT_VERSION);
    assert.ok((health.capabilities || []).includes("selection_first_evidence_v1"));
    const token = (await readFile(join(dataDir, "state", "pairing_token.txt"), "utf8")).trim();
    fixtureServer = await startFixtureServer();

    context = await launchPersistentChromium(T, userDataDir, extensionOptions());
    assert.ok(context, "Chromium did not launch");
    await installFixedCaptureDate(context);
    const worker = await extensionServiceWorker(T, context);
    assert.ok(worker, "extension service worker is unavailable");
    assert.equal(
      await worker.evaluate(() => chrome.runtime.getManifest().version),
      PRODUCT_VERSION,
      "the loaded extension version differs from the demo contract"
    );
    const extensionId = new URL(worker.url()).host;
    const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;

    await worker.evaluate(async ({ targetServiceUrl, pairingToken }) => {
      await chrome.storage.local.set({
        settings: {
          serviceUrl: targetServiceUrl,
          pairingToken,
          projectId: "default",
          provider: "mock",
          baseUrl: "",
          model: "",
          modelReady: true,
          modelRoute: "mock"
        }
      });
      await chrome.storage.local.remove(["pendingSelections", "onboardingMilestones"]);
      await chrome.storage.session.remove([
        "pendingSelection", "pendingSelections", "pendingSelectionNotice", "pendingSelectionSessionId"
      ]);
    }, { targetServiceUrl: serviceUrl, pairingToken: token });

    const fixturePage = await context.newPage();
    await fixturePage.setViewportSize({ width: 920, height: 390 });
    await fixturePage.goto(FIXTURE_URL, { waitUntil: "networkidle" });
    await fixturePage.locator("#quote").evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const fixtureRaw = join(rawDir, "selection.png");
    await fixturePage.screenshot({ path: fixtureRaw, animations: "disabled" });

    const fixtureTab = await worker.evaluate(async (targetUrl) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url === targetUrl);
      return tab ? { tabId: tab.id, windowId: tab.windowId } : null;
    }, FIXTURE_URL);
    assert.ok(fixtureTab?.tabId && fixtureTab?.windowId, "fixture tab could not be resolved");
    const sidepanel = await context.newPage();
    await sidepanel.setViewportSize({ width: 680, height: 800 });
    await sidepanel.goto(sidepanelUrl, { waitUntil: "domcontentloaded" });
    await waitForInteractiveSidepanel(sidepanel);
    const queuedSelection = await worker.evaluate(async ({ tabId, expectedQuote, sourceUrl, capturedAt }) => {
      const NativeDate = globalThis.Date;
      globalThis.Date = new Proxy(NativeDate, {
        construct(target, args) {
          return Reflect.construct(target, args.length ? args : [capturedAt]);
        }
      });
      try {
        const tab = await chrome.tabs.get(tabId);
        chrome.contextMenus.onClicked.dispatch({
          menuItemId: "qc-smart-read-selection",
          selectionText: expectedQuote,
          frameId: 0,
          pageUrl: sourceUrl
        }, tab);
        const deadline = NativeDate.now() + 5_000;
        while (NativeDate.now() < deadline) {
          const stored = await chrome.storage.local.get("pendingSelections");
          const selection = (stored.pendingSelections || []).find((item) => item.text === expectedQuote);
          if (selection) return selection;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("the production context-menu listener did not enqueue the selection");
      } finally {
        globalThis.Date = NativeDate;
      }
    }, {
      tabId: fixtureTab.tabId,
      expectedQuote: QUOTE,
      sourceUrl: FIXTURE_URL,
      capturedAt: CAPTURED_AT
    });
    assert.equal(queuedSelection?.text, QUOTE, "the production DOM snapshot changed the exact quote");
    assert.equal(queuedSelection?.contextText, QUOTE, "the production DOM snapshot contract drifted");
    assert.equal(queuedSelection?.contextMode, "quote-only");
    assert.equal(queuedSelection?.capturedAt, CAPTURED_AT);
    assert.equal(queuedSelection?.url, FIXTURE_URL);

    await sidepanel.waitForFunction((quote) => {
      const card = document.querySelector("#quickStartEvidence");
      return card?.hidden === false
        && card.dataset.claimStatus === "pending_validation"
        && document.querySelector("#quickStartQuoteText")?.textContent === quote
        && card.dataset.evidenceId;
    }, QUOTE);
    assert.equal(await sidepanel.locator("#quickStartAcceptClaimBtn").isDisabled(), false);
    assert.equal(await sidepanel.locator("#quickStartRejectClaimBtn").isDisabled(), false);

    const pendingRecords = await waitForRecords(
      serviceUrl,
      token,
      (records) => (records.evidence || []).some((item) => item.quote === QUOTE),
      "pending selection First Evidence"
    );
    const evidence = pendingRecords.evidence.find((item) => item.quote === QUOTE);
    const claim = pendingRecords.claims.find((item) => item.id === evidence.claim_id);
    assert.equal(claim.status, "pending_validation");
    assert.equal(evidence.status, "pending_validation");
    assert.equal(evidence.replay?.status, "resolved");
    assert.equal(evidence.replay?.reason, "exact_quote_match");
    assert.equal(evidence.replay?.version, 1);
    assert.equal(evidence.replay?.evidence_id, evidence.id);
    assert.equal(evidence.replay?.claim_id, claim.id);
    assert.equal(evidence.replay?.source_id, evidence.source_id);
    assert.equal(evidence.replay?.quote?.text, QUOTE);
    assert.equal(evidence.replay?.quote?.sha256, sha256(Buffer.from(QUOTE, "utf8")));
    assert.equal(
      evidence.replay.context.text.slice(
        evidence.replay.context.quote_start_offset,
        evidence.replay.context.quote_end_offset
      ),
      QUOTE
    );
    const source = (
      await serviceJson(serviceUrl, token, `/v1/sources/${encodeURIComponent(evidence.source_id)}`)
    ).source;
    assert.ok(source.text.includes(QUOTE));
    assert.equal(source.captured_at, CAPTURED_AT);
    assert.equal(evidence.replay?.source?.captured_at, CAPTURED_AT);
    assert.equal(evidence.replay?.source?.version_index, 1);
    assert.equal(evidence.replay?.source?.is_current, true);
    assert.equal(evidence.replay?.source?.current_source_id, source.id);
    assert.equal(evidence.replay?.source?.content_hash, source.content_hash);

    const extensionState = await worker.evaluate(async () => {
      const local = await chrome.storage.local.get(["pendingSelections", "onboardingMilestones"]);
      return { pendingSelections: local.pendingSelections || [], milestones: local.onboardingMilestones || {} };
    });
    assert.deepEqual(extensionState.pendingSelections, []);
    assert.equal(extensionState.milestones.firstClaimId, claim.id);
    assert.equal(extensionState.milestones.firstEvidenceId, evidence.id);
    for (const forbidden of ["text", "quote", "context", "contextText", "replay", "pairingToken"]) {
      assert.equal(forbidden in extensionState.milestones, false);
    }
    const runCount = await execFilePromise(PYTHON, [
      "-c",
      "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute('SELECT COUNT(*) FROM agent_runs').fetchone()[0]); db.close()",
      join(dataDir, "state", "qc_smart_reader.sqlite3")
    ], { cwd: ROOT });
    assert.equal(Number(runCount.stdout.trim()), 0, "selection demo invoked an agent/model run");

    const blockedValues = [token, dataDir, userDataDir, serviceUrl, FIXTURE_URL];
    const pendingRaw = join(rawDir, "pending.png");
    await captureEvidenceCard(sidepanel, pendingRaw, blockedValues);

    await sidepanel.locator("#quickStartReplayBtn").click();
    await sidepanel.waitForFunction(() => (
      document.querySelector("#quickStartReplayBtn")?.getAttribute("aria-expanded") === "true"
        && document.querySelector("#quickStartReplayPanel")?.dataset.replayStatus === "resolved"
    ));
    const replayRaw = join(rawDir, "replay.png");
    await captureEvidenceCard(sidepanel, replayRaw, blockedValues);

    await sidepanel.locator("#quickStartAcceptClaimBtn").click();
    await sidepanel.waitForFunction(() => (
      document.querySelector("#quickStartEvidence")?.dataset.claimStatus === "reviewed"
        && document.querySelector("#quickStartAcceptClaimBtn")?.disabled === true
    ));
    const reviewedRecords = await waitForRecords(
      serviceUrl,
      token,
      (records) => records.claims?.some((item) => item.id === claim.id && item.status === "reviewed"),
      "human-reviewed claim"
    );
    const reviewedEvidence = reviewedRecords.evidence.find((item) => item.id === evidence.id);
    assert.equal(reviewedEvidence.replay?.replay_id, evidence.replay.replay_id);
    const reviewedRaw = join(rawDir, "reviewed.png");
    await captureEvidenceCard(sidepanel, reviewedRaw, blockedValues);

    await sidepanel.close();
    const reopened = await context.newPage();
    await reopened.setViewportSize({ width: 680, height: 800 });
    await reopened.goto(sidepanelUrl, { waitUntil: "domcontentloaded" });
    await waitForInteractiveSidepanel(reopened);
    await reopened.waitForFunction(({ claimId, evidenceId }) => {
      const card = document.querySelector("#quickStartEvidence");
      return card?.dataset.claimId === claimId
        && card.dataset.evidenceId === evidenceId
        && card.dataset.claimStatus === "reviewed";
    }, { claimId: claim.id, evidenceId: evidence.id });
    await reopened.locator('button[data-tab="knowledge"]').click();
    await reopened.waitForFunction(() => document.querySelector("#quickStartEvidence")?.hidden === false);
    await reopened.locator("#quickStartReplayBtn").click();
    await reopened.waitForFunction((replayId) => (
      document.querySelector("#quickStartReplayBtn")?.dataset.replayId === replayId
        && document.querySelector("#quickStartReplayPanel")?.dataset.replayStatus === "resolved"
    ), evidence.replay.replay_id);
    const restoredRaw = join(rawDir, "restored.png");
    await captureEvidenceCard(reopened, restoredRaw, blockedValues);

    const stage = await context.newPage();
    const specs = [
      { raw: fixtureRaw, step: "STEP 1 OF 5", title: "Select one exact quote", subtitle: "Chrome command: Save selection as pending evidence (local, no model)." },
      { raw: pendingRaw, step: "STEP 2 OF 5", title: "Evidence arrives pending", subtitle: "Both decisions stay with you; saving the selection calls no model." },
      { raw: replayRaw, step: "STEP 3 OF 5", title: "Replay the captured record", subtitle: "The stored source version resolves to the same exact quote." },
      { raw: reviewedRaw, step: "STEP 4 OF 5", title: "Make the human decision", subtitle: "Accepted as supported only after comparing the claim and quote." },
      { raw: restoredRaw, step: "STEP 5 OF 5", title: "Close, reopen, verify", subtitle: "The same claim, evidence, Replay target, and decision return locally." }
    ];
    const frames = [];
    for (let index = 0; index < specs.length; index += 1) {
      const frame = join(frameDir, `${String(index + 1).padStart(2, "0")}.png`);
      await renderStageFrame(stage, specs[index].raw, frame, specs[index]);
      frames.push(frame);
    }
    const gif = join(runRoot, "selection-first-evidence.gif");
    await buildGif(frames, gif, runRoot);
    return { frames, gif };
  } finally {
    if (context) await context.close();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    await terminate(companion.child);
  }
}

async function assertRunsMatch(first, second) {
  assert.equal(first.frames.length, second.frames.length);
  for (let index = 0; index < first.frames.length; index += 1) {
    const [left, right] = await Promise.all([readFile(first.frames[index]), readFile(second.frames[index])]);
    assert.equal(sha256(left), sha256(right), `clean-run frame ${index + 1} is not deterministic`);
  }
  const [firstGif, secondGif] = await Promise.all([readFile(first.gif), readFile(second.gif)]);
  assert.equal(sha256(firstGif), sha256(secondGif), "same-ffmpeg clean runs produced different GIFs");
  assert.ok(firstGif.length <= 8 * 1024 * 1024, `demo exceeds 8 MiB target (${firstGif.length} bytes)`);
  return { bytes: firstGif.length, hash: sha256(firstGif) };
}

await execFilePromise(FFMPEG, ["-version"]);
const tempRoot = await mkdtemp(join(tmpdir(), "qc-selection-demo-"));
try {
  const first = await captureRun(join(tempRoot, "run-a"));
  const second = await captureRun(join(tempRoot, "run-b"));
  const result = await assertRunsMatch(first, second);
  await mkdir(OUTPUT_DIR, { recursive: true });
  await copyFile(first.gif, OUTPUT_GIF);
  await writeFile(OUTPUT_SUMS, `${result.hash}  selection-first-evidence.gif\n`, "utf8");
  const outputStat = await stat(OUTPUT_GIF);
  assert.equal(outputStat.size, result.bytes);
  console.log(`Generated ${OUTPUT_GIF}`);
  console.log(`SHA-256 ${result.hash}`);
  console.log(`Size ${result.bytes} bytes; two clean runs matched byte for byte.`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
