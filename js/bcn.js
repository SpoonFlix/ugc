// BC1 / BC3 encoders + block-linear swizzle for Tomodachi Life UGC textures.
// Ported from tex_format.py. Byte-identical output verified against the Python reference.

const GOB_W = 64;   // bytes per GOB row
const GOB_H = 8;    // rows per GOB

// ── block-linear swizzle (parameterized) ──────────────────────────────────
function buildBlockLut(widthBlocks, heightBlocks, bytesPerBlock, blockHeightGobs) {
    const bytesPerRow = widthBlocks * bytesPerBlock;
    if (bytesPerRow % GOB_W !== 0) {
        throw new Error(`row bytes ${bytesPerRow} not multiple of ${GOB_W}`);
    }
    const gobsPerRow = bytesPerRow / GOB_W;
    const blockRowsPerSuper = GOB_H * blockHeightGobs;
    const superBlockBytes = GOB_W * GOB_H * blockHeightGobs;

    const lut = new Int32Array(heightBlocks * bytesPerRow);

    for (let y = 0; y < heightBlocks; y++) {
        const superY = (y / blockRowsPerSuper) | 0;
        const yInSuper = y - superY * blockRowsPerSuper;
        const gobY = (yInSuper / GOB_H) | 0;
        const yInGob = yInSuper - gobY * GOB_H;

        const yBits = ((yInGob & 6) << 5) | ((yInGob & 1) << 4);
        const gobOff = gobY * GOB_W * GOB_H;
        const superYBase = superY * gobsPerRow * superBlockBytes + gobOff;
        const rowBase = y * bytesPerRow;

        for (let xb = 0; xb < bytesPerRow; xb++) {
            const superX = (xb / GOB_W) | 0;
            const xInGob = xb - superX * GOB_W;
            const superOff = superX * superBlockBytes;
            const offInGob =
                ((xInGob & 32) << 3) | yBits | ((xInGob & 16) << 1) | (xInGob & 15);
            lut[rowBase + xb] = superYBase + superOff + offInGob;
        }
    }
    return lut;
}

export function swizzleBlocks(linear, widthBlocks, heightBlocks, bytesPerBlock, blockHeightGobs) {
    const expected = widthBlocks * heightBlocks * bytesPerBlock;
    if (linear.length !== expected) {
        throw new Error(`swizzleBlocks: expected ${expected} bytes, got ${linear.length}`);
    }
    const lut = buildBlockLut(widthBlocks, heightBlocks, bytesPerBlock, blockHeightGobs);
    const out = new Uint8Array(expected);
    for (let i = 0; i < expected; i++) out[lut[i]] = linear[i];
    return out;
}

export function deswizzleBlocks(swizzled, widthBlocks, heightBlocks, bytesPerBlock, blockHeightGobs) {
    const expected = widthBlocks * heightBlocks * bytesPerBlock;
    if (swizzled.length !== expected) {
        throw new Error(`deswizzleBlocks: expected ${expected} bytes, got ${swizzled.length}`);
    }
    const lut = buildBlockLut(widthBlocks, heightBlocks, bytesPerBlock, blockHeightGobs);
    const out = new Uint8Array(expected);
    for (let i = 0; i < expected; i++) out[i] = swizzled[lut[i]];
    return out;
}

// ── RGB 565 <-> RGB8 (rounded, matching Python) ───────────────────────────
function to565(r, g, b) {
    const R = ((r * 31 + 127) / 255) | 0;
    const G = ((g * 63 + 127) / 255) | 0;
    const B = ((b * 31 + 127) / 255) | 0;
    return ((R << 11) | (G << 5) | B) & 0xFFFF;
}

function from565(v) {
    return [
        (((v >> 11) & 31) * 255 / 31) | 0,
        (((v >> 5)  & 63) * 255 / 63) | 0,
        (( v        & 31) * 255 / 31) | 0,
    ];
}

