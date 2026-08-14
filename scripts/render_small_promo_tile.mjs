#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchChromium } from "../tests/browser_runtime.mjs";

process.env.QC_REQUIRE_BROWSER = "1";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = resolve(ROOT, "store-assets", "web-store", "small-promo-tile-440x280.svg");
const DEFAULT_OUTPUT = resolve(ROOT, "store-assets", "web-store", "small-promo-tile-440x280.png");
const WIDTH = 440;
const HEIGHT = 280;
const T = {
  skip(reason) {
    throw new Error(reason);
  }
};

function outputPath(argv) {
  if (argv.length === 0) return DEFAULT_OUTPUT;
  if (argv.length === 2 && argv[0] === "--output") return resolve(argv[1]);
  throw new Error("Usage: node scripts/render_small_promo_tile.mjs [--output PATH]");
}

function assertPngContract(data, path) {
  assert.deepEqual(
    [...data.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${path} is not a PNG`
  );
  assert.equal(data.readUInt32BE(16), WIDTH, `${path} width`);
  assert.equal(data.readUInt32BE(20), HEIGHT, `${path} height`);
  assert.ok([2, 6].includes(data[25]), `${path} must use RGB or RGBA color`);
}

async function main() {
  const destination = outputPath(process.argv.slice(2));
  const svg = await readFile(SOURCE, "utf8");
  assert.doesNotMatch(svg, /<text\b/i, "promo tile SVG must not contain visible text");
  assert.doesNotMatch(svg, /\bv\d+(?:\.\d+)+\b/i, "promo tile SVG must be version-neutral");

  await mkdir(dirname(destination), { recursive: true });
  const browser = await launchChromium(T, {
    headless: true,
    channel: "chromium",
    args: ["--force-color-profile=srgb"]
  });
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1
    });
    await page.setContent(
      `<style>html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#071426}</style>${svg}`,
      { waitUntil: "load" }
    );
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    });
    const data = await page.screenshot({
      path: destination,
      type: "png",
      animations: "disabled",
      omitBackground: false
    });
    assertPngContract(data, destination);
  } finally {
    await browser.close();
  }

  console.log(`Rendered ${destination} from ${SOURCE}`);
}

await main();
