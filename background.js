const PENDING_SELECTION_QUEUE_KEY = "pendingSelections";
const LEGACY_PENDING_SELECTION_KEY = "pendingSelection";
const PENDING_SELECTION_NOTICE_KEY = "pendingSelectionNotice";
const MAX_PENDING_SELECTIONS = 20;
const SELECTION_QUEUED_MESSAGE = "qc-smart-reader-selection-queued";
const CLAIM_SELECTION_MESSAGE = "qc-smart-reader-claim-selection";

let selectionQueueMutation = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "qc-smart-read-selection",
    title: "用 QC Smart Reader 阅读选中文本",
    contexts: ["selection"]
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.windowId) return;
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "qc-smart-read-selection" || !tab?.id) return;
  const outcome = await enqueuePendingSelection(info, tab);
  if (Number.isInteger(tab.windowId)) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (_error) {
      // The queue is durable for this browser session even if the panel cannot open.
    }
  }
  await notifySelectionQueued(outcome);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== CLAIM_SELECTION_MESSAGE) return false;
  mutateSelectionQueue(() => claimPendingSelection(message))
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, selection: null, error: error?.message || String(error) });
    });
  return true;
});

function mutateSelectionQueue(task) {
  const current = selectionQueueMutation.then(task, task);
  selectionQueueMutation = current.catch(() => {});
  return current;
}

function numericId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizedSelection(value, fallback = {}) {
  if (!value || typeof value !== "object") return null;
  const text = String(value.text || fallback.text || "").trim();
  if (!text) return null;
  const projectId = String(value.projectId || value.project_id || fallback.projectId || "").trim();
  return {
    id: String(value.id || fallback.id || crypto.randomUUID()),
    text,
    title: String(value.title || fallback.title || ""),
    url: String(value.url || fallback.url || ""),
    tabId: numericId(value.tabId ?? value.tab_id ?? fallback.tabId),
    windowId: numericId(value.windowId ?? value.window_id ?? fallback.windowId),
    projectId,
    capturedAt: String(value.capturedAt || value.captured_at || fallback.capturedAt || new Date().toISOString())
  };
}

async function readPendingSelectionQueue() {
  const stored = await chrome.storage.session.get([
    PENDING_SELECTION_QUEUE_KEY,
    LEGACY_PENDING_SELECTION_KEY
  ]);
  const queue = (Array.isArray(stored[PENDING_SELECTION_QUEUE_KEY])
    ? stored[PENDING_SELECTION_QUEUE_KEY]
    : [])
    .map((item) => normalizedSelection(item))
    .filter(Boolean);
  const legacy = normalizedSelection(stored[LEGACY_PENDING_SELECTION_KEY]);
  if (legacy && !queue.some((item) => item.id === legacy.id)) queue.push(legacy);
  return queue.slice(-MAX_PENDING_SELECTIONS);
}

async function writePendingSelectionQueue(queue) {
  await chrome.storage.session.set({
    [PENDING_SELECTION_QUEUE_KEY]: queue.slice(-MAX_PENDING_SELECTIONS),
    [LEGACY_PENDING_SELECTION_KEY]: null
  });
  await chrome.storage.session.remove(LEGACY_PENDING_SELECTION_KEY);
}

async function enqueuePendingSelection(info, tab) {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const projectId = String(settings?.projectId || "default").trim() || "default";
  const selection = normalizedSelection({
    id: crypto.randomUUID(),
    text: info.selectionText || "",
    title: tab.title || "",
    url: tab.url || "",
    tabId: tab.id,
    windowId: tab.windowId,
    projectId,
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
  if (selection.tabId !== null && requestTabId !== null && selection.tabId === requestTabId) return 2;
  if (selection.windowId !== null && requestWindowId !== null && selection.windowId === requestWindowId) return 1;
  if (selection.tabId === null && selection.windowId === null) return 0;
  return -1;
}

async function claimPendingSelection(request) {
  const queue = await readPendingSelectionQueue();
  const requestedId = String(request.selectionId || request.selection_id || "").trim();
  const requestedNoticeId = String(request.noticeId || request.notice_id || "").trim();
  const storedNotice = await chrome.storage.session.get(PENDING_SELECTION_NOTICE_KEY);
  const notice = storedNotice[PENDING_SELECTION_NOTICE_KEY];
  if (notice && (!requestedId || requestedNoticeId === String(notice.id || ""))) {
    const requestProjectId = String(request.projectId || request.project_id || "default").trim() || "default";
    if (selectionTargetScore(notice, request) >= 0 && String(notice.projectId || "default") === requestProjectId) {
      await chrome.storage.session.remove(PENDING_SELECTION_NOTICE_KEY);
      return {
        ok: true,
        selection: null,
        pendingCount: queue.length,
        reason: "queue_full"
      };
    }
  }
  let index = -1;
  if (requestedId) {
    index = queue.findIndex((item) => item.id === requestedId);
  } else {
    let bestScore = -1;
    for (let candidateIndex = 0; candidateIndex < queue.length; candidateIndex += 1) {
      const score = selectionTargetScore(queue[candidateIndex], request);
      if (score > bestScore) {
        bestScore = score;
        index = candidateIndex;
        if (score === 2) break;
      }
    }
  }
  if (index < 0) {
    await writePendingSelectionQueue(queue);
    return { ok: true, selection: null, pendingCount: queue.length, reason: "not_found" };
  }

  const selection = queue[index];
  if (selectionTargetScore(selection, request) < 0) {
    await writePendingSelectionQueue(queue);
    return { ok: true, selection: null, pendingCount: queue.length, reason: "target_mismatch" };
  }

  const requestProjectId = String(request.projectId || request.project_id || "default").trim() || "default";
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
  queue.splice(index, 1);
  await writePendingSelectionQueue(queue);
  return { ok: true, selection, pendingCount: queue.length };
}
