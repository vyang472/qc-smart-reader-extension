const PENDING_SELECTION_QUEUE_KEY = "pendingSelections";
const LEGACY_PENDING_SELECTION_KEY = "pendingSelection";
const PENDING_SELECTION_NOTICE_KEY = "pendingSelectionNotice";
const PENDING_SELECTION_SESSION_ID_KEY = "pendingSelectionSessionId";
const MAX_PENDING_SELECTIONS = 20;
const MAX_SELECTION_QUOTE_CHARS = 800;
const MAX_SELECTION_CONTEXT_SIDE_CHARS = 1200;
const SELECTION_LEASE_MS = 2 * 60 * 1000;
const SELECTION_QUEUED_MESSAGE = "qc-smart-reader-selection-queued";
const CLAIM_SELECTION_MESSAGE = "qc-smart-reader-claim-selection";
const ACK_SELECTION_MESSAGE = "qc-smart-reader-ack-selection";
const RELEASE_SELECTION_MESSAGE = "qc-smart-reader-release-selection";

let selectionQueueMutation = Promise.resolve();
let pendingSelectionSessionIdPromise = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "qc-smart-read-selection",
    title: chrome.i18n?.getMessage?.("contextMenuSaveSelectionAsPendingEvidence")
      || "Save selection as pending evidence (local, no model)",
    contexts: ["selection"]
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.windowId) return;
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "qc-smart-read-selection" || !tab?.id) return;
  // Start both privileged operations while the context-menu user gesture is
  // still active. The DOM snapshot is the committed source context; it must
  // never be reconstructed later from whichever page happens to be active.
  const projectPromise = chrome.storage.local.get("settings").then(({ settings = {} }) => (
    String(settings?.projectId || "default").trim() || "default"
  ));
  const frameId = numericId(info.frameId);
  const sourceUrl = String(info.frameUrl || info.pageUrl || tab.url || "");
  const contextPromise = snapshotSelectionContext(info.selectionText || "", tab.id, frameId);
  const openPromise = Number.isInteger(tab.windowId)
    ? chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {})
    : Promise.resolve();
  const [selectionContext, projectId] = await Promise.all([contextPromise, projectPromise]);
  const outcome = await enqueuePendingSelection(
    info,
    tab,
    selectionContext,
    projectId,
    sourceUrl
  );
  await openPromise;
  await notifySelectionQueued(outcome);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const operation = {
    [CLAIM_SELECTION_MESSAGE]: claimPendingSelection,
    [ACK_SELECTION_MESSAGE]: acknowledgePendingSelection,
    [RELEASE_SELECTION_MESSAGE]: releasePendingSelection
  }[message?.type];
  if (!operation) return false;
  mutateSelectionQueue(() => operation(message))
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, selection: null, error: error?.message || String(error) });
    });
  return true;
});

chrome.windows?.onRemoved?.addListener((windowId) => (
  mutateSelectionQueue(async () => {
    const queue = await readPendingSelectionQueue();
    const sessionId = await currentPendingSelectionSessionId();
    const changed = orphanSelectionWindowBindings(queue, windowId, sessionId);
    if (changed) await writePendingSelectionQueue(queue);
    return changed;
  }).catch((error) => {
    console.warn("Pending selection window cleanup failed.", error);
    return false;
  })
));

function mutateSelectionQueue(task) {
  const current = selectionQueueMutation.then(task, task);
  selectionQueueMutation = current.catch(() => {});
  return current;
}

function numericId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function currentPendingSelectionSessionId() {
  if (!pendingSelectionSessionIdPromise) {
    pendingSelectionSessionIdPromise = (async () => {
      const stored = await chrome.storage.session.get(PENDING_SELECTION_SESSION_ID_KEY);
      const existing = String(stored[PENDING_SELECTION_SESSION_ID_KEY] || "").trim();
      if (existing) return existing;
      const created = crypto.randomUUID();
      await chrome.storage.session.set({ [PENDING_SELECTION_SESSION_ID_KEY]: created });
      return created;
    })().catch((error) => {
      pendingSelectionSessionIdPromise = null;
      throw error;
    });
  }
  return pendingSelectionSessionIdPromise;
}

function normalizeSelectionText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function selectionCharacterCount(value) {
  return Array.from(String(value || "")).length;
}

function selectionCharacterSlice(value, start, end) {
  return Array.from(String(value || "")).slice(start, end).join("");
}

