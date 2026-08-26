import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPromptImages } from "../src/prompt-images.js";

test("prompt images load every supported attachment in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-images-"));
  const first = join(root, "first");
  const second = join(root, "second");
  await writeFile(first, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await writeFile(second, Buffer.from([0xff, 0xd8, 0xff, 0x00]));

  assert.deepEqual(await loadPromptImages([first, second]), [
    { data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mediaType: "image/png" },
    { data: Buffer.from([0xff, 0xd8, 0xff, 0x00]), mediaType: "image/jpeg" },
  ]);
});

test("prompt images reject unsupported file contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-images-"));
  const source = join(root, "notes.txt");
  await writeFile(source, "not an image");

  await assert.rejects(loadPromptImages([source]), /not a supported image file/);
});

test("prompt images reject animated GIFs", async () => {
  const root = await mkdtemp(join(tmpdir(), "froe-images-"));
  const source = join(root, "animated.gif");
  const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 1, 0];
  await writeFile(source, Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    1, 0, 1, 0, 0x80, 0, 0,
    0, 0, 0, 0xff, 0xff, 0xff,
    ...frame,
    ...frame,
    0x3b,
  ]));

  await assert.rejects(loadPromptImages([source]), /non-animated GIF/);
});
