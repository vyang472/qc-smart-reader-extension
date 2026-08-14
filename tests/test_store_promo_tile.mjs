import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SVG_PATH = join(ROOT, "store-assets", "web-store", "small-promo-tile-440x280.svg");
const PNG_PATH = join(ROOT, "store-assets", "web-store", "small-promo-tile-440x280.png");
const RENDERER_PATH = join(ROOT, "scripts", "render_small_promo_tile.mjs");

test("small promo tile source is locale- and version-neutral", async () => {
  const [svg, renderer] = await Promise.all([
    readFile(SVG_PATH, "utf8"),
    readFile(RENDERER_PATH, "utf8")
  ]);

  assert.match(svg, /<svg\b[^>]*\bwidth="440"[^>]*\bheight="280"/i);
  assert.match(svg, /\bviewBox="0 0 440 280"/i);
  assert.match(svg, /<title\b/i, "SVG should retain an accessible title");
  assert.match(svg, /<desc\b/i, "SVG should retain an accessible description");
  assert.doesNotMatch(svg, /<text\b/i, "SVG must not contain visible text elements");
  assert.doesNotMatch(svg, /<foreignObject\b/i, "SVG must not hide HTML text");
  assert.doesNotMatch(svg, /\bv\d+(?:\.\d+)+\b/i, "SVG must not contain a version label");
  assert.doesNotMatch(svg, /\b\d+\.\d+\.\d+\b/, "SVG must not contain a semantic version");
  assert.doesNotMatch(svg, /\b(?:version|release)\b/i, "SVG metadata must stay version-neutral");
  assert.doesNotMatch(svg, /<(?:image|a)\b/i, "SVG must use only embedded vector artwork");
  assert.match(renderer, /small-promo-tile-440x280\.svg/);
});

test("small promo tile PNG has the Chrome Web Store raster contract", async () => {
  const png = await readFile(PNG_PATH);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 440);
  assert.equal(png.readUInt32BE(20), 280);
  assert.equal(png[24], 8, "PNG must use 8-bit channels");
  assert.ok([2, 6].includes(png[25]), "PNG must use RGB or RGBA color");
});
