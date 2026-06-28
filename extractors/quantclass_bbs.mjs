const DEFAULT_URL = "https://bbs.quantclass.cn/thread/fixture";
const LIMITS = {
  blocks: 120,
  codeBlocks: 80,
  images: 80,
  attachments: 40,
  nextPages: 5
};

export function parseQuantclassBbsHtml(html, options = {}) {
  const url = options.url || DEFAULT_URL;
  const title = firstText(html, ["h1", ".thread-title", ".post-title", ".title", "title"]) || "Untitled thread";
  const truncation = {};
  const allPostFragments = findPostFragments(html);
  const postFragments = limitItems(allPostFragments, "blocks", LIMITS.blocks, truncation);
  const blocks = postFragments.map((fragment, index) => {
    const text = normalizeText(stripTags(fragment.body));
    return {
      type: inferBlockType(fragment, index),
      floor: findFloor(fragment, text, index),
      author: firstText(fragment.body, [".author", ".username", ".user-name", "[class*='author']", "[class*='user']"]),
      time: firstText(fragment.body, ["time", ".time", ".date", "[class*='time']", "[class*='date']"]),
      text,
      codeBlocks: extractCodeBlocks(fragment.body).map((item) => item.code),
      codeBlockDetails: extractCodeBlocks(fragment.body),
      images: extractImages(fragment.body, url),
      attachments: extractAttachments(fragment.body, url)
    };
  });
  const allBlockTypes = allPostFragments.map((fragment, index) => inferBlockType(fragment, index));
  const commentLimit = Math.max(0, LIMITS.blocks - (allBlockTypes.includes("main_post") ? 1 : 0));
  recordLimit(
    truncation,
    "comments",
    allBlockTypes.filter((type) => type === "comment").length,
    blocks.filter((block) => block.type === "comment").length,
    commentLimit
  );
  const fallbackText = normalizeText(stripTags(html));
  const text = normalizeText((blocks.length ? blocks.map((block) => block.text).join("\n\n") : fallbackText));
  const codeBlocks = blocks.flatMap((block) => block.codeBlockDetails || []);
  const images = blocks.flatMap((block) => block.images || []);
  const attachments = blocks.flatMap((block) => block.attachments || []);
  const nextPages = extractNextPages(html, url, truncation);
  const markdown = blocksToMarkdown(blocks);
  const author = blocks[0]?.author || firstText(html, [".author", ".username", ".user-name"]);
  const publishedAt = blocks[0]?.time || firstText(html, ["time", ".time", ".date"]);
  recordLimit(truncation, "codeBlocks", codeBlocks.length, codeBlocks.length, LIMITS.codeBlocks);
  recordLimit(truncation, "images", images.length, images.length, LIMITS.images);
  recordLimit(truncation, "attachments", attachments.length, attachments.length, LIMITS.attachments);

  return {
    kind: "thread",
    profile: "quantclass-bbs",
    site: "quantclass",
    url,
    title,
    author,
    publishedAt,
    text,
    markdown,
    blocks,
    images,
    attachments,
    nextPages,
    stats: {
      profile: "quantclass-bbs",
      textChars: text.replace(/\s+/g, "").length,
      blocks: blocks.length,
      comments: blocks.filter((block) => block.type === "comment").length,
      floors: blocks.filter((block) => block.floor).length,
      codeBlocks: codeBlocks.length,
      images: images.length,
      attachments: attachments.length,
      nextPages: nextPages.length,
      truncated: hasTruncation(truncation),
      truncation,
      quality: scoreQuality({ text, blocks, images, codeBlocks, attachments, nextPages, author, publishedAt })
    }
  };
}

