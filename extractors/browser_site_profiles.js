(function () {
  const LIMITS = {
    headings: 40,
    blocks: 120,
    blockTextChars: 12000,
    codeBlocks: 80,
    images: 80,
    attachments: 40,
    links: 40,
    nextPages: 5
  };

  function extractReadablePage() {
    const selectedText = String(window.getSelection?.() || "").trim();
    const pageTitle = document.title || "";
    const url = location.href;
    const canonicalUrl = document.querySelector('link[rel="canonical"], link[rel~="canonical"]')?.href || url;
    const metaDescription = document.querySelector('meta[name="description"]')?.content || "";
    const siteId = inferSite(url);
    const profile = pickProfile(siteId);
    const site = normalizeSiteId(siteId);
    const truncation = {};
    const extracted = profile.extract(truncation, pageTitle);
    const title = extracted.title || pageTitle;
    const root = extracted.root || document;
    const blocks = extracted.blocks || [];
    const headings = extractHeadings(truncation);
    const codeBlocks = extractCodeBlocks(root, truncation);
    const images = extractImages(root, truncation);
    const links = extractLinks(root, truncation);
    const attachments = extracted.attachments || extractAttachments(root, truncation);
    const bodyText = normalizeText(extracted.text || "");
    const selectedSection = selectedText ? `选中文本：\n${selectedText}\n\n` : "";
    const blockMarkdown = blocks.length ? blocksToMarkdown(blocks) : "";
    const markdown = [
      `# ${title}`,
      url,
      canonicalUrl && canonicalUrl !== url ? `Canonical: ${canonicalUrl}` : "",
      metaDescription ? `摘要：${metaDescription}` : "",
      extracted.author || extracted.publishedAt ? `作者/时间：${[extracted.author, extracted.publishedAt].filter(Boolean).join(" · ")}` : "",
      headings.length ? `\n## 页面标题\n${headings.join("\n")}` : "",
      blockMarkdown ? `\n## 结构化内容\n${blockMarkdown}` : "",
      bodyText ? `\n## 正文\n${bodyText}` : "",
      codeBlocks.length ? `\n## 代码片段\n${codeBlocks.map(formatCodeBlock).join("\n\n")}` : "",
      images.length ? `\n## 图片\n${images.map((image) => `- ${image.alt || "image"}: ${image.src}`).join("\n")}` : "",
      attachments.length ? `\n## 附件\n${attachments.map((item) => `- [${item.text || "attachment"}](${item.href})`).join("\n")}` : "",
      links.length ? `\n## 重要链接\n${links.map((link) => `- [${link.text}](${link.href})`).join("\n")}` : ""
    ].filter(Boolean).join("\n\n");
    const text = `${selectedSection}${markdown}`;
    const stats = {
      profile: profile.id,
      site,
      textChars: text.replace(/\s+/g, "").length,
      blocks: blocks.length,
      images: images.length,
      codeBlocks: codeBlocks.length,
      attachments: attachments.length,
      links: links.length,
      comments: blocks.filter((block) => block.type === "comment").length,
      floors: blocks.filter((block) => block.floor).length,
      nextPages: extracted.nextPages?.length || 0,
      truncated: hasTruncation(truncation),
      truncation,
      quality: scoreQuality({ text, blocks, images, codeBlocks, attachments, extracted })
    };
    return {
      title,
      url,
      canonicalUrl,
      text,
      markdown,
      kind: selectedText ? `${extracted.kind}+selection` : extracted.kind,
      site,
      profile: profile.id,
      author: extracted.author || "",
      publishedAt: extracted.publishedAt || "",
      blocks,
      images,
      attachments,
      links,
      nextPages: extracted.nextPages || [],
      stats
    };
  }

  function inferSite(pageUrl) {
    try {
      const parsed = new URL(pageUrl);
      const host = parsed.hostname.replace(/^www\./, "");
      const pathname = parsed.pathname || "";
      if (host.includes("quantclass") || /bbs|forum|discuz/i.test(host)) return "quantclass";
      if (host.includes("zhihu")) return "zhihu";
      if (host.includes("mp.weixin.qq.com")) return "wechat";
      if (host.includes("substack")) return "substack";
      if (host.includes("medium.com")) return "medium";
      if (host.includes("news.ycombinator.com")) return "hacker-news";
      if (host.includes("reddit.com")) return "reddit";
      if (host.includes("arxiv.org")) return "arxiv";
      if (host.includes("github.com")) {
        if (/\/issues\/\d+/i.test(pathname)) return "github-issue";
        if (/\/discussions\/\d+/i.test(pathname)) return "github-discussion";
        return "github";
      }
      return "generic";
    } catch {
      return "generic";
    }
  }

  function pickProfile(siteId) {
    const profiles = {
      quantclass: { id: "quantclass-bbs", extract: extractForum },
      zhihu: { id: "zhihu", extract: (_truncation, pageTitle) => extractArticle(["article", ".Post-RichTextContainer", ".RichContent-inner", ".QuestionAnswer-content", "main"], pageTitle) },
      wechat: { id: "wechat-article", extract: (_truncation, pageTitle) => extractArticle(["#js_content", ".rich_media_content", "article"], pageTitle) },
      substack: { id: "substack", extract: (_truncation, pageTitle) => extractArticle(["article", ".available-content", ".post", "main"], pageTitle) },
      medium: { id: "medium", extract: (_truncation, pageTitle) => extractArticle(["article", "main"], pageTitle) },
      "hacker-news": { id: "hacker-news", extract: extractHackerNews },
      reddit: { id: "reddit", extract: extractReddit },
      arxiv: { id: "arxiv", extract: extractArxiv },
      "github-discussion": { id: "github-discussion", extract: (_truncation, pageTitle) => extractGithubThread("github-discussion", pageTitle) },
      "github-issue": { id: "github-issue", extract: (_truncation, pageTitle) => extractGithubThread("github-issue", pageTitle) },
      github: { id: "github-discussion", extract: (_truncation, pageTitle) => extractGithubThread("github-discussion", pageTitle) },
      generic: { id: "generic-readability", extract: (_truncation, pageTitle) => extractArticle(["article", "main", "[role='main']", ".content", ".article", ".post", ".markdown-body", "body"], pageTitle) }
    };
    return profiles[siteId] || profiles.generic;
  }

  function normalizeSiteId(siteId) {
    if (/^github-/.test(siteId || "")) return "github";
    return siteId || "generic";
  }

  function extractForum(truncation, pageTitle) {
    const root = firstExisting([".thread", ".topic", "main", "[role='main']", "article", ".post", ".markdown-body", ".content", "body"]);
    const titleNode = firstExisting(["h1", ".thread-title", ".post-title", ".title"]) || document.querySelector("title");
    const author = textOf(firstExisting([".author", ".username", ".user-name", "[class*='author']", "[class*='user']"]));
    const publishedAt = textOf(firstExisting(["time", ".time", ".date", ".created-at", "[class*='time']", "[class*='date']"]));
    const allPostNodes = uniqueNodes([
      ...document.querySelectorAll("article, .post, .reply, .comment, .floor, [class*='post-item'], [class*='comment']")
    ]).filter((node) => normalizeText(node.innerText || node.textContent || "").length > 40);
    const postNodes = limitItems(allPostNodes, "blocks", LIMITS.blocks, truncation);
    const blockTextStats = { total: postNodes.length, kept: postNodes.length, limit: LIMITS.blockTextChars, truncated: false, truncated_items: 0 };
    const blocks = postNodes.map((node, index) => {
      const rawText = normalizeText(node.innerText || node.textContent || "");
      if (rawText.length > LIMITS.blockTextChars) {
        blockTextStats.truncated = true;
        blockTextStats.truncated_items += 1;
      }
      return {
        type: inferForumBlockType(node, index),
        floor: findFloor(node, rawText, index),
        author: textOf(node.querySelector(".author, .username, .user-name, [class*='author'], [class*='user']")),
        time: textOf(node.querySelector("time, .time, .date, [class*='time'], [class*='date']")),
        text: rawText.slice(0, LIMITS.blockTextChars),
        codeBlocks: extractCodeBlocks(node).map((item) => item.code),
        images: extractImages(node),
        attachments: extractAttachments(node)
      };
    });
    const allBlockTypes = allPostNodes.map((node, index) => inferForumBlockType(node, index));
    const commentLimit = Math.max(0, LIMITS.blocks - (allBlockTypes.includes("main_post") ? 1 : 0));
    recordLimit(
      truncation,
      "comments",
      allBlockTypes.filter((type) => type === "comment").length,
      blocks.filter((block) => block.type === "comment").length,
      commentLimit
    );
    truncation.blockTextChars = blockTextStats;
    return {
      kind: "thread",
      title: textOf(titleNode) || pageTitle,
      author,
      publishedAt,
      root,
      text: normalizeText(root?.innerText || root?.textContent || document.body?.innerText || ""),
      blocks,
      attachments: extractAttachments(root || document.body),
      nextPages: extractNextPages(truncation)
    };
  }

  function extractHackerNews(truncation, pageTitle) {
    const titleNode = document.querySelector(".titleline a") || document.querySelector("title");
    const comments = [...document.querySelectorAll(".comment-tree .athing, tr.athing.comtr")]
      .map((node, index) => ({
        type: "comment",
        floor: index + 1,
        author: textOf(node.querySelector(".hnuser")),
        time: textOf(node.querySelector(".age")),
        text: normalizeText(node.innerText || node.textContent || "")
      }))
      .filter((block) => block.text.length > 20);
    return {
      kind: "thread",
      title: textOf(titleNode) || pageTitle,
      author: textOf(document.querySelector(".subtext .hnuser")),
      publishedAt: textOf(document.querySelector(".subtext .age")),
      root: document.body,
      text: normalizeText(document.body?.innerText || document.body?.textContent || ""),
      blocks: comments,
      nextPages: extractNextPages(truncation)
    };
  }

  function extractReddit(_truncation, pageTitle) {
    const root = firstExisting(["main", "shreddit-post", ".Post", "article"]) || document.body;
    const post = firstExisting(["shreddit-post", ".Post", "article", "main"]) || root;
    const title = textOf(post.querySelector("[slot='title'], h1, .title")) || pageTitle;
    const author = post.getAttribute?.("author") || textOf(post.querySelector("[slot='authorName'], .author, [class*='author']"));
    const publishedAt = textOf(post.querySelector("time, .date, [class*='time']"));
    const postBody = post.querySelector("[slot='text-body'], .md, .usertext-body, .content") || post;
    const mainPost = {
      type: "main_post",
      floor: 1,
      author,
      time: publishedAt,
      text: normalizeText(postBody.innerText || postBody.textContent || ""),
      codeBlocks: extractCodeBlocks(postBody).map((item) => item.code),
      images: extractImages(postBody),
      attachments: extractAttachments(postBody)
    };
    const comments = uniqueNodes([...document.querySelectorAll("shreddit-comment, .comment")]).map((node, index) => {
      const body = node.querySelector("[slot='comment'], .md, .usertext-body, .content") || node;
      return {
        type: "comment",
        floor: index + 2,
        author: node.getAttribute?.("author") || textOf(node.querySelector(".author, [slot='authorName'], [class*='author']")),
        time: textOf(node.querySelector("time, .date, [class*='time']")),
        text: normalizeText(body.innerText || body.textContent || ""),
        codeBlocks: extractCodeBlocks(body).map((item) => item.code),
        images: extractImages(body),
        attachments: extractAttachments(body)
      };
    }).filter((block) => block.text.length > 20);
    const blocks = [mainPost, ...comments].filter((block) => block.text.length > 20);
    return {
      kind: "thread",
      title,
      author,
      publishedAt,
      root,
      text: normalizeText(blocks.map((block) => block.text).join("\n\n")),
      blocks
    };
  }

  function extractArxiv() {
    const titleNode = firstExisting(["h1.title", "h1"]);
    const abstractNode = firstExisting(["blockquote.abstract", ".abstract"]);
    const authors = textOf(firstExisting([".authors", ".authors a"]));
    const meta = textOf(firstExisting([".dateline", ".submission-history"]));
    return {
      kind: "paper",
      title: textOf(titleNode).replace(/^Title:\s*/i, "") || document.title || "Untitled paper",
      author: authors.replace(/^Authors:\s*/i, ""),
      publishedAt: meta,
      root: document.body,
      text: normalizeText([textOf(titleNode), authors, textOf(abstractNode), meta].join("\n\n")),
      blocks: [{ type: "abstract", text: textOf(abstractNode).replace(/^Abstract:\s*/i, "") }].filter((block) => block.text)
    };
  }

  function extractGithubThread(profileId, pageTitle) {
    const root = firstExisting([".js-discussion", ".discussion-timeline", ".markdown-body", "main"]) || document.body;
    const titleNode = firstExisting([".js-issue-title", "bdi", "h1"]) || document.querySelector("title");
    const commentNodes = uniqueNodes([...root.querySelectorAll(".js-comment")]);
    const fallbackNodes = uniqueNodes([...root.querySelectorAll(".comment-body, .markdown-body")]);
    const nodes = commentNodes.length ? commentNodes : fallbackNodes;
    const blocks = (nodes.length ? nodes : [root]).map((node, index) => {
      const body = node.querySelector?.(".markdown-body, .comment-body") || node;
      return {
        type: index === 0 ? "main_post" : "comment",
        floor: index + 1,
        author: textOf(node.querySelector?.(".author, .Link--primary, [class*='author']")),
        time: textOf(node.querySelector?.("relative-time, time, .date, [class*='time']")),
        text: normalizeText(body.innerText || body.textContent || ""),
        codeBlocks: extractCodeBlocks(body).map((item) => item.code),
        images: extractImages(body),
        attachments: extractAttachments(body)
      };
    }).filter((block) => block.text.length > 20);
    return {
      kind: "thread",
      title: textOf(titleNode) || pageTitle,
      author: blocks[0]?.author || "",
      publishedAt: blocks[0]?.time || "",
      root,
      text: normalizeText(blocks.map((block) => block.text).join("\n\n")),
      blocks
    };
  }

  function extractArticle(selectors, pageTitle) {
    const root = pickBestRoot(selectors);
    const titleNode = firstExisting(["h1", "[data-testid='headline']", ".title", ".post-title"]) || document.querySelector("title");
    return {
      kind: "page",
      title: textOf(titleNode) || pageTitle,
      author: textOf(firstExisting(["[rel='author']", ".author", ".byline", ".rich_media_meta_text", ".rich_media_meta_nickname", "[class*='author']", "[class*='byline']"])),
      publishedAt: textOf(firstExisting(["time", ".date", ".publish-time", "[class*='date']", "[class*='time']"])),
      root,
      text: normalizeText(root?.innerText || root?.textContent || ""),
      blocks: []
    };
  }

  function pickBestRoot(selectors) {
    const nodes = uniqueNodes(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]));
    let best = nodes[0] || document.body;
    let bestScore = 0;
    for (const node of nodes) {
      const text = normalizeText(node.innerText || node.textContent || "");
      const paragraphs = node.querySelectorAll?.("p, li, h1, h2, h3, pre, code, blockquote").length || 0;
      const score = text.length + paragraphs * 120;
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }
    return best;
  }

  function firstExisting(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  function uniqueNodes(nodes) {
    return [...new Set(nodes.filter(Boolean))];
  }

  function textOf(node) {
    return normalizeText(node?.innerText || node?.textContent || "");
  }

  function extractHeadings(truncation) {
    const headings = [...document.querySelectorAll("h1, h2, h3")]
      .map((node) => `${"#".repeat(Math.min(Number(node.tagName.slice(1)), 3))} ${normalizeText(node.innerText || node.textContent || "")}`)
      .filter((line) => !/^#+\s*$/.test(line));
    return limitItems(headings, "headings", LIMITS.headings, truncation);
  }

  function extractCodeBlocks(root, truncation = null) {
    const preNodes = [...(root?.querySelectorAll?.("pre") || [])];
    const looseCodeNodes = [...(root?.querySelectorAll?.("code") || [])].filter((node) => !node.closest("pre"));
    const items = [...preNodes, ...looseCodeNodes]
      .map((node) => ({
        language: detectLanguage(node),
        code: normalizeText(node.innerText || node.textContent || "")
      }))
      .filter((item) => item.code.length > 20);
    return truncation ? limitItems(items, "codeBlocks", LIMITS.codeBlocks, truncation) : items.slice(0, LIMITS.codeBlocks);
  }

  function detectLanguage(node) {
    const className = String([node.className || "", node.querySelector?.("code")?.className || ""].join(" "));
    const match = className.match(/language-([\w-]+)/) || className.match(/highlight-([\w-]+)/);
    return match?.[1] || "";
  }

  function extractImages(root, truncation = null) {
    const images = [...(root?.querySelectorAll?.("img") || [])]
      .map((image) => ({
        src: resolveUrl(image.currentSrc || image.src || image.getAttribute("data-src") || image.getAttribute("data-original") || image.getAttribute("data-lazy-src") || ""),
        alt: normalizeText(image.alt || image.title || ""),
        context: normalizeText(image.closest("figure, p, div")?.innerText || "").slice(0, 240)
      }))
      .filter((image) => image.src && !image.src.startsWith("data:"));
    return truncation ? limitItems(images, "images", LIMITS.images, truncation) : images.slice(0, LIMITS.images);
  }

  function extractAttachments(root, truncation = null) {
    const attachments = collectLinks(root)
      .filter((link) => /\.(?:zip|7z|rar|pdf|docx?|xlsx?|pptx?)($|[?#])/i.test(link.href) || /附件|下载|file|pdf/i.test(link.text));
    return truncation ? limitItems(attachments, "attachments", LIMITS.attachments, truncation) : attachments.slice(0, LIMITS.attachments);
  }

  function extractLinks(root, truncation) {
    return limitItems(collectLinks(root), "links", LIMITS.links, truncation);
  }

  function collectLinks(root) {
    return [...(root?.querySelectorAll?.("a[href]") || [])]
      .map((link) => ({
        text: normalizeText(link.innerText || link.textContent || link.href).slice(0, 120),
        href: link.href
      }))
      .filter((link) => link.text && link.href && !link.href.startsWith("javascript:"));
  }

  function resolveUrl(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      return new URL(text, location.href).href;
    } catch {
      return text;
    }
  }

  function extractNextPages(truncation) {
    const pages = [...document.querySelectorAll("a[href]")]
      .filter((link) => /下一页|next|more|older/i.test(link.innerText || link.textContent || link.getAttribute("aria-label") || ""))
      .map((link) => link.href)
      .filter(Boolean);
    return limitItems(pages, "nextPages", LIMITS.nextPages, truncation);
  }

  function limitItems(items, key, limit, truncation) {
    const list = Array.isArray(items) ? items : [];
    const kept = list.slice(0, limit);
    if (truncation) recordLimit(truncation, key, list.length, kept.length, limit);
    return kept;
  }

  function recordLimit(truncation, key, total, kept, limit) {
    truncation[key] = { total, kept, limit, truncated: total > kept };
  }

  function hasTruncation(truncation) {
    return Object.values(truncation).some((item) => item?.truncated);
  }

  function blocksToMarkdown(items) {
    return items.map((block) => {
      const header = [
        `### ${block.type === "main_post" ? "主帖" : block.type === "comment" ? "评论" : block.type}`,
        block.floor ? `#${block.floor}` : "",
        block.author ? `作者：${block.author}` : "",
        block.time ? `时间：${block.time}` : ""
      ].filter(Boolean).join(" · ");
      const codes = (block.codeBlocks || []).map((code) => `\n\`\`\`\n${code}\n\`\`\``).join("\n");
      const attachments = (block.attachments || []).map((item) => `\n- 附件：[${item.text || "attachment"}](${item.href})`).join("");
      return `${header}\n\n${block.text || ""}${codes}${attachments}`;
    }).join("\n\n");
  }

  function findFloor(node, text, index) {
    const attr = node.getAttribute("data-floor") || "";
    if (/^\d+$/.test(attr)) return Number(attr);
    const id = node.id || "";
    const idMatch = id.match(/(?:post|floor|comment)[_-]?(\d+)/i);
    if (idMatch) return Number(idMatch[1]);
    const match = text.match(/(?:#|楼层|楼|第)\s*(\d+)/);
    return match ? Number(match[1]) : index + 1;
  }

  function inferForumBlockType(node, index) {
    const marker = [
      node.className,
      node.id,
      node.getAttribute?.("data-role"),
      node.getAttribute?.("data-type")
    ].join(" ").toLowerCase();
    if (/\b(reply|comment)\b|post-reply|post_reply/.test(marker)) return "comment";
    if (/\b(main|thread|post)\b/.test(marker)) return "main_post";
    return index === 0 ? "main_post" : "comment";
  }

  function formatCodeBlock(item) {
    return `\`\`\`${item.language || ""}\n${item.code}\n\`\`\``;
  }

  function scoreQuality({ text, blocks, images, codeBlocks, attachments, extracted }) {
    let score = 0;
    if (text.length > 1200) score += 35;
    else if (text.length > 400) score += 20;
    if (blocks.length) score += 20;
    if (codeBlocks.length) score += 10;
    if (images.length) score += 5;
    if (attachments.length) score += 5;
    if (extracted.author) score += 5;
    if (extracted.publishedAt) score += 5;
    if ((extracted.nextPages || []).length) score += 5;
    return Math.min(100, score || 10);
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  window.QCSmartReaderProfiles = {
    version: "0.1.0",
    inferSite,
    extractReadablePage
  };
})();
