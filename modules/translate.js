'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { readLSPK, readEntryData, writeLSPK, closeLSPK, parseLoca } = require('../lspk');
const { createTranslator, getTranslationCache, normalizeKey } = require('../translator');
const {
    loadConfig, safePakName, readPakMeta, readPakUIDs, pakHasTargetLanguage,
    version64ToStr, BG3_LANG_FOLDERS, translationState, loadApicle,
} = require('./shared');
const { mapLimit } = require('./utils/map-limit');
const { openSse } = require('./utils/sse');

const AUDIT_PARALLEL = 4;
const AUDIT_COMPARE_PARALLEL = 3;

module.exports = function register(app) {

/* ================================================================
   AUDIT — check all translations: version, completeness, missing IDs
   ================================================================ */

app.get('/api/mods/audit', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.modsFolder) return res.status(400).json({ error: 'Dossier Mods non configuré' });

    const lang = req.query.lang || 'fr';
    const tgtLangName = BG3_LANG_FOLDERS[lang] || 'French';

    const send = openSse(res, { typed: true });

    try {
        const files = (await fsp.readdir(cfg.modsFolder)).filter(f => f.toLowerCase().endsWith('.pak'));
        send('progress', { text: `${files.length} fichiers .pak trouvés...`, pct: 5 });

        // Phase 1: Read meta.lsx from each pak (parallel)
        let metaProgress = 0;
        const pakMetaResults = await mapLimit(files, AUDIT_PARALLEL, async (f) => {
            try {
                const meta = await readPakMeta(path.join(cfg.modsFolder, f));
                meta.fileName = f;
                metaProgress++;
                if (metaProgress % 5 === 0 || metaProgress === files.length) {
                    send('progress', {
                        text: `Lecture méta ${metaProgress}/${files.length}...`,
                        pct: 5 + Math.round((metaProgress / files.length) * 30),
                    });
                }
                return meta;
            } catch {
                return null;
            }
        });
        const pakMetas = pakMetaResults.filter(Boolean);

        send('progress', { text: 'Recherche des paires original ↔ traduction...', pct: 40 });

        // Phase 2: Match translations to originals
        // Skip generic folder names that many mods share
        const genericFolders = new Set(['gustavdev', 'gustav', 'shared', 'public', 'game', 'gustavx', 'expansion']);
        const pairs = [];
        const matchedTrans = new Set();
        const matchedOrig = new Set();

        // Rule 1: folder = "X French" → original folder = "X" (skip if generic)
        for (const trans of pakMetas) {
            if (!trans.folder || matchedTrans.has(trans.fileName)) continue;
            const suffix = ' ' + tgtLangName;
            if (trans.folder.endsWith(suffix)) {
                const origFolder = trans.folder.slice(0, -suffix.length);
                if (genericFolders.has(origFolder.toLowerCase())) continue;
                const orig = pakMetas.find(p => p.folder === origFolder && !matchedOrig.has(p.fileName));
                if (orig) {
                    pairs.push({ original: orig, translation: trans });
                    matchedOrig.add(orig.fileName);
                    matchedTrans.add(trans.fileName);
                }
            }
        }

        // Rule 2: folder = "X FR" → original folder = "X" (skip if generic)
        for (const trans of pakMetas) {
            if (!trans.folder || matchedTrans.has(trans.fileName)) continue;
            if (trans.folder.endsWith(' FR')) {
                const origFolder = trans.folder.slice(0, -3);
                if (genericFolders.has(origFolder.toLowerCase())) continue;
                const orig = pakMetas.find(p => p.folder === origFolder && !matchedOrig.has(p.fileName));
                if (orig) {
                    pairs.push({ original: orig, translation: trans });
                    matchedOrig.add(orig.fileName);
                    matchedTrans.add(trans.fileName);
                }
            }
        }

        // Rule 3: pak filename "X_fr.pak" → "X.pak"
        for (const trans of pakMetas) {
            if (matchedTrans.has(trans.fileName)) continue;
            const base = trans.fileName.replace(/\.pak$/i, '');
            if (base.toLowerCase().endsWith('_' + lang)) {
                const origName = base.slice(0, -(lang.length + 1)) + '.pak';
                const orig = pakMetas.find(p => p.fileName.toLowerCase() === origName.toLowerCase() && !matchedOrig.has(p.fileName));
                if (orig) {
                    pairs.push({ original: orig, translation: trans });
                    matchedOrig.add(orig.fileName);
                    matchedTrans.add(trans.fileName);
                }
            }
        }

        // Rule 4: description "Traduction du mod X" → find original by folder
        for (const trans of pakMetas) {
            if (matchedTrans.has(trans.fileName)) continue;
            if (!trans.description) continue;
            const m = trans.description.match(/^Traduction du mod (.+)$/i);
            if (m) {
                const origFolder = m[1];
                const orig = pakMetas.find(p => p.folder === origFolder && !matchedOrig.has(p.fileName));
                if (orig) {
                    pairs.push({ original: orig, translation: trans });
                    matchedOrig.add(orig.fileName);
                    matchedTrans.add(trans.fileName);
                }
            }
        }

        // Rule 5: UID overlap for unmatched paks with _fr in folder/name
        const unmatchedCandidates = pakMetas.filter(p =>
            !matchedTrans.has(p.fileName) && !matchedOrig.has(p.fileName) &&
            !genericFolders.has((p.folder || '').toLowerCase()) &&
            (
                (p.folder && p.folder.toLowerCase().endsWith('_fr')) ||
                p.fileName.toLowerCase().match(/_fr[\._]/i)
            )
        );

        if (unmatchedCandidates.length > 0) {
            send('progress', { text: `Comparaison UIDs pour ${unmatchedCandidates.length} traductions non appariées...`, pct: 50 });
            const unmatchedOriginals = pakMetas.filter(p =>
                !matchedOrig.has(p.fileName) && !matchedTrans.has(p.fileName) &&
                !unmatchedCandidates.includes(p) && !genericFolders.has((p.folder || '').toLowerCase())
            );

            // Cache UIDs
            const uidCache = new Map();
            const getUIDs = async (fileName) => {
                if (!uidCache.has(fileName)) {
                    uidCache.set(fileName, await readPakUIDs(path.join(cfg.modsFolder, fileName)));
                }
                return uidCache.get(fileName);
            };

            for (const candidate of unmatchedCandidates) {
                const candUIDs = await getUIDs(candidate.fileName);
                if (candUIDs.size === 0) continue;

                let bestMatch = null;
                let bestOverlap = 0;

                for (const orig of unmatchedOriginals) {
                    if (matchedOrig.has(orig.fileName)) continue;
                    const origUIDs = await getUIDs(orig.fileName);
                    if (origUIDs.size === 0) continue;

                    let overlap = 0;
                    for (const uid of candUIDs.keys()) {
                        if (origUIDs.has(uid)) overlap++;
                    }

                    if (overlap > bestOverlap && overlap >= candUIDs.size * 0.5) {
                        bestOverlap = overlap;
                        bestMatch = orig;
                    }
                }

                if (bestMatch) {
                    pairs.push({ original: bestMatch, translation: candidate });
                    matchedOrig.add(bestMatch.fileName);
                    matchedTrans.add(candidate.fileName);
                }
            }
        }

        send('progress', { text: `${pairs.length} paires trouvées. Comparaison des contenus...`, pct: 60 });

        // Phase 3: Compare UIDs and versions (parallel, cached UIDs)
        let compareProgress = 0;
        const results = await mapLimit(pairs, AUDIT_COMPARE_PARALLEL, async (pair) => {
            const origUIDs = await readPakUIDs(path.join(cfg.modsFolder, pair.original.fileName));
            const transUIDs = await readPakUIDs(path.join(cfg.modsFolder, pair.translation.fileName));

            let matchCount = 0;
            const missingList = [];
            for (const [uid, text] of origUIDs) {
                if (transUIDs.has(uid)) {
                    matchCount++;
                } else {
                    missingList.push({ uid, text: text.length > 100 ? text.slice(0, 100) + '...' : text });
                }
            }

            compareProgress++;
            send('progress', {
                text: `Analyse ${compareProgress}/${pairs.length}: ${pair.original.modName || pair.original.folder}...`,
                pct: 60 + Math.round((compareProgress / pairs.length) * 35),
            });

            const completionPct = origUIDs.size > 0 ? Math.round(matchCount / origUIDs.size * 100) : 100;

            return {
                original: {
                    fileName: pair.original.fileName,
                    folder: pair.original.folder,
                    modName: pair.original.modName,
                    version64: pair.original.version64,
                    versionStr: version64ToStr(pair.original.version64),
                    totalUIDs: origUIDs.size,
                },
                translation: {
                    fileName: pair.translation.fileName,
                    folder: pair.translation.folder,
                    modName: pair.translation.modName,
                    version64: pair.translation.version64,
                    versionStr: version64ToStr(pair.translation.version64),
                    totalUIDs: transUIDs.size,
                },
                matchCount,
                missingCount: missingList.length,
                completionPct,
                versionMatch: pair.original.version64 === pair.translation.version64,
                missing: missingList.slice(0, 50),
            };
        });

        // Sort: incomplete first, then by name
        results.sort((a, b) => {
            if (a.completionPct !== b.completionPct) return a.completionPct - b.completionPct;
            return (a.original.modName || '').localeCompare(b.original.modName || '');
        });

        send('progress', { text: 'Audit terminé !', pct: 100 });
        send('result', { pairs: results });
    } catch (e) {
        send('error', { text: e.message });
    }
    send('done', {});
    res.end();
});

