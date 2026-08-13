import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSiteProfileHtml } from "../extractors/site_profiles.mjs";
import { launchChromium } from "./browser_runtime.mjs";

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

async function extractHtmlWithBrowserBundle(browser, html, url) {
  const page = await browser.newPage();
  try {
    await page.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
    await page.goto(url);
    await page.addScriptTag({ path: fileURLToPath(new URL("../extractors/browser_site_profiles.js", import.meta.url)) });
    return await page.evaluate(() => window.QCSmartReaderProfiles.extractReadablePage());
  } finally {
    await page.close();
  }
}

test("browser site profile bundle matches registry fixtures for supported sites", async (t) => {
  const browser = await launchChromium(t, { headless: true });
  if (!browser) return;

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
  const browser = await launchChromium(t, { headless: true });
  if (!browser) return;

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
  const browser = await launchChromium(t, { headless: true });
  if (!browser) return;

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

test("browser generic profile keeps extraction scoped to the specific article root", async (t) => {
  const browser = await launchChromium(t, { headless: true });
  if (!browser) return;

  try {
    const result = await extractHtmlWithBrowserBundle(browser, `
      <!doctype html>
      <html>
        <head><title>Research Page</title></head>
        <body>
          <aside><h2>Account</h2><p>PRIVATE-SIDEBAR-TOKEN-1234567890</p></aside>
          <article>
            <h1>Scoped Research</h1>
            <p>First evidence paragraph.</p>
            <p>Second evidence paragraph.</p>
            <pre><code>const scoped = true;</code></pre>
            <img src="/chart.png" alt="research chart">
          </article>
        </body>
      </html>
    `, "https://research.example/scoped");

    assert.equal(result.title, "Scoped Research");
    assert.match(result.text, /First evidence paragraph\.\n\nSecond evidence paragraph\./);
    assert.doesNotMatch(result.text, /PRIVATE-SIDEBAR-TOKEN/);
    assert.doesNotMatch(result.text, /## Account/);
    assert.deepEqual(result.images.map((item) => item.src), ["https://research.example/chart.png"]);
  } finally {
    await browser.close();
  }
});

test("browser extraction preserves code indentation exactly", async (t) => {
  const browser = await launchChromium(t, { headless: true });
  if (!browser) return;

  try {
    const code = "def evaluate(value):\n\tif value:\n        return value\n\treturn 0";
    const result = await extractHtmlWithBrowserBundle(browser, `
      <!doctype html><title>Code fidelity</title>
      <article><h1>Code fidelity</h1><p>Runnable example.</p><pre><code>${code}</code></pre></article>
    `, "https://research.example/code-fidelity");

    assert.equal(result.blocks.length, 0);
    assert.equal(result.text.includes(`\`\`\`\n${code}\n\`\`\``), true);
  } finally {
    await browser.close();
  }
});

test("browser extraction distinguishes empty and restricted shells from short real content", async (t) => {
  const browser = await launchChromium(t, { headless: true });
  if (!browser) return;

  try {
    const empty = await extractHtmlWithBrowserBundle(
      browser,
      "<!doctype html><title>Empty article</title><body></body>",
      "https://research.example/empty"
    );
    assert.equal(empty.text, "");
    assert.equal(empty.markdown, "");
    assert.equal(empty.stats.textChars, 0);
    assert.equal(empty.stats.emptyContent, true);
    assert.equal(empty.quality_flags.empty_content, true);
    assert.equal(empty.quality_flags.auth_required, false);

    const login = await extractHtmlWithBrowserBundle(browser, `
      <!doctype html><title>Sign in</title>
      <main><h1>Sign in to continue</h1><button>Sign in</button></main>
    `, "https://research.example/login");
    assert.equal(login.text, "");
    assert.equal(login.stats.authRequired, true);
    assert.equal(login.quality_flags.auth_required, true);

    const challenge = await extractHtmlWithBrowserBundle(browser, `
      <!doctype html><title>Checking your browser...</title>
      <main><p>Verify you are human</p></main>
    `, "https://research.example/challenge");
    assert.equal(challenge.text, "");
    assert.equal(challenge.stats.authRequired, true);

    const shortReal = await extractHtmlWithBrowserBundle(browser, `
      <!doctype html><title>Brief note</title>
      <article><h1>Brief note</h1><p>One concise but genuine observation.</p></article>
    `, "https://research.example/brief");
    assert.match(shortReal.text, /One concise but genuine observation\./);
    assert.equal(shortReal.stats.emptyContent, false);
    assert.equal(shortReal.stats.authRequired, false);
  } finally {
    await browser.close();
  }
});

test("browser extraction enforces UTF-8 byte budgets for hostile oversized pages", async (t) => {
  const browser = await launchChromium(t, { headless: true });
  if (!browser) return;

  try {
    const hugeBody = "研究证据。".repeat(240_000);
    const hugeCode = `def oversized():\n${"    return evidence\n".repeat(120_000)}`;
    const result = await extractHtmlWithBrowserBundle(browser, `
      <!doctype html><title>Oversized page</title>
      <article><h1>Oversized page</h1><p>${hugeBody}</p><pre><code>${hugeCode}</code></pre></article>
    `, "https://research.example/oversized");
    const bytes = (value) => new TextEncoder().encode(value).length;

    assert.ok(bytes(result.text) <= 768 * 1024, `text bytes=${bytes(result.text)}`);
    assert.ok(bytes(result.markdown) <= 768 * 1024, `markdown bytes=${bytes(result.markdown)}`);
    assert.ok(bytes(result.text) < bytes(hugeBody) + bytes(hugeCode), "oversized body/code were duplicated into output");
    assert.ok(bytes(result.text.match(/```[\s\S]*?```/)?.[0] || "") <= 64 * 1024 + 16);
    assert.equal(result.stats.truncated, true);
    assert.equal(result.quality_flags.truncated, true);
    for (const key of ["bodyTextBytes", "codeBlockBytes", "codeBytes", "textBytes", "markdownBytes"]) {
      const record = result.stats.truncation[key];
      assert.ok(record, `missing ${key}`);
      assert.ok(record.originalBytes >= record.outputBytes, key);
      assert.ok(record.outputBytes <= record.limitBytes, key);
    }
  } finally {
    await browser.close();
  }
});
