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
  await chrome.storage.session.set({
    pendingSelection: {
      text: info.selectionText || "",
      title: tab.title || "",
      url: tab.url || "",
      capturedAt: new Date().toISOString()
    }
  });
  if (tab.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});
