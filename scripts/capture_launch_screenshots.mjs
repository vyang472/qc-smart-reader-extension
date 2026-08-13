#!/usr/bin/env node

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
        .replace(/\/(?:private\/)?var\/folders\/\S+/g, "LOCAL_VAULT/…")
        .replace(/\/(?:Users|home)\/[^\s/]+\/\S+/g, "LOCAL_VAULT/…")
        .replace(/\b(src|chk|chunk|claim|ev|evidence|arun|doc|note|job|topic)_[A-Za-z0-9_-]+\b/g, "$1_demo");
    }
    document.querySelectorAll("input[type=password]").forEach((input) => {
      input.value = "";
    });
    document.activeElement?.blur?.();
  });
}

async function captureViewport(page, path, anchor = null) {
  await page.setViewportSize({ width: 480, height: 800 });
  if (anchor) {
    await page.locator(anchor).first().evaluate((node) => {
      const top = node.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: Math.max(0, top - 16), behavior: "instant" });
    });
  } else {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  }
  await redactVisibleLocalValues(page);
  await page.addStyleTag({
    content: `
      * { caret-color: transparent !important; }
      html { scroll-behavior: auto !important; }
      ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
    `
  });
  await page.screenshot({ path, animations: "disabled" });
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
          .shot-shell::before {
            content: "ACTUAL EXTENSION UI · PUBLIC FIXTURE";
            position: absolute;
            z-index: 2;
            top: 10px;
            left: 50%;
            transform: translateX(-50%);
            width: max-content;
            padding: 6px 11px;
            border-radius: 999px;
            color: #EAF4FF;
            background: rgb(7 20 38 / 88%);
            font-size: 10px;
            font-weight: 800;
            letter-spacing: .55px;
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
        <div class="version">QC Smart Reader v0.9.0 · Screenshots generated from repository fixture data</div>
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
    try {
      await waitForHealth(serviceUrl);
    } catch (error) {
      throw new Error(`${error.message}\n${serviceOutput.trim()}`);
    }

    // This public, deterministic fixture contains no network-loaded assets and no
    // private data. The extension still captures it through its real page path.
    const fixtureHtml = `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>Every claim keeps an exact quote</title>
        </head>
        <body>
          <main class="application-main">
            <div class="discussion-timeline js-discussion">
              <h1><bdi class="js-issue-title markdown-title">Every claim keeps an exact quote</bdi></h1>
              <div class="js-comment">
                <a class="author Link--primary">QC Reader Demo</a>
                <relative-time datetime="2026-08-14T08:00:00Z">Aug 14, 2026</relative-time>
                <div class="comment-body markdown-body">
                  <p>Evidence-first research starts with a source-backed claim. Every claim should retain an exact quotation and a stable source chunk so reviewers can inspect the context before accepting it.</p>
                  <p>Local-first storage keeps raw captures, structured records, review decisions, and lineage under the user's control. A readable Markdown layer supports long-term access while SQLite keeps queries fast and consistent.</p>
                  <p>Restart-safe batch jobs persist their checkpoints before the next item begins. Interrupted work can resume without silently duplicating completed captures.</p>
                  <pre><code class="language-text">source -&gt; chunk -&gt; claim -&gt; evidence -&gt; review</code></pre>
                </div>
              </div>
              <div class="js-comment">
                <a class="author Link--primary">Human Reviewer</a>
                <relative-time datetime="2026-08-14T09:15:00Z">Aug 14, 2026</relative-time>
                <div class="comment-body markdown-body">
                  <p>Model output remains a draft until evidence is checked. A valid quotation proves that the citation exists in the captured source; human review still decides whether the claim is sound.</p>
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

    const sidepanel = await context.newPage();
    await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: "domcontentloaded" });
    await sidepanel.evaluate(
      ({ targetServiceUrl, pairingToken }) => chrome.storage.local.set({
        settings: {
          serviceUrl: targetServiceUrl,
          pairingToken,
          projectId: "default",
          provider: "openai",
          baseUrl: "",
          model: "",
          temperature: 0.2,
          modelDataConsent: false,
          modelDataConsentVersion: "",
          modelDataConsentAt: ""
        }
      }),
      { targetServiceUrl: serviceUrl, pairingToken: token }
    );
    await sidepanel.reload({ waitUntil: "domcontentloaded" });

    const fixturePage = await context.newPage();
    await fixturePage.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
    await fixturePage.bringToFront();
    await sidepanel.evaluate(() => document.querySelector("#readPageBtn")?.click());
    await sidepanel.waitForFunction(
      () => document.querySelector("#sourceTitle")?.textContent.includes("Every claim keeps an exact quote"),
      null,
      { timeout: 15_000 }
    );
    await sidepanel.waitForFunction(
      () => (document.querySelector("#sourcePreview")?.textContent || "").length > 20,
      null,
      { timeout: 15_000 }
    );
    await sidepanel.bringToFront();

    const rawCapture = join(rawDir, "01-capture-raw.png");
    await captureViewport(sidepanel, rawCapture);
    await composeLaunchScreenshot(
      context,
      rawCapture,
      join(OUTPUT_DIR, "01-capture.png"),
      {
        eyebrow: "CAPTURE",
        title: "Capture the source, not just the summary.",
        subtitle: "The live side panel reads a public fixture through the real extension extraction path.",
        points: ["Signed-in browser context", "Quality signals before synthesis", "Raw source preserved locally"]
      }
    );

    await sidepanel.locator('button[data-tab="knowledge"]').click();
    await sidepanel.locator("#extractKnowledgeBtn").click();
    await sidepanel.waitForFunction(
      () => document.querySelector("#knowledgeRecordStatus")?.textContent.includes("已抽取草稿"),
      null,
      { timeout: 25_000 }
    );
    await sidepanel.locator("#claimReviewList .claim-review-card").first().waitFor({ state: "visible", timeout: 15_000 });

    const rawReview = join(rawDir, "02-evidence-review-raw.png");
    await captureViewport(sidepanel, rawReview, "#claimReviewList .claim-review-card");
    await composeLaunchScreenshot(
      context,
      rawReview,
      join(OUTPUT_DIR, "02-evidence-review.png"),
      {
        eyebrow: "CLAIM / EVIDENCE REVIEW",
        title: "Review claims against exact quotes.",
        subtitle: "The real review workbench keeps the draft claim, source quote, chunk context, and decision controls together.",
        points: ["Quote validity is explicit", "Accept, verify, or reject", "Decision history stays auditable"]
      }
    );

    const detailButton = sidepanel.locator("#sourceList [data-source-detail-id]").first();
    await detailButton.waitFor({ state: "visible", timeout: 15_000 });
    await detailButton.click();
    await sidepanel.locator("#sourceDetail .source-detail-card").waitFor({ state: "visible", timeout: 15_000 });

    const rawVault = join(rawDir, "03-local-vault-raw.png");
    await captureViewport(sidepanel, rawVault, "#sourceDetail .source-detail-card");
    await composeLaunchScreenshot(
      context,
      rawVault,
      join(OUTPUT_DIR, "03-local-vault.png"),
      {
        eyebrow: "LOCAL VAULT",
        title: "Inspect what was stored—and why.",
        subtitle: "The actual source detail view exposes quality, versions, chunks, raw text, and local artifact links.",
        points: ["Markdown + SQLite", "Source versions and lineage", "No hosted QC backend"]
      }
    );

    console.log("Generated launch screenshots:");
    for (const name of ["01-capture.png", "02-evidence-review.png", "03-local-vault.png"]) {
      console.log(`- ${join(OUTPUT_DIR, name)}`);
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
