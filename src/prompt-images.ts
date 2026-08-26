import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ImageMediaType, PromptImage } from "./types.js";

const maxImageCount = 1_500;
const maxRequestBytes = 512 * 1024 * 1024;
const maxDataUrlPrefixBytes = Buffer.byteLength("data:image/jpeg;base64,");

export async function loadPromptImages(paths: string[]): Promise<PromptImage[]> {
  if (paths.length > maxImageCount) throw new Error(`At most ${maxImageCount} images can be attached to one prompt.`);

  const images: PromptImage[] = [];
  let requestBytes = 0;
  for (const path of paths) {
    const absolutePath = resolve(path);
    const details = await stat(absolutePath);
    if (!details.isFile()) throw new Error(`${path} is not a regular file.`);
    requestBytes += maxDataUrlPrefixBytes + base64Bytes(details.size);
    if (requestBytes > maxRequestBytes) throw new Error("Attached images exceed the 512 MB request limit.");
    const data = await readFile(absolutePath);
    const mediaType = detectMediaType(data);
    if (mediaType === undefined) throw new Error(`${path} is not a supported image file (PNG, JPEG, WEBP, or non-animated GIF).`);
    images.push({ data, mediaType });
  }
  return images;
}

function base64Bytes(fileBytes: number): number {
  return 4 * Math.ceil(fileBytes / 3);
}

function detectMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (!startsWith(data, [0x47, 0x49, 0x46, 0x38]) || (data[4] !== 0x37 && data[4] !== 0x39) || data[5] !== 0x61) return undefined;
  return isAnimatedGif(data) ? undefined : "image/gif";
}

function startsWith(data: Uint8Array, bytes: number[], offset = 0): boolean {
  return bytes.every((byte, index) => data[offset + index] === byte);
}

function isAnimatedGif(data: Uint8Array): boolean {
  let index = 13;
  if ((data[10] ?? 0) & 0x80) index += 3 * (1 << (((data[10] ?? 0) & 0x07) + 1));
  let frames = 0;
  while (index < data.length) {
    const block = data[index];
    if (block === 0x3b) return frames > 1;
    if (block === 0x2c) {
      frames += 1;
      if (frames > 1) return true;
      index += 10;
      if ((data[index - 1] ?? 0) & 0x80) index += 3 * (1 << (((data[index - 1] ?? 0) & 0x07) + 1));
      index += 1;
      index = skipGifSubBlocks(data, index);
      continue;
    }
    if (block === 0x21) {
      index = skipGifSubBlocks(data, index + 2);
      continue;
    }
    return false;
  }
  return false;
}

function skipGifSubBlocks(data: Uint8Array, index: number): number {
  while (index < data.length) {
    const length = data[index] ?? 0;
    index += length + 1;
    if (length === 0) return index;
  }
  return index;
}
