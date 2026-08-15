import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

let backgroundHarnessSequence = 0;

async function projectFile(name) {
  return readFile(new URL(`../${name}`, import.meta.url), "utf8");
}

async function createBackgroundHarness({
  session = {},
  local = {},
  settings,
  rejectNotifications = false,
  uiLanguage = "en",
  selectionContext,
  rejectSelectionContext = false,
  selectionContextGate = null,
  missingWindowIds = []
} = {}) {
  const source = await projectFile("background.js");
  const harnessId = ++backgroundHarnessSequence;
  const sessionState = structuredClone(session);
  const localState = structuredClone(local);
  if (settings !== undefined) localState.settings = structuredClone(settings);
  if (!localState.settings) localState.settings = {};
  const listeners = {};
  const notifications = [];
  const openedWindows = [];
  const createdMenus = [];
  const scriptExecutions = [];
  const missingWindows = new Set(missingWindowIds.map((value) => Number(value)));
  let uuid = 0;

  const storageArea = (state) => ({
    async get(keys) {
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, state[key]]));
      if (typeof keys === "string") return { [keys]: state[keys] };
      if (keys && typeof keys === "object") return { ...keys, ...state };
      return { ...state };
    },
    async set(values) {
      Object.assign(state, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    }
  });

  const context = {
    console: { ...console, warn() {}, error() {} },
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    crypto: { randomUUID: () => `h${harnessId}-selection-${++uuid}` },
    chrome: {
      action: {
        onClicked: { addListener(listener) { listeners.actionClicked = listener; } }
      },
      contextMenus: {
        create(options) {
          createdMenus.push(structuredClone(options));
        },
        onClicked: { addListener(listener) { listeners.contextMenuClicked = listener; } }
      },
      i18n: {
        getMessage(key) {
          if (key !== "contextMenuSaveSelectionAsPendingEvidence") return "";
          return uiLanguage === "zh-CN"
            ? "将选中文本保存为待核验证据（仅本地，不调用模型）"
            : "Save selection as pending evidence (local, no model)";
        }
      },
      runtime: {
        onInstalled: { addListener(listener) { listeners.installed = listener; } },
        onMessage: { addListener(listener) { listeners.message = listener; } },
        sendMessage(message) {
          notifications.push(structuredClone(message));
          return rejectNotifications
            ? Promise.reject(new Error("Could not establish connection. Receiving end does not exist."))
            : Promise.resolve();
        }
      },
      sidePanel: {
        async open({ windowId }) {
          openedWindows.push(windowId);
        }
      },
      windows: {
        onRemoved: {
          addListener(listener) {
            listeners.windowRemoved = listener;
          }
        },
        async get(windowId) {
          if (missingWindows.has(Number(windowId))) throw new Error(`No window with id: ${windowId}`);
          return { id: Number(windowId) };
        }
      },
      scripting: {
        async executeScript(details) {
          scriptExecutions.push(structuredClone({ target: details.target, args: details.args }));
          if (selectionContextGate) await selectionContextGate;
          if (rejectSelectionContext) throw new Error("selection injection failed");
          if (selectionContext) return [{ result: structuredClone(selectionContext) }];
          return [{
            result: {
              quote: String(details.args?.[0] || "").trim(),
              prefix: "Prefix from nested DOM.",
              suffix: "Suffix from nested DOM.",
              contextText: `Prefix from nested DOM.\n${String(details.args?.[0] || "").trim()}\nSuffix from nested DOM.`,
              captureMode: "dom-range"
            }
          }];
        }
      },
      storage: {
        local: storageArea(localState),
        session: storageArea(sessionState)
      }
    }
  };
  createContext(context);
  runInContext(source, context);

  async function clickSelection(index, overrides = {}) {
    const tabId = overrides.tabId ?? index + 1;
    const windowId = overrides.windowId ?? 7;
    missingWindows.delete(Number(windowId));
    await listeners.contextMenuClicked(
      {
        menuItemId: "qc-smart-read-selection",
        selectionText: overrides.text ?? `selection text ${index}`,
        frameId: overrides.frameId,
        frameUrl: overrides.frameUrl,
        pageUrl: overrides.pageUrl
      },
      {
        id: tabId,
        windowId,
        title: overrides.title ?? `Title ${index}`,
        url: overrides.url ?? `https://example.com/${index}`
      }
    );
  }

  async function removeWindow(windowId) {
    missingWindows.add(Number(windowId));
    await listeners.windowRemoved?.(Number(windowId));
  }

  function markWindowMissing(windowId) {
    missingWindows.add(Number(windowId));
  }

  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const sendResponse = (response) => {
        settled = true;
        resolve(structuredClone(response));
      };
      try {
        const keepChannelOpen = listeners.message(message, {}, sendResponse);
        if (keepChannelOpen !== true && !settled) resolve(undefined);
      } catch (error) {
        reject(error);
      }
    });
  }

  return {
    clickSelection,
    createdMenus,
    install: () => listeners.installed(),
    localState,
    notifications,
    openedWindows,
    markWindowMissing,
    removeWindow,
    scriptExecutions,
    sendToBackground,
    sessionState
  };
}

