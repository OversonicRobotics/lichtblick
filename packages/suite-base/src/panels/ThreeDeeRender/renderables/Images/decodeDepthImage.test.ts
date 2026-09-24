// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import zlib from "zlib";

import { decodeCompressedDepth, isCompressedDepthFormat, tryDecodeDepthPng } from "./decodeDepthImage";

// --- PNG test helpers ---

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
}
const CRC32_TABLE = makeCrc32Table();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  writeUint32BE(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  writeUint32BE(chunk, 8 + data.length, crc32(crcInput));
  return chunk;
}

function compressZlib(data: Uint8Array): Uint8Array {
  return new Uint8Array(zlib.deflateSync(data));
}

function make16BitGrayscalePng(width: number, height: number, pixelValue: number): Uint8Array {
  const ihdrData = new Uint8Array(13);
  writeUint32BE(ihdrData, 0, width);
  writeUint32BE(ihdrData, 4, height);
  ihdrData[8] = 16; // bit depth
  ihdrData[9] = 0;  // grayscale

  const scanlineLen = 1 + width * 2;
  const raw = new Uint8Array(height * scanlineLen);
  for (let row = 0; row < height; row++) {
    const base = row * scanlineLen;
    raw[base] = 0; // filter: None
    for (let col = 0; col < width; col++) {
      raw[base + 1 + col * 2] = (pixelValue >> 8) & 0xff;
      raw[base + 1 + col * 2 + 1] = pixelValue & 0xff;
    }
  }

  const compressed = compressZlib(raw);
  const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrChunk = buildChunk("IHDR", ihdrData);
  const idatChunk = buildChunk("IDAT", compressed);
  const iendChunk = buildChunk("IEND", new Uint8Array(0));

  const png = new Uint8Array(PNG_SIG.length + ihdrChunk.length + idatChunk.length + iendChunk.length);
  let offset = 0;
  png.set(PNG_SIG, offset); offset += PNG_SIG.length;
  png.set(ihdrChunk, offset); offset += ihdrChunk.length;
  png.set(idatChunk, offset); offset += idatChunk.length;
  png.set(iendChunk, offset);
  return png;
}

// --- Tests ---

describe("isCompressedDepthFormat", () => {
  it("returns true for format strings containing 16UC1", () => {
    // GIVEN format strings with 16UC1
    // WHEN isCompressedDepthFormat is called
    // THEN it returns true
    expect(isCompressedDepthFormat("16UC1")).toBe(true);
    expect(isCompressedDepthFormat("16UC1; compressedDepth")).toBe(true);
    expect(isCompressedDepthFormat("16UC1; png")).toBe(true);
  });

  it("returns true for format strings containing 32FC1", () => {
    expect(isCompressedDepthFormat("32FC1")).toBe(true);
    expect(isCompressedDepthFormat("32FC1; compressedDepth")).toBe(true);
  });

  it("returns false for non-depth format strings", () => {
    // GIVEN non-depth format strings
    // WHEN isCompressedDepthFormat is called
    // THEN it returns false
    expect(isCompressedDepthFormat("jpeg")).toBe(false);
    expect(isCompressedDepthFormat("png")).toBe(false);
    expect(isCompressedDepthFormat("rgb8")).toBe(false);
    expect(isCompressedDepthFormat("")).toBe(false);
  });
});

