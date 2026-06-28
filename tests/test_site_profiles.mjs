import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { inferSiteFromUrl, parseSiteProfileHtml, pickSiteProfile } from "../extractors/site_profiles.mjs";

async function fixture(name) {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("site profile registry infers supported sites from URLs", () => {
  assert.equal(inferSiteFromUrl("https://bbs.quantclass.cn/thread/87030"), "quantclass");
  assert.equal(inferSiteFromUrl("https://news.ycombinator.com/item?id=401"), "hacker-news");
  assert.equal(inferSiteFromUrl("https://www.reddit.com/r/algotrading/comments/abc/test"), "reddit");
  assert.equal(inferSiteFromUrl("https://arxiv.org/abs/2606.12345"), "arxiv");
  assert.equal(inferSiteFromUrl("https://github.com/org/repo/discussions/12"), "github-discussion");
  assert.equal(inferSiteFromUrl("https://github.com/org/repo/issues/34"), "github-issue");
  assert.equal(inferSiteFromUrl("https://research.substack.com/p/system"), "substack");
  assert.equal(pickSiteProfile("wechat-article").id, "wechat-article");
  assert.equal(pickSiteProfile("github-discussion").id, "github-discussion");
  assert.equal(pickSiteProfile("github-issue").id, "github-issue");
  assert.equal(pickSiteProfile("https://github.com/org/repo/issues/34").id, "github-issue");
  assert.equal(pickSiteProfile("quantclass-bbs").id, "quantclass-bbs");
  assert.equal(pickSiteProfile("generic-readability").id, "generic-readability");
  assert.equal(pickSiteProfile("https://unknown.example.com/post").id, "generic-readability");
});

test("Substack fixture extracts article metadata, code, image, and attachment", async () => {
  const result = parseSiteProfileHtml(await fixture("substack_article.html"), {
    url: "https://research.substack.com/p/research-os"
  });

  assert.equal(result.profile, "substack");
  assert.equal(result.site, "substack");
  assert.equal(result.kind, "page");
  assert.equal(result.title, "How to Build a Research Operating System");
  assert.equal(result.author, "Research Notes");
  assert.match(result.text, /durable source capture/);
  assert.match(result.codeBlocks[0].code, /collect/);
  assert.equal(result.codeBlocks[0].language, "yaml");
  assert.equal(result.images[0].src, "https://example.substack.com/images/workflow.png");
  assert.equal(result.attachments[0].href, "https://example.substack.com/files/research-os.pdf");
  assert.equal(result.stats.codeBlocks, 1);
  assert.equal(result.stats.images, 1);
  assert.equal(result.stats.attachments, 1);
  assert.equal(result.stats.truncated, false);
  assert.equal(result.stats.truncation.images.total, 1);
  assert.equal(result.stats.truncation.attachments.kept, 1);
});

test("Zhihu fixture extracts article metadata, code, image, formula text, and attachment", async () => {
  const result = parseSiteProfileHtml(await fixture("zhihu_article.html"), {
    url: "https://www.zhihu.com/question/123/answer/456"
  });

  assert.equal(result.profile, "zhihu");
  assert.equal(result.site, "zhihu");
  assert.equal(result.kind, "page");
  assert.equal(result.title, "如何搭建量化研究知识库");
  assert.equal(result.author, "知乎研究员");
  assert.match(result.text, /source_id、chunk_id/);
  assert.match(result.text, /score = evidence/);
  assert.match(result.codeBlocks[0].code, /evidence_score/);
  assert.equal(result.codeBlocks[0].language, "python");
  assert.equal(result.images[0].src, "https://www.zhihu.com/images/knowledge-graph.png");
  assert.equal(result.attachments[0].href, "https://www.zhihu.com/files/research-template.docx");
  assert.equal(result.stats.codeBlocks, 1);
  assert.equal(result.stats.images, 1);
  assert.equal(result.stats.attachments, 1);
});

test("WeChat fixture extracts article metadata, code, image, formula text, and PDF attachment", async () => {
  const result = parseSiteProfileHtml(await fixture("wechat_article.html"), {
    url: "https://mp.weixin.qq.com/s/research-pipeline"
  });

  assert.equal(result.profile, "wechat-article");
  assert.equal(result.site, "wechat");
  assert.equal(result.kind, "page");
  assert.equal(result.title, "研究流水线复盘");
  assert.equal(result.author, "量化学习社");
  assert.equal(result.publishedAt, "2026-06-21");
  assert.match(result.text, /策略假设/);
  assert.match(result.text, /return = signal/);
  assert.match(result.codeBlocks[0].code, /"stage":"screen"/);
  assert.equal(result.codeBlocks[0].language, "json");
  assert.equal(result.images[0].src, "https://mmbiz.qpic.cn/research-pipeline.png");
  assert.equal(result.attachments[0].href, "https://mp.weixin.qq.com/s/download/research-checklist.pdf");
  assert.equal(result.stats.attachments, 1);
});

test("Medium fixture extracts article metadata, code, image, formula text, and attachment", async () => {
  const result = parseSiteProfileHtml(await fixture("medium_article.html"), {
    url: "https://medium.com/research-lab/evidence-first-research-agents"
  });

  assert.equal(result.profile, "medium");
  assert.equal(result.site, "medium");
  assert.equal(result.kind, "page");
  assert.equal(result.title, "Evidence-First Research Agents");
  assert.equal(result.author, "Mira Quant");
  assert.match(result.text, /decision package/);
  assert.match(result.text, /confidence \/ implementation_cost/);
  assert.match(result.codeBlocks[0].code, /packageReady/);
  assert.equal(result.codeBlocks[0].language, "js");
  assert.equal(result.images[0].src, "https://miro.medium.com/research-agent.png");
  assert.equal(result.attachments[0].href, "https://medium.com/files/evidence-agent.zip");
  assert.equal(result.stats.codeBlocks, 1);
});

test("Generic fixture falls back to readability-style article extraction", async () => {
  const result = parseSiteProfileHtml(await fixture("generic_article.html"), {
    url: "https://research.example/articles/fallback"
  });

  assert.equal(result.profile, "generic-readability");
  assert.equal(result.site, "generic");
  assert.equal(result.kind, "page");
  assert.equal(result.title, "Independent Research Note");
  assert.equal(result.author, "Desk Analyst");
  assert.match(result.text, /no first-class site profile/);
  assert.match(result.codeBlocks[0].code, /drawdown/);
  assert.equal(result.images[0].src, "https://research.example/assets/fallback.png");
  assert.equal(result.attachments[0].href, "https://research.example/assets/fallback.pdf");
});

test("Hacker News fixture extracts comments and next-page links", async () => {
  const result = parseSiteProfileHtml(await fixture("hacker_news_thread.html"), {
    url: "https://news.ycombinator.com/item?id=401"
  });

  assert.equal(result.profile, "hacker-news");
  assert.equal(result.kind, "thread");
  assert.equal(result.title, "Ask HN: Durable research workflows");
  assert.equal(result.author, "quantdev");
  assert.equal(result.blocks.length, 2);
  assert.deepEqual(result.blocks.map((block) => block.author), ["alice", "bob"]);
  assert.match(result.blocks[0].text, /source ledger/);
  assert.match(result.blocks[0].codeBlocks[0], /source_id/);
  assert.deepEqual(result.nextPages, ["https://news.ycombinator.com/item?id=401&p=2"]);
  assert.equal(result.stats.comments, 2);
  assert.equal(result.stats.codeBlocks, 1);
});

test("Reddit fixture preserves post, comments, code, image, and PDF link", async () => {
  const result = parseSiteProfileHtml(await fixture("reddit_thread.html"), {
    url: "https://www.reddit.com/r/algotrading/comments/abc/workflow"
  });

  assert.equal(result.profile, "reddit");
  assert.equal(result.kind, "thread");
  assert.equal(result.title, "Knowledge-base driven quant research workflow");
  assert.equal(result.author, "u/systematic_researcher");
  assert.equal(result.blocks.length, 3);
  assert.equal(result.blocks[0].type, "main_post");
  assert.deepEqual(result.blocks.slice(1).map((block) => block.author), ["u/backtester", "u/riskdesk"]);
  assert.match(result.blocks[1].codeBlocks[0], /backtest\.sharpe/);
  assert.equal(result.images[0].src, "https://www.reddit.com/charts/factor-rotation.png");
  assert.equal(result.attachments[0].href, "https://www.reddit.com/files/research-playbook.pdf");
  assert.equal(result.stats.comments, 2);
});

test("arXiv fixture extracts paper abstract and PDF link", async () => {
  const result = parseSiteProfileHtml(await fixture("arxiv_abs.html"), {
    url: "https://arxiv.org/abs/2606.12345"
  });

  assert.equal(result.profile, "arxiv");
  assert.equal(result.kind, "paper");
  assert.equal(result.title, "Retrieval Augmented Research Agents for Evidence-Bound Synthesis");
  assert.equal(result.author, "Ada Chen, Ben Li");
  assert.match(result.text, /auditable research briefs/);
  assert.equal(result.blocks[0].type, "abstract");
  assert.equal(result.attachments[0].href, "https://arxiv.org/pdf/2606.12345");
  assert.equal(result.stats.attachments, 1);
});

test("GitHub Discussion fixture extracts discussion comments, code, and attachment", async () => {
  const result = parseSiteProfileHtml(await fixture("github_discussion.html"), {
    url: "https://github.com/org/repo/discussions/12"
  });

  assert.equal(result.profile, "github-discussion");
  assert.equal(result.kind, "thread");
  assert.equal(result.title, "Support citation-required deliverables");
  assert.equal(result.author, "maintainer");
  assert.equal(result.blocks.length, 2);
  assert.deepEqual(result.blocks.map((block) => block.author), ["maintainer", "reviewer"]);
  assert.match(result.blocks[0].text, /source and chunk references/);
  assert.match(result.blocks[0].codeBlocks[0], /source_id/);
  assert.equal(result.attachments[0].href, "https://github.com/org/repo/files/spec.zip");
  assert.equal(result.stats.comments, 1);
  assert.equal(result.stats.codeBlocks, 1);
});

test("GitHub Issue fixture extracts issue comments, code, image, and attachment", async () => {
  const result = parseSiteProfileHtml(await fixture("github_issue.html"), {
    url: "https://github.com/org/repo/issues/34"
  });

  assert.equal(result.profile, "github-issue");
  assert.equal(result.site, "github");
  assert.equal(result.kind, "thread");
  assert.equal(result.title, "Fix stale source quality blockers");
  assert.equal(result.author, "maintainer");
  assert.equal(result.blocks.length, 2);
  assert.deepEqual(result.blocks.map((block) => block.author), ["maintainer", "reviewer"]);
  assert.match(result.blocks[0].text, /archived truncated sources/);
  assert.match(result.blocks[0].codeBlocks[0], /source\.status/);
  assert.equal(result.images[0].src, "https://github.com/org/repo/assets/blocker-state.png");
  assert.equal(result.attachments[0].href, "https://github.com/org/repo/files/quality-gate-repro.zip");
  assert.equal(result.stats.comments, 1);
  assert.equal(result.stats.codeBlocks, 1);
});