/* ================================================================
   TRANSLATE  — runs main.js as child process with SSE streaming
   ================================================================ */

// API to check if a translation is running
app.get('/api/translate/status', (req, res) => {
    res.json({ busy: translationState.busy });
});

/* ── LIVE TRANSLATION API (for in-game mod client) ── */

// ── Live translations — shared singleton cache (minecraft/cache.json) ─────
const LIVE_CACHE_PATH = path.join(__dirname, '..', 'data', 'minecraft', 'cache.json');

function _liveCache() {
    return getTranslationCache(LIVE_CACHE_PATH);
}

// ── Ollama batch translator ───────────────────────────────────────────────
const OLLAMA_URL  = 'http://localhost:11434';
    const OLLAMA_BATCH = 20; // strings per request — smaller = more reliable JSON from Ollama

function _ollamaModel() {
    try {
        const cfg = loadApicle();
        return (cfg.ollama && cfg.ollama.model) ? cfg.ollama.model : 'qwen2.5:7b';
    } catch { return 'qwen2.5:7b'; }
}

async function _ollamaBatch(texts, src, tgt) {
    const LANG = { en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', ru: 'Russian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean' };
    const model = _ollamaModel();
    // Number each string so the model can't swap order
    const numbered = {};
    texts.forEach((t, i) => { numbered[i + 1] = t; });

    const prompt = `Translate these Minecraft game UI strings from ${LANG[src] || src} to ${LANG[tgt] || tgt}.
Return ONLY a JSON object with the same number keys mapped to translated strings. No explanations.
Preserve format specifiers (%s %d %f {name} {0}) exactly as-is.

${JSON.stringify(numbered)}`;

    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.1 } }),
        signal: AbortSignal.timeout(120000),
    });
    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
    const data = await resp.json();
    let raw = (data.response || '').trim()
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    // Attempt JSON repair if truncated (e.g. Ollama hit token limit mid-object)
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        // Try to salvage a partial object by closing it
        const repaired = raw.replace(/,\s*$/, '') + '}';
        try { parsed = JSON.parse(repaired); } catch { throw new Error('Ollama JSON parse failed'); }
    }
    return texts.map((orig, i) => {
        const v = parsed[i + 1] ?? parsed[String(i + 1)];
        return (typeof v === 'string' && v.length > 0) ? v : orig;
    });
}