test("background registers the exact localized local-only save menu", async () => {
  const english = await createBackgroundHarness({ uiLanguage: "en" });
  english.install();
  assert.equal(
    english.createdMenus.at(-1).title,
    "Save selection as pending evidence (local, no model)"
  );

  const chinese = await createBackgroundHarness({ uiLanguage: "zh-CN" });
  chinese.install();
  assert.equal(
    chinese.createdMenus.at(-1).title,
    "将选中文本保存为待核验证据（仅本地，不调用模型）"
  );
});

test("background migrates the legacy selection once and rejects overflow without overwriting queued text", async () => {
  const harness = await createBackgroundHarness({
    session: {
      pendingSelection: {
        text: "legacy selection",
        title: "Legacy",
        url: "https://example.com/legacy",
        capturedAt: "2026-01-01T00:00:00.000Z"
      }
    },
    settings: { projectId: "project-a" },
    rejectNotifications: true
  });

  await harness.clickSelection(0, { tabId: 101, windowId: 11 });
  assert.equal(harness.sessionState.pendingSelection, undefined, "legacy single-slot storage was not removed");
  assert.equal(harness.sessionState.pendingSelections, undefined, "legacy session queue was not migrated");
  assert.ok(harness.sessionState.pendingSelectionSessionId, "browser-session id was not created");
  assert.equal(harness.localState.pendingSelections.length, 2);
  assert.deepEqual(
    harness.localState.pendingSelections.map((item) => item.text),
    ["legacy selection", "selection text 0"]
  );
  assert.ok(harness.localState.pendingSelections.every((item) => item.id));
  assert.equal(harness.localState.pendingSelections[1].tabId, 101);
  assert.equal(harness.localState.pendingSelections[1].windowId, 11);
  assert.equal(harness.localState.pendingSelections[1].originalTabId, 101);
  assert.equal(harness.localState.pendingSelections[1].originalWindowId, 11);
  assert.equal(harness.localState.pendingSelections[1].projectId, "project-a");
  assert.equal(harness.localState.pendingSelections[1].text, "selection text 0");
  assert.equal(
    harness.localState.pendingSelections[1].contextText,
    "Prefix from nested DOM.\nselection text 0\nSuffix from nested DOM."
  );
  assert.deepEqual(harness.openedWindows, [11], "a rejected live notification prevented opening the side panel");

  for (let index = 1; index <= 21; index += 1) {
    await harness.clickSelection(index, { tabId: 101 + index, windowId: 11 });
  }
  assert.equal(harness.localState.pendingSelections.length, 20);
  assert.equal(new Set(harness.localState.pendingSelections.map((item) => item.id)).size, 20);
  assert.equal(harness.localState.pendingSelections.at(-1).text, "selection text 18");
  assert.ok(
    harness.localState.pendingSelections.some((item) => item.text === "legacy selection"),
    "queue overflow overwrote the oldest pending selection"
  );
  assert.ok(!harness.localState.pendingSelections.some((item) => item.text === "selection text 21"));
  assert.equal(harness.notifications.at(-1).reason, "queue_full");
  assert.equal(harness.notifications.at(-1).pendingCount, 20);
  assert.equal(harness.sessionState.pendingSelectionNotice.reason, "queue_full");
  assert.equal(harness.notifications.length, 22, "notification failures stopped later queue writes");
});

