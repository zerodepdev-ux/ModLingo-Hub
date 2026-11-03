'use strict';

const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');

/* ================================================================
   XXH32 — needed for LZ4 frame header checksum
   ================================================================ */
const XXH32 = (() => {
    const P1 = 0x9E3779B1, P2 = 0x85EBCA77, P3 = 0xC2B2AE3D, P4 = 0x27D4EB2F, P5 = 0x165667B1;
    const u  = v => v >>> 0;
    const r  = (v, n) => u((v << n) | (v >>> (32 - n)));
    const m  = Math.imul;
    const r32 = (buf, i) => u(buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24));
    const rnd = (a, inp) => { a = u(a + m(inp, P2)); a = r(a, 13); return u(m(a, P1)); };

    return function (buf, seed) {
        seed = seed || 0;
        const len = buf.length;
        let h, i = 0;
        if (len >= 16) {
            let v1 = u(u(seed + P1) + P2), v2 = u(seed + P2), v3 = u(seed), v4 = u(u(seed - P1));
            do {
                v1 = rnd(v1, r32(buf, i)); i += 4;
                v2 = rnd(v2, r32(buf, i)); i += 4;
                v3 = rnd(v3, r32(buf, i)); i += 4;
                v4 = rnd(v4, r32(buf, i)); i += 4;
            } while (i <= len - 16);
            h = u(u(r(v1, 1) + r(v2, 7)) + u(r(v3, 12) + r(v4, 18)));
        } else {
            h = u(seed + P5);
        }
        h = u(h + len);
        while (i <= len - 4) { h = u(h + m(r32(buf, i), P3)); h = u(m(r(h, 17), P4)); i += 4; }
        while (i < len)      { h = u(h + m(buf[i], P5));       h = u(m(r(h, 11), P1)); i++; }
        h = u(m(u(h ^ (h >>> 15)), P2));
        h = u(m(u(h ^ (h >>> 13)), P3));
        return u(h ^ (h >>> 16));
    };
})();

/* ================================================================
   LZ4 BLOCK DECOMPRESSION
   ================================================================ */
function lz4DecompressBlock(src, sOff, sEnd, dst, dOff) {
    let sI = sOff, dI = dOff;
    while (sI < sEnd) {
        const tok = src[sI++];
        let litLen = (tok >> 4) & 0xF;
        if (litLen === 15) { let b; do { b = src[sI++]; litLen += b; } while (b === 255); }
        if (litLen > 0) {
            src.copy(dst, dI, sI, sI + litLen);
            dI += litLen;
            sI += litLen;
        }
        if (sI >= sEnd) break;
        const off = src[sI] | (src[sI + 1] << 8); sI += 2;
        let matLen = (tok & 0xF) + 4;
        if ((tok & 0xF) === 15) { let b; do { b = src[sI++]; matLen += b; } while (b === 255); }
        let mP = dI - off;
        for (let j = 0; j < matLen; j++) dst[dI++] = dst[mP++];
    }
    return dI - dOff;
}

/* ================================================================
   LZ4 FRAME DECOMPRESSION
   ================================================================ */
const BLK_MAX = [0, 0, 0, 0, 65536, 262144, 1048576, 4194304];

function lz4FrameDecompress(src) {
    if (!Buffer.isBuffer(src)) src = Buffer.from(src);
    let p = 0;
    if (src.readUInt32LE(p) !== 0x184D2204) throw new Error('Bad LZ4 frame magic');
    p += 4;
    const flg = src[p++], bd = src[p++];
    if ((flg >> 3) & 1) p += 8;   // content size
    if (flg & 1)        p += 4;   // dict id
    p++;                           // header checksum
    const bMax = BLK_MAX[(bd >> 4) & 7] || 4194304;
    const hasBlockCk = (flg >> 4) & 1;

    const chunks = [];
    while (p + 4 <= src.length) {
        const bSize = src.readUInt32LE(p); p += 4;
        if (bSize === 0) break;
        const uncomp = !!(bSize & 0x80000000);
        const actual = bSize & 0x7FFFFFFF;
        if (p + actual > src.length) break;
        if (uncomp) {
            chunks.push(src.subarray(p, p + actual));
        } else {
            const out = Buffer.alloc(bMax);
            const len = lz4DecompressBlock(src, p, p + actual, out, 0);
            chunks.push(out.subarray(0, len));
        }
        p += actual;
        if (hasBlockCk) p += 4;
    }
    return Buffer.concat(chunks);
}