function selectionTextOccurrenceCount(text, quote) {
  if (!quote) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= text.length - quote.length) {
    const found = text.indexOf(quote, offset);
    if (found < 0) break;
    count += 1;
    offset = found + 1;
    if (count > 1) break;
  }
  return count;
}

function boundedExactSelectionContext(raw, fallbackQuote) {
  const quote = normalizeSelectionText(raw?.quote || fallbackQuote);
  const expectedQuote = normalizeSelectionText(fallbackQuote);
  if (!quote || quote !== expectedQuote) {
    return {
      quote: expectedQuote,
      prefix: "",
      suffix: "",
      contextText: expectedQuote,
      contextMode: "quote-only"
    };
  }
  let prefix = normalizeSelectionText(raw?.prefix || "");
  let suffix = normalizeSelectionText(raw?.suffix || "");
  if (!prefix && !suffix && raw?.contextText) {
    const supplied = normalizeSelectionText(raw.contextText);
    const quoteOffset = supplied.indexOf(quote);
    if (quoteOffset >= 0 && selectionTextOccurrenceCount(supplied, quote) === 1) {
      prefix = normalizeSelectionText(supplied.slice(0, quoteOffset));
      suffix = normalizeSelectionText(supplied.slice(quoteOffset + quote.length));
    }
  }
  for (const sideLimit of [MAX_SELECTION_CONTEXT_SIDE_CHARS, 800, 480, 240, 120, 60, 0]) {
    const boundedPrefix = sideLimit ? selectionCharacterSlice(prefix, -sideLimit) : "";
    const boundedSuffix = sideLimit ? selectionCharacterSlice(suffix, 0, sideLimit) : "";
    const contextText = [boundedPrefix, quote, boundedSuffix].filter(Boolean).join("\n");
    if (selectionTextOccurrenceCount(contextText, quote) === 1) {
      return {
        quote,
        prefix: boundedPrefix,
        suffix: boundedSuffix,
        contextText,
        contextMode: boundedPrefix || boundedSuffix ? "dom-range" : "quote-only"
      };
    }
  }
  return { quote, prefix: "", suffix: "", contextText: quote, contextMode: "quote-only" };
}

async function snapshotSelectionContext(selectionText, tabId, frameId = null) {
  const normalizedQuote = normalizeSelectionText(selectionText);
  if (selectionCharacterCount(normalizedQuote) > MAX_SELECTION_QUOTE_CHARS) {
    return {
      reason: "selection_too_long",
      length: selectionCharacterCount(normalizedQuote),
      max: MAX_SELECTION_QUOTE_CHARS
    };
  }
  const fallback = boundedExactSelectionContext(null, selectionText);
  if (!fallback.quote || !chrome.scripting?.executeScript) return fallback;
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: frameId === null ? { tabId } : { tabId, frameIds: [frameId] },
      func: captureBoundedDomSelection,
      args: [fallback.quote, MAX_SELECTION_CONTEXT_SIDE_CHARS]
    });
    return boundedExactSelectionContext(result, fallback.quote);
  } catch (_error) {
    return fallback;
  }
}

function captureBoundedDomSelection(expectedQuote, maxSideChars) {
  const normalize = (value) => String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  const selection = globalThis.getSelection?.();
  if (!selection || selection.rangeCount < 1) return null;
  const range = selection.getRangeAt(0);
  const rangeQuote = normalize(range.toString());
  const quote = normalize(expectedQuote);
  const characterSlice = (value, start, end) => Array.from(String(value || "")).slice(start, end).join("");
  if (!quote || (rangeQuote !== quote && !rangeQuote.startsWith(quote))) return null;

  let element = range.commonAncestorContainer;
  if (element?.nodeType !== Node.ELEMENT_NODE) element = element?.parentElement;
  const semanticRoot = element?.closest?.("p,li,blockquote,pre,td,th,figcaption,article,main,section,div,body")
    || element;
  if (!semanticRoot) return { quote, prefix: "", suffix: "" };
  try {
    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(semanticRoot);
    prefixRange.setEnd(range.startContainer, range.startOffset);
    const suffixRange = document.createRange();
    suffixRange.selectNodeContents(semanticRoot);
    suffixRange.setStart(range.endContainer, range.endOffset);
    return {
      quote,
      prefix: characterSlice(normalize(prefixRange.toString()), -Math.max(0, Number(maxSideChars) || 0)),
      suffix: characterSlice(normalize(suffixRange.toString()), 0, Math.max(0, Number(maxSideChars) || 0))
    };
  } catch (_error) {
    return { quote, prefix: "", suffix: "" };
  }
}

