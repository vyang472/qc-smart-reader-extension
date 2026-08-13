const DEFAULT_URL = "https://bbs.quantclass.cn/thread/fixture";
const LIMITS = {
  blocks: 120,
  codeBlocks: 80,
  images: 80,
  attachments: 40,
  nextPages: 5,
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

export function parseQuantclassBbsHtml(html, options = {}) {
  const url = options.url || DEFAULT_URL;
  const title = firstText(html, ["h1", ".thread-title", ".post-title", ".title", "title"]) || "Untitled thread";
  const truncation = {};
  const allPostFragments = findPostFragments(html);
  const postFragments = limitItems(allPostFragments, "blocks", LIMITS.blocks, truncation);
  const rawBlocks = postFragments.map((fragment, index) => {
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
  const blocks = limitBlocksByBytes(rawBlocks, truncation);
  const allBlockTypes = allPostFragments.map((fragment, index) => inferBlockType(fragment, index));
  const commentLimit = Math.max(0, LIMITS.blocks - (allBlockTypes.includes("main_post") ? 1 : 0));
  recordLimit(
    truncation,
    "comments",
    allBlockTypes.filter((type) => type === "comment").length,
    blocks.filter((block) => block.type === "comment").length,
    commentLimit
  );
  const fallbackText = normalizeText(stripTags(bodyContent(html)));
  const contentLimit = truncateUtf8(
    normalizeText((blocks.length ? blocks.map((block) => block.text).join("\n\n") : fallbackText)),
    LIMITS.bodyTextBytes
  );
  recordByteLimit(truncation, "bodyTextBytes", contentLimit, LIMITS.bodyTextBytes);
  const contentText = contentLimit.value;
  const authRequired = detectAuthRequired(title, contentText);
  const emptyContent = !contentText;
  const usableContent = !authRequired && !emptyContent;
  const codeBlocks = limitCodeBlocksByBytes(blocks.flatMap((block) => block.codeBlockDetails || []), truncation);
  const [images, attachments] = limitCollectionsByBytes(
    [blocks.flatMap((block) => block.images || []), blocks.flatMap((block) => block.attachments || [])],
    LIMITS.mediaTotalBytes,
    truncation,
    "mediaBytes"
  );
  const [nextPages] = limitCollectionsByBytes(
    [extractNextPages(html, url, truncation)],
    LIMITS.listTotalBytes,
    truncation,
    "listBytes"
  );
  const markdownLimit = truncateUtf8(usableContent ? blocksToMarkdown(blocks) : "", LIMITS.markdownBytes);
  recordByteLimit(truncation, "markdownBytes", markdownLimit, LIMITS.markdownBytes);
  const markdown = markdownLimit.value;
  const textLimit = truncateUtf8(usableContent ? contentText : "", LIMITS.textBytes);
  recordByteLimit(truncation, "textBytes", textLimit, LIMITS.textBytes);
  const text = textLimit.value;
  const author = blocks[0]?.author || firstText(html, [".author", ".username", ".user-name"]);
  const publishedAt = blocks[0]?.time || firstText(html, ["time", ".time", ".date"]);
  recordLimit(truncation, "codeBlocks", codeBlocks.length, codeBlocks.length, LIMITS.codeBlocks);
  recordLimit(truncation, "images", images.length, images.length, LIMITS.images);
  recordLimit(truncation, "attachments", attachments.length, attachments.length, LIMITS.attachments);

  const truncated = hasTruncation(truncation);
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
      quality: usableContent ? scoreQuality({ text, blocks, images, codeBlocks, attachments, nextPages, author, publishedAt }) : 0
    },
    qualityFlags: { emptyContent, authRequired, truncated },
    quality_flags: {
      empty_content: emptyContent,
      auth_required: authRequired,
      truncated
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
    const code = normalizeCode(decodeHtml(stripTags(match[3] || "")));
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

function limitBlocksByBytes(items, truncation) {
  const output = [];
  let originalBytes = 0;
  let outputBytes = 0;
  let largestOriginalTextBytes = 0;
  let largestOutputTextBytes = 0;
  for (const raw of items || []) {
    originalBytes += utf8Length(JSON.stringify(raw));
    const textLimit = truncateUtf8(raw.text || "", LIMITS.blockTextBytes);
    largestOriginalTextBytes = Math.max(largestOriginalTextBytes, textLimit.originalBytes);
    largestOutputTextBytes = Math.max(largestOutputTextBytes, textLimit.outputBytes);
    const codeBlockDetails = (raw.codeBlockDetails || []).map((item) => ({
      ...item,
      code: truncateUtf8(normalizeCode(item.code || ""), LIMITS.codeBlockBytes).value
    }));
    const block = {
      ...raw,
      text: textLimit.value,
      codeBlocks: codeBlockDetails.map((item) => item.code),
      codeBlockDetails
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

function bodyContent(html) {
  const match = String(html || "").match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return match ? match[1] : String(html || "").replace(/<head\b[\s\S]*?<\/head>/gi, "");
}

function utf8Length(value) {
  return new TextEncoder().encode(String(value || "")).length;
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
