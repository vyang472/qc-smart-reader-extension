import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const launchedWith = new WeakMap();
let cachedRuntime;
let runtimeResolved = false;
let systemChromeExtensionFailure = "";

function browserIsRequired() {
  return /^(1|true|yes|on)$/i.test(process.env.QC_REQUIRE_BROWSER || "");
}

function executableFile(path) {
  if (!path) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function playwrightCandidates() {
  const bundledNodeModules = join(
    homedir(),
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "node",
    "node_modules"
  );
  const candidates = [
    ["project/node resolution", "playwright"],
    ["bundled Codex runtime", join(bundledNodeModules, "playwright")]
  ];

  const pnpmRoot = join(bundledNodeModules, ".pnpm");
  try {
    const entry = readdirSync(pnpmRoot).find((name) => name.startsWith("playwright@"));
    if (entry) {
      candidates.push(["bundled Codex pnpm runtime", join(pnpmRoot, entry, "node_modules", "playwright")]);
    }
  } catch {
    // The direct bundled path above covers newer Codex runtime layouts.
  }
  return candidates;
}

function loadPlaywrightRuntime() {
  if (runtimeResolved) return cachedRuntime;
  runtimeResolved = true;
  for (const [source, candidate] of playwrightCandidates()) {
    try {
      const playwright = require(candidate);
      if (playwright?.chromium) {
        cachedRuntime = { playwright, source };
        return cachedRuntime;
      }
    } catch {
      // Try the next known local layout. No dependency is installed here.
    }
  }
  cachedRuntime = null;
  return cachedRuntime;
}

function executableBrowserFile(path) {
  if (!executableFile(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findBrowserExecutables(root, maxDepth = 6) {
  const found = [];
  const visit = (directory, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path, depth + 1);
      } else if (
        ["Google Chrome for Testing", "Chromium", "chrome"].includes(entry.name) &&
        executableBrowserFile(path)
      ) {
        found.push(path);
      }
    }
  };
  visit(root, 0);
  return found;
}

function cachedPlaywrightChromium() {
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (process.platform === "darwin") roots.push(join(homedir(), "Library", "Caches", "ms-playwright"));
  roots.push(join(homedir(), ".cache", "ms-playwright"));

  const output = [];
  const seen = new Set();
  for (const root of roots) {
    let releases = [];
    try {
      releases = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
        .sort((left, right) => Number(right.name.split("-")[1]) - Number(left.name.split("-")[1]));
    } catch {
      continue;
    }
    for (const release of releases) {
      for (const path of findBrowserExecutables(join(root, release.name))) {
        if (seen.has(path)) continue;
        seen.add(path);
        output.push({ source: `Playwright Chromium cache ${release.name} (${path})`, executablePath: path });
      }
    }
  }
  return output;
}

function macSystemChrome() {
  if (process.platform !== "darwin") return [];
  return [
    process.env.QC_CHROME_EXECUTABLE || "",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
  ]
    .filter(executableBrowserFile)
    .map((executablePath) => ({ source: `macOS system Chrome (${executablePath})`, executablePath }));
}

function fallbackBrowsers() {
  return [...cachedPlaywrightChromium(), ...macSystemChrome()];
}

function conciseError(error) {
  return String(error?.message || error || "unknown error").split("\n")[0];
}

export function browserUnavailable(t, reason) {
  const message = `Browser runtime unavailable: ${reason}`;
  if (browserIsRequired()) {
    throw new Error(`${message}. QC_REQUIRE_BROWSER=1 forbids browser test skips.`);
  }
  t.skip(message);
  return null;
}

function fallbackOptions(options, executablePath) {
  const { channel: _channel, executablePath: _configuredPath, ...rest } = options;
  return { ...rest, executablePath };
}

export async function launchChromium(t, options = {}) {
  const runtime = loadPlaywrightRuntime();
  if (!runtime) return browserUnavailable(t, "Playwright was not found locally or in the bundled Codex runtime");

  const failures = [];
  try {
    const browser = await runtime.playwright.chromium.launch(options);
    launchedWith.set(browser, runtime.source);
    return browser;
  } catch (error) {
    failures.push(`${runtime.source}: ${conciseError(error)}`);
  }

  const fallbacks = fallbackBrowsers();
  for (const { source, executablePath } of fallbacks) {
    try {
      const browser = await runtime.playwright.chromium.launch(fallbackOptions(options, executablePath));
      launchedWith.set(browser, source);
      return browser;
    } catch (error) {
      failures.push(`${source}: ${conciseError(error)}`);
    }
  }
  if (!fallbacks.length) failures.push("no cached Playwright Chromium or macOS system Chrome was found");

  return browserUnavailable(t, failures.join("; "));
}

export async function launchPersistentChromium(t, userDataDir, options = {}) {
  const runtime = loadPlaywrightRuntime();
  if (!runtime) return browserUnavailable(t, "Playwright was not found locally or in the bundled Codex runtime");
  if (systemChromeExtensionFailure) return browserUnavailable(t, systemChromeExtensionFailure);

  const failures = [];
  try {
    const context = await runtime.playwright.chromium.launchPersistentContext(userDataDir, options);
    launchedWith.set(context, runtime.source);
    return context;
  } catch (error) {
    failures.push(`${runtime.source}: ${conciseError(error)}`);
  }

  const fallbacks = fallbackBrowsers();
  for (const { source, executablePath } of fallbacks) {
    try {
      const context = await runtime.playwright.chromium.launchPersistentContext(
        userDataDir,
        fallbackOptions(options, executablePath)
      );
      launchedWith.set(context, source);
      return context;
    } catch (error) {
      failures.push(`${source}: ${conciseError(error)}`);
    }
  }
  if (!fallbacks.length) failures.push("no cached Playwright Chromium or macOS system Chrome was found");

  return browserUnavailable(t, failures.join("; "));
}

export async function extensionServiceWorker(t, context, timeout = 10000) {
  let worker = context.serviceWorkers()[0];
  if (worker) return worker;
  try {
    worker = await context.waitForEvent("serviceworker", { timeout });
    return worker;
  } catch (error) {
    const source = launchedWith.get(context) || "Chromium";
    const reason = `${source} did not expose the extension service worker: ${conciseError(error)}`;
    if (source.startsWith("macOS system Chrome")) systemChromeExtensionFailure = reason;
    return browserUnavailable(t, reason);
  }
}