function normalizedSelection(value, fallback = {}) {
  if (!value || typeof value !== "object") return null;
  const text = normalizeSelectionText(value.text || value.quote || fallback.text || fallback.quote || "");
  if (!text || selectionCharacterCount(text) > MAX_SELECTION_QUOTE_CHARS) return null;
  const projectId = String(value.projectId || value.project_id || fallback.projectId || "").trim();
  const tabId = numericId(value.tabId ?? value.tab_id ?? fallback.tabId);
  const windowId = numericId(value.windowId ?? value.window_id ?? fallback.windowId);
  const selectionContext = boundedExactSelectionContext({
    quote: text,
    prefix: value.prefix ?? fallback.prefix,
    suffix: value.suffix ?? fallback.suffix,
    contextText: value.contextText ?? value.context_text ?? fallback.contextText
  }, text);
  return {
    id: String(value.id || fallback.id || crypto.randomUUID()),
    text: selectionContext.quote,
    prefix: selectionContext.prefix,
    suffix: selectionContext.suffix,
    contextText: selectionContext.contextText,
    contextMode: String(value.contextMode || value.context_mode || fallback.contextMode || selectionContext.contextMode),
    title: String(value.title || fallback.title || ""),
    url: String(value.url || fallback.url || ""),
    tabId,
    windowId,
    originalTabId: numericId(
      value.originalTabId ?? value.original_tab_id ?? fallback.originalTabId ?? tabId
    ),
    originalWindowId: numericId(
      value.originalWindowId ?? value.original_window_id ?? fallback.originalWindowId ?? windowId
    ),
    projectId,
    capturedAt: String(value.capturedAt || value.captured_at || fallback.capturedAt || new Date().toISOString()),
    sessionId: String(value.sessionId || value.session_id || fallback.sessionId || ""),
    orphanedAt: String(value.orphanedAt || value.orphaned_at || fallback.orphanedAt || ""),
    leaseId: String(value.leaseId || value.lease_id || fallback.leaseId || ""),
    leaseWindowId: numericId(value.leaseWindowId ?? value.lease_window_id ?? fallback.leaseWindowId),
    leaseProjectId: String(value.leaseProjectId || value.lease_project_id || fallback.leaseProjectId || ""),
    leasedAt: String(value.leasedAt || value.leased_at || fallback.leasedAt || ""),
    leaseExpiresAt: String(value.leaseExpiresAt || value.lease_expires_at || fallback.leaseExpiresAt || "")
  };
}

function clearPendingSelectionLease(selection) {
  Object.assign(selection, {
    leaseId: "",
    leaseWindowId: null,
    leaseProjectId: "",
    leasedAt: "",
    leaseExpiresAt: ""
  });
}

function orphanPendingSelection(selection, sessionId, orphanedAt = new Date().toISOString()) {
  if (selection.originalTabId === null) selection.originalTabId = selection.tabId;
  if (selection.originalWindowId === null) selection.originalWindowId = selection.windowId;
  selection.tabId = null;
  selection.windowId = null;
  selection.sessionId = sessionId;
  selection.orphanedAt = selection.orphanedAt || orphanedAt;
  clearPendingSelectionLease(selection);
}

function orphanSelectionWindowBindings(queue, windowId, sessionId) {
  const removedWindowId = numericId(windowId);
  if (removedWindowId === null) return false;
  let changed = false;
  const orphanedAt = new Date().toISOString();
  for (const selection of queue) {
    if (selection.windowId !== removedWindowId) continue;
    orphanPendingSelection(selection, sessionId, orphanedAt);
    changed = true;
  }
  return changed;
}

async function orphanMissingSelectionWindowBindings(queue) {
  if (!chrome.windows?.get) return false;
  const sessionId = await currentPendingSelectionSessionId();
  const windowIds = [...new Set(queue.map((item) => item.windowId).filter((value) => value !== null))];
  const missingWindowIds = [];
  for (const windowId of windowIds) {
    try {
      await chrome.windows.get(windowId);
    } catch (error) {
      if (/no window|not found|invalid window/i.test(error?.message || String(error))) {
        missingWindowIds.push(windowId);
      }
    }
  }
  let changed = false;
  for (const windowId of missingWindowIds) {
    changed = orphanSelectionWindowBindings(queue, windowId, sessionId) || changed;
  }
  return changed;
}