// ── BC1: per-block encoder ────────────────────────────────────────────────
// block: Uint8Array(64) — 16 RGBA pixels in row-major 4x4 order
// Writes 8 bytes at out[outOff..outOff+8].
function encodeBc1Block(block, out, outOff) {
    let hiAllR = 0, hiAllG = 0, hiAllB = 0;
    let loAllR = 255, loAllG = 255, loAllB = 255;
    let hiOpR = 0, hiOpG = 0, hiOpB = 0;
    let loOpR = 255, loOpG = 255, loOpB = 255;
    let anyOpaque = false, allOpaque = true;

    // alphaOk[i]: 1 if pixel i has alpha >= 128
    const alphaOk = new Uint8Array(16);

    for (let i = 0; i < 16; i++) {
        const r = block[i*4], g = block[i*4+1], b = block[i*4+2], a = block[i*4+3];
        if (r > hiAllR) hiAllR = r; if (r < loAllR) loAllR = r;
        if (g > hiAllG) hiAllG = g; if (g < loAllG) loAllG = g;
        if (b > hiAllB) hiAllB = b; if (b < loAllB) loAllB = b;
        if (a >= 128) {
            alphaOk[i] = 1;
            anyOpaque = true;
            if (r > hiOpR) hiOpR = r; if (r < loOpR) loOpR = r;
            if (g > hiOpG) hiOpG = g; if (g < loOpG) loOpG = g;
            if (b > hiOpB) hiOpB = b; if (b < loOpB) loOpB = b;
        } else {
            allOpaque = false;
        }
    }
    const hasAlpha = !allOpaque;
    const allTrans = !anyOpaque;

    let hiR, hiG, hiB, loR, loG, loB;
    if (anyOpaque) {
        hiR = hiOpR; hiG = hiOpG; hiB = hiOpB;
        loR = loOpR; loG = loOpG; loB = loOpB;
    } else {
        hiR = hiAllR; hiG = hiAllG; hiB = hiAllB;
        loR = loAllR; loG = loAllG; loB = loAllB;
    }

    let c0 = to565(hiR, hiG, hiB);
    let c1 = to565(loR, loG, loB);
    const opaque = !hasAlpha;

    const needSwapOp = opaque && c0 <= c1;
    const needSwapAl = hasAlpha && c0 > c1;
    if (needSwapOp || needSwapAl) { const t = c0; c0 = c1; c1 = t; }

    if (opaque && c0 === c1) {
        c1 = Math.max(c1 - 1, 0) & 0xFFFF;
    }

    if (allTrans) {
        out[outOff  ] = 0;    out[outOff+1] = 0;
        out[outOff+2] = 0xFF; out[outOff+3] = 0xFF;
        out[outOff+4] = 0xFF; out[outOff+5] = 0xFF;
        out[outOff+6] = 0xFF; out[outOff+7] = 0xFF;
        return;
    }

    const [c0r, c0g, c0b] = from565(c0);
    const [c1r, c1g, c1b] = from565(c1);
    // 4-color palette (opaque mode): c0, c1, (2c0+c1)/3, (c0+2c1)/3
    const c2opR = ((2*c0r + c1r) / 3) | 0;
    const c2opG = ((2*c0g + c1g) / 3) | 0;
    const c2opB = ((2*c0b + c1b) / 3) | 0;
    const c3opR = ((c0r + 2*c1r) / 3) | 0;
    const c3opG = ((c0g + 2*c1g) / 3) | 0;
    const c3opB = ((c0b + 2*c1b) / 3) | 0;
    // 3-color palette (alpha mode): c0, c1, (c0+c1)/2
    const c2alR = ((c0r + c1r) / 2) | 0;
    const c2alG = ((c0g + c1g) / 2) | 0;
    const c2alB = ((c0b + c1b) / 2) | 0;

    let indices = 0;
    for (let i = 0; i < 16; i++) {
        const r = block[i*4], g = block[i*4+1], b = block[i*4+2];
        const dr0 = r-c0r, dg0 = g-c0g, db0 = b-c0b;
        const dr1 = r-c1r, dg1 = g-c1g, db1 = b-c1b;
        const d0 = dr0*dr0 + dg0*dg0 + db0*db0;
        const d1 = dr1*dr1 + dg1*dg1 + db1*db1;

        let idx;
        if (hasAlpha) {
            if (!alphaOk[i]) {
                idx = 3;
            } else {
                const dr = r-c2alR, dg = g-c2alG, db = b-c2alB;
                const d2 = dr*dr + dg*dg + db*db;
                // argmin [d0, d1, d2], first-min tie-break
                if (d0 <= d1) idx = d0 <= d2 ? 0 : 2;
                else         idx = d1 <= d2 ? 1 : 2;
            }
        } else {
            const dr2 = r-c2opR, dg2 = g-c2opG, db2 = b-c2opB;
            const d2 = dr2*dr2 + dg2*dg2 + db2*db2;
            const dr3 = r-c3opR, dg3 = g-c3opG, db3 = b-c3opB;
            const d3 = dr3*dr3 + dg3*dg3 + db3*db3;
            // argmin [d0, d1, d2, d3]
            let best = 0, bestD = d0;
            if (d1 < bestD) { best = 1; bestD = d1; }
            if (d2 < bestD) { best = 2; bestD = d2; }
            if (d3 < bestD) { best = 3; }
            idx = best;
        }
        indices |= (idx & 3) << (2 * i);
    }

    out[outOff  ] =  c0        & 0xFF;
    out[outOff+1] = (c0 >>  8) & 0xFF;
    out[outOff+2] =  c1        & 0xFF;
    out[outOff+3] = (c1 >>  8) & 0xFF;
    out[outOff+4] =  indices         & 0xFF;
    out[outOff+5] = (indices >>>  8) & 0xFF;
    out[outOff+6] = (indices >>> 16) & 0xFF;
    out[outOff+7] = (indices >>> 24) & 0xFF;
}

