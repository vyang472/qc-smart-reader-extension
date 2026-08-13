import { parseQuantclassBbsHtml } from "./quantclass_bbs.mjs";

const DEFAULT_URL = "https://example.com/article";
const LIMITS = {
  markdownLinks: 20,
  bodyTextBytes: 512 * 1024,
  blockTextBytes: 64 * 1024,
  blocksTotalBytes: 384 * 1024,
  codeBlockBytes: 64 * 1024,
  codeTotalBytes: 256 * 1024,
  mediaTotalBytes: 128 * 1024,
  listTotalBytes: 128 * 1024,
  textBytes: 768 * 1024,
  markdownBytes: 768 * 1024
};

export const SITE_PROFILES = [
  { id: "quantclass-bbs", site: "quantclass", kind: "thread", extract: parseQuantclass },
  { id: "zhihu", site: "zhihu", kind: "page", extract: (html, options) => parseArticle(html, options, {
    id: "zhihu",
    site: "zhihu",
    selectors: ["article", ".Post-RichTextContainer", ".RichContent-inner", ".QuestionAnswer-content", "main"]
  }) },
  { id: "wechat-article", site: "wechat", kind: "page", extract: (html, options) => parseArticle(html, options, {
    id: "wechat-article",
    site: "wechat",
    selectors: ["#js_content", ".rich_media_content", "article"],
    documentMetadata: true
  }) },
  { id: "substack", site: "substack", kind: "page", extract: (html, options) => parseArticle(html, options, {
    id: "substack",
    site: "substack",
    selectors: ["article", ".available-content", ".post", "main"]
  }) },
  { id: "medium", site: "medium", kind: "page", extract: (html, options) => parseArticle(html, options, {
    id: "medium",
    site: "medium",
    selectors: ["article", "main"]
  }) },
  { id: "hacker-news", site: "hacker-news", kind: "thread", extract: parseHackerNews },
  { id: "reddit", site: "reddit", kind: "thread", extract: parseReddit },
  { id: "arxiv", site: "arxiv", kind: "paper", extract: parseArxiv },
  { id: "github-discussion", site: "github", kind: "thread", extract: parseGithubDiscussion },
  { id: "github-issue", site: "github", kind: "thread", extract: parseGithubIssue },
  { id: "generic-readability", site: "generic", kind: "page", extract: (html, options) => parseArticle(html, options, {
    id: "generic-readability",
    site: "generic",
    selectors: ["article", "main", "[role='main']", ".content", ".article", ".post", ".markdown-body", "body"]
  }) }
];

export function inferSiteFromUrl(url) {
  let host = "";
  let pathname = "";
  try {
    const parsed = new URL(url || DEFAULT_URL);
    host = parsed.hostname.replace(/^www\./, "");
    pathname = parsed.pathname || "";
  } catch {
    return "generic";
  }
  if (host.includes("quantclass") || /(^|\.)bbs\.|forum/i.test(host)) return "quantclass";
  if (host.includes("zhihu")) return "zhihu";
  if (host === "mp.weixin.qq.com") return "wechat";
  if (host.includes("substack")) return "substack";
  if (host.includes("medium.com")) return "medium";
  if (host === "news.ycombinator.com") return "hacker-news";
  if (host.includes("reddit.com")) return "reddit";
  if (host.includes("arxiv.org")) return "arxiv";
  if (host.includes("github.com")) {
    if (/\/issues\/\d+/i.test(pathname)) return "github-issue";
    if (/\/discussions\/\d+/i.test(pathname)) return "github-discussion";
    return "github";
  }
  return "generic";
}

export function pickSiteProfile(siteOrUrl) {
  const value = siteOrUrl || "";
  const site = /^https?:\/\//i.test(value) ? inferSiteFromUrl(value) : value;
  return SITE_PROFILES.find((profile) => profile.id === site || profile.site === site) || SITE_PROFILES.at(-1);
}

export function parseSiteProfileHtml(html, options = {}) {
  const url = options.url || DEFAULT_URL;
  const profile = options.profile ? pickSiteProfile(options.profile) : pickSiteProfile(options.site || url);
  return profile.extract(html, { ...options, url });
}