async function readPendingSelectionQueue() {
  const sessionId = await currentPendingSelectionSessionId();
  const [localStored, sessionStored] = await Promise.all([
    chrome.storage.local.get(PENDING_SELECTION_QUEUE_KEY),
    chrome.storage.session.get([PENDING_SELECTION_QUEUE_KEY, LEGACY_PENDING_SELECTION_KEY])
  ]);
  const queue = [];
  const append = (raw) => {
    if (queue.length >= MAX_PENDING_SELECTIONS) return;
    const selection = normalizedSelection(raw, { sessionId });
    if (!selection || queue.some((item) => item.id === selection.id)) return;
    if (!selection.sessionId) selection.sessionId = sessionId;
    if (selection.sessionId !== sessionId) orphanPendingSelection(selection, sessionId);
    queue.push(selection);
  };
  for (const raw of Array.isArray(localStored[PENDING_SELECTION_QUEUE_KEY])
    ? localStored[PENDING_SELECTION_QUEUE_KEY]
    : []) append(raw);
  for (const raw of Array.isArray(sessionStored[PENDING_SELECTION_QUEUE_KEY])
    ? sessionStored[PENDING_SELECTION_QUEUE_KEY]
    : []) append(raw);
  append(sessionStored[LEGACY_PENDING_SELECTION_KEY]);
  await writePendingSelectionQueue(queue);
  return queue;
}

async function writePendingSelectionQueue(queue) {
  const bounded = queue.slice(0, MAX_PENDING_SELECTIONS);
  if (bounded.length) {
    await chrome.storage.local.set({ [PENDING_SELECTION_QUEUE_KEY]: bounded });
  } else {
    await chrome.storage.local.remove(PENDING_SELECTION_QUEUE_KEY);
  }
  await chrome.storage.session.remove([
    PENDING_SELECTION_QUEUE_KEY,
    LEGACY_PENDING_SELECTION_KEY
  ]);
}

async function enqueuePendingSelection(
  info,
  tab,
  selectionContext = null,
  frozenProjectId = "",
  frozenSourceUrl = ""
) {
  const projectId = String(frozenProjectId || "default").trim() || "default";
  const sessionId = await currentPendingSelectionSessionId();
  const normalizedQuote = normalizeSelectionText(selectionContext?.quote || info.selectionText || "");
  const normalizedLength = Number(selectionContext?.length || selectionCharacterCount(normalizedQuote));
  if (
    selectionContext?.reason === "selection_too_long"
      || normalizedLength > MAX_SELECTION_QUOTE_CHARS
  ) {
    return mutateSelectionQueue(async () => {
      const queue = await readPendingSelectionQueue();
      const notice = {
        id: crypto.randomUUID(),
        reason: "selection_too_long",
        tabId: numericId(tab.id),
        windowId: numericId(tab.windowId),
        projectId,
        title: String(tab.title || ""),
        createdAt: new Date().toISOString(),
        pendingCount: queue.length,
        length: normalizedLength,
        max: MAX_SELECTION_QUOTE_CHARS
      };
      await chrome.storage.session.set({ [PENDING_SELECTION_NOTICE_KEY]: notice });
      return { ok: false, selection: null, ...notice };
    });
  }
  const selection = normalizedSelection({
    id: crypto.randomUUID(),
    text: selectionContext?.quote || info.selectionText || "",
    prefix: selectionContext?.prefix || "",
    suffix: selectionContext?.suffix || "",
    contextText: selectionContext?.contextText || selectionContext?.quote || info.selectionText || "",
    contextMode: selectionContext?.contextMode || "quote-only",
    title: tab.title || "",
    url: frozenSourceUrl || tab.url || "",
    tabId: tab.id,
    windowId: tab.windowId,
    originalTabId: tab.id,
    originalWindowId: tab.windowId,
    projectId,
    sessionId,
    capturedAt: new Date().toISOString()
  });
  if (!selection) return { ok: false, selection: null, reason: "empty_selection" };
  return mutateSelectionQueue(async () => {
    const queue = await readPendingSelectionQueue();
    if (queue.length >= MAX_PENDING_SELECTIONS) {
      const notice = {
        id: crypto.randomUUID(),
        reason: "queue_full",
        tabId: selection.tabId,
        windowId: selection.windowId,
        projectId: selection.projectId,
        title: selection.title,
        createdAt: new Date().toISOString(),
        pendingCount: queue.length
      };
      await chrome.storage.session.set({ [PENDING_SELECTION_NOTICE_KEY]: notice });
      return { ok: false, selection: null, ...notice };
    }
    queue.push(selection);
    await writePendingSelectionQueue(queue);
    return { ok: true, selection, pendingCount: queue.length };
  });
}