describe("tryDecodeDepthPng", () => {
  it("returns undefined for data without a PNG signature", async () => {
    // GIVEN data that is not a PNG
    const data = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

    // WHEN tryDecodeDepthPng is called
    const result = await tryDecodeDepthPng(data);

    // THEN it returns undefined
    expect(result).toBeUndefined();
  });

  it("returns undefined for truncated PNG data", async () => {
    // GIVEN PNG signature bytes only (no valid chunks)
    const truncated = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

    const result = await tryDecodeDepthPng(truncated);

    expect(result).toBeUndefined();
  });

  it("decodes a 1x1 16-bit grayscale PNG", async () => {
    // GIVEN a valid 1x1 16-bit grayscale PNG with pixel value 1000
    const pixelValue = 1000;
    const png = make16BitGrayscalePng(1, 1, pixelValue);

    // WHEN tryDecodeDepthPng is called
    const result = await tryDecodeDepthPng(png);

    // THEN it returns the decoded depth image
    expect(result).toBeDefined();
    expect(result!.encoding).toBe("16UC1");
    expect(result!.width).toBe(1);
    expect(result!.height).toBe(1);
    expect((result!.data as Uint16Array)[0]).toBe(pixelValue);
  });

  it("decodes a 2x2 16-bit grayscale PNG with correct pixel values", async () => {
    // GIVEN a valid 2x2 16-bit grayscale PNG
    const pixelValue = 2048;
    const png = make16BitGrayscalePng(2, 2, pixelValue);

    // WHEN tryDecodeDepthPng is called
    const result = await tryDecodeDepthPng(png);

    // THEN all 4 pixels have the expected value
    expect(result).toBeDefined();
    expect(result!.width).toBe(2);
    expect(result!.height).toBe(2);
    expect(Array.from(result!.data as Uint16Array)).toEqual([pixelValue, pixelValue, pixelValue, pixelValue]);
  });
});

describe("decodeCompressedDepth", () => {
  it("returns undefined for empty data", async () => {
    // GIVEN empty data
    // WHEN decodeCompressedDepth is called
    // THEN it returns undefined
    const result = await decodeCompressedDepth(new Uint8Array(0), "16UC1");
    expect(result).toBeUndefined();
  });

  it("returns undefined for non-PNG data", async () => {
    // GIVEN data that contains neither a plain PNG nor a compressedDepth-prefixed PNG
    const data = new Uint8Array(20).fill(0x42);

    const result = await decodeCompressedDepth(data, "16UC1");

    expect(result).toBeUndefined();
  });

  it("decodes 16UC1 PNG without compressedDepth header", async () => {
    // GIVEN a plain 16-bit grayscale PNG
    const pixelValue = 500;
    const png = make16BitGrayscalePng(1, 1, pixelValue);

    // WHEN decodeCompressedDepth is called with 16UC1 format
    const result = await decodeCompressedDepth(png, "16UC1");

    // THEN it returns uint16 depth data
    expect(result).toBeDefined();
    expect(result!.encoding).toBe("16UC1");
    expect(result!.width).toBe(1);
    expect(result!.height).toBe(1);
    expect((result!.data as Uint16Array)[0]).toBe(pixelValue);
  });

  it("decodes 16UC1 PNG with 12-byte compressedDepth header", async () => {
    // GIVEN a PNG preceded by a 12-byte compressedDepth header (all zeros)
    const pixelValue = 800;
    const png = make16BitGrayscalePng(1, 1, pixelValue);
    const withHeader = new Uint8Array(12 + png.length);
    withHeader.set(png, 12);

    // WHEN decodeCompressedDepth is called
    const result = await decodeCompressedDepth(withHeader, "16UC1");

    // THEN it returns uint16 depth data ignoring the header
    expect(result).toBeDefined();
    expect(result!.encoding).toBe("16UC1");
    expect(result!.width).toBe(1);
    expect(result!.height).toBe(1);
    expect((result!.data as Uint16Array)[0]).toBe(pixelValue);
  });

  it("decodes 32FC1 with zero quantization as uint16 passthrough", async () => {
    // GIVEN a 32FC1 PNG with header where depthQuantization = 0 (no float reconstruction)
    const pixelValue = 300;
    const png = make16BitGrayscalePng(1, 1, pixelValue);
    const withHeader = new Uint8Array(12 + png.length);
    // header: int32(0) + float32(0 quantization) + float32(0 minDepth)
    withHeader.set(png, 12);

    // WHEN decodeCompressedDepth is called with 32FC1 format and zero quantization
    const result = await decodeCompressedDepth(withHeader, "32FC1");

    // THEN it returns data with 32FC1 encoding (uint16 passthrough when quantization=0)
    expect(result).toBeDefined();
    expect(result!.encoding).toBe("32FC1");
    expect(result!.width).toBe(1);
    expect(result!.height).toBe(1);
  });
});
