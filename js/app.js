// TomoTexture Web — main app logic.

import {
    initCodec,
    decodeCanvasZs, encodeCanvasZs, encodeUgctexZs, encodeThumbZs,
    CANVAS_RE, kindsFor, kindFilename, baseTypeOf,
} from './codec.js';

// ── DOM ────────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const btnOpenFolder = $('#btnOpenFolder');
const btnUseFiles   = $('#btnUseFiles');
const fileFallback  = $('#fileFallback');
const modeBadge     = $('#modeBadge');
const saveRootLabel = $('#saveRoot');
const grid          = $('#grid');
const emptyState    = $('#emptyState');
const countLabel    = $('#countLabel');
const statusEl      = $('#status');

// Manage Dialog
const dlgManage        = $('#dlgManage');
const dlgManageTitle   = $('#dlgManageTitle');
const dlgManageSub     = $('#dlgManageSub');
const dlgManageCanvas  = $('#dlgManageCanvas');
const btnManageReplace = $('#btnManageReplace');
const btnManageRecrop  = $('#btnManageRecrop');
const btnManageExport  = $('#btnManageExport');
const btnManageRevert  = $('#btnManageRevert');

// Crop Dialog
const dlgCrop        = $('#dlgCrop');
const cropStage      = $('#cropStage');
const cropCanvas     = $('#cropCanvas');
const cropFrame      = $('#cropFrame');
const cropInfoCoords = $('#cropInfoCoords');
const btnCropReset   = $('#btnCropReset');
const btnCropConfirm = $('#btnCropConfirm');

// Confirm Dialog
const dlgConfirm   = $('#dlgConfirm');
const dlgConfTitle = $('#dlgConfirmTitle');
const dlgConfBody  = $('#dlgConfirmBody');
const dlgConfCur   = $('#dlgConfirmCur');
const dlgConfNew   = $('#dlgConfirmNew');
const chkBackup    = $('#chkBackup');
const btnConfirm   = $('#btnConfirmReplace');

document.querySelectorAll('dialog [data-close]').forEach(b => {
    b.addEventListener('click', () => b.closest('dialog').close());
});

// ── State ──────────────────────────────────────────────────────────────────
const FSA_SUPPORTED = typeof window.showDirectoryPicker === 'function';
let rootHandle = null;       
let entries =[];            
let activeEntry = null; // Tracks which entry is open in the Manage Hub

// ── Formatter ──────────────────────────────────────────────────────────────
// Converts "UgcFacePaint000" to "Face Paint 1"
function formatItemName(baseName) {
    const match = /Ugc(FacePaint|Food|Goods)(\d+)/.exec(baseName);
    if (!match) return baseName;
    const type = match[1].replace(/([A-Z])/g, ' $1').trim(); 
    const num = parseInt(match[2], 10) + 1;
    return `${type} ${num}`;
}

// ── Boot ───────────────────────────────────────────────────────────────────
(async function boot() {
    if (FSA_SUPPORTED) {
        modeBadge.textContent = 'Folder Mode';
        modeBadge.classList.add('ok');
    } else {
        modeBadge.textContent = 'Files Mode';
        modeBadge.classList.add('warn');
        btnOpenFolder.disabled = true;
    }
    try {
        await initCodec();
    } catch (e) {
        setStatus('Failed to load codec: ' + e.message, 'err');
    }
})();

function setStatus(msg, kind = '') {
    statusEl.textContent = msg;
    statusEl.classList.toggle('show', !!msg);
    statusEl.classList.toggle('err', kind === 'err');
    statusEl.classList.toggle('ok',  kind === 'ok');
    if (msg && kind === 'ok') {
        setTimeout(() => { if (statusEl.textContent === msg) setStatus(''); }, 3000);
    }
}

function withError(fn) {
    return async (...args) => {
        try { return await fn(...args); }
        catch (e) { console.error(e); setStatus(e.message || String(e), 'err'); }
    };
}