// ── Google fallback (single-text, parallel) ───────────────────────────────
async function _googleTranslate(text) {
    return text;   // moteur Google retiré de l'édition publique (voir translator.js)
}

async function _googleBatch(texts, src, tgt, concurrency = 10) {
    const results = new Array(texts.length);
    for (let i = 0; i < texts.length; i += concurrency) {
        const chunk = texts.slice(i, i + concurrency);
        const translations = await Promise.all(
            chunk.map((t, j) => _googleTranslate(t, src, tgt).catch(() => texts[i + j]))
        );
        translations.forEach((tr, j) => { results[i + j] = tr; });
        if (i + concurrency < texts.length) await new Promise(r => setTimeout(r, 50));
    }
    return results;
}

app.get('/api/live/ping', (req, res) => {
    let version = '?';
    try { version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'version.json'), 'utf8')).version || version; } catch {}
    res.json({ ok: true, version, name: 'ModLingo-Hub', endpoints: ['/api/live/translate'] });
});

app.post('/api/live/translate', async (req, res) => {
    try {
        const body = req.body || {};
        const src = (body.srcLang || 'en').toLowerCase();
        const tgt = (body.tgtLang || 'fr').toLowerCase();

        let texts;
        if (Array.isArray(body.texts)) texts = body.texts;
        else if (typeof body.text === 'string') texts = [body.text];
        else return res.status(400).json({ error: 'texts:[] ou text:"..." requis' });

        texts = texts.filter(t => typeof t === 'string');
        if (texts.length === 0) return res.json({ translations: [], translation: undefined, srcLang: src, tgtLang: tgt });
        if (texts.length > 200) return res.status(400).json({ error: 'Max 200 textes par requête' });

        const translator = createTranslator({
            srcLang: src,
            tgtLang: tgt,
            cachePath: LIVE_CACHE_PATH,
            concurrency: 10,
            delayMs: 50,
            glossaryFile: 'minecraft/glossary.json',
            tagFile: 'minecraft/tag.json',
        });

        const uniqueTexts = [...new Set(texts)];
        const batchResults = await translator.translateBatch(uniqueTexts);
        translator.flush();

        const results = texts.map(t => batchResults.get(t) ?? t);

        res.json({
            translations: Array.isArray(body.texts) ? results : undefined,
            translation: Array.isArray(body.texts) ? undefined : results[0],
            srcLang: src,
            tgtLang: tgt,
        });
    } catch (e) {
        res.status(500).json({ error: 'Erreur de traduction live' });
    }
});