test("background recovers a durable pending selection in a new browser session and removes raw text only after ACK", async () => {
  const first = await createBackgroundHarness({ settings: { projectId: "project-a" } });
  await first.clickSelection(1, {
    text: "A browser restart must not discard this pending exact quote.",
    tabId: 101,
    windowId: 11,
    url: "https://example.com/durable-selection"
  });

  const committed = structuredClone(first.localState.pendingSelections[0]);
  const firstSessionId = first.sessionState.pendingSelectionSessionId;
  assert.equal(committed.sessionId, firstSessionId);
  assert.equal(committed.originalTabId, 101);
  assert.equal(committed.originalWindowId, 11);
  assert.match(JSON.stringify(first.localState), /browser restart must not discard/);
  assert.doesNotMatch(JSON.stringify(first.sessionState), /browser restart must not discard/);

  const restarted = await createBackgroundHarness({
    local: first.localState,
    session: {}
  });
  const wrongProject = await restarted.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    tabId: 202,
    windowId: 22,
    projectId: "project-b"
  });
  assert.equal(wrongProject.selection, null);
  assert.equal(wrongProject.reason, "project_mismatch");
  assert.equal(restarted.localState.pendingSelections[0].leaseId, "");

  const recovered = await restarted.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    tabId: 202,
    windowId: 22,
    projectId: "project-a"
  });
  assert.equal(recovered.selection.id, committed.id);
  assert.equal(recovered.selection.tabId, null);
  assert.equal(recovered.selection.windowId, null);
  assert.equal(recovered.selection.originalTabId, 101);
  assert.equal(recovered.selection.originalWindowId, 11);
  assert.ok(recovered.selection.orphanedAt);
  assert.notEqual(recovered.selection.sessionId, firstSessionId);
  assert.match(JSON.stringify(restarted.localState), /browser restart must not discard/);

  const acknowledged = await restarted.sendToBackground({
    type: "qc-smart-reader-ack-selection",
    selectionId: recovered.selection.id,
    leaseId: recovered.leaseId,
    tabId: 202,
    windowId: 22,
    projectId: "project-a"
  });
  assert.equal(acknowledged.acknowledged, true);
  assert.equal(restarted.localState.pendingSelections, undefined);
  assert.doesNotMatch(JSON.stringify(restarted.localState), /browser restart must not discard/);
});

test("background orphans a closed or missing window binding while preserving original provenance", async () => {
  const closed = await createBackgroundHarness({ settings: { projectId: "project-a" } });
  await closed.clickSelection(1, {
    text: "Closing the original window must leave this local commit recoverable.",
    tabId: 101,
    windowId: 11
  });
  await closed.removeWindow(11);

  const orphaned = closed.localState.pendingSelections[0];
  assert.equal(orphaned.tabId, null);
  assert.equal(orphaned.windowId, null);
  assert.equal(orphaned.originalTabId, 101);
  assert.equal(orphaned.originalWindowId, 11);
  assert.ok(orphaned.orphanedAt);
  const recovered = await closed.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    tabId: 202,
    windowId: 22,
    projectId: "project-a"
  });
  assert.equal(recovered.selection.id, orphaned.id);

  const missedEvent = await createBackgroundHarness({ settings: { projectId: "project-a" } });
  await missedEvent.clickSelection(2, {
    text: "A missed window removal event is reconciled before a later claim.",
    tabId: 102,
    windowId: 12
  });
  missedEvent.markWindowMissing(12);
  const reconciled = await missedEvent.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    tabId: 203,
    windowId: 23,
    projectId: "project-a"
  });
  assert.equal(reconciled.selection.originalWindowId, 12);
  assert.equal(reconciled.selection.windowId, null);
  assert.ok(reconciled.selection.orphanedAt);
});

