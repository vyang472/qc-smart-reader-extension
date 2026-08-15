import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

async function projectFile(name) {
  return readFile(new URL(`../${name}`, import.meta.url), "utf8");
}

function createNode(attributes = {}) {
  const values = new Map(Object.entries(attributes));
  return {
    hidden: false,
    placeholder: "",
    textContent: "",
    value: "",
    getAttribute(name) {
      return values.has(name) ? values.get(name) : null;
    },
    setAttribute(name, value) {
      values.set(name, String(value));
    }
  };
}

async function createI18nHarness({ uiLanguage, navigatorLanguage = "en-US", storedLocale } = {}) {
  const script = await projectFile("sidepanel_i18n.js");
  const storageState = {
    settings: { pairingToken: "secret", projectId: "research" },
    onboardingMilestones: { claimReadyAt: "2026-08-15T00:00:00.000Z" }
  };
  if (storedLocale !== undefined) storageState.uiLocale = storedLocale;
  const storageWrites = [];
  const storageRemovals = [];
  const documentElement = { lang: "" };
  const nodes = [];
  const context = {
    console,
    navigator: { language: navigatorLanguage },
    document: {
      documentElement,
      querySelectorAll() {
        return nodes;
      },
      getElementById() {
        return null;
      }
    },
    chrome: {
      i18n: uiLanguage === undefined ? undefined : {
        getUILanguage() {
          return uiLanguage;
        }
      },
      storage: {
        local: {
          async get(key) {
            return { [key]: storageState[key] };
          },
          async set(values) {
            storageWrites.push(structuredClone(values));
            Object.assign(storageState, values);
          },
          async remove(key) {
            storageRemovals.push(key);
            delete storageState[key];
          }
        }
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  createContext(context);
  runInContext(script, context);
  return {
    api: context.QCI18n,
    context,
    documentElement,
    nodes,
    storageRemovals,
    storageState,
    storageWrites
  };
}

test("locale normalization is deterministic and privacy-safe", async () => {
  const { api } = await createI18nHarness({ uiLanguage: "zh-CN" });

  for (const locale of ["zh", "zh-CN", "zh_CN", "zh-Hans", "zh-SG"]) {
    assert.equal(api.normalize(locale), "zh-CN", locale);
  }
  for (const locale of ["en", "en-US", "zh-Hant", "zh-TW", "fr-FR", ""]) {
    assert.equal(api.normalize(locale), "en", locale);
  }
});

test("sidepanel loads the classic i18n bridge before the module and exposes the locale selector", async () => {
  const html = await projectFile("sidepanel.html");
  const i18nIndex = html.indexOf('<script src="sidepanel_i18n.js"></script>');
  const moduleIndex = html.indexOf('<script src="sidepanel.js" type="module"></script>');

  assert.ok(i18nIndex >= 0 && moduleIndex > i18nIndex);
  assert.match(html, /id="uiLocaleSelect"/);
  assert.match(html, /value="auto"/);
  assert.match(html, /value="en"/);
  assert.match(html, /value="zh-CN"/);
});

test("resolution follows explicit, Chrome UI, navigator, then English precedence", async () => {
  const chromeChinese = await createI18nHarness({ uiLanguage: "zh-Hans", navigatorLanguage: "en-US" });
  assert.equal(chromeChinese.api.resolve("en-US"), "en");
  assert.equal(chromeChinese.api.resolve("auto"), "zh-CN");

  const chromeTraditional = await createI18nHarness({ uiLanguage: "zh-TW", navigatorLanguage: "zh-CN" });
  assert.equal(chromeTraditional.api.resolve(), "en", "unsupported Chrome locale must not fall through to navigator");

  const navigatorChinese = await createI18nHarness({ navigatorLanguage: "zh-SG" });
  assert.equal(navigatorChinese.api.resolve(), "zh-CN");

  const unsupported = await createI18nHarness({ uiLanguage: "de-DE", navigatorLanguage: "zh-CN" });
  assert.equal(unsupported.api.resolve(), "en");
});

test("explicit locale is stored separately and Auto removes only uiLocale", async () => {
  const harness = await createI18nHarness({ uiLanguage: "zh-CN" });
  const originalSettings = structuredClone(harness.storageState.settings);
  const originalMilestones = structuredClone(harness.storageState.onboardingMilestones);

  await harness.api.set("en");
  assert.equal(harness.api.get(), "en");
  assert.equal(harness.storageState.uiLocale, "en");
  assert.deepEqual(harness.storageWrites, [{ uiLocale: "en" }]);
  assert.deepEqual(harness.storageState.settings, originalSettings);
  assert.deepEqual(harness.storageState.onboardingMilestones, originalMilestones);

  await harness.api.set("auto");
  assert.equal(harness.api.get(), "zh-CN");
  assert.equal(harness.storageState.uiLocale, undefined);
  assert.deepEqual(harness.storageRemovals, ["uiLocale"]);
  assert.deepEqual(harness.storageState.settings, originalSettings);
  assert.deepEqual(harness.storageState.onboardingMilestones, originalMilestones);
});

test("initialization applies the stored explicit preference before browser language", async () => {
  const harness = await createI18nHarness({ uiLanguage: "en-US", storedLocale: "zh_CN" });

  await harness.api.initialize(harness.context.document);

  assert.equal(harness.api.get(), "zh-CN");
  assert.equal(harness.api.preference(), "zh-CN");
  assert.equal(harness.documentElement.lang, "zh-CN");
  assert.deepEqual(harness.storageWrites, [], "loading a preference must not rewrite storage");
});

test("document application translates opted-in chrome without touching input or evidence values", async () => {
  const harness = await createI18nHarness({ uiLanguage: "en-US" });
  const title = createNode({ "data-i18n": "quickStart.title" });
  const selector = createNode({ "data-i18n-placeholder": "currentPage.selectorPlaceholder" });
  selector.value = "article.user-entered";
  const claim = createNode();
  claim.textContent = "原始 claim 不得翻译";
  const quote = createNode();
  quote.textContent = "Exact source quote must remain verbatim.";
  const advancedNotice = createNode({ "data-i18n": "advanced.notice", "data-i18n-show-locale": "en" });
  harness.nodes.push(title, selector, claim, quote, advancedNotice);

  harness.api.applyDocument(harness.context.document);

  assert.equal(harness.documentElement.lang, "en");
  assert.equal(title.textContent, "Create your first evidence-backed claim from this page");
  assert.equal(selector.placeholder, "Content CSS selector, for example article or #js_content");
  assert.equal(selector.value, "article.user-entered");
  assert.equal(claim.textContent, "原始 claim 不得翻译");
  assert.equal(quote.textContent, "Exact source quote must remain verbatim.");
  assert.equal(advancedNotice.hidden, false);
});

test("reviewed and pending-verification messages are localized without translating server status", async () => {
  const { api } = await createI18nHarness({ uiLanguage: "en-US" });

  assert.equal(
    api.t("firstEvidence.review.reviewed"),
    "Saved locally and reviewed by you. This claim is marked supported."
  );
  assert.equal(
    api.t("firstEvidence.review.previous", { status: "pending_validation" }),
    "Your previous decision no longer matches the server status (pending_validation). Compare the claim and quote again."
  );
  assert.equal(
    api.t("quickStart.restore.prefix", {
      step: {
        i18nKey: "quickStart.restore.invalidated",
        params: { status: "pending_validation" }
      }
    }),
    "Restored local progress: server status changed to pending_validation; compare the claim and quote again."
  );
  assert.equal(
    api.t("quickStart.status.failed", {
      error: { i18nKey: "currentPage.error.noTab" }
    }),
    "Quick Start did not complete: No active tab was found."
  );
  assert.equal(
    api.t("settings.status.unavailable", {
      error: {
        i18nKey: "companion.error.apiMismatch",
        params: {
          extensionVersion: "0.9.3",
          requiredApi: 1,
          actualApi: { i18nKey: "companion.value.legacyUnknown" }
        }
      }
    }),
    "The local Companion is unavailable: Extension 0.9.3 requires Companion API 1; the current API is legacy or unknown. Update and restart the Companion."
  );
});

test("First Evidence exposes neutral bilingual support decisions and three user outcomes", async () => {
  const english = (await createI18nHarness({ uiLanguage: "en-US" })).api;
  assert.equal(english.t("quickStart.step.pair"), "Connect Companion");
  assert.equal(english.t("quickStart.step.capture"), "Capture this page");
  assert.equal(english.t("quickStart.step.review"), "Review & save");
  assert.equal(english.t("firstEvidence.prompt"), "Does this exact quote support the claim?");
  assert.equal(english.t("firstEvidence.accept"), "Accept as supported");
  assert.equal(english.t("firstEvidence.reject"), "Reject as unsupported");
  assert.equal(english.t("settings.setup.downloadPrompt"), "Install the matching local Companion before pairing:");
  assert.equal(english.t("settings.setup.downloadCompanion", { version: "1.2.3" }), "Download Companion v1.2.3");
  assert.equal(english.t("settings.setup.downloadChecksums"), "Verify SHA256SUMS");
  assert.match(english.t("quickStart.status.completedRejected"), /3 \/ 3.*unsupported.*another page/i);

  const chinese = (await createI18nHarness({ uiLanguage: "zh-CN" })).api;
  assert.equal(chinese.t("quickStart.step.pair"), "连接 Companion");
  assert.equal(chinese.t("quickStart.step.capture"), "采集当前页");
  assert.equal(chinese.t("quickStart.step.review"), "核对并保存");
  assert.equal(chinese.t("firstEvidence.prompt"), "这段原文是否支持这条 claim？");
  assert.equal(chinese.t("firstEvidence.accept"), "接受：原文支持");
  assert.equal(chinese.t("firstEvidence.reject"), "拒绝：原文不支持");
  assert.equal(chinese.t("settings.setup.downloadPrompt"), "配对前，请先安装与扩展同版本的本地 Companion：");
  assert.equal(chinese.t("settings.setup.downloadCompanion", { version: "1.2.3" }), "下载 Companion v1.2.3");
  assert.equal(chinese.t("settings.setup.downloadChecksums"), "校验 SHA256SUMS");
  assert.match(chinese.t("quickStart.status.completedRejected"), /3 \/ 3.*不支持.*另一个页面/);
});