// ── BC1: full image ────────────────────────────────────────────────────────
export function encodeBc1(rgba, width, height) {
    if (rgba.length !== width * height * 4) {
        throw new Error(`encodeBc1: rgba length ${rgba.length} != ${width*height*4}`);
    }
    if (width % 4 || height % 4) throw new Error('encodeBc1: dimensions must be /4');
    const bw = width / 4, bh = height / 4;
    const out = new Uint8Array(bw * bh * 8);
    const block = new Uint8Array(64);
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            // Gather 4x4 block in row-major
            for (let yy = 0; yy < 4; yy++) {
                const srcRow = ((by*4 + yy) * width + bx*4) * 4;
                for (let xx = 0; xx < 4; xx++) {
                    const s = srcRow + xx * 4;
                    const d = (yy*4 + xx) * 4;
                    block[d]   = rgba[s];
                    block[d+1] = rgba[s+1];
                    block[d+2] = rgba[s+2];
                    block[d+3] = rgba[s+3];
                }
            }
            encodeBc1Block(block, out, (by * bw + bx) * 8);
        }
    }
    return out;
}

// ── BC4 alpha (for BC3): per-block encoder ────────────────────────────────
// block: Uint8Array(16) — 16 alpha values in row-major 4x4 order
// Writes 8 bytes at out[outOff..outOff+8].
function encodeBc4AlphaBlock(block, out, outOff) {
    let a_hi = 0, a_lo = 255;
    for (let i = 0; i < 16; i++) {
        const a = block[i];
        if (a > a_hi) a_hi = a;
        if (a < a_lo) a_lo = a;
    }
    // a_hi >= a_lo always. swap = (a_hi <= a_lo) only when equal; a0 ends up as max.
    let a0 = a_hi, a1 = a_lo;

    // equal handling: if a0 == a1 and a0 > 0, decrement a1
    if (a0 === a1 && a0 > 0) a1 = Math.max(a1 - 1, 0);
    // if still equal (means both were 0), bump a0 up
    if (a0 === a1) a0 = Math.min(a0 + 1, 255);

    // 8-point palette (a0 > a1 mode), matching float32 math with int round-to-zero cast
    const palette = new Float32Array(8);
    palette[0] = a0;
    palette[1] = a1;
    palette[2] = (6*a0 + 1*a1) / 7;
    palette[3] = (5*a0 + 2*a1) / 7;
    palette[4] = (4*a0 + 3*a1) / 7;
    palette[5] = (3*a0 + 4*a1) / 7;
    palette[6] = (2*a0 + 5*a1) / 7;
    palette[7] = (1*a0 + 6*a1) / 7;

    // bits: 48-bit word, 3 bits per pixel. Use BigInt for clarity.
    let bits = 0n;
    for (let i = 0; i < 16; i++) {
        const pix = block[i];
        let best = 0, bestD = Math.abs(pix - palette[0]);
        for (let p = 1; p < 8; p++) {
            const d = Math.abs(pix - palette[p]);
            if (d < bestD) { best = p; bestD = d; }
        }
        bits |= BigInt(best & 7) << BigInt(3 * i);
    }

    out[outOff  ] = a0;
    out[outOff+1] = a1;
    out[outOff+2] = Number((bits        ) & 0xFFn);
    out[outOff+3] = Number((bits >>  8n ) & 0xFFn);
    out[outOff+4] = Number((bits >> 16n ) & 0xFFn);
    out[outOff+5] = Number((bits >> 24n ) & 0xFFn);
    out[outOff+6] = Number((bits >> 32n ) & 0xFFn);
    out[outOff+7] = Number((bits >> 40n ) & 0xFFn);
}

