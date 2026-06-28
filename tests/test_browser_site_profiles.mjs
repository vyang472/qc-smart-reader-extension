import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSiteProfileHtml } from "../extractors/site_profiles.mjs";

const require = createRequire(import.meta.url);

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

async function fixture(name) {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

const PROFILE_PARITY_CASES = [
  ["substack_article.html", "https://research.substack.com/p/research-os"],
  ["zhihu_article.html", "https://www.zhihu.com/question/123/answer/456"],
  ["wechat_article.html", "https://mp.weixin.qq.com/s/research-pipeline"],
  ["medium_article.html", "https://medium.com/research-lab/evidence-first-research-agents"],
  ["generic_article.html", "https://research.example/articles/fallback"],
  ["hacker_news_thread.html", "https://news.ycombinator.com/item?id=401"],
  ["reddit_thread.html", "https://www.reddit.com/r/algotrading/comments/abc/workflow"],
  ["arxiv_abs.html", "https://arxiv.org/abs/2606.12345"],
  ["github_discussion.html", "https://github.com/org/repo/discussions/12"],
  ["github_issue.html", "https://github.com/org/repo/issues/34"]
];

async function extractWithBrowserBundle(browser, fixtureName, url) {
  const html = await fixture(fixtureName);
  const expected = parseSiteProfileHtml(html, { url });
  const page = await browser.newPage();
  try {
    await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
    await page.goto(url);
    await page.addScriptTag({ path: fileURLToPath(new URL("../extractors/browser_site_profiles.js", import.meta.url)) });
    const actual = await page.evaluate(() => window.QCSmartReaderProfiles.extractReadablePage());
    return { expected, actual };
  } finally {
    await page.close();
  }
}

test("browser site profile bundle matches registry fixtures for supported sites", async (t) => {
  const playwright = loadPlaywright();
  if (!playwright?.chromium) {
    t.skip("Playwright is unavailable");
    return;
  }

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  try {
    for (const [fixtureName, url] of PROFILE_PARITY_CASES) {
      const { expected, actual } = await extractWithBrowserBundle(browser, fixtureName, url);
      assert.equal(actual.profile, expected.profile, fixtureName);
      assert.equal(actual.site, expected.site, fixtureName);
      assert.equal(actual.kind, expected.kind, fixtureName);
      assert.equal(actual.title, expected.title, fixtureName);
      assert.equal(actual.author, expected.author, fixtureName);
      assert.equal(actual.publishedAt, expected.publishedAt, fixtureName);
      assert.equal(actual.blocks.length, expected.blocks.length, fixtureName);
      assert.deepEqual(actual.blocks.map((block) => block.type), expected.blocks.map((block) => block.type), fixtureName);
      assert.deepEqual(actual.blocks.map((block) => block.author), expected.blocks.map((block) => block.author), fixtureName);
      assert.equal(actual.stats.comments, expected.stats.comments, fixtureName);
      assert.equal(actual.stats.codeBlocks, expected.stats.codeBlocks, fixtureName);
      assert.equal(actual.images.length, expected.images.length, fixtureName);
      assert.equal(actual.attachments.length, expected.attachments.length, fixtureName);
      assert.equal(actual.nextPages.length, expected.nextPages.length, fixtureName);
      if (expected.images[0]) assert.equal(actual.images[0].src, expected.images[0].src, fixtureName);
      if (expected.attachments[0]) assert.equal(actual.attachments[0].href, expected.attachments[0].href, fixtureName);
    }
  } finally {
    await browser.close();
  }
});

test("browser site profile bundle extracts QuantClass fixture in Chromium", async (t) => {
  const playwright = loadPlaywright();
  if (!playwright?.chromium) {
    t.skip("Playwright is unavailable");
    return;
  }

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  try {
    const html = await fixture("quantclass_thread.html");
    const url = "https://bbs.quantclass.cn/thread/87030";
    const expected = parseSiteProfileHtml(html, { url });
    const page = await browser.newPage();
    await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
    await page.goto(url);
    await page.addScriptTag({ path: fileURLToPath(new URL("../extractors/browser_site_profiles.js", import.meta.url)) });
    const result = await page.evaluate(() => window.QCSmartReaderProfiles.extractReadablePage());

    assert.equal(result.profile, expected.profile);
    assert.equal(result.site, expected.site);
    assert.equal(result.kind, expected.kind);
    assert.equal(result.title, expected.title);
    assert.equal(result.author, expected.author);
    assert.equal(result.publishedAt, expected.publishedAt);
    assert.equal(result.blocks.length, expected.blocks.length);
    assert.deepEqual(result.blocks.map((block) => block.floor), expected.blocks.map((block) => block.floor));
    assert.deepEqual(result.blocks.map((block) => block.type), expected.blocks.map((block) => block.type));
    assert.match(result.blocks[0].codeBlocks[0], /upper_shadow_count_5d/);
    assert.equal(result.images[0].src, expected.images[0].src);
    assert.equal(result.attachments[0].href, expected.attachments[0].href);
    assert.deepEqual(result.nextPages, expected.nextPages);
    assert.equal(result.stats.comments, expected.stats.comments);
    assert.equal(result.stats.attachments, expected.stats.attachments);
    assert.equal(result.stats.nextPages, expected.stats.nextPages);
  } finally {
    await browser.close();
  }
});

test("browser site profile bundle preserves QuantClass multi-page continuation semantics", async (t) => {
  const playwright = loadPlaywright();
  if (!playwright?.chromium) {
    t.skip("Playwright is unavailable");
    return;
  }

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Chromium is unavailable: ${error.message}`);
    return;
  }

  try {
    const page1Html = await fixture("quantclass_thread_multipage_page1.html");
    const page2Html = await fixture("quantclass_thread_multipage_page2.html");
    const page1Url = "https://bbs.quantclass.cn/thread/88000";
    const page2Url = "https://bbs.quantclass.cn/thread/88000?page=2";
    const expectedPage1 = parseSiteProfileHtml(page1Html, { url: page1Url });
    const expectedPage2 = parseSiteProfileHtml(page2Html, { url: page2Url });
    const page = await browser.newPage();
    await page.route(page1Url, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: page1Html }));
    await page.route(page2Url, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: page2Html }));

    await page.goto(page1Url);
    await page.addScriptTag({ path: fileURLToPath(new URL("../extractors/browser_site_profiles.js", import.meta.url)) });
    const page1 = await page.evaluate(() => window.QCSmartReaderProfiles.extractReadablePage());
    assert.deepEqual(page1.nextPages, expectedPage1.nextPages);
    assert.equal(page1.images[0].src, expectedPage1.images[0].src);
    assert.equal(page1.attachments[0].href, expectedPage1.attachments[0].href);
    assert.deepEqual(page1.blocks.map((block) => block.type), expectedPage1.blocks.map((block) => block.type));

    await page.goto(page2Url);
    await page.addScriptTag({ path: fileURLToPath(new URL("../extractors/browser_site_profiles.js", import.meta.url)) });
    const page2 = await page.evaluate(() => window.QCSmartReaderProfiles.extractReadablePage());
    assert.deepEqual(page2.nextPages, []);
    assert.deepEqual(page2.blocks.map((block) => block.type), expectedPage2.blocks.map((block) => block.type));
    assert.deepEqual(page2.blocks.map((block) => block.floor), [4, 5, 6]);
    assert.equal(page2.stats.comments, 3);
    assert.match(page2.blocks[1].codeBlocks[0], /revised_filter/);
    assert.equal(page2.images[0].src, expectedPage2.images[0].src);
    assert.equal(page2.attachments[0].href, expectedPage2.attachments[0].href);
  } finally {
    await browser.close();
  }
});