function parseQuantclass(html, options) {
  return parseQuantclassBbsHtml(html, options);
}

function parseArticle(html, options = {}, config) {
  const url = options.url || DEFAULT_URL;
  const rootHtml = firstFragment(html, config.selectors) || bodyFragment(html) || html;
  const metadataHtml = config.documentMetadata ? html : rootHtml;
  const title = firstText(metadataHtml, ["h1", "[data-testid='headline']", ".title", ".post-title"]) || firstText(html, ["title"]) || "Untitled";
  const author = firstText(metadataHtml, ["[rel='author']", ".author", ".byline", ".rich_media_meta_text", ".rich_media_meta_nickname", "[class*='author']", "[class*='byline']"]);
  const publishedAt = firstText(metadataHtml, ["time", ".date", ".publish-time", "[class*='date']", "[class*='time']"]);
  const text = normalizeText(stripTags(rootHtml));
  const codeBlocks = extractCodeBlocks(rootHtml);
  const images = extractImages(rootHtml, url);
  const attachments = extractAttachments(rootHtml, url);
  const links = extractLinks(rootHtml, url);
  const nextPages = extractNextPages(rootHtml, url);
  const markdown = articleMarkdown({ title, url, author, publishedAt, text, codeBlocks, images, attachments, links });
  return withStats({
    kind: "page",
    profile: config.id,
    site: config.site,
    url,
    title,
    author,
    publishedAt,
    text,
    _contentText: text,
    markdown,
    blocks: [],
    codeBlocks,
    images,
    attachments,
    links,
    nextPages
  });
}

function parseHackerNews(html, options = {}) {
  const url = options.url || "https://news.ycombinator.com/item";
  const titleLine = firstFragment(html, [".titleline"]);
  const title = firstText(titleLine || html, ["a"]) || firstText(html, ["title"]) || "Untitled HN thread";
  const subtext = firstFragment(html, [".subtext"]) || "";
  const comments = findFragmentsByClass(html, "comtr").map((fragment, index) => {
    const commentHtml = firstFragment(fragment.body, [".commtext"]) || fragment.body;
    return {
      type: "comment",
      floor: index + 1,
      author: firstText(fragment.body, [".hnuser"]),
      time: firstText(fragment.body, [".age"]),
      text: normalizeText(stripTags(commentHtml)),
      codeBlocks: extractCodeBlocks(commentHtml).map((item) => item.code)
    };
  }).filter((block) => block.text.length > 20);
  const text = normalizeText([title, ...comments.map((block) => block.text)].join("\n\n"));
  return withStats({
    kind: "thread",
    profile: "hacker-news",
    site: "hacker-news",
    url,
    title,
    author: firstText(subtext, [".hnuser"]),
    publishedAt: firstText(subtext, [".age"]),
    text,
    _contentText: normalizeText(comments.map((block) => block.text).join("\n\n")),
    markdown: blocksToMarkdown(title, url, comments),
    blocks: comments,
    codeBlocks: comments.flatMap((block) => block.codeBlocks || []).map((code) => ({ code, language: "" })),
    images: [],
    attachments: [],
    links: extractLinks(html, url),
    nextPages: extractNextPages(html, url)
  });
}