function findPostFragments(html) {
  const fragments = [];
  const pattern = /<(article|section|li|div)\b([^>]*class=["'][^"']*(?:post|reply|comment|floor|post-item)[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const body = match[3] || "";
    if (normalizeText(stripTags(body)).length < 20) continue;
    fragments.push({ tag: match[1], attrs: match[2] || "", body });
  }
  return uniqueByText(fragments);
}

function uniqueByText(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = normalizeText(stripTags(item.body)).slice(0, 300);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function inferBlockType(fragment, index) {
  const marker = `${fragment.attrs || ""} ${fragment.tag || ""}`.toLowerCase();
  if (/\b(reply|comment)\b|post-reply|post_reply/.test(marker)) return "comment";
  if (/\b(main|thread|post)\b/.test(marker)) return "main_post";
  return index === 0 ? "main_post" : "comment";
}

function firstText(html, selectors) {
  for (const selector of selectors) {
    const value = textBySelector(html, selector);
    if (value) return value;
  }
  return "";
}

function textBySelector(html, selector) {
  if (selector === "title") {
    return tagText(html, "title");
  }
  if (/^[a-z][a-z0-9]*$/i.test(selector)) {
    return tagText(html, selector);
  }
  const classContains = selector.match(/^\[class\*=['"]([^'"]+)['"]\]$/);
  if (classContains) {
    return classText(html, classContains[1], true);
  }
  if (selector.startsWith(".")) {
    return classText(html, selector.slice(1), false);
  }
  return "";
}

function tagText(html, tagName) {
  const pattern = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "i");
  const match = html.match(pattern);
  return match ? normalizeText(stripTags(match[1])) : "";
}

function classText(html, className, contains) {
  const pattern = /<([a-z0-9]+)\b([^>]*class=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const classes = match[3] || "";
    const ok = contains
      ? classes.toLowerCase().includes(className.toLowerCase())
      : classes.split(/\s+/).includes(className);
    if (!ok) continue;
    const text = normalizeText(stripTags(match[4] || ""));
    if (text) return text;
  }
  return "";
}

function findFloor(fragment, text, index) {
  const attr = fragment.attrs || "";
  const dataFloor = attr.match(/\bdata-floor=["']?(\d+)/i);
  if (dataFloor) return Number(dataFloor[1]);
  const idFloor = attr.match(/\bid=["']?(?:post|floor|comment)[_-]?(\d+)/i);
  if (idFloor) return Number(idFloor[1]);
  const textFloor = text.match(/(?:#|楼层|第)\s*(\d+)/);
  return textFloor ? Number(textFloor[1]) : index + 1;
}

function extractCodeBlocks(html) {
  const items = [];
  const pattern = /<(pre|code)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const code = normalizeText(decodeHtml(stripTags(match[3] || "")));
    if (code.length < 8) continue;
    items.push({
      language: detectLanguage(match[2] || ""),
      code
    });
  }
  return items.slice(0, LIMITS.codeBlocks);
}

function detectLanguage(attrs) {
  const match = String(attrs || "").match(/(?:language|highlight)-([\w-]+)/i);
  return match?.[1] || "";
}

function extractImages(html, baseUrl = DEFAULT_URL) {
  const images = [];
  const pattern = /<img\b([^>]*)>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const attrs = parseAttrs(match[1] || "");
    const src = attrs.currentSrc || attrs.src || attrs["data-src"] || "";
    if (!src || src.startsWith("data:")) continue;
    images.push({
      src: resolveUrl(src, baseUrl),
      alt: normalizeText(attrs.alt || attrs.title || "")
    });
  }
  return images.slice(0, LIMITS.images);
}

function extractAttachments(html, baseUrl = DEFAULT_URL) {
  return extractLinks(html, baseUrl)
    .filter((link) => /\.(?:zip|7z|rar|pdf|docx?|xlsx?|pptx?)($|[?#])/i.test(link.href) || /附件|下载|file/i.test(link.text))
    .slice(0, LIMITS.attachments);
}

function extractLinks(html, baseUrl = DEFAULT_URL) {
  const links = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const attrs = parseAttrs(match[1] || "");
    const href = attrs.href || "";
    const text = normalizeText(stripTags(match[2] || "")) || href;
    if (!href || href.startsWith("javascript:")) continue;
    links.push({ text, href: resolveUrl(href, baseUrl) });
  }
  return links;
}

function extractNextPages(html, baseUrl = DEFAULT_URL, truncation = {}) {
  const pages = extractLinks(html, baseUrl)
    .filter((link) => /下一页|next|more|older/i.test(link.text))
    .map((link) => link.href)
    .filter(Boolean);
  return limitItems(pages, "nextPages", LIMITS.nextPages, truncation);
}

function resolveUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl || DEFAULT_URL).href;
  } catch {
    return value;
  }
}

function limitItems(items, key, limit, truncation) {
  const list = Array.isArray(items) ? items : [];
  const kept = list.slice(0, limit);
  recordLimit(truncation, key, list.length, kept.length, limit);
  return kept;
}

function recordLimit(truncation, key, total, kept, limit) {
  truncation[key] = {
    total,
    kept,
    limit,
    truncated: total > kept
  };
}

function hasTruncation(truncation) {
  return Object.values(truncation).some((item) => item?.truncated);
}

function parseAttrs(raw) {
  const attrs = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = pattern.exec(raw))) {
    attrs[match[1]] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function blocksToMarkdown(blocks) {
  return blocks.map((block) => {
    const header = [
      `### ${block.type === "main_post" ? "主帖" : "评论"}`,
      block.floor ? `#${block.floor}` : "",
      block.author ? `作者：${block.author}` : "",
      block.time ? `时间：${block.time}` : ""
    ].filter(Boolean).join(" · ");
    const codes = (block.codeBlockDetails || [])
      .map((item) => `\n\`\`\`${item.language || ""}\n${item.code}\n\`\`\``)
      .join("\n");
    const attachments = (block.attachments || [])
      .map((item) => `\n- 附件：[${item.text}](${item.href})`)
      .join("");
    return `${header}\n\n${block.text || ""}${codes}${attachments}`;
  }).join("\n\n");
}

function scoreQuality({ text, blocks, images, codeBlocks, attachments, nextPages, author, publishedAt }) {
  let score = 0;
  if (text.length > 1200) score += 35;
  else if (text.length > 400) score += 20;
  if (blocks.length >= 2) score += 20;
  else if (blocks.length) score += 10;
  if (codeBlocks.length) score += 10;
  if (images.length) score += 5;
  if (attachments.length) score += 5;
  if (author) score += 5;
  if (publishedAt) score += 5;
  if (nextPages.length) score += 5;
  return Math.min(100, score || 10);
}

function stripTags(value) {
  return decodeHtml(String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|article|section|li|h[1-6]|pre|blockquote)>/gi, "\n")
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
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