test("background reports a missed queue-full notice once to the target panel", async () => {
  const harness = await createBackgroundHarness({
    session: {
      pendingSelections: Array.from({ length: 20 }, (_, index) => ({
        id: `queued-${index}`,
        text: `queued text ${index}`,
        title: `Queued ${index}`,
        url: `https://example.com/${index}`,
        tabId: 101 + index,
        windowId: 11,
        projectId: "project-a",
        capturedAt: "2026-01-01T00:00:00.000Z"
      }))
    },
    settings: { projectId: "project-a" },
    rejectNotifications: true
  });
  await harness.clickSelection(99, { tabId: 999, windowId: 11, text: "must not be dropped silently" });
  const noticeId = harness.sessionState.pendingSelectionNotice.id;

  const notice = await harness.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    noticeId,
    tabId: 999,
    windowId: 11,
    projectId: "project-a"
  });
  assert.equal(notice.selection, null);
  assert.equal(notice.reason, "queue_full");
  assert.equal(notice.pendingCount, 20);
  assert.equal(harness.sessionState.pendingSelectionNotice, undefined);

  const next = await harness.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    tabId: 101,
    windowId: 11,
    projectId: "project-a"
  });
  assert.equal(next.selection.id, "queued-0");
});

test("background leases selections by target and removes them only after a matching acknowledgement", async () => {
  const harness = await createBackgroundHarness({
    session: {
      pendingSelections: [
        {
          id: "selection-a",
          text: "window A text",
          title: "Window A",
          url: "https://example.com/a",
          tabId: 101,
          windowId: 11,
          projectId: "project-a",
          capturedAt: "2026-01-01T00:00:00.000Z"
        },
        {
          id: "selection-b",
          text: "window B text",
          title: "Window B",
          url: "https://example.com/b",
          tabId: 202,
          windowId: 22,
          projectId: "project-a",
          capturedAt: "2026-01-01T00:00:01.000Z"
        }
      ]
    }
  });

  const wrongWindow = await harness.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    selectionId: "selection-a",
    tabId: 202,
    windowId: 22,
    projectId: "project-a"
  });
  assert.equal(wrongWindow.selection, null);
  assert.equal(wrongWindow.reason, "target_mismatch");
  assert.equal(harness.localState.pendingSelections.length, 2);

  const movedTab = await harness.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    selectionId: "selection-a",
    tabId: 101,
    windowId: 22,
    projectId: "project-a"
  });
  assert.equal(movedTab.selection, null);
  assert.equal(movedTab.reason, "target_mismatch");
  assert.equal(harness.localState.pendingSelections[0].leaseId, "");

  const [claimedA, claimedB] = await Promise.all([
    harness.sendToBackground({
      type: "qc-smart-reader-claim-selection",
      selectionId: "selection-a",
      tabId: 101,
      windowId: 11,
      projectId: "project-a"
    }),
    harness.sendToBackground({
      type: "qc-smart-reader-claim-selection",
      selectionId: "selection-b",
      tabId: 202,
      windowId: 22,
      projectId: "project-a"
    })
  ]);
  assert.equal(claimedA.selection.id, "selection-a");
  assert.equal(claimedB.selection.id, "selection-b");
  assert.ok(claimedA.leaseId);
  assert.ok(claimedB.leaseId);
  assert.equal(harness.localState.pendingSelections.length, 2, "leasing removed pending content before commit");

  const resumedClaim = await harness.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    selectionId: "selection-a",
    tabId: 101,
    windowId: 11,
    projectId: "project-a"
  });
  assert.equal(resumedClaim.selection.id, "selection-a");
  assert.equal(resumedClaim.leaseId, claimedA.leaseId, "same-window reopen did not resume its lease");

  const wrongLease = await harness.sendToBackground({
    type: "qc-smart-reader-ack-selection",
    selectionId: "selection-a",
    leaseId: "wrong-lease",
    tabId: 101,
    windowId: 11,
    projectId: "project-a"
  });
  assert.equal(wrongLease.acknowledged, false);
  assert.equal(harness.localState.pendingSelections.length, 2);

  const acknowledgedA = await harness.sendToBackground({
    type: "qc-smart-reader-ack-selection",
    selectionId: "selection-a",
    leaseId: claimedA.leaseId,
    tabId: 101,
    windowId: 11,
    projectId: "project-a"
  });
  assert.equal(acknowledgedA.acknowledged, true);
  assert.deepEqual(harness.localState.pendingSelections.map((item) => item.id), ["selection-b"]);

  const acknowledgedB = await harness.sendToBackground({
    type: "qc-smart-reader-ack-selection",
    selectionId: "selection-b",
    leaseId: claimedB.leaseId,
    tabId: 202,
    windowId: 22,
    projectId: "project-a"
  });
  assert.equal(acknowledgedB.acknowledged, true);
  assert.equal(harness.localState.pendingSelections, undefined);
});