/* ================================================================
   LZ4 FRAME WRITE  (uncompressed blocks — valid LZ4, max compat)
   ================================================================ */
function lz4FrameWrapUncompressed(data) {
    if (!Buffer.isBuffer(data)) data = Buffer.from(data);
    const BMAX = 4194304;
    let totalSize = 7 + 4; // header (7) + endmark (4)
    let remaining = data.length;
    while (remaining > 0) {
        const bl = Math.min(BMAX, remaining);
        totalSize += 4 + bl;
        remaining -= bl;
    }

    const out = Buffer.alloc(totalSize);
    let p = 0;
    out.writeUInt32LE(0x184D2204, p); p += 4;
    const flg = 0x60, bd = 0x70;
    out[p++] = flg;
    out[p++] = bd;
    out[p++] = (XXH32(Buffer.from([flg, bd]), 0) >>> 8) & 0xFF;

    let dOff = 0;
    while (dOff < data.length) {
        const bLen = Math.min(BMAX, data.length - dOff);
        out.writeUInt32LE((bLen | 0x80000000) >>> 0, p); p += 4;
        data.copy(out, p, dOff, dOff + bLen); p += bLen;
        dOff += bLen;
    }
    out.writeUInt32LE(0, p); // endmark
    return out;
}

/* ================================================================
   LSPK v18 READER  — streaming read via fs.promises.open()
   ================================================================ */
