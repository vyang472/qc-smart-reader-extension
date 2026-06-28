import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseQuantclassBbsHtml } from "../extractors/quantclass_bbs.mjs";
import { parseSiteProfileHtml } from "../extractors/site_profiles.mjs";

test("QuantClass/BBS fixture is wired through the site profile registry", async () => {
  const html = await readFile(new URL("./fixtures/quantclass_thread.html", import.meta.url), "utf8");
  const result = parseSiteProfileHtml(html, {
    url: "https://bbs.quantclass.cn/thread/87030"
  });

  assert.equal(result.profile, "quantclass-bbs");
  assert.equal(result.kind, "thread");
  assert.equal(result.site, "quantclass");
  assert.equal(result.blocks.length, 3);
  assert.equal(result.stats.comments, 2);
});

test("QuantClass/BBS fixture extracts thread structure", async () => {
  const html = await readFile(new URL("./fixtures/quantclass_thread.html", import.meta.url), "utf8");
  const result = parseQuantclassBbsHtml(html, {
    url: "https://bbs.quantclass.cn/thread/87030"
  });

  assert.equal(result.profile, "quantclass-bbs");
  assert.equal(result.kind, "thread");
  assert.equal(result.site, "quantclass");
  assert.equal(result.title, "长上影线是卖出还是买入信号？");
  assert.equal(result.author, "上官山下");
  assert.equal(result.publishedAt, "2026-06-25 19:41");
  assert.equal(result.blocks.length, 3);
  assert.deepEqual(result.blocks.map((block) => block.floor), [1, 2, 3]);
  assert.deepEqual(result.blocks.map((block) => block.type), ["main_post", "comment", "comment"]);
  assert.equal(result.stats.comments, 2);
  assert.equal(result.stats.floors, 3);
});

test("QuantClass/BBS fixture preserves code, image, attachment, and next page", async () => {
  const html = await readFile(new URL("./fixtures/quantclass_thread.html", import.meta.url), "utf8");
  const result = parseQuantclassBbsHtml(html, {
    url: "https://bbs.quantclass.cn/thread/87030"
  });
  const mainPost = result.blocks[0];

  assert.equal(mainPost.author, "上官山下");
  assert.equal(mainPost.codeBlockDetails[0].language, "python");
  assert.match(mainPost.codeBlocks[0], /def signal/);
  assert.match(mainPost.codeBlocks[0], /upper_shadow_count_5d/);
  assert.equal(mainPost.images[0].src, "https://cdn.quantclass.cn/images/upper-shadow-chart.png");
  assert.equal(mainPost.images[0].alt, "回测净值曲线");
  assert.equal(mainPost.attachments[0].href, "https://cdn.quantclass.cn/files/upper-shadow.zip");
  assert.equal(mainPost.attachments[0].text, "附件：upper-shadow.zip");
  assert.deepEqual(result.nextPages, ["https://bbs.quantclass.cn/thread/87030?page=2"]);
  assert.equal(result.stats.codeBlocks, 1);
  assert.equal(result.stats.images, 1);
  assert.equal(result.stats.attachments, 1);
  assert.equal(result.stats.nextPages, 1);
});