test("background filters no-id drains by project and failed-item exclusions", async () => {
  const harness = await createBackgroundHarness({
    session: {
      pendingSelections: [
        {
          id: "selection-project-a",
          text: "Project A evidence",
          tabId: 101,
          windowId: 11,
          projectId: "project-a"
        },
        {
          id: "selection-project-b-failed",
          text: "Project B ambiguous evidence",
          tabId: 102,
          windowId: 11,
          projectId: "project-b"
        },
        {
          id: "selection-project-b-valid",
          text: "Project B valid evidence",
          tabId: 103,
          windowId: 11,
          projectId: "project-b"
        }
      ]
    }
  });

  const claimed = await harness.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    tabId: 999,
    windowId: 11,
    projectId: "project-b",
    excludeSelectionIds: ["selection-project-b-failed"]
  });

  assert.equal(claimed.selection.id, "selection-project-b-valid");
  assert.equal(claimed.selection.projectId, "project-b");
  assert.deepEqual(
    harness.localState.pendingSelections.map((item) => item.id),
    ["selection-project-a", "selection-project-b-failed", "selection-project-b-valid"]
  );
});

test("background rejects matching ACK and RELEASE tokens after their lease expires", async () => {
  const harness = await createBackgroundHarness({
    session: {
      pendingSelections: [{
        id: "selection-expired",
        text: "expired lease text",
        title: "Expired lease",
        url: "https://example.com/expired",
        tabId: 101,
        windowId: 11,
        projectId: "project-a",
        capturedAt: "2026-01-01T00:00:00.000Z",
        leaseId: "lease-expired",
        leaseWindowId: 11,
        leaseProjectId: "project-a",
        leasedAt: "2000-01-01T00:00:00.000Z",
        leaseExpiresAt: "2000-01-01T00:01:00.000Z"
      }]
    }
  });
  const leaseMessage = {
    selectionId: "selection-expired",
    leaseId: "lease-expired",
    tabId: 101,
    windowId: 11,
    projectId: "project-a"
  };

  const acknowledgement = await harness.sendToBackground({
    type: "qc-smart-reader-ack-selection",
    ...leaseMessage
  });
  assert.equal(acknowledgement.acknowledged, false);
  assert.equal(acknowledgement.reason, "lease_expired");
  assert.equal(harness.localState.pendingSelections.length, 1);

  const release = await harness.sendToBackground({
    type: "qc-smart-reader-release-selection",
    ...leaseMessage
  });
  assert.equal(release.released, false);
  assert.equal(release.reason, "lease_expired");
  assert.equal(harness.localState.pendingSelections[0].leaseId, "lease-expired");

  const renewed = await harness.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    selectionId: "selection-expired",
    tabId: 101,
    windowId: 11,
    projectId: "project-a"
  });
  assert.ok(renewed.leaseId);
  assert.notEqual(renewed.leaseId, "lease-expired");
});