function parseReddit(html, options = {}) {
  const url = options.url || "https://www.reddit.com/r/example/comments/thread";
  const postHtml = firstFragment(html, ["shreddit-post", ".Post", "article", "main"]) || html;
  const title = firstText(postHtml, ["h1", ".title", "[slot='title']"]) || firstText(html, ["title"]) || "Untitled Reddit thread";
  const author = firstText(postHtml, [".author", "[slot='authorName']", "[class*='author']"]);
  const publishedAt = firstText(postHtml, ["time", ".date", "[class*='time']"]);
  const postBody = firstFragment(postHtml, ["[slot='text-body']", ".md", ".usertext-body", ".content"]) || postHtml;
  const comments = findFragmentsByTagOrClass(html, "shreddit-comment", "comment").map((fragment, index) => {
    const textRoot = firstFragment(fragment.body, [".md", "[slot='comment']", ".content"]) || fragment.body;
    return {
      type: "comment",
      floor: index + 1,
      author: fragment.attrs.author || firstText(fragment.body, [".author", "[class*='author']"]),
      time: firstText(fragment.body, ["time", ".date", "[class*='time']"]),
      text: normalizeText(stripTags(textRoot)),
      codeBlocks: extractCodeBlocks(textRoot).map((item) => item.code)
    };
  }).filter((block) => block.text.length > 20);
  const text = normalizeText([stripTags(postBody), ...comments.map((block) => block.text)].join("\n\n"));
  return withStats({
    kind: "thread",
    profile: "reddit",
    site: "reddit",
    url,
    title,
    author,
    publishedAt,
    text,
    _contentText: normalizeText([stripTags(postBody), ...comments.map((block) => block.text)].join("\n\n")),
    markdown: blocksToMarkdown(title, url, [{ type: "main_post", floor: 1, author, time: publishedAt, text: normalizeText(stripTags(postBody)) }, ...comments]),
    blocks: [{ type: "main_post", floor: 1, author, time: publishedAt, text: normalizeText(stripTags(postBody)) }, ...comments],
    codeBlocks: extractCodeBlocks(postBody).concat(comments.flatMap((block) => (block.codeBlocks || []).map((code) => ({ code, language: "" })))),
    images: extractImages(postHtml, url),
    attachments: extractAttachments(postHtml, url),
    links: extractLinks(postHtml, url),
    nextPages: extractNextPages(html, url)
  });
}