async function notifySelectionQueued(outcome) {
  if (!outcome) return;
  const selection = outcome.selection;
  try {
    const notification = chrome.runtime.sendMessage({
      type: SELECTION_QUEUED_MESSAGE,
      selectionId: selection?.id || "",
      noticeId: outcome.ok ? "" : outcome.id || "",
      reason: outcome.reason || "",
      pendingCount: Number(outcome.pendingCount || 0),
      length: Number(outcome.length || 0),
      max: Number(outcome.max || 0),
      tabId: selection?.tabId ?? outcome.tabId,
      windowId: selection?.windowId ?? outcome.windowId
    });
    if (notification?.catch) await notification.catch(() => {});
  } catch (_error) {
    // No open side panel is normal; initialization will consume the queue later.
  }
}

function selectionTargetScore(selection, request) {
  const requestTabId = numericId(request.tabId ?? request.tab_id);
  const requestWindowId = numericId(request.windowId ?? request.window_id);
  if (
    selection.windowId !== null
      && requestWindowId !== null
      && selection.windowId !== requestWindowId
  ) return -1;
  if (selection.tabId !== null && requestTabId !== null && selection.tabId === requestTabId) return 2;
  if (selection.windowId !== null && requestWindowId !== null && selection.windowId === requestWindowId) return 1;
  if (selection.tabId === null && selection.windowId === null) return 0;
  return -1;
}