app.get('/api/translate/stream', async (req, res) => {
    const { pak, lang } = req.query;
    const cfg = loadConfig();
    if (!cfg.modsFolder || !pak) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ type: 'error', text: 'Configuration manquante: dossier Mods ou fichier pak non défini' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', code: 1 })}\n\n`);
        res.end();
        return;
    }

    let validPak;
    try { validPak = safePakName(pak); } catch (e) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'error', text: 'Nom de fichier invalide' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', code: 1 })}\n\n`);
        res.end();
        return;
    }
    const pakPath = path.join(cfg.modsFolder, validPak);
    if (!fs.existsSync(pakPath)) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ type: 'error', text: `Fichier introuvable: ${pakPath}` })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', code: 1 })}\n\n`);
        res.end();
        return;
    }

    const send = openSse(res, { typed: true });

    // Queue check: only one translation at a time to avoid IP ban
    if (translationState.busy) {
        send('error', { text: '⚠ Une traduction est déjà en cours ! Attendez qu\'elle se termine pour éviter un ban IP.' });
        send('done', { code: 1 });
        res.end();
        return;
    }
    translationState.busy = true;

    const langCode = lang || 'fr';
    const outputName = pak.replace(/\.pak$/i, `_${langCode}.pak`);
    const outputPath = path.join(cfg.modsFolder, outputName);

    // Check if pak already has the target language
    const langCheck = await pakHasTargetLanguage(pakPath, langCode);
    if (langCheck.hasTarget) {
        const langName = langCheck.langFolder || langCode;
        send('error', {
            text: `⚠ Ce mod contient déjà ${langCheck.fileCount} fichier(s) en ${langName} avec ${langCheck.stringCount} textes. Il est probablement déjà traduit en ${langName}.`
        });
        send('already_translated', {
            pak,
            lang: langCode,
            langName,
            fileCount: langCheck.fileCount,
            stringCount: langCheck.stringCount,
        });
        send('done', { code: 0, skipped: true });
        translationState.busy = false;
        res.end();
        return;
    }

    const args = [
        path.join(__dirname, '..', 'main.js'),
        pakPath,
        '--to', langCode,
        '--output', outputPath,
    ];

    send('start', { pak, lang: langCode, output: outputName });

    // Strip ANSI codes for clean log display
    const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '');

    // Regex to parse ETA markers: [ETA:XXs|YY] or [ETA:XmYs|ZZ]
    const etaRegex = /\[ETA:([^\]|]+)\|(\d+)\]/;
    const totalRegex = /\[TOTAL_STRINGS:(\d+)\]/;
    let totalStrings = 0;

    const sessionId = Date.now() + '-' + Math.random().toString(36).slice(2);
    const proc = spawn(process.execPath, args, { cwd: path.join(__dirname, '..') });
    translationState.activeProcesses.set(sessionId, proc);

    proc.stdout.on('data', (chunk) => {
        const lines = stripAnsi(chunk.toString()).split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Parse TOTAL_STRINGS marker
            const totalMatch = trimmed.match(totalRegex);
            if (totalMatch) {
                totalStrings = parseInt(totalMatch[1], 10);
                send('log', { text: trimmed });
                continue;
            }

            // Parse ETA marker and send as progress
            const etaMatch = trimmed.match(etaRegex);
            if (etaMatch) {
                const eta = etaMatch[1];
                const pct = parseInt(etaMatch[2], 10);
                send('progress', { pct, eta, totalStrings });
                // Don't send ETA-only lines as log (noisy)
                if (trimmed === `[ETA:${eta}|${pct}]`) continue;
            }

            send('log', { text: trimmed });
        }
    });

    proc.stderr.on('data', (chunk) => {
        const lines = stripAnsi(chunk.toString()).split('\n');
        for (const line of lines) {
            if (line.trim()) send('error', { text: line });
        }
    });

    proc.on('close', (code) => {
        send('done', { code, output: outputName, outputPath });
        translationState.activeProcesses.delete(sessionId);
        translationState.busy = false;
        res.end();
    });

    req.on('close', () => {
        const p = translationState.activeProcesses.get(sessionId);
        if (p) {
            p.kill();
            translationState.activeProcesses.delete(sessionId);
            translationState.busy = false;
        }
    });
});