function parseArxiv(html, options = {}) {
  const url = options.url || "https://arxiv.org/abs/0000.00000";
  const title = firstText(html, ["h1.title", "h1"]).replace(/^Title:\s*/i, "") || "Untitled paper";
  const author = firstText(html, [".authors"]).replace(/^Authors:\s*/i, "");
  const publishedAt = firstText(html, [".dateline", ".submission-history"]);
  const abstract = firstText(html, ["blockquote.abstract", ".abstract"]).replace(/^Abstract:\s*/i, "");
  const links = extractLinks(html, url);
  const pdfLinks = links.filter((link) => /\/pdf\/|\.pdf($|[?#])/i.test(link.href));
  const text = normalizeText([title, author, publishedAt, abstract].join("\n\n"));
  return withStats({
    kind: "paper",
    profile: "arxiv",
    site: "arxiv",
    url,
    title,
    author,
    publishedAt,
    text,
    _contentText: abstract,
    markdown: articleMarkdown({ title, url, author, publishedAt, text: abstract, codeBlocks: [], images: [], attachments: pdfLinks, links }),
    blocks: [{ type: "abstract", text: abstract }].filter((block) => block.text),
    codeBlocks: [],
    images: [],
    attachments: pdfLinks,
    links,
    nextPages: []
  });
}

function parseGithubDiscussion(html, options = {}) {
  return parseGithubThread(html, options, {
    profile: "github-discussion",
    defaultUrl: "https://github.com/org/repo/discussions/1",
    fallbackTitle: "Untitled GitHub discussion"
  });
}

function parseGithubIssue(html, options = {}) {
  return parseGithubThread(html, options, {
    profile: "github-issue",
    defaultUrl: "https://github.com/org/repo/issues/1",
    fallbackTitle: "Untitled GitHub issue"
  });
}

function parseGithubThread(html, options = {}, config) {
  const url = options.url || config.defaultUrl;
  const title = firstText(html, [".js-issue-title", "bdi", "h1", "title"]) || config.fallbackTitle;
  const rootHtml = firstFragment(html, [".js-discussion", ".discussion-timeline", ".markdown-body", "main"]) || html;
  const jsComments = findFragmentsByClass(rootHtml, "js-comment");
  const fragments = jsComments.length ? jsComments : findFragmentsByClass(rootHtml, "comment-body");
  const blocks = uniqueByText(fragments.length ? fragments : [{ body: rootHtml, attrs: {} }]).map((fragment, index) => {
    const body = firstFragment(fragment.body, [".markdown-body"]) || fragment.body;
    return {
      type: index === 0 ? "main_post" : "comment",
      floor: index + 1,
      author: firstText(fragment.body, [".author", ".Link--primary", "[class*='author']"]),
      time: firstText(fragment.body, ["relative-time", "time", ".date", "[class*='time']"]),
      text: normalizeText(stripTags(body)),
      codeBlocks: extractCodeBlocks(body).map((item) => item.code)
    };
  }).filter((block) => block.text.length > 20);
  const text = normalizeText(blocks.map((block) => block.text).join("\n\n"));
  return withStats({
    kind: "thread",
    profile: config.profile,
    site: "github",
    url,
    title,
    author: blocks[0]?.author || "",
    publishedAt: blocks[0]?.time || "",
    text,
    _contentText: text,
    markdown: blocksToMarkdown(title, url, blocks),
    blocks,
    codeBlocks: blocks.flatMap((block) => (block.codeBlocks || []).map((code) => ({ code, language: "" }))),
    images: extractImages(rootHtml, url),
    attachments: extractAttachments(rootHtml, url),
    links: extractLinks(rootHtml, url),
    nextPages: extractNextPages(rootHtml, url)
  });
}

function withStats(result) {
  const { _contentText, ...publicResult } = result;
  const truncation = {};
  const blocks = limitBlocksByBytes(result.blocks || [], truncation);
  const codeBlocks = limitCodeBlocksByBytes(result.codeBlocks || [], truncation);
  const [images, attachments] = limitCollectionsByBytes(
    [result.images || [], result.attachments || []],
    LIMITS.mediaTotalBytes,
    truncation,
    "mediaBytes"
  );
  const [links, nextPages] = limitCollectionsByBytes(
    [result.links || [], result.nextPages || []],
    LIMITS.listTotalBytes,
    truncation,
    "listBytes"
  );
  const contentLimit = truncateUtf8(normalizeText(_contentText ?? result.text ?? ""), LIMITS.bodyTextBytes);
  recordByteLimit(truncation, "bodyTextBytes", contentLimit, LIMITS.bodyTextBytes);
  const contentText = contentLimit.value;
  const authRequired = detectAuthRequired(result.title, contentText);
  const emptyContent = !contentText;
  const usableContent = !authRequired && !emptyContent;
  Object.assign(truncation, {
    blocks: limitRecord(blocks.length, blocks.length, blocks.length),
    comments: limitRecord(
      blocks.filter((block) => block.type === "comment").length,
      blocks.filter((block) => block.type === "comment").length,
      blocks.length
    ),
    codeBlocks: limitRecord(codeBlocks.length, codeBlocks.length, codeBlocks.length),
    images: limitRecord(images.length, images.length, images.length),
    attachments: limitRecord(attachments.length, attachments.length, attachments.length),
    links: limitRecord(links.length, links.length, links.length),
    nextPages: limitRecord(nextPages.length, nextPages.length, nextPages.length)
  });
  const markdownLimit = truncateUtf8(usableContent ? result.markdown : "", LIMITS.markdownBytes);
  recordByteLimit(truncation, "markdownBytes", markdownLimit, LIMITS.markdownBytes);
  const textLimit = truncateUtf8(usableContent ? result.text : "", LIMITS.textBytes);
  recordByteLimit(truncation, "textBytes", textLimit, LIMITS.textBytes);
  const truncated = hasTruncation(truncation);
  return {
    ...publicResult,
    text: textLimit.value,
    markdown: markdownLimit.value,
    blocks,
    codeBlocks,
    images,
    attachments,
    links,
    nextPages,
    stats: {
      profile: result.profile,
      site: result.site,
      textChars: usableContent ? contentText.replace(/\s+/g, "").length : 0,
      bodyTextChars: contentText.replace(/\s+/g, "").length,
      emptyContent,
      authRequired,
      blocks: blocks.length,
      comments: blocks.filter((block) => block.type === "comment").length,
      floors: blocks.filter((block) => block.floor).length,
      codeBlocks: codeBlocks.length,
      images: images.length,
      attachments: attachments.length,
      nextPages: nextPages.length,
      truncated,
      truncation,
      quality: usableContent ? scoreQuality({ ...result, text: contentText }) : 0
    },
    qualityFlags: { emptyContent, authRequired, truncated },
    quality_flags: {
      empty_content: emptyContent,
      auth_required: authRequired,
      truncated
    }
  };
}

function limitRecord(total, kept, limit) {
  return {
    total,
    kept,
    limit,
    truncated: total > kept
  };
}

function limitBlocksByBytes(items, truncation) {
  const output = [];
  let originalBytes = 0;
  let outputBytes = 0;
  let largestOriginalTextBytes = 0;
  let largestOutputTextBytes = 0;
  for (const item of items || []) {
    const raw = item && typeof item === "object" ? item : {};
    originalBytes += utf8Length(JSON.stringify(raw));
    const textLimit = truncateUtf8(raw.text || "", LIMITS.blockTextBytes);
    largestOriginalTextBytes = Math.max(largestOriginalTextBytes, textLimit.originalBytes);
    largestOutputTextBytes = Math.max(largestOutputTextBytes, textLimit.outputBytes);
    const block = {
      ...raw,
      text: textLimit.value,
      codeBlocks: (raw.codeBlocks || []).map((code) => truncateUtf8(normalizeCode(code), LIMITS.codeBlockBytes).value)
    };
    const bytes = utf8Length(JSON.stringify(block));
    if (outputBytes + bytes > LIMITS.blocksTotalBytes) break;
    output.push(block);
    outputBytes += bytes;
  }
  truncation.blockTextBytes = {
    originalBytes: largestOriginalTextBytes,
    outputBytes: largestOutputTextBytes,
    limitBytes: LIMITS.blockTextBytes,
    truncated: largestOriginalTextBytes > largestOutputTextBytes
  };
  truncation.blocksBytes = {
    originalBytes,
    outputBytes,
    limitBytes: LIMITS.blocksTotalBytes,
    truncated: originalBytes > outputBytes
  };
  return output;
}

function limitCodeBlocksByBytes(items, truncation) {
  const output = [];
  let originalBytes = 0;
  let outputBytes = 0;
  let largestOriginalBytes = 0;
  let largestOutputBytes = 0;
  for (const item of items || []) {
    const rawCode = normalizeCode(item?.code || "");
    const bytes = utf8Length(rawCode);
    originalBytes += bytes;
    largestOriginalBytes = Math.max(largestOriginalBytes, bytes);
    const remaining = LIMITS.codeTotalBytes - outputBytes;
    if (remaining <= 0) continue;
    const bounded = truncateUtf8(rawCode, Math.min(LIMITS.codeBlockBytes, remaining));
    largestOutputBytes = Math.max(largestOutputBytes, bounded.outputBytes);
    if (!bounded.value) continue;
    output.push({ ...item, code: bounded.value });
    outputBytes += bounded.outputBytes;
  }
  truncation.codeBlockBytes = {
    originalBytes: largestOriginalBytes,
    outputBytes: largestOutputBytes,
    limitBytes: LIMITS.codeBlockBytes,
    truncated: largestOriginalBytes > largestOutputBytes
  };
  truncation.codeBytes = {
    originalBytes,
    outputBytes,
    limitBytes: LIMITS.codeTotalBytes,
    truncated: originalBytes > outputBytes
  };
  return output;
}

function limitCollectionsByBytes(collections, limitBytes, truncation, key) {
  const output = collections.map(() => []);
  let originalBytes = 0;
  let outputBytes = 0;
  collections.forEach((items, collectionIndex) => {
    for (const item of items || []) {
      originalBytes += utf8Length(JSON.stringify(item));
      const remaining = limitBytes - outputBytes;
      if (remaining <= 0) continue;
      const bounded = boundCollectionItem(item, remaining);
      if (bounded === null) continue;
      const bytes = utf8Length(JSON.stringify(bounded));
      if (bytes > remaining) continue;
      output[collectionIndex].push(bounded);
      outputBytes += bytes;
    }
  });
  truncation[key] = { originalBytes, outputBytes, limitBytes, truncated: originalBytes > outputBytes };
  return output;
}

function boundCollectionItem(item, remainingBytes) {
  if (typeof item === "string") return truncateUtf8(item, Math.max(0, remainingBytes - 2)).value || null;
  if (!item || typeof item !== "object") return null;
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [
    key,
    typeof value === "string" ? truncateUtf8(value, Math.min(16 * 1024, Math.max(0, remainingBytes - 32))).value : value
  ]));
}

function truncateUtf8(value, limitBytes) {
  const text = String(value || "");
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= limitBytes) return { value: text, originalBytes: encoded.length, outputBytes: encoded.length, truncated: false };
  let end = Math.max(0, limitBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let decoded = "";
  while (end > 0) {
    try {
      decoded = decoder.decode(encoded.slice(0, end));
      break;
    } catch {
      end -= 1;
    }
  }
  const boundaryFloor = Math.floor(decoded.length * 0.8);
  const boundary = Math.max(decoded.lastIndexOf("\n"), decoded.lastIndexOf(" "));
  if (boundary >= boundaryFloor) decoded = decoded.slice(0, boundary);
  return { value: decoded, originalBytes: encoded.length, outputBytes: utf8Length(decoded), truncated: true };
}

function recordByteLimit(truncation, key, result, limitBytes) {
  truncation[key] = {
    originalBytes: result.originalBytes,
    outputBytes: result.outputBytes,
    limitBytes,
    truncated: result.truncated
  };
}

function hasTruncation(truncation) {
  return Object.values(truncation).some((item) => item?.truncated);
}

function scoreQuality(result) {
  let score = 0;
  const textLength = normalizeText(result.text || "").length;
  if (textLength > 1200) score += 35;
  else if (textLength > 400) score += 20;
  else if (textLength > 120) score += 10;
  if ((result.blocks || []).length >= 2) score += 20;
  else if ((result.blocks || []).length) score += 10;
  if ((result.codeBlocks || []).length) score += 10;
  if ((result.images || []).length) score += 5;
  if ((result.attachments || []).length) score += 5;
  if (result.author) score += 5;
  if (result.publishedAt) score += 5;
  if ((result.nextPages || []).length) score += 5;
  return Math.min(100, score || 10);
}

function detectAuthRequired(title, bodyText) {
  const combined = normalizeText([title, bodyText].filter(Boolean).join("\n"));
  if (!combined || utf8Length(combined) > 32 * 1024) return false;
  const markers = [
    /^(?:please\s+)?(?:sign|log)\s+in(?:\s+to\s+(?:continue|view|read|access).*)?[.!！。]?$/i,
    /^(?:checking your browser|just a moment|verify you are human|security check|authentication required|access denied)[.!！。…]*$/i,
    /^(?:请先登录|请登录后(?:继续|查看|访问)|登录后(?:继续|查看|访问).*)[!！。]?$/
  ];
  return combined
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && line.length <= 240)
    .some((line) => markers.some((pattern) => pattern.test(line)));
}

