import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEMO_PATH = join(ROOT, "store-assets", "demo", "selection-first-evidence.gif");

function skipSubBlocks(buffer, start) {
  let offset = start;
  while (offset < buffer.length) {
    const size = buffer[offset];
    offset += 1;
    if (size === 0) return offset;
    offset += size;
  }
  throw new Error("truncated GIF sub-block sequence");
}

function inspectGif(buffer) {
  assert.equal(buffer.subarray(0, 6).toString("ascii"), "GIF89a");
  assert.ok(buffer.length >= 13, "GIF logical screen descriptor is missing");

  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  const globalColorTable = (buffer[10] & 0x80) !== 0;
  const globalColorTableBytes = globalColorTable ? 3 * (2 ** ((buffer[10] & 0x07) + 1)) : 0;
  let offset = 13 + globalColorTableBytes;
  let frameCount = 0;
  let pendingDelay = 0;
  let durationCentiseconds = 0;
  let loopsForever = false;

  while (offset < buffer.length) {
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0x3b) break;

    if (marker === 0x21) {
      const label = buffer[offset];
      offset += 1;
      if (label === 0xf9) {
        const blockSize = buffer[offset];
        assert.equal(blockSize, 4, "unexpected GIF graphic-control block size");
        pendingDelay = buffer.readUInt16LE(offset + 2);
        offset += 1 + blockSize;
        assert.equal(buffer[offset], 0, "graphic-control block terminator is missing");
        offset += 1;
        continue;
      }

      if (label === 0xff) {
        const blockSize = buffer[offset];
        const application = buffer.subarray(offset + 1, offset + 1 + blockSize).toString("ascii");
        const dataStart = offset + 1 + blockSize;
        if (application === "NETSCAPE2.0" && buffer[dataStart] === 3 && buffer[dataStart + 1] === 1) {
          loopsForever = buffer.readUInt16LE(dataStart + 2) === 0;
        }
        offset = skipSubBlocks(buffer, dataStart);
        continue;
      }

      offset = skipSubBlocks(buffer, offset);
      continue;
    }

    if (marker === 0x2c) {
      assert.ok(offset + 9 <= buffer.length, "truncated GIF image descriptor");
      const packed = buffer[offset + 8];
      offset += 9;
      if ((packed & 0x80) !== 0) {
        offset += 3 * (2 ** ((packed & 0x07) + 1));
      }
      offset += 1;
      offset = skipSubBlocks(buffer, offset);
      frameCount += 1;
      durationCentiseconds += pendingDelay;
      pendingDelay = 0;
      continue;
    }

    throw new Error(`unexpected GIF block marker 0x${marker.toString(16)}`);
  }

  return {
    width,
    height,
    frameCount,
    durationSeconds: durationCentiseconds / 100,
    loopsForever
  };
}

test("selection First Evidence demo is a bounded, looping README asset", async () => {
  const demo = await readFile(DEMO_PATH);
  const checksum = await readFile(join(ROOT, "store-assets", "demo", "SHA256SUMS"), "utf8");
  assert.ok(demo.length >= 100_000, "demo is unexpectedly small or empty");
  assert.ok(demo.length <= 10 * 1024 * 1024, "demo exceeds the 10 MiB README image ceiling");
  assert.notEqual(demo.subarray(0, 64).toString("utf8").includes("git-lfs"), true, "demo is an LFS pointer");

  const metadata = inspectGif(demo);
  assert.deepEqual([metadata.width, metadata.height], [960, 540]);
  assert.ok(metadata.frameCount >= 5, `expected at least five visual states, got ${metadata.frameCount}`);
  assert.ok(
    metadata.durationSeconds >= 30 && metadata.durationSeconds <= 60,
    `expected a 30–60 second demo, got ${metadata.durationSeconds}s`
  );
  assert.equal(metadata.loopsForever, true, "README demo must loop continuously");
  assert.equal(
    checksum,
    `${createHash("sha256").update(demo).digest("hex")}  selection-first-evidence.gif\n`,
    "demo checksum manifest does not match the tracked GIF"
  );
});

test("both READMEs surface the verified selection demo before the legacy screenshot table", async () => {
  for (const filename of ["README.md", "README.zh-CN.md"]) {
    const readme = await readFile(join(ROOT, filename), "utf8");
    const demoIndex = readme.indexOf("store-assets/demo/selection-first-evidence.gif");
    const screenshotTableIndex = readme.indexOf("store-assets/screenshots/01-capture.png");
    assert.ok(demoIndex >= 0, `${filename} does not embed the selection demo`);
    assert.ok(screenshotTableIndex < 0 || demoIndex < screenshotTableIndex, `${filename} buries the demo after old screenshots`);
    assert.match(readme, /v0\.9\.5/);
  }
});

test("the generator keeps the demo on the real local-only evidence path", async () => {
  const script = await readFile(join(ROOT, "scripts", "capture_selection_demo.mjs"), "utf8");
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.scripts?.["demo:capture"], "node scripts/capture_selection_demo.mjs");
  assert.match(script, /launchPersistentChromium/);
  assert.match(script, /companion_service/);
  assert.match(script, /server\.py/);
  assert.match(script, /pendingSelections/);
  assert.match(script, /chrome\.contextMenus\.onClicked\.dispatch/);
  assert.doesNotMatch(
    script,
    /chrome\.storage\.local\.set\(\s*\{\s*pendingSelections\s*:/,
    "the demo must not bypass the production queue by injecting pendingSelections"
  );
  assert.match(script, /agent_runs/);
  assert.match(script, /exact_quote_match/);
  assert.match(script, /ffmpeg/);
  assert.doesNotMatch(script, /npm install|pip install|brew install/);
});