// ── Setup / Load ───────────────────────────────────────────────────────────
btnOpenFolder.addEventListener('click', withError(async () => {
    rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    // Display virtual path using workspace name
    saveRootLabel.textContent = `Workspace: /${rootHandle.name}/`;

    setStatus('Scanning…');
    entries = await scanFolderFSA(rootHandle);
    await renderEntries();
    setStatus(`Found ${entries.length} items.`, 'ok');
}));

async function scanFolderFSA(dirHandle, prefix = '', out = []) {
    for await (const [name, handle] of dirHandle.entries()) {
        if (handle.kind === 'directory') {
            if (name.startsWith('_ugc-tool-backups')) continue;
            await scanFolderFSA(handle, prefix + name + '/', out);
        } else {
            const m = CANVAS_RE.exec(name);
            if (m) {
                out.push({
                    baseName: m[1],
                    type: baseTypeOf(m[1]),
                    slotPath: prefix,
                    dirHandle,
                    lastUploadedBmp: null // Store original image here for re-cropping
                });
            }
        }
    }
    return out;
}

btnUseFiles.addEventListener('click', () => fileFallback.click());
fileFallback.addEventListener('change', withError(async (ev) => {
    const files = Array.from(ev.target.files ||[]);
    ev.target.value = '';
    if (!files.length) return;
    entries = entriesFromFiles(files);
    saveRootLabel.textContent = `(${files.length} individual files)`;
    await renderEntries();
}));

function entriesFromFiles(files) {
    const byBase = new Map();
    for (const f of files) {
        const m = CANVAS_RE.exec(f.name);
        if (m) {
            const base = m[1];
            byBase.set(base, byBase.get(base) || { baseName: base, type: baseTypeOf(base), slotPath: '', files: {}, lastUploadedBmp: null });
            byBase.get(base).files.canvas = f;
        }
        const mu = /^(Ugc(?:Food|Goods|FacePaint)\d+)\.ugctex\.zs$/.exec(f.name);
        if (mu) {
            const base = mu[1];
            byBase.set(base, byBase.get(base) || { baseName: base, type: baseTypeOf(base), slotPath: '', files: {}, lastUploadedBmp: null });
            byBase.get(base).files.ugctex = f;
        }
        const mt = /^(Ugc(?:Food|Goods|FacePaint)\d+)_Thumb\.ugctex\.zs$/.exec(f.name);
        if (mt) {
            const base = mt[1];
            byBase.set(base, byBase.get(base) || { baseName: base, type: baseTypeOf(base), slotPath: '', files: {}, lastUploadedBmp: null });
            byBase.get(base).files.thumb = f;
        }
    }
    return [...byBase.values()].filter(e => e.files?.canvas);
}