function utf8Length(value) {
  return new TextEncoder().encode(String(value || "")).length;
}

function articleMarkdown({ title, url, author, publishedAt, text, codeBlocks, images, attachments, links }) {
  return [
    `# ${title}`,
    url,
    author || publishedAt ? `作者/时间：${[author, publishedAt].filter(Boolean).join(" · ")}` : "",
    text ? `\n## 正文\n${text}` : "",
    codeBlocks.length ? `\n## 代码片段\n${codeBlocks.map(formatCodeBlock).join("\n\n")}` : "",
    images.length ? `\n## 图片\n${images.map((image) => `- ${image.alt || "image"}: ${image.src}`).join("\n")}` : "",
    attachments.length ? `\n## 附件\n${attachments.map((item) => `- [${item.text || "attachment"}](${item.href})`).join("\n")}` : "",
    links.length ? `\n## 重要链接\n${links.slice(0, LIMITS.markdownLinks).map((link) => `- [${link.text}](${link.href})`).join("\n")}` : ""
  ].filter(Boolean).join("\n\n");
}

function blocksToMarkdown(title, url, blocks) {
  return [
    `# ${title}`,
    url,
    ...blocks.map((block) => {
      const header = [
        `### ${block.type === "main_post" ? "主帖" : "评论"}`,
        block.floor ? `#${block.floor}` : "",
        block.author ? `作者：${block.author}` : "",
        block.time ? `时间：${block.time}` : ""
      ].filter(Boolean).join(" · ");
      const codes = (block.codeBlocks || []).map((code) => `\n\`\`\`\n${code}\n\`\`\``).join("\n");
      return `${header}\n\n${block.text || ""}${codes}`;
    })
  ].join("\n\n");
}

