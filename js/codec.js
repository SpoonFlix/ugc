// High-level codec: zstd (+) swizzle (+) BC1/BC3.
// Matches tex_format.py's public API so the app layer is simple.

import { decompress as fzstdDecompress } from '../vendor/fzstd.mjs';
import { init as zstdInit, compress as zstdCompress } from '../vendor/zstd-wasm/index.web.js';
import { swizzle, deswizzle, RAW_SIZE as CANVAS_RAW_SIZE } from './swizzle.js';
import {
    encodeFoodUgctex, encodeGoodsUgctex, encodeThumb,
} from './bcn.js';

let _zstdReady = null;

export async function initCodec() {
    if (_zstdReady) return _zstdReady;
    _zstdReady = zstdInit().catch(e => {
        _zstdReady = null;
        throw e;
    });
    await _zstdReady;
}

// Canvas (.canvas.zs): 256x256 RGBA8, swizzled bh=16, zstd.
export function decodeCanvasZs(zsBytes) {
    const raw = fzstdDecompress(zsBytes);
    if (raw.length !== CANVAS_RAW_SIZE) {
        throw new Error(`canvas: expected ${CANVAS_RAW_SIZE} raw bytes after zstd, got ${raw.length}`);
    }
    return deswizzle(raw);   // Uint8Array(262144) linear RGBA 256x256
}

export function encodeCanvasZs(rgba256, level = 19) {
    if (rgba256.length !== CANVAS_RAW_SIZE) {
        throw new Error(`encodeCanvasZs: rgba must be ${CANVAS_RAW_SIZE} bytes`);
    }
    const swiz = swizzle(rgba256);
    return zstdCompress(swiz, level);
}

// kind: 'food' | 'goods'
// srcRgba: 256x256 RGBA Uint8Array
export async function encodeUgctexZs(srcRgba256, kind, level = 19) {
    const target = kind === 'food' ? 384 : 512;
    const resized = await resizeRgba(srcRgba256, 256, 256, target, target);
    const raw = kind === 'food'
        ? encodeFoodUgctex(resized)
        : encodeGoodsUgctex(resized);
    return zstdCompress(raw, level);
}

export function encodeThumbZs(srcRgba256, level = 19) {
    const raw = encodeThumb(srcRgba256);   // 256x256 BC3 + bh=8 swizzle
    return zstdCompress(raw, level);
}

// ── Resize helper (browser) ───────────────────────────────────────────────
// Uses OffscreenCanvas high-quality smoothing. Not byte-identical to PIL LANCZOS
// but visually equivalent and deterministic per browser.
export async function resizeRgba(rgba, srcW, srcH, dstW, dstH) {
    if (srcW === dstW && srcH === dstH) return rgba;
    const src = new OffscreenCanvas(srcW, srcH);
    const sctx = src.getContext('2d');
    const imgData = new ImageData(new Uint8ClampedArray(rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength)), srcW, srcH);
    sctx.putImageData(imgData, 0, 0);

    const dst = new OffscreenCanvas(dstW, dstH);
    const dctx = dst.getContext('2d');
    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(src, 0, 0, dstW, dstH);
    const out = dctx.getImageData(0, 0, dstW, dstH);
    return new Uint8Array(out.data.buffer);
}

// ── Filename parsing ───────────────────────────────────────────────────────
// Matches ^(Ugc(?:Food|Goods|FacePaint)\d+)\.canvas\.zs$
export const CANVAS_RE = /^(Ugc(?:Food|Goods|FacePaint)\d+)\.canvas\.zs$/;

export function kindsFor(baseName) {
    if (/^UgcFacePaint/.test(baseName)) return ['canvas'];
    return ['canvas', 'ugctex', 'thumb'];
}

// ugctex/thumb filename for a given base name + kind.
export function kindFilename(baseName, kind) {
    if (kind === 'canvas') return `${baseName}.canvas.zs`;
    if (kind === 'ugctex') return `${baseName}.ugctex.zs`;
    if (kind === 'thumb')  return `${baseName}_Thumb.ugctex.zs`;
    throw new Error('unknown kind: ' + kind);
}

// Returns 'food' | 'goods' | 'facepaint' from a base name.
export function baseTypeOf(baseName) {
    if (/^UgcFood/.test(baseName))      return 'food';
    if (/^UgcGoods/.test(baseName))     return 'goods';
    if (/^UgcFacePaint/.test(baseName)) return 'facepaint';
    return 'unknown';
}