// ── BC1 color in 4-mode only (for BC3 color block) ────────────────────────
// block: Uint8Array(48) — 16 RGB pixels in row-major (no alpha).
// Writes 8 bytes at out[outOff..outOff+8].
function encodeBc1Color4Block(block, out, outOff) {
    let hiR = 0, hiG = 0, hiB = 0;
    let loR = 255, loG = 255, loB = 255;
    for (let i = 0; i < 16; i++) {
        const r = block[i*3], g = block[i*3+1], b = block[i*3+2];
        if (r > hiR) hiR = r; if (r < loR) loR = r;
        if (g > hiG) hiG = g; if (g < loG) loG = g;
        if (b > hiB) hiB = b; if (b < loB) loB = b;
    }
    let c0 = to565(hiR, hiG, hiB);
    let c1 = to565(loR, loG, loB);
    // swap on strict <
    if (c0 < c1) { const t = c0; c0 = c1; c1 = t; }
    if (c0 === c1) c1 = Math.max(c1 - 1, 0) & 0xFFFF;

    const [c0r, c0g, c0b] = from565(c0);
    const [c1r, c1g, c1b] = from565(c1);
    const c2R = ((2*c0r + c1r) / 3) | 0;
    const c2G = ((2*c0g + c1g) / 3) | 0;
    const c2B = ((2*c0b + c1b) / 3) | 0;
    const c3R = ((c0r + 2*c1r) / 3) | 0;
    const c3G = ((c0g + 2*c1g) / 3) | 0;
    const c3B = ((c0b + 2*c1b) / 3) | 0;

    let indices = 0;
    for (let i = 0; i < 16; i++) {
        const r = block[i*3], g = block[i*3+1], b = block[i*3+2];
        const dr0=r-c0r, dg0=g-c0g, db0=b-c0b;
        const dr1=r-c1r, dg1=g-c1g, db1=b-c1b;
        const dr2=r-c2R, dg2=g-c2G, db2=b-c2B;
        const dr3=r-c3R, dg3=g-c3G, db3=b-c3B;
        const d0 = dr0*dr0+dg0*dg0+db0*db0;
        const d1 = dr1*dr1+dg1*dg1+db1*db1;
        const d2 = dr2*dr2+dg2*dg2+db2*db2;
        const d3 = dr3*dr3+dg3*dg3+db3*db3;
        let best = 0, bestD = d0;
        if (d1 < bestD) { best = 1; bestD = d1; }
        if (d2 < bestD) { best = 2; bestD = d2; }
        if (d3 < bestD) { best = 3; }
        indices |= (best & 3) << (2 * i);
    }

    out[outOff  ] =  c0        & 0xFF;
    out[outOff+1] = (c0 >>  8) & 0xFF;
    out[outOff+2] =  c1        & 0xFF;
    out[outOff+3] = (c1 >>  8) & 0xFF;
    out[outOff+4] =  indices         & 0xFF;
    out[outOff+5] = (indices >>>  8) & 0xFF;
    out[outOff+6] = (indices >>> 16) & 0xFF;
    out[outOff+7] = (indices >>> 24) & 0xFF;
}