function formatCodeBlock(item) {
  return `\`\`\`${item.language || ""}\n${item.code}\n\`\`\``;
}

function firstText(html, selectors) {
  for (const selector of selectors) {
    const fragment = firstFragment(html, [selector]);
    const text = normalizeText(stripTags(fragment || ""));
    if (text) return text;
  }
  return "";
}

function firstFragment(html, selectors) {
  for (const selector of selectors) {
    const fragment = fragmentBySelector(html, selector);
    if (fragment) return fragment;
  }
  return "";
}

function fragmentBySelector(html, selector) {
  if (!html || !selector) return "";
  if (selector === "body") return bodyFragment(html);
  if (selector === "title") return tagFragment(html, "title");
  const tagClass = selector.match(/^([a-z][\w-]*)\.([\w-]+)$/i);
  if (tagClass) return classFragment(html, tagClass[2], { tagName: tagClass[1] });
  const classContains = selector.match(/^\[class\*=['"]([^'"]+)['"]\]$/);
  if (classContains) return classFragment(html, classContains[1], { contains: true });
  const attrEquals = selector.match(/^\[([^=\]]+)=['"]([^'"]+)['"]\]$/);
  if (attrEquals) return attrFragment(html, attrEquals[1], attrEquals[2]);
  if (selector.startsWith(".")) return classFragment(html, selector.slice(1));
  if (selector.startsWith("#")) return idFragment(html, selector.slice(1));
  if (/^[a-z][\w-]*$/i.test(selector)) return tagFragment(html, selector);
  return "";
}

