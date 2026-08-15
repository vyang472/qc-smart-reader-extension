const DEFAULT_AGENTS = [
  {
    id: "student",
    icon: "🐣",
    name: "学员小白",
    description: "提出初学者视角的好问题",
    prompt: "你是初学者代表。请指出最容易误解的概念、需要追问的问题、以及读完后应该先掌握的 3 个基础点。"
  },
  {
    id: "teacher",
    icon: "👨‍🏫",
    name: "老师",
    description: "用类比和例子把概念讲透",
    prompt: "你是老师。请用清晰类比、分层解释和例子讲透这篇内容，避免空话。"
  },
  {
    id: "expert",
    icon: "🧠",
    name: "领域专家",
    description: "结合行业背景深度解读",
    prompt: "你是领域专家。请判断内容在行业语境中的价值、隐含假设、关键机制和可能的外部变量。"
  },
  {
    id: "engineer",
    icon: "🔧",
    name: "工程师",
    description: "从实战落地角度提出追问",
    prompt: "你是工程师。请把内容转成可执行步骤、实现风险、验证方案和下一步实验。"
  },
  {
    id: "reviewer",
    icon: "🧐",
    name: "审查者",
    description: "评价讨论质量、纠偏补漏",
    prompt: "你是审查者。请专门检查证据强弱、逻辑跳跃、过度推断、缺失数据和需要补充的材料。"
  }
];

const DEFAULT_SYSTEM_PROMPT = `你是一个阅读研究助手。请基于用户提供的网页、帖子、论文或材料片段回答，不要编造来源没有的信息。
输出要服务于知识库沉淀：明确核心结论、证据、推演链、可执行启发、待验证问题。
如果材料质量低、证据不足或只是格式展示，要直接指出。`;

const BATCH_MAX_BROWSER_ATTEMPTS = 3;
const BATCH_RETRY_BASE_DELAY_MS = 1500;
const BATCH_MAX_CONCURRENCY = 3;
const DEFAULT_BATCH_HEARTBEAT_INTERVAL_MS = 30000;
const MIN_BATCH_HEARTBEAT_INTERVAL_MS = 100;
const SELECTION_QUEUED_MESSAGE = "qc-smart-reader-selection-queued";
const CLAIM_SELECTION_MESSAGE = "qc-smart-reader-claim-selection";
const FALLBACK_LEGACY_PROJECT_ID = "default";
const PENDING_NOTE_SYNC_TAG_PREFIX = "qc-local-note:";
const EXTENSION_VERSION = chrome.runtime?.getManifest?.().version || "0.9.4";
const REQUIRED_COMPANION_API_VERSION = 1;
const MODEL_DATA_CONSENT_VERSION = "2026-08-14-v1";
const ONBOARDING_MILESTONES_KEY = "onboardingMilestones";
const BATCH_RETRYABLE_FAILURE_LIMITS = {
  page_timeout: 3,
  network_error: 3,
  service_error: 3,
  extraction_empty: 2,
  pagination_needed: 1,
  attachment_missing: 1,
  unknown: 2
};

const EXTRACTION_LIMITS = {
  headings: 40,
  blocks: 120,
  blockTextChars: 12000,
  codeBlocks: 80,
  images: 80,
  attachments: 40,
  links: 40,
  nextPages: 5
};

const SOURCE_STATUS_LABELS = {
  new: "new",
  needs_review: "needs review",
  read: "read",
  extracted: "extracted",
  reviewed: "reviewed",
  rejected: "rejected",
  archived: "archived"
};

const STRATEGY_REVIEW_CHECKLISTS = {
  "paper-ready": [
    ["data_leakage", "无数据泄露 / look-ahead bias"],
    ["out_of_sample_result", "样本外结果可接受"],
    ["costs_included", "佣金、滑点和交易成本已纳入"],
    ["drawdown_bounded", "回撤在验收范围内"],
    ["turnover_feasible", "换手可执行"],
    ["liquidity_capacity_checked", "流动性 / 容量已检查"]
  ],
  "live-ready": [
    ["paper_trading_record", "纸盘记录已附并通过审查"],
    ["monitoring_plan", "监控计划已定义"],
    ["kill_switch", "Kill switch / 停止条件明确"],
    ["max_exposure", "最大敞口和仓位限制明确"],
    ["operational_failure_plan", "运维故障预案明确"],
    ["manual_reviewer_approval", "人工审批已记录"]
  ]
};

const state = {
  source: null,
  lastAnswer: "",
  lastAnswerSourceFingerprint: "",
  busyDepth: 0,
  settings: null,
  batchQueue: [],
  batchRunning: false,
  batchPaused: false,
  batchCancelRequested: false,
  batchExecutorId: "",
  batchConcurrency: 1,
  batchProjectId: "",
  busy: false,
  currentBatchJobId: "",
  batchMetrics: {
    startedAt: "",
    completedAt: "",
    total: 0,
    concurrency: 1,
    lastHeartbeatAt: "",
    qualityGateCounts: {
      total: 0,
      passed: 0,
      needsReview: 0,
      reasonCounts: {}
    }
  },
  currentSourceDetailId: "",
  currentSourceDetail: null,
  sourceDiffs: {},
  projects: [],
  projectDashboard: null,
  projectBrief: null,
  capturePlans: [],
  vaultDoctor: null,
  lineage: null,
  topicPackages: [],
  strategyHandoffs: [],
  strategyTickets: [],
  backtestResults: [],
  strategyReviews: [],
  claimReviewQueue: [],
  knowledgeRecords: {},
  projectViewGeneration: 0,
  onboardingMilestones: {},
  onboardingDecisionVerified: false,
  quickStartReplay: null
};

let pendingSelectionConsumption = Promise.resolve();
let pendingSelectionMessagesBound = false;

const $ = (id) => document.getElementById(id);

function uiText(key, params = {}, fallback = "") {
  const translated = globalThis.QCI18n?.t?.(key, params);
  return translated && translated !== key ? translated : fallback || key;
}

function setLocalizedNodeText(node, key, params = {}, fallback = "") {
  if (!node) return;
  if (node.dataset) {
    node.dataset.i18nDynamicKey = key;
    node.dataset.i18nParams = JSON.stringify(params);
  }
  node.textContent = uiText(key, params, fallback);
}

function companionReleaseLinks(version = EXTENSION_VERSION) {
  const releaseVersion = encodeURIComponent(String(version || "").trim());
  const releaseBase = `https://github.com/vyang472/qc-smart-reader-extension/releases/download/v${releaseVersion}`;
  return {
    companion: `${releaseBase}/qc-smart-reader-companion-${releaseVersion}.zip`,
    checksums: `${releaseBase}/SHA256SUMS`
  };
}

function configureCompanionReleaseLinks() {
  const links = companionReleaseLinks();
  const companionLink = $("companionDownloadLink");
  const checksumsLink = $("companionChecksumsLink");
  if (companionLink) {
    companionLink.href = links.companion;
    setLocalizedNodeText(
      companionLink,
      "settings.setup.downloadCompanion",
      { version: EXTENSION_VERSION },
      `下载 Companion v${EXTENSION_VERSION}`
    );
  }
  if (checksumsLink) {
    checksumsLink.href = links.checksums;
    setLocalizedNodeText(
      checksumsLink,
      "settings.setup.downloadChecksums",
      {},
      "校验 SHA256SUMS"
    );
  }
}

function clearLocalizedNodeText(node) {
  if (!node) return;
  if (node.dataset) {
    delete node.dataset.i18nDynamicKey;
    delete node.dataset.i18nParams;
  }
  node.removeAttribute?.("data-i18n-dynamic-key");
  node.removeAttribute?.("data-i18n-params");
}

function setRawNodeText(node, value) {
  if (!node) return;
  clearLocalizedNodeText(node);
  node.textContent = value || "";
}

function localizedError(key, fallback, params = {}) {
  const error = new Error(uiText(key, params, fallback));
  error.uiI18nKey = key;
  error.uiI18nParams = params;
  return error;
}

function errorI18nParam(error) {
  return error?.uiI18nKey
    ? { i18nKey: error.uiI18nKey, params: error.uiI18nParams || {} }
    : String(error?.message || error || "");
}

function refreshLocalizedNode(node) {
  const key = node?.dataset?.i18nDynamicKey;
  if (!key) return;
  let params = {};
  try {
    params = JSON.parse(node.dataset.i18nParams || "{}");
  } catch (_error) {
    params = {};
  }
  node.textContent = uiText(key, params);
}

async function initializeUiLocale() {
  await globalThis.QCI18n?.initialize?.(document);
  renderSource();
}

async function setUiLocale(preference) {
  if (!globalThis.QCI18n?.set) return "zh-CN";
  const locale = await globalThis.QCI18n.set(preference, document);
  const knowledgeInteractions = snapshotAdvancedKnowledgeInteractions();
  refreshLocalizedNode($("status"));
  refreshLocalizedNode($("settingsStatus"));
  renderSource();
  renderQuickStart();
  renderQuickStartEvidenceChrome();
  renderKnowledgeRecords(state.knowledgeRecords || {});
  renderClaimReviewQueue(state.claimReviewQueue || []);
  restoreAdvancedKnowledgeInteractions(knowledgeInteractions);
  updateAdvancedLanguageNotice();
  return locale;
}

function replayInteractionKey(button) {
  const replayId = String(button?.dataset?.evidenceReplayId || "");
  const scope = String(button?.dataset?.replayScope || "evidence");
  return replayId ? `${scope}:${replayId}` : "";
}

function snapshotAdvancedKnowledgeInteractions() {
  const claimDrafts = {};
  for (const node of document.querySelectorAll?.("[data-claim-edit-text]") || []) {
    const claimId = String(node?.dataset?.claimEditText || "");
    if (claimId) claimDrafts[claimId] = String(node.value ?? "");
  }
  const selectedKnowledgeClaims = [...(document.querySelectorAll?.("[data-claim-select]") || [])]
    .filter((node) => node.checked)
    .map((node) => String(node.value || ""))
    .filter(Boolean);
  const selectedWorkbenchClaims = [...(document.querySelectorAll?.("[data-claim-workbench-select]") || [])]
    .filter((node) => node.checked)
    .map((node) => String(node.value || ""))
    .filter(Boolean);
  const expandedReplays = {};
  for (const button of document.querySelectorAll?.("[data-evidence-replay-id]") || []) {
    const expanded = String(button.getAttribute?.("aria-expanded") ?? button["aria-expanded"] ?? "false") === "true";
    const key = replayInteractionKey(button);
    if (!expanded || !key) continue;
    const panelId = String(button.getAttribute?.("aria-controls") ?? button["aria-controls"] ?? "");
    const panel = panelId ? document.getElementById?.(panelId) : null;
    expandedReplays[key] = {
      contextScrollTop: Number(panel?.querySelector?.("[data-replay-context]")?.scrollTop || 0),
      storedQuoteScrollTop: Number(panel?.querySelector?.("[data-replay-stored-quote]")?.scrollTop || 0),
    };
  }
  return { claimDrafts, selectedKnowledgeClaims, selectedWorkbenchClaims, expandedReplays };
}

function restoreAdvancedKnowledgeInteractions(snapshot = {}) {
  const drafts = snapshot.claimDrafts || {};
  for (const node of document.querySelectorAll?.("[data-claim-edit-text]") || []) {
    const claimId = String(node?.dataset?.claimEditText || "");
    if (Object.prototype.hasOwnProperty.call(drafts, claimId)) node.value = drafts[claimId];
  }
  const selectedKnowledgeClaims = new Set(snapshot.selectedKnowledgeClaims || []);
  for (const node of document.querySelectorAll?.("[data-claim-select]") || []) {
    node.checked = selectedKnowledgeClaims.has(String(node.value || ""));
  }
  const selectedWorkbenchClaims = new Set(snapshot.selectedWorkbenchClaims || []);
  for (const node of document.querySelectorAll?.("[data-claim-workbench-select]") || []) {
    node.checked = selectedWorkbenchClaims.has(String(node.value || ""));
  }
  const expandedReplays = snapshot.expandedReplays || {};
  for (const button of document.querySelectorAll?.("[data-evidence-replay-id]") || []) {
    const state = expandedReplays[replayInteractionKey(button)];
    if (!state) continue;
    button.setAttribute?.("aria-expanded", "true");
    if (!button.setAttribute) button["aria-expanded"] = "true";
    const panelId = String(button.getAttribute?.("aria-controls") ?? button["aria-controls"] ?? "");
    const panel = panelId ? document.getElementById?.(panelId) : null;
    if (!panel) continue;
    panel.hidden = false;
    const context = panel.querySelector?.("[data-replay-context]");
    const storedQuote = panel.querySelector?.("[data-replay-stored-quote]");
    if (context) context.scrollTop = Number(state.contextScrollTop || 0);
    if (storedQuote) storedQuote.scrollTop = Number(state.storedQuoteScrollTop || 0);
  }
}

function updateAdvancedLanguageNotice(activeTabId = "") {
  const notice = $("advancedLanguageNotice");
  if (!notice) return;
  const tabId = activeTabId || document.querySelector?.(".tab.active")?.dataset?.tab || "chat";
  const advancedTabs = new Set(["batch", "agents", "deliverables"]);
  notice.hidden = globalThis.QCI18n?.get?.() !== "en" || !advancedTabs.has(tabId);
}

function sourceFingerprint(source) {
  const text = String(source?.text || "");
  return [
    source?.projectId || currentProjectId(),
    source?.kind || "",
    normalizeUrl(source?.url || ""),
    source?.title || "",
    text.length,
    stableTextDigest(text)
  ].join("\n---\n");
}

function stableTextDigest(text) {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const value = text.charCodeAt(index);
    left = Math.imul(left ^ value, 0x01000193) >>> 0;
    right = Math.imul(right ^ (value + index), 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

function markCurrentSourceFingerprint() {
  if (state.source) {
    const fingerprint = sourceFingerprint(state.source);
    if (state.lastAnswer && state.lastAnswerSourceFingerprint !== fingerprint) {
      state.lastAnswer = "";
      state.lastAnswerSourceFingerprint = "";
      const answers = $("answers");
      if (answers) answers.textContent = "";
    }
    state.source.sourceFingerprint = fingerprint;
  }
}

function currentProjectId() {
  return state.settings?.projectId || "default";
}

function currentSourceProjectId() {
  return String(state.source?.projectId || state.source?.project_id || "").trim();
}

function assertCurrentSourceProject() {
  if (!state.source) return;
  const projectId = currentProjectId();
  const sourceProjectId = currentSourceProjectId();
  if (!sourceProjectId) {
    state.source.projectId = projectId;
    return;
  }
  if (sourceProjectId !== projectId) {
    throw new Error(`当前来源属于项目 ${sourceProjectId}，不能写入当前项目 ${projectId}；请重新读取来源。`);
  }
}

function resetCurrentSourceAfterProjectChange(previousProjectId, nextProjectId) {
  if (previousProjectId === nextProjectId) return false;
  clearProjectBoundKnowledgeViews();
  if (state.source) {
    state.source = null;
    state.lastAnswer = "";
    state.lastAnswerSourceFingerprint = "";
    state.currentSourceDetailId = "";
    state.currentSourceDetail = null;
    state.sourceDiffs = {};
    $("answers").textContent = "";
    renderSource();
  }
  hideQuickStartEvidence();
  state.onboardingDecisionVerified = false;
  renderQuickStart();
  setStatus(`已切换到项目 ${nextProjectId}；请重新读取该项目的来源。`);
  return true;
}

function clearProjectBoundKnowledgeViews() {
  state.projectViewGeneration += 1;
  state.knowledgeRecords = {};
  state.claimReviewQueue = [];
  for (const id of ["knowledgeRecordList", "claimReviewList"]) {
    const node = $(id);
    if (!node) continue;
    node.replaceChildren?.();
    node.textContent = "";
    node.innerHTML = "";
    if (Array.isArray(node.children)) node.children.length = 0;
  }
}

function queryWithProject(params = {}) {
  const query = new URLSearchParams({ ...params, project_id: currentProjectId() });
  return `?${query.toString()}`;
}

init();

function setSidepanelInteractiveReady(isReady) {
  const ready = Boolean(isReady);
  if (document.documentElement) {
    document.documentElement.dataset.qcInteractiveReady = String(ready);
  }
  if (document.body) {
    document.body.inert = !ready;
    document.body.setAttribute("aria-busy", String(!ready));
  }
}

async function init() {
  let interactionHandlersBound = false;
  let hydrateWorkspaces = false;
  try {
    configureCompanionReleaseLinks();
    let localeError = null;
    try {
      await initializeUiLocale();
    } catch (error) {
      localeError = error;
    }
    bindTabs();
    bindEvents();
    interactionHandlersBound = true;
    renderAgents();
    if (localeError) throw localeError;
    await loadOnboardingMilestones();
    await loadSettings();
    bindPendingSelectionMessages();
    await queuePendingSelectionHydration({ automatic: true });
    if (!state.settings?.pairingToken) {
      showTab("settings");
      setLocalizedSettingsStatus(
        "settings.status.notPaired",
        {},
        "尚未完成配对。请按上方 3 步首次使用指引连接本地服务。"
      );
      await loadBatchQueue();
      return;
    }
    const startup = await authenticateCompanionForStartup();
    await loadBatchQueue();
    if (!startup) {
      return;
    }
    hydrateWorkspaces = true;
  } catch (error) {
    if (!interactionHandlersBound) throw error;
    console.warn("Essential side-panel startup failed.", error);
    showTab("settings");
    setLocalizedSettingsStatus(
      "settings.status.startupFailed",
      { error: errorI18nParam(error) },
      `启动未完成：${error.message}。设置仍可操作；修正问题后请重新打开侧边栏。`
    );
  } finally {
    if (interactionHandlersBound) setSidepanelInteractiveReady(true);
  }
  if (hydrateWorkspaces) await hydrateStartupWorkspaces();
}

async function hydrateStartupWorkspaces() {
  const hydrations = [
    async () => {
      if (await loadProjectDashboard({ quiet: true })) setProjectStatus("");
    },
    loadProjectBrief,
    loadCapturePlans,
    refreshKnowledgeWorkspace,
    loadTopicPackages,
    loadDeliverables,
    loadStrategyWorkspace
  ];
  for (const hydrate of hydrations) {
    try {
      await hydrate();
    } catch (error) {
      console.warn("Optional workspace hydration failed.", error);
    }
  }
}

async function authenticateCompanionForStartup() {
  try {
    const health = await companionRequest("/health", { method: "GET" });
    assertCompatibleCompanion(health);
    const projectsResponse = await companionRequest("/v1/projects", { method: "GET" });
    state.projects = projectsResponse.projects || [];
    renderProjectSelect();
    await markOnboardingMilestone("pairedAt");
    renderQuickStart({ restored: true });
    return { health, projects: state.projects };
  } catch (error) {
    const card = $("quickStartCard");
    if (card) card.hidden = true;
    showTab("settings");
    const invalidToken = /missing x-qc-pairing-token|invalid pairing token|HTTP 401|HTTP 403/i.test(error.message);
    setLocalizedSettingsStatus(
      invalidToken ? "settings.status.staleToken" : "settings.status.notReady",
      { error: errorI18nParam(error) },
      invalidToken
        ? `Pairing Token 已失效或不正确：${error.message}`
        : `本地服务尚未就绪：${error.message}`
    );
    return null;
  }
}

function bindTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      tabs.forEach((item) => {
        item.classList.remove("active");
        item.setAttribute("aria-selected", "false");
        item.tabIndex = -1;
      });
      document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      tab.tabIndex = 0;
      $(tab.dataset.tab).classList.add("active");
      updateAdvancedLanguageNotice(tab.dataset.tab);
    });
    tab.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      tabs[nextIndex].click();
      tabs[nextIndex].focus();
    });
  });
  updateAdvancedLanguageNotice(tabs.find((tab) => tab.classList.contains("active"))?.dataset?.tab || "chat");
}

function renderAgents() {
  const list = $("agentList");
  const template = $("agentTemplate");
  list.textContent = "";

  for (const agent of DEFAULT_AGENTS) {
    const node = template.content.cloneNode(true);
    const label = node.querySelector("label");
    const input = node.querySelector("input");
    input.value = agent.id;
    input.checked = true;
    label.dataset.agentId = agent.id;
    node.querySelector(".agent-icon").textContent = agent.icon;
    node.querySelector("strong").textContent = agent.name;
    node.querySelector("small").textContent = agent.description;
    list.appendChild(node);
  }

  $("customSystemPrompt").value = DEFAULT_SYSTEM_PROMPT;
}

function bindEvents() {
  $("uiLocaleSelect")?.addEventListener("change", (event) => {
    setUiLocale(event.currentTarget?.value || event.target?.value || "auto").catch((error) => {
      console.warn("UI locale could not be updated.", error);
    });
  });
  $("readPageBtn").addEventListener("click", readCurrentPage);
  $("quickStartBtn").addEventListener("click", runQuickStart);
  $("quickStartAcceptClaimBtn").addEventListener("click", acceptQuickStartClaim);
  $("quickStartRejectClaimBtn").addEventListener("click", rejectQuickStartClaim);
  $("quickStartReplayBtn").addEventListener("click", () => {
    toggleReplayPanel($("quickStartReplayBtn"), $("quickStartReplayPanel"));
  });
  $("useSelectionBtn").addEventListener("click", readSelectedTextFromPage);
  $("readSelectorBtn").addEventListener("click", readManualSelectorFromPage);
  $("enqueueNextPagesBtn").addEventListener("click", createNextPageCapturePlans);
  $("askBtn").addEventListener("click", askAgents);
  $("clearBtn").addEventListener("click", () => {
    $("answers").textContent = "";
    state.lastAnswer = "";
    state.lastAnswerSourceFingerprint = "";
    setStatus("");
  });
  $("saveNoteBtn").addEventListener("click", saveCurrentNote);
  $("saveSettingsBtn").addEventListener("click", () => saveSettings().catch(() => {}));
  $("testSettingsBtn").addEventListener("click", testSettings);
  $("clearApiKeyBtn").addEventListener("click", clearServiceApiKey);
  $("testCompanionBtn").addEventListener("click", testCompanion);
  $("providerSelect").addEventListener("change", syncProviderControls);
  $("modelDataConsentInput").addEventListener("change", persistModelDataConsent);
  $("runVaultDoctorBtn").addEventListener("click", runVaultDoctor);
  $("rebuildLineageBtn").addEventListener("click", rebuildLineage);
  $("projectSelect").addEventListener("change", changeProject);
  $("refreshProjectsBtn").addEventListener("click", loadProjects);
  $("createProjectBtn").addEventListener("click", createProject);
  $("refreshProjectBriefBtn").addEventListener("click", loadProjectBrief);
  $("saveProjectBriefBtn").addEventListener("click", saveProjectBrief);
  $("discoverCurrentPageLinksBtn").addEventListener("click", discoverCurrentPageLinksToCapturePlans);
  $("createCapturePlansBtn").addEventListener("click", createCapturePlans);
  $("refreshCapturePlansBtn").addEventListener("click", loadCapturePlans);
  $("enqueueApprovedPlansBtn").addEventListener("click", enqueueApprovedCapturePlans);
  $("refreshKbBtn").addEventListener("click", refreshKnowledgeWorkspace);
  $("syncPendingNotesBtn").addEventListener("click", syncPendingNotes);
  $("refreshReviewQueueBtn").addEventListener("click", loadReviewQueue);
  $("sourceStatusFilter").addEventListener("change", loadSourceLibrary);
  $("searchSourcesBtn").addEventListener("click", searchSourcesAndChunks);
  $("clearSourceSearchBtn").addEventListener("click", clearSourceSearch);
  $("sourceSearchInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchSourcesAndChunks();
    }
  });
  $("enqueueBatchBtn").addEventListener("click", enqueueBatchUrls);
  $("addOpenTabsBtn").addEventListener("click", addOpenTabsToBatch);
  $("restoreBatchBtn").addEventListener("click", restoreBatchFromCompanion);
  $("processBatchBtn").addEventListener("click", processBatchQueue);
  $("batchConcurrencyInput").addEventListener("change", updateBatchConcurrency);
  $("pauseBatchBtn").addEventListener("click", pauseBatchQueue);
  $("cancelBatchBtn").addEventListener("click", cancelBatchQueue);
  $("clearCompletedBatchBtn").addEventListener("click", clearCompletedBatchItems);
  $("clearBatchBtn").addEventListener("click", clearBatchQueue);
  $("ingestPdfBtn").addEventListener("click", ingestPdf);
  $("ingestYoutubeBtn").addEventListener("click", ingestYoutubeTranscript);
  $("pdfOcrInput").addEventListener("change", syncPdfImportMode);
  $("youtubeTranscriptInput").addEventListener("input", syncYoutubeImportMode);
  $("youtubeLanguageInput").addEventListener("input", syncYoutubeImportMode);
  syncPdfImportMode();
  syncYoutubeImportMode();
  $("exportMarkdownBtn").addEventListener("click", () => exportKnowledgeBase("markdown"));
  $("exportJsonBtn").addEventListener("click", () => exportKnowledgeBase("json"));
  $("clearKbBtn").addEventListener("click", clearKnowledgeBase);
  $("createDeliverableBtn").addEventListener("click", createDeliverableFromCurrentSource);
  $("refreshDeliverablesBtn").addEventListener("click", loadDeliverables);
  $("refreshTopicPackagesBtn").addEventListener("click", loadTopicPackages);
  $("strategyHandoffSelect").addEventListener("change", renderSelectedStrategyWorkspace);
  $("refreshStrategyTicketsBtn").addEventListener("click", loadStrategyWorkspace);
  $("generateStrategyTicketsBtn").addEventListener("click", generateStrategyTickets);
  $("refreshStrategyFeedbackBtn").addEventListener("click", loadStrategyWorkspace);
  $("importBacktestResultBtn").addEventListener("click", importBacktestResult);
  $("strategyReviewGateSelect").addEventListener("change", renderStrategyReviewChecklist);
  $("createStrategyReviewBtn").addEventListener("click", createStrategyReview);
  $("extractKnowledgeBtn").addEventListener("click", extractKnowledgeFromCurrentSource);
  $("createLearningPackBtn").addEventListener("click", createLearningPackFromCurrentSource);
  $("createTopicPackageBtn").addEventListener("click", createTopicPackageFromSelectedClaims);
  $("refreshKnowledgeRecordsBtn").addEventListener("click", loadKnowledgeRecords);
  $("refreshLearningItemsBtn").addEventListener("click", loadLearningItems);
  $("refreshClaimReviewQueueBtn").addEventListener("click", loadClaimReviewQueue);
  $("claimReviewStatusFilter").addEventListener("change", loadClaimReviewQueue);
  $("claimReviewQuoteFilter").addEventListener("change", loadClaimReviewQueue);
  $("claimReviewStrengthFilter").addEventListener("change", loadClaimReviewQueue);
  $("claimReviewSourceFilter").addEventListener("change", loadClaimReviewQueue);
  $("claimReviewTopicFilter").addEventListener("change", loadClaimReviewQueue);
  $("batchAcceptClaimsBtn").addEventListener("click", () => reviewSelectedClaims("reviewed"));
  $("batchPendingClaimsBtn").addEventListener("click", () => reviewSelectedClaims("pending_validation"));
  $("batchRejectClaimsBtn").addEventListener("click", () => reviewSelectedClaims("rejected"));
  $("mergeSelectedClaimsBtn").addEventListener("click", mergeSelectedClaims);
  $("splitSelectedClaimBtn").addEventListener("click", splitSelectedClaim);
}

function bindPendingSelectionMessages() {
  if (pendingSelectionMessagesBound || !chrome.runtime?.onMessage?.addListener) return;
  pendingSelectionMessagesBound = true;
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== SELECTION_QUEUED_MESSAGE) return false;
    queuePendingSelectionHydration({
      automatic: true,
      selectionId: message.selectionId || "",
      noticeId: message.noticeId || "",
      expectedTabId: message.tabId,
      expectedWindowId: message.windowId
    }).catch((error) => {
      console.warn("Pending selection live delivery failed.", error);
    });
    return false;
  });
}

function queuePendingSelectionHydration(options = {}) {
  const consume = () => hydratePendingSelection(options);
  const current = pendingSelectionConsumption.then(consume, consume);
  pendingSelectionConsumption = current.catch(() => false);
  return current;
}

function integerChromeId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function currentSidePanelTarget() {
  let windowId = null;
  let tab = null;
  try {
    if (chrome.windows?.getCurrent) {
      const currentWindow = await chrome.windows.getCurrent();
      windowId = integerChromeId(currentWindow?.id);
    }
  } catch (_error) {
    // The active tab below still gives us a reliable target on older Chrome versions.
  }
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_error) {
    tab = null;
  }
  return {
    tabId: integerChromeId(tab?.id),
    windowId: windowId ?? integerChromeId(tab?.windowId)
  };
}

function notificationTargetsCurrentPanel(options, target) {
  const expectedTabId = integerChromeId(options.expectedTabId);
  const expectedWindowId = integerChromeId(options.expectedWindowId);
  if (expectedTabId !== null && target.tabId !== null && expectedTabId === target.tabId) return true;
  if (expectedWindowId !== null && target.windowId !== null && expectedWindowId === target.windowId) return true;
  return expectedTabId === null && expectedWindowId === null;
}

async function hydratePendingSelection(options = {}) {
  await ensureSettingsLoaded();
  if (state.busy && !options.automatic) {
    setLocalizedStatus("currentPage.pending.busy");
    return false;
  }
  const target = await currentSidePanelTarget();
  const targetsThisPanel = notificationTargetsCurrentPanel(options, target);
  if (options.automatic && state.source) {
    if (targetsThisPanel) {
      setLocalizedStatus("currentPage.pending.deferred");
    }
    return false;
  }
  if (options.automatic && !targetsThisPanel) return false;

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: CLAIM_SELECTION_MESSAGE,
      selectionId: options.selectionId || "",
      noticeId: options.noticeId || "",
      tabId: target.tabId,
      windowId: target.windowId,
      projectId: currentProjectId()
    });
  } catch (error) {
    console.warn("Pending selection claim failed.", error);
    if (!options.automatic) {
      setLocalizedStatus("currentPage.pending.failed", { error: errorI18nParam(error) });
    }
    return false;
  }
  if (!response?.ok) {
    if (!options.automatic) {
      setLocalizedStatus("currentPage.pending.failed", {
        error: response?.error || { i18nKey: "currentPage.pending.noResponse" }
      });
    }
    return false;
  }
  if (!response.selection) {
    if (response.reason === "queue_full") {
      setLocalizedStatus("currentPage.pending.queueFull", {
        count: Number(response.pendingCount || 20)
      });
    }
    if (response.reason === "project_mismatch") {
      setLocalizedStatus("currentPage.pending.projectMismatch", {
        projectId: response.selectionProjectId || { i18nKey: "status.unknown" }
      });
    }
    return false;
  }

  const pending = response.selection;
  const pendingProjectId = String(pending.projectId || currentProjectId()).trim() || currentProjectId();
  if (pendingProjectId !== currentProjectId()) {
    setLocalizedStatus("currentPage.pending.cannotLoadProject", {
      selectionProjectId: pendingProjectId,
      currentProjectId: currentProjectId()
    });
    return false;
  }
  const fallbackTitleKey = "currentPage.selection.defaultTitle";
  state.source = {
    title: pending.title || uiText(fallbackTitleKey, {}, "选中文本"),
    titleI18nKey: pending.title ? "" : fallbackTitleKey,
    projectId: pendingProjectId,
    url: pending.url || "",
    text: pending.text,
    kind: "selection",
    site: inferSiteFromUrl(pending.url || ""),
    stats: { profile: "selection", textChars: countCjkAwareChars(pending.text), quality: 30 },
    capturedAt: pending.capturedAt || new Date().toISOString()
  };
  markCurrentSourceFingerprint();
  renderSource();
  setLocalizedStatus("currentPage.pending.loaded");
  return true;
}

async function readSelectedTextFromPage() {
  const loadedFromMenu = await hydratePendingSelection();
  if (loadedFromMenu) return;

  setBusy(true);
  setLocalizedStatus("currentPage.selection.loading");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw localizedError("currentPage.error.noTab", "没有找到当前标签页。");
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => String(window.getSelection?.() || "").trim()
    });

    if (!result) {
      setLocalizedStatus("currentPage.selection.none");
      return;
    }

    const fallbackTitleKey = "currentPage.selection.defaultTitle";
    state.source = {
      title: tab.title || uiText(fallbackTitleKey, {}, "选中文本"),
      titleI18nKey: tab.title ? "" : fallbackTitleKey,
      projectId: currentProjectId(),
      url: tab.url || "",
      text: result,
      kind: "selection",
      site: inferSiteFromUrl(tab.url || ""),
      stats: { profile: "selection", textChars: countCjkAwareChars(result), quality: 30 },
      capturedAt: new Date().toISOString()
    };
    markCurrentSourceFingerprint();
    renderSource();
    setLocalizedStatus("currentPage.selection.success", {
      count: countCjkAwareChars(result)
    });
  } catch (error) {
    setLocalizedStatus("currentPage.selection.failed", {
      error: errorI18nParam(error)
    });
  } finally {
    setBusy(false);
  }
}

async function readCurrentPage(options = {}) {
  setBusy(true);
  setLocalizedStatus("currentPage.status.reading");
  try {
    const capture = await readAndPersistCurrentPage();
    setLocalizedStatus("currentPage.status.saved", {
      count: countCjkAwareChars(state.source.text),
      sourceId: capture.source.id
    });
    return capture;
  } catch (error) {
    const key = error?.pageWasRead && state.source?.text?.trim()
      ? "currentPage.status.readNotSaved"
      : "currentPage.status.failed";
    setLocalizedStatus(key, {
      count: countCjkAwareChars(state.source?.text || ""),
      error: errorI18nParam(error)
    });
    if (options?.throwOnError) throw error;
    return null;
  } finally {
    setBusy(false);
  }
}

function sourceRequiresAuthentication(source = {}) {
  const flags = source.quality_flags || source.qualityFlags || {};
  return Boolean(
    source.stats?.authRequired
      || source.stats?.auth_required
      || flags.authRequired
      || flags.auth_required
  );
}

async function readAndPersistCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw localizedError("currentPage.error.noTab", "没有找到当前标签页。");

  const extracted = await extractFromTab(tab.id, tab);
  state.source = {
    ...extracted,
    projectId: currentProjectId()
  };
  markCurrentSourceFingerprint();
  renderSource();
  if (sourceRequiresAuthentication(state.source)) {
    throw localizedError(
      "currentPage.error.authRequired",
      "页面需要登录或权限，无法采集正文。"
    );
  }
  if (!state.source.text.trim()) {
    throw localizedError(
      "currentPage.error.noBody",
      "没有抽取到正文。PDF 页面可以先选中文本后右键发送。"
    );
  }

  let capture;
  try {
    capture = await ensureCurrentSourceCaptured();
  } catch (error) {
    error.pageWasRead = true;
    throw error;
  }
  await markOnboardingMilestone("capturedAt", {
    lastSourceId: capture.source.id,
    projectId: currentProjectId()
  });
  return capture;
}

async function loadOnboardingMilestones() {
  const stored = await chrome.storage.local.get(ONBOARDING_MILESTONES_KEY);
  const value = stored?.[ONBOARDING_MILESTONES_KEY];
  state.onboardingMilestones = value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
  state.onboardingDecisionVerified = false;
  return state.onboardingMilestones;
}

async function markOnboardingMilestone(field, metadata = {}) {
  if (!field) return state.onboardingMilestones;
  const previous = state.onboardingMilestones && typeof state.onboardingMilestones === "object"
    ? state.onboardingMilestones
    : {};
  const timestamp = previous[field] && field === "pairedAt"
    ? previous[field]
    : new Date().toISOString();
  const next = { ...previous };
  if (field === "capturedAt" || (
    field === "extractedAt"
      && (previous.projectId !== metadata.projectId || previous.lastSourceId !== metadata.lastSourceId)
  )) {
    const downstreamKeys = field === "capturedAt"
      ? [
          "extractedAt",
          "claimReadyAt",
          "firstDecisionAt",
          "firstDecisionStatus",
          "firstReviewedAt",
          "firstClaimId",
          "firstEvidenceId",
          "decisionInvalidatedAt",
          "decisionInvalidatedFromAt",
          "decisionInvalidatedFromStatus",
          "decisionInvalidatedStatus",
          "reviewInvalidatedAt",
          "reviewInvalidatedFromReviewedAt",
          "reviewInvalidatedStatus"
        ]
      : [
          "claimReadyAt",
          "firstDecisionAt",
          "firstDecisionStatus",
          "firstReviewedAt",
          "firstClaimId",
          "firstEvidenceId",
          "decisionInvalidatedAt",
          "decisionInvalidatedFromAt",
          "decisionInvalidatedFromStatus",
          "decisionInvalidatedStatus",
          "reviewInvalidatedAt",
          "reviewInvalidatedFromReviewedAt",
          "reviewInvalidatedStatus"
        ];
    for (const key of downstreamKeys) {
      delete next[key];
    }
    state.onboardingDecisionVerified = false;
  }
  if (field === "firstDecisionAt" || field === "firstReviewedAt") {
    delete next.decisionInvalidatedAt;
    delete next.decisionInvalidatedFromAt;
    delete next.decisionInvalidatedFromStatus;
    delete next.decisionInvalidatedStatus;
    delete next.reviewInvalidatedAt;
    delete next.reviewInvalidatedFromReviewedAt;
    delete next.reviewInvalidatedStatus;
  }
  if (field === "firstDecisionAt" && metadata.firstDecisionStatus === "rejected") {
    delete next.firstReviewedAt;
  }
  state.onboardingMilestones = {
    ...next,
    ...metadata,
    [field]: timestamp
  };
  await chrome.storage.local.set({ [ONBOARDING_MILESTONES_KEY]: state.onboardingMilestones });
  renderQuickStart();
  return state.onboardingMilestones;
}

function quickStartDecisionStatus(milestones = state.onboardingMilestones || {}) {
  const status = String(milestones.firstDecisionStatus || "").trim();
  if ((status === "reviewed" || status === "rejected") && milestones.firstDecisionAt) {
    return status;
  }
  return milestones.firstReviewedAt ? "reviewed" : "";
}

function migrateLegacyQuickStartDecisionMilestone(milestones) {
  if (
    !milestones?.firstReviewedAt
      || milestones.firstDecisionAt
      || milestones.firstDecisionStatus
  ) {
    return milestones;
  }
  const migrated = {
    ...milestones,
    firstDecisionAt: milestones.firstReviewedAt,
    firstDecisionStatus: "reviewed"
  };
  state.onboardingMilestones = migrated;
  chrome.storage.local.set({ [ONBOARDING_MILESTONES_KEY]: migrated }).catch((error) => {
    console.warn("Legacy Quick Start decision milestone could not be migrated.", error);
  });
  return migrated;
}