// ── BC3: full image (16 bytes per block: alpha || color) ──────────────────
export function encodeBc3(rgba, width, height) {
    if (rgba.length !== width * height * 4) {
        throw new Error(`encodeBc3: rgba length ${rgba.length} != ${width*height*4}`);
    }
    if (width % 4 || height % 4) throw new Error('encodeBc3: dimensions must be /4');
    const bw = width / 4, bh = height / 4;
    const out = new Uint8Array(bw * bh * 16);
    const alphaBlock = new Uint8Array(16);
    const colorBlock = new Uint8Array(48);
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            for (let yy = 0; yy < 4; yy++) {
                const srcRow = ((by*4 + yy) * width + bx*4) * 4;
                for (let xx = 0; xx < 4; xx++) {
                    const s = srcRow + xx * 4;
                    const p = yy*4 + xx;
                    colorBlock[p*3]   = rgba[s];
                    colorBlock[p*3+1] = rgba[s+1];
                    colorBlock[p*3+2] = rgba[s+2];
                    alphaBlock[p]     = rgba[s+3];
                }
            }
            const off = (by * bw + bx) * 16;
            encodeBc4AlphaBlock(alphaBlock, out, off);
            encodeBc1Color4Block(colorBlock, out, off + 8);
        }
    }
    return out;
}

// ── High-level wrappers matching the Python module API ────────────────────
export const FOOD_UGCTEX_W = 384;
export const FOOD_UGCTEX_STORE_H = 512;
export const FOOD_UGCTEX_VISIBLE_H = 384;
export const GOODS_UGCTEX_W = 512;
export const GOODS_UGCTEX_H = 512;
export const THUMB_W = 256;
export const THUMB_H = 256;

// rgba384: Uint8Array(384*384*4). Returns Uint8Array(98304) swizzled.
export function encodeFoodUgctex(rgba384) {
    if (rgba384.length !== FOOD_UGCTEX_W * FOOD_UGCTEX_VISIBLE_H * 4) {
        throw new Error('encodeFoodUgctex: expected 384x384 RGBA');
    }
    // pad bottom 128 rows with zeros to make 384x512, then encode BC1
    const padded = new Uint8Array(FOOD_UGCTEX_W * FOOD_UGCTEX_STORE_H * 4);
    padded.set(rgba384, 0);
    const bc1 = encodeBc1(padded, FOOD_UGCTEX_W, FOOD_UGCTEX_STORE_H);
    return swizzleBlocks(bc1, FOOD_UGCTEX_W / 4, FOOD_UGCTEX_STORE_H / 4, 8, 16);
}

// rgba512: Uint8Array(512*512*4). Returns Uint8Array(131072) swizzled.
export function encodeGoodsUgctex(rgba512) {
    if (rgba512.length !== GOODS_UGCTEX_W * GOODS_UGCTEX_H * 4) {
        throw new Error('encodeGoodsUgctex: expected 512x512 RGBA');
    }
    const bc1 = encodeBc1(rgba512, GOODS_UGCTEX_W, GOODS_UGCTEX_H);
    return swizzleBlocks(bc1, GOODS_UGCTEX_W / 4, GOODS_UGCTEX_H / 4, 8, 16);
}

// rgba256: Uint8Array(256*256*4). Returns Uint8Array(65536) swizzled.
export function encodeThumb(rgba256) {
    if (rgba256.length !== THUMB_W * THUMB_H * 4) {
        throw new Error('encodeThumb: expected 256x256 RGBA');
    }
    const bc3 = encodeBc3(rgba256, THUMB_W, THUMB_H);
    return swizzleBlocks(bc3, THUMB_W / 4, THUMB_H / 4, 16, 8);
}