test("QuantClass/BBS fixture keeps strategy context in text and markdown", async () => {
  const html = await readFile(new URL("./fixtures/quantclass_thread.html", import.meta.url), "utf8");
  const result = parseQuantclassBbsHtml(html, {
    url: "https://bbs.quantclass.cn/thread/87030"
  });

  assert.match(result.text, /高位长上影线/);
  assert.match(result.text, /样本外和换手过滤/);
  assert.match(result.text, /市场阶段拆分/);
  assert.match(result.markdown, /### 主帖 · #1/);
  assert.match(result.markdown, /```python/);
  assert.match(result.markdown, /附件：\[附件：upper-shadow.zip\]/);
  assert.ok(result.stats.quality >= 70, `quality too low: ${result.stats.quality}`);
});

test("QuantClass/BBS generated fixture keeps 100+ floors", () => {
  const floors = Array.from({ length: 105 }, (_, index) => {
    const floor = index + 1;
    const roleClass = floor === 1 ? "post floor" : "reply comment floor";
    return `
      <article class="${roleClass}" data-floor="${floor}">
        <span class="author username">user-${floor}</span>
        <time>2026-06-26 ${String(floor % 24).padStart(2, "0")}:00</time>
        <p>第 ${floor} 楼：这是一个用于测试 100 楼以上论坛抽取稳定性的回复。包含策略讨论、风险检查和证据引用。</p>
      </article>
    `;
  }).join("\n");
  const html = `
    <html>
      <head><title>100 楼压力测试</title></head>
      <body>
        <main class="thread">
          <h1 class="thread-title">100 楼压力测试</h1>
          ${floors}
          <a href="https://bbs.quantclass.cn/thread/stress?page=2">下一页</a>
        </main>
      </body>
    </html>
  `;
  const result = parseQuantclassBbsHtml(html, {
    url: "https://bbs.quantclass.cn/thread/stress"
  });

  assert.equal(result.blocks.length, 105);
  assert.equal(result.stats.comments, 104);
  assert.equal(result.stats.floors, 105);
  assert.equal(result.blocks[0].floor, 1);
  assert.equal(result.blocks.at(-1).floor, 105);
  assert.equal(result.blocks.at(-1).author, "user-105");
  assert.deepEqual(result.nextPages, ["https://bbs.quantclass.cn/thread/stress?page=2"]);
  assert.equal(result.stats.truncated, false);
  assert.equal(result.stats.truncation.blocks.total, 105);
  assert.equal(result.stats.truncation.blocks.kept, 105);
});

test("QuantClass/BBS generated fixture reports exact truncation counts", () => {
  const floors = Array.from({ length: 130 }, (_, index) => {
    const floor = index + 1;
    const roleClass = floor === 1 ? "post floor" : "reply comment floor";
    return `
      <article class="${roleClass}" data-floor="${floor}">
        <span class="author username">user-${floor}</span>
        <p>第 ${floor} 楼：这是一个用于测试截断元数据的回复。包含策略讨论、风险检查和证据引用。</p>
      </article>
    `;
  }).join("\n");
  const html = `
    <html>
      <head><title>截断压力测试</title></head>
      <body>
        <main class="thread">
          <h1 class="thread-title">截断压力测试</h1>
          ${floors}
        </main>
      </body>
    </html>
  `;
  const result = parseQuantclassBbsHtml(html, {
    url: "https://bbs.quantclass.cn/thread/truncated"
  });

  assert.equal(result.blocks.length, 120);
  assert.equal(result.stats.truncated, true);
  assert.equal(result.stats.truncation.blocks.total, 130);
  assert.equal(result.stats.truncation.blocks.kept, 120);
  assert.equal(result.stats.truncation.blocks.limit, 120);
  assert.equal(result.stats.truncation.blocks.truncated, true);
  assert.equal(result.stats.truncation.comments.total, 129);
  assert.equal(result.stats.truncation.comments.kept, 119);
});

test("QuantClass/BBS multi-page fixtures preserve relative links and continuation comments", async () => {
  const page1Html = await readFile(new URL("./fixtures/quantclass_thread_multipage_page1.html", import.meta.url), "utf8");
  const page2Html = await readFile(new URL("./fixtures/quantclass_thread_multipage_page2.html", import.meta.url), "utf8");
  const page1Url = "https://bbs.quantclass.cn/thread/88000";
  const page2Url = "https://bbs.quantclass.cn/thread/88000?page=2";
  const page1 = parseQuantclassBbsHtml(page1Html, { url: page1Url });
  const page2 = parseQuantclassBbsHtml(page2Html, { url: page2Url });

  assert.deepEqual(page1.nextPages, [page2Url]);
  assert.equal(page1.images[0].src, "https://bbs.quantclass.cn/uploads/multipage-page1.png");
  assert.equal(page1.attachments[0].href, "https://bbs.quantclass.cn/files/multipage-page1.zip");
  assert.deepEqual(page1.blocks.map((block) => block.type), ["main_post", "comment", "comment"]);
  assert.deepEqual(page1.blocks.map((block) => block.floor), [1, 2, 3]);

  assert.deepEqual(page2.nextPages, []);
  assert.deepEqual(page2.blocks.map((block) => block.type), ["comment", "comment", "comment"]);
  assert.deepEqual(page2.blocks.map((block) => block.floor), [4, 5, 6]);
  assert.equal(page2.stats.comments, 3);
  assert.match(page2.blocks[1].codeBlocks[0], /revised_filter/);
  assert.equal(page2.images[0].src, "https://bbs.quantclass.cn/uploads/multipage-page2.png");
  assert.equal(page2.attachments[0].href, "https://bbs.quantclass.cn/files/multipage-page2.xlsx");
});