/* ================================================================
   BATCH TRANSLATE  — translate multiple mods sequentially with
   global progress tracking and total time estimate via SSE
   ================================================================ */
app.post('/api/translate/batch', (req, res) => {
    // paks from JSON body (array or comma-separated string)
    const body = req.body || {};
    const lang = body.lang || 'fr';
    const cfg = loadConfig();

    const send = openSse(res, { typed: true });

    // Accept paks as array or comma-separated string (keep array to preserve commas in filenames)
    let pakNames;
    if (Array.isArray(body.paks)) {
        pakNames = body.paks.map(s => s.trim()).filter(Boolean);
    } else if (typeof body.paks === 'string' && body.paks) {
        pakNames = body.paks.split(',').map(s => s.trim()).filter(Boolean);
    } else {
        pakNames = [];
    }

    if (!cfg.modsFolder || pakNames.length === 0) {
        send('error', { text: 'Configuration manquante: dossier Mods ou fichiers pak non définis' });
        send('done', { code: 1 });
        res.end();
        return;
    }

    // Validate all pak names upfront
    const validPaks = [];
    for (const name of pakNames) {
        try {
            const safe = safePakName(name);
            const full = path.join(cfg.modsFolder, safe);
            if (!fs.existsSync(full)) {
                send('error', { text: `Fichier introuvable: ${safe}` });
                continue;
            }
            validPaks.push(safe);
        } catch (e) {
            send('error', { text: `Nom invalide "${name}": ${e.message}` });
        }
    }

    if (validPaks.length === 0) {
        send('error', { text: 'Aucun fichier pak valide trouvé' });
        send('done', { code: 1 });
        res.end();
        return;
    }

    // Queue check
    if (translationState.busy) {
        send('error', { text: '⚠ Une traduction est déjà en cours ! Attendez qu\'elle se termine.' });
        send('done', { code: 1 });
        res.end();
        return;
    }
    translationState.busy = true;

    send('batch_start', {
        totalMods: validPaks.length,
        paks: validPaks,
        lang,
    });

    const batchT0 = Date.now();
    let cancelled = false;
    let currentProc = null;
    const batchSessionId = Date.now() + '-batch-' + Math.random().toString(36).slice(2);
    const modResults = []; // { pak, success, elapsed, output }

    res.on('close', () => {
        cancelled = true;
        if (currentProc) {
            currentProc.kill();
        }
        translationState.activeProcesses.delete(batchSessionId);
        translationState.busy = false;
    });

    // Process mods sequentially (to respect API rate limits)
    (async () => {
        let skippedCount = 0;

        for (let i = 0; i < validPaks.length; i++) {
            if (cancelled) break;

            const pak = validPaks[i];
            const modIndex = i + 1;
            const outputName = pak.replace(/\.pak$/i, `_${lang}.pak`);
            const pakPath = path.join(cfg.modsFolder, pak);
            const outputPath = path.join(cfg.modsFolder, outputName);

            // Check if this pak already has the target language
            const langCheck = await pakHasTargetLanguage(pakPath, lang);
            if (langCheck.hasTarget) {
                const langName = langCheck.langFolder || lang;
                skippedCount++;
                send('mod_skipped', {
                    modIndex,
                    totalMods: validPaks.length,
                    pak,
                    langName,
                    fileCount: langCheck.fileCount,
                    stringCount: langCheck.stringCount,
                });
                send('log', { text: `\n⏩ [${modIndex}/${validPaks.length}] ${pak} — Déjà traduit en ${langName} (${langCheck.fileCount} fichier(s), ${langCheck.stringCount} textes). Ignoré.` });
                modResults.push({ pak, success: true, elapsed: '0.0', output: outputName, skipped: true });
                continue;
            }

            send('mod_start', {
                modIndex,
                totalMods: validPaks.length,
                pak,
                output: outputName,
            });
            send('log', { text: `\n═══ [${modIndex}/${validPaks.length}] ${pak} ═══` });

            const modT0 = Date.now();

            // Spawn main.js for this mod
            const args = [
                path.join(__dirname, '..', 'main.js'),
                pakPath,
                '--to', lang,
                '--output', outputPath,
            ];

            const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '');
            const etaRegex = /\[ETA:([^\]|]+)\|(\d+)\]/;
            const totalRegex = /\[TOTAL_STRINGS:(\d+)\]/;
            let modTotalStrings = 0;

            await new Promise((resolve) => {
                const proc = spawn(process.execPath, args, { cwd: path.join(__dirname, '..') });
                currentProc = proc;
                translationState.activeProcesses.set(batchSessionId, proc);

                proc.stdout.on('data', (chunk) => {
                    const lines = stripAnsi(chunk.toString()).split('\n');
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) continue;

                        const totalMatch = trimmed.match(totalRegex);
                        if (totalMatch) {
                            modTotalStrings = parseInt(totalMatch[1], 10);
                        }

                        const etaMatch = trimmed.match(etaRegex);
                        if (etaMatch) {
                            const eta = etaMatch[1];
                            const pct = parseInt(etaMatch[2], 10);
                            // Calculate batch-level progress
                            const batchPct = Math.round(((i + pct / 100) / validPaks.length) * 100);

                            // Estimate total batch time
                            const elapsedMs = Date.now() - batchT0;
                            const progressFraction = (i + pct / 100) / validPaks.length;
                            let batchEta = '';
                            if (progressFraction > 0.01) {
                                const totalEstMs = elapsedMs / progressFraction;
                                const remainMs = Math.max(0, totalEstMs - elapsedMs);
                                const remainSec = Math.round(remainMs / 1000);
                                batchEta = remainSec >= 60
                                    ? `${Math.floor(remainSec / 60)}m${remainSec % 60}s`
                                    : `${remainSec}s`;
                            }

                            send('progress', {
                                pct: batchPct,
                                eta: batchEta,
                                modIndex,
                                modPct: pct,
                                modEta: eta,
                                totalMods: validPaks.length,
                                totalStrings: modTotalStrings,
                            });
                            if (trimmed === `[ETA:${eta}|${pct}]`) continue;
                        }

                        send('log', { text: `  ${trimmed}` });
                    }
                });

                proc.stderr.on('data', (chunk) => {
                    for (const line of stripAnsi(chunk.toString()).split('\n')) {
                        if (line.trim()) send('error', { text: line });
                    }
                });

                proc.on('close', (code) => {
                    const modElapsed = ((Date.now() - modT0) / 1000).toFixed(1);
                    const success = code === 0;
                    modResults.push({ pak, success, elapsed: modElapsed, output: outputName });

                    send('mod_done', {
                        modIndex,
                        totalMods: validPaks.length,
                        pak,
                        output: outputName,
                        success,
                        elapsed: modElapsed,
                    });

                    if (success) {
                        send('log', { text: `  ✔ ${pak} terminé en ${modElapsed}s` });
                    } else {
                        send('log', { text: `  ✘ ${pak} échoué (code ${code})` });
                    }

                    currentProc = null;
                    resolve();
                });
            });
        }

        // All done — send batch summary
        const totalElapsed = ((Date.now() - batchT0) / 1000).toFixed(1);
        const succeeded = modResults.filter(r => r.success && !r.skipped).length;
        const failed = modResults.filter(r => !r.success).length;
        const skipped = modResults.filter(r => r.skipped).length;

        // Format total time nicely
        const totalSec = parseFloat(totalElapsed);
        let totalTimeStr;
        if (totalSec >= 3600) {
            const h = Math.floor(totalSec / 3600);
            const m = Math.floor((totalSec % 3600) / 60);
            const s = Math.round(totalSec % 60);
            totalTimeStr = `${h}h ${m}m ${s}s`;
        } else if (totalSec >= 60) {
            const m = Math.floor(totalSec / 60);
            const s = Math.round(totalSec % 60);
            totalTimeStr = `${m}m ${s}s`;
        } else {
            totalTimeStr = `${totalElapsed}s`;
        }

        send('batch_done', {
            totalMods: validPaks.length,
            succeeded,
            failed,
            skipped,
            totalElapsed,
            totalTimeStr,
            results: modResults,
        });

        send('log', { text: `\n═══════════════════════════════════════` });
        send('log', { text: `  BATCH TERMINÉ : ${succeeded}/${validPaks.length} traduit(s)` });
        if (skipped > 0) {
            send('log', { text: `  ⏩ ${skipped} mod(s) ignoré(s) (déjà traduit)` });
        }
        send('log', { text: `  Temps total : ${totalTimeStr}` });
        if (failed > 0) {
            send('log', { text: `  ✘ ${failed} mod(s) en erreur` });
        }
        for (const r of modResults) {
            const icon = r.skipped ? '⏩' : r.success ? '✔' : '✘';
            const suffix = r.skipped ? '— Déjà traduit' : `— ${r.elapsed}s`;
            send('log', { text: `    ${icon} ${r.pak} ${suffix}` });
        }
        send('log', { text: `═══════════════════════════════════════` });

        send('done', { code: failed > 0 ? 1 : 0 });
        translationState.activeProcesses.delete(batchSessionId);
        translationState.busy = false;
        res.end();

        // Refresh links after batch
    })().catch(err => {
        send('error', { text: `Erreur batch: ${err.message}` });
        send('done', { code: 1 });
        translationState.busy = false;
        translationState.activeProcesses.delete(batchSessionId);
        res.end();
    });
});