test("background release keeps the snapshotted DOM context and injection failure falls back to quote-only", async () => {
  const nested = await createBackgroundHarness({
    settings: { projectId: "project-a" },
    selectionContext: {
      quote: "nested exact quote",
      prefix: "bounded prefix",
      suffix: "bounded suffix",
      contextText: "bounded prefix\nnested exact quote\nbounded suffix",
      captureMode: "dom-range"
    }
  });
  await nested.clickSelection(1, { text: "nested exact quote", tabId: 101, windowId: 11 });
  const lease = await nested.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    selectionId: nested.localState.pendingSelections[0].id,
    tabId: 101,
    windowId: 11,
    projectId: "project-a"
  });
  const released = await nested.sendToBackground({
    type: "qc-smart-reader-release-selection",
    selectionId: lease.selection.id,
    leaseId: lease.leaseId,
    tabId: 101,
    windowId: 11,
    projectId: "project-a"
  });
  assert.equal(released.released, true);
  assert.equal(nested.localState.pendingSelections.length, 1);
  assert.equal(nested.localState.pendingSelections[0].leaseId, "");
  assert.equal(
    nested.localState.pendingSelections[0].contextText,
    "bounded prefix\nnested exact quote\nbounded suffix"
  );

  const fallback = await createBackgroundHarness({
    settings: { projectId: "project-a" },
    rejectSelectionContext: true
  });
  await fallback.clickSelection(2, {
    text: "  fallback\u00a0quote\r\nwith context unavailable  ",
    tabId: 102,
    windowId: 11
  });
  const stored = fallback.localState.pendingSelections[0];
  assert.equal(stored.text, "fallback quote\nwith context unavailable");
  assert.equal(stored.contextText, stored.text);
  assert.equal(stored.contextMode, "quote-only");

  const repeated = await createBackgroundHarness({
    settings: { projectId: "project-a" },
    selectionContext: {
      quote: "one exact quote",
      prefix: "one exact quote",
      suffix: "bounded suffix"
    }
  });
  await repeated.clickSelection(3, { text: "one exact quote", tabId: 103, windowId: 11 });
  assert.equal(repeated.localState.pendingSelections[0].contextText, "one exact quote");
  assert.equal(repeated.localState.pendingSelections[0].contextMode, "quote-only");
});

test("background rejects normalized selections over 800 characters without queueing or storing the quote", async () => {
  const harness = await createBackgroundHarness({
    settings: { projectId: "project-a" },
    rejectSelectionContext: true
  });
  const oversized = `  ${"x".repeat(799)}\u00a0yz\r\n  `;

  await harness.clickSelection(3, {
    text: oversized,
    tabId: 103,
    windowId: 11,
    title: "Oversized selection"
  });

  assert.deepEqual(harness.localState.pendingSelections || [], []);
  assert.equal(harness.sessionState.pendingSelectionNotice.reason, "selection_too_long");
  assert.equal(harness.sessionState.pendingSelectionNotice.length, 802);
  assert.equal(harness.sessionState.pendingSelectionNotice.max, 800);
  assert.equal(JSON.stringify(harness.sessionState).includes("x".repeat(100)), false);
  assert.equal(harness.notifications.at(-1).reason, "selection_too_long");
  assert.equal(harness.notifications.at(-1).length, 802);
  assert.equal(harness.notifications.at(-1).max, 800);
  assert.equal(harness.scriptExecutions.length, 0, "overlong quote was injected into the page before rejection");

  const notice = await harness.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    noticeId: harness.sessionState.pendingSelectionNotice.id,
    tabId: 103,
    windowId: 11,
    projectId: "project-a"
  });
  assert.equal(notice.selection, null);
  assert.equal(notice.reason, "selection_too_long");
  assert.equal(notice.length, 802);
  assert.equal(notice.max, 800);
  assert.equal(harness.sessionState.pendingSelectionNotice, undefined, "notice was not consumed once");

  const unicodeBoundary = `🙂${"x".repeat(799)}`;
  await harness.clickSelection(4, {
    text: unicodeBoundary,
    tabId: 104,
    windowId: 11,
    title: "Unicode boundary selection"
  });
  assert.equal(Array.from(harness.localState.pendingSelections[0].text).length, 800);
  assert.equal(harness.localState.pendingSelections[0].text, unicodeBoundary);
});

