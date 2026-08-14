(function installQCI18n(root) {
  "use strict";

  const STORAGE_KEY = "uiLocale";
  const AUTO = "auto";
  const catalogs = {
    en: {
      "shell.sourceLine.empty": "Read web pages, posts, and paper excerpts",
      "shell.sourceLine.selection": "Current source: selected text",
      "shell.sourceLine.page": "Current source: page content",
      "locale.label": "Interface language",
      "locale.auto": "Auto (browser)",
      "locale.english": "English",
      "locale.chinese": "Simplified Chinese",
      "nav.label": "Primary navigation",
      "nav.chat": "Read",
      "nav.batch": "Batch",
      "nav.agents": "Agents",
      "nav.knowledge": "Knowledge",
      "nav.deliverables": "Deliver",
      "nav.settings": "Settings",
      "advanced.notice": "Quick Start and setup are available in English. Advanced Batch, Agents, Knowledge, Deliverables, and project/model controls are currently shown in Chinese.",
      "advanced.chatNotice": "Agent Q&A below is an advanced workflow and currently remains in Chinese.",
      "advanced.knowledgeNotice": "First Evidence is available in English. The remaining Knowledge workspace is advanced and currently stays in Chinese.",
      "advanced.settingsNotice": "Companion setup is available in English. Project, capture-plan, and model controls below are advanced and currently stay in Chinese.",
      "quickStart.title": "Create your first evidence-backed claim from this page",
      "quickStart.hint": "Capture this page, compare one draft claim with its exact source quote, and decide whether it is supported. Saved locally; no external model is used.",
      "quickStart.step.pair": "Connect Companion",
      "quickStart.step.capture": "Capture this page",
      "quickStart.step.review": "Review & save",
      "quickStart.localOnly": "Progress stays in Chrome local storage. No usage telemetry is sent.",
      "quickStart.button.first": "Create your first evidence-backed claim",
      "quickStart.button.continue": "Continue the evidence chain from this page",
      "quickStart.button.another": "Create a different evidence-backed claim",
      "quickStart.button.again": "Create another evidence-backed claim",
      "quickStart.restore.reviewed": "the claim was marked supported and saved",
      "quickStart.restore.rejected": "the claim was marked unsupported and saved",
      "quickStart.restore.invalidated": "server status changed to {status}; compare the claim and quote again",
      "quickStart.restore.evidence": "the claim and exact quote are ready for your decision",
      "quickStart.restore.extracted": "local extraction finished and evidence is ready to inspect",
      "quickStart.restore.captured": "a source was saved; continue from the current page",
      "quickStart.restore.paired": "the local Companion is paired",
      "quickStart.restore.prefix": "Restored local progress: {step}.",
      "quickStart.status.reading": "1 / 3 Reading this page and saving it to the local Vault...",
      "quickStart.status.extracting": "2 / 3 Source saved locally; preparing the claim and exact quote...",
      "quickStart.status.evidenceReady": "2 / 3 Claim and exact quote are ready. Decide whether the quote supports the claim.",
      "quickStart.status.completedReviewed": "3 / 3 Saved locally and reviewed by you. This claim is marked supported.",
      "quickStart.status.completedRejected": "3 / 3 Decision saved locally: claim marked unsupported. Capture another page when you're ready.",
      "quickStart.status.failed": "Quick Start did not complete: {error}",
      "quickStart.error.pairFirst": "Enter your Pairing Token in Settings and test the local Companion first.",
      "quickStart.error.noSourceId": "The local Companion did not return a source id.",
      "quickStart.error.noEvidence": "The local template did not return an evidence chain containing both a claim and an exact quote; progress was not marked complete.",
      "quickStart.knowledgeReady": "Quick Start found the first claim and exact quote. No decision has been made, and no external model was called.",
      "currentPage.read": "Read current page",
      "currentPage.selection": "Use selected text",
      "currentPage.saveNote": "Save note",
      "currentPage.selectorPlaceholder": "Content CSS selector, for example article or #js_content",
      "currentPage.readSelector": "Read selector",
      "currentPage.emptyTitle": "No content read yet",
      "currentPage.characters": "{count} chars",
      "currentPage.enqueuePages": "Add next pages to capture plan",
      "currentPage.question": "Question",
      "currentPage.ask": "Start reading",
      "currentPage.clear": "Clear result",
      "currentPage.status.reading": "Reading the current page...",
      "currentPage.status.saved": "Read {count} chars and saved them to the local Vault ({sourceId}).",
      "currentPage.status.readNotSaved": "Read {count} chars, but did not save to the Vault: {error}",
      "currentPage.status.failed": "Could not read the page: {error}",
      "currentPage.error.noTab": "No active tab was found.",
      "currentPage.error.authRequired": "This page requires sign-in or permission, so its content could not be captured.",
      "currentPage.error.noBody": "No article text was extracted. On a PDF page, select text and send it from the context menu.",
      "currentPage.selection.defaultTitle": "Selected text",
      "currentPage.selection.loading": "Reading selected text from the current page...",
      "currentPage.selection.none": "No text is selected on this page. Select the article text first, or send it to the reader from the context menu.",
      "currentPage.selection.success": "Read {count} characters of selected text.",
      "currentPage.selection.failed": "Could not read selected text: {error}",
      "currentPage.pending.busy": "The current operation is still running, so the source cannot be switched yet.",
      "currentPage.pending.deferred": "New selected text was received and kept in the pending queue. Select Use selected text to switch sources.",
      "currentPage.pending.failed": "Could not read pending selected text: {error}",
      "currentPage.pending.noResponse": "the extension background did not respond",
      "currentPage.pending.queueFull": "There are already {count} selected-text items; the queue is full. This selection was not added and did not overwrite existing items. Process the queue with Use selected text and try again.",
      "currentPage.pending.projectMismatch": "A context-menu selection belongs to project {projectId}. Switch to that project to load it.",
      "currentPage.pending.cannotLoadProject": "Selected text belongs to project {selectionProjectId} and cannot be loaded into the current project {currentProjectId}.",
      "currentPage.pending.loaded": "Loaded selected text from the context menu.",
      "currentPage.selector.defaultTitle": "Manual selector source",
      "currentPage.selector.required": "Enter a content CSS selector, for example article, main, or #js_content.",
      "currentPage.selector.reading": "Reading with selector: {selector}",
      "currentPage.selector.success": "Read {count} characters with the selector.",
      "currentPage.selector.failed": "Could not read with the selector: {error}",
      "currentPage.selector.invalid": "This CSS selector is invalid: {selector}.",
      "currentPage.selector.noMatch": "No element matches this CSS selector: {selector}.",
      "currentPage.selector.empty": "The selector matched an element, but it contains no readable text: {selector}.",
      "currentPage.nextPages.preview": "Next pages: {urls}{more}",
      "currentPage.nextPages.more": " · +{count}",
      "currentPage.nextPages.button": "Add {count} next pages to capture plan",
      "currentPage.nextPages.none": "The current source has no next-page links.",
      "currentPage.nextPages.working": "Adding {count} next-page links to Capture Plan...",
      "currentPage.nextPages.success": "Added {count} next-page sources to Capture Plan.",
      "currentPage.nextPages.failed": "Could not add next-page sources: {error}",
      "currentPage.summary.profile": "profile",
      "currentPage.summary.quality": "quality",
      "currentPage.summary.images": "images",
      "currentPage.summary.codeBlocks": "code blocks",
      "currentPage.summary.attachments": "attachments",
      "currentPage.summary.comments": "comments",
      "currentPage.summary.nextPages": "next pages",
      "currentPage.summary.pdfPages": "PDF pages",
      "currentPage.summary.transcriptSegments": "caption segments",
      "currentPage.summary.ocrPages": "OCR replaced pages",
      "firstEvidence.title": "First evidence-backed claim",
      "firstEvidence.quoteTitle": "Exact quote from the source",
      "firstEvidence.prompt": "Does this exact quote support the claim?",
      "firstEvidence.accept": "Accept as supported",
      "firstEvidence.reject": "Reject as unsupported",
      "firstEvidence.acceptedButton": "Accepted as supported",
      "firstEvidence.rejectedButton": "Marked unsupported",
      "firstEvidence.review.pending": "Does this exact quote support the claim? Choose the decision that matches the source.",
      "firstEvidence.review.reviewed": "Saved locally and reviewed by you. This claim is marked supported.",
      "firstEvidence.review.rejected": "Decision saved locally. This claim is marked unsupported; that is a valid review outcome. You can capture another page.",
      "firstEvidence.review.previous": "Your previous decision no longer matches the server status ({status}). Compare the claim and quote again.",
      "firstEvidence.review.crossProject": "Cannot save this decision: the evidence belongs to another project. Cross-project review was blocked.",
      "firstEvidence.review.crossProjectStatus": "Cross-project review was blocked. Run Quick Start again in the current project.",
      "firstEvidence.review.missing": "Cannot save this decision: the claim or exact quote is missing. Run Quick Start again.",
      "firstEvidence.review.savingReviewed": "Saving your supported decision...",
      "firstEvidence.review.savingRejected": "Saving your unsupported decision...",
      "firstEvidence.review.notConfirmed": "The local Companion did not confirm the {status} decision; completion was not recorded.",
      "firstEvidence.review.accepted": "Saved locally and reviewed by you. This claim is marked supported.",
      "firstEvidence.review.rejectedSaved": "Decision saved locally. The claim is marked unsupported; you can continue with another page.",
      "firstEvidence.review.failed": "Could not save this decision: {error}",
      "settings.serviceTitle": "Local Companion",
      "settings.trust": "Your captures stay in your local Vault. The zero-config local template does not call an external model; sending content to a configured model requires your explicit consent.",
      "settings.setupTitle": "First use: 3 steps",
      "settings.setup.step1": "For a release build, double-click install.command in the Companion package. Use start.command only for source development.",
      "settings.setup.step2": "Paste the Pairing Token copied by the installer, then select Test local Companion.",
      "settings.setup.step3": "After pairing, run Quick Start. The local template needs no setup; privacy consent is required only when you switch to an external model.",
      "settings.serviceUrl": "Companion URL",
      "settings.pairingToken": "Pairing Token",
      "settings.pairingPlaceholder": "Copy it from the local Companion's state/pairing_token.txt",
      "settings.testCompanion": "Test local Companion",
      "settings.status.notPaired": "Pairing is not complete. Follow the 3-step setup guide above to connect the local Companion.",
      "settings.status.testing": "Testing the local Companion and Pairing Token...",
      "settings.status.needToken": "The local Companion is running. Enter the Pairing Token from {path}.",
      "settings.status.success": "Local Companion and Pairing Token are ready: extension {extensionVersion} · service {serviceVersion} · API {apiVersion} · {vault}",
      "settings.status.invalidToken": "The Pairing Token is invalid or missing: {error}",
      "settings.status.unavailable": "The local Companion is unavailable: {error}",
      "settings.status.staleToken": "The Pairing Token is invalid or expired: {error}",
      "settings.status.notReady": "The local Companion is not ready: {error}",
      "companion.error.wrongService": "The address responded, but it is not the QC Smart Reader Companion.",
      "companion.error.apiMismatch": "Extension {extensionVersion} requires Companion API {requiredApi}; the current API is {actualApi}. Update and restart the Companion.",
      "companion.error.extensionTooOld": "This extension is too old. The Companion requires extension {requiredVersion} or newer; the current version is {currentVersion}. Update the extension.",
      "companion.error.invalidUrl": "The Companion URL is invalid.",
      "companion.error.unsafeUrl": "To protect the Pairing Token, the Companion URL only allows local http://127.0.0.1 or localhost addresses.",
      "companion.error.timeout": "The Companion request timed out after {seconds} seconds. It may still be processing; check its status before retrying.",
      "companion.error.network": "Could not reach the local Companion. Check that it is running and try again.",
      "companion.error.invalidResponse": "The Companion returned an invalid response (HTTP {status}).",
      "companion.value.legacyUnknown": "legacy or unknown",
      "status.unknown": "unknown"
    },
    "zh-CN": {
      "shell.sourceLine.empty": "读取网页、帖子、论文片段",
      "shell.sourceLine.selection": "当前来源：选中文本",
      "shell.sourceLine.page": "当前来源：网页正文",
      "locale.label": "界面语言",
      "locale.auto": "自动（跟随浏览器）",
      "locale.english": "English",
      "locale.chinese": "简体中文",
      "nav.label": "主导航",
      "nav.chat": "聊天",
      "nav.batch": "批量",
      "nav.agents": "Agent",
      "nav.knowledge": "知识库",
      "nav.deliverables": "交付",
      "nav.settings": "设置",
      "advanced.notice": "Quick Start 和首次设置已支持中英文。批量、Agent、高级知识库、交付以及项目/模型控制暂保持中文。",
      "advanced.chatNotice": "下方 Agent 问答属于高级功能，暂保持中文。",
      "advanced.knowledgeNotice": "First Evidence 已支持中英文；其余知识库工作台属于高级功能，暂保持中文。",
      "advanced.settingsNotice": "Companion 设置已支持中英文；下方项目、采集计划和模型控制属于高级功能，暂保持中文。",
      "quickStart.title": "用当前页完成第一条可核验证据",
      "quickStart.hint": "采集当前页，对照一条草稿 claim 与原文 exact quote，再判断是否支持。全部保存在本地，不调用外部模型。",
      "quickStart.step.pair": "连接 Companion",
      "quickStart.step.capture": "采集当前页",
      "quickStart.step.review": "核对并保存",
      "quickStart.localOnly": "进度只保存在 Chrome 本地存储；不发送使用遥测。",
      "quickStart.button.first": "从当前页生成第一条证据",
      "quickStart.button.continue": "继续：用当前页完成证据链",
      "quickStart.button.another": "换当前页生成另一条证据",
      "quickStart.button.again": "用当前页再生成一条证据",
      "quickStart.restore.reviewed": "claim 已标记为支持并保存",
      "quickStart.restore.rejected": "claim 已标记为不支持并保存",
      "quickStart.restore.invalidated": "服务端状态已变为 {status}，请重新对照 claim 与原文",
      "quickStart.restore.evidence": "claim 与 exact quote 已就绪，等待你判断",
      "quickStart.restore.extracted": "已完成本地抽取，等待查看证据",
      "quickStart.restore.captured": "已保存过来源，可从当前页继续",
      "quickStart.restore.paired": "本地服务已配对",
      "quickStart.restore.prefix": "已恢复本地进度：{step}。",
      "quickStart.status.reading": "1 / 3 正在读取当前页并保存到本地 Vault...",
      "quickStart.status.extracting": "2 / 3 来源已保存到本地；正在准备 claim 与 exact quote...",
      "quickStart.status.evidenceReady": "2 / 3 claim 与 exact quote 已就绪；请判断原文是否支持 claim。",
      "quickStart.status.completedReviewed": "3 / 3 已保存到本地并由你核对；这条 claim 已标记为支持。",
      "quickStart.status.completedRejected": "3 / 3 决定已保存到本地；claim 已标记为不支持。可以继续采集另一个页面。",
      "quickStart.status.failed": "Quick Start 未完成：{error}",
      "quickStart.error.pairFirst": "请先在设置中填写 Pairing Token 并测试本地服务。",
      "quickStart.error.noSourceId": "本地服务没有返回 source id。",
      "quickStart.error.noEvidence": "本地模板没有返回同时包含 claim 与 exact quote 的证据链；未标记为完成。",
      "quickStart.knowledgeReady": "Quick Start 已定位第一条 claim 与 exact quote；尚未做出判断，也未调用外部模型。",
      "currentPage.read": "读取当前页",
      "currentPage.selection": "使用选中文本",
      "currentPage.saveNote": "保存笔记",
      "currentPage.selectorPlaceholder": "正文 CSS 选择器，例如 article 或 #js_content",
      "currentPage.readSelector": "读取选择器",
      "currentPage.emptyTitle": "尚未读取内容",
      "currentPage.characters": "{count} 字",
      "currentPage.enqueuePages": "分页加入候选池",
      "currentPage.question": "问题",
      "currentPage.ask": "开始阅读",
      "currentPage.clear": "清空结果",
      "currentPage.status.reading": "正在读取当前页面...",
      "currentPage.status.saved": "已读取 {count} 字；已保存到本地 Vault（{sourceId}）。",
      "currentPage.status.readNotSaved": "已读取 {count} 字，但未保存到 Vault：{error}",
      "currentPage.status.failed": "读取失败：{error}",
      "currentPage.error.noTab": "没有找到当前标签页。",
      "currentPage.error.authRequired": "页面需要登录或权限，无法采集正文。",
      "currentPage.error.noBody": "没有抽取到正文。PDF 页面可以先选中文本后右键发送。",
      "currentPage.selection.defaultTitle": "选中文本",
      "currentPage.selection.loading": "正在读取当前页选中文本...",
      "currentPage.selection.none": "当前页没有选中文本。可以先选中正文，或在页面里右键发送到阅读器。",
      "currentPage.selection.success": "已读取选中文本 {count} 字。",
      "currentPage.selection.failed": "读取选中文本失败：{error}",
      "currentPage.pending.busy": "当前操作尚未完成，暂不能切换来源。",
      "currentPage.pending.deferred": "收到新的右键选中文本，已保留在待载入队列；点击“使用选中文本”切换来源。",
      "currentPage.pending.failed": "读取待选文本失败：{error}",
      "currentPage.pending.noResponse": "扩展后台未响应",
      "currentPage.pending.queueFull": "待载入队列已有 {count} 条选中文本，队列已满。本次选择未入队，也没有覆盖旧内容。请先点击“使用选中文本”处理队列后再试。",
      "currentPage.pending.projectMismatch": "有一条右键选中文本属于项目 {projectId}；切回该项目后再载入。",
      "currentPage.pending.cannotLoadProject": "右键选中文本属于项目 {selectionProjectId}，不能载入当前项目 {currentProjectId}。",
      "currentPage.pending.loaded": "已载入右键选中的文本。",
      "currentPage.selector.defaultTitle": "手动选择器来源",
      "currentPage.selector.required": "请输入正文 CSS 选择器，例如 article、main、#js_content。",
      "currentPage.selector.reading": "正在按选择器读取：{selector}",
      "currentPage.selector.success": "已按选择器读取 {count} 字。",
      "currentPage.selector.failed": "选择器读取失败：{error}",
      "currentPage.selector.invalid": "CSS 选择器无效：{selector}。",
      "currentPage.selector.noMatch": "页面中没有匹配该 CSS 选择器：{selector}。",
      "currentPage.selector.empty": "选择器匹配到了元素，但没有可读取文本：{selector}。",
      "currentPage.nextPages.preview": "下一页：{urls}{more}",
      "currentPage.nextPages.more": " · +{count}",
      "currentPage.nextPages.button": "分页加入候选池 ({count})",
      "currentPage.nextPages.none": "当前来源没有分页链接。",
      "currentPage.nextPages.working": "正在把 {count} 个分页链接加入 Capture Plan...",
      "currentPage.nextPages.success": "已加入 {count} 个分页候选来源。",
      "currentPage.nextPages.failed": "分页加入候选池失败：{error}",
      "currentPage.summary.profile": "profile",
      "currentPage.summary.quality": "质量",
      "currentPage.summary.images": "图片",
      "currentPage.summary.codeBlocks": "代码块",
      "currentPage.summary.attachments": "附件",
      "currentPage.summary.comments": "评论",
      "currentPage.summary.nextPages": "分页",
      "currentPage.summary.pdfPages": "PDF页",
      "currentPage.summary.transcriptSegments": "字幕段",
      "currentPage.summary.ocrPages": "OCR替换页",
      "firstEvidence.title": "第一条有原文支撑的 Claim",
      "firstEvidence.quoteTitle": "Exact quote · 原文引用",
      "firstEvidence.prompt": "这段原文是否支持这条 claim？",
      "firstEvidence.accept": "接受：原文支持",
      "firstEvidence.reject": "拒绝：原文不支持",
      "firstEvidence.acceptedButton": "已接受为支持",
      "firstEvidence.rejectedButton": "已标记不支持",
      "firstEvidence.review.pending": "这段原文是否支持这条 claim？请选择与来源一致的判断。",
      "firstEvidence.review.reviewed": "已保存到本地并由你核对；这条 claim 已标记为支持。",
      "firstEvidence.review.rejected": "决定已保存到本地；这条 claim 已标记为不支持。这是有效的核对结果，可以继续采集另一个页面。",
      "firstEvidence.review.previous": "上次判断与服务端当前状态（{status}）不再一致；请重新对照 claim 与原文。",
      "firstEvidence.review.crossProject": "无法保存决定：这条证据属于另一个项目，已阻止跨项目审阅。",
      "firstEvidence.review.crossProjectStatus": "已阻止跨项目审阅；请在当前项目重新运行 Quick Start。",
      "firstEvidence.review.missing": "无法保存决定：缺少 claim 或 exact quote，请重新运行 Quick Start。",
      "firstEvidence.review.savingReviewed": "正在保存“原文支持”判断...",
      "firstEvidence.review.savingRejected": "正在保存“原文不支持”判断...",
      "firstEvidence.review.notConfirmed": "本地服务没有确认 {status} 判断；未记录完成里程碑。",
      "firstEvidence.review.accepted": "已保存到本地并由你核对；这条 claim 已标记为支持。",
      "firstEvidence.review.rejectedSaved": "决定已保存到本地；claim 已标记为不支持，可以继续采集另一个页面。",
      "firstEvidence.review.failed": "无法保存这次判断：{error}",
      "settings.serviceTitle": "本地服务",
      "settings.trust": "采集内容保存在本机 Vault。零配置本地模板不调用外部模型；只有你明确同意后，才会把内容发送给已配置的模型。",
      "settings.setupTitle": "首次使用 · 3 步完成",
      "settings.setup.step1": "正式版双击 Companion 包里的 install.command；源码开发时才用 start.command。",
      "settings.setup.step2": "粘贴安装器复制的 Pairing Token，点击“测试本地服务”。",
      "settings.setup.step3": "配对成功后直接运行 Quick Start；默认本地模板零配置，只有切换外部模型时才需要隐私同意。",
      "settings.serviceUrl": "Companion URL",
      "settings.pairingToken": "Pairing Token",
      "settings.pairingPlaceholder": "从本地服务 state/pairing_token.txt 复制",
      "settings.testCompanion": "测试本地服务",
      "settings.status.notPaired": "尚未完成配对。请按上方 3 步首次使用指引连接本地服务。",
      "settings.status.testing": "正在测试本地服务和 Pairing Token...",
      "settings.status.needToken": "本地服务已启动；请填写 Pairing Token：{path}",
      "settings.status.success": "本地服务和 Pairing Token 均正常：扩展 {extensionVersion} · 服务 {serviceVersion} · API {apiVersion} · {vault}",
      "settings.status.invalidToken": "Pairing Token 无效或未填写：{error}",
      "settings.status.unavailable": "本地服务不可用：{error}",
      "settings.status.staleToken": "Pairing Token 已失效或不正确：{error}",
      "settings.status.notReady": "本地服务尚未就绪：{error}",
      "companion.error.wrongService": "该地址有响应，但不是 QC Smart Reader Companion。",
      "companion.error.apiMismatch": "版本不兼容：扩展 {extensionVersion} 需要 Companion API {requiredApi}，当前 API 为 {actualApi}。请更新并重启 Companion。",
      "companion.error.extensionTooOld": "扩展版本过旧。Companion 要求扩展 {requiredVersion} 或更高，当前为 {currentVersion}。请更新扩展。",
      "companion.error.invalidUrl": "Companion URL 格式无效。",
      "companion.error.unsafeUrl": "为保护 Pairing Token，Companion URL 仅允许本机 http://127.0.0.1 或 localhost 地址。",
      "companion.error.timeout": "Companion 请求超时（{seconds} 秒）。服务可能仍在处理，请先检查状态再重试。",
      "companion.error.network": "无法连接本地 Companion。请确认服务已启动后重试。",
      "companion.error.invalidResponse": "Companion 返回了无法解析的响应（HTTP {status}）。",
      "companion.value.legacyUnknown": "旧版或未知",
      "status.unknown": "未知"
    }
  };

  function normalize(value) {
    const locale = String(value || "").trim().replace(/_/g, "-").toLowerCase();
    if (!locale || locale === AUTO) return "en";
    if (locale === "zh" || /^zh-(cn|hans|sg)(?:-|$)/.test(locale)) return "zh-CN";
    if (locale === "en" || locale.startsWith("en-")) return "en";
    return "en";
  }

  function browserLocale() {
    try {
      const chromeLocale = root.chrome?.i18n?.getUILanguage?.();
      if (chromeLocale) return chromeLocale;
    } catch (_error) {
      // Fall through to the browser standard when the extension API is unavailable.
    }
    return root.navigator?.language || "en";
  }

  function resolve(explicitLocale) {
    const explicit = String(explicitLocale || "").trim();
    return normalize(explicit && explicit.toLowerCase() !== AUTO ? explicit : browserLocale());
  }

  let preference = AUTO;
  let currentLocale = resolve();

  function interpolate(message, params = {}) {
    return String(message).replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => {
      if (!Object.prototype.hasOwnProperty.call(params, key)) return `{${key}}`;
      const value = params[key];
      if (value && typeof value === "object" && value.i18nKey) {
        return t(value.i18nKey, value.params || {});
      }
      return String(value);
    });
  }

  function t(key, params = {}) {
    const message = catalogs[currentLocale]?.[key]
      ?? catalogs.en[key]
      ?? key;
    return interpolate(message, params);
  }

  function attribute(node, name) {
    if (typeof node?.getAttribute === "function") return node.getAttribute(name);
    return node?.[name] ?? null;
  }

  function paramsForNode(node) {
    const raw = attribute(node, "data-i18n-params") || node?.dataset?.i18nParams;
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch (_error) {
      return {};
    }
  }

  function applyNode(node) {
    const params = paramsForNode(node);
    const textKey = attribute(node, "data-i18n") || node?.dataset?.i18nDynamicKey;
    const placeholderKey = attribute(node, "data-i18n-placeholder");
    const ariaKey = attribute(node, "data-i18n-aria-label");
    const titleKey = attribute(node, "data-i18n-title");
    const visibleLocale = attribute(node, "data-i18n-show-locale");
    if (textKey) node.textContent = t(textKey, params);
    if (placeholderKey) node.placeholder = t(placeholderKey, params);
    if (ariaKey) node.setAttribute?.("aria-label", t(ariaKey, params));
    if (titleKey) node.title = t(titleKey, params);
    if (visibleLocale) node.hidden = normalize(visibleLocale) !== currentLocale;
  }

  function applyDocument(targetDocument = root.document) {
    if (!targetDocument) return currentLocale;
    if (targetDocument.documentElement) targetDocument.documentElement.lang = currentLocale;
    const selector = [
      "[data-i18n]",
      "[data-i18n-placeholder]",
      "[data-i18n-aria-label]",
      "[data-i18n-title]",
      "[data-i18n-show-locale]",
      "[data-i18n-dynamic-key]"
    ].join(",");
    for (const node of targetDocument.querySelectorAll?.(selector) || []) applyNode(node);
    const localeSelect = targetDocument.getElementById?.("uiLocaleSelect");
    if (localeSelect) localeSelect.value = preference;
    return currentLocale;
  }

  async function initialize(targetDocument = root.document) {
    let storedPreference = AUTO;
    try {
      const stored = await root.chrome?.storage?.local?.get?.(STORAGE_KEY);
      const candidate = String(stored?.[STORAGE_KEY] || "").trim();
      if (candidate && candidate.toLowerCase() !== AUTO) storedPreference = normalize(candidate);
    } catch (_error) {
      storedPreference = AUTO;
    }
    preference = storedPreference;
    currentLocale = resolve(preference);
    applyDocument(targetDocument);
    return currentLocale;
  }

  async function set(nextPreference, targetDocument = root.document) {
    const requested = String(nextPreference || AUTO).trim();
    if (!requested || requested.toLowerCase() === AUTO) {
      preference = AUTO;
      await root.chrome?.storage?.local?.remove?.(STORAGE_KEY);
    } else {
      preference = normalize(requested);
      await root.chrome?.storage?.local?.set?.({ [STORAGE_KEY]: preference });
    }
    currentLocale = resolve(preference);
    applyDocument(targetDocument);
    return currentLocale;
  }

  function get() {
    return currentLocale;
  }

  function getPreference() {
    return preference;
  }

  root.QCI18n = Object.freeze({
    STORAGE_KEY,
    applyDocument,
    get,
    initialize,
    normalize,
    preference: getPreference,
    resolve,
    set,
    t
  });
})(typeof window !== "undefined" ? window : globalThis);