/* ================================================================
   SMART TRANSLATE  — translate only missing strings and patch existing translation pak
   ================================================================ */
app.get('/api/translate/smart', (req, res) => {
    const { original, translationPak, lang } = req.query;
    const cfg = loadConfig();
    if (!cfg.modsFolder || !original) {
        res.status(400).end();
        return;
    }

    // Validate pak names
    let validOriginal, validTransPak;
    try {
        validOriginal = safePakName(original);
        if (translationPak) validTransPak = safePakName(translationPak);
    } catch (e) {
        res.status(400).json({ error: e.message });
        return;
    }

    const send = openSse(res, { typed: true });

    // Queue check
    if (translationState.busy) {
        send('error', { text: '⚠ Une traduction est déjà en cours ! Attendez qu\'elle se termine pour éviter un ban IP.' });
        send('done', { code: 1 });
        res.end();
        return;
    }
    translationState.busy = true;

    // If no existing translation pak, just do a full translation
    if (!validTransPak) {
        send('log', { text: 'Aucun pak de traduction existant — traduction complète...' });
        // Redirect to full translation by spawning main.js
        const pakPath = path.join(cfg.modsFolder, validOriginal);
        const langCode = lang || 'fr';
        const outputName = validOriginal.replace(/\.pak$/i, `_${langCode}.pak`);
        const outputPath = path.join(cfg.modsFolder, outputName);

        const args = [
            path.join(__dirname, '..', 'main.js'),
            pakPath, '--to', langCode, '--output', outputPath,
        ];

        send('start', { pak: validOriginal, lang: langCode, output: outputName });

        const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '');
        const proc = spawn(process.execPath, args, { cwd: path.join(__dirname, '..') });

        proc.stdout.on('data', (chunk) => {
            for (const line of stripAnsi(chunk.toString()).split('\n')) {
                if (line.trim()) send('log', { text: line });
            }
        });
        proc.stderr.on('data', (chunk) => {
            for (const line of stripAnsi(chunk.toString()).split('\n')) {
                if (line.trim()) send('error', { text: line });
            }
        });
        proc.on('close', (code) => {
            send('done', { code, output: outputName });
            translationState.busy = false;
            res.end();
        });
        return;
    }

    // Smart mode: compare and translate only missing
    send('log', { text: `Analyse comparative : ${validOriginal} vs ${validTransPak}...` });

    (async () => {
        try {
            const origPath = path.join(cfg.modsFolder, validOriginal);
            const transPath = path.join(cfg.modsFolder, validTransPak);

            // Read all UIDs from original
            const origUIDs = new Map();
            const origLspk = await readLSPK(origPath);
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
                        const re = /contentuid="([^"]+)"[^>]*version="(\d+)"[^>]*>([^<]*)/g;
                        let m;
                        while ((m = re.exec(txt))) {
                            if (m[3].trim()) origUIDs.set(m[1], m[3]);
                        }
                    }
                } catch { /* skip */ }
            }
            await closeLSPK(origLspk);

            send('log', { text: `  Original : ${origUIDs.size} chaînes trouvées` });

            // Read all UIDs from translation
            const transUIDs = new Map();
            const transFileData = new Map(); // filename -> content (for editing)
            const transLspk = await readLSPK(transPath);
            const transEntries = [];

            for (const entry of transLspk.entries) {
                const lower = entry.name.toLowerCase();
                const data = await readEntryData(transLspk.handle, entry);
                transEntries.push({ name: entry.name, data, originalFlags: 0 });

                if (!lower.endsWith('.loca') && !lower.endsWith('.xml')) continue;
                try {
                    if (lower.endsWith('.loca')) {
                        for (const e of parseLoca(data)) {
                            if (e.uid && e.text && e.text.trim()) transUIDs.set(e.uid, e.text);
                        }
                    } else if (lower.endsWith('.xml')) {
                        const txt = data.toString('utf8');
                        transFileData.set(entry.name, txt);
                        const re = /contentuid="([^"]+)"[^>]*version="(\d+)"[^>]*>([^<]*)/g;
                        let m;
                        while ((m = re.exec(txt))) {
                            if (m[3].trim()) transUIDs.set(m[1], m[3]);
                        }
                    }
                } catch { /* skip */ }
            }
            await closeLSPK(transLspk);

            send('log', { text: `  Traduction : ${transUIDs.size} chaînes existantes` });

            // Find missing strings
            const missing = [];
            for (const [uid, origText] of origUIDs) {
                if (!transUIDs.has(uid)) {
                    missing.push({ uid, text: origText });
                }
            }

            send('log', { text: `  Manquantes : ${missing.length} chaînes à traduire` });

            if (missing.length === 0) {
                send('log', { text: '✔ Traduction complète ! Rien à ajouter.' });
                send('done', { code: 0, output: validTransPak, noChanges: true });
                translationState.busy = false;
                res.end();
                return;
            }

            // Translate missing strings using the translator
            const langCode = lang || 'fr';
            const translator = createTranslator({
                srcLang: 'auto',
                tgtLang: langCode,
                cachePath: path.join(__dirname, '..', 'data', 'bg3', 'cache.json'),
                concurrency: 3,
                delayMs: 120,
                logger: (msg) => send('log', { text: `  ${msg}` }),
                glossaryFile: 'bg3/glossary.json',
            });

            const textsToTranslate = missing.map(m => m.text);
            send('log', { text: `\nTraduction de ${textsToTranslate.length} chaînes manquantes...` });

            let done = 0;
            const results = await translator.translateBatch(textsToTranslate, (key, result, fromCache) => {
                done++;
                if (done % 10 === 0 || done === textsToTranslate.length) {
                    send('progress', { current: done, total: textsToTranslate.length, pct: Math.round(done / textsToTranslate.length * 100) });
                }
            });
            translator.flush();

            // Find the first XML translation file to append to
            let targetFile = null;
            for (const [fname, content] of transFileData) {
                if (fname.toLowerCase().includes('localization') && fname.toLowerCase().endsWith('.xml')) {
                    targetFile = fname;
                    break;
                }
            }

            if (!targetFile && transFileData.size > 0) {
                targetFile = [...transFileData.keys()][0];
            }

            if (targetFile) {
                let xmlContent = transFileData.get(targetFile);

                // Build new content entries
                const newEntries = [];
                for (const m of missing) {
                    const translated = results.get(m.text);
                    if (translated) {
                        const safeText = translated
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;');
                        newEntries.push(`    <content contentuid="${m.uid}" version="1">${safeText}</content>`);
                    }
                }

                // Insert before </contentList>
                const insertPoint = xmlContent.lastIndexOf('</contentList>');
                if (insertPoint > -1) {
                    xmlContent = xmlContent.slice(0, insertPoint)
                        + newEntries.join('\n') + '\n'
                        + xmlContent.slice(insertPoint);
                }

                // Update the entry data
                for (const te of transEntries) {
                    if (te.name === targetFile) {
                        te.data = Buffer.from(xmlContent, 'utf8');
                        break;
                    }
                }

                send('log', { text: `\n  ✔ ${newEntries.length} traductions ajoutées à ${targetFile}` });
            }

            // Rebuild the translation pak
            const finalEntries = transEntries.map(e => ({
                name: e.name,
                data: e.data,
                archivePart: 0,
                originalFlags: 0,
                uncompSize: e.data.length,
                modified: true,
            }));

            await writeLSPK(transPath, {
                flags: 0, priority: 0, md5: Buffer.alloc(16, 0), numParts: 1,
            }, finalEntries);

            send('log', { text: `\n  ✔ Pak mis à jour : ${validTransPak}` });
            send('done', { code: 0, output: validTransPak, addedStrings: missing.length });
            translationState.busy = false;
            res.end();
        } catch (e) {
            send('error', { text: `Erreur: ${e.message}` });
            send('done', { code: 1 });
            translationState.busy = false;
            res.end();
        }
    })();
});

}; // end register
