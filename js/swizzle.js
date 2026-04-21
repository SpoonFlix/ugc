// Switch GPU block-linear swizzle/deswizzle.
// Ported from swizzle.py (Tomodachi Life UGC canvas textures, 256x256 RGBA8).

export const CANVAS_W = 256;
export const CANVAS_H = 256;
export const BPP = 4;
export const BLOCK_HEIGHT_GOBS = 16;
export const GOB_W = 64;   // bytes per GOB row
export const GOB_H = 8;    // rows per GOB
export const RAW_SIZE = CANVAS_W * CANVAS_H * BPP;   // 262144

// LUT[i] = swizzled byte offset for linear byte i (0..RAW_SIZE-1).
// Equivalent to numpy's _build_lut broadcast.
function buildLut(width, height, bpp, blockHeightGobs) {
    const gobsPerRow = (width * bpp) / GOB_W;
    const blockBytes = GOB_W * GOB_H * blockHeightGobs;
    const blockRowsPx = GOB_H * blockHeightGobs;
    const rowStride = width * bpp;

    const lut = new Int32Array(height * rowStride);

    for (let y = 0; y < height; y++) {
        const blockY = (y / blockRowsPx) | 0;
        const yInBlock = y - blockY * blockRowsPx;
        const gobYInBlock = (yInBlock / GOB_H) | 0;
        const yInGob = yInBlock - gobYInBlock * GOB_H;

        const gobOffInBlock = gobYInBlock * GOB_W * GOB_H;
        const yBits = ((yInGob & 6) << 5) | ((yInGob & 1) << 4);
        const blockYBase = blockY * gobsPerRow * blockBytes + gobOffInBlock;

        const rowBase = y * rowStride;
        for (let xb = 0; xb < rowStride; xb++) {
            const blockX = (xb / GOB_W) | 0;
            const xInGob = xb - blockX * GOB_W;

            const blockOff = blockX * blockBytes;
            const offInGob =
                ((xInGob & 32) << 3) |
                yBits |
                ((xInGob & 16) << 1) |
                (xInGob & 15);

            lut[rowBase + xb] = blockYBase + blockOff + offInGob;
        }
    }
    return lut;
}

const _LUT = buildLut(CANVAS_W, CANVAS_H, BPP, BLOCK_HEIGHT_GOBS);

// linear RGBA bytes (Uint8Array, length 262144) → swizzled (Uint8Array, same length).
export function swizzle(linearRgba) {
    if (linearRgba.length !== RAW_SIZE) {
        throw new Error(`swizzle: expected ${RAW_SIZE} bytes, got ${linearRgba.length}`);
    }
    const out = new Uint8Array(RAW_SIZE);
    for (let i = 0; i < RAW_SIZE; i++) {
        out[_LUT[i]] = linearRgba[i];
    }
    return out;
}

// swizzled bytes → linear RGBA.
export function deswizzle(swizzled) {
    if (swizzled.length !== RAW_SIZE) {
        throw new Error(`deswizzle: expected ${RAW_SIZE} bytes, got ${swizzled.length}`);
    }
    const out = new Uint8Array(RAW_SIZE);
    for (let i = 0; i < RAW_SIZE; i++) {
        out[i] = swizzled[_LUT[i]];
    }
    return out;
}