async function readLSPK(filePath) {
    const handle = await fsp.open(filePath, 'r');
    const stat = await handle.stat();
    const fileSize = stat.size;

    // 1) Signature (8 bytes at offset 0)
    const sigBuf = Buffer.alloc(8);
    await handle.read(sigBuf, 0, 8, 0);
    const sig = sigBuf.toString('ascii', 0, 4);
    if (sig !== 'LSPK') {
        await handle.close();
        throw new Error('Not an LSPK package (bad signature)');
    }
    const version = sigBuf.readUInt32LE(4);
    if (version < 15 || version > 18) {
        await handle.close();
        throw new Error(`Unsupported LSPK version ${version}. Expected 15-18 for BG3.`);
    }

    // 2) Read metadata header
    let fileListOff, fileListSize, flags, priority, md5, numParts;

    if (version === 18) {
        // v18: header is at offset 8 (right after signature), 32 bytes
        const hdrBuf = Buffer.alloc(32);
        await handle.read(hdrBuf, 0, 32, 8);
        const offLo = hdrBuf.readUInt32LE(0);
        const offHi = hdrBuf.readUInt32LE(4);
        fileListOff  = offHi * 0x100000000 + offLo;
        fileListSize = hdrBuf.readUInt32LE(8);
        flags        = hdrBuf[12];
        priority     = hdrBuf[13];
        md5          = Buffer.from(hdrBuf.subarray(14, 30));
        numParts     = hdrBuf.readUInt16LE(30);
    } else {
        // v13-v16: tail header at end of file (36 bytes)
        const tailOff = fileSize - 36;
        if (tailOff < 8) {
            await handle.close();
            throw new Error('File too small for LSPK');
        }
        const tailBuf = Buffer.alloc(36);
        await handle.read(tailBuf, 0, 36, tailOff);
        const offLo  = tailBuf.readUInt32LE(4);
        const offHi  = tailBuf.readUInt32LE(8);
        fileListOff  = offHi * 0x100000000 + offLo;
        fileListSize = tailBuf.readUInt32LE(12);
        flags        = tailBuf[16];
        priority     = tailBuf[17];
        md5          = Buffer.from(tailBuf.subarray(18, 34));
        numParts     = tailBuf.readUInt16LE(34);
    }

    if (fileListOff < 8 || fileListOff + fileListSize > fileSize) {
        await handle.close();
        throw new Error(`Invalid file list offset/size: off=${fileListOff} size=${fileListSize} fileLen=${fileSize}`);
    }

    // 3) Read and decompress file list
    const compBuf = Buffer.alloc(fileListSize);
    await handle.read(compBuf, 0, fileListSize, fileListOff);

    let fileListBuf;
    if (version >= 18 && fileListSize >= 8) {
        // v18 file list: uint32 numFiles + uint32 compressedSize + LZ4 block data
        const numFiles     = compBuf.readUInt32LE(0);
        const compDataSize = compBuf.readUInt32LE(4);
        const ENTRY_SIZE   = 272;
        const uncompSize   = numFiles * ENTRY_SIZE;
        const compData     = compBuf.subarray(8, 8 + compDataSize);

        if (compDataSize >= uncompSize) {
            // Stored uncompressed
            fileListBuf = compData.subarray(0, uncompSize);
        } else {
            // LZ4 block decompression
            try {
                fileListBuf = Buffer.alloc(uncompSize);
                lz4DecompressBlock(compData, 0, compData.length, fileListBuf, 0);
            } catch (e1) {
                try { fileListBuf = lz4FrameDecompress(compData); } catch (e2) {
                    try { fileListBuf = zlib.inflateSync(compData); } catch (e3) {
                        await handle.close();
                        throw new Error('Cannot decompress v18 file list');
                    }
                }
            }
        }
    } else {
        // v13-v16: LZ4 frame or zlib compressed file list
        try {
            fileListBuf = lz4FrameDecompress(compBuf);
        } catch (e1) {
            try {
                fileListBuf = zlib.inflateSync(compBuf);
            } catch (e2) {
                await handle.close();
                throw new Error('Cannot decompress file list. LZ4: ' + e1.message + ' | Zlib: ' + e2.message);
            }
        }
    }

    // 4) Parse entry metadata (272 bytes each)
    const ENTRY_SIZE = 272;
    const numEntries = Math.floor(fileListBuf.length / ENTRY_SIZE);
    const entries = [];

    for (let i = 0; i < numEntries; i++) {
        const base = i * ENTRY_SIZE;
        let nameEnd = base;
        while (nameEnd < base + 256 && fileListBuf[nameEnd] !== 0) nameEnd++;
        const name = fileListBuf.toString('utf8', base, nameEnd);

        const offLow     = fileListBuf.readUInt32LE(base + 256);
        const offHigh    = fileListBuf.readUInt16LE(base + 260);
        const offset     = offHigh * 0x100000000 + offLow;
        const archivePart = fileListBuf[base + 262];
        const eFlags     = fileListBuf[base + 263];
        const sizeOnDisk = fileListBuf.readUInt32LE(base + 264);
        const uncompSize = fileListBuf.readUInt32LE(base + 268);
        const compression = eFlags & 0x0F;

        entries.push({ name, offset, sizeOnDisk, uncompSize, compression, archivePart, originalFlags: eFlags });
    }

    return { handle, fileSize, version, flags, priority, md5, numParts, entries };
}

/* ================================================================
   READ SINGLE ENTRY DATA  — only reads the bytes needed
   ================================================================ */
async function readEntryData(handle, entry) {
    const raw = Buffer.alloc(entry.sizeOnDisk);
    await handle.read(raw, 0, entry.sizeOnDisk, entry.offset);

    if (entry.compression === 0) return raw;

    if (entry.compression === 1) { // zlib
        try { return zlib.inflateSync(raw); } catch { return raw; }
    }

    if (entry.compression === 2) { // LZ4
        try {
            return lz4FrameDecompress(raw);
        } catch {
            try {
                const out = Buffer.alloc(entry.uncompSize);
                lz4DecompressBlock(raw, 0, raw.length, out, 0);
                return out;
            } catch { return raw; }
        }
    }

    return raw;
}

