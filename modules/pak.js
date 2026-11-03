'use strict';
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { readLSPK, readEntryData, closeLSPK, parseLoca } = require('../lspk');
const { verifyPak } = require('../verify-pak');
const {
    loadConfig, getBg3ModsFolder, bg3ModsFolderError, bg3ModsFolderMeta, safePakName, getCachedPakMeta, pakHasTargetLanguage,
    readPakMeta, readPakUIDs, loadLinks, version64ToStr,
    BG3_LANG_FOLDERS, BG3_KNOWN_LOCA_FOLDERS,
} = require('./shared');

module.exports = function register(app) {

/* ================================================================
   LIST .pak FILES  — in the configured mods folder
   ================================================================ */
/* ================================================================
   DASHBOARD  — high-level overview of paks and translations
   ================================================================ */
app.get('/api/dashboard', async (req, res) => {
    const cfg = loadConfig();
    const modsFolder = getBg3ModsFolder();
    if (!modsFolder) return res.json({ paks: 0, translations: 0, size: 0, sizeStr: '0 KB' });

    try {
        const files = await fsp.readdir(modsFolder);
        const paks = files.filter(f => f.toLowerCase().endsWith('.pak'));
        const links = loadLinks();
        const translationFiles = new Set(links.map(l => l.translationPak));

        let totalSize = 0;
        for (const f of paks) {
            try { totalSize += (await fsp.stat(path.join(modsFolder, f))).size; } catch {}
        }

        res.json({
            paks: paks.length,
            translations: translationFiles.size,
            size: totalSize,
            sizeStr: totalSize > 1024 * 1024
                ? (totalSize / 1024 / 1024).toFixed(1) + ' MB'
                : (totalSize / 1024).toFixed(1) + ' KB',
        });
    } catch (e) {
        res.json({ paks: 0, translations: 0, size: 0, sizeStr: '0 KB', error: e.message });
    }
});

/* ================================================================
   LIST .pak FILES  — in the configured mods folder
   ================================================================ */
app.get('/api/paks', async (req, res) => {
    const cfg = loadConfig();
    const modsFolder = getBg3ModsFolder();
    if (!modsFolder) {
        return res.json({
            error: bg3ModsFolderError(cfg.modsFolder),
            missingFolder: true,
            ...bg3ModsFolderMeta(cfg.modsFolder),
            paks: [],
        });
    }

    try {
        const files = await fsp.readdir(modsFolder);
        const paks = [];
        for (const f of files) {
            if (!f.toLowerCase().endsWith('.pak')) continue;
            const full = path.join(modsFolder, f);
            const stat = await fsp.stat(full);
            const meta = await getCachedPakMeta(full, stat);

            paks.push({
                name: f,
                size: stat.size,
                sizeStr: stat.size > 1024 * 1024
                    ? (stat.size / 1024 / 1024).toFixed(1) + ' MB'
                    : (stat.size / 1024).toFixed(1) + ' KB',
                mtime: stat.mtime,
                translatableFiles: meta.translatableFiles,
                version: meta.version,
                modName: meta.modName,
            });
        }
        paks.sort((a, b) => a.name.localeCompare(b.name));
        res.json({ paks });
    } catch (e) {
        res.json({ error: e.message, paks: [] });
    }
});

/* ================================================================
   API: Check if pak already has target language
   ================================================================ */
app.get('/api/pak/:name/has-language', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.modsFolder) return res.status(400).json({ error: 'Dossier Mods non configuré' });
    let pakName;
    try { pakName = safePakName(req.params.name); } catch (e) { return res.status(400).json({ error: e.message }); }
    const pakPath = path.join(cfg.modsFolder, pakName);
    const lang = req.query.lang || 'fr';
    const result = await pakHasTargetLanguage(pakPath, lang);
    res.json(result);
});

/* ================================================================
   SCAN .pak  — analyse translation status of a single pak
   ================================================================ */
