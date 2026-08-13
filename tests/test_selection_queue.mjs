import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

async function projectFile(name) {
  return readFile(new URL(`../${name}`, import.meta.url), "utf8");
}

async function createBackgroundHarness({ session = {}, settings = {}, rejectNotifications = false } = {}) {
  const source = await projectFile("background.js");
  const sessionState = structuredClone(session);
  const localState = { settings: structuredClone(settings) };
  const listeners = {};
  const notifications = [];
  const openedWindows = [];
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
    crypto: { randomUUID: () => `selection-${++uuid}` },
    chrome: {
      action: {
        onClicked: { addListener(listener) { listeners.actionClicked = listener; } }
      },
      contextMenus: {
        create() {},
        onClicked: { addListener(listener) { listeners.contextMenuClicked = listener; } }
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
    await listeners.contextMenuClicked(
      {
        menuItemId: "qc-smart-read-selection",
        selectionText: overrides.text ?? `selection text ${index}`
      },
      {
        id: tabId,
        windowId,
        title: overrides.title ?? `Title ${index}`,
        url: overrides.url ?? `https://example.com/${index}`
      }
    );
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

  return { clickSelection, localState, notifications, openedWindows, sendToBackground, sessionState };
}

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
  assert.equal(harness.sessionState.pendingSelections.length, 2);
  assert.deepEqual(
    harness.sessionState.pendingSelections.map((item) => item.text),
    ["legacy selection", "selection text 0"]
  );
  assert.ok(harness.sessionState.pendingSelections.every((item) => item.id));
  assert.equal(harness.sessionState.pendingSelections[1].tabId, 101);
  assert.equal(harness.sessionState.pendingSelections[1].windowId, 11);
  assert.equal(harness.sessionState.pendingSelections[1].projectId, "project-a");
  assert.deepEqual(harness.openedWindows, [11], "a rejected live notification prevented opening the side panel");

  for (let index = 1; index <= 21; index += 1) {
    await harness.clickSelection(index, { tabId: 101 + index, windowId: 11 });
  }
  assert.equal(harness.sessionState.pendingSelections.length, 20);
  assert.equal(new Set(harness.sessionState.pendingSelections.map((item) => item.id)).size, 20);
  assert.equal(harness.sessionState.pendingSelections.at(-1).text, "selection text 18");
  assert.ok(
    harness.sessionState.pendingSelections.some((item) => item.text === "legacy selection"),
    "queue overflow overwrote the oldest pending selection"
  );
  assert.ok(!harness.sessionState.pendingSelections.some((item) => item.text === "selection text 21"));
  assert.equal(harness.notifications.at(-1).reason, "queue_full");
  assert.equal(harness.notifications.at(-1).pendingCount, 20);
  assert.equal(harness.sessionState.pendingSelectionNotice.reason, "queue_full");
  assert.equal(harness.notifications.length, 22, "notification failures stopped later queue writes");
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

test("background claims queued selections atomically by id and target window", async () => {
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
  assert.equal(harness.sessionState.pendingSelections.length, 2);

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
  assert.deepEqual(harness.sessionState.pendingSelections, []);

  const duplicateClaim = await harness.sendToBackground({
    type: "qc-smart-reader-claim-selection",
    selectionId: "selection-a",
    tabId: 101,
    windowId: 11,
    projectId: "project-a"
  });
  assert.equal(duplicateClaim.selection, null, "an already consumed selection was returned twice");
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
  assert.equal(harness.sessionState.pendingSelections.length, 1);
});