/* ================================================================
   LZ4 BLOCK COMPRESSION  (greedy, 4-byte hash, 64K window)
   ================================================================ */
function lz4CompressBlock(src) {
    if (!Buffer.isBuffer(src)) src = Buffer.from(src);
    const sLen = src.length;
    if (sLen === 0) return Buffer.alloc(0);

    // Worst case: each byte as literal + overhead
    const dst = Buffer.alloc(sLen + Math.ceil(sLen / 255) + 16);
    let dI = 0, anchor = 0;

    const HASH_BITS = 16;
    const HASH_SIZE = 1 << HASH_BITS;
    const hashTable = new Int32Array(HASH_SIZE).fill(-1);

    function hash4(i) {
        const v = src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24);
        return ((Math.imul(v, 0x9E3779B1) >>> 0) >>> (32 - HASH_BITS)) & (HASH_SIZE - 1);
    }

    let sI = 0;
    while (sI + 4 < sLen - 5) {
        const h = hash4(sI);
        const ref = hashTable[h];
        hashTable[h] = sI;

        if (ref < 0 || sI - ref > 65535 ||
            src[ref] !== src[sI] || src[ref + 1] !== src[sI + 1] ||
            src[ref + 2] !== src[sI + 2] || src[ref + 3] !== src[sI + 3]) {
            sI++;
            continue;
        }

        // Match found — emit literal + match
        const litLen = sI - anchor;
        let matchLen = 4;
        while (sI + matchLen < sLen && src[ref + matchLen] === src[sI + matchLen]) matchLen++;

        // Token
        const tokenPos = dI++;
        let tokenLit = Math.min(litLen, 15);
        let tokenMatch = Math.min(matchLen - 4, 15);
        dst[tokenPos] = (tokenLit << 4) | tokenMatch;

        // Extra literal length
        if (litLen >= 15) {
            let rem = litLen - 15;
            while (rem >= 255) { dst[dI++] = 255; rem -= 255; }
            dst[dI++] = rem;
        }

        // Literal bytes
        src.copy(dst, dI, anchor, anchor + litLen);
        dI += litLen;

        // Match offset (little-endian 16-bit)
        const matchOff = sI - ref;
        dst[dI++] = matchOff & 0xFF;
        dst[dI++] = (matchOff >> 8) & 0xFF;

        // Extra match length
        if (matchLen - 4 >= 15) {
            let rem = matchLen - 4 - 15;
            while (rem >= 255) { dst[dI++] = 255; rem -= 255; }
            dst[dI++] = rem;
        }

        sI += matchLen;
        anchor = sI;
    }

    // Last literals (must be at least 5 bytes — LZ4 spec)
    const lastLit = sLen - anchor;
    const tokenPos = dI++;
    let tokenLit = Math.min(lastLit, 15);
    dst[tokenPos] = (tokenLit << 4); // match len = 0 for last sequence
    if (lastLit >= 15) {
        let rem = lastLit - 15;
        while (rem >= 255) { dst[dI++] = 255; rem -= 255; }
        dst[dI++] = rem;
    }
    src.copy(dst, dI, anchor, anchor + lastLit);
    dI += lastLit;

    return dst.subarray(0, dI);
}

/* ================================================================
   LSPK v18 WRITER  — matches BG3 native format
   Preserves original entry compression. LZ4-compresses file list.
   ================================================================ */