app.get('/api/pak/:name/scan', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.modsFolder) return res.status(400).json({ error: 'Dossier Mods non configuré' });
    let pakName;
    try { pakName = safePakName(req.params.name); } catch (e) { return res.status(400).json({ error: e.message }); }
    const pakPath = path.join(cfg.modsFolder, pakName);

    let lspk;
    try {
        lspk = await readLSPK(pakPath);
        const info = {
            name: req.params.name,
            totalEntries: lspk.entries.length,
            modName: path.basename(req.params.name, '.pak'),
            modUUID: null,
            modFolder: null,
            languages: {},       // { French: { files, totalStrings, translatedStrings } }
            locaFiles: [],
            xmlFiles: [],
            hasExistingTranslation: false,
        };

        // Find meta.lsx for mod info
        for (const entry of lspk.entries) {
            if (entry.name.toLowerCase().endsWith('meta.lsx')) {
                const data = await readEntryData(lspk.handle, entry);
                const fullTxt = data.toString('utf8');
                // Search from ModuleInfo section to avoid picking up Dependencies values
                const miIdx = fullTxt.indexOf('id="ModuleInfo"');
                const txt = miIdx >= 0 ? fullTxt.slice(miIdx) : fullTxt;
                const nameMatch = txt.match(/id="Name"[^>]*value="([^"]*)"/);
                const uuidMatch = txt.match(/id="UUID"[^>]*value="([^"]*)"/);
                const folderMatch = txt.match(/id="Folder"[^>]*value="([^"]*)"/);
                if (nameMatch) info.modName = nameMatch[1];
                if (uuidMatch) info.modUUID = uuidMatch[1];
                if (folderMatch) info.modFolder = folderMatch[1];
            }
        }

        // Categorize entries by language and type
        for (const entry of lspk.entries) {
            const lower = entry.name.toLowerCase();
            const parts = entry.name.split('/');

            // Detect language from path
            let detectedLang = null;
            for (let i = 0; i < parts.length - 1; i++) {
                if (parts[i].toLowerCase() === 'localization' && i + 1 < parts.length) {
                    const folder = parts[i + 1].toLowerCase();
                    if (BG3_KNOWN_LOCA_FOLDERS.has(folder)) {
                        // Find the language name by folder name
                        for (const [code, folderName] of Object.entries(BG3_LANG_FOLDERS)) {
                            if (folderName.toLowerCase() === folder) {
                                detectedLang = folderName;
                                break;
                            }
                        }
                        if (!detectedLang) detectedLang = parts[i + 1]; // use as-is
                    }
                }
            }

            if (lower.endsWith('.loca') || lower.endsWith('.xml')) {
                const fileInfo = { name: entry.name, lang: detectedLang, type: lower.endsWith('.loca') ? 'loca' : 'xml' };

                // Try to count strings
                try {
                    const data = await readEntryData(lspk.handle, entry);
                    if (lower.endsWith('.loca')) {
                        const locaEntries = parseLoca(data);
                        fileInfo.totalStrings = locaEntries.length;
                        fileInfo.nonEmptyStrings = locaEntries.filter(e => e.text && e.text.trim()).length;
                        info.locaFiles.push(fileInfo);
                    } else if (lower.endsWith('.xml')) {
                        const txt = data.toString('utf8');
                        const contentMatches = txt.match(/<content\s/g);
                        fileInfo.totalStrings = contentMatches ? contentMatches.length : 0;
                        info.xmlFiles.push(fileInfo);
                    }
                } catch {
                    if (lower.endsWith('.loca')) info.locaFiles.push(fileInfo);
                    else info.xmlFiles.push(fileInfo);
                }

                // Group by language
                if (detectedLang) {
                    if (!info.languages[detectedLang]) {
                        info.languages[detectedLang] = { files: 0, totalStrings: 0 };
                    }
                    info.languages[detectedLang].files++;
                    info.languages[detectedLang].totalStrings += fileInfo.totalStrings || 0;
                }
            }
        }

        info.hasExistingTranslation = Object.keys(info.languages).length > 1;
        res.json(info);
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        if (lspk) try { await closeLSPK(lspk); } catch (_) { /* ignore close errors */ }
    }
});

/* ================================================================
   SCAN MODS FOLDER  — detect existing translation paks for a mod
   ================================================================ */
