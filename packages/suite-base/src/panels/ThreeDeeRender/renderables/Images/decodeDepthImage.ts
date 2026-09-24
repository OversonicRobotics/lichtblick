// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

// Decode a 16-bit grayscale PNG into raw uint16 depth values.
// Used for depth-cloud rendering from foxglove.CompressedImage / sensor_msgs/CompressedImage.
//
// The browser's createImageBitmap API converts 16-bit PNGs to 8-bit RGBA, losing depth
// precision. This decoder handles 16-bit grayscale directly using DecompressionStream.
//
// Also handles the ROS compressedDepth plugin format:
//   - 16UC1;compressedDepth: optional 12-byte header (int32 format + float32 quantization + float32 minDepth) + PNG
//   - 32FC1;compressedDepth: 12-byte header + PNG (quantized 16-bit values requiring float reconstruction)

export type DecodedDepthImage = {
  /** Raw depth values: uint16 (mm for 16UC1) or reconstructed float32 (m for 32FC1) */
  data: Uint16Array | Float32Array;
  encoding: "16UC1" | "32FC1";
  width: number;
  height: number;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const COMPRESSED_DEPTH_HEADER_SIZE = 12;

/**
 * Returns true if the compressed image format string indicates a depth image.
 * Matches "16UC1", "32FC1" anywhere in the format string (handles "16UC1; compressedDepth",
 * "32FC1; png", etc.) or a plain "png" which may be a 16-bit depth PNG.
 */
export function isCompressedDepthFormat(format: string): boolean {
  return format.includes("16UC1") || format.includes("32FC1");
}

/**
 * Decode a compressed depth image (PNG-encoded 16-bit grayscale or quantized 32FC1).
 * Returns undefined if the data is not a recognized depth PNG.
 */
export async function decodeCompressedDepth(
  data: Uint8Array,
  format: string,
): Promise<DecodedDepthImage | undefined> {
  const is32FC1 = format.includes("32FC1");

  // Locate the PNG data — handle optional compressedDepth header
  let pngOffset = 0;
  let depthQuantization = 0;
  let minimumDepth = 0;

  if (hasPngSignature(data, COMPRESSED_DEPTH_HEADER_SIZE)) {
    // 12-byte compressedDepth header present
    pngOffset = COMPRESSED_DEPTH_HEADER_SIZE;
    if (is32FC1) {
      const headerView = new DataView(data.buffer, data.byteOffset, Math.min(12, data.byteLength));
      depthQuantization = headerView.getFloat32(4, true); // little-endian
      minimumDepth = headerView.getFloat32(8, true);
    }
  } else if (hasPngSignature(data, 0)) {
    pngOffset = 0;
  } else {
    return undefined;
  }

  const pngData = data.subarray(pngOffset);
  const decoded = await decode16BitGrayscalePng(pngData);
  if (!decoded) {
    return undefined;
  }

  if (is32FC1 && depthQuantization !== 0) {
    // Reconstruct float32 depth from quantized uint16 values
    // Formula: depth_m = depthQuantization / (pixel - 0.5) + minimumDepth
    const floatData = new Float32Array(decoded.pixels.length);
    for (let i = 0; i < decoded.pixels.length; i++) {
      const pixel = decoded.pixels[i]!;
      floatData[i] = pixel === 0 ? 0 : depthQuantization / (pixel - 0.5) + minimumDepth;
    }
    return { data: floatData, encoding: "32FC1", width: decoded.width, height: decoded.height };
  }

  // 16UC1: values are in mm, keep as uint16
  return {
    data: decoded.pixels,
    encoding: (is32FC1 ? "32FC1" : "16UC1"),
    width: decoded.width,
    height: decoded.height,
  };
}

/**
 * Attempt to decode a plain PNG (format: "png") as 16-bit grayscale depth.
 * Returns undefined if not a 16-bit grayscale PNG.
 */
export async function tryDecodeDepthPng(
  data: Uint8Array,
): Promise<DecodedDepthImage | undefined> {
  if (!hasPngSignature(data, 0)) {
    return undefined;
  }
  const decoded = await decode16BitGrayscalePng(data);
  if (!decoded) {
    return undefined;
  }
  return { data: decoded.pixels, encoding: "16UC1", width: decoded.width, height: decoded.height };
}

function hasPngSignature(data: Uint8Array, offset: number): boolean {
  if (data.length < offset + 8) {
    return false;
  }
  for (let i = 0; i < 8; i++) {
    if (data[offset + i] !== PNG_SIGNATURE[i]) {
      return false;
    }
  }
  return true;
}

type ParsedPng = { pixels: Uint16Array; width: number; height: number };

async function decode16BitGrayscalePng(data: Uint8Array): Promise<ParsedPng | undefined> {
  if (!hasPngSignature(data, 0)) {
    return undefined;
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Uint8Array[] = [];

  // Parse PNG chunks
  while (offset + 8 <= data.length) {
    const length =
      ((data[offset]! << 24) |
        (data[offset + 1]! << 16) |
        (data[offset + 2]! << 8) |
        data[offset + 3]!) >>>
      0;
    const type = String.fromCharCode(
      data[offset + 4]!,
      data[offset + 5]!,
      data[offset + 6]!,
      data[offset + 7]!,
    );
    offset += 8;

    if (offset + length > data.length) {
      break;
    }

    if (type === "IHDR") {
      width =
        ((data[offset]! << 24) |
          (data[offset + 1]! << 16) |
          (data[offset + 2]! << 8) |
          data[offset + 3]!) >>>
        0;
      height =
        ((data[offset + 4]! << 24) |
          (data[offset + 5]! << 16) |
          (data[offset + 6]! << 8) |
          data[offset + 7]!) >>>
        0;
      bitDepth = data[offset + 8]!;
      colorType = data[offset + 9]!;
    } else if (type === "IDAT") {
      idatChunks.push(data.slice(offset, offset + length));
    } else if (type === "IEND") {
      break;
    }

    offset += length + 4; // chunk data + CRC
  }

  // Only handle 16-bit grayscale (bit_depth=16, color_type=0)
  if (bitDepth !== 16 || colorType !== 0 || width === 0 || height === 0) {
    return undefined;
  }

  // Concatenate IDAT chunks
  const totalIdatLen = idatChunks.reduce((sum, c) => sum + c.length, 0);
  const idatData = new Uint8Array(totalIdatLen);
  let pos = 0;
  for (const chunk of idatChunks) {
    idatData.set(chunk, pos);
    pos += chunk.length;
  }

  // Decompress zlib-compressed IDAT data
  const decompressed = await decompressZlib(idatData);
  if (!decompressed) {
    return undefined;
  }

  // Reconstruct scanlines with PNG filter bytes
  // Each row: 1 filter byte + width * 2 data bytes (16-bit big-endian)
  const bytesPerPixel = 2;
  const rowStride = width * 2;
  const pixels = new Uint16Array(width * height);
  const prevRow = new Uint8Array(rowStride); // prior row, starts as zeros

  for (let row = 0; row < height; row++) {
    const filterOffset = row * (rowStride + 1);
    if (filterOffset + 1 + rowStride > decompressed.length) {
      return undefined;
    }
    const filterByte = decompressed[filterOffset]!;
    const cur = decompressed.subarray(filterOffset + 1, filterOffset + 1 + rowStride);

    // Apply filter reconstruction in-place into a per-row buffer
    const rec = new Uint8Array(rowStride);
    for (let i = 0; i < rowStride; i++) {
      const x = cur[i]!;
      const a = i >= bytesPerPixel ? rec[i - bytesPerPixel]! : 0;
      const b = prevRow[i]!;
      const c = i >= bytesPerPixel ? prevRow[i - bytesPerPixel]! : 0;
      switch (filterByte) {
        case 0:
          rec[i] = x;
          break;
        case 1:
          rec[i] = (x + a) & 0xff;
          break;
        case 2:
          rec[i] = (x + b) & 0xff;
          break;
        case 3:
          rec[i] = (x + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          rec[i] = (x + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          rec[i] = x;
      }
    }

    // Convert big-endian bytes to uint16 pixel values
    const rowBase = row * width;
    for (let col = 0; col < width; col++) {
      pixels[rowBase + col] = ((rec[col * 2]! << 8) | rec[col * 2 + 1]!) >>> 0;
    }

    prevRow.set(rec);
  }

  return { pixels, width, height };
}

async function decompressZlib(data: Uint8Array): Promise<Uint8Array | undefined> {
  try {
    const ds = new DecompressionStream("deflate");

    // Read concurrently with writing to avoid backpressure deadlock:
    // awaiting write() before reading stalls when output > readable highWaterMark.
    const chunks: Uint8Array[] = [];
    const readDone = (async () => {
      const reader = ds.readable.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(value);
      }
    })();

    const writer = ds.writable.getWriter();
    await writer.write(data as Uint8Array<ArrayBuffer>);
    await writer.close();
    await readDone;

    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(totalLen);
    let outPos = 0;
    for (const chunk of chunks) {
      out.set(chunk, outPos);
      outPos += chunk.length;
    }
    return out;
  } catch {
    return undefined;
  }
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  if (pb <= pc) {
    return b;
  }
  return c;
}