async function writeLSPK(outputPath, pakInfo, entries) {
    // Pre-calculate all offsets so we can write sequentially
    const DATA_START = 40; // 8 (sig) + 32 (header)

    let currentOffset = DATA_START;
    const entryBuffers = [];
    const entryMeta = [];
    for (const entry of entries) {
        // Re-compress modified entries (XML) with LZ4 block, keep others as-is
        let storeBuf, storeFlags, storeSizeOnDisk, storeUncompSize;

        if (entry.originalRaw && !entry.modified) {
            // Non-modified entry: use original raw (already compressed) data as-is
            storeBuf = entry.originalRaw;
            storeFlags = entry.originalFlags || 0;
            storeSizeOnDisk = entry.originalRaw.length;
            storeUncompSize = entry.uncompSize || entry.originalRaw.length;
        } else {
            const buf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);

            if (entry.modified && entry.originalFlags !== 0) {
                // Entry was modified and originally compressed: re-compress with LZ4
                const compressed = lz4CompressBlock(buf);
                if (compressed.length < buf.length) {
                    storeBuf = compressed;
                    storeFlags = 0x12;  // LZ4 (compression=2) + flag bits matching original
                    storeSizeOnDisk = compressed.length;
                    storeUncompSize = buf.length;
                } else {
                    storeBuf = buf;
                    storeFlags = 0;
                    storeSizeOnDisk = buf.length;
                    storeUncompSize = buf.length;
                }
            } else {
                // Store uncompressed (flags=0, like reference translation mods)
                storeBuf = buf;
                storeFlags = 0;
                storeSizeOnDisk = buf.length;
                storeUncompSize = buf.length;
            }
        }

        entryBuffers.push(storeBuf);
        entryMeta.push({
            name: entry.name,
            offset: currentOffset,
            sizeOnDisk: storeSizeOnDisk,
            uncompSize: storeUncompSize,
            flags: storeFlags,
            archivePart: entry.archivePart || 0,
        });
        currentOffset += storeBuf.length;
    }

    const fileListOffset = currentOffset;

    // Build raw file list (272 bytes per entry)
    const ENTRY_SIZE = 272;
    const fileListRaw = Buffer.alloc(entryMeta.length * ENTRY_SIZE);
    for (let i = 0; i < entryMeta.length; i++) {
        const base = i * ENTRY_SIZE;
        const nameBytes = Buffer.from(entryMeta[i].name, 'utf8');
        nameBytes.copy(fileListRaw, base, 0, Math.min(255, nameBytes.length));
        fileListRaw.writeUInt32LE(entryMeta[i].offset >>> 0, base + 256);
        fileListRaw.writeUInt16LE(Math.floor(entryMeta[i].offset / 0x100000000) & 0xFFFF, base + 260);
        fileListRaw[base + 262] = entryMeta[i].archivePart;
        fileListRaw[base + 263] = entryMeta[i].flags;
        fileListRaw.writeUInt32LE(entryMeta[i].sizeOnDisk, base + 264);
        // BG3 expects uncompSize=0 when flags=0 (uncompressed)
        fileListRaw.writeUInt32LE(entryMeta[i].flags === 0 ? 0 : entryMeta[i].uncompSize, base + 268);
    }

    // LZ4 block compress the file list (matching BG3 native format)
    const compressedList = lz4CompressBlock(fileListRaw);

    // Build file list blob: uint32 numFiles + uint32 compressedSize + LZ4 data
    const fileListBlob = Buffer.alloc(8 + compressedList.length);
    fileListBlob.writeUInt32LE(entryMeta.length, 0);
    fileListBlob.writeUInt32LE(compressedList.length, 4);
    compressedList.copy(fileListBlob, 8);

    // Build header (32 bytes at offset 8)
    const hdr = Buffer.alloc(32);
    hdr.writeUInt32LE(fileListOffset >>> 0, 0);                        // offset low
    hdr.writeUInt32LE(Math.floor(fileListOffset / 0x100000000), 4);    // offset high
    hdr.writeUInt32LE(fileListBlob.length, 8);                         // list size
    hdr[12] = pakInfo.flags || 0;
    hdr[13] = pakInfo.priority || 0;
    if (pakInfo.md5) {
        const md5Buf = Buffer.isBuffer(pakInfo.md5) ? pakInfo.md5 : Buffer.from(pakInfo.md5);
        md5Buf.copy(hdr, 14, 0, Math.min(16, md5Buf.length));
    }
    hdr.writeUInt16LE(pakInfo.numParts || 1, 30);

    // Write to a temp file first, then rename atomically (avoids partial overwrites
    // and file-lock issues on Windows when the target is already open by another process)
    const tmpPath = outputPath + '.tmp';
    await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmpPath);
        ws.on('error', reject);

        // 1) Signature: "LSPK" + version 18
        const sig = Buffer.alloc(8);
        sig.write('LSPK', 0, 'ascii');
        sig.writeUInt32LE(18, 4);
        ws.write(sig);

        // 2) Header (32 bytes)
        ws.write(hdr);

        // 3) File data
        for (const buf of entryBuffers) ws.write(buf);

        // 4) File list blob
        ws.write(fileListBlob);

        ws.end(() => resolve());
    });
    // Atomic rename: replace outputPath with the freshly-written temp file
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    fs.renameSync(tmpPath, outputPath);
}