function tagFragment(html, tagName) {
  const pattern = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "i");
  const match = String(html || "").match(pattern);
  return match ? match[0] : "";
}

function bodyFragment(html) {
  return tagFragment(html, "body") || "";
}

function idFragment(html, id) {
  const source = String(html || "");
  const pattern = /<([a-z0-9-]+)\b([^>]*)>/gi;
  let match;
  while ((match = pattern.exec(source))) {
    const attrs = parseAttrs(match[2] || "");
    if (attrs.id === id) return fragmentFromOpening(source, match);
  }
  return "";
}

function attrFragment(html, attrName, attrValue) {
  const source = String(html || "");
  const pattern = /<([a-z0-9-]+)\b([^>]*)>/gi;
  let match;
  while ((match = pattern.exec(source))) {
    const attrs = parseAttrs(match[2] || "");
    if (attrs[attrName] === attrValue) return fragmentFromOpening(source, match);
  }
  return "";
}

function classFragment(html, className, options = {}) {
  const source = String(html || "");
  const pattern = /<([a-z0-9-]+)\b([^>]*class=["']([^"']+)["'][^>]*)>/gi;
  let match;
  while ((match = pattern.exec(source))) {
    const tagName = match[1] || "";
    if (options.tagName && tagName.toLowerCase() !== options.tagName.toLowerCase()) continue;
    const classes = match[3] || "";
    const ok = options.contains
      ? classes.toLowerCase().includes(className.toLowerCase())
      : classes.split(/\s+/).includes(className);
    if (ok) return fragmentFromOpening(source, match);
  }
  return "";
}