app.get('/api/pak/:name/translations', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.modsFolder) return res.status(400).json({ error: 'Dossier Mods non configuré' });
    let pakName;
    try { pakName = safePakName(req.params.name); } catch (e) { return res.status(400).json({ error: e.message }); }
    const origName = pakName.replace(/\.pak$/i, '');
    const tgtLang = req.query.lang || 'fr';

    try {
        const files = await fsp.readdir(cfg.modsFolder);
        const translations = [];

        for (const f of files) {
            if (!f.toLowerCase().endsWith('.pak')) continue;
            // Check if this is a translation pak for the original mod
            const base = f.replace(/\.pak$/i, '');
            if (base === origName) continue; // skip the original itself

            // Heuristic: name contains original mod name + language suffix
            // Normalize by stripping separators (underscores, hyphens, spaces) for fuzzy match
            const normalize = s => s.toLowerCase().replace(/[_\-\s()]/g, '');
            const normBase = normalize(base);
            const normOrig = normalize(origName);
            const hasLangSuffix = base.toLowerCase().includes('_fr') || base.toLowerCase().includes('french')
                    || base.toLowerCase().includes('_' + tgtLang)
                    || normBase.includes('fr') && normBase.startsWith(normOrig.slice(0, Math.min(4, normOrig.length)));
            const isTranslationPak = (normBase.includes(normOrig) || normOrig.includes(normBase.replace(/fr\d*$/, '')))
                && hasLangSuffix;

            if (!isTranslationPak) continue;

            try {
                const pakPath = path.join(cfg.modsFolder, f);
                const lspk = await readLSPK(pakPath);
                const tInfo = { name: f, files: [], totalStrings: 0 };

                for (const entry of lspk.entries) {
                    const lower = entry.name.toLowerCase();
                    if (lower.endsWith('.loca') || lower.endsWith('.xml')) {
                        try {
                            const data = await readEntryData(lspk.handle, entry);
                            if (lower.endsWith('.loca')) {
                                const locaEntries = parseLoca(data);
                                tInfo.files.push({ name: entry.name, strings: locaEntries.length });
                                tInfo.totalStrings += locaEntries.length;
                            } else if (lower.endsWith('.xml')) {
                                const txt = data.toString('utf8');
                                const matches = txt.match(/<content\s/g);
                                const count = matches ? matches.length : 0;
                                tInfo.files.push({ name: entry.name, strings: count });
                                tInfo.totalStrings += count;
                            }
                        } catch { /* skip unreadable */ }
                    }
                }
                await closeLSPK(lspk);
                translations.push(tInfo);
            } catch { /* skip unparseable paks */ }
        }

        res.json({ translations });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ================================================================
   COMPARE PAKS  — find missing translations between original and translation pak
   ================================================================ */
app.post('/api/pak/compare', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.modsFolder) return res.status(400).json({ error: 'Dossier Mods non configuré' });
    const { original, translationPak } = req.body;

    let origLspk, transLspk;
    try {
        const origPath = path.join(cfg.modsFolder, safePakName(original));
        const transPath = path.join(cfg.modsFolder, safePakName(translationPak));

        // Read all UIDs from original
        const origUIDs = new Map(); // uid -> text
        origLspk = await readLSPK(origPath);
        for (const entry of origLspk.entries) {
            const lower = entry.name.toLowerCase();
            if (!lower.endsWith('.loca') && !lower.endsWith('.xml')) continue;
            try {
                const data = await readEntryData(origLspk.handle, entry);
                if (lower.endsWith('.loca')) {
                    for (const e of parseLoca(data)) {
                        if (e.uid && e.text && e.text.trim()) origUIDs.set(e.uid, e.text);
                    }
                } else {
                    const txt = data.toString('utf8');
                    const re = /contentuid="([^"]+)"[^>]*>([^<]*)</g;
                    let m;
                    while ((m = re.exec(txt))) {
                        if (m[2].trim()) origUIDs.set(m[1], m[2]);
                    }
                }
            } catch { /* skip */ }
        }
        await closeLSPK(origLspk);
        origLspk = null;

        // Read all UIDs from translation
        const transUIDs = new Map();
        transLspk = await readLSPK(transPath);
        for (const entry of transLspk.entries) {
            const lower = entry.name.toLowerCase();
            if (!lower.endsWith('.loca') && !lower.endsWith('.xml')) continue;
            try {
                const data = await readEntryData(transLspk.handle, entry);
                if (lower.endsWith('.loca')) {
                    for (const e of parseLoca(data)) {
                        if (e.uid && e.text && e.text.trim()) transUIDs.set(e.uid, e.text);
                    }
                } else {
                    const txt = data.toString('utf8');
                    const re = /contentuid="([^"]+)"[^>]*>([^<]*)</g;
                    let m;
                    while ((m = re.exec(txt))) {
                        if (m[2].trim()) transUIDs.set(m[1], m[2]);
                    }
                }
            } catch { /* skip */ }
        }
        await closeLSPK(transLspk);
        transLspk = null;

        // Compare
        const missing = [];
        const existing = [];
        for (const [uid, origText] of origUIDs) {
            if (transUIDs.has(uid)) {
                existing.push({ uid, original: origText, translated: transUIDs.get(uid) });
            } else {
                missing.push({ uid, original: origText });
            }
        }

        res.json({
            originalCount: origUIDs.size,
            translatedCount: transUIDs.size,
            missingCount: missing.length,
            existingCount: existing.length,
            completionPct: origUIDs.size > 0 ? Math.round(existing.length / origUIDs.size * 100) : 100,
            missing: missing.slice(0, 200), // limit to avoid huge response
            existing: existing.slice(0, 50), // sample
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        if (origLspk) try { await closeLSPK(origLspk); } catch (_) {}
        if (transLspk) try { await closeLSPK(transLspk); } catch (_) {}
    }
});

