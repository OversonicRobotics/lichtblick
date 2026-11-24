// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import zlib from "zlib";

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
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
  const typeBytes = new Uint8Array(Array.from(type, (c) => c.charCodeAt(0)));
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

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Builds a minimal 16-bit grayscale PNG where every pixel has the given value. */
export function make16BitGrayscalePng(
  width: number,
  height: number,
  pixelValue: number,
): Uint8Array {
  const ihdrData = new Uint8Array(13);
  writeUint32BE(ihdrData, 0, width);
  writeUint32BE(ihdrData, 4, height);
  ihdrData[8] = 16; // bit depth
  ihdrData[9] = 0; // grayscale

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
  const ihdrChunk = buildChunk("IHDR", ihdrData);
  const idatChunk = buildChunk("IDAT", compressed);
  const iendChunk = buildChunk("IEND", new Uint8Array(0));

  const png = new Uint8Array(
    PNG_SIG.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
  );
  let offset = 0;
  png.set(PNG_SIG, offset);
  offset += PNG_SIG.length;
  png.set(ihdrChunk, offset);
  offset += ihdrChunk.length;
  png.set(idatChunk, offset);
  offset += idatChunk.length;
  png.set(iendChunk, offset);
  return png;
}

/**
 * Wraps a PNG in a 12-byte compressedDepth header.
 * depthQuantization and minimumDepth are written as little-endian float32 at bytes 4 and 8.
 */
export function makeCompressedDepthBuffer(
  png: Uint8Array,
  depthQuantization: number = 0,
  minimumDepth: number = 0,
): Uint8Array {
  const withHeader = new Uint8Array(12 + png.length);
  const headerView = new DataView(withHeader.buffer);
  headerView.setInt32(0, 0, true);
  headerView.setFloat32(4, depthQuantization, true);
  headerView.setFloat32(8, minimumDepth, true);
  withHeader.set(png, 12);
  return withHeader;
}