function fragmentFromOpening(source, match) {
  const tagName = match[1] || "";
  const start = match.index || 0;
  const openEnd = match.index + match[0].length;
  const tagPattern = new RegExp(`</?${escapeRegExp(tagName)}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = openEnd;
  let depth = 1;
  let tagMatch;
  while ((tagMatch = tagPattern.exec(source))) {
    const rawTag = tagMatch[0] || "";
    if (/^<\//.test(rawTag)) {
      depth -= 1;
      if (depth === 0) return source.slice(start, tagPattern.lastIndex);
    } else if (!/\/>$/.test(rawTag)) {
      depth += 1;
    }
  }
  return source.slice(start, openEnd);
}

function findFragmentsByClass(html, className) {
  const fragments = [];
  const source = String(html || "");
  const pattern = /<([a-z0-9-]+)\b([^>]*class=["']([^"']+)["'][^>]*)>/gi;
  let match;
  while ((match = pattern.exec(source))) {
    const classes = match[3] || "";
    if (!classes.split(/\s+/).includes(className)) continue;
    fragments.push({
      tag: match[1],
      attrs: parseAttrs(match[2] || ""),
      body: fragmentFromOpening(source, match)
    });
  }
  return fragments;
}

function findFragmentsByTagOrClass(html, tagName, className) {
  const tagged = [];
  const tagPattern = new RegExp(`<${escapeRegExp(tagName)}\\b([^>]*)>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "gi");
  let tagMatch;
  while ((tagMatch = tagPattern.exec(String(html || "")))) {
    tagged.push({ tag: tagName, attrs: parseAttrs(tagMatch[1] || ""), body: tagMatch[2] || "" });
  }
  return tagged.concat(findFragmentsByClass(html, className));
}

function uniqueByText(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = normalizeText(stripTags(item.body || "")).slice(0, 200);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function extractCodeBlocks(html) {
  const items = [];
  const pattern = /<(pre|code)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = pattern.exec(String(html || "")))) {
    const code = normalizeCode(decodeHtml(stripTags(match[3] || "")));
    if (code.length < 8) continue;
    items.push({
      language: detectLanguage(match[2] || "") || detectLanguage(match[3] || ""),
      code
    });
  }
  return items;
}

function detectLanguage(attrs) {
  const match = String(attrs || "").match(/(?:language|highlight)-([\w-]+)/i);
  return match?.[1] || "";
}

function extractImages(html, baseUrl) {
  const images = [];
  const pattern = /<img\b([^>]*)>/gi;
  let match;
  while ((match = pattern.exec(String(html || "")))) {
    const attrs = parseAttrs(match[1] || "");
    const src = normalizeHref(attrs.currentSrc || attrs.src || attrs["data-src"] || "", baseUrl);
    if (!src || src.startsWith("data:")) continue;
    images.push({
      src,
      alt: normalizeText(attrs.alt || attrs.title || "")
    });
  }
  return images;
}

function extractAttachments(html, baseUrl) {
  return extractLinks(html, baseUrl)
    .filter((link) => /\.(?:zip|7z|rar|pdf|docx?|xlsx?|pptx?)($|[?#])/i.test(link.href) || /附件|下载|file|pdf/i.test(link.text));
}

function extractLinks(html, baseUrl) {
  const links = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(String(html || "")))) {
    const attrs = parseAttrs(match[1] || "");
    const href = normalizeHref(attrs.href || "", baseUrl);
    const text = normalizeText(stripTags(match[2] || "")) || href;
    if (!href || href.startsWith("javascript:")) continue;
    links.push({ text: text.slice(0, 120), href });
  }
  return links;
}

function extractNextPages(html, baseUrl) {
  return extractLinks(html, baseUrl)
    .filter((link) => /下一页|next|more|older/i.test(link.text))
    .map((link) => link.href)
    .filter(Boolean);
}

function normalizeHref(href, baseUrl) {
  const value = decodeHtml(String(href || "").trim());
  if (!value) return "";
  try {
    return new URL(value, baseUrl || DEFAULT_URL).href;
  } catch {
    return value;
  }
}

function parseAttrs(raw) {
  const attrs = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = pattern.exec(String(raw || "")))) {
    attrs[match[1]] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function stripTags(value) {
  return decodeHtml(String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|article|section|li|h[1-6]|pre|blockquote|tr|td)>/gi, "\n")
    .replace(/<[^>]+>/g, " "));
}

function decodeHtml(value) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " "
  };
  return String(value || "").replace(/&(#x?[0-9a-f]+|\w+);/gi, (_, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeCode(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