async function claimPendingSelection(request) {
  const queue = await readPendingSelectionQueue();
  if (await orphanMissingSelectionWindowBindings(queue)) {
    await writePendingSelectionQueue(queue);
  }
  const requestedId = String(request.selectionId || request.selection_id || "").trim();
  const requestedNoticeId = String(request.noticeId || request.notice_id || "").trim();
  const requestProjectId = String(request.projectId || request.project_id || "default").trim() || "default";
  const excludedIds = new Set(
    (Array.isArray(request.excludeSelectionIds) ? request.excludeSelectionIds : [])
      .slice(0, MAX_PENDING_SELECTIONS)
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  const storedNotice = await chrome.storage.session.get(PENDING_SELECTION_NOTICE_KEY);
  const notice = storedNotice[PENDING_SELECTION_NOTICE_KEY];
  if (notice && (!requestedId || requestedNoticeId === String(notice.id || ""))) {
    if (selectionTargetScore(notice, request) >= 0 && String(notice.projectId || "default") === requestProjectId) {
      await chrome.storage.session.remove(PENDING_SELECTION_NOTICE_KEY);
      return {
        ok: true,
        selection: null,
        pendingCount: queue.length,
        reason: String(notice.reason || "queue_full"),
        length: Number(notice.length || 0),
        max: Number(notice.max || 0)
      };
    }
  }
  let index = -1;
  if (requestedId) {
    index = queue.findIndex((item) => item.id === requestedId);
  } else {
    let bestScore = -1;
    for (let candidateIndex = 0; candidateIndex < queue.length; candidateIndex += 1) {
      const candidate = queue[candidateIndex];
      const candidateProjectId = String(candidate.projectId || requestProjectId).trim() || requestProjectId;
      if (candidateProjectId !== requestProjectId || excludedIds.has(candidate.id)) continue;
      const score = selectionTargetScore(candidate, request);
      if (score > bestScore) {
        bestScore = score;
        index = candidateIndex;
        if (score === 2) break;
      }
    }
  }
  if (index < 0) {
    await writePendingSelectionQueue(queue);
    const projectMismatch = !requestedId && queue.find((item) => (
      selectionTargetScore(item, request) >= 0
        && (String(item.projectId || requestProjectId).trim() || requestProjectId) !== requestProjectId
    ));
    return {
      ok: true,
      selection: null,
      pendingCount: queue.length,
      reason: projectMismatch ? "project_mismatch" : "not_found",
      selectionProjectId: projectMismatch?.projectId || ""
    };
  }

  const selection = queue[index];
  if (selectionTargetScore(selection, request) < 0) {
    await writePendingSelectionQueue(queue);
    return { ok: true, selection: null, pendingCount: queue.length, reason: "target_mismatch" };
  }

  if (selection.projectId && selection.projectId !== requestProjectId) {
    await writePendingSelectionQueue(queue);
    return {
      ok: true,
      selection: null,
      pendingCount: queue.length,
      reason: "project_mismatch",
      selectionProjectId: selection.projectId
    };
  }
  if (!selection.projectId) selection.projectId = requestProjectId;
  const requestWindowId = numericId(request.windowId ?? request.window_id);
  const now = Date.now();
  const leaseExpiry = Date.parse(selection.leaseExpiresAt || "");
  const leaseActive = Boolean(selection.leaseId) && Number.isFinite(leaseExpiry) && leaseExpiry > now;
  const leaseOwnerMatches = selection.leaseWindowId === requestWindowId
    && String(selection.leaseProjectId || "") === requestProjectId;
  if (leaseActive && !leaseOwnerMatches) {
    await writePendingSelectionQueue(queue);
    return { ok: true, selection: null, pendingCount: queue.length, reason: "leased" };
  }
  if (!leaseActive || !leaseOwnerMatches) {
    selection.leaseId = crypto.randomUUID();
    selection.leaseWindowId = requestWindowId;
    selection.leaseProjectId = requestProjectId;
    selection.leasedAt = new Date(now).toISOString();
    selection.leaseExpiresAt = new Date(now + SELECTION_LEASE_MS).toISOString();
  }
  await writePendingSelectionQueue(queue);
  return { ok: true, selection, leaseId: selection.leaseId, pendingCount: queue.length };
}

function pendingSelectionRequestMatch(selection, request) {
  if (selectionTargetScore(selection, request) < 0) return "target_mismatch";
  const requestProjectId = String(request.projectId || request.project_id || "default").trim() || "default";
  if (selection.projectId && selection.projectId !== requestProjectId) return "project_mismatch";
  const leaseId = String(request.leaseId || request.lease_id || "").trim();
  if (!leaseId || selection.leaseId !== leaseId) return "lease_mismatch";
  if (
    selection.leaseWindowId !== numericId(request.windowId ?? request.window_id)
      || String(selection.leaseProjectId || "") !== requestProjectId
  ) return "lease_owner_mismatch";
  const leaseExpiry = Date.parse(selection.leaseExpiresAt || "");
  if (!Number.isFinite(leaseExpiry) || leaseExpiry <= Date.now()) return "lease_expired";
  return "";
}

async function acknowledgePendingSelection(request) {
  const queue = await readPendingSelectionQueue();
  const selectionId = String(request.selectionId || request.selection_id || "").trim();
  const index = queue.findIndex((item) => item.id === selectionId);
  if (index < 0) {
    await writePendingSelectionQueue(queue);
    return { ok: true, acknowledged: false, pendingCount: queue.length, reason: "not_found" };
  }
  const reason = pendingSelectionRequestMatch(queue[index], request);
  if (reason) {
    await writePendingSelectionQueue(queue);
    return { ok: true, acknowledged: false, pendingCount: queue.length, reason };
  }
  queue.splice(index, 1);
  await writePendingSelectionQueue(queue);
  return { ok: true, acknowledged: true, pendingCount: queue.length };
}

async function releasePendingSelection(request) {
  const queue = await readPendingSelectionQueue();
  const selectionId = String(request.selectionId || request.selection_id || "").trim();
  const index = queue.findIndex((item) => item.id === selectionId);
  if (index < 0) {
    await writePendingSelectionQueue(queue);
    return { ok: true, released: false, pendingCount: queue.length, reason: "not_found" };
  }
  const reason = pendingSelectionRequestMatch(queue[index], request);
  if (reason) {
    await writePendingSelectionQueue(queue);
    return { ok: true, released: false, pendingCount: queue.length, reason };
  }
  clearPendingSelectionLease(queue[index]);
  await writePendingSelectionQueue(queue);
  return { ok: true, released: true, pendingCount: queue.length };
}