/* ================================================================
   DOWNLOAD .pak  — let users download a pak file from the Mods folder
   ================================================================ */
app.get('/api/pak/:name/download', (req, res) => {
    const cfg = loadConfig();
    if (!cfg.modsFolder) return res.status(400).json({ error: 'Dossier Mods non configuré' });
    let pakName;
    try { pakName = safePakName(req.params.name); } catch (e) { return res.status(400).json({ error: e.message }); }
    const pakPath = path.join(cfg.modsFolder, pakName);
    if (!fs.existsSync(pakPath)) return res.status(404).json({ error: 'Fichier introuvable' });
    res.download(pakPath, pakName);
});

/* ================================================================
   IMPORT .pak  — upload a pak file into the Mods folder
   ================================================================ */
app.post('/api/pak/import', express.raw({ type: 'application/octet-stream', limit: '500mb' }), async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.modsFolder) return res.status(400).json({ error: 'Dossier Mods non configuré' });

    const fileName = req.headers['x-filename'];
    if (!fileName) return res.status(400).json({ error: 'Nom de fichier manquant (header X-Filename)' });

    let pakName;
    try { pakName = safePakName(fileName); } catch (e) { return res.status(400).json({ error: e.message }); }

    const pakPath = path.join(cfg.modsFolder, pakName);
    const existed = fs.existsSync(pakPath);

    try {
        await fsp.writeFile(pakPath, req.body);

        // Try to read meta for info
        let meta = {};
        try { meta = await readPakMeta(pakPath); } catch { /* ok */ }

        res.json({
            ok: true,
            fileName: pakName,
            replaced: existed,
            modName: meta.modName || pakName.replace(/\.pak$/i, ''),
            size: req.body.length,
        });
    } catch (e) {
        res.status(500).json({ error: `Erreur d'écriture: ${e.message}` });
    }
});

/* ================================================================
   SHARE INFO  — get pak metadata for sharing
   ================================================================ */