// ── Render grid ───────────────────────────────────────────────────────────
async function renderEntries() {
    grid.innerHTML = '';
    emptyState.hidden = entries.length > 0;
    grid.hidden = entries.length === 0;
    countLabel.textContent = entries.length ? `${entries.length} ITEMS` : '';

    entries.sort((a, b) => (a.type + a.baseName).localeCompare(b.type + b.baseName));

    for (const entry of entries) {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
            <div class="thumb-wrap"><canvas class="thumb" width="256" height="256"></canvas></div>
            <div class="name">${formatItemName(entry.baseName)}</div>
        `;
        card.addEventListener('click', () => openManageHub(entry));
        grid.appendChild(card);
        entry.domCard = card;
        loadThumbFor(entry).catch(e => console.warn('thumb fail', entry.baseName, e));
    }
}

// ── Codec helpers ─────────────────────────────────────────────────────────
async function getCanvasBytes(entry) {
    if (entry.dirHandle) {
        const handle = await entry.dirHandle.getFileHandle(`${entry.baseName}.canvas.zs`);
        const file = await handle.getFile();
        return new Uint8Array(await file.arrayBuffer());
    }
    return new Uint8Array(await entry.files.canvas.arrayBuffer());
}

async function getCanvasRgba(entry) {
    return decodeCanvasZs(await getCanvasBytes(entry));
}

async function loadThumbFor(entry) {
    const rgba = await getCanvasRgba(entry);
    const canvas = entry.domCard.querySelector('canvas.thumb');
    drawRgbaToCanvas(canvas, rgba, 256, 256);
}

function drawRgbaToCanvas(canvas, rgba, w, h) {
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    ctx.putImageData(new ImageData(clamped, w, h), 0, 0);
}

// ── Management Hub ─────────────────────────────────────────────────────────
async function openManageHub(entry) {
    activeEntry = entry;
    dlgManageTitle.textContent = formatItemName(entry.baseName);
    dlgManageSub.textContent = entry.slotPath ? `/${entry.slotPath}` : 'Local Files';
    
    // Check for backups to enable revert button
    btnManageRevert.disabled = true;
    if (entry.dirHandle) {
        try {
            await entry.dirHandle.getFileHandle(`${entry.baseName}.canvas.zs.bak`);
            btnManageRevert.disabled = false;
        } catch {}
    }

    // Enable/disable recrop based on memory
    btnManageRecrop.disabled = !entry.lastUploadedBmp;

    const rgba = await getCanvasRgba(entry);
    drawRgbaToCanvas(dlgManageCanvas, rgba, 256, 256);
    
    dlgManage.showModal();
}

// Hub Actions
btnManageReplace.addEventListener('click', withError(async () => {
    const file = await pickFile('image/*');
    if (!file) return;
    const bmp = await createImageBitmap(file);
    activeEntry.lastUploadedBmp = bmp; // Store for recropping
    
    const newRgba = await askCrop(bmp);
    if (!newRgba) return;
    
    await executeReplace(activeEntry, newRgba);
}));

btnManageRecrop.addEventListener('click', withError(async () => {
    if (!activeEntry.lastUploadedBmp) return;
    const newRgba = await askCrop(activeEntry.lastUploadedBmp);
    if (!newRgba) return;
    
    await executeReplace(activeEntry, newRgba);
}));

btnManageExport.addEventListener('click', withError(async () => {
    const rgba = await getCanvasRgba(activeEntry);
    const off = new OffscreenCanvas(256, 256);
    const ctx = off.getContext('2d');
    const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    ctx.putImageData(new ImageData(clamped, 256, 256), 0, 0);
    const blob = await off.convertToBlob({ type: 'image/png' });
    downloadBlob(blob, `${activeEntry.baseName}.png`);
}));

btnManageRevert.addEventListener('click', withError(async () => {
    await revertEntry(activeEntry);
    dlgManage.close(); // Refresh UI
}));


// ── Core Actions ───────────────────────────────────────────────────────────
async function executeReplace(entry, newRgba) {
    const curRgba = await getCanvasRgba(entry);
    const ok = await askConfirmReplace(entry, curRgba, newRgba);
    if (!ok.confirmed) return;

    setStatus('Encoding…');
    const canvasBytes = encodeCanvasZs(newRgba);

    let ugctexBytes, thumbBytes;
    if (entry.type !== 'facepaint') {
        ugctexBytes = await encodeUgctexZs(newRgba, entry.type);
        thumbBytes  = encodeThumbZs(newRgba);
    }

    setStatus('Writing Data…');
    if (entry.dirHandle) {
        if (ok.backup) await backupOriginals(entry);
        await writeFileIntoDir(entry.dirHandle, kindFilename(entry.baseName, 'canvas'), canvasBytes);
        if (ugctexBytes) {
            await writeFileIntoDir(entry.dirHandle, kindFilename(entry.baseName, 'ugctex'), ugctexBytes);
            await writeFileIntoDir(entry.dirHandle, kindFilename(entry.baseName, 'thumb'),  thumbBytes);
        }
    } else {
        downloadBlob(new Blob([canvasBytes]), kindFilename(entry.baseName, 'canvas'));
        if (ugctexBytes) {
            downloadBlob(new Blob([ugctexBytes]), kindFilename(entry.baseName, 'ugctex'));
            downloadBlob(new Blob([thumbBytes]),  kindFilename(entry.baseName, 'thumb'));
        }
    }

    await loadThumbFor(entry);
    drawRgbaToCanvas(dlgManageCanvas, newRgba, 256, 256); // Update hub preview
    btnManageRecrop.disabled = false; // Enable adjust crop button
    
    // Re-check backup status
    if (entry.dirHandle) btnManageRevert.disabled = false;
    
    setStatus(`Updated successfully!`, 'ok');
}

async function backupOriginals(entry) {
    for (const kind of kindsFor(entry.baseName)) {
        const name = kindFilename(entry.baseName, kind);
        const bakName = `${name}.bak`;
        try { await entry.dirHandle.getFileHandle(bakName); continue; } catch {}
        try {
            const handle = await entry.dirHandle.getFileHandle(name);
            const file = await handle.getFile();
            await writeFileIntoDir(entry.dirHandle, bakName, new Uint8Array(await file.arrayBuffer()));
        } catch { }
    }
}

async function revertEntry(entry) {
    if (!entry.dirHandle) throw new Error('revert requires folder mode');
    let restored = 0;
    for (const kind of kindsFor(entry.baseName)) {
        const name = kindFilename(entry.baseName, kind);
        const bakName = `${name}.bak`;
        try {
            const bak = await entry.dirHandle.getFileHandle(bakName);
            const file = await bak.getFile();
            await writeFileIntoDir(entry.dirHandle, name, new Uint8Array(await file.arrayBuffer()));
            restored++;
        } catch {}
    }
    if (!restored) {
        setStatus(`No backup found.`, 'err');
        return;
    }
    entry.lastUploadedBmp = null; // Clear crop memory on revert
    await loadThumbFor(entry);
    setStatus(`Restored to original.`, 'ok');
}

async function writeFileIntoDir(dirHandle, name, bytes) {
    const handle = await dirHandle.getFileHandle(name, { create: true });
    const stream = await handle.createWritable();
    await stream.write(bytes);
    await stream.close();
}

async function cropBitmapToRgba(bmp, sx, sy, size, dstW, dstH) {
    const c = new OffscreenCanvas(dstW, dstH);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, sx, sy, size, size, 0, 0, dstW, dstH);
    const d = ctx.getImageData(0, 0, dstW, dstH);
    return new Uint8Array(d.data.buffer);
}

function pickFile(accept) {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = accept;
        input.onchange = () => resolve(input.files[0] || null);
        input.oncancel = () => resolve(null);
        input.click();
    });
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── UI Dialog Logic ────────────────────────────────────────────────────────
function askCrop(bmp) {
    return new Promise(resolve => {
        const CROP_OUT_W = 256, CROP_OUT_H = 256, MIN_FRAME_PX = 16;
        cropCanvas.width = bmp.width; cropCanvas.height = bmp.height;
        const ctx = cropCanvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0);

        let size = Math.min(bmp.width, bmp.height);
        let x = (bmp.width  - size) / 2, y = (bmp.height - size) / 2;

        const metrics = () => {
            const stageR  = cropStage.getBoundingClientRect();
            const canvasR = cropCanvas.getBoundingClientRect();
            const scale   = canvasR.width / bmp.width;
            return { scale, leftInStage: canvasR.left - stageR.left, topInStage: canvasR.top - stageR.top, canvasR };
        };

        const apply = () => {
            const { scale, leftInStage, topInStage } = metrics();
            if (!isFinite(scale) || scale <= 0) return;
            cropFrame.style.left   = (leftInStage + x * scale) + 'px';
            cropFrame.style.top    = (topInStage  + y * scale) + 'px';
            cropFrame.style.width  = (size * scale) + 'px';
            cropFrame.style.height = (size * scale) + 'px';
        };

        let drag = null;
        const clientToImg = (cX, cY) => {
            const { canvasR, scale } = metrics();
            return { imgX: (cX - canvasR.left) / scale, imgY: (cY - canvasR.top ) / scale };
        };
        const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

        const onDown = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            if (!cropFrame.contains(e.target)) return;
            e.preventDefault();
            const targetHandle = e.target.closest('.handle');
            drag = { mode: targetHandle ? targetHandle.dataset.handle : 'move', origin: clientToImg(e.clientX, e.clientY), start: { x, y, size } };
            cropStage.setPointerCapture(e.pointerId);
        };

        const onMove = (e) => {
            if (!drag) return;
            e.preventDefault();
            const p = clientToImg(e.clientX, e.clientY);
            const dx = p.imgX - drag.origin.imgX, dy = p.imgY - drag.origin.imgY;
            const s = drag.start;

            if (drag.mode === 'move') {
                x = clamp(s.x + dx, 0, bmp.width  - s.size);
                y = clamp(s.y + dy, 0, bmp.height - s.size);
                size = s.size;
            } else {
                const anchorX = (drag.mode === 'nw' || drag.mode === 'sw') ? s.x + s.size : s.x;
                const anchorY = (drag.mode === 'nw' || drag.mode === 'ne') ? s.y + s.size : s.y;
                const signX = (drag.mode === 'nw' || drag.mode === 'sw') ? -1 : 1;
                const signY = (drag.mode === 'nw' || drag.mode === 'ne') ? -1 : 1;
                const deltaX = signX * dx, deltaY = signY * dy;
                let newSize = Math.max(MIN_FRAME_PX, s.size + Math.max(deltaX, deltaY));
                newSize = Math.min(newSize, signX > 0 ? (bmp.width  - anchorX) : anchorX, signY > 0 ? (bmp.height - anchorY) : anchorY);
                size = Math.max(newSize, MIN_FRAME_PX);
                x = signX > 0 ? anchorX : anchorX - size;
                y = signY > 0 ? anchorY : anchorY - size;
            }
            apply();
        };

        const onUp = (e) => {
            if (!drag) return;
            drag = null;
            try { cropStage.releasePointerCapture(e.pointerId); } catch {}
        };

        const onReset = () => { size = Math.min(bmp.width, bmp.height); x = (bmp.width - size) / 2; y = (bmp.height - size) / 2; apply(); };
        const confirm = async () => { cleanup(); const rgba = await cropBitmapToRgba(bmp, Math.round(x), Math.round(y), Math.round(size), CROP_OUT_W, CROP_OUT_H); dlgCrop.close(); resolve(rgba); };
        const cancel = () => { cleanup(); dlgCrop.close(); resolve(null); };
        const onResize = () => apply();

        const cleanup = () => {
            cropStage.removeEventListener('pointerdown', onDown); cropStage.removeEventListener('pointermove', onMove);
            cropStage.removeEventListener('pointerup', onUp); cropStage.removeEventListener('pointercancel', onUp);
            btnCropConfirm.removeEventListener('click', confirm); btnCropReset.removeEventListener('click', onReset);
            window.removeEventListener('resize', onResize); dlgCrop.removeEventListener('close', cancel);
        };

        cropStage.addEventListener('pointerdown', onDown); cropStage.addEventListener('pointermove', onMove);
        cropStage.addEventListener('pointerup', onUp); cropStage.addEventListener('pointercancel', onUp);
        btnCropConfirm.addEventListener('click', confirm); btnCropReset.addEventListener('click', onReset);
        window.addEventListener('resize', onResize); dlgCrop.addEventListener('close', cancel, { once: true });

        dlgCrop.showModal();
        requestAnimationFrame(() => { apply(); requestAnimationFrame(apply); });
    });
}

function askConfirmReplace(entry, curRgba, newRgba) {
    return new Promise(resolve => {
        dlgConfTitle.textContent = `Update ${formatItemName(entry.baseName)}?`;
        dlgConfBody.textContent = entry.type === 'facepaint' ? 'Will update canvas layer.' : 'Will update canvas, texture, and thumbnail.';
        drawRgbaToCanvas(dlgConfCur, curRgba, 256, 256); drawRgbaToCanvas(dlgConfNew, newRgba, 256, 256);

        const cleanup = (res) => { dlgConfirm.close(); btnConfirm.removeEventListener('click', onC); dlgConfirm.removeEventListener('close', onX); resolve(res); };
        const onC = () => cleanup({ confirmed: true, backup: chkBackup.checked }); const onX = () => cleanup({ confirmed: false });
        btnConfirm.addEventListener('click', onC); dlgConfirm.addEventListener('close', onX, { once: true });
        dlgConfirm.showModal();
    });
}