/* ================================================================
   CLOSE HANDLE
   ================================================================ */
async function closeLSPK(lspk) {
    if (lspk && lspk.handle) await lspk.handle.close();
}

/* ================================================================
   LOCA READER  — BG3 binary localization format
   Format: 'LOCA' + u32 numEntries + u32 textBlockOffset
           + entries (70 bytes each: 64b uid + u16 version + u32 strLen)
           + text blob (UTF-8)
   ================================================================ */
function parseLoca(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'LOCA') {
        throw new Error('Not a valid LOCA file');
    }

    const numEntries = buf.readUInt32LE(4);
    const textBlockOffset = buf.readUInt32LE(8);
    const ENTRY_SIZE = 70;
    const HEADER = 12;

    const entries = [];
    let textOff = textBlockOffset;

    for (let i = 0; i < numEntries; i++) {
        const base = HEADER + i * ENTRY_SIZE;
        // Read uid (null-terminated within 64 bytes)
        let uidEnd = base;
        while (uidEnd < base + 64 && buf[uidEnd] !== 0) uidEnd++;
        const uid = buf.toString('utf8', base, uidEnd);
        const version = buf.readUInt16LE(base + 64);
        const strLen = buf.readUInt32LE(base + 66);

        const text = buf.toString('utf8', textOff, textOff + strLen);
        textOff += strLen;

        entries.push({ uid, version, text });
    }

    return entries;
}

/* ================================================================
   LOCA WRITER  — rebuild LOCA binary from entries
   ================================================================ */
function buildLoca(entries) {
    const HEADER = 12;
    const ENTRY_SIZE = 70;

    // Build text blob
    const textBuffers = entries.map(e => Buffer.from(e.text, 'utf8'));
    const textBlob = Buffer.concat(textBuffers);
    const textBlockOffset = HEADER + entries.length * ENTRY_SIZE;

    const totalSize = textBlockOffset + textBlob.length;
    const out = Buffer.alloc(totalSize);

    // Header
    out.write('LOCA', 0, 'ascii');
    out.writeUInt32LE(entries.length, 4);
    out.writeUInt32LE(textBlockOffset, 8);

    // Entries
    let textOff = 0;
    for (let i = 0; i < entries.length; i++) {
        const base = HEADER + i * ENTRY_SIZE;
        // Write uid (null-padded to 64 bytes)
        const uidBuf = Buffer.from(entries[i].uid, 'utf8');
        uidBuf.copy(out, base, 0, Math.min(63, uidBuf.length));
        out.writeUInt16LE(entries[i].version, base + 64);
        out.writeUInt32LE(textBuffers[i].length, base + 66);
        textOff += textBuffers[i].length;
    }

    // Text blob
    textBlob.copy(out, textBlockOffset);

    return out;
}

module.exports = { readLSPK, readEntryData, writeLSPK, closeLSPK, parseLoca, buildLoca, lz4DecompressBlock, lz4CompressBlock };