app.get('/api/pak/:name/share-info', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.modsFolder) return res.status(400).json({ error: 'Dossier Mods non configuré' });
    let pakName;
    try { pakName = safePakName(req.params.name); } catch (e) { return res.status(400).json({ error: e.message }); }
    const pakPath = path.join(cfg.modsFolder, pakName);
    if (!fs.existsSync(pakPath)) return res.status(404).json({ error: 'Fichier introuvable' });

    try {
        const stat = await fsp.stat(pakPath);
        const meta = await readPakMeta(pakPath);
        const uids = await readPakUIDs(pakPath);

        // Find linked original
        const links = loadLinks();
        const link = links.find(l => l.translationPak === pakName || l.originalPak === pakName);

        res.json({
            fileName: pakName,
            modName: meta.modName || pakName.replace(/\.pak$/i, ''),
            folder: meta.folder,
            uuid: meta.uuid,
            version: meta.version64 ? version64ToStr(meta.version64) : null,
            size: stat.size,
            sizeStr: stat.size > 1024 * 1024
                ? (stat.size / 1024 / 1024).toFixed(1) + ' MB'
                : (stat.size / 1024).toFixed(1) + ' KB',
            totalStrings: uids.size,
            linkedTo: link ? (link.translationPak === pakName ? link.originalPak : link.translationPak) : null,
            originalMod: link ? link.originalModName : null,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ================================================================
   LIST TRANSLATION PAKS  — all paks that look like translations
   ================================================================ */
app.get('/api/paks/translations', async (req, res) => {
    const modsFolder = getBg3ModsFolder();
    if (!modsFolder) return res.json({ paks: [] });

    try {
        const files = await fsp.readdir(modsFolder);
        const links = loadLinks();
        const results = [];

        for (const f of files) {
            if (!f.toLowerCase().endsWith('.pak')) continue;
            const full = path.join(modsFolder, f);

            // Check if it's a translation (linked or has _fr/_de/etc in name)
            const link = links.find(l => l.translationPak === f);
            const langSuffixMatch = f.match(/_([a-z]{2}(?:-[A-Z]{2})?)\.pak$/i);
            const isTranslation = !!link || !!langSuffixMatch;
            if (!isTranslation) continue;

            try {
                const stat = await fsp.stat(full);
                let meta = {};
                try { meta = await readPakMeta(full); } catch { /* ok */ }

                results.push({
                    name: f,
                    modName: meta.modName || f.replace(/\.pak$/i, ''),
                    version: meta.version64 ? version64ToStr(meta.version64) : null,
                    size: stat.size,
                    sizeStr: stat.size > 1024 * 1024
                        ? (stat.size / 1024 / 1024).toFixed(1) + ' MB'
                        : (stat.size / 1024).toFixed(1) + ' KB',
                    originalMod: link ? link.originalModName : null,
                    linkedTo: link ? link.originalPak : null,
                    lang: link ? link.lang : (langSuffixMatch ? langSuffixMatch[1] : null),
                });
            } catch { /* skip */ }
        }

        results.sort((a, b) => a.name.localeCompare(b.name));
        res.json({ paks: results });
    } catch (e) {
        res.json({ paks: [], error: e.message });
    }
});

/* ================================================================
   SEARCH — Recherche globale dans tous les .pak liés
   Cache d'index en mémoire, limite 100 résultats
   ================================================================ */
const searchIndexCache = new Map(); // pakName -> { entries, mtimeMs, size }
const SEARCH_MAX_RESULTS = 100;

async function buildSearchIndex(pakPath, pakName, stat) {
    const cached = searchIndexCache.get(pakName);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.entries;
    }
    const entries = [];
    let lspk;
    try {
        lspk = await readLSPK(pakPath);
        for (const entry of lspk.entries) {
            const lower = entry.name.toLowerCase();
            if (!lower.endsWith('.loca')) continue;
            try {
                const data = await readEntryData(lspk.handle, entry);
                const locaEntries = parseLoca(data);
                for (const le of locaEntries) {
                    if (!le.text || !le.text.trim()) continue;
                    entries.push({
                        uid: le.uid || '',
                        text: le.text,
                        locaFile: entry.name,
                        pakName,
                    });
                }
            } catch {}
        }
    } catch {}
    finally { if (lspk) try { await closeLSPK(lspk); } catch {} }
    searchIndexCache.set(pakName, { entries, mtimeMs: stat.mtimeMs, size: stat.size });
    return entries;
}

app.post('/api/search', async (req, res) => {
    const { query, lang } = req.body || {};
    if (!query || typeof query !== 'string' || query.trim().length < 2) {
        return res.status(400).json({ error: 'Requête trop courte (min 2 caractères)' });
    }
    const q = query.toLowerCase().trim();
    const modsFolder = getBg3ModsFolder();
    if (!modsFolder) return res.json({ results: [], total: 0 });

    try {
        const files = await fsp.readdir(modsFolder);
        const links = loadLinks();
        const results = [];

        for (const f of files) {
            if (results.length >= SEARCH_MAX_RESULTS) break;
            if (!f.toLowerCase().endsWith('.pak')) continue;

            // Only search in translation paks (linked or lang suffix)
            const link = links.find(l => l.translationPak === f);
            const langSuffixMatch = f.match(/_([a-z]{2}(?:-[A-Z]{2})?)\.pak$/i);
            if (!link && !langSuffixMatch) continue;

            const full = path.join(modsFolder, f);
            try {
                const stat = await fsp.stat(full);
                const index = await buildSearchIndex(full, f, stat);
                for (const entry of index) {
                    if (results.length >= SEARCH_MAX_RESULTS) break;
                    if (entry.text.toLowerCase().includes(q)) {
                        // Extrait autour du match
                        const idx = entry.text.toLowerCase().indexOf(q);
                        const start = Math.max(0, idx - 40);
                        const end = Math.min(entry.text.length, idx + q.length + 40);
                        const excerpt = (start > 0 ? '…' : '') + entry.text.slice(start, end) + (end < entry.text.length ? '…' : '');
                        results.push({
                            pakName: entry.pakName,
                            locaFile: entry.locaFile,
                            uid: entry.uid,
                            excerpt,
                            modName: link ? link.originalModName : null,
                        });
                    }
                }
            } catch {}
        }

        res.json({ results, total: results.length, truncated: results.length >= SEARCH_MAX_RESULTS });
    } catch (e) {
        res.json({ results: [], total: 0, error: e.message });
    }
});

/* ================================================================
   VERIFY .pak  — structural and content integrity check
   ================================================================ */
app.get('/api/pak/:name/verify', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.modsFolder) return res.status(400).json({ error: 'Dossier Mods non configuré' });
    let pakName;
    try { pakName = safePakName(req.params.name); } catch (e) { return res.status(400).json({ error: e.message }); }
    const pakPath = path.join(cfg.modsFolder, pakName);
    if (!fs.existsSync(pakPath)) return res.status(404).json({ error: 'Fichier introuvable' });

    try {
        const result = await verifyPak(pakPath, { silent: true });
        res.json(result);
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

}; // end register