function renderQuickStart(options = {}) {
  const card = $("quickStartCard");
  if (!card) return;
  const milestones = state.onboardingMilestones || {};
  const paired = Boolean(milestones.pairedAt && state.settings?.pairingToken);
  const projectMatches = milestones.projectId === currentProjectId();
  const decisionStatus = quickStartDecisionStatus(milestones);
  const decisionAndVerified = Boolean(
    projectMatches && decisionStatus && state.onboardingDecisionVerified
  );
  card.hidden = !paired;
  if (!paired) return;

  const steps = [
    ["quickStartPairStep", Boolean(milestones.pairedAt)],
    ["quickStartCaptureStep", Boolean(projectMatches && milestones.capturedAt)],
    ["quickStartReviewStep", decisionAndVerified]
  ];
  const completed = steps.filter(([, done]) => done).length;
  for (const [id, done] of steps) {
    const node = $(id);
    node?.classList?.toggle?.("done", done);
  }

  const progress = $("quickStartProgress");
  if (progress) {
    progress.textContent = `${completed} / ${steps.length}`;
    progress.classList?.toggle?.("done", completed === steps.length);
    progress.classList?.toggle?.("in-progress", completed !== steps.length);
  }
  const button = $("quickStartBtn");
  if (button) {
    const buttonKey = decisionAndVerified
      ? "quickStart.button.again"
      : projectMatches && milestones.claimReadyAt
        ? "quickStart.button.another"
        : projectMatches && milestones.capturedAt
          ? "quickStart.button.continue"
          : "quickStart.button.first";
    setLocalizedNodeText(button, buttonKey);
  }
  const status = $("quickStartStatus");
  if (status && options.restored) {
    let stepKey = "quickStart.restore.paired";
    let stepParams = {};
    if (decisionAndVerified) {
      stepKey = decisionStatus === "rejected"
        ? "quickStart.restore.rejected"
        : "quickStart.restore.reviewed";
    } else if (projectMatches && (milestones.decisionInvalidatedAt || milestones.reviewInvalidatedAt)) {
      stepKey = "quickStart.restore.invalidated";
      stepParams = {
        status: milestones.decisionInvalidatedStatus
          || milestones.reviewInvalidatedStatus
          || uiText("status.unknown", {}, "待验证")
      };
    } else if (projectMatches && milestones.claimReadyAt) {
      stepKey = "quickStart.restore.evidence";
    } else if (projectMatches && milestones.extractedAt) {
      stepKey = "quickStart.restore.extracted";
    } else if (projectMatches && milestones.capturedAt) {
      stepKey = "quickStart.restore.captured";
    }
    setLocalizedNodeText(status, "quickStart.restore.prefix", {
      step: { i18nKey: stepKey, params: stepParams }
    });
  }
}

function firstQuoteBackedClaim(records) {
  const claims = Array.isArray(records?.claims) ? records.claims : [];
  const evidenceRows = Array.isArray(records?.evidence) ? records.evidence : [];
  for (const claim of claims) {
    const evidence = evidenceRows.find((item) => (
      item.claim_id === claim.id && String(item.quote || "").trim()
    ));
    if (evidence) return { claim, evidence };
  }
  return null;
}

function replayValuePresent(value) {
  return value !== null && value !== undefined && String(value) !== "";
}

function replayRangeLabel(single, start, end, formatter = (value) => String(value)) {
  if (replayValuePresent(single)) return formatter(single);
  if (!replayValuePresent(start) && !replayValuePresent(end)) return "";
  const left = replayValuePresent(start) ? formatter(start) : formatter(end);
  const right = replayValuePresent(end) ? formatter(end) : left;
  return left === right ? left : `${left}–${right}`;
}

function replayTimestampLabel(value) {
  if (!replayValuePresent(value)) return "";
  const raw = String(value);
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) return raw;
  const number = Number(value);
  return Number.isFinite(number) ? formatTimestamp(number) : raw;
}

function replayKindKey(sourceKind, locatorType) {
  const normalized = String(sourceKind || "").toLowerCase();
  if (["pdf", "paper"].includes(normalized) || locatorType === "page") return "pdf";
  if (["thread", "forum", "post"].includes(normalized) || locatorType === "floor") return "thread";
  if (["video", "youtube", "transcript"].includes(normalized) || locatorType === "timestamp") return "video";
  if (["page", "web", "html", "article"].includes(normalized)) return "page";
  return "source";
}

function replayLocatorLabel(replay) {
  const locator = replay?.locator && typeof replay.locator === "object" ? replay.locator : {};
  const source = replay?.source && typeof replay.source === "object" ? replay.source : {};
  const type = String(locator.type || "").toLowerCase();
  const segments = [uiText(`replay.kind.${replayKindKey(source.kind, type)}`)];
  const page = replayRangeLabel(locator.page, locator.page_start, locator.page_end);
  const floor = replayValuePresent(locator.floor) ? String(locator.floor) : "";
  const timestamp = replayRangeLabel(
    locator.timestamp,
    locator.timestamp_start,
    locator.timestamp_end,
    replayTimestampLabel
  );
  const numericChunkIndex = Number(locator.chunk_index);
  const chunk = replayValuePresent(locator.chunk_index)
    ? Number.isInteger(numericChunkIndex) && numericChunkIndex >= 0
      ? String(numericChunkIndex + 1)
      : String(locator.chunk_index)
    : replayValuePresent(locator.chunk_id)
      ? String(locator.chunk_id)
      : "";
  if (page) segments.push(uiText("replay.locator.page", { value: page }));
  if (floor) segments.push(uiText("replay.locator.floor", { value: floor }));
  if (timestamp) segments.push(uiText("replay.locator.timestamp", { value: timestamp }));
  if (chunk) segments.push(uiText("replay.locator.chunk", { value: chunk }));
  if (segments.length === 1 && locator.label) segments.push(String(locator.label));
  return segments.filter(Boolean).join(" · ");
}

function replayActionAriaLabel(replay) {
  const source = replay?.source && typeof replay.source === "object" ? replay.source : {};
  const sourceLabel = String(source.title || source.site || uiText("replay.source.unknown"));
  const locatorLabel = replayLocatorLabel(replay) || uiText("replay.locator.unknown");
  return uiText("replay.actionLabel", { source: sourceLabel, locator: locatorLabel });
}

function replayExactQuoteRange(replay) {
  const quote = String(replay?.quote?.text ?? "");
  const context = String(replay?.context?.text ?? "");
  const start = Number(replay?.context?.quote_start_offset);
  const end = Number(replay?.context?.quote_end_offset);
  if (
    !quote
      || !Number.isInteger(start)
      || !Number.isInteger(end)
      || start < 0
      || end < start
      || end > context.length
      || context.slice(start, end) !== quote
  ) {
    return null;
  }
  return { context, quote, start, end };
}

function replayPresentation(replay) {
  const rawStatus = String(replay?.status || "unresolved").toLowerCase();
  const status = ["resolved", "stale", "unresolved"].includes(rawStatus) ? rawStatus : "unresolved";
  const exactRange = replayExactQuoteRange(replay);
  if ((status === "resolved" || status === "stale") && !exactRange) {
    return { status: "unresolved", reason: "context_offset_mismatch", exactRange: null };
  }
  return { status, reason: String(replay?.reason || ""), exactRange };
}

function safeReplaySourceUrl(replay) {
  const rawCandidate = String(replay?.source?.open_url || "");
  if (/[\u0000-\u001F\u007F]/.test(rawCandidate)) return "";
  const candidate = rawCandidate.trim();
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (url.username || url.password) return "";
    return url.href;
  } catch (_error) {
    return "";
  }
}

function renderReplayPanelMarkup(replay) {
  const presentation = replayPresentation(replay);
  const source = replay?.source && typeof replay.source === "object" ? replay.source : {};
  const locator = replay?.locator && typeof replay.locator === "object" ? replay.locator : {};
  const projectMismatch = presentation.reason === "project_mismatch";
  const quote = projectMismatch ? "" : String(replay?.quote?.text ?? "");
  const context = projectMismatch ? "" : String(replay?.context?.text ?? "");
  const sourceUrl = projectMismatch ? "" : safeReplaySourceUrl(replay);
  const sourceMeta = projectMismatch ? [] : [
    source.captured_at
      ? uiText("replay.source.captured", { value: source.captured_at })
      : "",
    replayValuePresent(source.version_index)
      ? uiText("replay.source.version", { value: `v${source.version_index}` })
      : "",
    source.content_hash
      ? uiText("replay.source.hash", { value: source.content_hash })
      : "",
    source.is_current === true
      ? uiText("replay.source.current")
      : source.is_current === false && source.current_source_id
        ? uiText("replay.source.superseded", { sourceId: source.current_source_id })
        : ""
  ].filter(Boolean);
  const locatorLabel = projectMismatch ? "" : replayLocatorLabel(replay);
  const provenance = projectMismatch || !locator.provenance
    ? ""
    : uiText("replay.locator.provenance", { value: locator.provenance });
  let snapshotMarkup = "";
  if (presentation.exactRange && presentation.status !== "unresolved") {
    const { start, end } = presentation.exactRange;
    snapshotMarkup = `
      <div class="replay-snapshot-label">${escapeHtml(uiText("replay.snapshotTitle"))}</div>
      <pre class="replay-context" data-replay-context tabindex="0" aria-label="${escapeHtml(uiText("replay.snapshotTitle"))}">${escapeHtml(context.slice(0, start))}<mark data-replay-exact-quote>${escapeHtml(context.slice(start, end))}</mark>${escapeHtml(context.slice(end))}</pre>
    `;
  } else if (context || quote) {
    snapshotMarkup = `
      ${context ? `<div class="replay-snapshot-label">${escapeHtml(uiText("replay.snapshotTitle"))}</div><pre class="replay-context" data-replay-context tabindex="0" aria-label="${escapeHtml(uiText("replay.snapshotTitle"))}">${escapeHtml(context)}</pre>` : ""}
      ${quote ? `<div class="replay-snapshot-label">${escapeHtml(uiText("replay.storedQuote"))}</div><div class="replay-stored-quote" data-replay-stored-quote tabindex="0" aria-label="${escapeHtml(uiText("replay.storedQuote"))}">${escapeHtml(quote)}</div>` : ""}
    `;
  }
  const reasonKey = `replay.reason.${presentation.reason || "missing_chunk"}`;
  const reason = uiText(reasonKey, {}, presentation.reason || "");
  return `
    <div class="replay-status-row">
      <span class="replay-status ${escapeHtml(presentation.status)}" data-replay-status="${escapeHtml(presentation.status)}">${escapeHtml(uiText(`replay.status.${presentation.status}`))}</span>
      ${locatorLabel ? `<span class="replay-locator" data-replay-locator>${escapeHtml(locatorLabel)}</span>` : ""}
    </div>
    ${!projectMismatch && source.title ? `<strong class="replay-source-title">${escapeHtml(source.title)}</strong>` : ""}
    ${sourceMeta.length ? `<small class="replay-source-meta">${escapeHtml(sourceMeta.join(" · "))}</small>` : ""}
    ${provenance ? `<small class="replay-provenance">${escapeHtml(provenance)}</small>` : ""}
    ${snapshotMarkup}
    ${reason ? `<p class="replay-reason">${escapeHtml(reason)}</p>` : ""}
    ${sourceUrl ? `
      <a class="replay-source-link" data-replay-source-link href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(uiText("replay.source.open"))}</a>
      <p class="replay-source-fallback">${escapeHtml(uiText("replay.source.fallback"))}</p>
    ` : ""}
  `;
}

function replayMatchesEvidence(replay, evidence, options = {}) {
  if (!replay || typeof replay !== "object" || Number(replay.version) !== 1 || !replay.replay_id) return false;
  const projectId = String(options.projectId || evidence?.project_id || "");
  if (projectId && projectId !== currentProjectId()) return false;
  const expected = {
    evidence_id: evidence?.id || options.evidenceId || "",
    claim_id: options.claimId || evidence?.claim_id || "",
    source_id: evidence?.source_id || options.sourceId || ""
  };
  return Object.entries(expected).every(([key, value]) => !value || String(replay[key] || "") === String(value));
}

function replayPanelDomId(replayId, scope = "evidence") {
  const raw = String(replayId || "replay");
  const rawScope = String(scope || "evidence");
  const readableScope = rawScope.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 24) || "evidence";
  const readable = raw.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 36) || "replay";
  return `replay-panel-${readableScope}-${readable}-${stableTextDigest(`${rawScope}:${raw}`)}`;
}

function renderEvidenceReplayControls(evidence, options = {}) {
  const replay = evidence?.replay;
  if (!replayMatchesEvidence(replay, evidence, options)) return "";
  const replayId = String(replay.replay_id);
  const scope = String(options.scope || "evidence");
  const panelId = replayPanelDomId(replayId, scope);
  const actionLabel = replayActionAriaLabel(replay);
  return `
    <div class="replay-container" data-replay-container="${escapeHtml(replayId)}">
      <button
        class="replay-action"
        type="button"
        data-evidence-replay-id="${escapeHtml(replayId)}"
        data-replay-scope="${escapeHtml(scope)}"
        aria-expanded="false"
        aria-controls="${escapeHtml(panelId)}"
        aria-label="${escapeHtml(actionLabel)}"
      >${escapeHtml(uiText("replay.action"))}</button>
      <section
        id="${escapeHtml(panelId)}"
        class="replay-panel"
        data-replay-panel="${escapeHtml(replayId)}"
        aria-label="${escapeHtml(uiText("replay.panelLabel"))}"
        hidden
      >${renderReplayPanelMarkup(replay)}</section>
    </div>
  `;
}

function toggleReplayPanel(button, panel) {
  if (!button || !panel) return false;
  const expanded = String(button.getAttribute?.("aria-expanded") ?? button["aria-expanded"] ?? "false") === "true";
  const nextExpanded = !expanded;
  button.setAttribute?.("aria-expanded", String(nextExpanded));
  if (!button.setAttribute) button["aria-expanded"] = String(nextExpanded);
  panel.hidden = !nextExpanded;
  return nextExpanded;
}

function toggleEvidenceReplay(button, root = document) {
  const replayId = button?.dataset?.evidenceReplayId || "";
  if (!replayId) return false;
  const panels = root?.querySelectorAll?.("[data-replay-panel]") || [];
  const panel = [...panels].find((item) => item.dataset?.replayPanel === replayId);
  return toggleReplayPanel(button, panel);
}

function bindReplayActions(root) {
  for (const button of root?.querySelectorAll?.("[data-evidence-replay-id]") || []) {
    button.addEventListener("click", () => toggleEvidenceReplay(button, root));
  }
}

function renderQuickStartReplay() {
  const card = $("quickStartEvidence");
  const container = $("quickStartReplayContainer");
  const button = $("quickStartReplayBtn");
  const panel = $("quickStartReplayPanel");
  if (!card || !container || !button || !panel) return;
  const replay = state.quickStartReplay;
  const matches = card.dataset.projectId === currentProjectId() && replayMatchesEvidence(
    replay,
    {
      id: card.dataset.evidenceId || "",
      claim_id: card.dataset.claimId || "",
      source_id: card.dataset.sourceId || "",
      project_id: card.dataset.projectId || ""
    },
    { projectId: card.dataset.projectId || "" }
  );
  if (!matches) {
    container.hidden = true;
    button.dataset.replayId = "";
    button.setAttribute?.("aria-expanded", "false");
    button.setAttribute?.("aria-label", uiText("replay.action"));
    panel.dataset.replayPanel = "";
    panel.dataset.replayStatus = "";
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const sameReplay = button.dataset.replayId === replay.replay_id;
  const wasExpanded = sameReplay
    && String(button.getAttribute?.("aria-expanded") ?? button["aria-expanded"] ?? "false") === "true";
  container.hidden = false;
  button.dataset.replayId = replay.replay_id;
  setLocalizedNodeText(button, "replay.action");
  button.setAttribute?.("aria-label", replayActionAriaLabel(replay));
  button.setAttribute?.("aria-expanded", String(wasExpanded));
  panel.dataset.replayPanel = replay.replay_id;
  panel.dataset.replayStatus = replayPresentation(replay).status;
  panel.hidden = !wasExpanded;
  panel.innerHTML = renderReplayPanelMarkup(replay);
}

function revealQuickStartEvidence(claim, evidence, options = {}) {
  const card = $("quickStartEvidence");
  if (!card || !claim || !evidence) return;
  $("quickStartClaimText").textContent = String(claim.text || "");
  $("quickStartQuoteText").textContent = String(evidence.quote || "");
  card.dataset.claimId = claim.id || "";
  card.dataset.evidenceId = evidence.id || "";
  card.dataset.projectId = options.projectId || claim.project_id || currentProjectId();
  card.dataset.claimStatus = claim.status || "";
  card.dataset.sourceId = evidence.source_id || evidence.replay?.source_id || "";
  state.quickStartReplay = evidence.replay && typeof evidence.replay === "object"
    ? evidence.replay
    : null;
  card.hidden = false;
  renderQuickStartEvidenceChrome();
  if (options.focus !== false) {
    card.classList?.remove?.("quick-start-highlight");
    void card.offsetWidth;
    card.classList?.add?.("quick-start-highlight");
    card.focus?.();
    card.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  for (const node of document.querySelectorAll?.("[data-claim-record-id], [data-evidence-record-id]") || []) {
    const matches = node.dataset.claimRecordId === claim.id || node.dataset.evidenceRecordId === evidence.id;
    node.classList?.toggle?.("quick-start-highlight", matches);
  }
}

function renderQuickStartEvidenceChrome() {
  const card = $("quickStartEvidence");
  const acceptButton = $("quickStartAcceptClaimBtn");
  const rejectButton = $("quickStartRejectClaimBtn");
  const reviewStatus = $("quickStartReviewStatus");
  if (!card) return;
  renderQuickStartReplay();
  const claimId = card.dataset?.claimId || "";
  const claimStatus = card.dataset?.claimStatus || "";
  const decisionStatus = quickStartDecisionStatus();
  const hasLocalDecision = Boolean(
    decisionStatus
      && state.onboardingMilestones?.projectId === card.dataset.projectId
      && state.onboardingMilestones?.firstClaimId === claimId
  );
  const hasInvalidatedDecision = Boolean(
    (state.onboardingMilestones?.decisionInvalidatedAt || state.onboardingMilestones?.reviewInvalidatedAt)
      && state.onboardingMilestones?.projectId === card.dataset.projectId
      && state.onboardingMilestones?.firstClaimId === claimId
  );
  const alreadyDecided = hasLocalDecision
    && state.onboardingDecisionVerified
    && claimStatus === decisionStatus;
  if (acceptButton) {
    acceptButton.dataset.claimId = claimId;
    acceptButton.disabled = state.busy || alreadyDecided;
    setLocalizedNodeText(
      acceptButton,
      alreadyDecided && decisionStatus === "reviewed"
        ? "firstEvidence.acceptedButton"
        : "firstEvidence.accept"
    );
  }
  if (rejectButton) {
    rejectButton.dataset.claimId = claimId;
    rejectButton.disabled = state.busy || alreadyDecided;
    setLocalizedNodeText(
      rejectButton,
      alreadyDecided && decisionStatus === "rejected"
        ? "firstEvidence.rejectedButton"
        : "firstEvidence.reject"
    );
  }
  if (reviewStatus) {
    if (alreadyDecided) {
      setLocalizedNodeText(
        reviewStatus,
        decisionStatus === "rejected"
          ? "firstEvidence.review.rejected"
          : "firstEvidence.review.reviewed"
      );
    } else if (hasLocalDecision || hasInvalidatedDecision) {
      setLocalizedNodeText(reviewStatus, "firstEvidence.review.previous", {
        status: claimStatus || uiText("status.unknown", {}, "未知")
      });
    } else {
      setLocalizedNodeText(reviewStatus, "firstEvidence.review.pending");
    }
  }
}

function hideQuickStartEvidence() {
  const card = $("quickStartEvidence");
  if (!card) return;
  card.hidden = true;
  card.dataset.claimId = "";
  card.dataset.evidenceId = "";
  card.dataset.projectId = "";
  card.dataset.claimStatus = "";
  card.dataset.sourceId = "";
  state.quickStartReplay = null;
  $("quickStartClaimText").textContent = "";
  $("quickStartQuoteText").textContent = "";
  const replayContainer = $("quickStartReplayContainer");
  const replayButton = $("quickStartReplayBtn");
  const replayPanel = $("quickStartReplayPanel");
  if (replayContainer) replayContainer.hidden = true;
  if (replayButton) {
    replayButton.dataset.replayId = "";
    replayButton.setAttribute?.("aria-expanded", "false");
    replayButton.setAttribute?.("aria-label", uiText("replay.action"));
  }
  if (replayPanel) {
    replayPanel.dataset.replayPanel = "";
    replayPanel.dataset.replayStatus = "";
    replayPanel.hidden = true;
    replayPanel.innerHTML = "";
  }
  for (const id of ["quickStartAcceptClaimBtn", "quickStartRejectClaimBtn"]) {
    const button = $(id);
    if (!button) continue;
    button.dataset.claimId = "";
    button.disabled = true;
  }
}

function restoreQuickStartEvidenceFromRecords(records) {
  let milestones = state.onboardingMilestones || {};
  state.onboardingDecisionVerified = false;
  hideQuickStartEvidence();
  if (
    milestones.projectId !== currentProjectId()
      || !milestones.claimReadyAt
      || !milestones.firstClaimId
      || !milestones.firstEvidenceId
  ) {
    renderQuickStart();
    return false;
  }
  const claim = (records?.claims || []).find((item) => item.id === milestones.firstClaimId);
  const evidence = (records?.evidence || []).find((item) => (
    item.id === milestones.firstEvidenceId
      && item.claim_id === milestones.firstClaimId
      && String(item.quote || "").trim()
  ));
  if (!claim || (claim.project_id && claim.project_id !== milestones.projectId) || !evidence) {
    renderQuickStart();
    return false;
  }
  if (milestones.firstReviewedAt && claim.status === "reviewed") {
    milestones = migrateLegacyQuickStartDecisionMilestone(milestones);
  }
  const localDecisionStatus = quickStartDecisionStatus(milestones);
  const hadActiveDecision = Boolean(localDecisionStatus);
  if (hadActiveDecision && claim.status === localDecisionStatus) {
    state.onboardingDecisionVerified = true;
  } else if (hadActiveDecision) {
    invalidateQuickStartDecisionMilestone(claim.status || "unknown");
  }
  renderQuickStart({
    restored: hadActiveDecision || Boolean(
      state.onboardingMilestones?.decisionInvalidatedAt
        || state.onboardingMilestones?.reviewInvalidatedAt
    )
  });
  revealQuickStartEvidence(claim, evidence, { focus: false, projectId: milestones.projectId });
  return true;
}

function invalidateQuickStartDecisionMilestone(serverStatus) {
  const milestones = state.onboardingMilestones || {};
  const previousStatus = quickStartDecisionStatus(milestones);
  const previousAt = milestones.firstDecisionAt || milestones.firstReviewedAt;
  if (!previousStatus || !previousAt) return false;
  const invalidatedAt = new Date().toISOString();
  const invalidated = {
    ...milestones,
    decisionInvalidatedAt: invalidatedAt,
    decisionInvalidatedFromAt: previousAt,
    decisionInvalidatedFromStatus: previousStatus,
    decisionInvalidatedStatus: serverStatus || "unknown"
  };
  if (previousStatus === "reviewed") {
    invalidated.reviewInvalidatedAt = invalidatedAt;
    invalidated.reviewInvalidatedFromReviewedAt = milestones.firstReviewedAt || previousAt;
    invalidated.reviewInvalidatedStatus = serverStatus || "unknown";
  } else {
    delete invalidated.reviewInvalidatedAt;
    delete invalidated.reviewInvalidatedFromReviewedAt;
    delete invalidated.reviewInvalidatedStatus;
  }
  delete invalidated.firstDecisionAt;
  delete invalidated.firstDecisionStatus;
  delete invalidated.firstReviewedAt;
  state.onboardingMilestones = invalidated;
  state.onboardingDecisionVerified = false;
  chrome.storage.local.set({ [ONBOARDING_MILESTONES_KEY]: invalidated }).catch((error) => {
    console.warn("Quick Start review invalidation milestone could not be persisted.", error);
  });
  return true;
}

async function runQuickStart() {
  await ensureSettingsLoaded();
  if (!state.settings?.pairingToken) {
    setLocalizedStatus("quickStart.error.pairFirst");
    showTab("settings");
    return null;
  }

  setBusy(true);
  const quickStatus = $("quickStartStatus");
  try {
    await markOnboardingMilestone("pairedAt");
    setLocalizedNodeText(quickStatus, "quickStart.status.reading");
    const capture = await readAndPersistCurrentPage();
    const sourceId = capture?.source?.id;
    if (!sourceId) throw localizedError("quickStart.error.noSourceId", "本地服务没有返回 source id。");

    setLocalizedNodeText(quickStatus, "quickStart.status.extracting");
    const result = await requestKnowledgeExtraction(sourceId, "mock");
    await markOnboardingMilestone("extractedAt", { lastSourceId: sourceId, projectId: currentProjectId() });
    await applyKnowledgeExtractionResult(sourceId, result, "Quick Start 已抽取");
    const records = result.records || {};
    const firstEvidence = firstQuoteBackedClaim(records);
    if (!firstEvidence) {
      throw localizedError(
        "quickStart.error.noEvidence",
        "本地模板没有返回同时包含 claim 与 exact quote 的证据链；未标记为完成。"
      );
    }

    renderKnowledgeRecords(records);
    revealQuickStartEvidence(firstEvidence.claim, firstEvidence.evidence);
    await markOnboardingMilestone("claimReadyAt", {
      lastSourceId: sourceId,
      projectId: currentProjectId(),
      firstClaimId: firstEvidence.claim.id || "",
      firstEvidenceId: firstEvidence.evidence.id || ""
    });
    setLocalizedNodeText(quickStatus, "quickStart.status.evidenceReady");
    setLocalizedKnowledgeRecordStatus("quickStart.knowledgeReady");
    showTab("knowledge");
    revealQuickStartEvidence(firstEvidence.claim, firstEvidence.evidence);
    return { capture, result, ...firstEvidence };
  } catch (error) {
    const params = { error: errorI18nParam(error) };
    setLocalizedNodeText(quickStatus, "quickStart.status.failed", params);
    setLocalizedStatus("quickStart.status.failed", params);
    return null;
  } finally {
    setBusy(false);
  }
}

async function acceptQuickStartClaim() {
  return decideQuickStartClaim("reviewed");
}

async function rejectQuickStartClaim() {
  return decideQuickStartClaim("rejected");
}

async function decideQuickStartClaim(decisionStatus) {
  if (decisionStatus !== "reviewed" && decisionStatus !== "rejected") return null;
  const card = $("quickStartEvidence");
  const milestones = state.onboardingMilestones || {};
  const claimId = String(card?.dataset?.claimId || state.onboardingMilestones?.firstClaimId || "").trim();
  const claimText = String($("quickStartClaimText")?.textContent || "");
  const quote = String($("quickStartQuoteText")?.textContent || "").trim();
  const evidenceProjectId = String(card?.dataset?.projectId || "").trim();
  const evidenceId = String(card?.dataset?.evidenceId || "").trim();
  const evidenceSourceId = String(card?.dataset?.sourceId || state.quickStartReplay?.source_id || "").trim();
  const replayBeforeReview = state.quickStartReplay;
  if (
    !evidenceProjectId
      || evidenceProjectId !== currentProjectId()
      || milestones.projectId !== currentProjectId()
      || milestones.firstClaimId !== claimId
      || milestones.firstEvidenceId !== evidenceId
  ) {
    setLocalizedNodeText($("quickStartReviewStatus"), "firstEvidence.review.crossProject");
    setLocalizedStatus("firstEvidence.review.crossProjectStatus");
    return null;
  }
  if (!claimId || !evidenceId || !quote) {
    setLocalizedNodeText($("quickStartReviewStatus"), "firstEvidence.review.missing");
    return null;
  }

  setBusy(true);
  setLocalizedNodeText(
    $("quickStartReviewStatus"),
    decisionStatus === "rejected"
      ? "firstEvidence.review.savingRejected"
      : "firstEvidence.review.savingReviewed"
  );
  try {
    const reviewBody = decisionStatus === "rejected"
      ? {
          status: "rejected",
          reviewer: "quick-start-user",
          review_note: "Reviewed in First Evidence after comparing the claim with the exact quote.",
          rejection_reason: "The exact quote does not support this claim."
        }
      : {
          status: "reviewed",
          reviewer: "quick-start-user",
          review_note: "Accepted in First Evidence after comparing the claim with the exact quote."
        };
    const result = await companionRequest(`/v1/claims/${encodeURIComponent(claimId)}/review`, {
      method: "POST",
      body: reviewBody
    });
    if (result?.claim?.status !== decisionStatus) {
      throw new Error(
        uiText(
          "firstEvidence.review.notConfirmed",
          { status: decisionStatus },
          `本地服务没有确认 ${decisionStatus} 判断；未记录完成里程碑。`
        )
      );
    }
    const metadata = {
      projectId: currentProjectId(),
      firstClaimId: claimId,
      firstEvidenceId: evidenceId,
      firstDecisionStatus: decisionStatus
    };
    if (decisionStatus === "reviewed") metadata.firstReviewedAt = new Date().toISOString();
    await refreshClaimReviewAfterMutation();
    const refreshedReplay = replayMatchesEvidence(
      state.quickStartReplay,
      { id: evidenceId, claim_id: claimId, source_id: evidenceSourceId },
      { projectId: currentProjectId() }
    ) ? state.quickStartReplay : replayBeforeReview;
    state.onboardingDecisionVerified = true;
    await markOnboardingMilestone("firstDecisionAt", metadata);
    revealQuickStartEvidence(
      {
        ...result.claim,
        id: claimId,
        project_id: currentProjectId(),
        status: decisionStatus,
        text: result.claim?.text || claimText
      },
      {
        id: evidenceId,
        claim_id: claimId,
        source_id: evidenceSourceId,
        quote,
        replay: refreshedReplay
      },
      { focus: false, projectId: currentProjectId() }
    );
    renderQuickStartEvidenceChrome();
    setLocalizedNodeText(
      $("quickStartReviewStatus"),
      decisionStatus === "rejected"
        ? "firstEvidence.review.rejectedSaved"
        : "firstEvidence.review.accepted"
    );
    setLocalizedNodeText(
      $("quickStartStatus"),
      decisionStatus === "rejected"
        ? "quickStart.status.completedRejected"
        : "quickStart.status.completedReviewed"
    );
    renderQuickStart();
    return result;
  } catch (error) {
    setLocalizedNodeText($("quickStartReviewStatus"), "firstEvidence.review.failed", {
      error: errorI18nParam(error)
    });
    return null;
  } finally {
    setBusy(false);
  }
}

async function readManualSelectorFromPage() {
  const selector = $("manualSelectorInput")?.value.trim() || "";
  if (!selector) {
    setLocalizedStatus("currentPage.selector.required");
    return;
  }
  setBusy(true);
  setLocalizedStatus("currentPage.selector.reading", { selector });
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw localizedError("currentPage.error.noTab", "没有找到当前标签页。");
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractManualSelectorPage,
      args: [selector]
    });
    const extracted = result || {};
    if (extracted.error?.code) {
      throw manualSelectorLocalizedError(extracted.error, selector);
    }
    if (!String(extracted.text || "").trim()) {
      throw localizedError(
        "currentPage.selector.empty",
        `选择器匹配到了元素，但没有可读取文本：${selector}。`,
        { selector }
      );
    }
    const fallbackTitleKey = "currentPage.selector.defaultTitle";
    state.source = {
      title: extracted.title || tab.title || uiText(fallbackTitleKey, {}, "手动选择器来源"),
      titleI18nKey: extracted.title || tab.title ? "" : fallbackTitleKey,
      projectId: currentProjectId(),
      url: tab.url || extracted.url || "",
      canonicalUrl: extracted.canonicalUrl || normalizeUrl(tab.url || extracted.url || ""),
      text: extracted.text || "",
      markdown: extracted.markdown || "",
      kind: extracted.kind || "page+manual-selector",
      site: extracted.site || inferSiteFromUrl(tab.url || extracted.url || ""),
      author: extracted.author || "",
      publishedAt: extracted.publishedAt || "",
      blocks: extracted.blocks || [],
      images: extracted.images || [],
      attachments: extracted.attachments || [],
      links: extracted.links || [],
      nextPages: extracted.nextPages || [],
      stats: extracted.stats || {},
      capturedAt: new Date().toISOString()
    };
    markCurrentSourceFingerprint();
    renderSource();
    setLocalizedStatus("currentPage.selector.success", {
      count: countCjkAwareChars(state.source.text)
    });
  } catch (error) {
    const directKeys = new Set([
      "currentPage.selector.invalid",
      "currentPage.selector.noMatch",
      "currentPage.selector.empty",
      "currentPage.selector.failed"
    ]);
    if (directKeys.has(error?.uiI18nKey)) {
      setLocalizedStatus(error.uiI18nKey, error.uiI18nParams || { selector });
    } else {
      setLocalizedStatus("currentPage.selector.failed", {
        error: errorI18nParam(error)
      });
    }
  } finally {
    setBusy(false);
  }
}

function manualSelectorLocalizedError(metadata = {}, selector = "") {
  const keys = {
    selector_invalid: "currentPage.selector.invalid",
    selector_no_match: "currentPage.selector.noMatch",
    selector_empty: "currentPage.selector.empty"
  };
  const fallbackByCode = {
    selector_invalid: `CSS 选择器无效：${selector}。`,
    selector_no_match: `页面中没有匹配该 CSS 选择器：${selector}。`,
    selector_empty: `选择器匹配到了元素，但没有可读取文本：${selector}。`
  };
  const code = String(metadata.code || "selector_error");
  const key = keys[code] || "currentPage.selector.failed";
  const error = localizedError(
    key,
    fallbackByCode[code] || String(metadata.detail || "选择器读取失败。"),
    key === "currentPage.selector.failed"
      ? { error: String(metadata.detail || code) }
      : { selector }
  );
  error.code = code;
  error.selectorErrorDetail = String(metadata.detail || "");
  return error;
}