test("background snapshots iframe selections from the clicked frame and freezes its URL", async () => {
  const harness = await createBackgroundHarness({
    settings: { projectId: "project-a" },
    selectionContext: {
      quote: "Evidence selected inside an embedded reader.",
      prefix: "Embedded prefix",
      suffix: "Embedded suffix"
    }
  });

  await harness.clickSelection(8, {
    text: "Evidence selected inside an embedded reader.",
    tabId: 108,
    windowId: 11,
    url: "https://parent.example/article",
    pageUrl: "https://parent.example/article",
    frameId: 4,
    frameUrl: "https://embed.example/reader#/chapter-2"
  });

  assert.deepEqual(harness.scriptExecutions[0].target, { tabId: 108, frameIds: [4] });
  assert.equal(
    harness.localState.pendingSelections[0].url,
    "https://embed.example/reader#/chapter-2"
  );
});

test("background bounds DOM context by Unicode characters without splitting an emoji", async () => {
  const prefix = `zz🙂${"p".repeat(1199)}`;
  const harness = await createBackgroundHarness({
    settings: { projectId: "project-a" },
    selectionContext: {
      quote: "Unicode-safe context boundary.",
      prefix,
      suffix: "suffix"
    }
  });

  await harness.clickSelection(9, {
    text: "Unicode-safe context boundary.",
    tabId: 109,
    windowId: 11
  });

  const storedPrefix = harness.localState.pendingSelections[0].prefix;
  assert.equal(Array.from(storedPrefix).length, 1200);
  assert.equal(storedPrefix.startsWith("🙂"), true);
  assert.equal(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(storedPrefix), false);
});

test("background leaves an enqueue-bound selection pending after a project switch", async () => {
  const harness = await createBackgroundHarness({
    session: {
      pendingSelections: [{
        id: "selection-a",
        text: "project A text",
        title: "Project A",
        url: "https://example.com/a",
        tabId: 101,
        windowId: 11,
        projectId: "project-a",
        capturedAt: "2026-01-01T00:00:00.000Z"
      }]
    }
  });
  const response = await harness.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    selectionId: "selection-a",
    tabId: 101,
    windowId: 11,
    projectId: "project-b"
  });
  assert.equal(response.selection, null);
  assert.equal(response.reason, "project_mismatch");
  assert.equal(response.selectionProjectId, "project-a");
  assert.equal(harness.localState.pendingSelections.length, 1);
});

test("background freezes the click-time project before a delayed DOM snapshot completes", async () => {
  let releaseSnapshot;
  const selectionContextGate = new Promise((resolve) => {
    releaseSnapshot = resolve;
  });
  const harness = await createBackgroundHarness({
    settings: { projectId: "project-a" },
    selectionContextGate
  });

  const click = harness.clickSelection(7, {
    text: "Project identity is frozen at the explicit save gesture.",
    tabId: 107,
    windowId: 11
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.localState.settings = { projectId: "project-b" };
  releaseSnapshot();
  await click;

  assert.equal(harness.localState.pendingSelections[0].projectId, "project-a");
});