function extractManualSelectorPage(selector) {
  let root;
  try {
    root = document.querySelector(selector);
  } catch (error) {
    return {
      error: {
        code: "selector_invalid",
        detail: String(error?.message || error || "")
      }
    };
  }
  if (!root) {
    return { error: { code: "selector_no_match" } };
  }
  const url = location.href;
  const canonicalUrl = document.querySelector('link[rel="canonical"], link[rel~="canonical"]')?.href || url;
  const title = document.title || textOf(root.querySelector("h1, h2, h3")) || "";
  const bodyText = normalizeText(root.innerText || root.textContent || "");
  if (!bodyText) {
    return { error: { code: "selector_empty" } };
  }
  const codeBlocks = extractCodeBlocks(root);
  const images = extractImages(root);
  const links = extractLinks(root);
  const attachments = links.filter((link) => /\.(?:zip|7z|rar|pdf|docx?|xlsx?|pptx?)($|[?#])/i.test(link.href) || /附件|下载|file|pdf/i.test(link.text));
  const nextPages = links
    .filter((link) => /下一页|next|more|older/i.test(link.text))
    .map((link) => link.href)
    .filter(Boolean)
    .slice(0, 5);
  const headings = Array.from(root.querySelectorAll?.("h1, h2, h3") || [])
    .slice(0, 20)
    .map((node) => `${"#".repeat(Math.min(Number(node.tagName.slice(1)), 3))} ${normalizeText(node.innerText || node.textContent || "")}`)
    .filter((line) => !/^#+\s*$/.test(line));
  const markdown = [
    `# ${title || url}`,
    url,
    canonicalUrl && canonicalUrl !== url ? `Canonical: ${canonicalUrl}` : "",
    `Manual selector: ${selector}`,
    headings.length ? `\n## 页面标题\n${headings.join("\n")}` : "",
    `\n## 手动选择器正文\n${bodyText}`,
    codeBlocks.length ? `\n## 代码片段\n${codeBlocks.map(formatCodeBlock).join("\n\n")}` : "",
    images.length ? `\n## 图片\n${images.map((image) => `- ${image.alt || "image"}: ${image.src}`).join("\n")}` : "",
    attachments.length ? `\n## 附件\n${attachments.map((item) => `- [${item.text || "attachment"}](${item.href})`).join("\n")}` : "",
    links.length ? `\n## 重要链接\n${links.slice(0, 40).map((link) => `- [${link.text}](${link.href})`).join("\n")}` : ""
  ].filter(Boolean).join("\n\n");
  const textChars = markdown.replace(/\s+/g, "").length;
  return {
    title,
    url,
    canonicalUrl,
    text: markdown,
    markdown,
    kind: "page+manual-selector",
    site: inferSite(url),
    author: "",
    publishedAt: "",
    blocks: [
      {
        type: "manual_selector",
        selector,
        text: bodyText,
        codeBlocks: codeBlocks.map((item) => item.code),
        images,
        attachments
      }
    ],
    images,
    attachments,
    links: links.slice(0, 40),
    nextPages,
    stats: {
      profile: "manual-selector",
      site: inferSite(url),
      manualSelector: selector,
      textChars,
      blocks: 1,
      images: images.length,
      codeBlocks: codeBlocks.length,
      attachments: attachments.length,
      links: Math.min(links.length, 40),
      comments: 0,
      floors: 0,
      nextPages: nextPages.length,
      lowText: textChars < 200,
      quality: manualSelectorQuality(textChars, codeBlocks, images)
    }
  };

  function textOf(node) {
    return normalizeText(node?.innerText || node?.textContent || "");
  }

  function extractCodeBlocks(scope) {
    return Array.from(scope.querySelectorAll?.("pre, code") || [])
      .map((node) => ({
        language: detectLanguage(node),
        code: normalizeText(node.innerText || node.textContent || "")
      }))
      .filter((item) => item.code.length > 20)
      .slice(0, 80);
  }

  function detectLanguage(node) {
    const className = String(node.className || "");
    const match = className.match(/language-([\w-]+)/) || className.match(/highlight-([\w-]+)/);
    return match?.[1] || "";
  }

  function formatCodeBlock(item) {
    return `\`\`\`${item.language || ""}\n${item.code}\n\`\`\``;
  }

  function extractImages(scope) {
    return Array.from(scope.querySelectorAll?.("img") || [])
      .map((image) => ({
        src: image.currentSrc || image.src || "",
        alt: normalizeText(image.alt || image.title || ""),
        context: normalizeText(image.closest("figure, p, div")?.innerText || "").slice(0, 240)
      }))
      .filter((image) => image.src && !image.src.startsWith("data:"))
      .slice(0, 80);
  }

  function extractLinks(scope) {
    return Array.from(scope.querySelectorAll?.("a[href]") || [])
      .map((link) => ({
        text: normalizeText(link.innerText || link.textContent || link.href).slice(0, 120),
        href: link.href
      }))
      .filter((link) => link.text && link.href && !link.href.startsWith("javascript:"))
      .slice(0, 100);
  }

  function manualSelectorQuality(textLength, codes, imageList) {
    let score = 20;
    if (textLength >= 1500) score += 40;
    else if (textLength >= 600) score += 30;
    else if (textLength >= 200) score += 15;
    if (codes.length) score += 10;
    if (imageList.length) score += 5;
    return Math.min(85, score);
  }

  function inferSite(pageUrl) {
    try {
      const host = new URL(pageUrl).hostname.replace(/^www\./, "");
      if (host.includes("quantclass") || /bbs|forum|discuz/i.test(host)) return "quantclass";
      if (host.includes("zhihu")) return "zhihu";
      if (host.includes("mp.weixin.qq.com")) return "wechat";
      if (host.includes("substack")) return "substack";
      if (host.includes("medium.com")) return "medium";
      if (host.includes("news.ycombinator.com")) return "hacker-news";
      if (host.includes("reddit.com")) return "reddit";
      if (host.includes("arxiv.org")) return "arxiv";
      if (host.includes("github.com")) return "github";
      return host || "web";
    } catch {
      return "web";
    }
  }

  function normalizeText(value) {
    return String(value)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }
}

function extractReadablePage() {
  if (window.QCSmartReaderProfiles?.extractReadablePage) {
    try {
      return window.QCSmartReaderProfiles.extractReadablePage();
    } catch (error) {
      console.warn("Shared site profile extraction failed; falling back to inline extractor.", error);
    }
  }
  const selectedText = String(window.getSelection?.() || "").trim();
  const pageTitle = document.title || "";
  const url = location.href;
  const canonicalUrl = document.querySelector('link[rel="canonical"], link[rel~="canonical"]')?.href || url;
  const metaDescription = document.querySelector('meta[name="description"]')?.content || "";
  const site = inferSite(url);
  const profile = pickProfile(site);
  const truncation = {};
  const extracted = profile.extract();
  const title = extracted.title || pageTitle;
  const blocks = extracted.blocks || [];
  const headings = extractHeadings();
  const codeBlocks = extractCodeBlocks(extracted.root || document);
  const images = extractImages(extracted.root || document);
  const links = extractLinks(extracted.root || document);
  const attachments = extracted.attachments || extractAttachments(extracted.root || document);
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
    truncated: hasExtractionTruncation(),
    truncation,
    quality: scoreQuality({ text, blocks, images, codeBlocks, extracted })
  };

  return {
    title,
    url,
    canonicalUrl,
    text,
    markdown,
    kind: selectedText ? `${extracted.kind}+selection` : extracted.kind,
    site,
    author: extracted.author || "",
    publishedAt: extracted.publishedAt || "",
    blocks,
    images,
    attachments,
    links,
    nextPages: extracted.nextPages || [],
    stats
  };

  function inferSite(pageUrl) {
    const host = new URL(pageUrl).hostname.replace(/^www\./, "");
    if (host.includes("quantclass") || /bbs|forum|discuz/i.test(host)) return "quantclass";
    if (host.includes("zhihu")) return "zhihu";
    if (host.includes("mp.weixin.qq.com")) return "wechat";
    if (host.includes("substack")) return "substack";
    if (host.includes("medium.com")) return "medium";
    if (host.includes("news.ycombinator.com")) return "hacker-news";
    if (host.includes("reddit.com")) return "reddit";
    if (host.includes("arxiv.org")) return "arxiv";
    if (host.includes("github.com")) return "github";
    return "generic";
  }

  function pickProfile(siteId) {
    const profiles = {
      quantclass: { id: "quantclass-bbs", extract: extractForum },
      zhihu: { id: "zhihu", extract: () => extractArticle(["article", ".Post-RichTextContainer", ".RichContent-inner", ".QuestionAnswer-content", "main"]) },
      wechat: { id: "wechat-article", extract: () => extractArticle(["#js_content", ".rich_media_content", "article"]) },
      substack: { id: "substack", extract: () => extractArticle(["article", ".available-content", ".post", "main"]) },
      medium: { id: "medium", extract: () => extractArticle(["article", "main"]) },
      "hacker-news": { id: "hacker-news", extract: extractHackerNews },
      reddit: { id: "reddit", extract: () => extractArticle(["shreddit-post", "[slot='text-body']", "article", "main"]) },
      arxiv: { id: "arxiv", extract: extractArxiv },
      github: { id: "github-discussion", extract: () => extractArticle([".js-discussion", ".markdown-body", "article", "main"]) },
      generic: { id: "generic-readability", extract: () => extractArticle(["article", "main", "[role='main']", ".content", ".article", ".post", ".markdown-body", "body"]) }
    };
    return profiles[siteId] || profiles.generic;
  }

  function extractForum() {
    const root = firstExisting([".thread", ".topic", "main", "[role='main']", "article", ".post", ".markdown-body", ".content", "body"]);
    const titleNode = firstExisting(["h1", ".thread-title", ".post-title", ".title"]) || document.querySelector("title");
    const author = textOf(firstExisting([".author", ".username", ".user-name", "[class*='author']", "[class*='user']"]));
    const publishedAt = textOf(firstExisting(["time", ".time", ".date", ".created-at", "[class*='time']", "[class*='date']"]));
    const allPostNodes = uniqueNodes([
      ...Array.from(document.querySelectorAll("article, .post, .reply, .comment, .floor, [class*='post-item'], [class*='comment']"))
    ]).filter((node) => normalizeText(node.innerText || "").length > 40);
    const postNodes = limitExtractionItems(allPostNodes, "blocks", EXTRACTION_LIMITS.blocks);
    const blockTextStats = { total: postNodes.length, kept: postNodes.length, limit: EXTRACTION_LIMITS.blockTextChars, truncated: false, truncated_items: 0 };
    const blocks = postNodes.map((node, index) => {
      const rawText = normalizeText(node.innerText || "");
      if (rawText.length > EXTRACTION_LIMITS.blockTextChars) {
        blockTextStats.truncated = true;
        blockTextStats.truncated_items += 1;
      }
      return {
        type: inferForumBlockType(node, index),
        floor: findFloor(node, index),
        author: textOf(node.querySelector(".author, .username, .user-name, [class*='author'], [class*='user']")),
        time: textOf(node.querySelector("time, .time, .date, [class*='time'], [class*='date']")),
        text: rawText.slice(0, EXTRACTION_LIMITS.blockTextChars),
        codeBlocks: extractCodeBlocks(node, { track: false }).map((item) => item.code),
        images: extractImages(node, { track: false }),
        attachments: extractAttachments(node, { track: false })
      };
    });
    const allBlockTypes = allPostNodes.map((node, index) => inferForumBlockType(node, index));
    const commentLimit = Math.max(0, EXTRACTION_LIMITS.blocks - (allBlockTypes.includes("main_post") ? 1 : 0));
    recordExtractionLimit(
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
      text: normalizeText(root?.innerText || document.body?.innerText || ""),
      blocks,
      attachments: extractAttachments(root || document.body),
      nextPages: extractNextPages()
    };
  }

  function extractHackerNews() {
    const root = firstExisting([".athing", "body"]);
    const titleNode = document.querySelector(".titleline a") || document.querySelector("title");
    const comments = Array.from(document.querySelectorAll(".comment-tree .athing, tr.athing.comtr"))
      .map((node, index) => ({
        type: "comment",
        floor: index + 1,
        author: textOf(node.querySelector(".hnuser")),
        time: textOf(node.querySelector(".age")),
        text: normalizeText(node.innerText || "")
      }))
      .filter((block) => block.text.length > 20);
    return {
      kind: "thread",
      title: textOf(titleNode) || pageTitle,
      author: textOf(document.querySelector(".subtext .hnuser")),
      publishedAt: textOf(document.querySelector(".subtext .age")),
      root: document.body,
      text: normalizeText(document.body?.innerText || ""),
      blocks: comments,
      nextPages: extractNextPages()
    };
  }

  function extractArxiv() {
    const titleNode = firstExisting(["h1.title", "h1"]);
    const abstractNode = firstExisting(["blockquote.abstract", ".abstract"]);
    const authors = textOf(firstExisting([".authors", ".authors a"]));
    const meta = textOf(firstExisting([".dateline", ".submission-history"]));
    return {
      kind: "paper",
      title: textOf(titleNode).replace(/^Title:\s*/i, "") || pageTitle,
      author: authors.replace(/^Authors:\s*/i, ""),
      publishedAt: meta,
      root: document.body,
      text: normalizeText([textOf(titleNode), authors, textOf(abstractNode), meta].join("\n\n")),
      blocks: [
        { type: "abstract", text: textOf(abstractNode).replace(/^Abstract:\s*/i, "") }
      ].filter((block) => block.text)
    };
  }

  function extractArticle(selectors) {
    const root = pickBestRoot(selectors);
    const titleNode = firstExisting(["h1", "[data-testid='headline']", ".title", ".post-title"]) || document.querySelector("title");
    return {
      kind: "page",
      title: textOf(titleNode) || pageTitle,
      author: textOf(firstExisting(["[rel='author']", ".author", ".byline", "[class*='author']", "[class*='byline']"])),
      publishedAt: textOf(firstExisting(["time", ".date", ".publish-time", "[class*='date']", "[class*='time']"])),
      root,
      text: normalizeText(root?.innerText || ""),
      blocks: []
    };
  }

  function pickBestRoot(selectors) {
    const nodes = uniqueNodes(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))));
    let best = nodes[0] || document.body;
    let bestScore = 0;
    for (const node of nodes) {
      const text = normalizeText(node.innerText || "");
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

  function extractHeadings() {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((node) => `${"#".repeat(Math.min(Number(node.tagName.slice(1)), 3))} ${normalizeText(node.innerText || "")}`)
      .filter((line) => !/^#+\s*$/.test(line));
    return limitExtractionItems(headings, "headings", EXTRACTION_LIMITS.headings);
  }

  function extractCodeBlocks(root, options = {}) {
    const items = Array.from(root.querySelectorAll?.("pre, code") || [])
      .map((node) => ({
        language: detectLanguage(node),
        code: normalizeText(node.innerText || "")
      }))
      .filter((item) => item.code.length > 20);
    return limitExtractionItems(items, "codeBlocks", EXTRACTION_LIMITS.codeBlocks, options);
  }

  function detectLanguage(node) {
    const className = String(node.className || "");
    const match = className.match(/language-([\w-]+)/) || className.match(/highlight-([\w-]+)/);
    return match?.[1] || "";
  }

  function formatCodeBlock(item) {
    return `\`\`\`${item.language || ""}\n${item.code}\n\`\`\``;
  }

  function extractImages(root, options = {}) {
    const images = Array.from(root.querySelectorAll?.("img") || [])
      .map((image) => ({
        src: image.currentSrc || image.src || "",
        alt: normalizeText(image.alt || image.title || ""),
        context: normalizeText(image.closest("figure, p, div")?.innerText || "").slice(0, 240)
      }))
      .filter((image) => image.src && !image.src.startsWith("data:"));
    return limitExtractionItems(images, "images", EXTRACTION_LIMITS.images, options);
  }

  function extractAttachments(root, options = {}) {
    const attachments = collectLinks(root)
      .filter((link) => /\.(?:zip|7z|rar|pdf|docx?|xlsx?|pptx?)($|[?#])/i.test(link.href) || /附件|下载|file/i.test(link.text));
    return limitExtractionItems(attachments, "attachments", EXTRACTION_LIMITS.attachments, options);
  }

  function collectLinks(root) {
    return Array.from(root.querySelectorAll?.("a[href]") || [])
      .map((link) => ({
        text: normalizeText(link.innerText || link.textContent || link.href).slice(0, 120),
        href: link.href
      }))
      .filter((link) => link.text && link.href && !link.href.startsWith("javascript:"));
  }

  function extractLinks(root, options = {}) {
    return limitExtractionItems(collectLinks(root), "links", EXTRACTION_LIMITS.links, options);
  }

  function extractNextPages() {
    const pages = Array.from(document.querySelectorAll("a[href]"))
      .filter((link) => /下一页|next|more|older/i.test(link.innerText || link.getAttribute("aria-label") || ""))
      .map((link) => link.href)
      .filter(Boolean);
    return limitExtractionItems(pages, "nextPages", EXTRACTION_LIMITS.nextPages);
  }

  function limitExtractionItems(items, key, limit, options = {}) {
    const list = Array.isArray(items) ? items : [];
    const kept = list.slice(0, limit);
    if (options.track !== false) {
      recordExtractionLimit(key, list.length, kept.length, limit);
    }
    return kept;
  }

  function recordExtractionLimit(key, total, kept, limit) {
    truncation[key] = {
      total,
      kept,
      limit,
      truncated: total > kept
    };
  }

  function hasExtractionTruncation() {
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

  function findFloor(node, index) {
    const text = normalizeText(node.innerText || "");
    const match = text.match(/(?:#|楼|第)\s*(\d+)/);
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

  function scoreQuality({ text, blocks, images, codeBlocks, extracted }) {
    let score = 0;
    if (text.length > 1200) score += 35;
    else if (text.length > 400) score += 20;
    if (blocks.length) score += 20;
    if (codeBlocks.length) score += 10;
    if (images.length) score += 5;
    if (extracted.author) score += 5;
    if (extracted.publishedAt) score += 5;
    if ((extracted.nextPages || []).length) score += 5;
    return Math.min(100, score || 10);
  }

  function normalizeText(value) {
    return String(value)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }
}

function renderSource() {
  const source = state.source;
  if (source?.titleI18nKey) {
    setLocalizedNodeText($("sourceTitle"), source.titleI18nKey);
  } else if (source?.title) {
    setRawNodeText($("sourceTitle"), source.title);
  } else {
    setLocalizedNodeText($("sourceTitle"), "currentPage.emptyTitle");
  }
  setLocalizedNodeText($("sourceStats"), "currentPage.characters", {
    count: countCjkAwareChars(source?.text || "")
  });
  $("sourceUrl").textContent = source?.url || "";
  setLocalizedNodeText(
    $("sourceLine"),
    !source
      ? "shell.sourceLine.empty"
      : source.kind === "selection"
        ? "shell.sourceLine.selection"
        : "shell.sourceLine.page"
  );
  renderSourcePreview(source);
}

function renderSourcePreview(source) {
  const preview = $("sourcePreview");
  if (!preview) return;
  preview.textContent = "";
  const nextPageButton = $("enqueueNextPagesBtn");
  if (nextPageButton) {
    nextPageButton.disabled = true;
    setLocalizedNodeText(nextPageButton, "currentPage.enqueuePages");
  }
  if (!source) return;
  const stats = source.stats || {};
  const nextPages = Array.isArray(source.nextPages) ? source.nextPages.filter(Boolean) : [];
  const items = [
    ["currentPage.summary.profile", stats.profile || source.site || "generic"],
    ["currentPage.summary.quality", `${stats.quality || 0}/100`],
    ["currentPage.summary.images", stats.images ?? source.images?.length ?? 0],
    ["currentPage.summary.codeBlocks", stats.codeBlocks ?? 0],
    ["currentPage.summary.attachments", stats.attachments ?? source.attachments?.length ?? 0],
    ["currentPage.summary.comments", stats.comments ?? 0],
    ["currentPage.summary.nextPages", stats.nextPages ?? source.nextPages?.length ?? 0],
    ["currentPage.summary.pdfPages", stats.pages ?? 0],
    ["currentPage.summary.transcriptSegments", stats.transcriptSegments ?? 0],
    ...(stats.ocrPagesReplaced === undefined ? [] : [["currentPage.summary.ocrPages", stats.ocrPagesReplaced]])
  ];
  for (const [labelKey, value] of items) {
    const node = document.createElement("span");
    node.textContent = `${uiText(labelKey)}: ${value}`;
    preview.appendChild(node);
  }
  const flags = source.quality_flags || source.qualityFlags || {};
  const activeFlags = Object.entries(flags)
    .filter(([, value]) => Array.isArray(value) ? value.length : Boolean(value))
    .map(([key, value]) => Array.isArray(value) ? `${key}:${value.join(",")}` : key);
  if (activeFlags.length) {
    const node = document.createElement("span");
    node.textContent = `flags: ${activeFlags.join(" / ")}`;
    preview.appendChild(node);
  }
  if (nextPages.length) {
    const node = document.createElement("span");
    setLocalizedNodeText(node, "currentPage.nextPages.preview", {
      urls: nextPages.slice(0, 3).join(" · "),
      more: nextPages.length > 3
        ? {
            i18nKey: "currentPage.nextPages.more",
            params: { count: nextPages.length - 3 }
          }
        : ""
    });
    preview.appendChild(node);
    if (nextPageButton) {
      nextPageButton.disabled = false;
      setLocalizedNodeText(nextPageButton, "currentPage.nextPages.button", {
        count: nextPages.length
      });
    }
  }
}

async function loadBatchQueue() {
  const projectId = currentProjectId();
  const {
    batchQueue = [],
    batchMetrics = null,
    batchConcurrency = 1,
    batchMetricsByProject = {},
    batchConcurrencyByProject = {}
  } = await chrome.storage.local.get([
    "batchQueue",
    "batchMetrics",
    "batchConcurrency",
    "batchMetricsByProject",
    "batchConcurrencyByProject"
  ]);
  const storedQueue = Array.isArray(batchQueue) ? batchQueue : [];
  let migratedLegacyItems = false;
  const scopedQueue = storedQueue.map((item) => {
    const itemProjectId = batchItemProjectId(item);
    if (itemProjectId) {
      return item.projectId === itemProjectId ? item : { ...item, projectId: itemProjectId };
    }
    migratedLegacyItems = true;
    return { ...item, projectId };
  });
  const metricsByProject = isRecord(batchMetricsByProject) ? batchMetricsByProject : {};
  const concurrencyByProject = isRecord(batchConcurrencyByProject) ? batchConcurrencyByProject : {};
  const hasScopedMetrics = Object.keys(metricsByProject).length > 0;
  const hasScopedConcurrency = Object.keys(concurrencyByProject).length > 0;
  state.batchProjectId = projectId;
  state.batchQueue = scopedQueue.filter((item) => item.projectId === projectId);
  state.batchConcurrency = normalizeBatchConcurrency(
    concurrencyByProject[projectId] ?? (!hasScopedConcurrency ? batchConcurrency : 1)
  );
  state.batchMetrics = normalizeBatchMetrics(
    metricsByProject[projectId] ?? (!hasScopedMetrics ? batchMetrics : null)
  );
  state.currentBatchJobId = "";
  syncBatchConcurrencyInput();
  renderBatchQueue();
  if (migratedLegacyItems || !(projectId in metricsByProject) || !(projectId in concurrencyByProject)) {
    await saveBatchQueue(projectId);
  }
}

async function saveBatchQueue(projectId = state.batchProjectId || currentProjectId()) {
  const normalizedProjectId = String(projectId || "default");
  const stored = await chrome.storage.local.get([
    "batchQueue",
    "batchMetricsByProject",
    "batchConcurrencyByProject"
  ]);
  const otherProjectItems = (Array.isArray(stored.batchQueue) ? stored.batchQueue : [])
    .filter((item) => {
      const itemProjectId = batchItemProjectId(item);
      return itemProjectId && itemProjectId !== normalizedProjectId;
    })
    .map((item) => ({ ...item, projectId: batchItemProjectId(item) }));
  const currentProjectItems = state.batchQueue.map((item) => ({
    ...item,
    projectId: normalizedProjectId
  }));
  const metricsByProject = {
    ...(isRecord(stored.batchMetricsByProject) ? stored.batchMetricsByProject : {}),
    [normalizedProjectId]: state.batchMetrics
  };
  const concurrencyByProject = {
    ...(isRecord(stored.batchConcurrencyByProject) ? stored.batchConcurrencyByProject : {}),
    [normalizedProjectId]: state.batchConcurrency
  };
  await chrome.storage.local.set({
    batchQueue: [...otherProjectItems, ...currentProjectItems],
    batchMetrics: state.batchMetrics,
    batchConcurrency: state.batchConcurrency,
    batchMetricsByProject: metricsByProject,
    batchConcurrencyByProject: concurrencyByProject
  });
  state.batchProjectId = normalizedProjectId;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function batchItemProjectId(item) {
  return String(item?.projectId || item?.project_id || "").trim();
}

function batchJobProjectId(job) {
  const topLevel = String(job?.input?.project_id || job?.input?.projectId || "").trim();
  if (topLevel) return topLevel;
  for (const item of job?.items || []) {
    const itemProjectId = String(item?.input?.project_id || item?.input?.projectId || "").trim();
    if (itemProjectId) return itemProjectId;
  }
  return "";
}

async function enqueueBatchUrls() {
  const raw = $("batchUrlsInput").value || "";
  const urls = parseUrls(raw);
  if (!urls.length) {
    setBatchStatus("没有识别到 URL。");
    return;
  }
  addUrlsToQueue(urls);
  $("batchUrlsInput").value = "";
  await saveBatchQueue();
  renderBatchQueue();
  setBatchStatus(`已加入 ${urls.length} 个 URL。`);
}

async function addOpenTabsToBatch() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const urls = tabs.map((tab) => tab.url).filter((url) => /^https?:\/\//.test(url || ""));
  addUrlsToQueue(urls);
  await saveBatchQueue();
  renderBatchQueue();
  setBatchStatus(`已从当前窗口加入 ${urls.length} 个标签。`);
}

function addUrlsToQueue(urls) {
  const existing = new Set(state.batchQueue.map((item) => normalizeUrl(item.url)));
  for (const url of urls) {
    const normalized = normalizeUrl(url);
    if (!normalized || existing.has(normalized)) continue;
    existing.add(normalized);
    state.batchQueue.push({
      id: crypto.randomUUID(),
      projectId: currentProjectId(),
      url: normalized,
      canonicalUrl: normalized,
      title: normalized,
      status: "pending",
      error: "",
      errorCategory: "",
      browserAttempts: 0,
      lastAttemptAt: "",
      startedAt: "",
      completedAt: "",
      lastHeartbeatAt: "",
      sourceId: "",
      jobId: "",
      jobItemId: "",
      nextPages: [],
      paginationCheckpoint: null,
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
}

async function restoreBatchFromCompanion() {
  if (state.batchRunning) {
    setBatchStatus("批量任务运行中，不能恢复。");
    return;
  }
  setBusy(true);
  setBatchStatus("正在从本地服务恢复最近任务...");
  try {
    const jobsResponse = await companionRequest("/v1/jobs?limit=20", { method: "GET" });
    const projectId = currentProjectId();
    const jobs = (jobsResponse.jobs || []).filter((job) => {
      if (job.type !== "read") return false;
      const jobProjectId = batchJobProjectId(job);
      return jobProjectId ? jobProjectId === projectId : projectId === "default";
    });
    if (!jobs.length) {
      setBatchStatus("本地服务里没有可恢复的 read job。");
      return;
    }
    let selectedJob = null;
    for (const summary of jobs) {
      const detail = await companionRequest(`/v1/jobs/${encodeURIComponent(summary.id)}`, { method: "GET" });
      const recovered = await companionRequest(`/v1/jobs/${encodeURIComponent(summary.id)}/recover`, {
        method: "POST",
        body: { max_age_seconds: 300 }
      });
      const job = recovered.job || detail.job;
      if (batchJobProjectId(job) && batchJobProjectId(job) !== projectId) continue;
      if ((job.items || []).some((item) => ["pending", "failed", "running"].includes(item.status))) {
        selectedJob = job;
        break;
      }
    }
    if (!selectedJob) {
      setBatchStatus("最近任务没有待恢复的 URL。");
      return;
    }
    const restored = mergeJobIntoBatchQueue(selectedJob);
    await saveBatchQueue();
    renderBatchQueue();
    setBatchStatus(`已从 ${selectedJob.id} 恢复 ${restored} 个 URL。`);
  } catch (error) {
    setBatchStatus(`恢复失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function mergeJobIntoBatchQueue(job) {
  const jobProjectId = batchJobProjectId(job);
  if (jobProjectId && jobProjectId !== currentProjectId()) return 0;
  updateBatchQualityGateFromJob(job);
  const existing = new Map(state.batchQueue.map((item) => [normalizeUrl(item.url), item]));
  let restored = 0;
  for (const jobItem of job.items || []) {
    const url = normalizeUrl(jobItem.url || jobItem.input?.url || "");
    if (!url) continue;
    const localStatus = serviceItemStatusToLocal(jobItem.status);
    const existingItem = existing.get(url);
    const result = jobItem.result || {};
    const fallbackCheckpoint = {
      url,
      sourceId: jobItem.source_id || existingItem?.sourceId || "",
      title: jobItem.title || jobItem.input?.title || existingItem?.title || url,
      jobId: job.id,
      jobItemId: jobItem.id,
      nextPages: result.next_pages || result.nextPages || existingItem?.nextPages || []
    };
    const paginationCheckpoint =
      normalizeBatchPaginationCheckpoint(result.pagination_checkpoint || result.paginationCheckpoint, fallbackCheckpoint) ||
      normalizeBatchPaginationCheckpoint({ next_pages: result.next_pages || result.nextPages || [] }, fallbackCheckpoint) ||
      normalizeBatchPaginationCheckpoint(existingItem?.paginationCheckpoint, fallbackCheckpoint);
    const nextPages = paginationCheckpoint?.next_pages || normalizeBatchNextPages(existingItem?.nextPages || []);
    const next = {
      id: existingItem?.id || jobItem.input?.client_id || crypto.randomUUID(),
      projectId: jobProjectId || currentProjectId(),
      url,
      canonicalUrl: jobItem.input?.canonical_url || normalizeUrl(url),
      title: jobItem.title || jobItem.input?.title || url,
      status: localStatus,
      error: jobItem.error || "",
      errorCategory: jobItem.error_category || "",
      browserAttempts: Number(jobItem.result?.browser_attempts || existingItem?.browserAttempts || 0),
      retryable: typeof result.retryable === "boolean" ? result.retryable : existingItem?.retryable,
      lastAttemptAt: existingItem?.lastAttemptAt || jobItem.started_at || "",
      startedAt: jobItem.started_at || existingItem?.startedAt || "",
      completedAt: jobItem.completed_at || existingItem?.completedAt || (["success", "failed"].includes(localStatus) ? jobItem.updated_at || "" : ""),
      lastHeartbeatAt: jobItem.heartbeat_at || existingItem?.lastHeartbeatAt || "",
      sourceId: jobItem.source_id || "",
      jobId: job.id,
      jobItemId: jobItem.id,
      nextPages,
      paginationCheckpoint,
      addedAt: existingItem?.addedAt || jobItem.created_at || new Date().toISOString(),
      updatedAt: jobItem.updated_at || new Date().toISOString()
    };
    if (existingItem) {
      Object.assign(existingItem, next);
    } else {
      state.batchQueue.push(next);
      existing.set(url, next);
    }
    restored += 1;
  }
  return restored;
}

function normalizeBatchMetrics(metrics) {
  return {
    startedAt: metrics?.startedAt || "",
    completedAt: metrics?.completedAt || "",
    total: Number(metrics?.total || 0),
    concurrency: normalizeBatchConcurrency(metrics?.concurrency || state.batchConcurrency),
    lastHeartbeatAt: metrics?.lastHeartbeatAt || "",
    qualityGateCounts: normalizeBatchQualityGateCounts(metrics?.qualityGateCounts || metrics?.quality_gate_counts)
  };
}

function normalizeBatchQualityGateCounts(value) {
  const reasonSource = value?.reasonCounts || value?.reason_counts || {};
  const reasonCounts = {};
  if (reasonSource && typeof reasonSource === "object") {
    for (const [key, count] of Object.entries(reasonSource)) {
      const normalizedKey = String(key || "").trim();
      if (!normalizedKey) continue;
      reasonCounts[normalizedKey] = Number(count || 0);
    }
  }
  return {
    total: Number(value?.total || 0),
    passed: Number(value?.passed || 0),
    needsReview: Number(value?.needsReview || value?.needs_review || 0),
    reasonCounts
  };
}

function updateBatchQualityGateFromJob(job) {
  const counts = normalizeBatchQualityGateCounts(job?.quality_gate_counts || job?.qualityGateCounts || {});
  if (!counts.total && !counts.needsReview && !counts.passed) return;
  state.batchMetrics = {
    ...normalizeBatchMetrics(state.batchMetrics),
    qualityGateCounts: counts
  };
}

function normalizeBatchConcurrency(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(BATCH_MAX_CONCURRENCY, parsed));
}

function batchConcurrencyLimit() {
  state.batchConcurrency = normalizeBatchConcurrency(state.batchConcurrency);
  return state.batchConcurrency;
}

async function updateBatchConcurrency() {
  state.batchConcurrency = normalizeBatchConcurrency($("batchConcurrencyInput")?.value);
  syncBatchConcurrencyInput();
  await saveBatchQueue();
  renderBatchQueue();
  setBatchStatus(`并发上限已设为 ${state.batchConcurrency}。`);
}

function syncBatchConcurrencyInput() {
  const node = $("batchConcurrencyInput");
  if (node) node.value = String(batchConcurrencyLimit());
}

function serviceItemStatusToLocal(status) {
  if (status === "success") return "success";
  if (status === "failed" || status === "skipped") return "failed";
  if (status === "running") return "running";
  if (status === "canceled") return "canceled";
  return "pending";
}

function normalizeBatchNextPages(value) {
  const rawItems = Array.isArray(value) ? value : [];
  const output = [];
  const seen = new Set();
  for (const item of rawItems) {
    const url = normalizeUrl(item);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    output.push(url);
  }
  return output;
}

function normalizeBatchPaginationCheckpoint(value, fallback = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const nextPages = normalizeBatchNextPages(raw.next_pages || raw.nextPages || fallback.nextPages || fallback.next_pages || []);
  if (!nextPages.length) return null;
  return {
    status: raw.status || "pagination_needed",
    source_id: raw.source_id || raw.sourceId || fallback.sourceId || "",
    source_url: raw.source_url || raw.sourceUrl || fallback.url || "",
    source_title: raw.source_title || raw.sourceTitle || raw.title || fallback.title || fallback.url || "",
    job_id: raw.job_id || raw.jobId || fallback.jobId || "",
    job_item_id: raw.job_item_id || raw.jobItemId || fallback.jobItemId || "",
    next_pages: nextPages,
    next_page_count: Number(raw.next_page_count || raw.nextPageCount || nextPages.length) || nextPages.length,
    captured_at: raw.captured_at || raw.capturedAt || fallback.capturedAt || "",
    profile: raw.profile || fallback.profile || ""
  };
}

function buildBatchPaginationCheckpoint(item, extracted, capture) {
  const nextPages = normalizeBatchNextPages(extracted?.nextPages || []);
  if (!nextPages.length) return null;
  return normalizeBatchPaginationCheckpoint({
    status: "pagination_needed",
    source_id: capture?.source?.id || item.sourceId || "",
    source_url: extracted?.url || item.url || "",
    source_title: extracted?.title || item.title || item.url || "",
    job_id: item.jobId || "",
    job_item_id: item.jobItemId || "",
    next_pages: nextPages,
    next_page_count: nextPages.length,
    captured_at: new Date().toISOString(),
    profile: extracted?.stats?.profile || extracted?.site || ""
  });
}

function applyBatchPaginationCheckpoint(item, checkpoint) {
  const normalized = normalizeBatchPaginationCheckpoint(checkpoint, {
    url: item.url,
    title: item.title,
    sourceId: item.sourceId,
    jobId: item.jobId,
    jobItemId: item.jobItemId,
    nextPages: item.nextPages || []
  });
  item.paginationCheckpoint = normalized;
  item.nextPages = normalized?.next_pages || [];
  return normalized;
}

function parseUrls(raw) {
  return String(raw || "")
    .split(/[\n,]+/)
    .map((line) => normalizeUrl(line.trim()))
    .filter(Boolean);
}

function normalizeUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
      parsed.port = "";
    }
    parsed.hash = "";
    const entries = [...parsed.searchParams.entries()]
      .filter(([key]) => !isTrackingQueryParam(key))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    parsed.search = "";
    for (const [key, value] of entries) {
      parsed.searchParams.append(key, value);
    }
    if (parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function isTrackingQueryParam(key) {
  const lowered = String(key || "").toLowerCase();
  return (
    lowered.startsWith("utm_") ||
    lowered.startsWith("pk_") ||
    [
      "fbclid",
      "gclid",
      "dclid",
      "gbraid",
      "wbraid",
      "msclkid",
      "mc_cid",
      "mc_eid",
      "igshid",
      "_hsenc",
      "_hsmi",
      "spm"
    ].includes(lowered)
  );
}

function inferBatchFailureCategory(error) {
  const text = String(error?.message || error || "").toLowerCase();
  if (!text) return "unknown";
  if (["login", "auth", "unauthorized", "forbidden", "permission", "401", "403", "请登录", "未登录", "权限"].some((marker) => text.includes(marker))) {
    return "auth_required";
  }
  if (["timeout", "timed out", "超时"].some((marker) => text.includes(marker))) {
    return "page_timeout";
  }
  if (["empty", "no content", "no text", "没有抽取", "正文为空"].some((marker) => text.includes(marker))) {
    return "extraction_empty";
  }
  if (["parse", "parser", "json", "readability", "dom", "解析失败"].some((marker) => text.includes(marker))) {
    return "parse_failed";
  }
  if (["duplicate", "dedupe", "already exists", "重复"].some((marker) => text.includes(marker))) {
    return "duplicate";
  }
  if (["pagination", "next page", "next pages", "分页", "下一页"].some((marker) => text.includes(marker))) {
    return "pagination_needed";
  }
  if (["attachment", "download missing", "file missing", "附件", "下载缺失", "文件缺失"].some((marker) => text.includes(marker))) {
    return "attachment_missing";
  }
  if (["net::", "dns", "connection", "offline", "network", "fetch failed", "refused", "网络"].some((marker) => text.includes(marker))) {
    return "network_error";
  }
  if (["service", "companion", "http 500", "http 502", "http 503", "http 504", "服务器", "服务"].some((marker) => text.includes(marker))) {
    return "service_error";
  }
  return "unknown";
}

function batchErrorCategoryLabel(category) {
  const labels = {
    auth_required: "需要登录/权限",
    page_timeout: "页面加载超时",
    extraction_empty: "正文抽取为空",
    parse_failed: "解析失败",
    duplicate: "重复来源",
    service_error: "本地服务错误",
    network_error: "网络错误",
    pagination_needed: "分页未采完",
    attachment_missing: "附件未保存",
    stuck_running: "运行卡住后恢复",
    unknown: "未知失败"
  };
  return labels[category] || category || "未知失败";
}

async function processBatchQueue() {
  if (state.batchRunning) {
    setBatchStatus("批量任务正在运行。");
    return;
  }
  const processable = state.batchQueue.filter((item) => ["pending", "failed", "running"].includes(item.status));
  if (!processable.length) {
    setBatchStatus("没有待处理 URL。");
    return;
  }

  state.batchRunning = true;
  state.batchPaused = false;
  state.batchCancelRequested = false;
  const concurrency = batchConcurrencyLimit();
  startBatchRun(processable.length, concurrency);
  setBusy(true);
  try {
    const preparation = await prepareServiceBackedBatch(processable);
    if (preparation.ready) {
      await processBatchQueueFromService(processable, concurrency);
    } else {
      setBatchStatus(preparation.message);
      await processBatchQueueLocally(processable, concurrency, {
        preparationMessage: preparation.message
      });
    }
  } finally {
    state.batchRunning = false;
    state.batchPaused = false;
    state.batchCancelRequested = false;
    finishBatchRun();
    await saveBatchQueue();
    renderBatchQueue();
    setBusy(false);
  }
}

function startBatchRun(total, concurrency = state.batchConcurrency) {
  state.batchMetrics = {
    startedAt: new Date().toISOString(),
    completedAt: "",
    total: Number(total || 0),
    concurrency: normalizeBatchConcurrency(concurrency),
    lastHeartbeatAt: latestBatchHeartbeatAt(),
    qualityGateCounts: normalizeBatchQualityGateCounts(null)
  };
}

function finishBatchRun() {
  state.batchMetrics = {
    ...normalizeBatchMetrics(state.batchMetrics),
    completedAt: new Date().toISOString(),
    lastHeartbeatAt: latestBatchHeartbeatAt()
  };
}

function batchExecutorId() {
  if (!state.batchExecutorId) {
    state.batchExecutorId = `extension-${crypto.randomUUID()}`;
  }
  return state.batchExecutorId;
}

function batchWorkerExecutorId(workerIndex) {
  return `${batchExecutorId()}-worker-${Number(workerIndex) + 1}`;
}

function batchHeartbeatIntervalMs() {
  const configured = Number(
    state.settings?.batchHeartbeatIntervalMs ||
    globalThis.QCSmartReaderTestConfig?.batchHeartbeatIntervalMs ||
    0
  );
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(MIN_BATCH_HEARTBEAT_INTERVAL_MS, Math.min(configured, DEFAULT_BATCH_HEARTBEAT_INTERVAL_MS));
  }
  return DEFAULT_BATCH_HEARTBEAT_INTERVAL_MS;
}

async function prepareServiceBackedBatch(items) {
  const configured = companionServiceConfigured();
  try {
    await ensureBatchJobItems(items);
    const jobIds = uniqueJobIds(items);
    if (!jobIds.length) {
      const message = configured
        ? "服务端批量准备失败：未能创建或关联服务端任务。已明确切换为浏览器本地队列，每条结果仍会尝试写入 Vault。"
        : "未完成 Companion 配置，已使用浏览器本地队列；写入 Vault 前仍需有效的 Pairing Token。";
      return { ready: false, configured, message };
    }
    for (const jobId of jobIds) {
      const preparationErrors = [];
      try {
        const recovered = await companionRequest(`/v1/jobs/${encodeURIComponent(jobId)}/recover`, {
          method: "POST",
          body: { max_age_seconds: 300 }
        });
        mergeJobIntoBatchQueue(recovered.job);
      } catch (error) {
        preparationErrors.push(error);
        console.warn("Companion job recovery before batch failed.", error);
      }
      try {
        const retried = await companionRequest(`/v1/jobs/${encodeURIComponent(jobId)}/retry-failed`, {
          method: "POST",
          body: {}
        });
        mergeJobIntoBatchQueue(retried.job);
      } catch (error) {
        preparationErrors.push(error);
        console.warn("Companion failed-item reset before batch failed.", error);
      }
      try {
        const resumed = await companionRequest(`/v1/jobs/${encodeURIComponent(jobId)}/resume`, {
          method: "POST",
          body: {}
        });
        mergeJobIntoBatchQueue(resumed.job);
      } catch (error) {
        preparationErrors.push(error);
        console.warn("Companion job resume before batch failed.", error);
      }
      if (preparationErrors.length) throw preparationErrors[0];
    }
    await saveBatchQueue();
    renderBatchQueue();
    return { ready: true, configured, message: "" };
  } catch (error) {
    console.warn("Companion claim-next preparation failed; falling back to local batch loop.", error);
    const detail = shortText(error?.message || String(error || "未知错误"), 160);
    const message = configured
      ? `服务端批量准备失败（${detail}）。已明确切换为浏览器本地队列，每条结果仍会尝试写入 Vault。`
      : `Companion 未配置或不可用（${detail}）。已使用浏览器本地队列。`;
    return { ready: false, configured, message };
  }
}

function companionServiceConfigured() {
  return Boolean(String(state.settings?.serviceUrl || "").trim() && String(state.settings?.pairingToken || "").trim());
}

function isBatchItemRetryable(item) {
  if (item?.status !== "failed") return false;
  if (typeof item.retryable === "boolean") return item.retryable;
  return shouldRetryBatchFailure(item.errorCategory || "unknown", Number(item.browserAttempts || 0));
}

function batchCompletionCounts(items) {
  const counts = { success: 0, failed: 0, retryable: 0, canceled: 0, unfinished: 0 };
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.status === "success") counts.success += 1;
    else if (item?.status === "failed") {
      counts.failed += 1;
      if (isBatchItemRetryable(item)) counts.retryable += 1;
    } else if (item?.status === "canceled") counts.canceled += 1;
    else counts.unfinished += 1;
  }
  return counts;
}

function formatBatchCompletionSummary(items) {
  const counts = batchCompletionCounts(items);
  const parts = [
    `成功 ${counts.success}`,
    `失败 ${counts.failed}`,
    `可重试 ${counts.retryable}`,
    `已取消 ${counts.canceled}`
  ];
  if (counts.unfinished) parts.push(`未完成 ${counts.unfinished}`);
  return parts.join(" · ");
}

function setBatchCompletionStatus(items, lead = "批量处理结束", contextMessage = "") {
  const prefix = contextMessage ? `${contextMessage} ` : "";
  setBatchStatus(`${prefix}${lead}：${formatBatchCompletionSummary(items)}。`);
}

async function processBatchQueueFromService(initialItems, concurrency = 1) {
  const total = initialItems.length;
  let completed = 0;
  let stopReason = "";
  let dispatchError = null;
  const jobIds = uniqueJobIds(initialItems);
  const workerCount = Math.min(normalizeBatchConcurrency(concurrency), Math.max(1, total));

  async function claimNextFromAnyJob(executorId) {
    for (const jobId of jobIds) {
      if (state.batchCancelRequested || state.batchPaused || stopReason) break;
      const claim = await claimNextBatchJobItem(jobId, executorId);
      if (claim.item) return claim;
      if (claim.reason === "paused" || claim.reason === "canceled") {
        stopReason = claim.reason;
        return claim;
      }
    }
    return { item: null, reason: stopReason || "drained" };
  }

  async function worker(workerIndex) {
    const executorId = batchWorkerExecutorId(workerIndex);
    try {
      while (!state.batchCancelRequested && !state.batchPaused && !stopReason) {
        const claim = await claimNextFromAnyJob(executorId);
        if (!claim.item) break;
        const item = localItemForJobItem(claim.job, claim.item);
        if (!item) continue;
        completed += 1;
        const index = completed;
        await processClaimedBatchItem(item, index, total, executorId);
      }
    } catch (error) {
      dispatchError = dispatchError || error;
      stopReason = "error";
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, workerIndex) => worker(workerIndex)));

  if (state.batchCancelRequested) {
    setBatchCompletionStatus(initialItems, "批量任务已取消");
  } else if (state.batchPaused) {
    await pauseBatchJobForItems(initialItems);
    setBatchCompletionStatus(initialItems, "批量任务已暂停");
  } else if (stopReason === "paused") {
    setBatchCompletionStatus(initialItems, "服务端任务已暂停");
  } else if (stopReason === "canceled") {
    setBatchCompletionStatus(initialItems, "服务端任务已取消");
  } else if (dispatchError) {
    setBatchCompletionStatus(
      initialItems,
      `服务端批量执行中断（${shortText(dispatchError.message || String(dispatchError), 140)}）`
    );
  } else {
    setBatchCompletionStatus(initialItems);
  }
}

async function claimNextBatchJobItem(jobId, executorId = batchExecutorId()) {
  const response = await companionRequest(`/v1/jobs/${encodeURIComponent(jobId)}/claim-next`, {
    method: "POST",
    body: {
      executor_id: executorId,
      lease_seconds: 180
    }
  });
  mergeJobIntoBatchQueue(response.job);
  await saveBatchQueue();
  renderBatchQueue();
  return response;
}

function localItemForJobItem(job, jobItem) {
  if (!job?.id || !jobItem?.id) return null;
  let item = state.batchQueue.find((candidate) => candidate.jobId === job.id && candidate.jobItemId === jobItem.id);
  if (!item) {
    mergeJobIntoBatchQueue(job);
    item = state.batchQueue.find((candidate) => candidate.jobId === job.id && candidate.jobItemId === jobItem.id);
  }
  return item || null;
}

async function processClaimedBatchItem(item, index, total, executorId = batchExecutorId()) {
  markBatchItemRunning(item);
  await saveBatchQueue();
  renderBatchQueue();
  setBatchStatus(`正在处理 ${index}/${total}: ${item.url}`);

  const heartbeat = startBatchItemHeartbeat(item, executorId);
  try {
    const { extracted, capture, browserAttempts } = await captureBatchItemWithRetries(item, { index, total });
    markBatchItemCompleted(item, "success");
    item.title = extracted.title || item.url;
    item.sourceId = capture?.source?.id || "";
    item.error = "";
    item.errorCategory = "";
    item.browserAttempts = browserAttempts;
    item.retryable = false;
    const paginationCheckpoint = applyBatchPaginationCheckpoint(item, buildBatchPaginationCheckpoint(item, extracted, capture));
    await updateBatchJobItem(item, "success", {
      executor_id: executorId,
      title: item.title,
      source_id: item.sourceId,
      result: {
        duplicate: Boolean(capture?.duplicate),
        source_id: item.sourceId,
        title: item.title,
        text_length: countCjkAwareChars(extracted.text || ""),
        browser_attempts: browserAttempts,
        max_browser_attempts: BATCH_MAX_BROWSER_ATTEMPTS,
        next_pages: item.nextPages || [],
        pagination_checkpoint: paginationCheckpoint
      }
    });
  } catch (error) {
    markBatchItemCompleted(item, "failed");
    item.error = error.message || String(error);
    item.errorCategory = error.errorCategory || inferBatchFailureCategory(item.error);
    item.browserAttempts = error.browserAttempts || item.browserAttempts || 1;
    item.retryable = shouldRetryBatchFailure(item.errorCategory, item.browserAttempts);
    await updateBatchJobItem(item, "failed", {
      executor_id: executorId,
      error: item.error,
      error_category: item.errorCategory,
      title: item.title || item.url,
      result: {
        browser_attempts: item.browserAttempts,
        max_browser_attempts: BATCH_MAX_BROWSER_ATTEMPTS,
        retry_limit: maxBatchAttemptsForCategory(item.errorCategory),
        retryable: shouldRetryBatchFailure(item.errorCategory, item.browserAttempts)
      }
    });
  } finally {
    clearInterval(heartbeat);
    item.updatedAt = new Date().toISOString();
    await saveBatchQueue();
    renderBatchQueue();
  }
}

function markBatchItemRunning(item) {
  const now = new Date().toISOString();
  item.status = "running";
  item.error = "";
  item.errorCategory = "";
  item.startedAt = item.startedAt || now;
  item.completedAt = "";
  item.updatedAt = now;
}

function markBatchItemCompleted(item, status) {
  const now = new Date().toISOString();
  item.status = status;
  item.completedAt = now;
  item.updatedAt = now;
}

function recordBatchHeartbeat(item, heartbeatAt) {
  const timestamp = heartbeatAt || new Date().toISOString();
  item.lastHeartbeatAt = timestamp;
  item.updatedAt = timestamp;
  state.batchMetrics = {
    ...normalizeBatchMetrics(state.batchMetrics),
    lastHeartbeatAt: timestamp
  };
}

function startBatchItemHeartbeat(item, executorId = batchExecutorId()) {
  return setInterval(async () => {
    if (!item.jobId || !item.jobItemId || item.status !== "running") return;
    try {
      const response = await companionRequest(`/v1/jobs/${encodeURIComponent(item.jobId)}/items/${encodeURIComponent(item.jobItemId)}/heartbeat`, {
        method: "POST",
        body: {
          executor_id: executorId,
          lease_seconds: 180
        }
      });
      const heartbeatAt = response.item?.heartbeat_at || new Date().toISOString();
      recordBatchHeartbeat(item, heartbeatAt);
      await saveBatchQueue();
      renderBatchQueue();
    } catch (error) {
      console.warn("Companion job item heartbeat failed.", error);
    }
  }, batchHeartbeatIntervalMs());
}

async function processBatchQueueLocally(items, concurrency = 1, options = {}) {
  let completed = 0;
  let nextIndex = 0;
  const workerCount = Math.min(normalizeBatchConcurrency(concurrency), Math.max(1, items.length));

  async function worker() {
    while (!state.batchCancelRequested && !state.batchPaused) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (!item) break;
      markBatchItemRunning(item);
      await saveBatchQueue();
      renderBatchQueue();
      await updateBatchJobItem(item, "running");
      setBatchStatus(`正在处理 ${index + 1}/${items.length}: ${item.url}`);

      try {
        const { extracted, capture, browserAttempts } = await captureBatchItemWithRetries(item, {
          index: index + 1,
          total: items.length
        });
        markBatchItemCompleted(item, "success");
        item.title = extracted.title || item.url;
        item.sourceId = capture?.source?.id || "";
        item.error = "";
        item.errorCategory = "";
        item.browserAttempts = browserAttempts;
        item.retryable = false;
        const paginationCheckpoint = applyBatchPaginationCheckpoint(item, buildBatchPaginationCheckpoint(item, extracted, capture));
        await updateBatchJobItem(item, "success", {
          title: item.title,
          source_id: item.sourceId,
          result: {
            duplicate: Boolean(capture?.duplicate),
            source_id: item.sourceId,
            title: item.title,
            text_length: countCjkAwareChars(extracted.text || ""),
            browser_attempts: browserAttempts,
            max_browser_attempts: BATCH_MAX_BROWSER_ATTEMPTS,
            next_pages: item.nextPages || [],
            pagination_checkpoint: paginationCheckpoint
          }
        });
      } catch (error) {
        markBatchItemCompleted(item, "failed");
        item.error = error.message || String(error);
        item.errorCategory = error.errorCategory || inferBatchFailureCategory(item.error);
        item.browserAttempts = error.browserAttempts || item.browserAttempts || 1;
        item.retryable = shouldRetryBatchFailure(item.errorCategory, item.browserAttempts);
        await updateBatchJobItem(item, "failed", {
          error: item.error,
          error_category: item.errorCategory,
          title: item.title || item.url,
          result: {
            browser_attempts: item.browserAttempts,
            max_browser_attempts: BATCH_MAX_BROWSER_ATTEMPTS,
            retry_limit: maxBatchAttemptsForCategory(item.errorCategory),
            retryable: shouldRetryBatchFailure(item.errorCategory, item.browserAttempts)
          }
        });
      } finally {
        item.updatedAt = new Date().toISOString();
        completed += 1;
        await saveBatchQueue();
        renderBatchQueue();
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (state.batchCancelRequested) {
    setBatchCompletionStatus(items, "批量任务已取消", options.preparationMessage || "");
  } else if (state.batchPaused) {
    await pauseBatchJobForItems(items);
    setBatchCompletionStatus(items, "批量任务已暂停", options.preparationMessage || "");
  }
  if (!state.batchPaused && !state.batchCancelRequested) {
    setBatchCompletionStatus(items, "批量处理结束", options.preparationMessage || "");
  }
}

async function captureBatchItemWithRetries(item, context = {}) {
  let lastError = null;
  let lastCategory = "unknown";
  for (let attempt = 1; attempt <= BATCH_MAX_BROWSER_ATTEMPTS; attempt += 1) {
    let tab;
    item.browserAttempts = attempt;
    item.lastAttemptAt = new Date().toISOString();
    item.error = attempt > 1 ? `重试中：${attempt}/${BATCH_MAX_BROWSER_ATTEMPTS}` : "";
    item.errorCategory = "";
    await saveBatchQueue();
    renderBatchQueue();
    const prefix = context.index && context.total ? `${context.index}/${context.total}` : "";
    setBatchStatus(`正在处理 ${prefix ? `${prefix}: ` : ""}${item.url}（尝试 ${attempt}/${BATCH_MAX_BROWSER_ATTEMPTS}）`);
    try {
      tab = await chrome.tabs.create({ url: item.url, active: false });
      await waitForTabComplete(tab.id);
      const extracted = await extractFromTab(tab.id, tab);
      const capture = await saveExtractedToCompanion(extracted, tab);
      return { extracted, capture, browserAttempts: attempt };
    } catch (error) {
      lastError = error;
      lastCategory = inferBatchFailureCategory(error);
      const message = error?.message || String(error);
      if (!shouldRetryBatchFailure(lastCategory, attempt)) {
        throw annotateBatchFailure(error, lastCategory, attempt);
      }
      const delayMs = batchBackoffDelayMs(attempt);
      item.error = `${message}；${Math.round(delayMs / 1000)} 秒后重试 ${attempt + 1}/${BATCH_MAX_BROWSER_ATTEMPTS}`;
      item.errorCategory = lastCategory;
      item.updatedAt = new Date().toISOString();
      await saveBatchQueue();
      renderBatchQueue();
      setBatchStatus(`后台标签失败：${batchErrorCategoryLabel(lastCategory)}，准备重试 ${attempt + 1}/${BATCH_MAX_BROWSER_ATTEMPTS}: ${item.url}`);
      await sleep(delayMs);
    } finally {
      if (tab?.id) {
        try {
          await chrome.tabs.remove(tab.id);
        } catch {
          // Tab may already be closed by the user.
        }
      }
    }
  }
  throw annotateBatchFailure(lastError || new Error("批量采集失败。"), lastCategory, BATCH_MAX_BROWSER_ATTEMPTS);
}

function shouldRetryBatchFailure(category, attempt) {
  return attempt < maxBatchAttemptsForCategory(category);
}

function maxBatchAttemptsForCategory(category) {
  const retryLimit = BATCH_RETRYABLE_FAILURE_LIMITS[category || "unknown"];
  return Math.min(BATCH_MAX_BROWSER_ATTEMPTS, Number(retryLimit || 1));
}

function batchBackoffDelayMs(attempt) {
  return BATCH_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1));
}

function annotateBatchFailure(error, category, browserAttempts) {
  const wrapped = error instanceof Error ? error : new Error(String(error || "批量采集失败。"));
  wrapped.errorCategory = category || "unknown";
  wrapped.browserAttempts = browserAttempts;
  return wrapped;
}

async function extractFromTab(tabId, tab) {
  const result = await extractReadablePageFromTab(tabId);
  const extracted = result || {};
  return {
    title: extracted.title || tab.title || tab.url || "Untitled",
    url: tab.url || extracted.url || "",
    canonicalUrl: extracted.canonicalUrl || normalizeUrl(tab.url || extracted.url || ""),
    text: extracted.text || "",
    markdown: extracted.markdown || extracted.text || "",
    kind: extracted.kind || "page",
    site: extracted.site || inferSiteFromUrl(tab.url || ""),
    author: extracted.author || "",
    publishedAt: extracted.publishedAt || "",
    blocks: extracted.blocks || [],
    images: extracted.images || [],
    attachments: extracted.attachments || [],
    links: extracted.links || [],
    nextPages: extracted.nextPages || [],
    stats: extracted.stats || {},
    quality_flags: extracted.quality_flags || extracted.qualityFlags || {},
    capturedAt: new Date().toISOString()
  };
}

async function extractReadablePageFromTab(tabId) {
  await injectSiteProfileBundle(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractReadablePage
  });
  return result || {};
}

async function injectSiteProfileBundle(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["extractors/browser_site_profiles.js"]
    });
  } catch (error) {
    console.warn("Shared site profile bundle injection failed; falling back to inline extractor.", error);
  }
}

async function saveExtractedToCompanion(extracted, tab) {
  const qualityFlags = extracted.quality_flags || extracted.qualityFlags || {};
  if (extracted.stats?.authRequired || extracted.stats?.auth_required || qualityFlags.authRequired || qualityFlags.auth_required) {
    throw new Error("页面需要登录或权限，无法采集正文。");
  }
  if (!extracted.text?.trim()) {
    throw new Error("没有抽取到正文。");
  }
  return companionRequest("/v1/captures", {
    method: "POST",
    body: {
      project_id: currentProjectId(),
      source: {
        kind: extracted.kind,
        url: extracted.url,
        canonical_url: extracted.canonicalUrl || normalizeUrl(extracted.url),
        title: extracted.title,
        site: extracted.site,
        author: extracted.author,
        published_at: extracted.publishedAt,
        captured_at: extracted.capturedAt
      },
      content: {
        text: extracted.text,
        markdown: extracted.markdown,
        blocks: extracted.blocks,
        images: extracted.images,
        attachments: extracted.attachments,
        links: extracted.links,
        next_pages: extracted.nextPages || [],
        stats: extracted.stats
      },
      browser: {
        tab_id: tab?.id || "",
        window_id: tab?.windowId || ""
      }
    }
  });
}

async function createBatchJob(items) {
  const response = await companionRequest("/v1/jobs/read", {
    method: "POST",
    body: {
      project_id: currentProjectId(),
      items: items.map((item) => ({
        id: item.id,
        url: item.url,
        canonical_url: item.canonicalUrl || normalizeUrl(item.url),
        title: item.title || item.url,
        kind: "url",
        project_id: currentProjectId(),
        added_at: item.addedAt
      })),
      created_at: new Date().toISOString(),
      source: "extension-batch"
    }
  });
  state.currentBatchJobId = response.job?.id || "";
  return response.job || null;
}

async function ensureBatchJobItems(items) {
  const missing = items.filter((item) => !item.jobId || !item.jobItemId);
  if (!missing.length) return;
  const job = await createBatchJob(missing);
  attachJobItemsToQueue(missing, job);
}

function attachJobItemsToQueue(queueItems, job) {
  if (!job?.items?.length) return;
  const byClientId = new Map();
  const byUrl = new Map();
  for (const jobItem of job.items) {
    const clientId = jobItem.input?.client_id;
    if (clientId) byClientId.set(clientId, jobItem);
    if (jobItem.url) byUrl.set(normalizeUrl(jobItem.url), jobItem);
  }
  for (const item of queueItems) {
    const jobItem = byClientId.get(item.id) || byUrl.get(normalizeUrl(item.url));
    if (!jobItem) continue;
    item.jobId = job.id;
    item.jobItemId = jobItem.id;
  }
}

async function updateBatchJobItem(item, status, extra = {}) {
  if (!item.jobId || !item.jobItemId) return;
  try {
    const errorCategory = extra.error_category || extra.failure_category || item.errorCategory || "";
    const response = await companionRequest(`/v1/jobs/${encodeURIComponent(item.jobId)}/items/${encodeURIComponent(item.jobItemId)}/status`, {
      method: "POST",
      body: {
        status,
        title: item.title || item.url,
        source_id: item.sourceId || "",
        error_category: errorCategory,
        ...extra
      }
    });
    if (response.job) {
      mergeJobIntoBatchQueue(response.job);
    }
  } catch (error) {
    console.warn("Companion job item update failed.", error);
  }
}

async function pauseBatchQueue() {
  if (!state.batchRunning) {
    setBatchStatus("没有正在运行的批量任务。");
    return;
  }
  state.batchPaused = true;
  const outcome = await pauseBatchJobForItems(state.batchQueue);
  setBatchStatus(outcome.failed.length
    ? `本地处理已暂停，但 ${outcome.failed.length} 个服务端任务暂停失败；恢复前请先测试本地服务。`
    : "收到暂停请求；当前 URL 处理完后停止。");
}

async function pauseBatchJobForItems(items) {
  return postBatchJobActionForItems(items, "pause");
}

async function cancelBatchQueue() {
  if (!state.batchRunning && !state.batchQueue.some((item) => ["pending", "running", "failed"].includes(item.status))) {
    setBatchStatus("没有可取消的批量任务。");
    return;
  }
  if (!confirm("确认取消当前批量任务？尚未完成的 URL 会被标记为已取消。")) return;
  state.batchCancelRequested = true;
  const cancelable = state.batchQueue.filter((item) => !["success", "canceled"].includes(item.status));
  const previousStates = new Map(cancelable.map((item) => [item.id, {
    status: item.status,
    error: item.error,
    errorCategory: item.errorCategory,
    browserAttempts: item.browserAttempts,
    lastAttemptAt: item.lastAttemptAt,
    completedAt: item.completedAt,
    lastHeartbeatAt: item.lastHeartbeatAt,
    updatedAt: item.updatedAt
  }]));
  for (const item of cancelable) {
    if (item.status !== "running") {
      item.status = "canceled";
      item.error = "";
      item.errorCategory = "";
      item.browserAttempts = 0;
      item.lastAttemptAt = "";
      item.startedAt = item.startedAt || "";
      item.completedAt = new Date().toISOString();
      item.lastHeartbeatAt = "";
      item.updatedAt = new Date().toISOString();
    }
  }
  const outcome = await postBatchJobActionForItems(state.batchQueue, "cancel");
  const failedJobs = new Set(outcome.failed);
  for (const item of cancelable) {
    if (!item.jobId || !failedJobs.has(item.jobId)) continue;
    Object.assign(item, previousStates.get(item.id));
  }
  await saveBatchQueue();
  renderBatchQueue();
  setBatchStatus(outcome.failed.length
    ? `本地队列已停止，但 ${outcome.failed.length} 个服务端任务取消失败；请恢复连接后再次取消。`
    : "已请求取消；当前 URL 如已开始会先收尾。");
}

async function clearCompletedBatchItems() {
  if (state.batchRunning) {
    setBatchStatus("批量任务运行中，不能清理已完成项。");
    return;
  }
  const before = state.batchQueue.length;
  const completed = state.batchQueue.filter((item) => ["success", "canceled"].includes(item.status));
  const outcome = await postBatchJobActionForItems(completed, "clear-completed");
  const failedJobs = new Set(outcome.failed);
  state.batchQueue = state.batchQueue.filter((item) => {
    if (!["success", "canceled"].includes(item.status)) return true;
    return item.jobId && failedJobs.has(item.jobId);
  });
  await saveBatchQueue();
  renderBatchQueue();
  setBatchStatus(outcome.failed.length
    ? `已清理 ${before - state.batchQueue.length} 个已完成项；${outcome.failed.length} 个服务端任务清理失败并保留在列表中。`
    : `已清理 ${before - state.batchQueue.length} 个已完成项。`);
}

async function postBatchJobActionForItems(items, action) {
  const jobIds = [...new Set(items.map((item) => item.jobId).filter(Boolean))];
  const succeeded = [];
  const failed = [];
  for (const jobId of jobIds) {
    try {
      await companionRequest(`/v1/jobs/${encodeURIComponent(jobId)}/${action}`, {
        method: "POST",
        body: {}
      });
      succeeded.push(jobId);
    } catch (error) {
      console.warn(`Companion job ${action} failed.`, error);
      failed.push(jobId);
    }
  }
  return { succeeded, failed };
}

function uniqueJobIds(items) {
  return [...new Set((items || []).map((item) => item.jobId).filter(Boolean))];
}

async function waitForTabComplete(tabId, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      await sleep(800);
      return;
    }
    await sleep(500);
  }
  throw new Error("页面加载超时。");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearBatchQueue() {
  if (state.batchRunning) {
    setBatchStatus("批量任务运行中，不能清空。");
    return;
  }
  if (!state.batchQueue.length) {
    setBatchStatus("队列已经是空的。");
    return;
  }
  if (!confirm("确认清空当前项目的批量队列？未完成的服务端任务会先取消，此操作不能撤销。")) return;
  const cancelable = state.batchQueue.filter((item) => !["success", "skipped", "canceled"].includes(item.status));
  const outcome = await postBatchJobActionForItems(cancelable, "cancel");
  if (outcome.failed.length) {
    setBatchStatus(`清空未执行：${outcome.failed.length} 个服务端任务取消失败，队列已原样保留。`);
    return;
  }
  state.batchQueue = [];
  state.batchMetrics = normalizeBatchMetrics(null);
  await saveBatchQueue();
  renderBatchQueue();
  setBatchStatus("队列已清空。");
}

async function retryBatchItem(itemId) {
  if (state.batchRunning) {
    setBatchStatus("批量任务运行中，不能单独重试。");
    return;
  }
  const item = state.batchQueue.find((candidate) => candidate.id === itemId);
  if (!item) return;
  if (item.jobId && item.jobItemId) {
    try {
      await companionRequest(`/v1/jobs/${encodeURIComponent(item.jobId)}/items/${encodeURIComponent(item.jobItemId)}/retry`, {
        method: "POST",
        body: {}
      });
    } catch (error) {
      console.warn("Companion job item retry failed.", error);
    }
  }
  item.status = "pending";
  item.error = "";
  item.errorCategory = "";
  item.browserAttempts = 0;
  item.lastAttemptAt = "";
  item.startedAt = "";
  item.completedAt = "";
  item.lastHeartbeatAt = "";
  item.sourceId = "";
  item.nextPages = [];
  item.paginationCheckpoint = null;
  item.updatedAt = new Date().toISOString();
  await saveBatchQueue();
  renderBatchQueue();
  setBatchStatus(`已重置为待处理：${item.url}`);
}

async function ingestPdf() {
  const value = $("pdfInput").value.trim();
  if (!value) {
    setPdfImportStatus("请输入 PDF 路径或 URL。");
    return;
  }
  const useOcr = Boolean($("pdfOcrInput").checked);
  setBusy(true);
  $("ingestPdfBtn").textContent = useOcr ? "正在导入（自动 OCR）..." : "正在导入（不使用 OCR）...";
  setPdfImportStatus(`正在导入 PDF；${useOcr ? "已启用扫描件自动 OCR" : "OCR 已关闭"}...`);
  try {
    const payload = /^https?:\/\//i.test(value) ? { url: value } : { path: value };
    payload.project_id = currentProjectId();
    payload.ocr = useOcr;
    const result = await companionRequest("/v1/pdfs/extract", {
      method: "POST",
      body: payload
    });
    const source = result.source || {};
    state.source = {
      title: source.title || value,
      projectId: source.project_id || currentProjectId(),
      url: source.url || value,
      text: source.text || "",
      markdown: source.text || "",
      kind: "pdf",
      site: "pdf",
      sourceId: source.id || "",
      chunks: result.chunks || [],
      markdownPath: source.markdown_path || "",
      stats: {
        profile: result.pdf?.profile || "pdf-pypdf",
        pages: result.pdf?.pages || 0,
        ocrPagesReplaced: Number(result.pdf?.ocr?.pages_replaced || 0),
        quality: result.pdf?.low_text ? 25 : 75
      },
      capturedAt: source.captured_at || new Date().toISOString()
    };
    markCurrentSourceFingerprint();
    renderSource();
    await loadKnowledgeBase();
    const ocrStatus = formatPdfOcrStatus(result.pdf, useOcr);
    setPdfImportStatus(`PDF 已导入：${result.pdf?.pages || 0} 页；${ocrStatus}`);
  } catch (error) {
    setPdfImportStatus(`PDF 导入失败：${error.message}`);
  } finally {
    setBusy(false);
    syncPdfImportMode();
  }
}

function formatPdfOcrStatus(pdf = {}, requested = true) {
  if (!requested) return "OCR 已关闭，使用 PDF 文本层";
  const ocr = pdf?.ocr;
  if (!ocr || typeof ocr !== "object") {
    return pdf?.low_text
      ? "OCR 状态未知，文本层较少（服务端未返回 OCR 结果）"
      : "OCR 状态未知（服务端未返回 OCR 结果）";
  }
  const engine = String(ocr.engine || "").trim();
  const error = String(ocr.error || "").trim();
  const reason = String(ocr.reason || "").trim().toLowerCase();
  if (ocr.applied) {
    return `OCR 已应用${engine ? `（${engine}）` : ""}`;
  }
  if (error) {
    return `OCR 失败，已回退到可用文本${engine ? `（${engine}）` : ""}：${error}`;
  }
  if (reason === "not_needed") {
    return "未需 OCR（PDF 已有可用文本层）";
  }
  if (reason === "disabled") {
    return "OCR 未执行（服务端已禁用），已使用 PDF 文本层";
  }
  if (ocr.attempted) {
    return `OCR 未应用，已回退到 PDF 文本层${engine ? `（${engine}）` : ""}`;
  }
  return "未需 OCR（PDF 已有可用文本层）";
}

function syncPdfImportMode() {
  const button = $("ingestPdfBtn");
  if (!button || state.busy) return;
  button.textContent = $("pdfOcrInput")?.checked ? "导入 PDF（自动 OCR）" : "导入 PDF（不使用 OCR）";
}

function isValidYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    let videoId = "";
    if (host === "youtu.be") {
      videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
    } else if (["youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
      if (parsed.pathname === "/watch") {
        videoId = parsed.searchParams.get("v") || "";
      } else {
        videoId = parsed.pathname.match(/^\/(?:shorts|embed)\/([^/?#]+)/)?.[1] || "";
      }
    }
    return /^[A-Za-z0-9_-]{11}$/.test(videoId);
  } catch (_error) {
    return false;
  }
}

function youtubeImportMode() {
  return $("youtubeTranscriptInput").value.trim() ? "manual" : "automatic";
}

function youtubeLanguageLabel() {
  return $("youtubeLanguageInput").value.trim() || "自动选择";
}

function syncYoutubeImportMode() {
  const button = $("ingestYoutubeBtn");
  if (!button || state.busy) return;
  const mode = youtubeImportMode();
  const language = youtubeLanguageLabel();
  button.dataset.importMode = mode;
  button.textContent = mode === "manual"
    ? `导入手工字幕（manual · ${language}）`
    : `自动获取字幕（automatic · ${language}）`;
}

async function ingestYoutubeTranscript() {
  const url = $("youtubeUrlInput").value.trim();
  const title = $("youtubeTitleInput").value.trim();
  const transcript = $("youtubeTranscriptInput").value.trim();
  const language = $("youtubeLanguageInput").value.trim();
  const mode = transcript ? "manual" : "automatic";
  syncYoutubeImportMode();
  if (!isValidYouTubeUrl(url)) {
    setYoutubeImportStatus("请输入有效的 YouTube URL；标题不能替代来源地址。支持 watch、shorts、embed 和 youtu.be 链接。");
    return;
  }
  setBusy(true);
  $("ingestYoutubeBtn").textContent = mode === "manual"
    ? `正在导入手工字幕（manual · ${language || "未指定语言"}）...`
    : `正在获取公开字幕（automatic · ${language || "自动选择"}）...`;
  setYoutubeImportStatus(
    mode === "manual"
      ? `正在导入手工字幕：manual · 语言 ${language || "未指定"}...`
      : `正在自动获取公开字幕：automatic · 语言优先 ${language || "自动选择"}...`
  );
  try {
    const result = await companionRequest("/v1/youtube/transcripts", {
      method: "POST",
      body: {
        project_id: currentProjectId(),
        url,
        title,
        transcript,
        language,
        captured_at: new Date().toISOString()
      }
    });
    const source = result.source || {};
    const captionSource = String(result.youtube?.caption_source || result.youtube?.source || mode).trim() || mode;
    const captionLanguage = String(result.youtube?.language || language || "未标注").trim();
    state.source = {
      title: source.title || title || url || "YouTube 字幕",
      projectId: source.project_id || currentProjectId(),
      url: source.url || url,
      text: source.text || transcript,
      markdown: source.text || transcript,
      kind: "video",
      site: "youtube",
      sourceId: source.id || "",
      chunks: result.chunks || [],
      markdownPath: source.markdown_path || "",
      stats: {
        profile: "youtube-transcript",
        quality: source.extraction_quality || 75,
        transcriptSegments: result.youtube?.segments || 0,
        captionSource,
        language: captionLanguage
      },
      capturedAt: source.captured_at || new Date().toISOString()
    };
    markCurrentSourceFingerprint();
    renderSource();
    await refreshKnowledgeWorkspace();
    setYoutubeImportStatus(
      `YouTube 字幕已导入：${result.youtube?.segments || 0} 段；${captionSource} · 语言 ${captionLanguage}。`
    );
  } catch (error) {
    setYoutubeImportStatus(
      `YouTube 字幕导入失败（${mode} · ${language || (mode === "automatic" ? "自动选择" : "未指定语言")}）：${error.message}`
    );
  } finally {
    setBusy(false);
    syncYoutubeImportMode();
  }
}

function renderBatchQueue() {
  const list = $("batchList");
  if (!list) return;
  renderBatchProgress();
  list.textContent = "";
  if (!state.batchQueue.length) {
    list.innerHTML = '<p class="hint">队列为空。粘贴 URL 后点击“加入队列”。</p>';
    return;
  }
  for (const item of state.batchQueue) {
    const paginationCheckpoint = normalizeBatchPaginationCheckpoint(item.paginationCheckpoint, {
      url: item.url,
      title: item.title,
      sourceId: item.sourceId,
      jobId: item.jobId,
      jobItemId: item.jobItemId,
      nextPages: item.nextPages || []
    });
    const nextPages = paginationCheckpoint?.next_pages || normalizeBatchNextPages(item.nextPages || []);
    const node = document.createElement("article");
    node.className = "batch-item";
    node.innerHTML = `
      <span class="status-pill">${escapeHtml(item.status)}</span>
      <span>
        <strong>${escapeHtml(item.title || item.url)}</strong>
        <small>${escapeHtml(item.url)}</small>
        ${item.error ? `<small>错误：${escapeHtml(item.error)}</small>` : ""}
        ${item.errorCategory ? `<small>错误类型：${escapeHtml(batchErrorCategoryLabel(item.errorCategory))}</small>` : ""}
        ${item.browserAttempts ? `<small>尝试：${Number(item.browserAttempts)}/${BATCH_MAX_BROWSER_ATTEMPTS}</small>` : ""}
        ${item.startedAt ? `<small>开始：${escapeHtml(formatClockTime(item.startedAt))}</small>` : ""}
        ${item.completedAt ? `<small>结束：${escapeHtml(formatClockTime(item.completedAt))}</small>` : ""}
        ${item.lastHeartbeatAt ? `<small>心跳：${escapeHtml(formatClockTime(item.lastHeartbeatAt))}</small>` : ""}
        ${item.sourceId ? `<small>source: ${escapeHtml(item.sourceId)}</small>` : ""}
        ${item.jobId ? `<small>job: ${escapeHtml(item.jobId)}${item.jobItemId ? ` / ${escapeHtml(item.jobItemId)}` : ""}</small>` : ""}
        ${nextPages.length ? `<small>分页 checkpoint：${nextPages.length} 页待续采</small>` : ""}
        ${["failed", "running"].includes(item.status) ? `<button type="button" class="inline-action" data-retry-id="${escapeHtml(item.id)}">重试</button>` : ""}
        ${nextPages.length ? `<button type="button" class="inline-action" data-batch-next-pages-id="${escapeHtml(item.id)}">分页入候选</button>` : ""}
      </span>
    `;
    node.querySelector("[data-retry-id]")?.addEventListener("click", () => retryBatchItem(item.id));
    node.querySelector("[data-batch-next-pages-id]")?.addEventListener("click", () => createBatchItemNextPageCapturePlans(item.id));
    list.appendChild(node);
  }
}

function renderBatchProgress() {
  const node = $("batchProgress");
  if (!node) return;
  const snapshot = batchProgressSnapshot();
  if (!snapshot.total) {
    node.textContent = "";
    return;
  }
  const parts = [
    `总数 ${snapshot.total}`,
    `并发 ${snapshot.concurrency}`,
    `待处理 ${snapshot.pending}`,
    `运行 ${snapshot.running}`,
    `成功 ${snapshot.success}`,
    `失败 ${snapshot.failed}`,
    `已取消 ${snapshot.canceled}`
  ];
  if (snapshot.qualityNeedsReview > 0) {
    parts.push(`需审查 ${snapshot.qualityNeedsReview}`);
  }
  const timing = [];
  if (snapshot.elapsedMs > 0) timing.push(`耗时 ${formatDurationMs(snapshot.elapsedMs)}`);
  if (state.batchRunning && snapshot.etaMs > 0) timing.push(`预计剩余 ${formatDurationMs(snapshot.etaMs)}`);
  if (snapshot.lastHeartbeatAt) timing.push(`最后心跳 ${formatClockTime(snapshot.lastHeartbeatAt)}`);
  const qualityReasonSummary = formatBatchQualityReasonCounts(snapshot.qualityReasonCounts);
  if (qualityReasonSummary) timing.push(`质量原因 ${qualityReasonSummary}`);
  node.innerHTML = `
    <div>${parts.map(escapeHtml).join(" · ")}</div>
    ${timing.length ? `<small>${timing.map(escapeHtml).join(" · ")}</small>` : ""}
  `;
}

function batchProgressSnapshot() {
  const counts = {
    total: state.batchQueue.length,
    pending: 0,
    running: 0,
    success: 0,
    failed: 0,
    canceled: 0
  };
  for (const item of state.batchQueue) {
    if (Object.prototype.hasOwnProperty.call(counts, item.status)) counts[item.status] += 1;
  }
  const startedAt = state.batchMetrics.startedAt || earliestBatchStartedAt();
  const completedAt = state.batchMetrics.completedAt;
  const elapsedMs = startedAt ? Math.max(0, (completedAt ? parseTimestampMs(completedAt) : Date.now()) - parseTimestampMs(startedAt)) : 0;
  const finishedDurations = state.batchQueue
    .filter((item) => ["success", "failed"].includes(item.status))
    .map((item) => {
      const start = parseTimestampMs(item.startedAt || item.lastAttemptAt || item.addedAt);
      const end = parseTimestampMs(item.completedAt || item.updatedAt);
      return start && end && end >= start ? end - start : 0;
    })
    .filter((duration) => duration > 0);
  const averageMs = finishedDurations.length
    ? finishedDurations.reduce((sum, duration) => sum + duration, 0) / finishedDurations.length
    : 0;
  const remaining = counts.pending + counts.running;
  return {
    ...counts,
    elapsedMs,
    etaMs: averageMs > 0 ? averageMs * remaining : 0,
    concurrency: normalizeBatchConcurrency(state.batchMetrics.concurrency || state.batchConcurrency),
    lastHeartbeatAt: latestBatchHeartbeatAt(),
    qualityNeedsReview: Number(state.batchMetrics.qualityGateCounts?.needsReview || 0),
    qualityReasonCounts: state.batchMetrics.qualityGateCounts?.reasonCounts || {}
  };
}

function formatBatchQualityReasonCounts(reasonCounts) {
  const entries = Object.entries(reasonCounts || {})
    .filter(([, count]) => Number(count || 0) > 0)
    .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0) || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([reason, count]) => `${batchQualityReasonLabel(reason)} ${Number(count || 0)}`);
  return entries.join(" · ");
}

function batchQualityReasonLabel(reason) {
  const labels = {
    low_quality: "低质量",
    low_text: "正文过短",
    truncated: "被截断",
    auth_required: "需登录",
    pagination_needed: "需分页",
    attachment_missing: "缺附件",
    missing_title: "缺标题",
    missing_url: "缺 URL"
  };
  return labels[reason] || reason || "未知";
}

function earliestBatchStartedAt() {
  const timestamps = state.batchQueue
    .map((item) => item.startedAt)
    .filter(Boolean)
    .sort();
  return timestamps[0] || "";
}

function latestBatchHeartbeatAt() {
  const timestamps = [
    state.batchMetrics.lastHeartbeatAt,
    ...state.batchQueue.map((item) => item.lastHeartbeatAt)
  ].filter(Boolean).sort();
  return timestamps[timestamps.length - 1] || "";
}

function parseTimestampMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : 0;
}

function formatClockTime(value) {
  const ms = parseTimestampMs(value);
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDurationMs(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

function setBatchStatus(message) {
  const node = $("batchStatus");
  if (node) node.textContent = message || "";
}

function setPdfImportStatus(message) {
  const text = message || "";
  const node = $("pdfImportStatus");
  if (node) node.textContent = text;
  setBatchStatus(text);
}

function setYoutubeImportStatus(message) {
  const text = message || "";
  const node = $("youtubeImportStatus");
  if (node) node.textContent = text;
  setBatchStatus(text);
}

function setDeliverableStatus(message) {
  const node = $("deliverableStatus");
  if (node) node.textContent = message || "";
}

function setTopicPackageStatus(message) {
  const node = $("topicPackageStatus");
  if (node) node.textContent = message || "";
}

function setStrategyTicketStatus(message) {
  const node = $("strategyTicketStatus");
  if (node) node.textContent = message || "";
}

function setStrategyBacktestStatus(message) {
  const node = $("strategyBacktestStatus");
  if (node) node.textContent = message || "";
}

function setStrategyReviewStatus(message) {
  const node = $("strategyReviewStatus");
  if (node) node.textContent = message || "";
}

function setKnowledgeRecordStatus(message) {
  const node = $("knowledgeRecordStatus");
  setRawNodeText(node, message);
}

function setLocalizedKnowledgeRecordStatus(key, params = {}, fallback = "") {
  setLocalizedNodeText($("knowledgeRecordStatus"), key, params, fallback);
}

function setLearningItemStatus(message) {
  const node = $("learningItemStatus");
  if (node) node.textContent = message || "";
}

async function askAgents() {
  if (!state.source?.text?.trim()) {
    setStatus("请先读取当前页或使用选中文本。");
    return;
  }
  try {
    assertCurrentSourceProject();
  } catch (error) {
    setStatus(error.message);
    return;
  }
  await loadSettings();
  if (!state.settings?.pairingToken) {
    setStatus("请先在设置里填写 Pairing Token。");
    showTab("settings");
    return;
  }
  const provider = selectedModelProvider();
  if (provider === "mock") {
    setStatus("本地模板只生成可审阅的结构化内容，不生成聊天答案。可使用 Quick Start；如需 Agent 阅读，请在设置中选择并配置外部模型。");
    showTab("settings");
    return;
  }
  const blockingReason = externalProviderBlockingReason(provider);
  if (blockingReason) {
    setStatus(`模型调用已阻止：${blockingReason}。`);
    showTab("settings");
    if (!hasCurrentModelDataConsent()) $("modelDataConsentInput")?.focus?.();
    return;
  }

  const selectedAgents = getSelectedAgents();
  if (!selectedAgents.length) {
    setStatus("至少选择一个 Agent。");
    showTab("agents");
    return;
  }

  setBusy(true);
  setStatus("Agent 正在阅读...");
  const requestFingerprint = sourceFingerprint(state.source);
  try {
    const prompt = buildPrompt(selectedAgents);
    const answer = await callLlm(prompt);
    if (!state.source || sourceFingerprint(state.source) !== requestFingerprint) {
      throw new Error("阅读期间来源已经切换，本次答案未绑定也未保存；请在当前来源重新运行。");
    }
    state.lastAnswer = answer;
    state.lastAnswerSourceFingerprint = requestFingerprint;
    renderAnswer("综合讨论", "🤖", answer);
    setStatus("阅读完成。");
  } catch (error) {
    setStatus(`调用失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function getSelectedAgents() {
  const checked = Array.from(document.querySelectorAll("#agentList input:checked")).map((input) => input.value);
  return DEFAULT_AGENTS.filter((agent) => checked.includes(agent.id));
}

function buildPrompt(agents) {
  const question = $("questionInput").value.trim() || "请总结这篇内容。";
  const source = state.source;
  const agentInstructions = agents.map((agent) => `- ${agent.icon} ${agent.name}：${agent.prompt}`).join("\n");

  return `${$("customSystemPrompt").value.trim() || DEFAULT_SYSTEM_PROMPT}

请模拟以下 Agent 同时参与阅读，每个 Agent 必须单独输出一节，然后再给出“综合结论”和“知识库条目草稿”：
${agentInstructions}

用户问题：
${question}

材料元信息：
- 标题：${source.title}
- URL：${source.url}
- 类型：${source.kind}
- 抓取时间：${source.capturedAt}

材料正文：
${source.text}

输出格式：
## Agent 讨论
### <Agent 名称>
- 观点
- 证据
- 追问

## 综合结论
- 核心要点
- 关键推演链
- 可执行启发
- 风险与待验证问题

## 知识库条目草稿
- 标题
- 标签
- 摘要
- 关键结论
- 后续行动`;
}

async function callLlm(prompt) {
  const response = await companionRequest("/v1/llm/chat", {
    method: "POST",
    body: {
      prompt,
      project_id: currentProjectId(),
      source_id: state.source?.sourceId || "",
      agent_id: "multi_agent_reader"
    }
  });
  if (!response.answer) throw new Error("本地服务没有返回模型答案。");
  return response.answer;
}

function renderAnswer(title, icon, body) {
  const card = document.createElement("article");
  card.className = "answer-card";
  card.innerHTML = `
    <header><span>${escapeHtml(icon)}</span><span>${escapeHtml(title)}</span></header>
    <div class="body">${escapeHtml(body)}</div>
  `;
  $("answers").prepend(card);
}

async function saveCurrentNote() {
  if (!state.source) {
    setStatus("没有可保存的来源。");
    return;
  }
  if (state.lastAnswer && state.lastAnswerSourceFingerprint !== sourceFingerprint(state.source)) {
    setStatus("当前答案属于另一个来源，已阻止错绑保存；请对当前来源重新运行阅读。");
    return;
  }
  const note = {
    id: crypto.randomUUID(),
    projectId: currentProjectId(),
    title: state.source.title || "未命名条目",
    url: state.source.url || "",
    kind: state.source.kind || "page",
    capturedAt: state.source.capturedAt || new Date().toISOString(),
    question: $("questionInput").value.trim(),
    answer: state.lastAnswer || "",
    excerpt: (state.source.text || "").slice(0, 4000),
    sourceId: state.source.sourceId || "",
    site: state.source.site || inferSiteFromUrl(state.source.url || ""),
    author: state.source.author || "",
    publishedAt: state.source.publishedAt || ""
  };

  let saved = null;
  try {
    saved = await saveNoteToCompanion(note);
  } catch (error) {
    if (!isOfflineFallbackError(error)) {
      console.warn("Companion note save failed without offline fallback.", error);
      setStatus(`保存失败，未加入本地待同步队列：${error.message}`);
      return;
    }
    console.warn("Companion save is temporarily unavailable; queueing a pending local note.", error);
  }
  if (saved?.note?.id) {
    try {
      await refreshKnowledgeWorkspace();
      setStatus(`已保存到本地 Vault：${saved.note.id}`);
    } catch (error) {
      console.warn("Note save was acknowledged, but workspace refresh failed.", error);
      setStatus(`已保存到本地 Vault：${saved.note.id}；列表刷新失败，可手动刷新。`);
    }
    return;
  }
  if (saved) {
    setStatus("保存失败，未加入本地待同步队列：Vault 响应缺少笔记确认标识。");
    return;
  }

  note.sourceId = state.source?.sourceId || note.sourceId || "";
  note.pendingSync = true;
  note.syncId = note.id;
  note.pendingSince = new Date().toISOString();
  const knowledgeBase = await loadFallbackKnowledgeNotes();
  knowledgeBase.unshift(note);
  await chrome.storage.local.set({ knowledgeBase });
  await loadKnowledgeBase();
  setStatus("本地服务暂时不可达，笔记已安全保存到 Chrome 待同步队列。");
}

async function refreshKnowledgeWorkspace() {
  await loadReviewQueue();
  await loadSourceLibrary();
  await loadKnowledgeBase();
  await loadKnowledgeRecords();
  await loadClaimReviewQueue();
  await loadLearningItems();
}

async function loadReviewQueue() {
  try {
    const responses = await Promise.all(
      ["needs_review", "new", "extracted"].map((status) =>
        companionRequest(`/v1/sources${queryWithProject({ limit: "100", status })}`, { method: "GET" })
      )
    );
    const byId = new Map();
    responses.flatMap((data) => data.sources || []).forEach((source) => {
      if (source.id) byId.set(source.id, source);
    });
    const reviewable = Array.from(byId.values()).sort((a, b) => {
      const left = Date.parse(a.captured_at || a.created_at || "") || 0;
      const right = Date.parse(b.captured_at || b.created_at || "") || 0;
      return right - left;
    });
    renderReviewQueue(reviewable);
    setReviewQueueStatus(reviewable.length ? `${reviewable.length} 条待审来源。` : "暂无待审来源。");
  } catch (error) {
    console.warn("Companion review queue list failed.", error);
    renderReviewQueue([]);
    setReviewQueueStatus(`无法读取待审队列：${error.message}`);
  }
}

function renderReviewQueue(sources) {
  const list = $("reviewQueueList");
  if (!list) return;
  list.textContent = "";
  if (!sources.length) {
    list.innerHTML = '<p class="hint">暂无待审来源。新采集或完成结构化抽取的来源会出现在这里。</p>';
    return;
  }
  for (const source of sources) {
    const node = document.createElement("article");
    node.className = "source-row review-row";
    node.innerHTML = `
      <div>
        <strong>${escapeHtml(source.title || "未命名来源")}</strong>
        <div class="meta">${escapeHtml([source.kind, source.site, source.captured_at || source.created_at, `${Number(source.text_length || 0)} 字`, qualitySummary(source)].filter(Boolean).join(" · "))}</div>
        <span class="source-status ${escapeHtml(source.status || "new")}">${escapeHtml(sourceStatusLabel(source.status))}</span>
        <small>${escapeHtml(source.url || source.id || "")}</small>
      </div>
      <div class="source-actions">
        <button type="button" data-source-detail-id="${escapeHtml(source.id)}">详情</button>
        <button type="button" data-source-use-id="${escapeHtml(source.id)}">设为当前</button>
        <button type="button" data-source-status-id="${escapeHtml(source.id)}" data-source-status="reviewed">接受</button>
        <button type="button" data-source-status-id="${escapeHtml(source.id)}" data-source-status="rejected">拒绝</button>
      </div>
    `;
    bindSourceRowActions(node, source.id);
    list.appendChild(node);
  }
}

function bindSourceRowActions(node, sourceId) {
  node.querySelector("[data-source-detail-id]")?.addEventListener("click", () => loadSourceDetail(sourceId));
  node.querySelector("[data-source-use-id]")?.addEventListener("click", () => loadSourceDetail(sourceId, { setCurrent: true }));
  node.querySelectorAll("[data-source-status-id]").forEach((button) => {
    button.addEventListener("click", () => updateSourceStatus(button.dataset.sourceStatusId, button.dataset.sourceStatus));
  });
}

function setReviewQueueStatus(message) {
  const node = $("reviewQueueStatus");
  if (node) node.textContent = message || "";
}

async function loadSourceLibrary() {
  try {
    const status = $("sourceStatusFilter")?.value || "all";
    const params = status && status !== "all" ? { limit: "100", status } : { limit: "100" };
    const data = await companionRequest(`/v1/sources${queryWithProject(params)}`, { method: "GET" });
    renderSourceLibrary(data.sources || []);
    setSourceLibraryStatus("");
  } catch (error) {
    console.warn("Companion source list failed.", error);
    renderSourceLibrary([]);
    setSourceLibraryStatus(`无法读取来源库：${error.message}`);
  }
}

function renderSourceLibrary(sources) {
  const list = $("sourceList");
  if (!list) return;
  list.textContent = "";
  if (!sources.length) {
    list.innerHTML = '<p class="hint">还没有入库来源。读取网页、批量采集或导入 PDF 后会出现在这里。</p>';
    renderSourceDetail(null);
    return;
  }

  for (const source of sources) {
    const node = document.createElement("article");
    node.className = "source-row";
    node.innerHTML = `
      <div>
        <strong>${escapeHtml(source.title || "未命名来源")}</strong>
        <div class="meta">${escapeHtml([source.kind, source.site, source.captured_at || source.created_at, `${Number(source.text_length || 0)} 字`].filter(Boolean).join(" · "))}</div>
        <span class="source-status ${escapeHtml(source.status || "new")}">${escapeHtml(sourceStatusLabel(source.status))}</span>
        <small>${escapeHtml(source.url || source.id || "")}</small>
      </div>
      <div class="source-actions">
        <button type="button" data-source-detail-id="${escapeHtml(source.id)}">详情</button>
        <button type="button" data-source-use-id="${escapeHtml(source.id)}">设为当前</button>
        <button type="button" data-source-status-id="${escapeHtml(source.id)}" data-source-status="reviewed">reviewed</button>
        <button type="button" data-source-status-id="${escapeHtml(source.id)}" data-source-status="rejected">rejected</button>
      </div>
    `;
    bindSourceRowActions(node, source.id);
    list.appendChild(node);
  }
}

async function loadSourceDetail(sourceId, options = {}) {
  if (!sourceId) return null;
  if (options.setCurrent && state.busy) {
    setSourceLibraryStatus("当前操作尚未完成，暂不能切换来源。");
    return null;
  }
  setBusy(true);
  setSourceLibraryStatus("正在读取来源详情...");
  try {
    const data = await companionRequest(`/v1/sources/${encodeURIComponent(sourceId)}`, { method: "GET" });
    const source = data.source || {};
    state.currentSourceDetailId = source.id || sourceId;
    state.currentSourceDetail = source;
    renderSourceDetail(source);
    if (options.setCurrent) {
      state.source = sourceDetailToCurrentSource(source);
      markCurrentSourceFingerprint();
      renderSource();
      setSourceLibraryStatus("已设为当前来源，可以回到聊天页继续阅读或生成交付物。");
      showTab("chat");
    } else {
      setSourceLibraryStatus("");
    }
    return source;
  } catch (error) {
    setSourceLibraryStatus(`读取来源详情失败：${error.message}`);
    return null;
  } finally {
    setBusy(false);
  }
}

function renderSourceDetail(source) {
  const detail = $("sourceDetail");
  if (!detail) return;
  detail.textContent = "";
  if (!source) return;
  state.currentSourceDetail = source;
  const chunks = Array.isArray(source.chunks) ? source.chunks : [];
  const notes = Array.isArray(source.notes) ? source.notes : [];
  const documents = Array.isArray(source.documents) ? source.documents : [];
  const versions = Array.isArray(source.versions) ? source.versions : [];
  const diff = state.sourceDiffs?.[source.id] || source.diff || null;
  detail.innerHTML = `
    <article class="source-detail-card">
      <h3>${escapeHtml(source.title || "未命名来源")}</h3>
      <div class="meta">${escapeHtml([source.kind, source.site, source.captured_at || source.created_at, source.id].filter(Boolean).join(" · "))}</div>
      <div class="detail-row"><strong>状态</strong><span><span class="source-status ${escapeHtml(source.status || "new")}">${escapeHtml(sourceStatusLabel(source.status))}</span></span></div>
      <div class="detail-row"><strong>抽取质量</strong><span>${Number(source.extraction_quality || 0)}/100 · ${escapeHtml(formatQualityFlags(source.quality_flags || {}))}</span></div>
      <div class="review-actions">
        ${Object.keys(SOURCE_STATUS_LABELS).map((status) => `<button type="button" data-source-status-id="${escapeHtml(source.id)}" data-source-status="${escapeHtml(status)}">${escapeHtml(status)}</button>`).join("")}
        <button type="button" data-source-diff-id="${escapeHtml(source.id)}">查看版本 Diff</button>
        <button type="button" data-source-reextract-id="${escapeHtml(source.id)}">重跑结构化抽取</button>
      </div>
      ${source.url ? `<div class="detail-row"><strong>URL</strong><span>${escapeHtml(source.url)}</span></div>` : ""}
      <div class="detail-row"><strong>原始文件</strong><span>${escapeHtml(source.raw_path || "")}</span></div>
      <div class="detail-row"><strong>摘要文件</strong><span>${escapeHtml(source.markdown_path || "")}</span></div>
      ${versions.length ? `<div class="detail-row"><strong>版本</strong><span>${escapeHtml(formatSourceVersions(versions, source.id))}</span></div>` : ""}
      ${documents.length ? `<div class="detail-row"><strong>文档</strong><span>${escapeHtml(documents.map((item) => `${item.id} · ${item.token_count || 0} tokens`).join("；"))}</span></div>` : ""}
      <div class="detail-row"><strong>Chunks</strong><span>${chunks.length} 个</span></div>
      <div class="detail-row"><strong>关联笔记</strong><span>${notes.length} 条</span></div>
      ${diff ? renderSourceVersionDiff(diff) : ""}
      ${notes.length ? `<div class="linked-notes">${notes.map(renderLinkedNote).join("")}</div>` : ""}
      ${chunks.length ? `<div class="chunk-list">${chunks.slice(0, 12).map(renderSourceChunk).join("")}</div>` : ""}
      <pre>${escapeHtml(shortText(sourceBodyText(source.text || ""), 5000))}</pre>
    </article>
  `;
  detail.querySelectorAll("[data-source-status-id]").forEach((button) => {
    button.addEventListener("click", () => updateSourceStatus(button.dataset.sourceStatusId, button.dataset.sourceStatus));
  });
  detail.querySelectorAll("[data-source-diff-id]").forEach((button) => {
    button.addEventListener("click", () => loadSourceVersionDiff(button.dataset.sourceDiffId));
  });
  detail.querySelectorAll("[data-source-reextract-id]").forEach((button) => {
    button.addEventListener("click", () => reextractSource(button.dataset.sourceReextractId));
  });
}

function formatSourceVersions(versions, sourceId) {
  const current = versions.find((item) => item.source_id === sourceId);
  const latest = versions.find((item) => item.is_current) || versions[versions.length - 1];
  const currentLabel = current ? `当前 v${current.version_index}` : "当前版本未登记";
  const latestLabel = latest ? `最新 v${latest.version_index}` : "";
  return [currentLabel, latestLabel, `${versions.length} 个版本`].filter(Boolean).join(" · ");
}

function renderSourceVersionDiff(diff) {
  const summary = [
    diff.has_compare ? `对比 ${diff.compare_source_id || "上一版"}` : "没有上一版",
    diff.changed ? "内容有变化" : "内容未变化",
    diff.similarity !== undefined ? `相似度 ${Math.round(Number(diff.similarity || 0) * 100)}%` : "",
    diff.added_chars || diff.removed_chars ? `+${Number(diff.added_chars || 0)} / -${Number(diff.removed_chars || 0)} chars` : ""
  ].filter(Boolean).join(" · ");
  const body = diff.unified_diff || diff.reason || "暂无可展示 diff。";
  return `
    <section class="source-version-diff" data-source-version-diff>
      <strong>版本 Diff</strong>
      <small>${escapeHtml(summary)}</small>
      <pre>${escapeHtml(body)}</pre>
    </section>
  `;
}

async function loadSourceVersionDiff(sourceId) {
  if (!sourceId) return null;
  setBusy(true);
  setSourceLibraryStatus("正在读取版本 diff...");
  try {
    const data = await companionRequest(`/v1/sources/${encodeURIComponent(sourceId)}/diff`, { method: "GET" });
    const diff = data.diff || {};
    state.sourceDiffs[sourceId] = diff;
    if (state.currentSourceDetail?.id === sourceId) {
      renderSourceDetail({ ...state.currentSourceDetail, diff });
    } else {
      const detail = $("sourceDetail");
      if (detail) {
        detail.innerHTML = `<article class="source-detail-card">${renderSourceVersionDiff(diff)}</article>`;
      }
    }
    setSourceLibraryStatus(diff.has_compare ? "已读取版本 diff。" : "这个来源还没有上一版可对比。");
    return diff;
  } catch (error) {
    setSourceLibraryStatus(`读取版本 diff 失败：${error.message}`);
    return null;
  } finally {
    setBusy(false);
  }
}

async function updateSourceStatus(sourceId, status) {
  if (!sourceId || !status) return;
  setBusy(true);
  setSourceLibraryStatus(`正在标记为 ${status}...`);
  try {
    const data = await companionRequest(`/v1/sources/${encodeURIComponent(sourceId)}/status`, {
      method: "POST",
      body: { status }
    });
    const source = data.source || {};
    if (state.currentSourceDetailId === sourceId) {
      renderSourceDetail(source);
    }
    if (state.source?.sourceId === sourceId) {
      state.source.sourceStatus = source.status || state.source.sourceStatus || "";
      state.source.markdownPath = source.markdown_path || state.source.markdownPath || "";
      renderSource();
    }
    await refreshSourceListsAfterMutation();
    setSourceLibraryStatus(`已标记为 ${sourceStatusLabel(status)}。`);
  } catch (error) {
    setSourceLibraryStatus(`标记状态失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function refreshSourceListsAfterMutation() {
  for (const refresh of [loadReviewQueue, loadSourceLibrary]) {
    try {
      await refresh();
    } catch (error) {
      console.warn("Source list refresh failed after mutation.", error);
    }
  }
}

function sourceStatusLabel(status) {
  return SOURCE_STATUS_LABELS[status] || "new";
}

function qualitySummary(source) {
  const flags = source?.quality_flags || {};
  const issues = [];
  if (Number(source?.extraction_quality || 0) < 50) issues.push(`quality ${Number(source?.extraction_quality || 0)}/100`);
  if (flags.low_text) issues.push("low text");
  if (flags.truncated) issues.push("truncated");
  if (flags.auth_required) issues.push("auth");
  if (flags.pagination_needed) issues.push("pagination");
  if (flags.attachment_missing) issues.push("attachment");
  if (flags.missing_title || flags.missing_url || (flags.missing_fields || []).length) issues.push("metadata");
  return issues.length ? `需审：${issues.join(", ")}` : "";
}

function renderLinkedNote(note) {
  return `
    <div class="linked-note">
      <strong>${escapeHtml(note.title || note.id)}</strong>
      <small>${escapeHtml([note.created_at, note.markdown_path].filter(Boolean).join(" · "))}</small>
      ${note.question ? `<p>${escapeHtml(shortText(note.question, 180))}</p>` : ""}
    </div>
  `;
}

function renderSourceChunk(chunk) {
  const meta = [
    `#${chunk.index ?? ""}`,
    chunk.id,
    `${Number(chunk.length || 0)} 字`,
    chunk.page_start ? `page ${chunk.page_start}${chunk.page_end && chunk.page_end !== chunk.page_start ? `-${chunk.page_end}` : ""}` : "",
    chunk.timestamp_start !== null && chunk.timestamp_start !== undefined ? `time ${formatTimestamp(chunk.timestamp_start)}${chunk.timestamp_end && chunk.timestamp_end !== chunk.timestamp_start ? `-${formatTimestamp(chunk.timestamp_end)}` : ""}` : "",
    chunk.heading_path || ""
  ].filter(Boolean).join(" · ");
  return `
    <div class="source-chunk">
      <small>${escapeHtml(meta)}</small>
      <p>${escapeHtml(shortText(chunk.snippet || "", 360))}</p>
    </div>
  `;
}

function formatQualityFlags(flags) {
  const active = Object.entries(flags || {})
    .filter(([, value]) => Array.isArray(value) ? value.length : Boolean(value))
    .map(([key, value]) => Array.isArray(value) ? `${key}: ${value.join(", ")}` : key);
  return active.join("；") || "无明显质量标记";
}

function formatTimestamp(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function sourceDetailToCurrentSource(source) {
  const text = sourceBodyText(source.text || "");
  const current = {
    title: source.title || "未命名来源",
    projectId: source.project_id || currentProjectId(),
    url: source.url || "",
    text,
    markdown: text,
    kind: source.kind || "page",
    site: source.site || inferSiteFromUrl(source.url || ""),
    author: source.author || "",
    publishedAt: source.published_at || "",
    capturedAt: source.captured_at || source.created_at || new Date().toISOString(),
    sourceId: source.id || "",
    sourceStatus: source.status || "",
    chunks: source.chunks || [],
    markdownPath: source.markdown_path || "",
    stats: {
      profile: source.site || source.kind || "source",
      textChars: countCjkAwareChars(source.text || ""),
      pages: Math.max(...(source.chunks || []).map((chunk) => Number(chunk.page_end || chunk.page_start || 0)), 0),
      quality: source.extraction_quality || (source.text ? 80 : 20)
    },
    quality_flags: source.quality_flags || {}
  };
  current.sourceFingerprint = sourceFingerprint(current);
  return current;
}

function sourceBodyText(value) {
  const text = String(value || "");
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function setSourceLibraryStatus(message) {
  const node = $("sourceLibraryStatus");
  if (node) node.textContent = message || "";
}

async function searchSourcesAndChunks() {
  const query = $("sourceSearchInput").value.trim();
  if (!query) {
    setSourceSearchStatus("请输入搜索关键词。");
    return;
  }
  setBusy(true);
  setSourceSearchStatus("正在搜索来源、chunks 和笔记...");
  try {
    const data = await companionRequest("/v1/search", {
      method: "POST",
      body: { query, limit: 20, project_id: currentProjectId() }
    });
    renderSourceSearchResults(data);
    const count = (data.sources?.length || 0) + (data.chunks?.length || 0) + (data.notes?.length || 0);
    setSourceSearchStatus(`找到 ${count} 条结果。`);
  } catch (error) {
    renderSourceSearchResults({});
    setSourceSearchStatus(`搜索失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function clearSourceSearch() {
  $("sourceSearchInput").value = "";
  renderSourceSearchResults({});
  setSourceSearchStatus("");
}

function renderSourceSearchResults(results) {
  const container = $("sourceSearchResults");
  if (!container) return;
  container.textContent = "";
  const sources = Array.isArray(results.sources) ? results.sources : [];
  const chunks = Array.isArray(results.chunks) ? results.chunks : [];
  const notes = Array.isArray(results.notes) ? results.notes : [];
  if (!sources.length && !chunks.length && !notes.length) return;
  const sourceResults = sources.map((source) => `
    <div class="search-result">
      <strong>${escapeHtml(source.title || source.id)}</strong>
      <small>${escapeHtml([source.kind, source.site, source.captured_at, source.url].filter(Boolean).join(" · "))}</small>
      <button type="button" data-source-detail-id="${escapeHtml(source.id)}">打开来源</button>
    </div>
  `).join("");
  const chunkResults = chunks.map((chunk) => `
    <div class="search-result">
      <strong>${escapeHtml(chunk.title || chunk.source_id)}</strong>
      <small>${escapeHtml([`chunk #${chunk.chunk_index}`, chunk.source_id, chunk.url].filter(Boolean).join(" · "))}</small>
      <p>${escapeHtml(shortText(chunk.snippet || "", 420))}</p>
      <button type="button" data-source-detail-id="${escapeHtml(chunk.source_id)}">打开来源</button>
    </div>
  `).join("");
  const noteResults = notes.map((note) => {
    const tags = Array.isArray(note.tags) && note.tags.length ? `tags: ${note.tags.join(", ")}` : "";
    const body = note.answer || note.summary || note.excerpt || note.question || "";
    const sourceButton = note.source_id ? `<button type="button" data-source-detail-id="${escapeHtml(note.source_id)}">打开来源</button>` : "";
    return `
      <div class="search-result">
        <strong>${escapeHtml(note.title || note.id)}</strong>
        <small>${escapeHtml([note.created_at, note.source_site, note.source_url, tags].filter(Boolean).join(" · "))}</small>
        <p>${escapeHtml(shortText(body, 420))}</p>
        ${sourceButton}
      </div>
    `;
  }).join("");
  container.innerHTML = `
    ${sourceResults ? `<article class="kb-item"><h3>来源结果 (${sources.length})</h3><div class="record-list">${sourceResults}</div></article>` : ""}
    ${chunkResults ? `<article class="kb-item"><h3>片段结果 (${chunks.length})</h3><div class="record-list">${chunkResults}</div></article>` : ""}
    ${noteResults ? `<article class="kb-item"><h3>笔记结果 (${notes.length})</h3><div class="record-list">${noteResults}</div></article>` : ""}
  `;
  container.querySelectorAll("[data-source-detail-id]").forEach((button) => {
    button.addEventListener("click", () => loadSourceDetail(button.dataset.sourceDetailId));
  });
}

function setSourceSearchStatus(message) {
  const node = $("sourceSearchStatus");
  if (node) node.textContent = message || "";
}

async function loadKnowledgeBase() {
  const localNotes = fallbackKnowledgeNotesForProject(await loadFallbackKnowledgeNotes());
  try {
    const data = await companionRequest(`/v1/notes${queryWithProject({ limit: "100" })}`, { method: "GET" });
    renderKnowledgeBase(data.notes || [], "Vault", localNotes);
    setPendingNotesStatus(localNotes.length, { serviceAvailable: true });
    return;
  } catch (error) {
    console.warn("Companion note list failed; keeping pending Chrome notes visible.", error);
    renderKnowledgeBase([], "Vault", localNotes);
    setPendingNotesStatus(localNotes.length, {
      serviceAvailable: false,
      error,
      offline: isOfflineFallbackError(error)
    });
  }
}

function fallbackKnowledgeNoteProjectId(note) {
  return String(note?.projectId || note?.project_id || "").trim();
}

async function loadFallbackKnowledgeNotes() {
  const { knowledgeBase = [] } = await chrome.storage.local.get("knowledgeBase");
  const stored = Array.isArray(knowledgeBase) ? knowledgeBase : [];
  let migrated = !Array.isArray(knowledgeBase);
  const normalized = stored
    .filter((note) => {
      const valid = isRecord(note);
      if (!valid) migrated = true;
      return valid;
    })
    .map((note) => {
      const projectId = fallbackKnowledgeNoteProjectId(note) || FALLBACK_LEGACY_PROJECT_ID;
      const id = String(note.id || "").trim() || `local-note-${crypto.randomUUID()}`;
      const pendingSync = true;
      const syncId = String(note.syncId || id).trim();
      if (note.id === id && note.projectId === projectId && note.pendingSync === pendingSync && note.syncId === syncId) return note;
      migrated = true;
      return { ...note, id, projectId, pendingSync, syncId };
    });
  if (migrated) await chrome.storage.local.set({ knowledgeBase: normalized });
  return normalized;
}

function fallbackKnowledgeNotesForProject(notes, projectId = currentProjectId()) {
  const normalizedProjectId = String(projectId || FALLBACK_LEGACY_PROJECT_ID);
  return (Array.isArray(notes) ? notes : []).filter(
    (note) => fallbackKnowledgeNoteProjectId(note) === normalizedProjectId
  );
}

function renderKnowledgeBase(knowledgeBase, sourceType, pendingNotes = []) {
  const list = $("kbList");
  list.textContent = "";
  const entries = [
    ...(Array.isArray(pendingNotes) ? pendingNotes : []).map((item) => ({ item, pending: true })),
    ...(Array.isArray(knowledgeBase) ? knowledgeBase : []).map((item) => ({ item, pending: false }))
  ];
  if (!entries.length) {
    list.innerHTML = '<p class="hint">还没有知识库条目。阅读完成后点击“保存笔记”。</p>';
    return;
  }

  for (const entry of entries) {
    const { item, pending } = entry;
    const node = document.createElement("article");
    node.className = pending ? "kb-item pending-sync" : "kb-item";
    const createdAt = item.created_at || item.capturedAt || "";
    const sourceUrl = item.source_url || item.url || "";
    const body = item.answer || item.summary || item.excerpt || "";
    const location = pending ? "Chrome · 待同步" : sourceType;
    node.innerHTML = `
      <h3>${escapeHtml(item.title)}</h3>
      <div class="meta">${escapeHtml(location)} · ${escapeHtml(createdAt)} · ${escapeHtml(sourceUrl)}</div>
      <pre>${escapeHtml(body)}</pre>
    `;
    list.appendChild(node);
  }
}

function pendingNoteSyncTag(note) {
  const syncId = String(note?.syncId || note?.id || "").trim();
  return syncId ? `${PENDING_NOTE_SYNC_TAG_PREFIX}${syncId}` : "";
}

function vaultNoteHasPendingSyncTag(note, tag) {
  return Boolean(tag && Array.isArray(note?.tags) && note.tags.includes(tag));
}

function setPendingNotesStatus(count, options = {}) {
  const pendingCount = Math.max(0, Number(count || 0));
  const status = $("pendingNotesStatus");
  const button = $("syncPendingNotesBtn");
  if (button) button.disabled = pendingCount === 0 || Boolean(options.syncing);
  if (!status) return;
  if (options.message) {
    status.textContent = options.message;
    return;
  }
  if (!pendingCount) {
    status.textContent = "待同步 0 条本地笔记。";
    return;
  }
  if (options.serviceAvailable) {
    status.textContent = `待同步 ${pendingCount} 条本地笔记；Vault 已连接，可立即同步。`;
    return;
  }
  const detail = shortText(options.error?.message || "本地服务不可用", 140);
  status.textContent = options.offline
    ? `待同步 ${pendingCount} 条本地笔记；Vault 暂时不可达：${detail}`
    : `待同步 ${pendingCount} 条本地笔记；Vault 连接错误，未自动降级：${detail}`;
}

async function syncPendingNotes() {
  const projectId = currentProjectId();
  const pending = fallbackKnowledgeNotesForProject(await loadFallbackKnowledgeNotes(), projectId);
  if (!pending.length) {
    setPendingNotesStatus(0);
    return;
  }

  setPendingNotesStatus(pending.length, {
    syncing: true,
    message: `正在同步 ${pending.length} 条本地笔记到 Vault...`
  });
  let vaultNotes;
  try {
    const data = await companionRequest(`/v1/notes${queryWithProject({ limit: "1000" })}`, { method: "GET" });
    vaultNotes = data.notes || [];
  } catch (error) {
    setPendingNotesStatus(pending.length, {
      message: `同步未开始，待同步 ${pending.length} 条：${error.message}`
    });
    return;
  }

  const acknowledgedIds = new Set();
  let posted = 0;
  let alreadyPresent = 0;
  let syncError = null;
  for (const note of pending) {
    const tag = pendingNoteSyncTag(note);
    if (vaultNotes.some((vaultNote) => vaultNoteHasPendingSyncTag(vaultNote, tag))) {
      acknowledgedIds.add(note.id);
      alreadyPresent += 1;
      continue;
    }
    try {
      const saved = await savePendingNoteToCompanion(note, tag);
      if (!saved?.note?.id) throw new Error("Vault 未确认笔记已写入。");
      acknowledgedIds.add(note.id);
      posted += 1;
      vaultNotes.push(saved.note);
    } catch (error) {
      syncError = error;
      break;
    }
  }

  if (acknowledgedIds.size) {
    const latest = await loadFallbackKnowledgeNotes();
    const remaining = latest.filter((note) => (
      fallbackKnowledgeNoteProjectId(note) !== projectId || !acknowledgedIds.has(note.id)
    ));
    await chrome.storage.local.set({ knowledgeBase: remaining });
  }

  await loadKnowledgeBase();
  const remainingCount = fallbackKnowledgeNotesForProject(await loadFallbackKnowledgeNotes(), projectId).length;
  if (syncError) {
    setPendingNotesStatus(remainingCount, {
      message: `同步暂停：${syncError.message}。已确认 ${acknowledgedIds.size} 条，待同步 ${remainingCount} 条。`
    });
    return;
  }
  setPendingNotesStatus(remainingCount, {
    message: `同步完成：新增 ${posted} 条，已在 Vault ${alreadyPresent} 条，待同步 ${remainingCount} 条。`
  });
}

async function loadDeliverables() {
  try {
    const data = await companionRequest(`/v1/deliverables${queryWithProject({ limit: "50" })}`, { method: "GET" });
    renderDeliverables(data.deliverables || []);
    setDeliverableStatus("");
  } catch (error) {
    console.warn("Companion deliverables list failed.", error);
    renderDeliverables([]);
    setDeliverableStatus(`无法读取交付物：${error.message}`);
  }
}

async function loadTopicPackages() {
  const selected = new Set(getSelectedTopicPackageIds());
  try {
    const data = await companionRequest(`/v1/topic-packages${queryWithProject({ limit: "50" })}`, { method: "GET" });
    state.topicPackages = data.topic_packages || [];
    renderTopicPackages(state.topicPackages, selected);
    setTopicPackageStatus("");
  } catch (error) {
    console.warn("Companion topic package list failed.", error);
    state.topicPackages = [];
    renderTopicPackages([]);
    setTopicPackageStatus(`无法读取专题包：${error.message}`);
  }
}

function renderTopicPackages(topicPackages, selected = new Set()) {
  const list = $("topicPackageList");
  if (!list) return;
  list.textContent = "";
  if (!topicPackages.length) {
    list.innerHTML = '<p class="hint">还没有专题包。先在知识库里抽取并审阅 claims，再由服务端生成 topic package。</p>';
    return;
  }
  for (const topic of topicPackages) {
    const label = document.createElement("label");
    label.className = "topic-package-option";
    const checked = selected.has(topic.id) ? "checked" : "";
    const stale = topic.stale ? "stale" : "fresh";
    label.innerHTML = `
      <input type="checkbox" value="${escapeHtml(topic.id)}" ${checked}>
      <span>
        <strong>${escapeHtml(shortText(topic.title || topic.id, 120))}</strong>
        <small>${escapeHtml(topic.status || "draft")} · review ${escapeHtml(topic.review_status || "needs_review")} · evidence ${escapeHtml(topic.evidence_strength || "unknown")} · ${escapeHtml(stale)}</small>
        <small>claims ${(topic.claim_ids || []).length} · sources ${(topic.source_ids || []).length}</small>
      </span>
    `;
    list.appendChild(label);
  }
}

function getSelectedTopicPackageIds() {
  return [...document.querySelectorAll("#topicPackageList input[type='checkbox']:checked")]
    .map((input) => input.value)
    .filter(Boolean);
}

function renderDeliverables(deliverables) {
  const list = $("deliverableList");
  if (!list) return;
  list.textContent = "";
  if (!deliverables.length) {
    list.innerHTML = '<p class="hint">还没有交付物。读取并分析一篇材料后，点击“生成交付物”。</p>';
    return;
  }

  for (const item of deliverables) {
    const node = document.createElement("article");
    node.className = "kb-item";
    const gate = item.ready_gate || {};
    const gateLabel = gate.passed ? "Gate passed" : `Gate issues ${Number(gate.issue_count || 0)}`;
    const topicCount = Number(gate.topic_package_count || item.input?.topic_package_ids?.length || 0);
    const canCreateHandoff = item.kind === "strategy_task_brief" && item.status === "final";
    node.innerHTML = `
      <h3>${escapeHtml(item.title)}</h3>
      <div class="meta">${escapeHtml(deliverableKindLabel(item.kind))} · ${escapeHtml(item.status || "draft")} · ${escapeHtml(gateLabel)} · topic ${topicCount} · 待验证 ${Number(item.unsupported_claims || 0)} · ${escapeHtml(item.created_at || "")}</div>
      <div class="deliverable-path">${escapeHtml(item.markdown_path || "")}</div>
      ${canCreateHandoff ? `<div class="source-actions"><button type="button" data-create-handoff-id="${escapeHtml(item.id)}">生成策略交接包</button></div>` : ""}
    `;
    node.querySelector("[data-create-handoff-id]")?.addEventListener("click", () => createStrategyHandoffFromDeliverable(item.id));
    list.appendChild(node);
  }
}

async function createStrategyHandoffFromDeliverable(deliverableId) {
  if (!deliverableId) return;
  setBusy(true);
  setDeliverableStatus("正在生成策略交接包...");
  try {
    const result = await companionRequest("/v1/strategy-handoffs", {
      method: "POST",
      body: { deliverable_id: deliverableId }
    });
    await loadStrategyWorkspace();
    const handoff = result.strategy_handoff || {};
    if (handoff.id && $("strategyHandoffSelect")) {
      $("strategyHandoffSelect").value = handoff.id;
      renderSelectedStrategyWorkspace();
    }
    setDeliverableStatus(`已生成策略交接包：${handoff.markdown_path || handoff.id || "ok"}`);
  } catch (error) {
    setDeliverableStatus(`生成策略交接包失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function loadStrategyWorkspace() {
  const selectedHandoffId = $("strategyHandoffSelect")?.value || "";
  try {
    const [handoffData, ticketData, backtestData, reviewData] = await Promise.all([
      companionRequest(`/v1/strategy-handoffs${queryWithProject({ limit: "50" })}`, { method: "GET" }),
      companionRequest(`/v1/strategy-tickets${queryWithProject({ limit: "100" })}`, { method: "GET" }),
      companionRequest(`/v1/backtest-results${queryWithProject({ limit: "100" })}`, { method: "GET" }),
      companionRequest(`/v1/strategy-reviews${queryWithProject({ limit: "100" })}`, { method: "GET" })
    ]);
    state.strategyHandoffs = handoffData.strategy_handoffs || [];
    state.strategyTickets = ticketData.strategy_tickets || [];
    state.backtestResults = backtestData.backtest_results || [];
    state.strategyReviews = reviewData.strategy_reviews || [];
    renderStrategyHandoffSelect(selectedHandoffId);
    renderSelectedStrategyWorkspace();
    const selected = selectedStrategyHandoff();
    const ticketCount = selected
      ? state.strategyTickets.filter((ticket) => ticket.handoff_id === selected.id).length
      : state.strategyTickets.length;
    setStrategyTicketStatus(
      state.strategyHandoffs.length
        ? `${state.strategyHandoffs.length} 个交接包，当前 ${ticketCount} 张票据。`
        : "暂无策略交接包。先生成 final 策略任务单，再创建 handoff。"
    );
    setStrategyBacktestStatus("");
    setStrategyReviewStatus("");
  } catch (error) {
    console.warn("Companion strategy workspace load failed.", error);
    state.strategyHandoffs = [];
    state.strategyTickets = [];
    state.backtestResults = [];
    state.strategyReviews = [];
    renderStrategyHandoffSelect("");
    renderSelectedStrategyWorkspace();
    setStrategyTicketStatus(`无法读取策略票据：${error.message}`);
    setStrategyBacktestStatus(`无法读取回测反馈：${error.message}`);
    setStrategyReviewStatus(`无法读取策略审查：${error.message}`);
  }
}

function renderSelectedStrategyWorkspace() {
  renderStrategyTickets(state.strategyTickets);
  renderBacktestResults(state.backtestResults);
  renderStrategyReviewBacktestSelect();
  renderStrategyReviewChecklist();
  renderStrategyReviews(state.strategyReviews);
}

function renderStrategyHandoffSelect(selectedHandoffId = "") {
  const select = $("strategyHandoffSelect");
  if (!select) return;
  const previous = selectedHandoffId || select.value || "";
  if (!state.strategyHandoffs.length) {
    select.innerHTML = '<option value="">暂无策略交接包</option>';
    select.value = "";
    return;
  }
  select.innerHTML = state.strategyHandoffs.map((handoff) => {
    const label = [
      shortText(handoff.title || handoff.id, 86),
      handoff.status || "drafted",
      handoff.updated_at || handoff.created_at || ""
    ].filter(Boolean).join(" · ");
    return `<option value="${escapeHtml(handoff.id)}">${escapeHtml(label)}</option>`;
  }).join("");
  select.value = state.strategyHandoffs.some((handoff) => handoff.id === previous)
    ? previous
    : state.strategyHandoffs[0].id;
}

function selectedStrategyHandoff() {
  const handoffId = $("strategyHandoffSelect")?.value || "";
  return state.strategyHandoffs.find((handoff) => handoff.id === handoffId) || null;
}

function renderStrategyTickets(tickets) {
  const list = $("strategyTicketList");
  if (!list) return;
  list.textContent = "";
  const selected = selectedStrategyHandoff();
  const visibleTickets = selected
    ? tickets.filter((ticket) => ticket.handoff_id === selected.id)
    : tickets;
  if (!visibleTickets.length) {
    list.innerHTML = '<p class="hint">当前交接包还没有实现票据。</p>';
    return;
  }
  const statusOrder = { "in-progress": 0, open: 1, blocked: 2, done: 3, canceled: 4 };
  const sorted = [...visibleTickets].sort((left, right) => {
    const statusDelta = (statusOrder[left.status] ?? 9) - (statusOrder[right.status] ?? 9);
    if (statusDelta) return statusDelta;
    return String(left.kind || "").localeCompare(String(right.kind || ""));
  });
  for (const ticket of sorted) {
    const node = document.createElement("article");
    node.className = "strategy-ticket-card";
    const claimCount = (ticket.claim_ids || []).length;
    const evidenceCount = (ticket.evidence_ids || []).length;
    node.innerHTML = `
      <div class="strategy-ticket-main">
        <span class="status-pill ${escapeHtml(ticket.status || "open")}">${escapeHtml(ticket.status || "open")}</span>
        <span>
          <strong>${escapeHtml(ticket.title || ticket.id)}</strong>
          <small>${escapeHtml(strategyTicketKindLabel(ticket.kind))} · owner ${escapeHtml(ticket.owner || "unassigned")} · claims ${claimCount} · evidence ${evidenceCount}</small>
          <p>${escapeHtml(shortText(ticket.objective || "", 260))}</p>
          ${ticket.markdown_path ? `<small class="deliverable-path">${escapeHtml(ticket.markdown_path)}</small>` : ""}
        </span>
      </div>
      <div class="strategy-ticket-actions">
        <button type="button" data-ticket-id="${escapeHtml(ticket.id)}" data-ticket-status="in-progress">领取</button>
        <button type="button" data-ticket-id="${escapeHtml(ticket.id)}" data-ticket-status="done">完成</button>
        <button type="button" data-ticket-id="${escapeHtml(ticket.id)}" data-ticket-status="blocked">阻塞</button>
        <button type="button" data-ticket-id="${escapeHtml(ticket.id)}" data-ticket-status="open">重开</button>
      </div>
    `;
    node.querySelectorAll("[data-ticket-status]").forEach((button) => {
      button.addEventListener("click", () => updateStrategyTicketStatus(button.dataset.ticketId, button.dataset.ticketStatus));
    });
    list.appendChild(node);
  }
}

async function generateStrategyTickets() {
  const handoff = selectedStrategyHandoff();
  if (!handoff?.id) {
    setStrategyTicketStatus("请选择策略交接包。");
    return;
  }
  setBusy(true);
  setStrategyTicketStatus("正在生成/补齐实现票据...");
  try {
    const owner = $("strategyTicketOwnerInput")?.value.trim() || "";
    const result = await companionRequest("/v1/strategy-tickets", {
      method: "POST",
      body: { handoff_id: handoff.id, owner }
    });
    await loadStrategyWorkspace();
    setStrategyTicketStatus(`已同步 ${result.strategy_tickets?.length || 0} 张实现票据。`);
  } catch (error) {
    setStrategyTicketStatus(`生成票据失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function updateStrategyTicketStatus(ticketId, status) {
  if (!ticketId || !status) return;
  setBusy(true);
  setStrategyTicketStatus("正在更新票据状态...");
  try {
    const owner = $("strategyTicketOwnerInput")?.value.trim() || "";
    const body = { status };
    if (owner) body.owner = owner;
    const result = await companionRequest(`/v1/strategy-tickets/${encodeURIComponent(ticketId)}/status`, {
      method: "POST",
      body
    });
    await loadStrategyWorkspace();
    setStrategyTicketStatus(`已更新：${result.strategy_ticket?.title || ticketId} -> ${status}`);
  } catch (error) {
    setStrategyTicketStatus(`更新票据失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function strategyTicketKindLabel(kind) {
  return {
    data_ingestion: "数据接入",
    signal_code: "信号代码",
    portfolio_backtest: "组合回测",
    risk_controls: "风控",
    backtest_report: "回测报告",
    monitoring: "监控"
  }[kind] || kind || "implementation";
}

function currentHandoffBacktests() {
  const handoff = selectedStrategyHandoff();
  return handoff
    ? state.backtestResults.filter((result) => result.handoff_id === handoff.id)
    : state.backtestResults;
}

function renderBacktestResults(results) {
  const list = $("strategyBacktestList");
  if (!list) return;
  list.textContent = "";
  const visibleResults = currentHandoffBacktests();
  if (!visibleResults.length) {
    list.innerHTML = '<p class="hint">当前交接包还没有回测结果。</p>';
    return;
  }
  for (const result of visibleResults) {
    const node = document.createElement("article");
    node.className = "strategy-feedback-card";
    const metricSummary = Object.entries(result.metrics || {})
      .slice(0, 4)
      .map(([key, value]) => `${key}: ${value}`)
      .join(" · ");
    node.innerHTML = `
      <div class="strategy-ticket-main">
        <span class="status-pill ${escapeHtml(result.status || "imported")}">${escapeHtml(result.status || "imported")}</span>
        <span>
          <strong>${escapeHtml(result.outcome || result.id)}</strong>
          <small>${escapeHtml(result.period || "")} · ${escapeHtml(result.universe || "")}</small>
          ${metricSummary ? `<p>${escapeHtml(metricSummary)}</p>` : ""}
          ${result.failure_notes ? `<p>${escapeHtml(shortText(result.failure_notes, 220))}</p>` : ""}
          ${result.markdown_path ? `<small class="deliverable-path">${escapeHtml(result.markdown_path)}</small>` : ""}
        </span>
      </div>
    `;
    list.appendChild(node);
  }
}

function renderStrategyReviewBacktestSelect(selectedResultId = "") {
  const select = $("strategyReviewBacktestSelect");
  if (!select) return;
  const previous = selectedResultId || select.value || "";
  const results = currentHandoffBacktests();
  if (!results.length) {
    select.innerHTML = '<option value="">暂无回测结果</option>';
    select.value = "";
    return;
  }
  select.innerHTML = results.map((result) => {
    const label = [
      result.outcome || result.id,
      result.status || "imported",
      shortText(result.period || "", 48)
    ].filter(Boolean).join(" · ");
    return `<option value="${escapeHtml(result.id)}">${escapeHtml(label)}</option>`;
  }).join("");
  select.value = results.some((result) => result.id === previous)
    ? previous
    : results[0].id;
}

function selectedStrategyBacktest() {
  const resultId = $("strategyReviewBacktestSelect")?.value || "";
  return state.backtestResults.find((result) => result.id === resultId) || null;
}

function renderStrategyReviewChecklist() {
  const container = $("strategyReviewChecklist");
  if (!container) return;
  const gate = $("strategyReviewGateSelect")?.value || "paper-ready";
  const items = STRATEGY_REVIEW_CHECKLISTS[gate] || [];
  container.innerHTML = items.map(([key, label]) => `
    <label class="review-checklist-item">
      <input type="checkbox" data-review-check="${escapeHtml(key)}">
      <span>
        <strong>${escapeHtml(label)}</strong>
        <input type="text" data-review-note="${escapeHtml(key)}" placeholder="审查备注，可选">
      </span>
    </label>
  `).join("");
}

function renderStrategyReviews(reviews) {
  const list = $("strategyReviewList");
  if (!list) return;
  list.textContent = "";
  const handoff = selectedStrategyHandoff();
  const visibleReviews = handoff
    ? reviews.filter((review) => review.handoff_id === handoff.id)
    : reviews;
  if (!visibleReviews.length) {
    list.innerHTML = '<p class="hint">还没有 paper/live 审查记录。</p>';
    return;
  }
  for (const review of visibleReviews) {
    const node = document.createElement("article");
    node.className = "strategy-feedback-card";
    const issueText = (review.issues || []).map((issue) => issue.item || issue.code).filter(Boolean).join(" · ");
    node.innerHTML = `
      <div class="strategy-ticket-main">
        <span class="status-pill ${escapeHtml(review.status || "failed")}">${escapeHtml(review.status || "failed")}</span>
        <span>
          <strong>${escapeHtml(review.gate || review.id)}</strong>
          <small>reviewer ${escapeHtml(review.reviewer || "")} · backtest ${escapeHtml(review.backtest_result_id || "")}</small>
          ${issueText ? `<p>issues: ${escapeHtml(issueText)}</p>` : "<p>No gate issues.</p>"}
          ${review.markdown_path ? `<small class="deliverable-path">${escapeHtml(review.markdown_path)}</small>` : ""}
        </span>
      </div>
    `;
    list.appendChild(node);
  }
}

async function importBacktestResult() {
  const handoff = selectedStrategyHandoff();
  if (!handoff?.id) {
    setStrategyBacktestStatus("请选择策略交接包。");
    return;
  }
  setBusy(true);
  setStrategyBacktestStatus("正在导入回测结果...");
  try {
    const metrics = parseJsonObjectInput("backtestMetricsInput", "指标 JSON");
    if (!Object.keys(metrics).length) throw new Error("指标 JSON 不能为空。");
    const costs = parseJsonObjectInput("backtestCostsInput", "成本 JSON", { allowEmpty: true });
    const riskFields = parseKeyValueText($("backtestRiskInput")?.value || "");
    const artifact = artifactFromInput($("backtestArtifactInput")?.value || "", "report", "Backtest artifact");
    const payload = removeEmptyValues({
      handoff_id: handoff.id,
      outcome: $("backtestOutcomeSelect")?.value || "supported",
      status: $("backtestStatusSelect")?.value || "reviewed",
      period: $("backtestPeriodInput")?.value.trim() || "",
      universe: $("backtestUniverseInput")?.value.trim() || "",
      benchmark: $("backtestBenchmarkInput")?.value.trim() || "",
      metrics,
      costs,
      slippage: riskFields.slippage || "",
      max_drawdown: riskFields.max_drawdown || riskFields.drawdown || metrics.max_drawdown || "",
      turnover: riskFields.turnover || metrics.turnover || "",
      capacity: riskFields.capacity || metrics.capacity || "",
      artifacts: artifact ? [artifact] : [],
      failure_notes: $("backtestFailureNotesInput")?.value.trim() || ""
    });
    const result = await companionRequest("/v1/backtest-results", {
      method: "POST",
      body: payload
    });
    await loadStrategyWorkspace();
    if (result.backtest_result?.id && $("strategyReviewBacktestSelect")) {
      $("strategyReviewBacktestSelect").value = result.backtest_result.id;
    }
    setStrategyBacktestStatus(`已导入回测结果：${result.backtest_result?.id || "ok"}`);
  } catch (error) {
    setStrategyBacktestStatus(`导入回测失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function createStrategyReview() {
  const backtest = selectedStrategyBacktest();
  if (!backtest?.id) {
    setStrategyReviewStatus("请选择回测结果。");
    return;
  }
  const reviewer = $("strategyReviewerInput")?.value.trim() || "";
  if (!reviewer) {
    setStrategyReviewStatus("请输入 reviewer。");
    return;
  }
  setBusy(true);
  setStrategyReviewStatus("正在提交策略审查...");
  try {
    const artifact = artifactFromInput($("strategyReviewArtifactInput")?.value || "", "review", "Strategy review artifact");
    const result = await companionRequest("/v1/strategy-reviews", {
      method: "POST",
      body: removeEmptyValues({
        backtest_result_id: backtest.id,
        gate: $("strategyReviewGateSelect")?.value || "paper-ready",
        reviewer,
        note: $("strategyReviewNoteInput")?.value.trim() || "",
        checklist: collectStrategyReviewChecklist(),
        artifacts: artifact ? [artifact] : []
      })
    });
    await loadStrategyWorkspace();
    const review = result.strategy_review || {};
    const issueText = review.issues?.length ? `，issues ${review.issues.length}` : "";
    setStrategyReviewStatus(`已提交审查：${review.status || "ok"}${issueText}`);
  } catch (error) {
    setStrategyReviewStatus(`提交审查失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function collectStrategyReviewChecklist() {
  const checklist = {};
  document.querySelectorAll("[data-review-check]").forEach((checkbox) => {
    const key = checkbox.dataset.reviewCheck;
    if (!key) return;
    const note = document.querySelector(`[data-review-note="${key}"]`)?.value.trim() || "";
    checklist[key] = { passed: checkbox.checked, note };
  });
  return checklist;
}

function parseJsonObjectInput(id, label, options = {}) {
  const raw = $(id)?.value.trim() || "";
  if (!raw) return options.allowEmpty ? {} : {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error(`${label} 必须是 JSON object。`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`${label} 解析失败：${error.message}`);
  }
}

function parseKeyValueText(text) {
  const output = {};
  String(text || "")
    .split(/[;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const match = part.match(/^([^:=]+)\s*[:=]\s*(.+)$/);
      if (!match) return;
      const key = match[1].trim().toLowerCase().replace(/[\s-]+/g, "_");
      output[key] = match[2].trim();
    });
  return output;
}

function artifactFromInput(value, kind, title) {
  const path = String(value || "").trim();
  if (!path) return null;
  return {
    kind,
    title: title || path.split(/[\\/]/).pop() || path,
    path
  };
}

function removeEmptyValues(value) {
  const output = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item === "" || item === null || item === undefined) continue;
    if (Array.isArray(item) && !item.length) continue;
    if (item && typeof item === "object" && !Array.isArray(item) && !Object.keys(item).length) continue;
    output[key] = item;
  }
  return output;
}

function selectedModelProvider() {
  return String($("providerSelect")?.value || state.settings?.provider || "mock").trim() || "mock";
}

function modelProviderLabel(provider = selectedModelProvider()) {
  return {
    mock: "本地模板（Mock 模式）",
    openai: "OpenAI-compatible",
    anthropic: "Anthropic",
    codex: "Codex CLI"
  }[provider] || provider;
}

function currentProviderReady(provider = selectedModelProvider()) {
  if (provider === "mock") return true;
  if (state.settings?.modelSettingsProvider && state.settings.modelSettingsProvider !== provider) return false;
  return Boolean(state.settings?.modelReady && state.settings?.modelRoute !== "mock");
}

function externalProviderBlockingReason(provider = selectedModelProvider()) {
  if (provider === "mock") return "";
  const issues = [];
  if (!currentProviderReady(provider)) issues.push("模型配置未就绪");
  if (!hasCurrentModelDataConsent()) issues.push("未同意将材料发送给所选模型");
  return issues.length
    ? `${modelProviderLabel(provider)} ${issues.join("；")}；不会自动改用本地模板（Mock 模式）`
    : "";
}

function resolveKnowledgeExtractionMode() {
  const provider = selectedModelProvider();
  if (provider === "mock") return "mock";
  const blockingReason = externalProviderBlockingReason(provider);
  if (blockingReason) throw new Error(`${blockingReason}。`);
  return "provider";
}

async function requestKnowledgeExtraction(sourceId, mode) {
  return companionRequest(`/v1/sources/${encodeURIComponent(sourceId)}/extract-knowledge`, {
    method: "POST",
    body: { mode, max_claims: 5, project_id: currentProjectId() }
  });
}

async function extractKnowledgeFromCurrentSource() {
  if (!state.source?.text?.trim()) {
    setKnowledgeRecordStatus("请先读取当前页、选中文本或导入 PDF。");
    showTab("chat");
    return;
  }

  let extractionMode;
  try {
    extractionMode = resolveKnowledgeExtractionMode();
  } catch (error) {
    setKnowledgeRecordStatus(`抽取已阻止：${error.message}`);
    showTab("settings");
    return;
  }

  setBusy(true);
  setKnowledgeRecordStatus(extractionMode === "mock" ? "正在运行本地模板抽取（Mock 模式，未调用外部模型）..." : "正在调用已配置模型抽取结构化知识...");
  try {
    const capture = await ensureCurrentSourceCaptured();
    const sourceId = capture?.source?.id || state.source.sourceId;
    if (!sourceId) throw new Error("本地服务没有返回 source id。");
    const result = await requestKnowledgeExtraction(sourceId, extractionMode);
    await markOnboardingMilestone("extractedAt", { lastSourceId: sourceId, projectId: currentProjectId() });
    await applyKnowledgeExtractionResult(sourceId, result, "已抽取草稿");
  } catch (error) {
    setKnowledgeRecordStatus(`抽取失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function applyKnowledgeExtractionResult(sourceId, result, label) {
  if (result.source?.id && state.source?.sourceId === sourceId) {
    state.source.sourceStatus = result.source.status || state.source.sourceStatus || "";
    state.source.chunks = result.source.chunks || state.source.chunks || [];
    state.source.markdownPath = result.source.markdown_path || state.source.markdownPath || "";
    renderSource();
  }
  const records = result.records || {};
  const counts = knowledgeRecordCounts(records);
  const run = result.agent_run || {};
  const runInput = run.input || {};
  const modeLabel = runInput.effective_mode === "mock" || run.agent_id === "mock_structured_extractor"
    ? "本地模板 · Mock 模式 · 未调用外部模型"
    : `${runInput.provider || "provider"}${run.model ? ` · ${run.model}` : ""}`;
  await refreshKnowledgeListsAfterMutation();
  setKnowledgeRecordStatus(`${label}：${formatKnowledgeCounts(counts)}；${modeLabel}${run.id ? `；run ${run.id}` : ""}`);
  return { counts, run };
}

async function reextractSource(sourceId) {
  if (!sourceId) return null;
  let extractionMode;
  try {
    extractionMode = resolveKnowledgeExtractionMode();
  } catch (error) {
    setKnowledgeRecordStatus(`重跑抽取已阻止：${error.message}`);
    showTab("settings");
    return null;
  }
  setBusy(true);
  setKnowledgeRecordStatus("正在重跑结构化抽取...");
  try {
    const data = await companionRequest(`/v1/sources/${encodeURIComponent(sourceId)}/reextract`, {
      method: "POST",
      body: {
        mode: extractionMode,
        max_claims: 5,
        project_id: currentProjectId(),
        reason: "source detail re-extraction"
      }
    });
    if (data.diff) {
      state.sourceDiffs[sourceId] = data.diff;
    }
    const result = data.result || {};
    await markOnboardingMilestone("extractedAt", { lastSourceId: sourceId, projectId: currentProjectId() });
    await applyKnowledgeExtractionResult(sourceId, result, "已重跑抽取");
    if (state.currentSourceDetailId === sourceId) {
      await loadSourceDetail(sourceId);
    }
    return data;
  } catch (error) {
    setKnowledgeRecordStatus(`重跑抽取失败：${error.message}`);
    return null;
  } finally {
    setBusy(false);
  }
}

async function refreshKnowledgeListsAfterMutation() {
  for (const refresh of [loadReviewQueue, loadSourceLibrary, loadKnowledgeRecords, loadClaimReviewQueue]) {
    try {
      await refresh();
    } catch (error) {
      console.warn("Knowledge list refresh failed after mutation.", error);
    }
  }
}

async function loadKnowledgeRecords() {
  const requestedProjectId = currentProjectId();
  const requestedGeneration = state.projectViewGeneration;
  try {
    const query = new URLSearchParams({ limit: "50", project_id: requestedProjectId });
    const data = await companionRequest(`/v1/knowledge/records?${query.toString()}`, { method: "GET" });
    if (
      requestedGeneration !== state.projectViewGeneration
        || requestedProjectId !== currentProjectId()
    ) return null;
    renderKnowledgeRecords(data);
    restoreQuickStartEvidenceFromRecords(data);
    setKnowledgeRecordStatus("");
    return data;
  } catch (error) {
    if (
      requestedGeneration !== state.projectViewGeneration
        || requestedProjectId !== currentProjectId()
    ) return null;
    console.warn("Companion knowledge records list failed.", error);
    renderKnowledgeRecords({});
    setKnowledgeRecordStatus(`无法读取结构化记录：${error.message}`);
    return null;
  }
}

async function loadClaimReviewQueue() {
  const requestedProjectId = currentProjectId();
  const requestedGeneration = state.projectViewGeneration;
  try {
    const status = $("claimReviewStatusFilter")?.value || "extracted,pending_validation";
    const query = new URLSearchParams({
      status,
      quote_validity: $("claimReviewQuoteFilter")?.value || "",
      evidence_strength: $("claimReviewStrengthFilter")?.value || "",
      source_id: $("claimReviewSourceFilter")?.value.trim() || "",
      topic_package_id: $("claimReviewTopicFilter")?.value.trim() || "",
      limit: "50",
      project_id: requestedProjectId
    });
    const data = await companionRequest(`/v1/claims/review-queue?${query.toString()}`, { method: "GET" });
    if (
      requestedGeneration !== state.projectViewGeneration
        || requestedProjectId !== currentProjectId()
    ) return null;
    const claims = Array.isArray(data.claims) ? data.claims : [];
    renderClaimReviewQueue(claims);
    const filters = data.filters || {};
    const filterMeta = [
      filters.quote_validity && filters.quote_validity !== "all" ? `quote ${filters.quote_validity}` : "",
      filters.evidence_strength ? `strength ${filters.evidence_strength}` : "",
      filters.source_id ? `source ${filters.source_id}` : "",
      filters.topic_package_id ? `topic ${filters.topic_package_id}` : ""
    ].filter(Boolean).join(" · ");
    setClaimReviewStatus(claims.length ? `${claims.length} 条 claim 待处理${filterMeta ? ` · ${filterMeta}` : ""}。` : "暂无符合条件的 claim。");
  } catch (error) {
    if (
      requestedGeneration !== state.projectViewGeneration
        || requestedProjectId !== currentProjectId()
    ) return null;
    console.warn("Companion claim review queue failed.", error);
    renderClaimReviewQueue([]);
    setClaimReviewStatus(`无法读取 claim 审阅队列：${error.message}`);
  }
}

function renderClaimReviewQueue(claims) {
  const rows = Array.isArray(claims) ? claims : [];
  state.claimReviewQueue = rows;
  const list = $("claimReviewList");
  if (!list) return;
  list.textContent = "";
  if (!rows.length) {
    list.innerHTML = '<p class="hint">暂无 claim 审阅项。完成结构化抽取后，extracted / pending_validation claim 会出现在这里。</p>';
    return;
  }
  for (const claim of rows) {
    const node = document.createElement("article");
    node.className = "claim-review-card";
    const evidenceRows = Array.isArray(claim.evidence) ? claim.evidence : [];
    const validEvidenceCount = Number(claim.valid_evidence_count ?? claim.evidence_count ?? evidenceRows.length ?? 0);
    const canReview = validEvidenceCount > 0;
    const meta = [
      claim.status || "extracted",
      `evidence ${Number(claim.evidence_count || evidenceRows.length || 0)}`,
      `valid ${validEvidenceCount}`,
      formatConfidence(claim.confidence),
      claim.source_id ? `source ${claim.source_id}` : "",
      claim.reviewer ? `reviewer ${claim.reviewer}` : "",
      claim.reviewed_at || ""
    ].filter(Boolean).join(" · ");
    node.innerHTML = `
      <div class="claim-review-header">
        <label class="claim-select-row">
          <input type="checkbox" value="${escapeHtml(claim.id)}" data-claim-workbench-select>
          <span>批量</span>
        </label>
        <span class="status-pill ${escapeHtml(claim.status || "extracted")}">${escapeHtml(claim.status || "extracted")}</span>
      </div>
      <label class="field-label" for="claim-edit-${escapeHtml(claim.id)}">Claim</label>
      <textarea id="claim-edit-${escapeHtml(claim.id)}" rows="3" data-claim-edit-text="${escapeHtml(claim.id)}">${escapeHtml(claim.text || "")}</textarea>
      ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
      ${claim.reasoning_chain ? `<p class="claim-reasoning">${escapeHtml(shortText(claim.reasoning_chain, 520))}</p>` : ""}
      ${claim.review_note ? `<p class="review-note">${escapeHtml(shortText(claim.review_note, 260))}</p>` : ""}
      ${claim.rejection_reason ? `<p class="review-rejection">拒绝原因：${escapeHtml(shortText(claim.rejection_reason, 260))}</p>` : ""}
      ${renderClaimEventHistory(claim.events || claim.claim_events || [])}
      <div class="source-actions">
        <button type="button" data-claim-workbench-id="${escapeHtml(claim.id)}" data-claim-status="reviewed" ${canReview ? "" : "disabled title=\"缺少有效 evidence，不能接受\""}>接受</button>
        <button type="button" data-claim-workbench-id="${escapeHtml(claim.id)}" data-claim-status="pending_validation">待验证</button>
        <button type="button" data-claim-workbench-id="${escapeHtml(claim.id)}" data-claim-status="rejected">拒绝</button>
      </div>
      <div class="claim-evidence-list">
        ${evidenceRows.length ? evidenceRows.map((evidence) => renderClaimEvidenceReviewCard(evidence, {
          claimId: claim.id,
          projectId: claim.project_id || currentProjectId()
        })).join("") : '<p class="hint">这个 claim 没有 evidence，不能进入 reviewed。</p>'}
      </div>
    `;
    bindClaimReviewWorkbenchActions(node);
    list.appendChild(node);
  }
}

function renderClaimEventHistory(events) {
  const rows = Array.isArray(events) ? events : [];
  if (!rows.length) return "";
  return `
    <details class="claim-history" open>
      <summary>Claim history (${rows.length})</summary>
      <ol>
        ${rows.map(renderClaimEventItem).join("")}
      </ol>
    </details>
  `;
}

function renderClaimEventItem(event) {
  const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  const related = Array.isArray(event.related_claim_ids) ? event.related_claim_ids.filter(Boolean) : [];
  const statusChange = [metadata.previous_status || "", metadata.next_status || ""].filter(Boolean).join(" -> ");
  const metrics = [
    statusChange,
    metadata.moved_evidence_count ? `moved evidence ${metadata.moved_evidence_count}` : "",
    metadata.cloned_evidence_count ? `cloned evidence ${metadata.cloned_evidence_count}` : "",
    metadata.split_claim_count ? `split claims ${metadata.split_claim_count}` : "",
    metadata.text_changed ? "text changed" : "",
    related.length ? `related ${related.join(", ")}` : ""
  ].filter(Boolean).join(" · ");
  const textDiff = metadata.text_changed ? `
    <div class="claim-event-diff">
      <small>Before</small>
      <pre>${escapeHtml(shortText(metadata.previous_text || "", 520))}</pre>
      <small>After</small>
      <pre>${escapeHtml(shortText(metadata.next_text || "", 520))}</pre>
    </div>
  ` : "";
  return `
    <li>
      <div class="claim-event-title">
        <strong>${escapeHtml(claimEventLabel(event.event_type || "event"))}</strong>
        <small>${escapeHtml([event.created_at || "", event.reviewer ? `reviewer ${event.reviewer}` : ""].filter(Boolean).join(" · "))}</small>
      </div>
      ${metrics ? `<small>${escapeHtml(metrics)}</small>` : ""}
      ${event.note ? `<p>${escapeHtml(shortText(event.note, 260))}</p>` : ""}
      ${textDiff}
    </li>
  `;
}

function claimEventLabel(type) {
  return {
    review: "Review",
    review_revalidation_failed: "Review revalidation failed",
    merge_target: "Merge target",
    merge_source: "Merge source",
    split_source: "Split source",
    split_child: "Split child"
  }[type] || type;
}

function renderClaimEvidenceReviewCard(evidence, options = {}) {
  const meta = [
    evidence.status || "pending_validation",
    evidence.citation_valid === false ? "quote invalid" : evidence.citation_valid === true ? "quote valid" : "",
    evidence.strength || "",
    evidence.source_title || evidence.source_id || "",
    evidence.chunk_id ? `chunk ${evidence.chunk_id}` : "",
    evidence.page ? `page ${evidence.page}` : "",
    evidence.floor ? `floor ${evidence.floor}` : "",
    evidence.timestamp ? `time ${evidence.timestamp}` : "",
    evidence.reviewer ? `reviewer ${evidence.reviewer}` : ""
  ].filter(Boolean).join(" · ");
  const sourceLine = [
    evidence.source_url || "",
    evidence.review_note ? `note: ${evidence.review_note}` : ""
  ].filter(Boolean).join(" · ");
  return `
    <article class="claim-evidence-card">
      <div class="claim-evidence-meta">${escapeHtml(meta || "evidence")}</div>
      <blockquote>${escapeHtml(shortText(evidence.quote || "缺少 quote", 620))}</blockquote>
      ${evidence.chunk_context ? `<pre class="quote-context">${escapeHtml(shortText(evidence.chunk_context, 1200))}</pre>` : '<p class="hint">没有 chunk context。</p>'}
      ${sourceLine ? `<small>${escapeHtml(sourceLine)}</small>` : ""}
      ${renderEvidenceReplayControls(evidence, {
        ...options,
        scope: options.scope || "claim-review"
      })}
      <div class="source-actions">
        <button type="button" data-evidence-review-id="${escapeHtml(evidence.id)}" data-evidence-status="reviewed">接受证据</button>
        <button type="button" data-evidence-review-id="${escapeHtml(evidence.id)}" data-evidence-status="pending_validation">待验证</button>
        <button type="button" data-evidence-review-id="${escapeHtml(evidence.id)}" data-evidence-status="rejected">拒绝证据</button>
      </div>
    </article>
  `;
}

function bindClaimReviewWorkbenchActions(root) {
  bindReplayActions(root);
  root.querySelectorAll("[data-claim-workbench-id]").forEach((button) => {
    button.addEventListener("click", () => reviewClaimFromWorkbench(button.dataset.claimWorkbenchId, button.dataset.claimStatus));
  });
  root.querySelectorAll("[data-evidence-review-id]").forEach((button) => {
    button.addEventListener("click", () => reviewEvidenceFromWorkbench(button.dataset.evidenceReviewId, button.dataset.evidenceStatus));
  });
}

function buildClaimReviewPayload(status, claimId = "") {
  const rejectionReason = status === "rejected" ? $("claimRejectionReasonInput")?.value.trim() || "" : "";
  return removeEmptyValues({
    status,
    text: claimId ? claimEditTextValue(claimId) : "",
    reviewer: $("claimReviewerInput")?.value.trim() || "extension-user",
    review_note: $("claimReviewNoteInput")?.value.trim() || "",
    rejection_reason: rejectionReason
  });
}

function claimEditTextValue(claimId) {
  for (const node of document.querySelectorAll("[data-claim-edit-text]")) {
    if (node.dataset.claimEditText === claimId) return node.value.trim();
  }
  return "";
}

function selectedClaimReviewIds() {
  return [...document.querySelectorAll("[data-claim-workbench-select]:checked")]
    .map((input) => input.value)
    .filter(Boolean);
}

async function refreshClaimReviewAfterMutation() {
  for (const refresh of [loadKnowledgeRecords, loadClaimReviewQueue]) {
    try {
      await refresh();
    } catch (error) {
      console.warn("Claim review refresh failed after mutation.", error);
    }
  }
}

async function reviewClaimFromWorkbench(claimId, status) {
  if (!claimId || !status) return;
  setBusy(true);
  setClaimReviewStatus(`正在标记 claim 为 ${status}...`);
  try {
    await companionRequest(`/v1/claims/${encodeURIComponent(claimId)}/review`, {
      method: "POST",
      body: buildClaimReviewPayload(status, claimId)
    });
    await refreshClaimReviewAfterMutation();
    setClaimReviewStatus(`claim 已标记为 ${status}。`);
  } catch (error) {
    setClaimReviewStatus(`claim 审阅失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function reviewSelectedClaims(status) {
  const claimIds = selectedClaimReviewIds();
  if (!claimIds.length) {
    setClaimReviewStatus("请先勾选要批量处理的 claim。");
    return;
  }
  setBusy(true);
  setClaimReviewStatus(`正在批量标记 ${claimIds.length} 条 claim 为 ${status}...`);
  try {
    const result = await companionRequest("/v1/claims/review-batch", {
      method: "POST",
      body: {
        ...buildClaimReviewPayload(status),
        claim_ids: claimIds
      }
    });
    await refreshClaimReviewAfterMutation();
    const successCount = Number(result.success_count || 0);
    const errorCount = Number(result.error_count || 0);
    const suffix = errorCount ? `，${errorCount} 条失败` : "";
    setClaimReviewStatus(`批量审阅完成：${successCount} 条成功${suffix}。`);
  } catch (error) {
    setClaimReviewStatus(`批量审阅失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function mergeSelectedClaims() {
  const claimIds = selectedClaimReviewIds();
  if (claimIds.length < 2) {
    setClaimReviewStatus("请至少勾选 2 条 claim；第一条会作为 canonical claim。");
    return;
  }
  const [targetClaimId] = claimIds;
  setBusy(true);
  setClaimReviewStatus(`正在合并 ${claimIds.length} 条 claim 到 ${targetClaimId}...`);
  try {
    const result = await companionRequest("/v1/claims/merge", {
      method: "POST",
      body: removeEmptyValues({
        target_claim_id: targetClaimId,
        claim_ids: claimIds,
        reviewer: $("claimReviewerInput")?.value.trim() || "extension-user",
        review_note: $("claimReviewNoteInput")?.value.trim() || "merged duplicate claims",
        reason: $("claimRejectionReasonInput")?.value.trim() || "duplicate claim"
      })
    });
    await refreshClaimReviewAfterMutation();
    const movedEvidence = Number(result.moved_evidence_count || 0);
    setClaimReviewStatus(`已合并 ${result.merged_claim_ids?.length || claimIds.length - 1} 条 claim，迁移 ${movedEvidence} 条 evidence。`);
  } catch (error) {
    setClaimReviewStatus(`合并 claim 失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function splitSelectedClaim() {
  const claimIds = selectedClaimReviewIds();
  if (claimIds.length !== 1) {
    setClaimReviewStatus("请只勾选 1 条要拆分的 claim。");
    return;
  }
  const splitLines = ($("claimSplitTextInput")?.value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (splitLines.length < 2) {
    setClaimReviewStatus("请在拆分文本里至少写 2 行新 claim。");
    return;
  }
  const [sourceClaimId] = claimIds;
  setBusy(true);
  setClaimReviewStatus(`正在拆分 claim ${sourceClaimId}...`);
  try {
    const result = await companionRequest("/v1/claims/split", {
      method: "POST",
      body: removeEmptyValues({
        claim_id: sourceClaimId,
        splits: splitLines.map((text) => ({ text })),
        reviewer: $("claimReviewerInput")?.value.trim() || "extension-user",
        review_note: $("claimReviewNoteInput")?.value.trim() || "",
        reason: $("claimRejectionReasonInput")?.value.trim() || "split broad claim",
        clone_evidence: true
      })
    });
    await refreshClaimReviewAfterMutation();
    const splitCount = result.split_claim_ids?.length || splitLines.length;
    const clonedEvidence = Number(result.cloned_evidence_count || 0);
    setClaimReviewStatus(`已拆分出 ${splitCount} 条 claim，复制 ${clonedEvidence} 条 evidence，等待复核。`);
  } catch (error) {
    setClaimReviewStatus(`拆分 claim 失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function reviewEvidenceFromWorkbench(evidenceId, status) {
  if (!evidenceId || !status) return;
  setBusy(true);
  setClaimReviewStatus(`正在标记 evidence 为 ${status}...`);
  try {
    await companionRequest(`/v1/evidence/${encodeURIComponent(evidenceId)}/review`, {
      method: "POST",
      body: buildClaimReviewPayload(status)
    });
    await refreshClaimReviewAfterMutation();
    setClaimReviewStatus(`evidence 已标记为 ${status}。`);
  } catch (error) {
    setClaimReviewStatus(`evidence 审阅失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function setClaimReviewStatus(message) {
  const node = $("claimReviewStatus");
  if (node) node.textContent = message || "";
}

async function createLearningPackFromCurrentSource() {
  if (!state.source?.text?.trim()) {
    setLearningItemStatus("请先读取当前页、选中文本、PDF 或 YouTube 字幕。");
    showTab("chat");
    return;
  }
  setBusy(true);
  setLearningItemStatus("正在生成学习包...");
  try {
    const capture = await ensureCurrentSourceCaptured();
    const sourceId = capture?.source?.id || state.source.sourceId;
    if (!sourceId) throw new Error("本地服务没有返回 source id。");
    const result = await companionRequest(`/v1/sources/${encodeURIComponent(sourceId)}/learning-pack`, {
      method: "POST",
      body: { project_id: currentProjectId(), max_items: 6 }
    });
    await loadLearningItems();
    setLearningItemStatus(`已生成学习包：${formatLearningCounts(result.counts || {})}；${result.markdown_path || ""}`);
  } catch (error) {
    setLearningItemStatus(`生成学习包失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function createTopicPackageFromSelectedClaims() {
  const claimIds = getSelectedKnowledgeClaimIds();
  if (!claimIds.length) {
    setKnowledgeRecordStatus("请先在 claims 列表里勾选要打包的 claim。");
    return;
  }
  const title = $("topicTitleInput").value.trim() || `专题包 ${new Date().toISOString().slice(0, 10)}`;
  const status = $("topicStatusSelect").value || "active";
  setBusy(true);
  setKnowledgeRecordStatus("正在生成专题包...");
  try {
    const result = await companionRequest("/v1/topic-packages", {
      method: "POST",
      body: {
        project_id: currentProjectId(),
        title,
        status,
        claim_ids: claimIds
      }
    });
    const topic = result.topic_package || {};
    await loadTopicPackages();
    setKnowledgeRecordStatus(`已生成专题包：${topic.markdown_path || topic.id || "ok"}`);
    setTopicPackageStatus("专题包列表已刷新，可在交付页勾选作为输入。");
  } catch (error) {
    setKnowledgeRecordStatus(`专题包生成失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function getSelectedKnowledgeClaimIds() {
  return [...document.querySelectorAll("[data-claim-select]:checked")]
    .map((input) => input.value)
    .filter(Boolean);
}

async function loadLearningItems() {
  try {
    const data = await companionRequest(`/v1/learning/items${queryWithProject({ limit: "80" })}`, { method: "GET" });
    renderLearningItems(data.items || []);
    setLearningItemStatus("");
  } catch (error) {
    console.warn("Companion learning items list failed.", error);
    renderLearningItems([]);
    setLearningItemStatus(`无法读取学习项：${error.message}`);
  }
}

function renderLearningItems(items) {
  const list = $("learningItemList");
  if (!list) return;
  list.textContent = "";
  if (!items.length) {
    list.innerHTML = '<p class="hint">还没有学习项。读取来源后点击“生成学习包”。</p>';
    return;
  }
  const counts = items.reduce((acc, item) => {
    acc[item.kind] = (acc[item.kind] || 0) + 1;
    return acc;
  }, {});
  const summary = document.createElement("article");
  summary.className = "kb-item record-summary";
  summary.innerHTML = `<h3>学习项</h3><div class="record-counts">${Object.entries(counts)
    .map(([key, value]) => `<span>${escapeHtml(learningKindLabel(key))}: ${Number(value || 0)}</span>`)
    .join("")}</div>`;
  list.appendChild(summary);
  for (const item of items.slice(0, 30)) {
    const node = document.createElement("article");
    node.className = "kb-item";
    const title = item.front || item.prompt || item.id;
    const body = item.back || item.answer || "";
    node.innerHTML = `
      <h3>${escapeHtml(shortText(title, 180))}</h3>
      <div class="meta">${escapeHtml([learningKindLabel(item.kind), item.status, item.due_at, item.source_id].filter(Boolean).join(" · "))}</div>
      ${body ? `<pre>${escapeHtml(shortText(body, 800))}</pre>` : ""}
      ${item.markdown_path ? `<div class="deliverable-path">${escapeHtml(item.markdown_path)}</div>` : ""}
    `;
    list.appendChild(node);
  }
}

function learningKindLabel(kind) {
  return {
    retrieval_question: "检索练习",
    anki_card: "Anki 卡",
    feynman_prompt: "费曼复述",
    confusion_checkpoint: "卡点/错题",
    review_due: "复习队列"
  }[kind] || kind;
}

function formatLearningCounts(counts) {
  return Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${learningKindLabel(key)} ${value}`)
    .join("，") || "无学习项";
}

function renderKnowledgeRecords(records) {
  const cachedRecords = records && typeof records === "object" ? records : {};
  state.knowledgeRecords = cachedRecords;
  const list = $("knowledgeRecordList");
  if (!list) return;
  list.textContent = "";
  const counts = knowledgeRecordCounts(cachedRecords);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (!total) {
    list.innerHTML = '<p class="hint">还没有结构化记录。读取来源后点击“抽取结构化知识”。</p>';
    return;
  }

  const summary = document.createElement("article");
  summary.className = "kb-item record-summary";
  summary.innerHTML = `<h3>结构化记录</h3><div class="record-counts">${Object.entries(counts)
    .map(([key, value]) => `<span>${escapeHtml(recordGroupLabel(key))}: ${Number(value || 0)}</span>`)
    .join("")}</div>`;
  list.appendChild(summary);

  appendRecordGroup(list, "claims", cachedRecords.claims, renderClaimRecord);
  appendRecordGroup(list, "entities", cachedRecords.entities, renderEntityRecord);
  appendRecordGroup(list, "evidence", cachedRecords.evidence, renderEvidenceRecord);
  appendRecordGroup(list, "relations", cachedRecords.relations, renderRelationRecord);
  appendRecordGroup(list, "assumptions", cachedRecords.assumptions, renderAssumptionRecord);
  appendRecordGroup(list, "strategy_ideas", cachedRecords.strategy_ideas, renderStrategyRecord);
  appendRecordGroup(list, "risks", cachedRecords.risks, renderRiskRecord);
  appendRecordGroup(list, "tasks", cachedRecords.tasks, renderTaskRecord);
  bindClaimReviewActions(list);
}

function appendRecordGroup(parent, key, items, renderItem) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return;
  const displayLimit = key === "claims" ? 20 : 6;
  const node = document.createElement("article");
  node.className = "kb-item record-group";
  node.innerHTML = `
    <h3>${escapeHtml(recordGroupLabel(key))} (${rows.length})</h3>
    <div class="record-list">${rows.slice(0, displayLimit).map(renderItem).join("")}</div>
    ${rows.length > displayLimit ? `<div class="meta">另有 ${rows.length - displayLimit} 条，可在导出 JSON 或 Vault 中查看。</div>` : ""}
  `;
  parent.appendChild(node);
}

function renderClaimRecord(item) {
  const evidenceCount = Number(item.evidence_count || 0);
  const canReview = evidenceCount > 0;
  const meta = [
    item.status,
    `evidence ${evidenceCount}`,
    formatConfidence(item.confidence),
    item.source_id ? `source ${item.source_id}` : "",
    item.reviewer ? `reviewer ${item.reviewer}` : ""
  ].filter(Boolean).join(" · ");
  return `
    <div class="record-line" data-claim-record-id="${escapeHtml(item.id || "")}">
      <label class="claim-select-row">
        <input type="checkbox" value="${escapeHtml(item.id)}" data-claim-select>
        <span>加入专题包</span>
      </label>
      <strong>${escapeHtml(shortText(item.text || "Untitled", 180))}</strong>
      ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
      ${item.reasoning_chain ? `<p>${escapeHtml(shortText(item.reasoning_chain, 260))}</p>` : ""}
      ${item.review_note ? `<p class="review-note">${escapeHtml(shortText(item.review_note, 220))}</p>` : ""}
      <div class="source-actions">
        <button type="button" data-claim-review-id="${escapeHtml(item.id)}" data-claim-status="reviewed" ${canReview ? "" : "disabled title=\"缺少有效 evidence，不能接受\""}>接受 claim</button>
        <button type="button" data-claim-review-id="${escapeHtml(item.id)}" data-claim-status="pending_validation">待验证</button>
        <button type="button" data-claim-review-id="${escapeHtml(item.id)}" data-claim-status="rejected">拒绝</button>
      </div>
    </div>
  `;
}

function bindClaimReviewActions(root) {
  bindReplayActions(root);
  root.querySelectorAll("[data-claim-review-id]").forEach((button) => {
    button.addEventListener("click", () => reviewClaim(button.dataset.claimReviewId, button.dataset.claimStatus));
  });
}

async function reviewClaim(claimId, status) {
  if (!claimId || !status) return;
  setBusy(true);
  setKnowledgeRecordStatus(`正在标记 claim 为 ${status}...`);
  try {
    await companionRequest(`/v1/claims/${encodeURIComponent(claimId)}/review`, {
      method: "POST",
      body: buildClaimReviewPayload(status, claimId)
    });
    await refreshClaimReviewAfterMutation();
    setKnowledgeRecordStatus(`claim 已标记为 ${status}。`);
  } catch (error) {
    setKnowledgeRecordStatus(`claim 审阅失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function renderEntityRecord(item) {
  const aliases = Array.isArray(item.aliases) && item.aliases.length ? `aliases: ${item.aliases.join(", ")}` : "";
  return renderRecordLine(item.name, [item.kind, item.status].filter(Boolean).join(" · "), item.description || aliases);
}

function renderEvidenceRecord(item) {
  const meta = [
    item.strength,
    item.source_id ? `source ${item.source_id}` : "",
    item.chunk_id ? `chunk ${item.chunk_id}` : "",
    item.page ? `page ${item.page}` : "",
    item.floor ? `floor ${item.floor}` : ""
  ].filter(Boolean).join(" · ");
  return `
    <div class="record-line" data-evidence-record-id="${escapeHtml(item.id || "")}">
      <strong>${escapeHtml(shortText(item.quote || item.claim_id || "evidence", 180))}</strong>
      ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
      ${item.url ? `<p>${escapeHtml(shortText(item.url, 260))}</p>` : ""}
      ${renderEvidenceReplayControls(item, {
        claimId: item.claim_id || "",
        projectId: item.project_id || currentProjectId(),
        scope: "knowledge-record"
      })}
    </div>
  `;
}

function renderRelationRecord(item) {
  const title = [item.subject_entity_id, item.predicate, item.object_entity_id].filter(Boolean).join(" -> ");
  return renderRecordLine(title || item.predicate || "relation", item.status || "", item.claim_id ? `claim ${item.claim_id}` : "");
}

function renderAssumptionRecord(item) {
  return renderRecordLine(item.text, item.status || "", item.claim_id ? `claim ${item.claim_id}` : "");
}

function renderStrategyRecord(item) {
  return renderRecordLine(item.title, item.status || "", item.thesis || "");
}

function renderRiskRecord(item) {
  return renderRecordLine(item.text, [item.severity, item.status].filter(Boolean).join(" · "), "");
}

function renderTaskRecord(item) {
  return renderRecordLine(item.title, item.status || "", item.acceptance || "");
}

function renderRecordLine(title, meta, body) {
  return `
    <div class="record-line">
      <strong>${escapeHtml(shortText(title || "Untitled", 180))}</strong>
      ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
      ${body ? `<p>${escapeHtml(shortText(body, 260))}</p>` : ""}
    </div>
  `;
}

function knowledgeRecordCounts(records) {
  return {
    claims: records?.claims?.length || 0,
    entities: records?.entities?.length || 0,
    evidence: records?.evidence?.length || 0,
    relations: records?.relations?.length || 0,
    assumptions: records?.assumptions?.length || 0,
    risks: records?.risks?.length || 0,
    strategy_ideas: records?.strategy_ideas?.length || 0,
    tasks: records?.tasks?.length || 0
  };
}

function formatKnowledgeCounts(counts) {
  return Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${recordGroupLabel(key)} ${value}`)
    .join("，") || "无新增记录";
}

function recordGroupLabel(key) {
  return {
    claims: "主张",
    entities: "实体",
    evidence: "证据",
    relations: "关系",
    assumptions: "假设",
    risks: "风险",
    strategy_ideas: "策略想法",
    tasks: "任务"
  }[key] || key;
}

function formatConfidence(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  if (Number.isNaN(number)) return "";
  return `置信 ${Math.round(number * 100)}%`;
}

function shortText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

async function createDeliverableFromCurrentSource() {
  const topicPackageIds = getSelectedTopicPackageIds();
  if (!topicPackageIds.length && !state.source?.text?.trim()) {
    setDeliverableStatus("请先读取当前页、选中文本或导入 PDF。");
    showTab("chat");
    return;
  }

  setBusy(true);
  setDeliverableStatus("正在生成交付物...");
  try {
    if (!topicPackageIds.length && state.lastAnswer && !currentSourceBoundAnswer()) {
      throw new Error("当前答案属于另一个来源，已阻止生成交付物；请对当前来源重新运行阅读。");
    }
    const payload = topicPackageIds.length
      ? buildTopicPackageDeliverablePayload(topicPackageIds)
      : buildDeliverablePayload(await ensureCurrentSourceCaptured());
    const result = await companionRequest("/v1/deliverables", {
      method: "POST",
      body: payload
    });
    await loadDeliverables();
    const deliverable = result.deliverable;
    const gate = deliverable?.ready_gate || {};
    const gateText = gate.passed ? "Ready Gate 通过" : `Ready Gate 未通过：${Number(gate.issue_count || 0)} 个问题`;
    setDeliverableStatus(`已生成 ${deliverable?.status || "draft"}：${deliverable?.markdown_path || deliverable?.id || "ok"}；${gateText}`);
  } catch (error) {
    setDeliverableStatus(`生成失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function ensureCurrentSourceCaptured() {
  if (!state.source?.text?.trim()) {
    throw new Error("没有可入库的来源。");
  }
  assertCurrentSourceProject();
  const fingerprint = sourceFingerprint(state.source);
  if (state.source.sourceId && !state.source.sourceFingerprint) {
    state.source.sourceFingerprint = fingerprint;
  }
  if (state.source.sourceId && state.source.sourceFingerprint !== fingerprint) {
    state.source.sourceId = "";
    state.source.chunks = [];
    state.source.markdownPath = "";
    state.source.sourceFingerprint = "";
  }
  if (state.source.sourceId) {
    return {
      source: { id: state.source.sourceId },
      chunks: state.source.chunks || []
    };
  }
  const capture = await companionRequest("/v1/captures", {
    method: "POST",
    body: currentSourceCapturePayload()
  });
  const sourceId = capture?.source?.id;
  if (!sourceId) throw new Error("本地服务没有返回 source id。");
  state.source.sourceId = sourceId;
  state.source.projectId = capture.source?.project_id || currentProjectId();
  state.source.chunks = capture.chunks || [];
  state.source.markdownPath = capture.source?.markdown_path || "";
  state.source.sourceFingerprint = sourceFingerprint(state.source);
  return capture;
}

function currentSourceCapturePayload() {
  return {
    project_id: currentProjectId(),
    source: {
      project_id: currentProjectId(),
      kind: state.source.kind || "page",
      url: state.source.url || "",
      title: state.source.title || "未命名来源",
      site: state.source.site || inferSiteFromUrl(state.source.url || ""),
      author: state.source.author || "",
      published_at: state.source.publishedAt || "",
      captured_at: state.source.capturedAt || new Date().toISOString()
    },
    content: {
      text: state.source.text || "",
      markdown: state.source.markdown || state.source.text || "",
      blocks: state.source.blocks || [],
      images: state.source.images || [],
      attachments: state.source.attachments || [],
      links: state.source.links || [],
      next_pages: state.source.nextPages || [],
      stats: state.source.stats || {}
    },
    browser: {}
  };
}

function buildDeliverablePayload(capture) {
  const kind = $("deliverableKindSelect").value || "report";
  const label = deliverableKindLabel(kind);
  const sourceId = capture?.source?.id || state.source.sourceId;
  const title = $("deliverableTitleInput").value.trim() || `${state.source.title || "未命名专题"} - ${label}`;
  const answer = currentSourceBoundAnswer();
  const claims = buildDeliverableClaims(sourceId, capture?.chunks || [], answer);
  const nextSteps = extractActionLines(answer);
  return {
    kind,
    title,
    status: $("deliverableStatusSelect").value || "draft",
    project_id: currentProjectId(),
    source_ids: sourceId ? [sourceId] : [],
    background: answer || `基于当前来源《${state.source.title || "未命名来源"}》生成的交付物草稿。`,
    summary: answer || "",
    claims,
    risks: extractRiskLines(answer),
    next_steps: nextSteps,
    strategy: {
      hypothesis: claims[0]?.text || "当前资料提示存在可验证的策略假设，仍需补充数据和回测。",
      input_data: [`当前来源：${state.source.title || state.source.url || "未命名来源"}`],
      signal: "待从证据链中定义可计算信号/因子。",
      backtest_window: "待定义样本内、样本外和滚动验证窗口。",
      metrics: ["收益", "最大回撤", "换手", "胜率", "稳定性"],
      risk_checks: ["过拟合", "交易成本", "流动性", "市场阶段变化", "样本外失效"],
      implementation_steps: nextSteps.length ? nextSteps : ["补充数据定义", "实现信号", "跑回测", "做风险检查", "输出复盘报告"],
      acceptance: ["关键结论必须有 source/chunk 引用或标记为待验证", "策略任务可被工程实现和回测复现"]
    }
  };
}

function buildTopicPackageDeliverablePayload(topicPackageIds) {
  const kind = $("deliverableKindSelect").value || "report";
  const label = deliverableKindLabel(kind);
  const selectedTopics = state.topicPackages.filter((topic) => topicPackageIds.includes(topic.id));
  const titleBase = selectedTopics.length === 1
    ? selectedTopics[0].title
    : `专题包组合 ${selectedTopics.length || topicPackageIds.length}`;
  const title = $("deliverableTitleInput").value.trim() || `${titleBase || "专题包"} - ${label}`;
  const topicNames = selectedTopics.map((topic) => topic.title || topic.id);
  return {
    kind,
    title,
    status: $("deliverableStatusSelect").value || "draft",
    project_id: currentProjectId(),
    topic_package_ids: topicPackageIds,
    background: topicNames.length ? `基于专题包生成：${topicNames.join("；")}` : "基于已审专题包生成。",
    summary: topicNames.join("\n"),
    strategy: {
      hypothesis: "从专题包中的已审 canonical claims 提炼可验证策略假设。",
      input_data: topicNames.length ? topicNames.map((name) => `专题包：${name}`) : ["已审专题包"],
      signal: "待从专题包证据链中定义可计算信号/因子。",
      backtest_window: "待定义样本内、样本外和滚动验证窗口。",
      metrics: ["收益", "最大回撤", "换手", "胜率", "稳定性"],
      risk_checks: ["过拟合", "交易成本", "流动性", "市场阶段变化", "样本外失效"],
      implementation_steps: ["确认专题包证据状态", "定义信号", "跑回测", "做风险检查", "输出复盘报告"],
      acceptance: ["topic package Ready Gate 通过", "关键结论保留 source/chunk/quote 引用", "策略任务可被工程实现和回测复现"]
    }
  };
}

function buildDeliverableClaims(sourceId, chunks, answer = currentSourceBoundAnswer()) {
  const candidates = extractClaimLines(answer);
  const fallback = state.source.title
    ? [`需要围绕《${state.source.title}》继续提炼可验证结论。`]
    : ["当前资料需要继续提炼可验证结论。"];
  const lines = (candidates.length ? candidates : fallback).slice(0, 10);
  const chunk = chunks?.[0] || {};
  const quote = chooseEvidenceQuote(state.source.text || "");
  return lines.map((line) => {
    const claim = { text: line };
    if (sourceId && quote && !/待验证|需要验证|风险|假设|可能|不确定/.test(line)) {
      claim.citations = [{
        source_id: sourceId,
        chunk_id: chunk.id || "",
        quote,
        url: state.source.url || ""
      }];
    }
    return claim;
  });
}

function currentSourceBoundAnswer() {
  if (!state.lastAnswer || !state.source) return "";
  return state.lastAnswerSourceFingerprint === sourceFingerprint(state.source)
    ? state.lastAnswer
    : "";
}

function extractClaimLines(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)]|#+)\s*/, "").trim())
    .filter((line) => line.length >= 16 && line.length <= 180)
    .filter((line) => !/^(Agent|综合结论|知识库条目草稿|核心要点|关键结论|后续行动|风险与待验证问题)$/i.test(line))
    .slice(0, 12);
}

function extractRiskLines(text) {
  return extractClaimLines(text).filter((line) => /风险|待验证|不确定|缺失|不足|过度|假设/.test(line)).slice(0, 6);
}

function extractActionLines(text) {
  return extractClaimLines(text).filter((line) => /行动|步骤|实现|验证|回测|下一步|任务|补充/.test(line)).slice(0, 6);
}

function chooseEvidenceQuote(text) {
  const normalized = String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  const line = normalized
    .split(/\n+/)
    .map((item) => item.trim())
    .find((item) => item.length >= 24 && !item.startsWith("---") && !item.startsWith("id:"));
  return (line || normalized.slice(0, 180)).slice(0, 220);
}

function deliverableKindLabel(kind) {
  return {
    report: "研究报告",
    ppt_outline: "PPT 大纲",
    video_script: "视频脚本",
    strategy_task_brief: "策略任务单"
  }[kind] || "交付物";
}

async function saveNoteToCompanion(note) {
  const capture = await ensureCurrentSourceCaptured();
  const sourceId = capture?.source?.id;
  if (!sourceId) throw new Error("本地服务没有返回 source id。");
  const syncTag = pendingNoteSyncTag(note);
  const tags = [...new Set([
    ...(Array.isArray(note.tags) ? note.tags : []),
    syncTag
  ].filter(Boolean))];

  return companionRequest("/v1/notes", {
    method: "POST",
    body: {
      project_id: currentProjectId(),
      source_id: sourceId,
      title: note.title,
      question: note.question,
      answer: note.answer,
      excerpt: note.excerpt,
      tags
    }
  });
}

async function savePendingNoteToCompanion(note, syncTag = pendingNoteSyncTag(note)) {
  const noteProjectId = fallbackKnowledgeNoteProjectId(note);
  if (!noteProjectId || noteProjectId !== currentProjectId()) {
    throw new Error("待同步笔记不属于当前项目。");
  }
  if (!syncTag) throw new Error("待同步笔记缺少稳定同步标识。");

  let sourceId = note.sourceId || "";
  const sourceText = String(note.excerpt || "").trim();
  if (sourceText) {
    const capture = await companionRequest("/v1/captures", {
      method: "POST",
      body: {
        project_id: noteProjectId,
        source: {
          project_id: noteProjectId,
          kind: note.kind || "page",
          url: note.url || "",
          title: note.title || "未命名来源",
          site: note.site || inferSiteFromUrl(note.url || ""),
          author: note.author || "",
          published_at: note.publishedAt || "",
          captured_at: note.capturedAt || note.pendingSince || new Date().toISOString()
        },
        content: {
          text: sourceText,
          markdown: sourceText,
          blocks: [],
          images: [],
          attachments: [],
          links: [],
          next_pages: [],
          stats: {}
        },
        browser: {}
      }
    });
    sourceId = capture?.source?.id || sourceId;
  }
  if (!sourceId) throw new Error("Vault 未确认待同步笔记的来源。");

  const tags = [...new Set([
    ...(Array.isArray(note.tags) ? note.tags : []),
    syncTag
  ].filter(Boolean))];
  return companionRequest("/v1/notes", {
    method: "POST",
    body: {
      project_id: noteProjectId,
      source_id: sourceId,
      title: note.title,
      question: note.question,
      answer: note.answer,
      excerpt: note.excerpt,
      tags
    }
  });
}

async function exportKnowledgeBase(format) {
  try {
    const data = await companionRequest(
      `/v1/export?format=${encodeURIComponent(format)}&project_id=${encodeURIComponent(currentProjectId())}`,
      { method: "GET" }
    );
    if (!data.content) throw new Error("本地服务没有返回导出内容。");
    await downloadTextFile(
      data.content,
      data.filename || `qc-smart-reader-export.${format === "json" ? "json" : "md"}`,
      format === "json" ? "application/json" : "text/markdown"
    );
    const counts = data.counts || {};
    setStatus(`已从本地 Vault 导出：sources ${counts.sources || 0}，notes ${counts.notes || 0}，deliverables ${counts.deliverables || 0}。`);
    return;
  } catch (error) {
    console.warn("Companion export failed; falling back to Chrome storage.", error);
  }

  const knowledgeBase = fallbackKnowledgeNotesForProject(await loadFallbackKnowledgeNotes());
  if (!knowledgeBase.length) {
    setStatus("本地服务不可用，且 Chrome 本地知识库为空。");
    return;
  }

  const content = format === "json"
    ? JSON.stringify(knowledgeBase, null, 2)
    : knowledgeBase.map(noteToMarkdown).join("\n\n---\n\n");
  const mime = format === "json" ? "application/json" : "text/markdown";
  const ext = format === "json" ? "json" : "md";
  await downloadTextFile(content, `qc-smart-reader-knowledge-base.${ext}`, mime);
  setStatus("本地服务不可用，已导出 Chrome 本地 fallback 知识库。");
}

async function downloadTextFile(content, filename, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  await chrome.downloads.download({
    url,
    filename,
    saveAs: true
  });
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function noteToMarkdown(note) {
  return `# ${note.title}

- URL: ${note.url}
- 类型: ${note.kind}
- 时间: ${note.capturedAt}
- 问题: ${note.question}

## AI 阅读结果

${note.answer || ""}

## 原文摘录

${note.excerpt || ""}`;
}

async function clearKnowledgeBase() {
  if (!confirm("确认清空当前项目的 Chrome 本地知识库？本地 Vault 文件不会被删除。")) return;
  const projectId = currentProjectId();
  const knowledgeBase = await loadFallbackKnowledgeNotes();
  const remaining = knowledgeBase.filter((note) => fallbackKnowledgeNoteProjectId(note) !== projectId);
  await chrome.storage.local.set({ knowledgeBase: remaining });
  await loadKnowledgeBase();
  setStatus(`已清空项目 ${projectId} 的 Chrome 本地知识库；其他项目与本地 Vault 未受影响。`);
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const { apiKey: _legacyApiKey, ...localSettings } = settings || {};
  state.legacyApiKeyPending = String(_legacyApiKey || "").trim();
  state.settings = {
    serviceUrl: "http://127.0.0.1:37621",
    pairingToken: "",
    provider: "mock",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5",
    temperature: 0.2,
    codexCommand: "",
    codexTimeoutSeconds: 300,
    modelDataConsent: false,
    modelDataConsentVersion: "",
    modelDataConsentAt: "",
    modelSettingsProvider: "mock",
    modelReady: true,
    modelRoute: "mock",
    projectId: "default",
    ...localSettings
  };
  if (!hasCurrentModelDataConsent(state.settings)) {
    state.settings.modelDataConsent = false;
  }
  $("serviceUrlInput").value = state.settings.serviceUrl;
  $("pairingTokenInput").value = state.settings.pairingToken || "";
  $("providerSelect").value = state.settings.provider;
  $("baseUrlInput").value = state.settings.baseUrl;
  $("apiKeyInput").value = "";
  $("modelInput").value = state.settings.model;
  $("temperatureInput").value = state.settings.temperature;
  $("codexCommandInput").value = state.settings.codexCommand || "";
  $("codexTimeoutInput").value = normalizeCodexTimeout(state.settings.codexTimeoutSeconds);
  $("modelDataConsentInput").checked = Boolean(state.settings.modelDataConsent);
  $("projectSelect").value = state.settings.projectId || "default";
  if (state.settings.pairingToken) {
    await loadModelSettings();
    if (state.legacyApiKeyPending) {
      try {
        await saveModelSettingsToCompanion();
        setSettingsStatus("旧版 Chrome API Key 已安全迁移到本地 companion service。");
      } catch (error) {
        setSettingsStatus(`旧版 API Key 尚未迁移：${error.message}`);
      }
    }
  }
  syncProviderControls();
}

async function saveSettings(options = {}) {
  try {
    const consent = modelDataConsentFields(Boolean($("modelDataConsentInput").checked));
    state.settings = {
      ...state.settings,
      serviceUrl: $("serviceUrlInput").value.trim() || "http://127.0.0.1:37621",
      pairingToken: $("pairingTokenInput").value.trim(),
      provider: $("providerSelect").value || state.settings?.provider || "mock",
      baseUrl: $("baseUrlInput").value.trim(),
      model: $("modelInput").value.trim(),
      temperature: Number($("temperatureInput").value || 0.2),
      codexCommand: $("codexCommandInput").value.trim(),
      codexTimeoutSeconds: normalizeCodexTimeout($("codexTimeoutInput").value),
      ...consent,
      projectId: $("projectSelect").value || state.settings?.projectId || "default"
    };
    await chrome.storage.local.set({ settings: state.settings });
    let modelSaved = false;
    if (options?.saveModel !== false) {
      modelSaved = Boolean(await saveModelSettingsToCompanion());
    }
    setSettingsStatus(modelSaved || options?.saveModel === false
      ? "设置已保存。"
      : "本地设置已保存；尚未配对，模型设置未写入 companion service。");
    return state.settings;
  } catch (error) {
    setSettingsStatus(`保存设置失败：${error.message}`);
    throw error;
  }
}

async function loadModelSettings() {
  try {
    const data = await companionRequest("/v1/model-settings", { method: "GET" });
    applyModelSettings(data.settings || {});
  } catch (error) {
    console.warn("Companion model settings load failed.", error);
  }
}

function applyModelSettings(settings) {
  state.settings.provider = settings.provider ?? state.settings.provider ?? "mock";
  state.settings.baseUrl = settings.base_url ?? state.settings.baseUrl ?? "https://api.openai.com/v1";
  state.settings.model = settings.model ?? state.settings.model ?? "gpt-5";
  state.settings.temperature = Number(settings.temperature ?? state.settings.temperature ?? 0.2);
  state.settings.codexCommand = settings.codex_command ?? state.settings.codexCommand ?? "";
  state.settings.codexTimeoutSeconds = normalizeCodexTimeout(
    settings.codex_timeout_seconds ?? state.settings.codexTimeoutSeconds
  );
  state.settings.modelSettingsProvider = state.settings.provider;
  state.settings.modelRoute = settings.route || (state.settings.provider === "mock" ? "mock" : "provider");
  state.settings.modelReady = typeof settings.ready === "boolean"
    ? settings.ready
    : fallbackModelSettingsReady(settings, state.settings.provider);
  $("providerSelect").value = state.settings.provider;
  $("baseUrlInput").value = state.settings.baseUrl;
  $("modelInput").value = state.settings.model;
  $("temperatureInput").value = state.settings.temperature;
  $("codexCommandInput").value = state.settings.codexCommand;
  $("codexTimeoutInput").value = state.settings.codexTimeoutSeconds;
  $("apiKeyInput").value = "";
  $("apiKeyInput").placeholder = settings.has_api_key
    ? `服务端已保存 ${settings.api_key_hint || "API Key"}；留空不修改`
    : "留空表示不设置 API Key";
  syncProviderControls();
}

function fallbackModelSettingsReady(settings, provider) {
  if (provider === "mock") return true;
  if (provider === "codex") {
    return Boolean(settings.codex_ready || settings.codex_available || settings.codex_command);
  }
  return Boolean(settings.has_api_key);
}

function normalizeCodexTimeout(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 300;
  return Math.max(10, Math.min(3600, parsed));
}

function syncProviderControls() {
  const provider = selectedModelProvider();
  const isMock = provider === "mock";
  const isCodex = provider === "codex";
  const busy = Boolean(state.busy);
  for (const [id, hidden] of [
    ["remoteProviderFields", isMock || isCodex],
    ["codexProviderFields", !isCodex],
    ["externalModelFields", isMock],
    ["modelDataConsentRow", isMock],
    ["externalModelActions", isMock]
  ]) {
    const node = $(id);
    if (node) node.hidden = hidden;
  }
  for (const id of ["baseUrlInput", "apiKeyInput", "clearApiKeyBtn"]) {
    const node = $(id);
    if (node) node.disabled = busy || isMock || isCodex;
  }
  for (const id of ["codexCommandInput", "codexTimeoutInput"]) {
    const node = $(id);
    if (node) node.disabled = busy || !isCodex;
  }
  for (const id of ["modelInput", "temperatureInput", "modelDataConsentInput", "testSettingsBtn"]) {
    const node = $(id);
    if (node) node.disabled = busy || isMock;
  }
  const hint = $("modelRouteHint");
  if (hint) {
    if (isMock) {
      hint.textContent = "零配置模式：结构化抽取在本地生成可审阅模板，不发送网页内容，也不生成虚假聊天答案。";
    } else {
      const blockingReason = externalProviderBlockingReason(provider);
      hint.textContent = blockingReason
        ? `${blockingReason}。请保存配置并完成隐私同意。`
        : `${modelProviderLabel(provider)} 已就绪；材料只会在你主动运行模型操作时发送。`;
    }
  }
}

async function saveModelSettingsToCompanion(options = {}) {
  if (!state.settings?.pairingToken) return null;
  const body = {
    provider: $("providerSelect").value,
    base_url: $("baseUrlInput").value.trim(),
    model: $("modelInput").value.trim(),
    temperature: Number($("temperatureInput").value || 0.2),
    codex_command: $("codexCommandInput").value.trim(),
    codex_timeout_seconds: normalizeCodexTimeout($("codexTimeoutInput").value)
  };
  const apiKey = $("apiKeyInput").value.trim() || state.legacyApiKeyPending || "";
  if (apiKey) body.api_key = apiKey;
  if (options.clearApiKey) body.clear_api_key = true;
  const data = await companionRequest("/v1/model-settings", { method: "POST", body });
  state.legacyApiKeyPending = "";
  applyModelSettings(data.settings || {});
  await chrome.storage.local.set({
    settings: {
      serviceUrl: state.settings.serviceUrl,
      pairingToken: state.settings.pairingToken,
      provider: state.settings.provider,
      baseUrl: state.settings.baseUrl,
      model: state.settings.model,
      temperature: state.settings.temperature,
      codexCommand: state.settings.codexCommand,
      codexTimeoutSeconds: state.settings.codexTimeoutSeconds,
      modelDataConsent: Boolean(state.settings.modelDataConsent),
      modelDataConsentVersion: state.settings.modelDataConsentVersion || "",
      modelDataConsentAt: state.settings.modelDataConsentAt || "",
      projectId: state.settings.projectId
    }
  });
  return data.settings;
}

async function loadProjects() {
  try {
    const data = await companionRequest("/v1/projects", { method: "GET" });
    state.projects = data.projects || [];
    renderProjectSelect();
    if (await loadProjectDashboard({ quiet: true })) {
      setProjectStatus("");
    }
  } catch (error) {
    console.warn("Companion projects list failed.", error);
    state.projects = [{ id: "default", name: "Inbox" }];
    state.projectDashboard = null;
    renderProjectSelect();
    renderProjectDashboard(null);
    setProjectStatus(`无法读取项目列表：${error.message}`);
  }
}

function renderProjectSelect() {
  const select = $("projectSelect");
  if (!select) return;
  const selected = state.settings?.projectId || "default";
  const projects = state.projects.length ? state.projects : [{ id: "default", name: "Inbox" }];
  select.innerHTML = projects
    .map((project) => {
      const count = project.source_count !== undefined ? ` · ${Number(project.source_count || 0)} sources` : "";
      return `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name || project.id)}${escapeHtml(count)}</option>`;
    })
    .join("");
  select.value = projects.some((project) => project.id === selected) ? selected : "default";
  state.settings.projectId = select.value || "default";
}

async function changeProject() {
  const previousProjectId = state.batchProjectId || currentProjectId();
  const selectedProjectId = $("projectSelect")?.value || currentProjectId();
  if (selectedProjectId !== previousProjectId) clearProjectBoundKnowledgeViews();
  await saveBatchQueue(previousProjectId);
  await saveSettings({ saveModel: false });
  const nextProjectId = currentProjectId();
  resetCurrentSourceAfterProjectChange(previousProjectId, nextProjectId);
  await loadBatchQueue();
  await loadProjectBrief();
  await loadCapturePlans();
  await refreshKnowledgeWorkspace();
  await loadTopicPackages();
  await loadDeliverables();
  await loadStrategyWorkspace();
  await loadProjectDashboard();
  setProjectStatus(`当前项目：${$("projectSelect").selectedOptions[0]?.textContent || currentProjectId()}`);
}

async function createProject() {
  const name = $("newProjectNameInput").value.trim();
  if (!name) {
    setProjectStatus("请输入项目名称。");
    return;
  }
  setBusy(true);
  setProjectStatus("正在创建项目...");
  try {
    const previousProjectId = state.batchProjectId || currentProjectId();
    const result = await companionRequest("/v1/projects", {
      method: "POST",
      body: { name }
    });
    $("newProjectNameInput").value = "";
    await saveBatchQueue(previousProjectId);
    await loadProjects();
    state.settings.projectId = result.project?.id || state.settings.projectId || "default";
    $("projectSelect").value = state.settings.projectId;
    await chrome.storage.local.set({ settings: state.settings });
    resetCurrentSourceAfterProjectChange(previousProjectId, state.settings.projectId);
    await loadBatchQueue();
    await loadProjectBrief();
    await loadCapturePlans();
    await refreshKnowledgeWorkspace();
    await loadTopicPackages();
    await loadDeliverables();
    await loadStrategyWorkspace();
    await loadProjectDashboard();
    setProjectStatus(`已创建并切换到：${result.project?.name || name}`);
  } catch (error) {
    setProjectStatus(`创建项目失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function setProjectStatus(message) {
  const node = $("projectStatus");
  if (node) node.textContent = message || "";
}

function setProjectBriefStatus(message) {
  const node = $("projectBriefStatus");
  if (node) node.textContent = message || "";
}

function setCapturePlanStatus(message) {
  const node = $("capturePlanStatus");
  if (node) node.textContent = message || "";
}

async function loadProjectBrief(options = {}) {
  if (!$("projectResearchQuestionInput")) return false;
  try {
    const data = await companionRequest(`/v1/projects/${encodeURIComponent(currentProjectId())}/brief`, {
      method: "GET"
    });
    state.projectBrief = data.brief || null;
    renderProjectBrief(state.projectBrief);
    if (!options.quiet) {
      setProjectBriefStatus(state.projectBrief?.complete ? "Brief 已完整。" : "Brief 尚未完整。");
    }
    return true;
  } catch (error) {
    console.warn("Companion project brief load failed.", error);
    state.projectBrief = null;
    renderProjectBrief(null);
    if (!options.quiet) {
      setProjectBriefStatus(`读取 Brief 失败：${error.message}`);
    }
    return false;
  }
}

function renderProjectBrief(brief) {
  const mappings = [
    ["projectResearchQuestionInput", "research_question"],
    ["projectTargetOutputInput", "target_output"],
    ["projectEvidenceThresholdInput", "evidence_threshold"],
    ["projectReviewPolicyInput", "review_policy"],
    ["projectStrategyScopeInput", "strategy_scope"]
  ];
  for (const [id, key] of mappings) {
    const node = $(id);
    if (node) node.value = brief?.[key] || "";
  }
  const inclusion = $("projectInclusionRulesInput");
  if (inclusion) inclusion.value = (brief?.inclusion_rules || []).join("\n");
  const exclusion = $("projectExclusionRulesInput");
  if (exclusion) exclusion.value = (brief?.exclusion_rules || []).join("\n");
}

function textareaLines(id) {
  return String($(id)?.value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function discoverCurrentPageLinksToCapturePlans() {
  setBusy(true);
  setCapturePlanStatus("正在从当前页面发现候选来源链接...");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//.test(tab.url || "")) {
      setCapturePlanStatus("当前标签页不是可发现链接的网页。");
      return;
    }
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: discoverCandidateLinksFromPage
    });
    const result = injection?.result || {};
    const page = result.page || { url: tab.url || "", title: tab.title || "" };
    const candidates = normalizeDiscoveredLinkCandidates(result.candidates || [], page);
    if (!candidates.length) {
      setCapturePlanStatus("当前页面没有发现符合条件的 thread/article 候选链接。");
      return;
    }
    const data = await companionRequest("/v1/capture-plans", {
      method: "POST",
      body: {
        project_id: currentProjectId(),
        items: candidates.map((candidate) => ({
          url: candidate.url,
          canonical_url: candidate.canonicalUrl,
          title: candidate.title,
          source_type: candidate.sourceType,
          priority: Number($("capturePlanPriorityInput")?.value || 3),
          reason: candidate.reason,
          metadata: {
            discovered_from_url: normalizeUrl(page.url || tab.url || ""),
            discovered_from_title: page.title || tab.title || "",
            discovery_score: candidate.score,
            discovery_text: candidate.text,
            discovery_reason: candidate.reason
          }
        }))
      }
    });
    $("capturePlanUrlsInput").value = candidates.map((candidate) => candidate.url).join("\n");
    if (!$("capturePlanReasonInput")?.value.trim()) {
      $("capturePlanReasonInput").value = `从列表页发现：${page.title || page.url || tab.title || ""}`;
    }
    state.capturePlans = data.plans || [];
    await loadCapturePlans({ quiet: true });
    await loadProjectDashboard({ quiet: true });
    setCapturePlanStatus(`已从当前页面发现并加入 ${candidates.length} 条候选来源。`);
  } catch (error) {
    setCapturePlanStatus(`发现候选链接失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function normalizeDiscoveredLinkCandidates(rawCandidates, page) {
  const seen = new Set();
  const output = [];
  for (const item of rawCandidates || []) {
    const url = normalizeUrl(item.url || item.href || "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = String(item.title || item.text || url).trim().slice(0, 180);
    output.push({
      url,
      canonicalUrl: url,
      title: title || url,
      text: String(item.text || "").trim().slice(0, 240),
      score: Number(item.score || 0),
      sourceType: inferCapturePlanSourceType(url),
      reason: `从列表页发现：${page.title || page.url || "current page"}`
    });
  }
  return output.slice(0, 100);
}

function inferCapturePlanSourceType(url) {
  const lowered = String(url || "").toLowerCase();
  if (/\.pdf($|[?#])/.test(lowered)) return "pdf";
  if (/arxiv\.org\/abs\//.test(lowered)) return "paper";
  if (/\/(?:thread|topic|post|discussion|discussions|issues|comments?)\b|news\.ycombinator\.com\/item\?id=|reddit\.com\/r\/[^/]+\/comments\//.test(lowered)) {
    return "thread";
  }
  return "article";
}

async function createNextPageCapturePlans() {
  const source = state.source || {};
  const nextPages = (Array.isArray(source.nextPages) ? source.nextPages : [])
    .map((url) => normalizeUrl(url))
    .filter(Boolean);
  if (!nextPages.length) {
    setLocalizedStatus("currentPage.nextPages.none");
    return;
  }
  setBusy(true);
  setLocalizedStatus("currentPage.nextPages.working", { count: nextPages.length });
  try {
    const data = await companionRequest("/v1/capture-plans", {
      method: "POST",
      body: {
        project_id: currentProjectId(),
        items: nextPages.map((url, index) => ({
          url,
          canonical_url: url,
          title: `${source.title || "分页来源"} - page ${index + 2}`,
          source_type: source.kind?.includes("thread") ? "thread" : inferCapturePlanSourceType(url),
          priority: 2,
          reason: `分页继续：${source.title || source.url || "current source"}`,
          metadata: {
            pagination_from_url: source.url || "",
            pagination_from_title: source.title || "",
            pagination_index: index + 2
          }
        }))
      }
    });
    if ($("capturePlanUrlsInput")) {
      $("capturePlanUrlsInput").value = nextPages.join("\n");
    }
    if ($("capturePlanSourceTypeInput")) {
      $("capturePlanSourceTypeInput").value = source.kind?.includes("thread") ? "thread" : "url";
    }
    if ($("capturePlanReasonInput") && !$("capturePlanReasonInput").value.trim()) {
      $("capturePlanReasonInput").value = `分页继续：${source.title || source.url || ""}`;
    }
    state.capturePlans = data.plans || [];
    await loadCapturePlans({ quiet: true });
    await loadProjectDashboard({ quiet: true });
    setLocalizedStatus("currentPage.nextPages.success", { count: nextPages.length });
    setCapturePlanStatus(`已加入 ${nextPages.length} 个分页候选来源。`);
  } catch (error) {
    setLocalizedStatus("currentPage.nextPages.failed", {
      error: errorI18nParam(error)
    });
  } finally {
    setBusy(false);
  }
}

async function createBatchItemNextPageCapturePlans(itemId) {
  const item = state.batchQueue.find((candidate) => candidate.id === itemId);
  if (!item) {
    setBatchStatus("没有找到这条批量队列项。");
    return;
  }
  const checkpoint = normalizeBatchPaginationCheckpoint(item.paginationCheckpoint, {
    url: item.url,
    title: item.title,
    sourceId: item.sourceId,
    jobId: item.jobId,
    jobItemId: item.jobItemId,
    nextPages: item.nextPages || []
  });
  if (!checkpoint?.next_pages?.length) {
    setBatchStatus("这条队列项没有分页 checkpoint。");
    return;
  }
  setBusy(true);
  setBatchStatus("正在把批量分页 checkpoint 加入 Capture Plan...");
  try {
    const nextPages = checkpoint.next_pages;
    const data = await companionRequest("/v1/capture-plans", {
      method: "POST",
      body: {
        project_id: currentProjectId(),
        items: nextPages.map((url, index) => ({
          url,
          canonical_url: url,
          title: `${checkpoint.source_title || item.title || "分页来源"} - page ${index + 2}`,
          source_type: inferCapturePlanSourceType(url),
          priority: 2,
          reason: `分页 checkpoint：${checkpoint.source_title || item.title || item.url}`,
          metadata: {
            pagination_from_url: checkpoint.source_url || item.url || "",
            pagination_from_title: checkpoint.source_title || item.title || "",
            pagination_source_id: checkpoint.source_id || item.sourceId || "",
            pagination_job_id: checkpoint.job_id || item.jobId || "",
            pagination_job_item_id: checkpoint.job_item_id || item.jobItemId || "",
            pagination_index: index + 2,
            pagination_checkpoint: true
          }
        }))
      }
    });
    if ($("capturePlanUrlsInput")) {
      $("capturePlanUrlsInput").value = nextPages.join("\n");
    }
    if ($("capturePlanReasonInput") && !$("capturePlanReasonInput").value.trim()) {
      $("capturePlanReasonInput").value = `分页 checkpoint：${checkpoint.source_title || item.title || item.url || ""}`;
    }
    state.capturePlans = data.plans || [];
    await loadCapturePlans({ quiet: true });
    await loadProjectDashboard({ quiet: true });
    setBatchStatus(`已把 ${nextPages.length} 个分页 checkpoint 加入候选池。`);
    setCapturePlanStatus(`已把 ${nextPages.length} 个分页 checkpoint 加入候选池。`);
  } catch (error) {
    setBatchStatus(`分页 checkpoint 入候选失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function discoverCandidateLinksFromPage() {
  const currentUrl = new URL(location.href);
  const currentHost = currentUrl.hostname.replace(/^www\./, "");
  const rows = [];
  const seen = new Set();
  for (const link of Array.from(document.querySelectorAll("a[href]"))) {
    let url;
    try {
      url = new URL(link.href, location.href);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol)) continue;
    url.hash = "";
    const href = url.href;
    if (href === currentUrl.href || seen.has(href)) continue;
    const text = normalizeDiscoveryText(link.innerText || link.textContent || link.getAttribute("aria-label") || link.title || "");
    const title = normalizeDiscoveryText(link.title || text || href);
    if (shouldSkipDiscoveryLink(url, text)) continue;
    const score = scoreDiscoveryLink(url, text, currentHost);
    if (score < 4) continue;
    seen.add(href);
    rows.push({
      url: href,
      title,
      text,
      score,
      reason: discoveryReason(url, text, currentHost)
    });
  }
  rows.sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));
  return {
    page: {
      url: location.href,
      title: document.title || ""
    },
    candidates: rows.slice(0, 100),
    stats: {
      scanned_links: document.querySelectorAll("a[href]").length,
      candidate_links: rows.length,
      kept_links: Math.min(rows.length, 100)
    }
  };

  function normalizeDiscoveryText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);
  }

  function shouldSkipDiscoveryLink(url, text) {
    const lowered = `${url.href} ${text}`.toLowerCase();
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|ico|mp3|mp4|zip|7z|rar|docx?|xlsx?|pptx?)($|[?#])/.test(url.pathname.toLowerCase())) {
      return true;
    }
    if (/(login|logout|signin|signup|register|account|profile|setting|search|tag|category|share|reply|comment-page|javascript)/.test(lowered)) {
      return true;
    }
    if (/^(下一页|上一页|next|prev|previous|more|更多|返回|首页)$/.test(text.toLowerCase())) {
      return true;
    }
    return false;
  }

  function scoreDiscoveryLink(url, text, host) {
    const linkHost = url.hostname.replace(/^www\./, "");
    const href = url.href.toLowerCase();
    let score = linkHost === host ? 2 : 0;
    if (/\/(?:thread|topic|post|article|articles|discussion|discussions|issues|comments?)\b/.test(href)) score += 5;
    if (/news\.ycombinator\.com\/item\?id=\d+/.test(href)) score += 5;
    if (/reddit\.com\/r\/[^/]+\/comments\//.test(href)) score += 5;
    if (/arxiv\.org\/abs\/\d/.test(href)) score += 5;
    if (/github\.com\/[^/]+\/[^/]+\/(?:discussions|issues)\/\d+/.test(href)) score += 5;
    if (/\/p\/[\w-]+|\/\d{4}\/\d{2}\/|\/\d{4}-\d{2}-\d{2}\//.test(href)) score += 3;
    if (text.length >= 10) score += 1;
    if (/策略|研究|回测|因子|量化|论文|thread|discussion|research|strategy|factor|backtest/i.test(text)) score += 1;
    return score;
  }

  function discoveryReason(url, text, host) {
    const linkHost = url.hostname.replace(/^www\./, "");
    const sameSite = linkHost === host ? "同站" : linkHost;
    return `${sameSite}候选来源${text ? `：${text}` : ""}`;
  }
}

async function saveProjectBrief() {
  setBusy(true);
  setProjectBriefStatus("正在保存 Brief...");
  try {
    const data = await companionRequest(`/v1/projects/${encodeURIComponent(currentProjectId())}/brief`, {
      method: "POST",
      body: {
        research_question: $("projectResearchQuestionInput")?.value.trim() || "",
        target_output: $("projectTargetOutputInput")?.value.trim() || "",
        inclusion_rules: textareaLines("projectInclusionRulesInput"),
        exclusion_rules: textareaLines("projectExclusionRulesInput"),
        evidence_threshold: $("projectEvidenceThresholdInput")?.value.trim() || "",
        review_policy: $("projectReviewPolicyInput")?.value.trim() || "",
        strategy_scope: $("projectStrategyScopeInput")?.value.trim() || ""
      }
    });
    state.projectBrief = data.brief || null;
    renderProjectBrief(state.projectBrief);
    await loadProjectDashboard({ quiet: true });
    setProjectBriefStatus(state.projectBrief?.complete ? "Brief 已保存并达到完整门槛。" : "Brief 已保存，但仍缺必填门槛。");
  } catch (error) {
    setProjectBriefStatus(`保存 Brief 失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function loadCapturePlans(options = {}) {
  if (!$("capturePlanList")) return false;
  try {
    const query = queryWithProject({ limit: "100" });
    const data = await companionRequest(`/v1/capture-plans${query}`, { method: "GET" });
    state.capturePlans = data.plans || [];
    renderCapturePlans();
    if (!options.quiet) {
      setCapturePlanStatus(`已载入 ${state.capturePlans.length} 条 capture plan。`);
    }
    return true;
  } catch (error) {
    console.warn("Companion capture plan load failed.", error);
    state.capturePlans = [];
    renderCapturePlans();
    if (!options.quiet) {
      setCapturePlanStatus(`读取 Capture Plan 失败：${error.message}`);
    }
    return false;
  }
}

async function createCapturePlans() {
  const urls = textareaLines("capturePlanUrlsInput");
  if (!urls.length) {
    setCapturePlanStatus("请输入至少一个 URL。");
    return;
  }
  setBusy(true);
  setCapturePlanStatus("正在加入候选池...");
  try {
    const data = await companionRequest("/v1/capture-plans", {
      method: "POST",
      body: {
        project_id: currentProjectId(),
        urls,
        source_type: $("capturePlanSourceTypeInput")?.value.trim() || "url",
        priority: Number($("capturePlanPriorityInput")?.value || 3),
        reason: $("capturePlanReasonInput")?.value.trim() || ""
      }
    });
    $("capturePlanUrlsInput").value = "";
    state.capturePlans = data.plans || [];
    await loadCapturePlans({ quiet: true });
    await loadProjectDashboard({ quiet: true });
    setCapturePlanStatus(`已加入/更新 ${state.capturePlans.length} 条候选来源。`);
  } catch (error) {
    setCapturePlanStatus(`加入候选池失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function renderCapturePlans() {
  const node = $("capturePlanList");
  if (!node) return;
  if (!state.capturePlans.length) {
    node.innerHTML = `<p class="hint">还没有候选来源。先把 URL 加入候选池，再审批进入队列。</p>`;
    return;
  }
  node.innerHTML = state.capturePlans
    .map((plan) => {
      const status = String(plan.status || "candidate").replace(/_/g, "-");
      const reason = plan.reason ? `<p>${escapeHtml(plan.reason)}</p>` : "";
      const screenReason = plan.screen_reason ? `<small>筛选备注：${escapeHtml(plan.screen_reason)}</small>` : "";
      return `
        <article class="capture-plan-card">
          <div class="capture-plan-main">
            <span class="status-pill ${escapeHtml(status)}">${escapeHtml(capturePlanStatusLabel(plan.status))}</span>
            <div>
              <strong>${escapeHtml(plan.title || plan.url)}</strong>
              <small>${escapeHtml(plan.source_type || "url")} · P${Number(plan.priority || 3)} · ${escapeHtml(plan.url)}</small>
              ${reason}
              ${screenReason}
            </div>
          </div>
          <div class="capture-plan-actions">
            <button data-capture-plan-status="approved" data-capture-plan-id="${escapeHtml(plan.id)}">批准</button>
            <button data-capture-plan-status="rejected" data-capture-plan-id="${escapeHtml(plan.id)}">拒绝</button>
            <button data-capture-plan-status="candidate" data-capture-plan-id="${escapeHtml(plan.id)}">候选</button>
          </div>
        </article>
      `;
    })
    .join("");
  node.querySelectorAll("[data-capture-plan-status]").forEach((button) => {
    button.addEventListener("click", () => updateCapturePlanStatus(button.dataset.capturePlanId, button.dataset.capturePlanStatus));
  });
}

function capturePlanStatusLabel(status) {
  const labels = {
    candidate: "候选",
    approved: "已批准",
    rejected: "已拒绝",
    queued: "已入队",
    captured: "已采集"
  };
  return labels[status] || status || "候选";
}

async function updateCapturePlanStatus(planId, status) {
  if (!planId || !status) return;
  setBusy(true);
  setCapturePlanStatus("正在更新计划状态...");
  try {
    await companionRequest(`/v1/capture-plans/${encodeURIComponent(planId)}/status`, {
      method: "POST",
      body: {
        status,
        reviewer: $("projectStageReviewerInput")?.value.trim() || "",
        screen_reason: $("projectStageNoteInput")?.value.trim() || ""
      }
    });
    await loadCapturePlans({ quiet: true });
    await loadProjectDashboard({ quiet: true });
    setCapturePlanStatus(`已更新为：${capturePlanStatusLabel(status)}`);
  } catch (error) {
    setCapturePlanStatus(`更新计划状态失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function enqueueApprovedCapturePlans() {
  setBusy(true);
  setCapturePlanStatus("正在把 approved 计划加入读取队列...");
  try {
    const data = await companionRequest("/v1/capture-plans/enqueue-approved", {
      method: "POST",
      body: { project_id: currentProjectId() }
    });
    await loadCapturePlans({ quiet: true });
    await loadProjectDashboard({ quiet: true });
    await loadBatchQueue();
    setCapturePlanStatus(`已创建读取任务：${data.job?.id || ""}，共 ${data.plans?.length || 0} 条。`);
  } catch (error) {
    setCapturePlanStatus(`入队失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function loadProjectDashboard(options = {}) {
  const node = $("projectDashboard");
  if (!node) return false;
  try {
    const data = await companionRequest(`/v1/projects/${encodeURIComponent(currentProjectId())}/dashboard`, {
      method: "GET"
    });
    state.projectDashboard = data.dashboard || null;
    renderProjectDashboard(state.projectDashboard);
    return true;
  } catch (error) {
    console.warn("Companion project dashboard load failed.", error);
    state.projectDashboard = null;
    renderProjectDashboard(null);
    if (!options.quiet) {
      setProjectStatus(`无法读取项目仪表盘：${error.message}`);
    }
    return false;
  }
}

function renderProjectDashboard(dashboard) {
  const node = $("projectDashboard");
  if (!node) return;
  if (!dashboard?.stages?.length) {
    node.innerHTML = `<p class="hint">项目阶段仪表盘会在 companion service 可用后显示。</p>`;
    return;
  }

  const metrics = dashboard.metrics || {};
  const summary = dashboard.stage_summary || {};
  const sourceStatusCounts = metrics.source_status_counts || {};
  const sourceStatusSummary = Object.entries(sourceStatusCounts)
    .map(([status, count]) => `${escapeHtml(SOURCE_STATUS_LABELS[status] || status)} ${Number(count || 0)}`)
    .join(" · ");
  const finalKinds = Object.entries(metrics.final_deliverables || {})
    .filter(([, count]) => Number(count || 0) > 0)
    .map(([kind, count]) => `${escapeHtml(kind)} ${Number(count || 0)}`)
    .join(" · ");

  const stageCards = dashboard.stages
    .map((stage) => {
      const status = String(stage.status || "in_progress").replace(/_/g, "-");
      const blockers = (stage.blockers || [])
        .map((blocker) => `<li>${escapeHtml(blocker)}</li>`)
        .join("");
      const confirmedMeta = stage.confirmed
        ? `<small>确认：${escapeHtml(stage.reviewer || "未署名")} · ${escapeHtml(stage.confirmed_at || "")}</small>`
        : "";
      const note = stage.note ? `<p>${escapeHtml(stage.note)}</p>` : "";
      const buttonLabel = stage.confirmed ? "更新确认" : (stage.ready ? "确认阶段" : "风险接受");
      return `
        <article class="project-stage-card ${escapeHtml(status)}">
          <div class="project-stage-head">
            <strong>${escapeHtml(stage.label || stage.id)}</strong>
            <span class="status-pill ${escapeHtml(status)}">${escapeHtml(stageStatusLabel(stage.status))}</span>
          </div>
          <div class="project-stage-progress" aria-label="${escapeHtml(stage.label || stage.id)} progress">
            <span style="width: ${Math.round(Number(stage.progress || 0) * 100)}%"></span>
          </div>
          <div class="project-stage-meta">
            <span>${Number(stage.current || 0)} / ${Number(stage.target || 0)}</span>
            <span>${escapeHtml(stage.exit_criteria || "")}</span>
          </div>
          ${blockers ? `<ul class="project-stage-blockers">${blockers}</ul>` : `<p class="hint">退出标准已满足，等待人工确认。</p>`}
          ${confirmedMeta}
          ${note}
          <div class="project-stage-actions">
            <button data-confirm-project-stage="${escapeHtml(stage.id)}">${buttonLabel}</button>
          </div>
        </article>
      `;
    })
    .join("");

  node.innerHTML = `
    <div class="project-dashboard-summary">
      <span>${Number(summary.confirmed || 0)} / ${Number(summary.total || 0)} 已确认</span>
      <span>${Number(summary.ready || 0)} 个阶段达到自动门槛</span>
      <span>${Number(metrics.source_count || 0)} sources</span>
      <span>${Number(metrics.reviewed_claim_count || 0)} reviewed claims</span>
      <span>${Number(metrics.reviewed_topic_package_count || 0)} reviewed topics</span>
      <span>${Number(metrics.stale_topic_package_count || 0)} stale topics</span>
      <span>${Number(metrics.stale_deliverable_count || 0)} stale deliverables</span>
      <span>${Number(metrics.strategy_handoff_count || 0)} handoffs</span>
      <span>${Number(metrics.passed_strategy_review_count || 0)} passed reviews</span>
    </div>
    <p class="hint">${sourceStatusSummary || "暂无 source 状态分布"}${finalKinds ? ` · final: ${finalKinds}` : ""}</p>
    <div class="project-stage-list">${stageCards}</div>
  `;

  node.querySelectorAll("[data-confirm-project-stage]").forEach((button) => {
    button.addEventListener("click", () => confirmProjectStage(button.dataset.confirmProjectStage));
  });
}

function stageStatusLabel(status) {
  const labels = {
    confirmed: "已确认",
    ready: "待确认",
    in_progress: "进行中",
    "in-progress": "进行中"
  };
  return labels[status] || status || "进行中";
}

async function confirmProjectStage(stageId) {
  if (!stageId) return;
  const dashboardStage = (state.projectDashboard?.stages || []).find((stage) => stage.id === stageId);
  const note = $("projectStageNoteInput")?.value.trim() || "";
  if (dashboardStage && !dashboardStage.ready && !dashboardStage.confirmed && !note) {
    setProjectStatus("该阶段还未达到自动门槛；如要风险接受，请先填写确认备注。");
    return;
  }

  setBusy(true);
  setProjectStatus("正在确认项目阶段...");
  try {
    const data = await companionRequest(
      `/v1/projects/${encodeURIComponent(currentProjectId())}/stages/${encodeURIComponent(stageId)}/confirm`,
      {
        method: "POST",
        body: {
          reviewer: $("projectStageReviewerInput")?.value.trim() || "",
          note
        }
      }
    );
    state.projectDashboard = data.dashboard || null;
    renderProjectDashboard(state.projectDashboard);
    setProjectStatus(`已确认阶段：${dashboardStage?.label || stageId}`);
  } catch (error) {
    setProjectStatus(`确认阶段失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function runVaultDoctor() {
  setBusy(true);
  setVaultDoctorStatus("正在检查 Vault...");
  try {
    const data = await companionRequest(`/v1/vault/doctor${queryWithProject({ write_report: "1" })}`, {
      method: "GET"
    });
    state.vaultDoctor = data.doctor || null;
    renderVaultDoctor(state.vaultDoctor);
    const counts = state.vaultDoctor?.counts || {};
    setVaultDoctorStatus(
      `Vault Doctor 完成：${Number(counts.errors || 0)} errors，${Number(counts.warnings || 0)} warnings。`
    );
  } catch (error) {
    state.vaultDoctor = null;
    renderVaultDoctor(null);
    setVaultDoctorStatus(`Vault Doctor 失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function rebuildLineage() {
  setBusy(true);
  setLineageStatus("正在重建依赖血缘...");
  try {
    const data = await companionRequest("/v1/lineage/rebuild", {
      method: "POST",
      body: { project_id: currentProjectId() }
    });
    state.lineage = data.lineage || null;
    renderLineage(state.lineage);
    setLineageStatus(`Lineage 完成：${Number(state.lineage?.edge_count || 0)} 条依赖边。`);
  } catch (error) {
    state.lineage = null;
    renderLineage(null);
    setLineageStatus(`Lineage 失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function setVaultDoctorStatus(message) {
  const node = $("vaultDoctorStatus");
  if (node) node.textContent = message || "";
}

function setLineageStatus(message) {
  const node = $("lineageStatus");
  if (node) node.textContent = message || "";
}

function renderVaultDoctor(report) {
  const node = $("vaultDoctorResults");
  if (!node) return;
  if (!report) {
    node.innerHTML = "";
    return;
  }
  const counts = report.counts || {};
  const issues = report.issues || [];
  const issueRows = issues.slice(0, 12).map((issue) => `
    <div class="vault-doctor-issue ${escapeHtml(issue.severity || "warning")}">
      <strong>${escapeHtml(issue.code || "issue")}</strong>
      <small>${escapeHtml([issue.table, issue.record_id, issue.field].filter(Boolean).join(" · "))}</small>
      <p>${escapeHtml(issue.message || "")}</p>
      ${issue.path ? `<small>${escapeHtml(issue.path)}</small>` : ""}
    </div>
  `).join("");
  node.innerHTML = `
    <div class="project-dashboard-summary">
      <span>${report.ok ? "OK" : "Needs Fix"}</span>
      <span>${Number(counts.files_checked || 0)} files</span>
      <span>${Number(counts.references_checked || 0)} refs</span>
      <span>${Number(counts.errors || 0)} errors</span>
      <span>${Number(counts.warnings || 0)} warnings</span>
    </div>
    ${report.markdown_path ? `<p class="hint">${escapeHtml(report.markdown_path)}</p>` : ""}
    <div class="vault-doctor-list">${issueRows || `<p class="hint">没有发现问题。</p>`}</div>
  `;
}

function renderLineage(lineage) {
  const node = $("lineageResults");
  if (!node) return;
  if (!lineage) {
    node.innerHTML = "";
    return;
  }
  const summary = lineage.summary || {};
  const byRelation = summary.by_relation || {};
  const relationRows = Object.entries(byRelation)
    .slice(0, 12)
    .map(([relation, count]) => `<li><span>${escapeHtml(relation)}</span><strong>${Number(count || 0)}</strong></li>`)
    .join("");
  const downstreamRows = Object.entries(summary.by_downstream_type || {})
    .slice(0, 8)
    .map(([type, count]) => `<span>${escapeHtml(type)} ${Number(count || 0)}</span>`)
    .join("");
  node.innerHTML = `
    <div class="project-dashboard-summary">
      <span>${Number(summary.edge_count || lineage.edge_count || 0)} edges</span>
      <span>${escapeHtml(summary.project_id || lineage.project_id || currentProjectId())}</span>
      <span>${escapeHtml(lineage.rebuilt_at || "")}</span>
    </div>
    <div class="lineage-downstream">${downstreamRows || `<span>暂无 downstream 统计</span>`}</div>
    <ul class="lineage-relation-list">${relationRows || `<li><span>暂无依赖关系</span><strong>0</strong></li>`}</ul>
  `;
}

async function testCompanion() {
  setBusy(true);
  setLocalizedSettingsStatus("settings.status.testing");
  try {
    await saveSettings({ saveModel: false });
    setLocalizedSettingsStatus("settings.status.testing");
    const health = await companionRequest("/health", { method: "GET" });
    assertCompatibleCompanion(health);
    if (health.pairing_required && !state.settings?.pairingToken) {
      setLocalizedSettingsStatus("settings.status.needToken", {
        path: health.pairing_token_path || "state/pairing_token.txt"
      });
      return;
    }
    const projectsResponse = await companionRequest("/v1/projects", { method: "GET" });
    state.projects = projectsResponse.projects || [];
    renderProjectSelect();
    await loadModelSettings();
    await markOnboardingMilestone("pairedAt");
    renderQuickStart();
    setLocalizedSettingsStatus("settings.status.success", {
      extensionVersion: EXTENSION_VERSION,
      serviceVersion: health.service_version || health.version,
      apiVersion: health.api_version,
      vault: health.vault_dir || health.data_dir
    });
    showTab("chat");
    $("quickStartBtn")?.focus?.();
  } catch (error) {
    const invalidToken = /missing x-qc-pairing-token|invalid pairing token|HTTP 401|HTTP 403/i.test(error.message);
    setLocalizedSettingsStatus(
      invalidToken ? "settings.status.invalidToken" : "settings.status.unavailable",
      { error: errorI18nParam(error) }
    );
  } finally {
    setBusy(false);
  }
}

async function testSettings() {
  setBusy(true);
  setSettingsStatus("正在保存并测试模型...");
  try {
    await saveSettings();
    const provider = selectedModelProvider();
    if (provider === "mock") {
      setSettingsStatus("本地模板已就绪：不调用外部模型，无需发送测试提示。可直接运行 Quick Start。");
      return;
    }
    const blockingReason = externalProviderBlockingReason(provider);
    if (blockingReason) throw new Error(`${blockingReason}。`);
    setSettingsStatus("正在测试模型...");
    const answer = await callLlm("请只回复：QC Smart Reader 连接成功。");
    setSettingsStatus(`模型连接成功：${answer.slice(0, 120)}`);
  } catch (error) {
    setSettingsStatus(`模型测试失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function persistModelDataConsent() {
  await ensureSettingsLoaded();
  Object.assign(state.settings, modelDataConsentFields(Boolean($("modelDataConsentInput").checked)));
  await chrome.storage.local.set({ settings: state.settings });
  setSettingsStatus(hasCurrentModelDataConsent() ? "已记录当前隐私说明下的模型数据使用同意。" : "已取消模型数据使用同意；模型调用将被阻止。");
}

function hasCurrentModelDataConsent(settings = state.settings) {
  return Boolean(settings?.modelDataConsent)
    && settings.modelDataConsentVersion === MODEL_DATA_CONSENT_VERSION;
}

function modelDataConsentFields(checked) {
  if (!checked) {
    return {
      modelDataConsent: false,
      modelDataConsentVersion: "",
      modelDataConsentAt: ""
    };
  }
  const alreadyCurrent = hasCurrentModelDataConsent();
  return {
    modelDataConsent: true,
    modelDataConsentVersion: MODEL_DATA_CONSENT_VERSION,
    modelDataConsentAt: alreadyCurrent && state.settings?.modelDataConsentAt
      ? state.settings.modelDataConsentAt
      : new Date().toISOString()
  };
}

function assertCompatibleCompanion(health) {
  if (!health || health.ok !== true || health.app !== "QC Smart Reader") {
    throw localizedError(
      "companion.error.wrongService",
      "该地址有响应，但不是 QC Smart Reader Companion。"
    );
  }
  const apiVersion = Number(health.api_version);
  if (apiVersion !== REQUIRED_COMPANION_API_VERSION) {
    throw localizedError(
      "companion.error.apiMismatch",
      `扩展 ${EXTENSION_VERSION} 需要 Companion API ${REQUIRED_COMPANION_API_VERSION}，当前 API 为 ${health.api_version ?? "旧版或未知"}。请更新并重启 Companion。`,
      {
        extensionVersion: EXTENSION_VERSION,
        requiredApi: REQUIRED_COMPANION_API_VERSION,
        actualApi: health.api_version ?? { i18nKey: "companion.value.legacyUnknown" }
      }
    );
  }
  const minimumExtension = String(health.min_extension_version || "").trim();
  if (minimumExtension && compareProductVersions(EXTENSION_VERSION, minimumExtension) < 0) {
    throw localizedError(
      "companion.error.extensionTooOld",
      `扩展版本过旧。Companion 要求扩展 ${minimumExtension} 或更高，当前为 ${EXTENSION_VERSION}。请更新扩展。`,
      {
        requiredVersion: minimumExtension,
        currentVersion: EXTENSION_VERSION
      }
    );
  }
}

function compareProductVersions(left, right) {
  const parse = (value) => String(value || "")
    .split(".")
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 10) || 0);
  const leftParts = parse(left);
  const rightParts = parse(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

async function clearServiceApiKey() {
  if (!confirm("确认清除 companion service 中保存的模型 API Key？清除后需要重新填写才能调用该服务商。")) return;
  setBusy(true);
  setSettingsStatus("正在清除服务端 API Key...");
  try {
    await saveSettings({ saveModel: false });
    if (!state.settings?.pairingToken) {
      setSettingsStatus("请先填写 Pairing Token。");
      return;
    }
    setSettingsStatus("正在清除服务端 API Key...");
    await saveModelSettingsToCompanion({ clearApiKey: true });
    setSettingsStatus("服务端 API Key 已清除。");
  } catch (error) {
    setSettingsStatus(`清除失败：${error.message}`);
  } finally {
    setBusy(false);
  }
}

function showTab(tabId) {
  const tab = document.querySelector(`.tab[data-tab="${tabId}"]`);
  tab?.click();
  tab?.focus?.();
}

function setBusy(isBusy) {
  state.busyDepth = Math.max(0, Number(state.busyDepth || 0) + (isBusy ? 1 : -1));
  state.busy = state.busyDepth > 0;
  const ids = [
    "uiLocaleSelect",
    "readPageBtn",
    "quickStartBtn",
    "quickStartAcceptClaimBtn",
    "quickStartRejectClaimBtn",
    "useSelectionBtn",
    "saveNoteBtn",
    "manualSelectorInput",
    "readSelectorBtn",
    "enqueueNextPagesBtn",
    "askBtn",
    "testSettingsBtn",
    "testCompanionBtn",
    "saveSettingsBtn",
    "clearApiKeyBtn",
    "providerSelect",
    "baseUrlInput",
    "apiKeyInput",
    "modelInput",
    "temperatureInput",
    "codexCommandInput",
    "codexTimeoutInput",
    "modelDataConsentInput",
    "pairingTokenInput",
    "runVaultDoctorBtn",
    "rebuildLineageBtn",
    "projectSelect",
    "projectStageReviewerInput",
    "projectStageNoteInput",
    "projectResearchQuestionInput",
    "projectTargetOutputInput",
    "projectInclusionRulesInput",
    "projectExclusionRulesInput",
    "projectEvidenceThresholdInput",
    "projectReviewPolicyInput",
    "projectStrategyScopeInput",
    "refreshProjectBriefBtn",
    "saveProjectBriefBtn",
    "capturePlanUrlsInput",
    "capturePlanSourceTypeInput",
    "capturePlanPriorityInput",
    "capturePlanReasonInput",
    "discoverCurrentPageLinksBtn",
    "createCapturePlansBtn",
    "refreshCapturePlansBtn",
    "enqueueApprovedPlansBtn",
    "refreshProjectsBtn",
    "createProjectBtn",
    "refreshKbBtn",
    "syncPendingNotesBtn",
    "refreshReviewQueueBtn",
    "exportMarkdownBtn",
    "exportJsonBtn",
    "clearKbBtn",
    "sourceStatusFilter",
    "searchSourcesBtn",
    "clearSourceSearchBtn",
    "enqueueBatchBtn",
    "addOpenTabsBtn",
    "restoreBatchBtn",
    "batchConcurrencyInput",
    "processBatchBtn",
    "pauseBatchBtn",
    "cancelBatchBtn",
    "clearCompletedBatchBtn",
    "clearBatchBtn",
    "pdfInput",
    "pdfOcrInput",
    "ingestPdfBtn",
    "youtubeUrlInput",
    "youtubeTitleInput",
    "youtubeLanguageInput",
    "youtubeTranscriptInput",
    "ingestYoutubeBtn",
    "createDeliverableBtn",
    "refreshDeliverablesBtn",
    "refreshTopicPackagesBtn",
    "strategyHandoffSelect",
    "strategyTicketOwnerInput",
    "refreshStrategyTicketsBtn",
    "generateStrategyTicketsBtn",
    "backtestOutcomeSelect",
    "backtestStatusSelect",
    "backtestPeriodInput",
    "backtestUniverseInput",
    "backtestBenchmarkInput",
    "backtestMetricsInput",
    "backtestCostsInput",
    "backtestRiskInput",
    "backtestArtifactInput",
    "backtestFailureNotesInput",
    "importBacktestResultBtn",
    "refreshStrategyFeedbackBtn",
    "strategyReviewBacktestSelect",
    "strategyReviewGateSelect",
    "strategyReviewerInput",
    "strategyReviewNoteInput",
    "strategyReviewArtifactInput",
    "createStrategyReviewBtn",
    "extractKnowledgeBtn",
    "createLearningPackBtn",
    "createTopicPackageBtn",
    "refreshKnowledgeRecordsBtn",
    "refreshLearningItemsBtn",
    "claimReviewStatusFilter",
    "claimReviewQuoteFilter",
    "claimReviewStrengthFilter",
    "claimReviewSourceFilter",
    "claimReviewTopicFilter",
    "claimReviewerInput",
    "claimReviewNoteInput",
    "claimRejectionReasonInput",
    "claimSplitTextInput",
    "refreshClaimReviewQueueBtn",
    "batchAcceptClaimsBtn",
    "batchPendingClaimsBtn",
    "batchRejectClaimsBtn",
    "mergeSelectedClaimsBtn",
    "splitSelectedClaimBtn"
  ];
  ids.forEach((id) => {
    const node = $(id);
    if (!node) return;
    if (id === "pauseBatchBtn" || id === "cancelBatchBtn") {
      node.disabled = !state.batchRunning;
      return;
    }
    if (id === "quickStartAcceptClaimBtn" || id === "quickStartRejectClaimBtn") {
      const decisionStatus = quickStartDecisionStatus();
      const decisionCompleted = Boolean(
        decisionStatus
          && state.onboardingDecisionVerified
          && state.onboardingMilestones?.projectId === currentProjectId()
          && state.onboardingMilestones?.firstClaimId === node.dataset.claimId
          && $("quickStartEvidence")?.dataset?.claimStatus === decisionStatus
      );
      node.disabled = state.busy || !node.dataset.claimId || decisionCompleted;
      return;
    }
    node.disabled = state.busy;
  });
  syncProviderControls();
}

function setStatus(message) {
  setRawNodeText($("status"), message);
}

function setLocalizedStatus(key, params = {}, fallback = "") {
  setLocalizedNodeText($("status"), key, params, fallback);
}

function setSettingsStatus(message) {
  const node = $("settingsStatus");
  setRawNodeText(node, message);
}

function setLocalizedSettingsStatus(key, params = {}, fallback = "") {
  setLocalizedNodeText($("settingsStatus"), key, params, fallback);
}

function countCjkAwareChars(text) {
  return String(text || "").replace(/\s+/g, "").length;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isOfflineFallbackError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  const status = Number(error?.status || 0);
  const isAuthOrVersionError = [
    "401",
    "403",
    "unauthorized",
    "forbidden",
    "pairing token",
    "auth",
    "version",
    "incompatible",
    "upgrade",
    "鉴权",
    "权限",
    "版本",
    "升级"
  ].some((marker) => message.includes(marker));
  if (isAuthOrVersionError) return false;
  if (status >= 400 && status < 500) return false;
  if (status >= 500 && status < 600) return true;
  if (error?.isNetworkError === true) return true;
  return [
    "failed to fetch",
    "fetch failed",
    "networkerror",
    "network error",
    "connection refused",
    "connection reset",
    "err_connection_refused",
    "econnrefused",
    "enotfound",
    "dns",
    "offline",
    "unreachable",
    "网络不可达",
    "无法连接"
  ].some((marker) => message.includes(marker));
}

async function companionRequest(path, options = {}) {
  await ensureSettingsLoaded();
  const base = (state.settings?.serviceUrl || "http://127.0.0.1:37621").replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json"
  };
  if (state.settings?.pairingToken) {
    headers["x-qc-pairing-token"] = state.settings.pairingToken;
  }
  let parsedBase;
  try {
    parsedBase = new URL(base);
  } catch (_error) {
    throw localizedError("companion.error.invalidUrl", "Companion URL 格式无效。");
  }
  if (parsedBase.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsedBase.hostname)) {
    throw localizedError(
      "companion.error.unsafeUrl",
      "为保护 Pairing Token，Companion URL 仅允许本机 http://127.0.0.1 或 localhost 地址。"
    );
  }
  const timeoutMs = companionRequestTimeoutMs(path, options);
  const controller = typeof globalThis.AbortController === "function"
    ? new globalThis.AbortController()
    : null;
  const timeoutId = controller && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  let response;
  let text;
  try {
    response = await fetch(`${base}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller?.signal
    });
    text = await response.text();
  } catch (cause) {
    const timedOut = cause?.name === "AbortError";
    const seconds = Math.round(timeoutMs / 1000);
    const error = timedOut
      ? localizedError(
          "companion.error.timeout",
          `Companion 请求超时（${seconds} 秒）。服务可能仍在处理，请先检查状态再重试。`,
          { seconds }
        )
      : localizedError(
          "companion.error.network",
          "无法连接本地 Companion。请确认服务已启动后重试。"
        );
    error.isNetworkError = true;
    error.code = timedOut ? "companion_timeout" : "companion_network_error";
    error.cause = cause;
    throw error;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (cause) {
    const error = localizedError(
      "companion.error.invalidResponse",
      `Companion 返回了无法解析的响应（HTTP ${response.status}）。`,
      { status: response.status }
    );
    error.status = response.status;
    error.code = "invalid_response";
    error.cause = cause;
    throw error;
  }
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = data.code || "companion_error";
    throw error;
  }
  return data;
}

function companionRequestTimeoutMs(path, options = {}) {
  const explicit = Number(options.timeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1000, Math.min(explicit, 60 * 60 * 1000));
  }
  if (/\/v1\/(?:llm\/chat|sources\/[^/]+\/(?:extract-knowledge|reextract))/.test(path)) {
    const codexSeconds = normalizeCodexTimeout(state.settings?.codexTimeoutSeconds || 300);
    return Math.min((codexSeconds + 30) * 1000, 60 * 60 * 1000);
  }
  if (path.startsWith("/v1/pdfs/extract")) return 4 * 60 * 1000;
  if (path.startsWith("/v1/youtube/transcripts")) return 2 * 60 * 1000;
  if (path.startsWith("/v1/vault/doctor") || path.startsWith("/v1/lineage/rebuild")) {
    return 3 * 60 * 1000;
  }
  return 45 * 1000;
}

async function ensureSettingsLoaded() {
  if (!state.settings) {
    await loadSettings();
  }
}

function inferSiteFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.includes("quantclass")) return "quantclass";
    if (host.includes("zhihu")) return "zhihu";
    if (host.includes("substack")) return "substack";
    if (host.includes("medium.com")) return "medium";
    if (host.includes("news.ycombinator.com")) return "hacker-news";
    if (host.includes("reddit.com")) return "reddit";
    if (host.includes("arxiv.org")) return "arxiv";
    if (host.includes("github.com")) return "github";
    return host || "web";
  } catch {
    return "local";
  }
}
