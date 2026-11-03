'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');
const { createTranslator, ensureMinecraftFormatSpacing } = require('../translator');
const { loadConfig, saveConfig, safeInstanceName, safeModId, looksLikeWindowsPath, homePathCandidates, dirExists } = require('./shared');
const { openSse } = require('./utils/sse');

/* ================================================================
   MINECRAFT — translate FTB Quests (.snbt) + KubeJS lang (.json)
   ================================================================ */

// Windows paths
const MC_INSTANCES_PRISM_WIN = path.join(process.env.APPDATA || '', 'PrismLauncher', 'instances');
const MC_INSTANCES_CURSEFORGE_WIN = path.join(process.env.USERPROFILE || '', 'curseforge', 'minecraft', 'Instances');

// Linux paths
const HOME = process.env.HOME || '';
const MC_INSTANCES_PRISM_LINUX_NATIVE   = path.join(HOME, '.local', 'share', 'PrismLauncher', 'instances');
const MC_INSTANCES_PRISM_LINUX_FLATPAK  = path.join(HOME, '.var', 'app', 'org.prismlauncher.PrismLauncher', 'data', 'PrismLauncher', 'instances');
const MC_INSTANCES_MULTIMC_LINUX_NATIVE  = path.join(HOME, '.local', 'share', 'multimc', 'instances');
const MC_INSTANCES_MULTIMC_LINUX_FLATPAK = path.join(HOME, '.var', 'app', 'org.multimc.MultiMC5', 'data', 'multimc', 'instances');

function detectMinecraftInstancesDir() {
    const rels = [
        ['.local', 'share', 'PrismLauncher', 'instances'],
        ['.var', 'app', 'org.prismlauncher.PrismLauncher', 'data', 'PrismLauncher', 'instances'],
        ['.local', 'share', 'multimc', 'instances'],
        ['.var', 'app', 'org.multimc.MultiMC5', 'data', 'multimc', 'instances'],
        ['.var', 'app', 'com.atlauncher.ATLauncher', 'data', 'instances'],
    ];
    for (const home of homePathCandidates()) {
        for (const rel of rels) {
            const p = path.join(home, ...rel);
            if (dirExists(p)) return p;
        }
    }
    if (process.platform === 'win32') {
        if (dirExists(MC_INSTANCES_PRISM_WIN)) return MC_INSTANCES_PRISM_WIN;
        if (dirExists(MC_INSTANCES_CURSEFORGE_WIN)) return MC_INSTANCES_CURSEFORGE_WIN;
    }
    if (dirExists(MC_INSTANCES_PRISM_LINUX_NATIVE)) return MC_INSTANCES_PRISM_LINUX_NATIVE;
    if (dirExists(MC_INSTANCES_PRISM_LINUX_FLATPAK)) return MC_INSTANCES_PRISM_LINUX_FLATPAK;
    return '';
}

function getMinecraftInstancesPath() {
    const cfg = loadConfig();
    const configured = (cfg.minecraftInstancesFolder || '').trim();
    const deadWin = configured && looksLikeWindowsPath(configured) && process.platform !== 'win32';
    if (configured && !deadWin && dirExists(configured)) return configured;

    const detected = detectMinecraftInstancesDir();
    if (detected) {
        if (!configured || deadWin || !dirExists(configured)) {
            cfg.minecraftInstancesFolder = detected;
            try { saveConfig(cfg); } catch {}
        }
        return detected;
    }
    return configured || (process.platform === 'win32' ? MC_INSTANCES_PRISM_WIN : MC_INSTANCES_PRISM_LINUX_FLATPAK);
}

/**
 * Resolve the Minecraft data root for an instance.
 * PrismLauncher uses <instance>/minecraft/, CurseForge places files directly in <instance>/.
 */
function mcRoot(instanceDir) {
    for (const sub of ['minecraft', '.minecraft']) {
        const candidate = path.join(instanceDir, sub);
        if (fs.existsSync(candidate)) return candidate;
    }
    return instanceDir;
}

function resolveInstanceDir(instancesPath, instance) {
    const name = safeInstanceName(instance);
    return path.join(instancesPath, name);
}

/* ── SNBT Parser & Writer (FTBQuest) ── */

function unescapeSNBT(s) {
    return String(s).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/* ── JSON5 Parser & Writer (FTBQuest 1.21+ — ATM11 etc.) ── */

/**
 * Strip JSON5 comments and trailing commas so the result is valid JSON.
 * Handles // line comments, /* block comments *\/, and trailing commas before } or ].
 */
function stripJSON5Comments(content) {
    let out = '';
    let i = 0;
    let inString = false;
    let stringChar = '';
    while (i < content.length) {
        const ch = content[i];
        const next = content[i + 1];
        if (inString) {
            out += ch;
            if (ch === '\\' && i + 1 < content.length) {
                out += next;
                i += 2;
                continue;
            }
            if (ch === stringChar) inString = false;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            inString = true;
            stringChar = ch;
            out += '"';
            i++;
            continue;
        }
        if (ch === '/' && next === '/') {
            // line comment — skip to end of line
            while (i < content.length && content[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            // block comment — skip to */
            i += 2;
            while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        out += ch;
        i++;
    }
    // Remove trailing commas before } or ]
    return out.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Parse a JSON5 lang file into the same entry format as parseSNBT.
 * JSON5 lang files are flat objects: { "key": "value", "key2": ["line1", "line2"] }
 */
function parseJSON5Lang(content) {
    const cleaned = stripJSON5Comments(content);
    let obj;
    try {
        obj = JSON.parse(cleaned);
    } catch (e) {
        return [];
    }
    const entries = [];
    for (const [key, value] of Object.entries(obj)) {
        if (Array.isArray(value)) {
            entries.push({ key, value: value.map(v => String(v)), isArray: true, inline: false });
        } else {
            entries.push({ key, value: String(value), isArray: false });
        }
    }
    return entries;
}

/**
 * Write entries back as JSON5 (JSON with 2-space indent, compatible with JSON5 readers).
 */
function writeJSON5Lang(entries) {
    const obj = {};
    for (const entry of entries) {
        if (entry.isArray) {
            obj[entry.key] = entry.value;
        } else {
            obj[entry.key] = entry.value;
        }
    }
    return JSON.stringify(obj, null, 2);
}

/**
 * Scan a JSON5 lang directory (e.g. lang/en_us/) and collect all entries from all .json5 files.
 * Returns { entries, files } where files = [{ name, relPath, entryCount }].
 */
async function scanJSON5LangDir(langDir, locale) {
    const localeDir = path.join(langDir, locale);
    if (!fs.existsSync(localeDir) || !fs.statSync(localeDir).isDirectory()) return null;

    const entries = [];
    const files = [];

    async function walk(rel) {
        const dir = path.join(localeDir, rel);
        const items = await fsp.readdir(dir, { withFileTypes: true });
        for (const item of items) {
            const childRel = rel ? path.join(rel, item.name) : item.name;
            if (item.isDirectory()) {
                await walk(childRel);
            } else if (item.name.endsWith('.json5') || item.name.endsWith('.json')) {
                const content = await fsp.readFile(path.join(dir, item.name), 'utf8');
                const parsed = parseJSON5Lang(content);
                entries.push(...parsed);
                files.push({ name: item.name, relPath: childRel, entryCount: parsed.length });
            }
        }
    }

    await walk('');
    return { entries, files };
}

/**
 * Parse an FTBQuest SNBT lang file into an array of entries.
 */
function parseSNBT(content) {
    const entries = [];
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    let i = 0;

    while (i < lines.length && lines[i].trim() !== '{') i++;
    i++;

    while (i < lines.length) {
        const line = lines[i].trim();
        if (line === '}') break;
        if (line === '') { i++; continue; }

        // Single-value: key: "value"
        const singleMatch = line.match(/^([\w.]+):\s*"(.*)"$/);
        if (singleMatch) {
            entries.push({ key: singleMatch[1], value: unescapeSNBT(singleMatch[2]), isArray: false });
            i++;
            continue;
        }

        // Inline array: key: ["text1" "text2" ...]
        const inlineArrayMatch = line.match(/^([\w.]+):\s*\[(.+)\]$/);
        if (inlineArrayMatch) {
            const key = inlineArrayMatch[1];
            const raw = inlineArrayMatch[2];
            const values = [];
            // Extract all quoted strings (handle escaped quotes)
            const strRe = /"((?:[^"\\]|\\.)*)"/g;
            let m;
            while ((m = strRe.exec(raw)) !== null) {
                values.push(unescapeSNBT(m[1]));
            }
            entries.push({ key, value: values, isArray: true, inline: true });
            i++;
            continue;
        }

        // Multi-line array: key: [
        const arrayStartMatch = line.match(/^([\w.]+):\s*\[$/);
        if (arrayStartMatch) {
            const key = arrayStartMatch[1];
            const values = [];
            i++;
            while (i < lines.length) {
                const arrLine = lines[i].trim();
                if (arrLine === ']') { i++; break; }
                const strMatch = arrLine.match(/^"(.*)"$/);
                if (strMatch) values.push(unescapeSNBT(strMatch[1]));
                i++;
            }
            entries.push({ key, value: values, isArray: true, inline: false });
            continue;
        }
        i++;
    }
    return entries;
}

function escapeSNBT(s) {
    if (s == null) return '';
    let v = ensureMinecraftFormatSpacing(String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    // FTBQuest format codes: '&' followed by [0-9a-fk-or] is a color/style.
    // Any other '&' must be escaped as '\&' or FTBQuest refuses to load the lang file.
    v = v.replace(/(?<!\\)&(?![0-9a-fk-orA-FK-OR])/g, '\\&');
    return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

function writeSNBT(entries) {
    const lines = ['{'];
    for (const entry of entries) {
        if (entry.isArray) {
            if (entry.inline) {
                // Preserve inline format: key: ["text1" "text2"]
                const quoted = entry.value.map(v => `"${escapeSNBT(v)}"`).join(' ');
                lines.push(`\t${entry.key}: [${quoted}]`);
            } else {
                lines.push(`\t${entry.key}: [`);
                for (const line of entry.value) lines.push(`\t\t"${escapeSNBT(line)}"`);
                lines.push('\t]');
            }
        } else {
            lines.push(`\t${entry.key}: "${escapeSNBT(entry.value)}"`);
        }
    }
    lines.push('}');
    return lines.join('\n');
}

/** Mirror a monolithic locale SNBT/JSON5 into lang/<locale>/ when en_us/ exists (ATM10 / FTB 1.21). */
async function writeFtbLocaleFolder(langDir, locale, entries) {
    const srcFolder = path.join(langDir, 'en_us');
    const dstFolder = path.join(langDir, locale);
    if (!fs.existsSync(srcFolder) || !fs.statSync(srcFolder).isDirectory()) return [];
    const byKey = new Map(entries.map(e => [e.key, e]));
    const written = [];

    async function walk(rel) {
        const dir = path.join(srcFolder, rel);
        const names = await fsp.readdir(dir, { withFileTypes: true });
        for (const n of names) {
            const child = rel ? path.join(rel, n.name) : n.name;
            if (n.isDirectory()) {
                await walk(child);
                continue;
            }
            // Support both .snbt and .json5 files
            const isSnbt = n.name.endsWith('.snbt');
            const isJson5 = n.name.endsWith('.json5');
            if (!isSnbt && !isJson5) continue;
            if (n.name.endsWith('_merged')) continue;

            const rawContent = await fsp.readFile(path.join(srcFolder, child), 'utf8');
            let parsed, translated, outputContent;

            if (isJson5) {
                parsed = parseJSON5Lang(rawContent);
                translated = parsed.map(e => {
                    const t = byKey.get(e.key);
                    return t ? { ...e, value: t.value } : e;
                });
                outputContent = writeJSON5Lang(translated) + '\n';
            } else {
                parsed = parseSNBT(rawContent);
                translated = parsed.map(e => {
                    const t = byKey.get(e.key);
                    return t ? { ...e, value: t.value } : e;
                });
                outputContent = writeSNBT(translated) + '\n';
            }

            const outPath = path.join(dstFolder, child);
            await fsp.mkdir(path.dirname(outPath), { recursive: true });
            await fsp.writeFile(outPath, outputContent, 'utf8');
            written.push(outPath);
        }
    }

    await walk('');
    return written;
}

function flattenSNBTEntries(entries) {
    // Translate each array element individually to preserve element count.
    // External APIs (DeepL/Google) often collapse or expand newlines, corrupting arrays.
    const translatable = [];
    for (const entry of entries) {
        if (entry.isArray) {
            for (let i = 0; i < entry.value.length; i++) {
                const v = entry.value[i];
                if (v && v.trim()) translatable.push({ key: `${entry.key}[${i}]`, text: v, isArray: true, arrIdx: i, arrKey: entry.key });
            }
        } else {
            if (entry.value && entry.value.trim()) translatable.push({ key: entry.key, text: entry.value, isArray: false });
        }
    }
    return translatable;
}

const MC_COMPONENT_TEXT_KEYS = new Set(['text', 'translate', 'insertion']);

function isMinecraftJsonComponent(text) {
    const t = String(text || '').trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return false;
    if (!/"text"\s*:|"translate"\s*:|"hoverEvent"\s*:|"clickEvent"\s*:/.test(t)) return false;
    try {
        JSON.parse(t);
        return true;
    } catch {
        return t.startsWith('{') && t.includes('"text"');
    }
}

const FR_TRAD_PACK_RE = /^FR_Traduction.*\.zip$/i;

function listFrTraductionPacks(rpDir) {
    if (!rpDir || !fs.existsSync(rpDir)) return [];
    try {
        return fs.readdirSync(rpDir).filter(f => FR_TRAD_PACK_RE.test(f));
    } catch {
        return [];
    }
}

function findFrTraductionPack(rpDir) {
    const files = listFrTraductionPacks(rpDir);
    if (files.length === 0) return null;
    const exact = files.find(f => f.toLowerCase() === 'fr_traduction.zip');
    return exact || files[0];
}

async function activateResourcePack(optionsFile, packFileName) {
    if (!packFileName || !optionsFile || !fs.existsSync(optionsFile)) return false;
    try {
        let options = await fsp.readFile(optionsFile, 'utf8');
        const rpName = `file/${packFileName}`;
        if (options.includes(rpName)) return true;
        const rpMatch = options.match(/^resourcePacks:\[(.*)?\]$/m);
        if (!rpMatch) return false;
        const existing = rpMatch[1] || '';
        const packs = existing ? `"${rpName}",${existing}` : `"${rpName}"`;
        options = options.replace(/^resourcePacks:\[.*?\]$/m, `resourcePacks:[${packs}]`);
        await fsp.writeFile(optionsFile, options, 'utf8');
        return true;
    } catch {
        return false;
    }
}

/** Fix French typography spaces (NBSP) inserted before colons inside JSON strings */
function repairJsonTypography(text) {
    return String(text)
        .replace(/\\"([^"\\]+)\\"[\u00A0\u202F]+:/g, '\\"$1":')
        .replace(/\\"([^"\\]+)\\"\s+:/g, '\\"$1":')
        .replace(/"([^"\\]+)"[\u00A0\u202F]+:/g, '"$1":')
        .replace(/"([^"\\]+)"\s+:/g, (m, key) => {
            if (/^(text|color|action|value|contents|translate|hoverEvent|clickEvent|underlined|italic|bold)$/.test(key)) {
                return `"${key}":`;
            }
            return m;
        });
}

function collectJsonComponentTexts(jsonStr, out) {
    if (!isMinecraftJsonComponent(jsonStr)) return;
    let node;
    try { node = JSON.parse(jsonStr); } catch { return; }
    function walk(val) {
        if (typeof val === 'string') {
            const t = val.trim();
            if (t && /[a-zA-ZÀ-ÿ]/.test(t) && !isMinecraftJsonComponent(t) && !isSkippableChapterString(t)) {
                out.push(val);
            }
            return;
        }
        if (Array.isArray(val)) { val.forEach(walk); return; }
        if (val && typeof val === 'object') {
            for (const [k, v] of Object.entries(val)) {
                if (MC_COMPONENT_TEXT_KEYS.has(k) && typeof v === 'string') {
                    if (!isSkippableChapterString(v)) out.push(v);
                } else {
                    walk(v);
                }
            }
        }
    }
    walk(node);
}

function translateJsonComponentValue(enValue, translationMap) {
    let node;
    try {
        node = JSON.parse(enValue);
    } catch {
        return enValue;
    }

    function walk(val) {
        if (typeof val === 'string') {
            const tr = translationMap.get(val);
            return (tr != null && tr !== '') ? tr : val;
        }
        if (Array.isArray(val)) return val.map(walk);
        if (val && typeof val === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(val)) {
                if (MC_COMPONENT_TEXT_KEYS.has(k) && typeof v === 'string') {
                    const tr = translationMap.get(v);
                    out[k] = (tr != null && tr !== '') ? tr : v;
                } else if (typeof v === 'object' && v !== null) {
                    out[k] = walk(v);
                } else {
                    out[k] = v;
                }
            }
            return out;
        }
        return val;
    }

    try {
        return JSON.stringify(walk(node));
    } catch {
        return enValue;
    }
}

function isSkippableChapterString(text) {
    if (!text || !text.trim()) return true;
    if (isMinecraftJsonComponent(text)) return true;
    if (/^[a-z0-9_]+:[a-z0-9_/]+$/i.test(text) && !text.includes(' ')) return true;
    if (/^[0-9A-F]{16}$/i.test(text)) return true;
    if (/^\d+$/.test(text)) return true;
    if (!/[a-zA-ZÀ-ÿ]/.test(text)) return true;
    return false;
}

/** Extract translatable strings from FTB Quest chapter SNBT (title/subtitle/description). */
function extractChapterTranslatable(content, fileName) {
    const results = [];
    const seen = new Set();

    function add(text) {
        if (isSkippableChapterString(text)) return;
        if (seen.has(text)) return;
        seen.add(text);
        results.push({ file: fileName, text });
    }

    for (const re of [/\btitle:\s*"((?:[^"\\]|\\.)*)"/g, /\bsubtitle:\s*"((?:[^"\\]|\\.)*)"/g]) {
        let m;
        while ((m = re.exec(content)) !== null) {
            add(unescapeSNBT(m[1]));
        }
    }

    const descBlockRe = /\bdescription:\s*\[([\s\S]*?)\]/g;
    let dm;
    while ((dm = descBlockRe.exec(content)) !== null) {
        const strRe = /"((?:[^"\\]|\\.)*)"/g;
        let sm;
        while ((sm = strRe.exec(dm[1])) !== null) {
            add(unescapeSNBT(sm[1]));
        }
    }

    return results;
}

function applyChapterTranslations(content, translationMap) {
    let result = content.replace(/"((?:[^"\\]|\\.)*)"/g, (match, raw) => {
        const text = unescapeSNBT(raw);
        if (isMinecraftJsonComponent(text)) return match;
        const translated = translationMap.get(text);
        if (translated != null && translated !== '' && translated !== text) {
            return `"${escapeSNBT(translated)}"`;
        }
        return match;
    });
    return repairJsonTypography(result);
}

/**
 * Apply translations to a JSON5 chapter file.
 * Parse the JSON5, replace translatable strings in quest objects, then re-serialize.
 */
function applyChapterTranslationsJSON5(content, translationMap) {
    try {
        const cleaned = stripJSON5Comments(content);
        const obj = JSON.parse(cleaned);
        if (obj.quests && Array.isArray(obj.quests)) {
            for (const quest of obj.quests) {
                for (const key of Object.keys(quest)) {
                    if (!JSON5_CHAPTER_TRANSLATABLE_KEYS.has(key)) continue;
                    const val = quest[key];
                    if (typeof val === 'string' && val.trim()) {
                        const translated = translationMap.get(val);
                        if (translated != null && translated !== '' && translated !== val) {
                            quest[key] = ensureMinecraftFormatSpacing(translated);
                        }
                    } else if (Array.isArray(val)) {
                        quest[key] = val.map(v => {
                            if (typeof v === 'string' && v.trim()) {
                                const translated = translationMap.get(v);
                                if (translated != null && translated !== '' && translated !== v) {
                                    return ensureMinecraftFormatSpacing(translated);
                                }
                            }
                            return v;
                        });
                    }
                }
            }
        }
        return JSON.stringify(obj, null, 2);
    } catch {
        // Fallback: string replacement like SNBT mode
        return applyChapterTranslations(content, translationMap);
    }
}

async function scanFtbQuestInfo(instanceDir) {
    const root = mcRoot(instanceDir);
    const questsDir = path.join(root, 'config', 'ftbquests', 'quests');
    if (!fs.existsSync(questsDir)) return null;

    const langDir = path.join(questsDir, 'lang');
    if (fs.existsSync(langDir)) {
        // Detect format: SNBT files (old) vs JSON5 directories (new, ATM11+)
        const langEntries = await fsp.readdir(langDir, { withFileTypes: true });
        const snbtFiles = langEntries.filter(e => e.isFile() && e.name.endsWith('.snbt')).map(e => e.name);
        const subDirs = langEntries.filter(e => e.isDirectory()).map(e => e.name);

        const locales = [];
        for (const f of snbtFiles) locales.push(f.replace('.snbt', ''));
        for (const d of subDirs) {
            if (!locales.includes(d)) locales.push(d);
        }

        // Determine format: if en_us is a directory with .json5 files, it's JSON5 format
        const enUsDir = path.join(langDir, 'en_us');
        const isJSON5Format = fs.existsSync(enUsDir) && fs.statSync(enUsDir).isDirectory();

        let entryCount = 0;
        if (isJSON5Format) {
            // JSON5 format (ATM11+): lang/en_us/*.json5 + lang/en_us/chapters/*.json5
            try {
                const scanned = await scanJSON5LangDir(langDir, 'en_us');
                if (scanned) entryCount = scanned.entries.length;
            } catch {}
        } else if (locales.includes('en_us')) {
            // SNBT format: lang/en_us.snbt
            try {
                const content = await fsp.readFile(path.join(langDir, 'en_us.snbt'), 'utf8');
                entryCount = parseSNBT(content).length;
            } catch {}
        }

        return {
            mode: 'lang',
            format: isJSON5Format ? 'json5' : 'snbt',
            langDir,
            locales,
            hasEnglish: locales.includes('en_us'),
            hasFrench: locales.includes('fr_fr'),
            entryCount,
        };
    }

    const chaptersDir = path.join(questsDir, 'chapters');
    if (!fs.existsSync(chaptersDir)) return null;

    // Support both .snbt and .json5 chapter files
    const allChapterFiles = await fsp.readdir(chaptersDir);
    const chapterFiles = allChapterFiles.filter(f => f.endsWith('.snbt') || f.endsWith('.json5'));
    if (chapterFiles.length === 0) return null;

    const isJSON5Chapters = chapterFiles.some(f => f.endsWith('.json5'));

    let entryCount = 0;
    for (const file of chapterFiles) {
        try {
            const content = await fsp.readFile(path.join(chaptersDir, file), 'utf8');
            if (file.endsWith('.json5')) {
                // JSON5 chapters: extract translatable strings from the quest structure
                entryCount += extractChapterTranslatableJSON5(content, file).length;
            } else {
                entryCount += extractChapterTranslatable(content, file).length;
            }
        } catch {}
    }

    return {
        mode: 'chapters',
        format: isJSON5Chapters ? 'json5' : 'snbt',
        chaptersDir,
        chapterFiles,
        chapterCount: chapterFiles.length,
        locales: [],
        hasEnglish: entryCount > 0,
        hasFrench: false,
        entryCount,
    };
}

/**
 * Extract translatable strings from a JSON5 chapter file.
 * JSON5 chapters have a structure like:
 * { quests: [ { title: "...", subtitle: "...", description: [...] }, ... ] }
 * We look for known translatable fields in the quest objects.
 */
const JSON5_CHAPTER_TRANSLATABLE_KEYS = new Set(['title', 'subtitle', 'description', 'text', 'quest_desc', 'quest_subtitle']);

function extractChapterTranslatableJSON5(content, filename) {
    const out = [];
    try {
        const cleaned = stripJSON5Comments(content);
        const obj = JSON.parse(cleaned);
        if (obj.quests && Array.isArray(obj.quests)) {
            for (const quest of obj.quests) {
                for (const key of Object.keys(quest)) {
                    if (!JSON5_CHAPTER_TRANSLATABLE_KEYS.has(key)) continue;
                    const val = quest[key];
                    if (typeof val === 'string' && val.trim()) {
                        out.push({ text: val, path: `${filename}::quest.${quest.id || '?'}.${key}` });
                    } else if (Array.isArray(val)) {
                        for (const v of val) {
                            if (typeof v === 'string' && v.trim()) {
                                out.push({ text: v, path: `${filename}::quest.${quest.id || '?'}.${key}[]` });
                            }
                        }
                    }
                }
            }
        }
    } catch {}
    return out;
}

/* ── Patchouli book helpers ── */

// Keys whose string values are translatable in Patchouli book JSON files.
const PATCHOULI_TRANSLATABLE_KEYS = new Set([
    'name', 'text', 'title', 'subtitle', 'description', 'landing_text',
    'link_text', 'header', 'tooltip', 'flavor',
]);

// Detect JAR entries that are Patchouli book JSON (entry, category, book.json).
// Format: assets/<modid>/patchouli_books/<book>/<locale>/{book.json|entries/**.json|categories/**.json}
const PATCHOULI_ENTRY_RE = /^assets\/([^/]+)\/patchouli_books\/([^/]+)\/([^/]+)\/(.+\.json)$/;

// A Minecraft i18n lang key looks like "modid.path.subpath" (lowercase, dots, no spaces).
const LANG_KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/**
 * Walk a JSON value; collect translatable string leaves (only when parent key is in PATCHOULI_TRANSLATABLE_KEYS).
 * Each output entry is tagged isLangKey=true if the string looks like a Minecraft i18n key reference
 * (which means Patchouli will resolve it from lang/<locale>.json, so we shouldn't translate the key itself
 * but rather translate the value it maps to in the mod's lang file).
 */
function collectPatchouliStrings(node, parentKey, pathArr, out) {
    if (typeof node === 'string') {
        if (PATCHOULI_TRANSLATABLE_KEYS.has(parentKey) && node.trim()
            && !/^[a-z0-9_]+:[a-z0-9_/]+$/.test(node)   // resource id like "minecraft:foo"
            && !/^#/.test(node)                          // Patchouli template placeholder like "#footer"
        ) {
            out.push({ path: pathArr.slice(), value: node, isLangKey: LANG_KEY_RE.test(node) });
        }
        return;
    }
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) collectPatchouliStrings(node[i], parentKey, pathArr.concat(i), out);
        return;
    }
    if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) collectPatchouliStrings(node[k], k, pathArr.concat(k), out);
    }
}

function setByPath(root, pathArr, value) {
    let cur = root;
    for (let i = 0; i < pathArr.length - 1; i++) cur = cur[pathArr[i]];
    cur[pathArr[pathArr.length - 1]] = value;
}

/**
 * Extract Patchouli book files for a single modId from a JAR's zip entries.
 * Returns array of { entryName, book, locale, relPath, json, strings }.
 *   - relPath = subpath inside the locale folder (e.g. "entries/getting_started/casting.json")
 */
function extractPatchouliFromZip(zipEntries, modId, locale = 'en_us') {
    const out = [];
    for (const e of zipEntries) {
        const m = e.entryName.match(PATCHOULI_ENTRY_RE);
        if (!m) continue;
        if (m[1] !== modId) continue;
        if (m[3] !== locale) continue;
        let json;
        try { json = JSON.parse(e.getData().toString('utf8')); }
        catch { continue; }
        const strings = [];
        collectPatchouliStrings(json, null, [], strings);
        if (strings.length === 0) continue;
        out.push({ entryName: e.entryName, book: m[2], locale: m[3], relPath: m[4], json, strings });
    }
    return out;
}

/* ── KubeJS JSON lang helpers ── */

/**
 * Scan kubejs/assets/ for all mods that have lang files.
 * Returns: [{ mod: "draconicevolution", langDir: "...", locales: [...], entryCount: N }]
 */
async function scanKubeJSLangs(instancePath) {
    const assetsDir = path.join(mcRoot(instancePath), 'kubejs', 'assets');
    if (!fs.existsSync(assetsDir)) return [];

    const mods = [];
    const modDirs = await fsp.readdir(assetsDir, { withFileTypes: true });

    for (const modDir of modDirs) {
        if (!modDir.isDirectory()) continue;
        const langDir = path.join(assetsDir, modDir.name, 'lang');
        if (!fs.existsSync(langDir)) continue;

        const files = (await fsp.readdir(langDir)).filter(f => f.endsWith('.json'));
        if (files.length === 0) continue;

        const locales = files.map(f => f.replace('.json', ''));
        let entryCount = 0;
        let hasFtbQuestKeys = false;
        let ftbQuestKeyCount = 0;
        if (locales.includes('en_us')) {
            try {
                const json = JSON.parse(await fsp.readFile(path.join(langDir, 'en_us.json'), 'utf8'));
                const keys = Object.keys(json);
                entryCount = keys.length;
                ftbQuestKeyCount = keys.filter(k => k.startsWith('ftbquests.chapter.')).length;
                hasFtbQuestKeys = ftbQuestKeyCount > 0;
            } catch {}
        }

        mods.push({
            mod: modDir.name,
            langDir,
            locales,
            hasEnglish: locales.includes('en_us'),
            hasFrench: locales.includes('fr_fr'),
            entryCount,
            hasFtbQuestKeys,
            ftbQuestKeyCount,
        });
    }
    return mods;
}

/* ── Mod JAR Translation (Resource Pack) ── */

/**
 * Scan mod JARs in an instance for lang files.
 * Returns list of mods with translation status.
 */
/** Parse a .lang file (1.12 format: key=value lines, # comments) */
function parseLangFile(buf) {
    const result = {};
    const text = buf.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1); // preserve value as-is
        if (key) result[key] = val;
    }
    return result;
}

async function scanModJars(instancePath) {
    const modsDir = path.join(mcRoot(instancePath), 'mods');
    if (!fs.existsSync(modsDir)) return [];

    const jars = (await fsp.readdir(modsDir)).filter(f => f.endsWith('.jar'));
    const mods = [];

    for (const jarName of jars) {
        try {
            const zip = new AdmZip(path.join(modsDir, jarName));
            const entries = zip.getEntries();

            // Support both 1.13+ (.json, lowercase) and 1.12 (.lang, mixed case)
            const langEntries = entries.filter(e =>
                /^assets\/[^/]+\/lang\/[^/]+\.(json|lang)$/.test(e.entryName)
            );

            if (langEntries.length === 0) continue;

            // Determine if this JAR uses .lang or .json format
            const isLegacy = langEntries.some(e => e.entryName.endsWith('.lang'));

            // Group by modId
            const modMap = {};
            for (const le of langEntries) {
                const parts = le.entryName.split('/');
                const modId = parts[1];
                const locale = parts[3].replace(/\.(json|lang)$/, '').toLowerCase();
                if (!modMap[modId]) modMap[modId] = { locales: [], jar: jarName, legacy: isLegacy };
                modMap[modId].locales.push(locale);
            }

            for (const [modId, info] of Object.entries(modMap)) {
                // Find english source — try en_us.json (1.13+) then en_US.lang / en_us.lang (1.12)
                let enEntry = langEntries.find(e => e.entryName === `assets/${modId}/lang/en_us.json`);
                let legacyFmt = false;
                if (!enEntry) {
                    enEntry = langEntries.find(e =>
                        e.entryName === `assets/${modId}/lang/en_US.lang` ||
                        e.entryName === `assets/${modId}/lang/en_us.lang`
                    );
                    if (enEntry) legacyFmt = true;
                }
                if (!enEntry) continue;

                let enCount = 0, frCount = 0;
                try {
                    const enData = enEntry.getData();
                    const enParsed = legacyFmt
                        ? parseLangFile(enData)
                        : JSON.parse(enData.toString('utf8'));
                    enCount = Object.keys(enParsed).length;
                } catch { continue; }

                // Find french — fr_fr.json (1.13+) or fr_FR.lang / fr_fr.lang (1.12)
                let frEntry = langEntries.find(e => e.entryName === `assets/${modId}/lang/fr_fr.json`);
                if (!frEntry) {
                    frEntry = langEntries.find(e =>
                        e.entryName === `assets/${modId}/lang/fr_FR.lang` ||
                        e.entryName === `assets/${modId}/lang/fr_fr.lang`
                    );
                }
                if (frEntry) {
                    try {
                        const frData = frEntry.getData();
                        const frParsed = legacyFmt
                            ? parseLangFile(frData)
                            : JSON.parse(frData.toString('utf8'));
                        frCount = Object.keys(frParsed).length;
                    } catch {}
                }

                const pct = enCount > 0 ? Math.round(frCount / enCount * 100) : 0;
                mods.push({
                    modId,
                    jar: jarName,
                    enCount,
                    frCount,
                    missing: enCount - frCount,
                    pct,
                    hasEnglish: true,
                    hasFrench: frCount > 0,
                    isComplete: pct >= 100,
                });
            }

            // ── Patchouli book scan ──
            const patchouliEnEntries = entries.filter(e => {
                const m = e.entryName.match(PATCHOULI_ENTRY_RE);
                return m && m[3] === 'en_us';
            });
            if (patchouliEnEntries.length > 0) {
                const byMod = {};
                for (const pe of patchouliEnEntries) {
                    const m = pe.entryName.match(PATCHOULI_ENTRY_RE);
                    const modId = m[1];
                    if (!byMod[modId]) byMod[modId] = 0;
                    try {
                        const json = JSON.parse(pe.getData().toString('utf8'));
                        const strings = [];
                        collectPatchouliStrings(json, null, [], strings);
                        byMod[modId] += strings.length;
                    } catch {}
                }
                for (const [modId, pCount] of Object.entries(byMod)) {
                    if (pCount === 0) continue;
                    let pFrCount = 0;
                    for (const e of entries) {
                        const m = e.entryName.match(PATCHOULI_ENTRY_RE);
                        if (!m || m[1] !== modId || m[3] !== 'fr_fr') continue;
                        try {
                            const json = JSON.parse(e.getData().toString('utf8'));
                            const strs = [];
                            collectPatchouliStrings(json, null, [], strs);
                            pFrCount += strs.length;
                        } catch {}
                    }
                    const existing = mods.find(mm => mm.modId === modId);
                    if (existing) {
                        existing.patchouliEnCount = pCount;
                        existing.patchouliFrCount = pFrCount;
                        existing.enCount += pCount;
                        existing.frCount += pFrCount;
                        existing.missing = existing.enCount - existing.frCount;
                        existing.pct = existing.enCount > 0 ? Math.round(existing.frCount / existing.enCount * 100) : 0;
                        existing.isComplete = existing.pct >= 100;
                    } else {
                        mods.push({
                            modId,
                            jar: jarName,
                            enCount: pCount,
                            frCount: pFrCount,
                            missing: pCount - pFrCount,
                            pct: pCount > 0 ? Math.round(pFrCount / pCount * 100) : 0,
                            hasEnglish: true,
                            hasFrench: pFrCount > 0,
                            isComplete: pFrCount >= pCount,
                            patchouliEnCount: pCount,
                            patchouliFrCount: pFrCount,
                            patchouliOnly: true,
                        });
                    }
                }
            }
        } catch {}
    }

    mods.sort((a, b) => b.missing - a.missing);
    return mods;
}

const DATAPACK_ID = 'jvtrans_fr';

function safeWorldName(name) {
    const n = String(name || '').replace(/[\\/]/g, '').trim();
    if (!n || n === '.' || n === '..') return '';
    return n;
}

function readInstanceMcVersion(instanceDir) {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(instanceDir, 'mmc-pack.json'), 'utf8'));
        const mc = (data.components || []).find(c => c.uid === 'net.minecraft');
        if (mc && mc.version) return String(mc.version);
    } catch {}
    return '';
}

function packFormatsForMc(version) {
    const parts = String(version || '').split('.').map(n => parseInt(n, 10) || 0);
    const maj = parts[0] || 1;
    const min = parts[1] || 21;
    const pat = parts[2] || 0;
    if (maj === 1 && min <= 12) return { rp: 3, dp: 4 };
    if (maj === 1 && min === 20 && pat <= 4) return { rp: 15, dp: 26 };
    if (maj === 1 && min === 20) return { rp: 32, dp: 41 };
    if (maj === 1 && min === 21 && pat <= 1) return { rp: 34, dp: 48 };
    if (maj === 1 && min === 21 && pat <= 3) return { rp: 42, dp: 57 };
    if (maj === 1 && min === 21 && pat <= 4) return { rp: 46, dp: 61 };
    return { rp: 48, dp: 71 };
}

async function listWorldSaves(root) {
    const savesDir = path.join(root, 'saves');
    if (!dirExists(savesDir)) return [];
    const items = await fsp.readdir(savesDir, { withFileTypes: true });
    const worlds = [];
    for (const item of items) {
        if (!item.isDirectory()) continue;
        const dir = path.join(savesDir, item.name);
        if (!fs.existsSync(path.join(dir, 'level.dat'))) continue;
        let mtime = 0;
        try { mtime = (await fsp.stat(dir)).mtimeMs; } catch {}
        worlds.push({
            name: item.name,
            hasDatapack: dirExists(path.join(dir, 'datapacks', DATAPACK_ID)),
            hasResources: fs.existsSync(path.join(dir, 'resources.zip')),
            mtime,
        });
    }
    worlds.sort((a, b) => b.mtime - a.mtime);
    return worlds;
}

function jarMatchesRequired(jarLower, key) {
    if (key === 'essential') {
        if (jarLower.includes('ftb-essential') || jarLower.includes('ftb_essential')) return false;
        return /(?:^|[._-])essential(?:[._-]|$)/.test(jarLower);
    }
    return jarLower.includes(key);
}

function scanRequiredMods(root, extraNames) {
    const modsDir = path.join(root, 'mods');
    const wanted = [];
    const seen = new Set();
    for (const raw of extraNames || []) {
        const key = String(raw || '').trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        wanted.push(key);
    }
    let jars = [];
    if (dirExists(modsDir)) {
        try { jars = fs.readdirSync(modsDir).filter(f => /\.jar$/i.test(f)); } catch {}
    }
    const low = jars.map(j => j.toLowerCase());
    const found = [];
    const missing = [];
    for (const key of wanted) {
        const hit = jars.find((_, i) => jarMatchesRequired(low[i], key));
        if (hit) found.push({ id: key, jar: hit });
        else missing.push({ id: key });
    }
    return { found, missing, jarCount: jars.length };
}

async function collectLangFilesIntoZip(root, zip) {
    let files = 0;
    const rpDir = path.join(root, 'resourcepacks');
    for (const packName of listFrTraductionPacks(rpDir)) {
        try {
            const src = new AdmZip(path.join(rpDir, packName));
            for (const e of src.getEntries()) {
                if (e.isDirectory) continue;
                const n = e.entryName.replace(/\\/g, '/');
                if (n === 'pack.mcmeta' || n === 'pack.png' || n.endsWith('/')) continue;
                zip.addFile(n, e.getData());
                files++;
            }
        } catch {}
    }
    const assetsDir = path.join(root, 'kubejs', 'assets');
    async function walk(dir, rel) {
        if (!dirExists(dir)) return;
        const ents = await fsp.readdir(dir, { withFileTypes: true });
        for (const ent of ents) {
            const p = path.join(dir, ent.name);
            const r = rel ? `${rel}/${ent.name}` : ent.name;
            if (ent.isDirectory()) await walk(p, r);
            else if (/\/lang\/fr_fr\.json$/i.test(r) || /\/lang\/fr_FR\.lang$/i.test(r)) {
                zip.addFile(`assets/${r.replace(/^assets\//, '')}`, await fsp.readFile(p));
                files++;
            }
        }
    }
    await walk(assetsDir, '');
    return files;
}

async function writeWorldDatapack(worldDir, { formats, requiredIds, worldName, instance }) {
    const packDir = path.join(worldDir, 'datapacks', DATAPACK_ID);
    const reqLine = (requiredIds.length ? requiredIds : ['essential']).join(', ');
    const safeTell = String(worldName).replace(/\\/g, '').replace(/"/g, '');
    const loadMc = [
        'scoreboard objectives add jvtrans_send trigger',
        'scoreboard players enable @a jvtrans_send',
        `tellraw @a [{"text":"[JVTrans] ","color":"gold"},{"text":"Traductions FR actives sur ${safeTell}.","color":"white"}]`,
        `tellraw @a [{"text":"  → ","color":"dark_gray"},{"text":"Les joueurs qui rejoignent (Essential / LAN) reçoivent le pack.","color":"gray"}]`,
        `tellraw @a [{"text":"  → ","color":"dark_gray"},{"text":"Mods requis : ${reqLine}","color":"aqua"}]`,
        'tellraw @a [{"text":"  → ","color":"dark_gray"},{"text":"/trigger jvtrans_send","color":"gold"},{"text":" — test Send à toi-même","color":"gray"}]',
        '',
    ].join('\n');
    const sendMc = [
        'tellraw @s [{"text":"[JVTrans] ","color":"gold"},{"text":"Test Send — envoyé à toi-même.","color":"white"}]',
        'tellraw @s [{"text":"  Si tu lis ça, le datapack tourne. Le resource pack FR est dans ce monde.","color":"gray"}]',
        'title @s actionbar {"text":"JVTrans FR — Send OK (toi-même)","color":"gold"}',
        'playsound minecraft:entity.experience_orb.pickup player @s ~ ~ ~ 0.5 1.2',
        '',
    ].join('\n');
    const testMc = 'function jvtrans:send\n';
    const tickMc = [
        'scoreboard players enable @a jvtrans_send',
        'execute as @a[scores={jvtrans_send=1..}] at @s run function jvtrans:send',
        'scoreboard players set @a[scores={jvtrans_send=1..}] jvtrans_send 0',
        '',
    ].join('\n');
    const loadTag = JSON.stringify({ values: ['jvtrans:load'] }, null, 2);
    const tickTag = JSON.stringify({ values: ['jvtrans:tick'] }, null, 2);
    for (const folder of ['function', 'functions']) {
        await fsp.mkdir(path.join(packDir, 'data', 'jvtrans', folder), { recursive: true });
        await fsp.mkdir(path.join(packDir, 'data', 'minecraft', 'tags', folder), { recursive: true });
        await fsp.writeFile(path.join(packDir, 'data', 'jvtrans', folder, 'load.mcfunction'), loadMc);
        await fsp.writeFile(path.join(packDir, 'data', 'jvtrans', folder, 'send.mcfunction'), sendMc);
        await fsp.writeFile(path.join(packDir, 'data', 'jvtrans', folder, 'test.mcfunction'), testMc);
        await fsp.writeFile(path.join(packDir, 'data', 'jvtrans', folder, 'tick.mcfunction'), tickMc);
        await fsp.writeFile(path.join(packDir, 'data', 'minecraft', 'tags', folder, 'load.json'), loadTag);
        await fsp.writeFile(path.join(packDir, 'data', 'minecraft', 'tags', folder, 'tick.json'), tickTag);
    }
    await fsp.writeFile(path.join(packDir, 'pack.mcmeta'), JSON.stringify({
        pack: {
            pack_format: formats.dp,
            description: `§6JVTrans FR §7— ${safeTell}\n§8localhost · Essential`,
        },
    }, null, 2));
    await fsp.writeFile(path.join(packDir, 'jvtrans.json'), JSON.stringify({
        instance,
        world: worldName,
        host: 'localhost',
        requiredMods: requiredIds,
        createdAt: new Date().toISOString(),
    }, null, 2));
    return packDir;
}

/* ── Minecraft API Routes ── */

function register(app) {

    /** List instances — scans for both FTBQuest SNBT and KubeJS JSON sources */
    app.get('/api/minecraft/instances', async (req, res) => {
        try {
            const cfg = loadConfig();
            const configured = (cfg.minecraftInstancesFolder || '').trim();
            const instancesPath = getMinecraftInstancesPath();
            const windowsOnLinux = !!(configured && looksLikeWindowsPath(configured) && process.platform !== 'win32');
            if (!dirExists(instancesPath)) {
                return res.json({
                    found: false,
                    path: instancesPath,
                    configured,
                    windowsOnLinux,
                    instances: [],
                });
            }

            const items = await fsp.readdir(instancesPath, { withFileTypes: true });
            const instances = [];

            for (const item of items) {
                if (!item.isDirectory()) continue;
                const instanceDir = path.join(instancesPath, item.name);

                // ── FTBQuest source ──
                const ftbquest = await scanFtbQuestInfo(instanceDir);

                // ── KubeJS sources ──
                const kubejsMods = await scanKubeJSLangs(instanceDir);

                // ── BetterQuesting source ──
                const bqDir = path.join(mcRoot(instanceDir), 'config', 'betterquesting');
                const hasBetterQuesting = fs.existsSync(bqDir);

                const compatible = !!(ftbquest || kubejsMods.length > 0 || hasBetterQuesting);

                const totalEntries = (ftbquest ? ftbquest.entryCount : 0) + kubejsMods.reduce((s, m) => s + m.entryCount, 0);
                const hasEnglish = (ftbquest ? ftbquest.hasEnglish : false) || kubejsMods.some(m => m.hasEnglish);
                const hasFrench = (ftbquest ? ftbquest.hasFrench : false) || kubejsMods.some(m => m.hasFrench);

                instances.push({
                    name: item.name,
                    ftbquest,
                    kubejs: kubejsMods,
                    hasBetterQuesting,
                    compatible,
                    totalEntries,
                    hasEnglish,
                    hasFrench,
                    sourceCount: (ftbquest ? 1 : 0) + kubejsMods.length + (hasBetterQuesting ? 1 : 0),
                });
            }

            res.json({ found: true, path: instancesPath, configured, windowsOnLinux: false, instances });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** List world saves + Essential / required mods for datapack sharing */
    app.get('/api/minecraft/saves', async (req, res) => {
        try {
            const instance = req.query.instance;
            if (!instance) return res.status(400).json({ error: 'Instance requise' });
            const instanceDir = resolveInstanceDir(getMinecraftInstancesPath(), instance);
            if (!fs.existsSync(instanceDir)) return res.status(404).json({ error: `Instance introuvable: ${instance}` });
            const root = mcRoot(instanceDir);
            const extra = String(req.query.required || 'essential').split(/[,;\s]+/).filter(Boolean);
            const required = scanRequiredMods(root, extra);
            const worlds = await listWorldSaves(root);
            const mcVersion = readInstanceMcVersion(instanceDir);
            const rpPacks = listFrTraductionPacks(path.join(root, 'resourcepacks'));
            res.json({
                ok: true,
                instance,
                mcVersion,
                worlds,
                required,
                translationPacks: rpPacks,
                host: 'localhost',
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Create datapack + world resources.zip so joining players get FR translations */
    app.post('/api/minecraft/datapack', async (req, res) => {
        try {
            const { instance, world, required, sendTranslations } = req.body || {};
            if (!instance) return res.status(400).json({ error: 'Instance requise' });
            const worldName = safeWorldName(world);
            if (!worldName) return res.status(400).json({ error: 'Save requise' });

            const instanceDir = resolveInstanceDir(getMinecraftInstancesPath(), instance);
            if (!fs.existsSync(instanceDir)) return res.status(404).json({ error: `Instance introuvable: ${instance}` });
            const root = mcRoot(instanceDir);
            const worldDir = path.join(root, 'saves', worldName);
            if (!fs.existsSync(path.join(worldDir, 'level.dat'))) {
                return res.status(404).json({ error: `Save introuvable: ${worldName}` });
            }

            const requiredIds = (Array.isArray(required) ? required : String(required || 'essential').split(/[,;\s]+/))
                .map(s => String(s || '').trim().toLowerCase())
                .filter(Boolean);
            if (!requiredIds.includes('essential')) requiredIds.unshift('essential');

            const mods = scanRequiredMods(root, requiredIds);
            const mcVersion = readInstanceMcVersion(instanceDir);
            const formats = packFormatsForMc(mcVersion);
            const packDir = await writeWorldDatapack(worldDir, { formats, requiredIds, worldName, instance });

            let resourceFiles = 0;
            let resourcesPath = '';
            if (sendTranslations !== false) {
                const zip = new AdmZip();
                zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({
                    pack: {
                        pack_format: formats.rp,
                        description: `§6Traduction FR §7— ${worldName}\n§8Envoyé aux joueurs (Essential / LAN)`,
                    },
                }, null, 2), 'utf8'));
                resourceFiles = await collectLangFilesIntoZip(root, zip);
                resourcesPath = path.join(worldDir, 'resources.zip');
                zip.writeZip(resourcesPath);
            }

            res.json({
                ok: true,
                instance,
                world: worldName,
                host: 'localhost',
                datapack: packDir,
                resources: resourcesPath || null,
                resourceFiles,
                required: mods,
                mcVersion,
                hint: 'Ouvre la save, invite via Essential. L’autre accepte le resource pack à la connexion.',
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Import FTBQuest SNBT/JSON5 from an instance (lang file or chapter files) */
    app.get('/api/minecraft/ftbquest-import', async (req, res) => {
        try {
            const { instance, locale } = req.query;
            if (!instance) return res.status(400).json({ error: 'Instance requise' });

            const instancesPath = getMinecraftInstancesPath();
            const instanceDir = resolveInstanceDir(instancesPath, instance);
            const info = await scanFtbQuestInfo(instanceDir);

            if (!info) {
                return res.status(404).json({ error: `FTB Quests introuvable pour ${instance}` });
            }

            if (info.mode === 'chapters') {
                const chapters = {};
                const preview = [];
                let translatableCount = 0;

                for (const file of info.chapterFiles) {
                    const filePath = path.join(info.chaptersDir, file);
                    const content = await fsp.readFile(filePath, 'utf8');
                    chapters[file] = content;
                    let extracted;
                    if (file.endsWith('.json5')) {
                        extracted = extractChapterTranslatableJSON5(content, file);
                    } else {
                        extracted = extractChapterTranslatable(content, file);
                    }
                    translatableCount += extracted.length;
                    for (const t of extracted) {
                        if (preview.length >= 10) break;
                        preview.push({
                            key: `${file}::${t.text.substring(0, 40)}`,
                            text: t.text.length > 100 ? t.text.substring(0, 97) + '...' : t.text,
                        });
                    }
                }

                return res.json({
                    source: 'ftbquest',
                    mode: 'chapters',
                    format: info.format || 'snbt',
                    instance,
                    chapterCount: info.chapterCount,
                    chapterFiles: info.chapterFiles,
                    translatableCount,
                    preview,
                    chapters,
                });
            }

            // Lang mode
            const srcLocale = locale || 'en_us';
            const isJSON5 = info.format === 'json5';

            if (isJSON5) {
                // JSON5 format: lang/<locale>/ directory with .json5 files
                const scanned = await scanJSON5LangDir(info.langDir, srcLocale);
                if (!scanned || scanned.entries.length === 0) {
                    return res.status(404).json({ error: `Dossier ${srcLocale}/ introuvable ou vide dans ${info.langDir}` });
                }

                const entries = scanned.entries;
                const translatable = flattenSNBTEntries(entries);

                const categories = {};
                for (const t of translatable) {
                    const cat = t.key.split('.')[0];
                    if (!categories[cat]) categories[cat] = 0;
                    categories[cat]++;
                }

                // Collect all file contents for the translate endpoint
                const fileContents = {};
                for (const f of scanned.files) {
                    fileContents[f.relPath] = await fsp.readFile(path.join(info.langDir, srcLocale, f.relPath), 'utf8');
                }

                return res.json({
                    source: 'ftbquest',
                    mode: 'lang',
                    format: 'json5',
                    instance,
                    locale: srcLocale,
                    totalEntries: entries.length,
                    translatableCount: translatable.length,
                    categories,
                    preview: translatable.slice(0, 10).map(t => ({
                        key: t.key,
                        text: t.text.length > 100 ? t.text.substring(0, 97) + '...' : t.text,
                    })),
                    fileContents,
                    langFiles: scanned.files,
                });
            }

            // SNBT format: lang/<locale>.snbt
            const langFile = path.join(info.langDir, `${srcLocale}.snbt`);

            if (!fs.existsSync(langFile)) {
                return res.status(404).json({ error: `Fichier ${srcLocale}.snbt introuvable pour ${instance}` });
            }

            const content = await fsp.readFile(langFile, 'utf8');
            const entries = parseSNBT(content);
            const translatable = flattenSNBTEntries(entries);

            const categories = {};
            for (const t of translatable) {
                const cat = t.key.split('.')[0];
                if (!categories[cat]) categories[cat] = 0;
                categories[cat]++;
            }

            res.json({
                source: 'ftbquest',
                mode: 'lang',
                format: 'snbt',
                instance,
                locale: srcLocale,
                totalEntries: entries.length,
                translatableCount: translatable.length,
                categories,
                preview: translatable.slice(0, 10).map(t => ({
                    key: t.key,
                    text: t.text.length > 100 ? t.text.substring(0, 97) + '...' : t.text,
                })),
                content,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Import KubeJS JSON lang from an instance (all mods or a specific mod) */
    app.get('/api/minecraft/kubejs-import', async (req, res) => {
        try {
            const { instance, mod, locale } = req.query;
            if (!instance) return res.status(400).json({ error: 'Instance requise' });

            const instancesPath = getMinecraftInstancesPath();
            const srcLocale = locale || 'en_us';
            const instanceDir = resolveInstanceDir(instancesPath, instance);
            const assetsDir = path.join(mcRoot(instanceDir), 'kubejs', 'assets');

            if (!fs.existsSync(assetsDir)) {
                return res.status(404).json({ error: 'Dossier kubejs/assets introuvable' });
            }

            // Determine which mods to import
            const modDirs = await fsp.readdir(assetsDir, { withFileTypes: true });
            const modsToImport = [];

            for (const md of modDirs) {
                if (!md.isDirectory()) continue;
                if (mod && md.name !== mod) continue;
                const langFile = path.join(assetsDir, md.name, 'lang', `${srcLocale}.json`);
                if (!fs.existsSync(langFile)) continue;
                modsToImport.push({ mod: md.name, langFile });
            }

            if (modsToImport.length === 0) {
                return res.status(404).json({ error: `Aucun fichier ${srcLocale}.json trouvé dans kubejs/assets` });
            }

            // Read and merge all mod lang files
            const allEntries = {};
            const modInfo = [];
            for (const m of modsToImport) {
                try {
                    const json = JSON.parse(await fsp.readFile(m.langFile, 'utf8'));
                    const count = Object.keys(json).length;
                    for (const [k, v] of Object.entries(json)) {
                        allEntries[`${m.mod}::${k}`] = v; // prefix with mod name to avoid collisions
                    }
                    modInfo.push({ mod: m.mod, entries: count });
                } catch (e) {
                    modInfo.push({ mod: m.mod, entries: 0, error: e.message });
                }
            }

            const translatable = Object.entries(allEntries)
                .filter(([, v]) => typeof v === 'string' && v.trim())
                .map(([k, v]) => ({ key: k, text: v }));

            res.json({
                source: 'kubejs',
                instance,
                locale: srcLocale,
                mods: modInfo,
                totalEntries: Object.keys(allEntries).length,
                translatableCount: translatable.length,
                preview: translatable.slice(0, 10).map(t => ({
                    key: t.key,
                    text: t.text.length > 100 ? t.text.substring(0, 97) + '...' : t.text,
                })),
                entries: allEntries,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Translate FTBQuest SNBT/JSON5 entries (SSE) — lang file or chapter files */
    app.post('/api/minecraft/ftbquest-translate', async (req, res) => {
        const { content, chapters, mode, lang, instance, format, fileContents } = req.body;
        const isChapterMode = mode === 'chapters';
        const isJSON5 = format === 'json5';
        if (isChapterMode) {
            if (!chapters || typeof chapters !== 'object') {
                return res.status(400).json({ error: 'No chapter content provided' });
            }
        } else if (isJSON5) {
            if (!fileContents || typeof fileContents !== 'object') {
                return res.status(400).json({ error: 'No JSON5 file contents provided' });
            }
        } else if (!content) {
            return res.status(400).json({ error: 'No SNBT content provided' });
        }

        const send = openSse(res);

        try {
            const tgtLang = lang || 'fr';
            const translator = createTranslator({
                srcLang: 'en',
                tgtLang: tgtLang,
                cachePath: path.join(__dirname, '..', 'data', 'minecraft', 'cache.json'),
                concurrency: 10,
                delayMs: 50,
                logger: (msg) => send('log', { text: msg }),
                glossaryFile: 'minecraft/glossary.json',
                tagFile: 'minecraft/tag.json',
            });

            if (isChapterMode) {
                const allTexts = [];
                for (const [file, fileContent] of Object.entries(chapters)) {
                    let extracted;
                    if (file.endsWith('.json5')) {
                        extracted = extractChapterTranslatableJSON5(fileContent, file);
                    } else {
                        extracted = extractChapterTranslatable(fileContent, file);
                    }
                    for (const e of extracted) allTexts.push(e.text);
                }
                const uniqueTexts = [...new Set(allTexts)];

                send('log', { text: `⛏ FTBQuest (chapitres) — ${instance || 'Instance'} — ${uniqueTexts.length} chaînes` });
                send('log', { text: `[TOTAL_STRINGS:${uniqueTexts.length}]` });

                let done = 0;
                const total = uniqueTexts.length;
                let cachedCount = 0;
                let translatedCount = 0;

                const results = await translator.translateBatch(uniqueTexts, (original, result, fromCache, err, meta) => {
                    done++;
                    if (fromCache) cachedCount++;
                    else translatedCount++;
                    send('progress', { current: done, total, text: original.substring(0, 60) });
                    send('translation_item', { original, translated: result, fromCache, provider: meta && meta.provider, sent: meta && meta.sent });
                });

                const translatedChapters = {};
                for (const [file, fileContent] of Object.entries(chapters)) {
                    if (file.endsWith('.json5')) {
                        // Apply translations to JSON5 chapter file
                        translatedChapters[file] = applyChapterTranslationsJSON5(fileContent, results);
                    } else {
                        translatedChapters[file] = applyChapterTranslations(fileContent, results);
                    }
                }

                translator.flush();
                send('log', { text: `\n✅ FTBQuest (chapitres) terminé: ${translatedCount} traduites, ${cachedCount} en cache` });
                send('done', {
                    source: 'ftbquest',
                    mode: 'chapters',
                    format: isJSON5 ? 'json5' : 'snbt',
                    translated: translatedCount,
                    cached: cachedCount,
                    total,
                    chapters: translatedChapters,
                    instance: instance || '',
                });
                res.end();
                return;
            }

            // Lang mode
            let entries;
            if (isJSON5) {
                // Parse all JSON5 lang files and merge entries
                entries = [];
                for (const [relPath, fileContent] of Object.entries(fileContents)) {
                    const parsed = parseJSON5Lang(fileContent);
                    for (const e of parsed) {
                        e._sourceFile = relPath;
                        entries.push(e);
                    }
                }
            } else {
                entries = parseSNBT(content);
            }

            const translatable = flattenSNBTEntries(entries);

            send('log', { text: `⛏ FTBQuest — ${instance || 'Instance'} — ${translatable.length} chaînes` });
            send('log', { text: `[TOTAL_STRINGS:${translatable.length}]` });

            const uniqueTexts = [...new Set(translatable.map(e => e.text))];
            let done = 0;
            const total = uniqueTexts.length;
            let cachedCount = 0;
            let translatedCount = 0;

            const results = await translator.translateBatch(uniqueTexts, (original, result, fromCache, err, meta) => {
                done++;
                if (fromCache) cachedCount++;
                else translatedCount++;
                send('progress', { current: done, total, text: original.substring(0, 60) });
                send('translation_item', { original, translated: result, fromCache, provider: meta && meta.provider, sent: meta && meta.sent });
            });

            const translatedEntries = entries.map(entry => {
                if (entry.isArray) {
                    const newValues = entry.value.map(line => {
                        if (!line || !line.trim()) return line;
                        const t = results.get(line);
                        return (t != null && t !== '') ? t : line;
                    });
                    return { ...entry, value: newValues };
                }
                if (!entry.value || !entry.value.trim()) return entry;
                const t = results.get(entry.value);
                return (t != null && t !== '') ? { ...entry, value: t } : entry;
            });

            if (isJSON5) {
                // Group translated entries by source file and write each as JSON5
                const outputFileContents = {};
                const byFile = {};
                for (const entry of translatedEntries) {
                    const srcFile = entry._sourceFile || 'unknown.json5';
                    if (!byFile[srcFile]) byFile[srcFile] = [];
                    byFile[srcFile].push(entry);
                }
                for (const [relPath, fileEntries] of Object.entries(byFile)) {
                    outputFileContents[relPath] = writeJSON5Lang(fileEntries) + '\n';
                }

                translator.flush();
                send('log', { text: `\n✅ FTBQuest terminé: ${translatedCount} traduites, ${cachedCount} en cache` });
                send('done', {
                    source: 'ftbquest',
                    mode: 'lang',
                    format: 'json5',
                    translated: translatedCount,
                    cached: cachedCount,
                    total,
                    fileContents: outputFileContents,
                    instance: instance || '',
                });
                res.end();
                return;
            }

            const outputSNBT = writeSNBT(translatedEntries);

            translator.flush();
            send('log', { text: `\n✅ FTBQuest terminé: ${translatedCount} traduites, ${cachedCount} en cache` });
            send('done', {
                source: 'ftbquest',
                mode: 'lang',
                format: 'snbt',
                translated: translatedCount,
                cached: cachedCount,
                total,
                snbt: outputSNBT,
                filename: 'fr_fr.snbt',
                instance: instance || '',
            });
            res.end();
        } catch (e) {
            send('error', { message: e.message });
            res.end();
        }
    });

    /** Translate KubeJS JSON lang entries (SSE) */
    app.post('/api/minecraft/kubejs-translate', async (req, res) => {
        const { entries, lang, instance } = req.body;
        if (!entries || typeof entries !== 'object') return res.status(400).json({ error: 'No entries provided' });

        const send = openSse(res);

        try {
            // entries = { "mod::key": "value", ... }
            const textsToTranslate = [];
            for (const [, v] of Object.entries(entries)) {
                if (typeof v !== 'string' || !v.trim()) continue;
                if (isMinecraftJsonComponent(v)) collectJsonComponentTexts(v, textsToTranslate);
                else textsToTranslate.push(v);
            }
            const uniqueTexts = [...new Set(textsToTranslate)];

            send('log', { text: `🧊 KubeJS — ${instance || 'Instance'} — ${uniqueTexts.length} chaînes` });
            send('log', { text: `[TOTAL_STRINGS:${uniqueTexts.length}]` });

            const tgtLang = lang || 'fr';
            const translator = createTranslator({
                srcLang: 'en',
                tgtLang: tgtLang,
                cachePath: path.join(__dirname, '..', 'data', 'minecraft', 'cache.json'),
                concurrency: 10,
                delayMs: 50,
                logger: (msg) => send('log', { text: msg }),
                glossaryFile: 'minecraft/glossary.json',
                tagFile: 'minecraft/tag.json',
            });

            let done = 0;
            const total = uniqueTexts.length;
            let cachedCount = 0;
            let translatedCount = 0;

            const results = await translator.translateBatch(uniqueTexts, (original, result, fromCache, err, meta) => {
                done++;
                if (fromCache) cachedCount++;
                else translatedCount++;
                send('progress', { current: done, total, text: original.substring(0, 60) });
                send('translation_item', { original, translated: result, fromCache, provider: meta && meta.provider, sent: meta && meta.sent });
            });

            // Build output JSON per mod
            const modOutputs = {};
            for (const [compoundKey, originalText] of Object.entries(entries)) {
                const sepIdx = compoundKey.indexOf('::');
                const mod = compoundKey.substring(0, sepIdx);
                const realKey = compoundKey.substring(sepIdx + 2);

                if (!modOutputs[mod]) modOutputs[mod] = {};
                if (isMinecraftJsonComponent(originalText)) {
                    modOutputs[mod][realKey] = translateJsonComponentValue(originalText, results);
                } else {
                    const translation = results.get(originalText);
                    modOutputs[mod][realKey] = (translation && originalText.trim()) ? translation : originalText;
                }
            }

            translator.flush();
            send('log', { text: `\n✅ KubeJS terminé: ${translatedCount} traduites, ${cachedCount} en cache` });
            send('log', { text: `   Mods: ${Object.keys(modOutputs).join(', ')}` });
            send('done', {
                source: 'kubejs',
                translated: translatedCount,
                cached: cachedCount,
                total,
                modOutputs, // { modName: { key: translatedValue } }
                instance: instance || '',
            });
            res.end();
        } catch (e) {
            send('error', { message: e.message });
            res.end();
        }
    });

    /** Save FTBQuest SNBT/JSON5 to instance (lang file/dir or chapter files) */
    app.post('/api/minecraft/ftbquest-save', async (req, res) => {
        try {
            const { instance, snbt, chapters, mode, locale, format, fileContents } = req.body;
            if (!instance) return res.status(400).json({ error: 'Instance requise' });

            const instancesPath = getMinecraftInstancesPath();
            const instanceDir = resolveInstanceDir(instancesPath, instance);
            const info = await scanFtbQuestInfo(instanceDir);

            if (!info) {
                return res.status(404).json({ error: 'FTB Quests introuvable pour cette instance' });
            }

            const isJSON5 = format === 'json5' || info.format === 'json5';

            if (mode === 'chapters' || info.mode === 'chapters') {
                if (!chapters || typeof chapters !== 'object') {
                    return res.status(400).json({ error: 'Contenu chapitres requis' });
                }

                const saved = [];
                for (const [file, content] of Object.entries(chapters)) {
                    if (!info.chapterFiles.includes(file)) continue;
                    const outFile = path.join(info.chaptersDir, file);
                    await fsp.writeFile(outFile, repairJsonTypography(content), 'utf8');
                    saved.push(outFile);
                }

                if (saved.length === 0) {
                    return res.status(400).json({ error: 'Aucun fichier chapitre valide à enregistrer' });
                }

                return res.json({ ok: true, mode: 'chapters', saved });
            }

            const tgtLocale = locale || 'fr_fr';
            const langDir = info.langDir;

            if (!langDir || !fs.existsSync(langDir)) {
                return res.status(404).json({ error: `Dossier lang introuvable: ${langDir}` });
            }

            if (isJSON5 && fileContents) {
                // JSON5 format: write each file to lang/<locale>/<relPath>
                const dstFolder = path.join(langDir, tgtLocale);
                const saved = [];
                for (const [relPath, content] of Object.entries(fileContents)) {
                    const outPath = path.join(dstFolder, relPath);
                    await fsp.mkdir(path.dirname(outPath), { recursive: true });
                    await fsp.writeFile(outPath, content, 'utf8');
                    saved.push(outPath);
                }
                return res.json({ ok: true, mode: 'lang', format: 'json5', saved, folderFiles: saved.length });
            }

            // SNBT format
            if (!snbt) return res.status(400).json({ error: 'Contenu SNBT requis' });

            let toWrite = snbt;
            let entries = [];
            try {
                entries = parseSNBT(snbt);
                if (entries.length) toWrite = writeSNBT(entries);
            } catch {}

            const outFile = path.join(langDir, `${tgtLocale}.snbt`);
            await fsp.writeFile(outFile, toWrite, 'utf8');
            const folderFiles = entries.length
                ? await writeFtbLocaleFolder(langDir, tgtLocale, entries)
                : [];
            res.json({ ok: true, mode: 'lang', path: outFile, folderFiles: folderFiles.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Repair corrupted JSON typography (NBSP before colons) in FTB chapter files */
    app.post('/api/minecraft/ftbquest-repair-chapters', async (req, res) => {
        try {
            const { instance } = req.body;
            if (!instance) return res.status(400).json({ error: 'Instance requise' });

            const instancesPath = getMinecraftInstancesPath();
            const instanceDir = resolveInstanceDir(instancesPath, instance);
            const info = await scanFtbQuestInfo(instanceDir);
            if (!info || info.mode !== 'chapters') {
                return res.status(404).json({ error: 'Mode chapitres introuvable pour cette instance' });
            }

            const repaired = [];
            for (const file of info.chapterFiles) {
                const filePath = path.join(info.chaptersDir, file);
                const content = await fsp.readFile(filePath, 'utf8');
                const fixed = repairJsonTypography(content);
                if (fixed !== content) {
                    await fsp.writeFile(filePath, fixed, 'utf8');
                    repaired.push(file);
                }
            }

            res.json({ ok: true, repaired, count: repaired.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Save KubeJS JSON lang files to instance */
    app.post('/api/minecraft/kubejs-save', async (req, res) => {
        try {
            const { instance, modOutputs, locale } = req.body;
            if (!instance || !modOutputs) return res.status(400).json({ error: 'Instance et données requises' });

            const tgtLocale = locale || 'fr_fr';
            const instancesPath = getMinecraftInstancesPath();
            const assetsDir = path.join(mcRoot(resolveInstanceDir(instancesPath, instance)), 'kubejs', 'assets');
            const saved = [];

            for (const [mod, translations] of Object.entries(modOutputs)) {
                safeModId(mod);
                const langDir = path.join(assetsDir, mod, 'lang');
                if (!fs.existsSync(langDir)) {
                    await fsp.mkdir(langDir, { recursive: true });
                }
                const outFile = path.join(langDir, `${tgtLocale}.json`);
                await fsp.writeFile(outFile, JSON.stringify(translations, null, 2), 'utf8');
                saved.push({ mod, path: outFile, entries: Object.keys(translations).length });
            }

            res.json({ ok: true, saved });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Download translated SNBT */
    app.post('/api/minecraft/export-snbt', (req, res) => {
        const { snbt, filename } = req.body;
        if (!snbt) return res.status(400).json({ error: 'No SNBT content' });

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename || 'fr_fr.snbt'}"`);
        res.send(snbt);
    });

    /** Scan mods for translation status */
    app.get('/api/minecraft/mods-scan', async (req, res) => {
        try {
            const { instance } = req.query;
            if (!instance) return res.status(400).json({ error: 'Instance requise' });

            const instancesPath = getMinecraftInstancesPath();
            const instanceDir = resolveInstanceDir(instancesPath, instance);
            if (!fs.existsSync(instanceDir)) {
                return res.status(404).json({ error: `Instance introuvable: ${instance}` });
            }

            const mods = await scanModJars(instanceDir);

            // Check for existing resource pack translations (FR_Traduction.zip or FR_Traduction_*.zip)
            const rpDir = path.join(mcRoot(instanceDir), 'resourcepacks');
            const rpFiles = listFrTraductionPacks(rpDir);
            const hasResourcePack = rpFiles.length > 0;

            let rpTranslations = 0;
            for (const packName of rpFiles) {
                try {
                    const rpZip = new AdmZip(path.join(rpDir, packName));
                    const rpEntries = rpZip.getEntries().filter(e =>
                        /\/lang\/(fr_fr\.json|fr_FR\.lang)$/i.test(e.entryName)
                    );
                    for (const e of rpEntries) {
                        try {
                            if (e.entryName.toLowerCase().endsWith('.lang')) {
                                rpTranslations += Object.keys(parseLangFile(e.getData())).length;
                            } else {
                                rpTranslations += Object.keys(JSON.parse(e.getData().toString('utf8'))).length;
                            }
                        } catch {}
                    }
                } catch {}
            }

            const needTranslation = mods.filter(m => !m.isComplete);
            const totalMissing = needTranslation.reduce((s, m) => s + m.missing, 0);

            res.json({
                instance,
                totalMods: mods.length,
                modsWithFrench: mods.filter(m => m.hasFrench).length,
                modsComplete: mods.filter(m => m.isComplete).length,
                needTranslation: needTranslation.length,
                totalEntries: mods.reduce((s, m) => s + m.enCount, 0),
                totalMissing,
                hasResourcePack,
                rpTranslations,
                mods,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /**
     * Categorise a lang key into one of: 'names' | 'gui' | 'desc' | 'other'
     * Used to apply per-mod category filters during translation.
     */
    function categorizeKey(key) {
        const k = key.toLowerCase();
        // Descriptions / Tooltips first (some item.X.tooltip sub-keys exist)
        if (/\.(tooltip|desc|description|info|lore|flavor|hint)($|\.)/.test(k) ||
            /^(tooltip|description)\b/.test(k)) return 'desc';
        // Names: items, blocks, entities, enchantments, biomes, potions…
        if (/^(item|block|tile|entity|entities|mob|enchantment|enchant|biome|effect|potion|attribute|fluid|itemgroup|group|creativetab)\b/.test(k)) return 'names';
        // GUI / interface
        if (/^(gui|screen|container|button|hud|tab|chat|message|jei|nei|config|menu|command|key)\b/.test(k) ||
            /\.(gui|screen|button|label|header)($|\.)/.test(k)) return 'gui';
        return 'other';
    }

    /** Translate mod lang entries from JARs (SSE) */
    app.post('/api/minecraft/mods-translate', async (req, res) => {
        const { instance, modIds, lang, forcePatchouli, modFilters } = req.body;
        if (!instance) return res.status(400).json({ error: 'Instance requise' });
        if (!modIds || !Array.isArray(modIds) || modIds.length === 0) {
            return res.status(400).json({ error: 'Aucun mod sélectionné' });
        }

        const send = openSse(res);

        try {
            const instancesPath = getMinecraftInstancesPath();
            const modsDir = path.join(mcRoot(resolveInstanceDir(instancesPath, instance)), 'mods');
            if (!fs.existsSync(modsDir)) {
                send('error', { message: 'Dossier mods introuvable' });
                return res.end();
            }

            const tgtLang = lang || 'fr';
            const translator = createTranslator({
                srcLang: 'en',
                tgtLang: tgtLang,
                cachePath: path.join(__dirname, '..', 'data', 'minecraft', 'cache.json'),
                concurrency: 10,
                delayMs: 50,
                logger: (msg) => send('log', { text: msg }),
                glossaryFile: 'minecraft/glossary.json',
                tagFile: 'minecraft/tag.json',
            });

            // Collect all texts from selected mods
            const modsData = {}; // modId -> { en, existingFr, jar, patchouli }
            const jars = (await fsp.readdir(modsDir)).filter(f => f.endsWith('.jar'));

            for (const jarName of jars) {
                try {
                    const zip = new AdmZip(path.join(modsDir, jarName));
                    const zipEntries = zip.getEntries();

                    for (const modId of modIds) {
                        // Support 1.13+ JSON and 1.12 .lang format
                        let enEntry = zipEntries.find(e => e.entryName === `assets/${modId}/lang/en_us.json`);
                        let legacyFmt = false;
                        if (!enEntry) {
                            enEntry = zipEntries.find(e =>
                                e.entryName === `assets/${modId}/lang/en_US.lang` ||
                                e.entryName === `assets/${modId}/lang/en_us.lang`
                            );
                            if (enEntry) legacyFmt = true;
                        }
                        const patchouli = extractPatchouliFromZip(zipEntries, modId, 'en_us');
                        if (!enEntry && patchouli.length === 0) continue;

                        if (!modsData[modId]) {
                            modsData[modId] = {
                                en: {},
                                existingFr: {},
                                jar: jarName,
                                patchouli: [],
                                existingFrPatchouliByRel: {},
                                legacy: legacyFmt,
                            };
                        }

                        if (enEntry) {
                            try {
                                const enParsed = legacyFmt
                                    ? parseLangFile(enEntry.getData())
                                    : JSON.parse(enEntry.getData().toString('utf8'));
                                for (const [k, v] of Object.entries(enParsed)) {
                                    if (!(k in modsData[modId].en)) modsData[modId].en[k] = v;
                                }
                            } catch {}
                        }

                        // Find french — fr_FR.lang (1.12) or fr_fr.json (1.13+)
                        let frEntry = zipEntries.find(e => e.entryName === `assets/${modId}/lang/fr_fr.json`);
                        if (!frEntry) {
                            frEntry = zipEntries.find(e =>
                                e.entryName === `assets/${modId}/lang/fr_FR.lang` ||
                                e.entryName === `assets/${modId}/lang/fr_fr.lang`
                            );
                        }
                        if (frEntry) {
                            try {
                                const frParsed = legacyFmt
                                    ? parseLangFile(frEntry.getData())
                                    : JSON.parse(frEntry.getData().toString('utf8'));
                                for (const [k, v] of Object.entries(frParsed)) {
                                    if (!(k in modsData[modId].existingFr)) modsData[modId].existingFr[k] = v;
                                }
                            } catch {}
                        }

                        // Append patchouli entries from this JAR
                        modsData[modId].patchouli.push(...patchouli);

                        // Existing fr_fr Patchouli files (skipped if forcePatchouli=true)
                        if (!forcePatchouli) {
                            const existingPatchouliFr = extractPatchouliFromZip(zipEntries, modId, 'fr_fr');
                            for (const p of existingPatchouliFr) {
                                if (!modsData[modId].existingFrPatchouliByRel[p.relPath]) {
                                    modsData[modId].existingFrPatchouliByRel[p.relPath] = p.json;
                                }
                            }
                        }
                    }
                } catch {}
            }

            if (Object.keys(modsData).length === 0) {
                send('error', { message: 'Aucun mod trouvé parmi les sélectionnés' });
                return res.end();
            }

            // ── Build a global lang key index by scanning ALL mod JARs ──
            // Patchouli entries often reference lang keys (e.g. "starbunclemania.page.foo")
            // defined by *another* mod (addons). We need to resolve those keys to their
            // English value so we can translate them and inject into the right mod's fr_fr.json.
            const langKeyIndex = {}; // key -> { modId, enValue }
            const langKeyExistingFr = {}; // key -> existing fr_fr value from any JAR (for skip detection)
            for (const jarName of jars) {
                try {
                    const zip = new AdmZip(path.join(modsDir, jarName));
                    for (const e of zip.getEntries()) {
                        const m = e.entryName.match(/^assets\/([^/]+)\/lang\/(en_us|fr_fr)\.json$/);
                        if (!m) continue;
                        let json;
                        try { json = JSON.parse(e.getData().toString('utf8')); } catch { continue; }
                        for (const [k, v] of Object.entries(json)) {
                            if (typeof v !== 'string') continue;
                            if (m[2] === 'en_us') {
                                if (!langKeyIndex[k]) langKeyIndex[k] = { modId: m[1], enValue: v };
                            } else {
                                if (!langKeyExistingFr[k]) langKeyExistingFr[k] = v;
                            }
                        }
                    }
                } catch {}
            }

            // Count Patchouli lang-key references that we can resolve
            let patchouliLangKeyRefs = 0;
            let patchouliLangKeyUnresolved = 0;
            for (const data of Object.values(modsData)) {
                for (const p of data.patchouli) {
                    for (const s of p.strings) {
                        if (!s.isLangKey) continue;
                        if (langKeyIndex[s.value]) patchouliLangKeyRefs++;
                        else patchouliLangKeyUnresolved++;
                    }
                }
            }

            // Collect all unique English texts that need translation
            const textsToTranslate = [];
            for (const [modId, data] of Object.entries(modsData)) {
                const mfCats = modFilters && modFilters[modId]; // e.g. ['names','gui','desc','patchouli','other'] or null=all
                // Lang texts
                for (const [key, enValue] of Object.entries(data.en)) {
                    if (typeof enValue !== 'string' || !enValue.trim()) continue;
                    if (data.existingFr[key]) continue;
                    if (mfCats && !mfCats.includes(categorizeKey(key))) continue;
                    if (isMinecraftJsonComponent(enValue)) {
                        collectJsonComponentTexts(enValue, textsToTranslate);
                        continue;
                    }
                    textsToTranslate.push(enValue);
                }
                // Patchouli texts
                const doPatchouli = !mfCats || mfCats.includes('patchouli');
                if (doPatchouli) {
                    for (const p of data.patchouli) {
                        for (const s of p.strings) {
                            if (s.isLangKey) {
                                const idx = langKeyIndex[s.value];
                                if (!idx) continue;
                                if (!forcePatchouli && langKeyExistingFr[s.value]) continue;
                                textsToTranslate.push(idx.enValue);
                            } else {
                                textsToTranslate.push(s.value);
                            }
                        }
                    }
                }
            }

            const uniqueTexts = [...new Set(textsToTranslate)];
            const totalToTranslate = uniqueTexts.length;

            const patchouliFileCount = Object.values(modsData).reduce((sum, d) => sum + d.patchouli.length, 0);
            send('log', { text: `🔧 Mods — ${Object.keys(modsData).length} mod(s) sélectionné(s)` });
            if (patchouliFileCount > 0) {
                send('log', { text: `📖 ${patchouliFileCount} fichier(s) Patchouli détecté(s)` });
                if (patchouliLangKeyRefs > 0) send('log', { text: `   🔑 ${patchouliLangKeyRefs} clé(s) i18n résolue(s) via lang/en_us.json` });
                if (patchouliLangKeyUnresolved > 0) send('log', { text: `   ⚠ ${patchouliLangKeyUnresolved} clé(s) introuvable(s) dans les JARs` });
            }
            send('log', { text: `📝 ${totalToTranslate} chaînes uniques à traduire (${textsToTranslate.length} total)` });
            send('log', { text: `[TOTAL_STRINGS:${totalToTranslate}]` });

            let done = 0;
            let cachedCount = 0;
            let translatedCount = 0;

            const results = await translator.translateBatch(uniqueTexts, (original, result, fromCache) => {
                done++;
                if (fromCache) cachedCount++;
                else translatedCount++;
                send('progress', { current: done, total: totalToTranslate, text: original.substring(0, 60) });
            });

            // Build per-mod fr_fr.json output + Patchouli outputs
            const modOutputs = {};
            const patchouliOutputs = {}; // modId -> [{ relPath, book, json }]
            for (const [modId, data] of Object.entries(modsData)) {
                const mfCats = modFilters && modFilters[modId];
                // ── Lang ──
                const frJson = { ...data.existingFr };
                for (const [key, enValue] of Object.entries(data.en)) {
                    if (typeof enValue !== 'string' || !enValue.trim()) continue;
                    if (frJson[key]) continue;
                    if (mfCats && !mfCats.includes(categorizeKey(key))) continue;
                    if (isMinecraftJsonComponent(enValue)) {
                        frJson[key] = translateJsonComponentValue(enValue, results);
                        continue;
                    }
                    const translation = results.get(enValue);
                    if (translation) frJson[key] = translation;
                }
                // Merge, preserving any lang-keys already routed here from another mod's patchouli loop
                modOutputs[modId] = { ...frJson, ...(modOutputs[modId] || {}) };

                // ── Patchouli ──
                const doPatchouliOut = !mfCats || mfCats.includes('patchouli');
                const pOut = [];
                if (doPatchouliOut) for (const p of data.patchouli) {
                    const baseJson = data.existingFrPatchouliByRel[p.relPath]
                        ? JSON.parse(JSON.stringify(data.existingFrPatchouliByRel[p.relPath]))
                        : JSON.parse(JSON.stringify(p.json));
                    let literalApplied = 0;
                    for (const s of p.strings) {
                        if (s.isLangKey) {
                            // Route to the source mod's lang/fr_fr.json instead of the entry file
                            const idx = langKeyIndex[s.value];
                            if (!idx) continue;
                            if (!forcePatchouli && langKeyExistingFr[s.value]) continue;
                            const tr = results.get(idx.enValue);
                            if (!tr || tr === idx.enValue) continue;
                            if (!modOutputs[idx.modId]) modOutputs[idx.modId] = {};
                            if (!modOutputs[idx.modId][s.value]) modOutputs[idx.modId][s.value] = tr;
                        } else {
                            const tr = results.get(s.value);
                            if (!tr || tr === s.value) continue;
                            try { setByPath(baseJson, s.path, tr); literalApplied++; } catch {}
                        }
                    }
                    // Only emit the entry file if it has literal-text translations to write back
                    if (literalApplied > 0) pOut.push({ relPath: p.relPath, book: p.book, json: baseJson });
                }
                if (pOut.length > 0) patchouliOutputs[modId] = pOut;

                const langEntries = Object.keys(frJson).length;
                const langTotal = Object.keys(data.en).length;
                const patchouliMsg = pOut.length > 0 ? `, ${pOut.length} fichier(s) Patchouli` : '';
                send('log', { text: `  ✓ ${modId}: ${langEntries}/${langTotal} entrées${patchouliMsg}` });
            }

            translator.flush();
            // Build set of legacy (1.12 .lang format) modIds
            const legacyMods = Object.entries(modsData)
                .filter(([, d]) => d.legacy)
                .map(([id]) => id);
            send('done', {
                source: 'mods',
                translated: translatedCount,
                cached: cachedCount,
                total: totalToTranslate,
                modCount: Object.keys(modOutputs).length,
                modOutputs,
                patchouliOutputs,
                legacyMods,
            });
            res.end();
        } catch (e) {
            send('error', { message: e.message });
            res.end();
        }
    });

    /** Build EN keys map from all mod JARs in an instance */
    async function buildEnMap(instanceDir) {
        const modsDir = path.join(mcRoot(instanceDir), 'mods');
        const enMap = {}; // modId -> { keys: {key: val}, legacy: bool }
        if (!fs.existsSync(modsDir)) return enMap;
        const jars = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
        for (const jarName of jars) {
            try {
                const zip = new AdmZip(path.join(modsDir, jarName));
                for (const le of zip.getEntries()) {
                    const m = le.entryName.match(/^assets\/([^/]+)\/lang\/(en_us\.json|en_US\.lang|en_us\.lang)$/);
                    if (!m) continue;
                    const modId = m[1];
                    const isLegacy = le.entryName.endsWith('.lang');
                    try {
                        const parsed = isLegacy ? parseLangFile(le.getData()) : JSON.parse(le.getData().toString('utf8'));
                        enMap[modId] = { keys: parsed, legacy: isLegacy };
                    } catch {}
                }
            } catch {}
        }
        return enMap;
    }

    /** Verify existing resource pack(s) — detect broken/empty/untranslated entries */
    app.get('/api/minecraft/mods-verify-pack', async (req, res) => {
        try {
            const { instance } = req.query;
            if (!instance) return res.status(400).json({ error: 'Instance requise' });

            const instancesPath = getMinecraftInstancesPath();
            const instanceDir = resolveInstanceDir(instancesPath, instance);
            if (!fs.existsSync(instanceDir)) return res.status(404).json({ error: 'Instance introuvable' });

            const rpDir = path.join(mcRoot(instanceDir), 'resourcepacks');
            const rpFiles = fs.existsSync(rpDir)
                ? fs.readdirSync(rpDir).filter(f => /^FR_Traduction.*\.zip$/i.test(f))
                : [];

            if (rpFiles.length === 0) return res.json({ hasPack: false, packs: [] });

            const enMap = await buildEnMap(instanceDir);
            const results = [];

            for (const packName of rpFiles) {
                const packPath = path.join(rpDir, packName);
                const packResult = { packName, mods: [], totalKeys: 0, emptyCount: 0, untranslatedCount: 0, missingCount: 0 };

                try {
                    const packZip = new AdmZip(packPath);
                    const frEntries = packZip.getEntries().filter(e =>
                        /^assets\/[^/]+\/lang\/(fr_fr\.json|fr_FR\.lang)$/.test(e.entryName)
                    );

                    for (const fe of frEntries) {
                        const parts = fe.entryName.split('/');
                        const modId = parts[1];
                        const isLegacy = fe.entryName.endsWith('.lang');

                        let frKeys = {};
                        try {
                            frKeys = isLegacy ? parseLangFile(fe.getData()) : JSON.parse(fe.getData().toString('utf8'));
                        } catch (parseErr) {
                            packResult.mods.push({ modId, error: 'JSON invalide: ' + parseErr.message, totalInPack: 0, emptyCount: 0, untranslatedCount: 0, missingCount: 0, hasIssues: true, sampleIssues: [] });
                            continue;
                        }

                        const enInfo = enMap[modId];
                        let emptyCount = 0, untranslatedCount = 0;
                        const sampleIssues = [];

                        for (const [key, val] of Object.entries(frKeys)) {
                            if (val === '' || val === null || val === undefined) {
                                emptyCount++;
                                if (sampleIssues.length < 5) sampleIssues.push({ key, type: 'vide', fr: '' });
                            } else if (enInfo && enInfo.keys[key] !== undefined && val === enInfo.keys[key]) {
                                untranslatedCount++;
                                if (sampleIssues.length < 5) sampleIssues.push({ key, type: 'non traduit', fr: val });
                            }
                        }

                        const missingCount = enInfo
                            ? Math.max(0, Object.keys(enInfo.keys).length - Object.keys(frKeys).length)
                            : 0;

                        packResult.totalKeys += Object.keys(frKeys).length;
                        packResult.emptyCount += emptyCount;
                        packResult.untranslatedCount += untranslatedCount;
                        packResult.missingCount += missingCount;

                        packResult.mods.push({
                            modId,
                            totalInPack: Object.keys(frKeys).length,
                            emptyCount,
                            untranslatedCount,
                            missingCount,
                            hasIssues: emptyCount > 0 || untranslatedCount > 0,
                            sampleIssues,
                        });
                    }
                } catch (e) {
                    packResult.error = 'Erreur lecture: ' + e.message;
                }

                results.push(packResult);
            }

            res.json({ hasPack: true, packs: results });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Repair existing resource pack — remove empty/untranslated entries */
    app.post('/api/minecraft/mods-repair-pack', async (req, res) => {
        try {
            const { instance, packName } = req.body;
            if (!instance) return res.status(400).json({ error: 'Instance requise' });

            const instancesPath = getMinecraftInstancesPath();
            const instanceDir = resolveInstanceDir(instancesPath, instance);
            if (!fs.existsSync(instanceDir)) return res.status(404).json({ error: 'Instance introuvable' });

            const rpDir = path.join(mcRoot(instanceDir), 'resourcepacks');
            const rpFiles = fs.existsSync(rpDir)
                ? fs.readdirSync(rpDir).filter(f => /^FR_Traduction.*\.zip$/i.test(f))
                : [];

            const targetPack = packName ? rpFiles.find(f => f === packName) : rpFiles[0];
            if (!targetPack) return res.status(404).json({ error: 'Pack introuvable' });

            const packPath = path.join(rpDir, targetPack);
            const enMap = await buildEnMap(instanceDir);

            const packZip = new AdmZip(packPath);
            const newZip = new AdmZip();
            let removedEmpty = 0, removedUntranslated = 0;
            const fixedMods = [];

            for (const entry of packZip.getEntries()) {
                const name = entry.entryName;
                const data = entry.getData();
                const frMatch = name.match(/^assets\/([^/]+)\/lang\/(fr_fr\.json|fr_FR\.lang)$/);

                if (frMatch) {
                    const modId = frMatch[1];
                    const isLegacy = name.endsWith('.lang');
                    const enInfo = enMap[modId];
                    let frKeys = {};
                    try {
                        frKeys = isLegacy ? parseLangFile(data) : JSON.parse(data.toString('utf8'));
                    } catch {
                        newZip.addFile(name, data);
                        continue;
                    }

                    const cleaned = {};
                    let modEmpty = 0, modUntranslated = 0;
                    for (const [key, val] of Object.entries(frKeys)) {
                        if (val === '' || val === null || val === undefined) {
                            modEmpty++;
                        } else if (enInfo && enInfo.keys[key] !== undefined && val === enInfo.keys[key]) {
                            modUntranslated++;
                        } else {
                            cleaned[key] = val;
                        }
                    }

                    removedEmpty += modEmpty;
                    removedUntranslated += modUntranslated;
                    if (modEmpty > 0 || modUntranslated > 0) {
                        fixedMods.push({ modId, removedEmpty: modEmpty, removedUntranslated: modUntranslated });
                    }

                    if (isLegacy) {
                        newZip.addFile(name, Buffer.from(Object.entries(cleaned).map(([k, v]) => `${k}=${v}`).join('\n'), 'utf8'));
                    } else {
                        newZip.addFile(name, Buffer.from(JSON.stringify(cleaned, null, 2), 'utf8'));
                    }
                } else {
                    newZip.addFile(name, data);
                }
            }

            newZip.writeZip(packPath);

            res.json({ ok: true, packName: targetPack, removedEmpty, removedUntranslated, fixedMods });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Generate and install a resource pack with mod translations */
    app.post('/api/minecraft/mods-resourcepack', async (req, res) => {
        try {
            const { instance, modOutputs, patchouliOutputs, legacyMods } = req.body;
            if (!instance || !modOutputs) return res.status(400).json({ error: 'Instance et données requises' });

            const instancesPath = getMinecraftInstancesPath();
            const instanceDir = resolveInstanceDir(instancesPath, instance);
            const rpDir = path.join(mcRoot(instanceDir), 'resourcepacks');

            if (!fs.existsSync(rpDir)) {
                await fsp.mkdir(rpDir, { recursive: true });
            }

            // Read app version
            let appVersion = '1.0.0';
            try {
                const vData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'version.json'), 'utf8'));
                appVersion = vData.version || appVersion;
            } catch {}

            const now = new Date().toISOString().split('T')[0];
            const modIds = Object.keys(modOutputs);
            const modCount = modIds.length;
            const totalEntries = Object.values(modOutputs).reduce((s, v) => s + Object.keys(v).length, 0);
            const patchouliFileCount = patchouliOutputs
                ? Object.values(patchouliOutputs).reduce((s, arr) => s + arr.length, 0)
                : 0;

            // Filename: 1 mod -> FR_Traduction_<modid>.zip, N>1 -> FR_Traduction_<N>mods.zip
            const safeModId = (s) => String(s).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
            const packBaseName = modCount === 1
                ? `FR_Traduction_${safeModId(modIds[0])}.zip`
                : `FR_Traduction_${modCount}mods.zip`;

            // Create resource pack ZIP
            const zip = new AdmZip();

            // pack_format: 3 for 1.12.x (legacy), 34 for 1.21.x
            const isLegacyPack = legacyMods && legacyMods.length > 0 && legacyMods.length === modIds.length;
            const packFormat = isLegacyPack ? 3 : 34;
            const patchouliMsgDesc = patchouliFileCount > 0 ? ` +${patchouliFileCount} Patchouli` : '';
            const packMcmeta = {
                pack: {
                    pack_format: packFormat,
                    description: `§6Traduction FR §7— ${modCount} mod${modCount > 1 ? 's' : ''}, ${totalEntries} entrées${patchouliMsgDesc}\n§8ModLingo-Hub v${appVersion} — ${now}`,
                },
            };
            zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify(packMcmeta, null, 2), 'utf8'));

            // Add each mod's lang file (fr_fr.json for 1.13+, fr_FR.lang for 1.12 legacy)
            for (const [modId, translations] of Object.entries(modOutputs)) {
                const isLegacy = legacyMods && legacyMods.includes(modId);
                if (isLegacy) {
                    // Output .lang format: key=value\n
                    const langContent = Object.entries(translations)
                        .map(([k, v]) => `${k}=${v}`)
                        .join('\n');
                    zip.addFile(`assets/${modId}/lang/fr_FR.lang`, Buffer.from(langContent, 'utf8'));
                } else {
                    const jsonContent = JSON.stringify(translations, null, 2);
                    zip.addFile(`assets/${modId}/lang/fr_fr.json`, Buffer.from(jsonContent, 'utf8'));
                }
            }

            // Add Patchouli book translations
            if (patchouliOutputs) {
                for (const [modId, files] of Object.entries(patchouliOutputs)) {
                    for (const f of files) {
                        // Original: assets/<modId>/patchouli_books/<book>/en_us/<relPath>
                        // Output:   assets/<modId>/patchouli_books/<book>/fr_fr/<relPath>
                        const zipPath = `assets/${modId}/patchouli_books/${f.book}/fr_fr/${f.relPath}`;
                        zip.addFile(zipPath, Buffer.from(JSON.stringify(f.json, null, 2), 'utf8'));
                    }
                }
            }

            // Save the ZIP
            const rpFile = path.join(rpDir, packBaseName);
            zip.writeZip(rpFile);

            const optionsFile = path.join(mcRoot(instanceDir), 'options.txt');
            const activated = await activateResourcePack(optionsFile, packBaseName);

            res.json({
                ok: true,
                path: rpFile,
                fileName: packBaseName,
                modCount,
                totalEntries,
                patchouliFileCount,
                activated,
                packFormat: 34,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Deploy in-game /langue_fr commands via KubeJS server script */
    app.post('/api/minecraft/deploy-commands', async (req, res) => {
        try {
            const { instance } = req.body;
            if (!instance) return res.status(400).json({ error: 'Instance requise' });

            const instancesPath = getMinecraftInstancesPath();
            const instanceDir = resolveInstanceDir(instancesPath, instance);
            if (!fs.existsSync(instanceDir)) {
                return res.status(404).json({ error: `Instance introuvable: ${instance}` });
            }

            const serverScriptsDir = path.join(mcRoot(instanceDir), 'kubejs', 'server_scripts');
            if (!fs.existsSync(serverScriptsDir)) {
                await fsp.mkdir(serverScriptsDir, { recursive: true });
            }

            // Gather info about what's translated
            const ftbLangDir = path.join(mcRoot(instanceDir), 'config', 'ftbquests', 'quests', 'lang');
            const assetsDir = path.join(mcRoot(instanceDir), 'kubejs', 'assets');

            // Build source data for the script
            const sources = [];

            // FTBQuest check — SNBT monolithique (<= MC 1.21) ou dossiers JSON5 (MC 26+)
            if (fs.existsSync(ftbLangDir)) {
                let frCount = 0, enCount = 0;
                const enUsDirCheck = path.join(ftbLangDir, 'en_us');
                if (fs.existsSync(enUsDirCheck) && fs.statSync(enUsDirCheck).isDirectory()) {
                    try {
                        const enScan = await scanJSON5LangDir(ftbLangDir, 'en_us');
                        if (enScan) enCount = enScan.entries.length;
                    } catch {}
                    try {
                        const frScan = await scanJSON5LangDir(ftbLangDir, 'fr_fr');
                        if (frScan) frCount = frScan.entries.length;
                    } catch {}
                } else {
                    const frSnbt = path.join(ftbLangDir, 'fr_fr.snbt');
                    const enSnbt = path.join(ftbLangDir, 'en_us.snbt');
                    if (fs.existsSync(frSnbt)) {
                        try { frCount = parseSNBT(await fsp.readFile(frSnbt, 'utf8')).length; } catch {}
                    }
                    if (fs.existsSync(enSnbt)) {
                        try { enCount = parseSNBT(await fsp.readFile(enSnbt, 'utf8')).length; } catch {}
                    }
                }
                sources.push({ type: 'FTBQuest', id: 'ftbquest', frCount, enCount });
            }

            // KubeJS checks
            if (fs.existsSync(assetsDir)) {
                const modDirs = await fsp.readdir(assetsDir, { withFileTypes: true });
                for (const md of modDirs) {
                    if (!md.isDirectory()) continue;
                    const langDir = path.join(assetsDir, md.name, 'lang');
                    if (!fs.existsSync(langDir)) continue;
                    const enFile = path.join(langDir, 'en_us.json');
                    const frFile = path.join(langDir, 'fr_fr.json');
                    let enCount = 0, frCount = 0;
                    if (fs.existsSync(enFile)) {
                        try { enCount = Object.keys(JSON.parse(await fsp.readFile(enFile, 'utf8'))).length; } catch {}
                    }
                    if (fs.existsSync(frFile)) {
                        try { frCount = Object.keys(JSON.parse(await fsp.readFile(frFile, 'utf8'))).length; } catch {}
                    }
                    sources.push({ type: 'KubeJS', id: md.name, frCount, enCount });
                }
            }

            const rpDirForCmds = path.join(mcRoot(instanceDir), 'resourcepacks');
            for (const packName of listFrTraductionPacks(rpDirForCmds)) {
                try {
                    const rpZip = new AdmZip(path.join(rpDirForCmds, packName));
                    const rpEntries = rpZip.getEntries().filter(e =>
                        /\/lang\/(fr_fr\.json|fr_FR\.lang)$/i.test(e.entryName)
                    );
                    let rpFrTotal = 0;
                    for (const e of rpEntries) {
                        try {
                            if (e.entryName.toLowerCase().endsWith('.lang')) {
                                rpFrTotal += Object.keys(parseLangFile(e.getData())).length;
                            } else {
                                rpFrTotal += Object.keys(JSON.parse(e.getData().toString('utf8'))).length;
                            }
                        } catch {}
                    }
                    sources.push({ type: 'ResourcePack', id: packName.replace(/\.zip$/i, ''), frCount: rpFrTotal, enCount: rpFrTotal });
                } catch {}
            }

            // Read app version
            let appVersion = '1.0.0';
            try {
                const vData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'version.json'), 'utf8'));
                appVersion = vData.version || appVersion;
            } catch {}

            const now = new Date().toISOString().split('T')[0];

            // Generate the KubeJS server script
            const script = `// ═══════════════════════════════════════════════════════════════
// Auto-generated by ModLingo-Hub v${appVersion}
// Date: ${now}
// Commands: /langue_fr Version, /langue_fr Test, /langue_fr Send <joueur>
// ═══════════════════════════════════════════════════════════════

ServerEvents.commandRegistry(event => {
    const { commands: Commands, arguments: Arguments } = event;

    // Sources data (auto-generated)
    const LANG_VERSION = '${appVersion}';
    const LANG_DATE = '${now}';
    const SOURCES = ${JSON.stringify(sources, null, 8)};

    event.register(
        Commands.literal('langue_fr')
            // Pas de .requires() : hasPermission(int) a été supprimé de
            // CommandSourceStack (MC 26.x) et niveau 0 = accessible à tous.
            // ── /langue_fr Version ──
            .then(Commands.literal('Version')
                .executes(ctx => {
                    ctx.source.sendSuccess(
                        Component.string('§6§l══════════════════════════════════'),
                        false
                    );
                    ctx.source.sendSuccess(
                        Component.string('§e§l  Langue FR §r§7— Pack de traduction'),
                        false
                    );
                    ctx.source.sendSuccess(
                        Component.string('§6§l══════════════════════════════════'),
                        false
                    );
                    ctx.source.sendSuccess(
                        Component.string('§f  Version: §a' + LANG_VERSION),
                        false
                    );
                    ctx.source.sendSuccess(
                        Component.string('§f  Date:    §a' + LANG_DATE),
                        false
                    );
                    ctx.source.sendSuccess(
                        Component.string('§f  Outil:   §bModLingo-Hub'),
                        false
                    );
                    ctx.source.sendSuccess(
                        Component.string('§f  Sources: §e' + SOURCES.length + ' §7module(s)'),
                        false
                    );
                    ctx.source.sendSuccess(
                        Component.string('§6§l══════════════════════════════════'),
                        false
                    );
                    return 1;
                })
            )
            // ── /langue_fr Test ──
            .then(Commands.literal('Test')
                .executes(ctx => {
                    ctx.source.sendSuccess(
                        Component.string('§6§l══════════════════════════════════'),
                        false
                    );
                    ctx.source.sendSuccess(
                        Component.string('§e§l  Test des traductions FR'),
                        false
                    );
                    ctx.source.sendSuccess(
                        Component.string('§6§l══════════════════════════════════'),
                        false
                    );

                    let totalFr = 0;
                    let totalEn = 0;
                    let allOk = true;

                    SOURCES.forEach(src => {
                        totalFr += src.frCount;
                        totalEn += src.enCount;
                        const pct = src.enCount > 0 ? Math.round((src.frCount / src.enCount) * 100) : 0;
                        let status, color;
                        if (src.frCount === 0) {
                            status = '§c✘ Non traduit';
                            color = '§c';
                            allOk = false;
                        } else if (src.frCount >= src.enCount) {
                            status = '§a✓ Complet';
                            color = '§a';
                        } else {
                            status = '§e⚠ Partiel (' + pct + '%)';
                            color = '§e';
                            allOk = false;
                        }
                        ctx.source.sendSuccess(
                            Component.string('  ' + color + '■ §f' + src.type + '/' + src.id + ' §7— ' + status + ' §8(' + src.frCount + '/' + src.enCount + ')'),
                            false
                        );
                    });

                    ctx.source.sendSuccess(
                        Component.string('§6§l──────────────────────────────────'),
                        false
                    );

                    const grandPct = totalEn > 0 ? Math.round((totalFr / totalEn) * 100) : 0;
                    if (allOk) {
                        ctx.source.sendSuccess(
                            Component.string('  §a§l✓ Tout est traduit ! §r§7(' + totalFr + '/' + totalEn + ' — ' + grandPct + '%)'),
                            false
                        );
                    } else {
                        ctx.source.sendSuccess(
                            Component.string('  §e§l⚠ Traduction incomplète §r§7(' + totalFr + '/' + totalEn + ' — ' + grandPct + '%)'),
                            false
                        );
                    }

                    ctx.source.sendSuccess(
                        Component.string('§6§l══════════════════════════════════'),
                        false
                    );
                    return 1;
                })
            )
            // ── /langue_fr Send <joueur> ──
            .then(Commands.literal('Send')
                .then(Commands.argument('joueur', Arguments.PLAYERS.create(event))
                    .executes(ctx => {
                        const targets = Arguments.PLAYERS.getResult(ctx, 'joueur');
                        const sender = ctx.source.textName;

                        let totalFr = 0;
                        let totalEn = 0;
                        SOURCES.forEach(src => {
                            totalFr += src.frCount;
                            totalEn += src.enCount;
                        });
                        const grandPct = totalEn > 0 ? Math.round((totalFr / totalEn) * 100) : 0;

                        let count = 0;
                        targets.forEach(target => {
                            target.tell(Component.string('§6§l══════════════════════════════════'));
                            target.tell(Component.string('§e§l  Traduction FR §r§7— partagée par §f' + sender));
                            target.tell(Component.string('§6§l══════════════════════════════════'));
                            target.tell(Component.string('§f  Version: §a' + LANG_VERSION + ' §7(' + LANG_DATE + ')'));
                            target.tell(Component.string('§f  Couverture: §a' + totalFr + '/' + totalEn + ' §7(' + grandPct + '%)'));
                            SOURCES.forEach(src => {
                                const pct = src.enCount > 0 ? Math.round((src.frCount / src.enCount) * 100) : 0;
                                const color = src.frCount === 0 ? '§c' : (src.frCount >= src.enCount ? '§a' : '§e');
                                target.tell(Component.string('  ' + color + '■ §f' + src.type + '/' + src.id + ' §7— ' + color + pct + '%'));
                            });
                            target.tell(Component.string('§7  Les quêtes FTB sont traduites côté serveur.'));
                            target.tell(Component.string('§7  Pour les mods, installe le resource pack FR.'));
                            target.tell(Component.string('§6§l══════════════════════════════════'));
                            count++;
                        });

                        ctx.source.sendSuccess(
                            Component.string('§a✓ Infos de traduction envoyées à §f' + count + ' §ajoueur(s)'),
                            false
                        );
                        return count;
                    })
                )
            )
    );
});
`;

            const outFile = path.join(serverScriptsDir, 'langue_fr_commands.js');
            await fsp.writeFile(outFile, script, 'utf8');

            res.json({ ok: true, path: outFile, sources });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /**
     * Deploy pre-existing translation files (fr_fr.json / fr_fr.snbt / .zip
     * resource pack) to a chosen instance — no translation, just routing.
     * Body: { instance, files: [{ path, data (base64), target? }], activate? }
     * target = 'auto' | 'resourcepack' | 'kubejs' | 'ftbquest' | 'resourcepack-bundle'
     */
    app.post('/api/minecraft/deploy-translations', async (req, res) => {
        try {
            const { instance, files, activate } = req.body || {};
            if (!instance) return res.status(400).json({ error: 'Instance requise' });
            if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: 'Aucun fichier' });

            const instancesPath = getMinecraftInstancesPath();
            const instanceDir = resolveInstanceDir(instancesPath, instance);
            if (!fs.existsSync(instanceDir)) return res.status(404).json({ error: `Instance introuvable: ${instance}` });
            const root = mcRoot(instanceDir);

            const results = [];
            // Files that should be bundled into the FR resource pack
            const rpBundle = []; // { entryName, buffer }

            for (const f of files) {
                if (!f || !f.path || !f.data) {
                    results.push({ path: f && f.path, ok: false, error: 'path/data manquant' });
                    continue;
                }
                const raw = f.path.replace(/\\/g, '/');
                const lower = raw.toLowerCase();
                const ext = path.extname(lower);
                const base = path.basename(lower);
                const buf = Buffer.from(f.data, 'base64');
                let target = f.target || 'auto';

                // ── Auto detect ──
                if (target === 'auto') {
                    if (ext === '.zip') target = 'resourcepack';
                    else if (ext === '.snbt') target = 'ftbquest';
                    else if (/^assets\/[^/]+\/lang\/[^/]+\.json$/.test(lower)) target = 'resourcepack-bundle';
                    else if (ext === '.json') target = 'kubejs';
                    else { results.push({ path: raw, ok: false, error: 'Type non reconnu' }); continue; }
                }

                try {
                    if (target === 'resourcepack') {
                        const rpDir = path.join(root, 'resourcepacks');
                        if (!fs.existsSync(rpDir)) await fsp.mkdir(rpDir, { recursive: true });
                        const destName = path.basename(raw);
                        const destPath = path.join(rpDir, destName);
                        await fsp.writeFile(destPath, buf);
                        results.push({ path: raw, ok: true, target, destination: destPath });

                    } else if (target === 'ftbquest') {
                        const ftbDir = path.join(root, 'config', 'ftbquests', 'quests', 'lang');
                        if (!fs.existsSync(ftbDir)) await fsp.mkdir(ftbDir, { recursive: true });
                        // Keep original filename (fr_fr.snbt, de_de.snbt, etc.)
                        const destName = path.basename(raw);
                        const destPath = path.join(ftbDir, destName);
                        await fsp.writeFile(destPath, buf);
                        results.push({ path: raw, ok: true, target, destination: destPath });

                    } else if (target === 'kubejs') {
                        // Need a mod id. Try to extract from path or filename.
                        // Accepted patterns:
                        //   <modid>/lang/<locale>.json
                        //   <modid>.<locale>.json
                        //   <modid>.json (assumed fr_fr)
                        let modId = null, locale = 'fr_fr';
                        const pathMatch = lower.match(/(?:^|\/)([a-z0-9_]+)\/lang\/([a-z_]+)\.json$/);
                        if (pathMatch) { modId = pathMatch[1]; locale = pathMatch[2]; }
                        else {
                            const nameMatch = base.match(/^([a-z0-9_]+)\.([a-z_]+)\.json$/);
                            if (nameMatch) { modId = nameMatch[1]; locale = nameMatch[2]; }
                            else {
                                const simple = base.match(/^([a-z0-9_]+)\.json$/);
                                if (simple && simple[1] !== 'fr_fr' && simple[1] !== 'en_us') modId = simple[1];
                            }
                        }
                        if (!modId) {
                            results.push({ path: raw, ok: false, error: 'Mod id introuvable (renommez en <modid>.fr_fr.json)' });
                            continue;
                        }
                        const langDir = path.join(root, 'kubejs', 'assets', modId, 'lang');
                        if (!fs.existsSync(langDir)) await fsp.mkdir(langDir, { recursive: true });
                        const destPath = path.join(langDir, `${locale}.json`);
                        await fsp.writeFile(destPath, buf);
                        results.push({ path: raw, ok: true, target, destination: destPath, modId, locale });

                    } else if (target === 'resourcepack-bundle') {
                        // Strip leading folders before "assets/"
                        const idx = lower.indexOf('assets/');
                        const entryName = idx >= 0 ? raw.slice(idx) : `assets/${path.basename(raw, ext)}/lang/${path.basename(raw)}`;
                        rpBundle.push({ entryName, buffer: buf });
                        results.push({ path: raw, ok: true, target, destination: `FR_Traduction*:${entryName}` });

                    } else {
                        results.push({ path: raw, ok: false, error: `target inconnu: ${target}` });
                    }
                } catch (e) {
                    results.push({ path: raw, ok: false, error: e.message });
                }
            }

            // Build/merge resource pack if there are bundle entries
            let rpInfo = null;
            if (rpBundle.length > 0) {
                const rpDir = path.join(root, 'resourcepacks');
                if (!fs.existsSync(rpDir)) await fsp.mkdir(rpDir, { recursive: true });
                const packName = findFrTraductionPack(rpDir) || 'FR_Traduction.zip';
                const rpFile = path.join(rpDir, packName);
                const zip = fs.existsSync(rpFile) ? new AdmZip(rpFile) : new AdmZip();

                // Ensure pack.mcmeta exists
                if (!zip.getEntry('pack.mcmeta')) {
                    const meta = { pack: { pack_format: 34, description: '§6Traduction FR §7— importée' } };
                    zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
                }

                for (const { entryName, buffer } of rpBundle) {
                    const existing = zip.getEntry(entryName);
                    if (existing) zip.updateFile(existing, buffer);
                    else zip.addFile(entryName, buffer);
                }
                zip.writeZip(rpFile);
                rpInfo = { path: rpFile, fileName: packName, entries: rpBundle.length };
            }

            let activated = false;
            if (activate && (rpInfo || results.some(r => r.target === 'resourcepack' && r.ok))) {
                const optionsFile = path.join(root, 'options.txt');
                const packToActivate = rpInfo
                    ? rpInfo.fileName
                    : path.basename(results.find(r => r.target === 'resourcepack' && r.ok).destination);
                activated = await activateResourcePack(optionsFile, packToActivate);
            }

            const okCount = results.filter(r => r.ok).length;
            res.json({ ok: true, total: results.length, succeeded: okCount, failed: results.length - okCount, results, resourcePack: rpInfo, activated });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /**
     * Export all translated files from an instance as a .minTrad bundle.
     * Format: ZIP containing manifest.json + payload files.
     * manifest.json = { name, version, date, files: [{ src, dest, kind }] }
     *   - src  : path inside the .minTrad archive
     *   - dest : path relative to instance root (e.g. "config/ftbquests/quests/lang/fr_fr.snbt")
     *   - kind : 'ftbquest' | 'kubejs' | 'resourcepack'
     * Body: { instance, locale?, includeResourcePack? }
     * Response: JSON { ok, fileName, data: base64 } so the browser can save it.
     */
    app.post('/api/minecraft/export-mintrad', async (req, res) => {
        try {
            const { instance, locale, includeResourcePack } = req.body || {};
            if (!instance) return res.status(400).json({ error: 'Instance requise' });
            const loc = (locale || 'fr_fr').toLowerCase();
            const instancesPath = getMinecraftInstancesPath();
            const instanceDir = resolveInstanceDir(instancesPath, instance);
            if (!fs.existsSync(instanceDir)) return res.status(404).json({ error: `Instance introuvable: ${instance}` });
            const root = mcRoot(instanceDir);

            const zip = new AdmZip();
            const files = [];

            // ── FTBQuest <locale>.snbt ──
            const ftbFile = path.join(root, 'config', 'ftbquests', 'quests', 'lang', `${loc}.snbt`);
            if (fs.existsSync(ftbFile)) {
                const buf = await fsp.readFile(ftbFile);
                const src = `ftbquests/${loc}.snbt`;
                zip.addFile(src, buf);
                files.push({ src, dest: `config/ftbquests/quests/lang/${loc}.snbt`, kind: 'ftbquest' });
            }

            // ── KubeJS assets/<modid>/lang/<locale>.json ──
            const assetsDir = path.join(root, 'kubejs', 'assets');
            if (fs.existsSync(assetsDir)) {
                const modDirs = await fsp.readdir(assetsDir, { withFileTypes: true });
                for (const md of modDirs) {
                    if (!md.isDirectory()) continue;
                    const langFile = path.join(assetsDir, md.name, 'lang', `${loc}.json`);
                    if (!fs.existsSync(langFile)) continue;
                    const buf = await fsp.readFile(langFile);
                    const src = `kubejs/${md.name}.${loc}.json`;
                    zip.addFile(src, buf);
                    files.push({ src, dest: `kubejs/assets/${md.name}/lang/${loc}.json`, kind: 'kubejs', modId: md.name });
                }
            }

            // ── Optional FR resource pack ──
            if (includeResourcePack) {
                const rpDir = path.join(root, 'resourcepacks');
                for (const packName of listFrTraductionPacks(rpDir)) {
                    const rpFile = path.join(rpDir, packName);
                    const buf = await fsp.readFile(rpFile);
                    const src = `resourcepack/${packName}`;
                    zip.addFile(src, buf);
                    files.push({ src, dest: `resourcepacks/${packName}`, kind: 'resourcepack', optional: true });
                }
            }

            if (files.length === 0) return res.status(404).json({ error: 'Aucun fichier de traduction trouvé dans cette instance' });

            // App version for trace
            let appVersion = '1.0.0';
            try {
                const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'version.json'), 'utf8'));
                appVersion = v.version || appVersion;
            } catch {}

            const manifest = {
                format: 'minTrad',
                formatVersion: 1,
                name: instance,
                locale: loc,
                date: new Date().toISOString(),
                generator: `ModLingo-Hub v${appVersion}`,
                files,
            };
            zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

            const safeName = instance.replace(/[^a-z0-9_-]+/gi, '_');
            const fileName = `${safeName}_${loc}.minTrad`;
            const data = zip.toBuffer().toString('base64');
            res.json({ ok: true, fileName, data, manifest: { ...manifest, files: files.map(f => ({ src: f.src, dest: f.dest, kind: f.kind })) } });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /**
     * Import a .minTrad bundle (or compatible ZIP with manifest.json) into an instance.
     * Body: { instance, data (base64), activate? }
     */
    app.post('/api/minecraft/import-mintrad', async (req, res) => {
        try {
            const { instance, data, activate } = req.body || {};
            if (!instance || !data) return res.status(400).json({ error: 'instance et data requis' });
            const instancesPath = getMinecraftInstancesPath();
            const instanceDir = resolveInstanceDir(instancesPath, instance);
            if (!fs.existsSync(instanceDir)) return res.status(404).json({ error: `Instance introuvable: ${instance}` });
            const root = mcRoot(instanceDir);

            const buf = Buffer.from(data, 'base64');
            const zip = new AdmZip(buf);
            const manifestEntry = zip.getEntry('manifest.json');
            if (!manifestEntry) return res.status(400).json({ error: 'manifest.json manquant — ce n\'est pas un .minTrad valide' });

            let manifest;
            try { manifest = JSON.parse(manifestEntry.getData().toString('utf8')); }
            catch { return res.status(400).json({ error: 'manifest.json invalide' }); }
            if (manifest.format !== 'minTrad') return res.status(400).json({ error: 'format invalide (attendu: minTrad)' });
            if (!Array.isArray(manifest.files)) return res.status(400).json({ error: 'manifest.files manquant' });

            const results = [];
            let hasResourcePack = false;
            const rpActivateNames = [];
            for (const f of manifest.files) {
                try {
                    const entry = zip.getEntry(f.src);
                    if (!entry) { results.push({ src: f.src, ok: false, error: 'fichier absent du .minTrad' }); continue; }

                    // Safety: dest must be relative, no .. traversal
                    const destRel = String(f.dest || '').replace(/\\/g, '/');
                    if (!destRel || destRel.startsWith('/') || destRel.includes('..') || /^[a-z]:/i.test(destRel)) {
                        results.push({ src: f.src, ok: false, error: `dest invalide: ${destRel}` });
                        continue;
                    }
                    const destPath = path.join(root, destRel);
                    const destDir = path.dirname(destPath);
                    if (!fs.existsSync(destDir)) await fsp.mkdir(destDir, { recursive: true });
                    await fsp.writeFile(destPath, entry.getData());
                    if (f.kind === 'resourcepack') {
                        hasResourcePack = true;
                        rpActivateNames.push(path.basename(destRel));
                    }
                    results.push({ src: f.src, ok: true, dest: destPath, kind: f.kind });
                } catch (e) {
                    results.push({ src: f.src, ok: false, error: e.message });
                }
            }

            let activated = false;
            if (activate && hasResourcePack) {
                const optionsFile = path.join(root, 'options.txt');
                for (const name of rpActivateNames) {
                    if (await activateResourcePack(optionsFile, name)) activated = true;
                }
            }

            const okCount = results.filter(r => r.ok).length;
            res.json({
                ok: true,
                manifest: { name: manifest.name, locale: manifest.locale, date: manifest.date, generator: manifest.generator },
                total: results.length,
                succeeded: okCount,
                failed: results.length - okCount,
                results,
                activated,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /* ================================================================
       DEEPL USAGE / QUOTA  — /LimiteMax
       ================================================================ */
    app.get('/api/LimiteMax', async (req, res) => {
        try {
            const apiData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'APIcle.json'), 'utf8'));
            const key = (apiData.deepl && apiData.deepl.key) ? apiData.deepl.key.trim() : '';
            if (!key || key.length < 5) {
                return res.json({ ok: false, error: 'Aucune clé API DeepL configurée dans data/APIcle.json' });
            }
            const isFree = key.endsWith(':fx');
            const hostname = isFree ? 'api-free.deepl.com' : 'api.deepl.com';

            const result = await new Promise((resolve, reject) => {
                const https = require('https');
                const reqApi = https.request({
                    hostname,
                    port: 443,
                    path: '/v2/usage',
                    method: 'GET',
                    headers: {
                        'Authorization': `DeepL-Auth-Key ${key}`,
                        'User-Agent': 'BG3Translator/1.0',
                    },
                }, (apiRes) => {
                    let data = '';
                    apiRes.on('data', chunk => { data += chunk; });
                    apiRes.on('end', () => {
                        if (apiRes.statusCode === 403 || apiRes.statusCode === 401) {
                            reject(new Error('Clé API DeepL invalide (401/403)'));
                            return;
                        }
                        if (apiRes.statusCode !== 200) {
                            reject(new Error(`DeepL API erreur HTTP ${apiRes.statusCode}`));
                            return;
                        }
                        try { resolve(JSON.parse(data)); }
                        catch { reject(new Error('Réponse JSON invalide')); }
                    });
                });
                reqApi.on('error', reject);
                reqApi.setTimeout(10000, () => { reqApi.destroy(); reject(new Error('Timeout')); });
                reqApi.end();
            });

            res.json({
                ok: true,
                plan: isFree ? 'Free' : 'Pro',
                character_count: result.character_count || 0,
                character_limit: result.character_limit || 0,
            });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    /* ================================================================
       BETTERQUESTING — translate DefaultQuests.json
       ================================================================ */

    /**
     * Extract translatable strings from BetterQuesting DefaultQuests.json.
     * Returns array of { id, type ('quest'|'line'), name, desc }
     */
    function parseBQ(json) {
        const entries = [];
        const db = json['questDatabase:9'] || {};
        for (const [, quest] of Object.entries(db)) {
            const bq = (quest['properties:10'] || {})['betterquesting:10'] || {};
            entries.push({
                id: quest['questID:3'],
                type: 'quest',
                name: bq['name:8'] || '',
                desc: bq['desc:8'] || '',
            });
        }
        const lines = json['questLines:9'] || {};
        for (const [, line] of Object.entries(lines)) {
            const bq = (line['properties:10'] || {})['betterquesting:10'] || {};
            entries.push({
                id: line['lineID:3'],
                type: 'line',
                name: bq['name:8'] || '',
                desc: bq['desc:8'] || '',
            });
        }
        return entries;
    }

    /**
     * Apply translations back into a cloned BQ JSON object.
     * translationsMap: Map<originalText, translatedText>
     */
    function applyBQTranslations(json, translationsMap) {
        const out = JSON.parse(JSON.stringify(json)); // deep clone
        const db = out['questDatabase:9'] || {};
        for (const [, quest] of Object.entries(db)) {
            const bq = ((quest['properties:10'] || {})['betterquesting:10'] || {});
            if (bq['name:8'] && translationsMap.has(bq['name:8'])) bq['name:8'] = translationsMap.get(bq['name:8']);
            if (bq['desc:8'] && translationsMap.has(bq['desc:8'])) bq['desc:8'] = translationsMap.get(bq['desc:8']);
        }
        const lines = out['questLines:9'] || {};
        for (const [, line] of Object.entries(lines)) {
            const bq = ((line['properties:10'] || {})['betterquesting:10'] || {});
            if (bq['name:8'] && translationsMap.has(bq['name:8'])) bq['name:8'] = translationsMap.get(bq['name:8']);
            if (bq['desc:8'] && translationsMap.has(bq['desc:8'])) bq['desc:8'] = translationsMap.get(bq['desc:8']);
        }
        return out;
    }

    /** Import BetterQuesting entries from an instance */
    app.get('/api/minecraft/bq-import', async (req, res) => {
        try {
            const { instance } = req.query;
            if (!instance) return res.status(400).json({ error: 'Instance requise' });

            const instancesPath = getMinecraftInstancesPath();
            const bqFile = path.join(mcRoot(resolveInstanceDir(instancesPath, instance)), 'config', 'betterquesting', 'DefaultQuests.json');

            if (!fs.existsSync(bqFile)) {
                return res.status(404).json({ error: `DefaultQuests.json introuvable pour ${instance}` });
            }

            const raw = await fsp.readFile(bqFile, 'utf8');
            const json = JSON.parse(raw);
            const entries = parseBQ(json);

            const questCount  = entries.filter(e => e.type === 'quest').length;
            const lineCount   = entries.filter(e => e.type === 'line').length;
            const translatableNames = entries.filter(e => e.name.trim()).length;
            const translatableDescs = entries.filter(e => e.desc.trim()).length;

            res.json({
                source: 'betterquesting',
                instance,
                questCount,
                lineCount,
                translatableCount: translatableNames + translatableDescs,
                preview: entries.slice(0, 5).map(e => ({ type: e.type, name: e.name.substring(0, 60), desc: e.desc.substring(0, 80) })),
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Translate BetterQuesting DefaultQuests.json (SSE) */
    app.post('/api/minecraft/bq-translate', async (req, res) => {
        const { instance, lang } = req.body;
        if (!instance) return res.status(400).json({ error: 'Instance requise' });

        const send = openSse(res);

        try {
            const instancesPath = getMinecraftInstancesPath();
            const bqFile = path.join(mcRoot(resolveInstanceDir(instancesPath, instance)), 'config', 'betterquesting', 'DefaultQuests.json');

            if (!fs.existsSync(bqFile)) {
                send('error', { message: `DefaultQuests.json introuvable pour ${instance}` });
                return res.end();
            }

            const raw = await fsp.readFile(bqFile, 'utf8');
            const json = JSON.parse(raw);
            const entries = parseBQ(json);

            // Collect unique non-empty strings (names + descs)
            const uniqueSet = new Set();
            for (const e of entries) {
                if (e.name.trim()) uniqueSet.add(e.name);
                if (e.desc.trim()) uniqueSet.add(e.desc);
            }
            const uniqueTexts = [...uniqueSet];

            send('log', { text: `📖 BetterQuesting — ${instance} — ${entries.length} quêtes/chapitres` });
            send('log', { text: `📝 ${uniqueTexts.length} chaînes uniques à traduire` });
            send('log', { text: `[TOTAL_STRINGS:${uniqueTexts.length}]` });

            const tgtLang = lang || 'fr';
            const translator = createTranslator({
                srcLang: 'en',
                tgtLang,
                cachePath: path.join(__dirname, '..', 'data', 'minecraft', 'cache.json'),
                concurrency: 10,
                delayMs: 50,
                logger: (msg) => send('log', { text: msg }),
                glossaryFile: 'minecraft/glossary.json',
                tagFile: 'minecraft/tag.json',
            });

            let done = 0;
            const total = uniqueTexts.length;
            let cachedCount = 0;
            let translatedCount = 0;

            const results = await translator.translateBatch(uniqueTexts, (original, result, fromCache) => {
                done++;
                if (fromCache) cachedCount++; else translatedCount++;
                send('progress', { current: done, total, text: original.substring(0, 60) });
            });

            const translatedJson = applyBQTranslations(json, results);
            const outputContent = JSON.stringify(translatedJson, null, 2);

            translator.flush();
            send('log', { text: `\n✅ BetterQuesting terminé: ${translatedCount} traduites, ${cachedCount} en cache` });
            send('done', {
                source: 'betterquesting',
                translated: translatedCount,
                cached: cachedCount,
                total,
                content: outputContent,
                filename: 'DefaultQuests.json',
                instance,
            });
            res.end();
        } catch (e) {
            send('error', { message: e.message });
            res.end();
        }
    });

    /** Save translated DefaultQuests.json to instance (with backup) */
    app.post('/api/minecraft/bq-save', async (req, res) => {
        try {
            const { instance, content } = req.body;
            if (!instance || !content) return res.status(400).json({ error: 'Instance et contenu requis' });

            const instancesPath = getMinecraftInstancesPath();
            const bqDir = path.join(mcRoot(resolveInstanceDir(instancesPath, instance)), 'config', 'betterquesting');
            const bqFile = path.join(bqDir, 'DefaultQuests.json');
            const bakFile = path.join(bqDir, 'DefaultQuests.json.bak');

            if (!fs.existsSync(bqDir)) return res.status(404).json({ error: `Dossier betterquesting introuvable` });

            // Backup original if not already backed up
            if (fs.existsSync(bqFile) && !fs.existsSync(bakFile)) {
                await fsp.copyFile(bqFile, bakFile);
            }

            await fsp.writeFile(bqFile, content, 'utf8');
            res.json({ ok: true, path: bqFile, backup: bakFile });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Audit all instances — detect format specifier corruption in FR resource packs */
    app.get('/api/minecraft/mods-audit', async (req, res) => {
        try {
            const instancesPath = getMinecraftInstancesPath();
            if (!fs.existsSync(instancesPath)) return res.json({ instances: [] });

            // Valid Java/Minecraft format specifier letter(s) after optional positional index
            const VALID_SPEC = /^%(\d+\$)?[sdfnbcBoOxXeEgGhHaAtT%]$/;

            function extractSpecs(str) {
                // Match %s, %d, %1$s, %2$d etc.
                return (String(str).match(/%(?:\d+\$)?[a-zA-Z%]/g) || []);
            }

            function getSpecIssue(enVal, frVal) {
                const enSpecs = extractSpecs(enVal);
                const frSpecs = extractSpecs(frVal);

                // Only VALID Java specs in EN are what we care about.
                // Custom mod placeholders like %MODNAME, %Creative produce %M, %C via the regex
                // but they're not real Java format specifiers — ignore them.
                const enValid = enSpecs.filter(s => VALID_SPEC.test(s));
                if (enValid.length === 0) return null;

                const frValid = frSpecs.filter(s => VALID_SPEC.test(s));

                // FR has no specs at all → missing
                if (frSpecs.length === 0) return { type: 'missing', enSpecs: enValid, frSpecs: [] };

                // Same spec count: check for corrupt (invalid letter) or type mismatch
                if (enValid.length === frSpecs.length) {
                    const hasInvalid = frSpecs.some(s => !VALID_SPEC.test(s));
                    if (hasInvalid) return { type: 'corrupt', enSpecs: enValid, frSpecs };
                    // All valid — check if letters match
                    const enNorm = enValid.map(s => s.replace(/^%\d+\$/, '%')).sort();
                    const frNorm = frSpecs.map(s => s.replace(/^%\d+\$/, '%')).sort();
                    if (JSON.stringify(enNorm) !== JSON.stringify(frNorm))
                        return { type: 'type_mismatch', enSpecs: enValid, frSpecs };
                    return null;
                }

                // Count differs → check valid-only count
                if (enValid.length !== frValid.length) return { type: 'count_mismatch', enSpecs: enValid, frSpecs: frValid };

                // Same valid count but letters differ
                const enNorm = enValid.map(s => s.replace(/^%\d+\$/, '%')).sort();
                const frNorm = frValid.map(s => s.replace(/^%\d+\$/, '%')).sort();
                if (JSON.stringify(enNorm) !== JSON.stringify(frNorm))
                    return { type: 'type_mismatch', enSpecs: enValid, frSpecs: frValid };

                return null;
            }

            const instanceItems = await fsp.readdir(instancesPath, { withFileTypes: true });
            const dirs = instanceItems.filter(i => i.isDirectory());

            // Parallelize across instances for speed
            const perInstance = await Promise.all(dirs.map(async (item) => {
                const instanceDir = path.join(instancesPath, item.name);
                const rpDir = path.join(mcRoot(instanceDir), 'resourcepacks');
                if (!fs.existsSync(rpDir)) return null;

                const rpFiles = fs.readdirSync(rpDir).filter(f => /^FR_Traduction.*\.zip$/i.test(f));
                if (rpFiles.length === 0) return null;

                const enMap = await buildEnMap(instanceDir);
                const instancePacks = [];

                for (const rpName of rpFiles) {
                    let rpZip;
                    try { rpZip = new AdmZip(path.join(rpDir, rpName)); } catch { continue; }
                    const issues = [];
                    const frModIds = new Set();
                    for (const entry of rpZip.getEntries()) {
                        const m = entry.entryName.match(/^assets\/([^/]+)\/lang\/fr_fr\.json$/i);
                        if (!m) continue;
                        const modId = m[1];
                        frModIds.add(modId);
                        const enMod = enMap[modId];
                        if (!enMod) continue;
                        let frData;
                        try { frData = JSON.parse(entry.getData().toString('utf8')); } catch { continue; }
                        for (const [key, frVal] of Object.entries(frData)) {
                            const enVal = enMod.keys[key];
                            if (!enVal) continue;
                            const issue = getSpecIssue(enVal, frVal);
                            if (issue) issues.push({ modId, key, en: String(enVal), fr: String(frVal), ...issue });
                        }
                    }
                    // Mods present in JARs (EN) but absent from this FR pack
                    const untranslated = Object.entries(enMap)
                        .filter(([modId, data]) => !frModIds.has(modId) && Object.keys(data.keys).length >= 5)
                        .map(([modId, data]) => ({ modId, keyCount: Object.keys(data.keys).length }))
                        .sort((a, b) => b.keyCount - a.keyCount)
                        .slice(0, 40);
                    if (issues.length > 0 || untranslated.length > 0)
                        instancePacks.push({ packName: rpName, issues, untranslated });
                }

                if (instancePacks.length === 0) return null;
                return { instance: item.name, packs: instancePacks };
            }));

            const results = perInstance.filter(Boolean);
            res.json({ instances: results });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /** Repair format specifier corruption in a FR resource pack (corrupt + type_mismatch only) */
    app.post('/api/minecraft/mods-repair-audit', async (req, res) => {
        try {
            const { instance: instanceName, packName } = req.body;
            if (!instanceName || !packName) return res.status(400).json({ error: 'instance et packName requis' });

            const instancesPath = getMinecraftInstancesPath();
            const instanceDir = resolveInstanceDir(instancesPath, instanceName);
            const packBase = path.basename(String(packName));
            if (packBase !== String(packName).trim() || !FR_TRAD_PACK_RE.test(packBase)) {
                return res.status(400).json({ error: 'Nom de pack invalide' });
            }
            const rpDir = path.join(mcRoot(instanceDir), 'resourcepacks');
            const rpPath = path.join(rpDir, packBase);
            if (!fs.existsSync(rpPath)) return res.status(404).json({ error: 'Pack introuvable' });

            const VALID_SPEC = /^%(?:\d+\$)?[sdfnbcBoOxXeEgGhHaAtT%]$/;
            function extractSpecs(str) {
                return (String(str).match(/%(?:\d+\$)?[a-zA-Z%]/g) || []);
            }

            function repairValue(enVal, frVal) {
                const enSpecs = extractSpecs(enVal);
                const frSpecs = extractSpecs(frVal);
                // Only care about valid Java specs in EN (ignore custom mod placeholders)
                const enValid = enSpecs.filter(s => VALID_SPEC.test(s));
                if (enValid.length === 0) return null;
                // Only repairable when spec count matches exactly
                if (enValid.length !== frSpecs.length) return null;
                // Check if any FR spec is invalid (corrupt or wrong letter)
                const needsRepair = frSpecs.some(s => !VALID_SPEC.test(s));
                if (!needsRepair) return null;
                let idx = 0;
                const fixed = frVal.replace(/%(?:\d+\$)?[a-zA-Z%]/g, m => {
                    const en = enValid[idx] !== undefined ? enValid[idx] : m;
                    idx++;
                    return en;
                });
                return fixed === frVal ? null : fixed;
            }

            const enMap = await buildEnMap(instanceDir);
            let rpZip;
            try { rpZip = new AdmZip(rpPath); } catch (e) { return res.status(500).json({ error: `Impossible d'ouvrir le ZIP: ${e.message}` }); }

            let fixedCount = 0;
            let skippedCount = 0;
            for (const entry of rpZip.getEntries()) {
                const m = entry.entryName.match(/^assets\/([^/]+)\/lang\/fr_fr\.json$/i);
                if (!m) continue;
                const modId = m[1];
                const enMod = enMap[modId];
                if (!enMod) continue;
                let frData;
                try { frData = JSON.parse(entry.getData().toString('utf8')); } catch { continue; }
                let changed = false;
                for (const [key, frVal] of Object.entries(frData)) {
                    const enVal = enMod.keys[key];
                    if (!enVal) continue;
                    const fixed = repairValue(String(enVal), String(frVal));
                    if (fixed !== null) {
                        frData[key] = fixed;
                        changed = true;
                        fixedCount++;
                    } else {
                        // count if this key was a skippable issue (missing/count_mismatch)
                        const enSpecs = extractSpecs(String(enVal));
                        const frSpecs = extractSpecs(String(frVal));
                        if (enSpecs.length !== frSpecs.length && enSpecs.length > 0) skippedCount++;
                    }
                }
                if (changed) {
                    const buf = Buffer.from(JSON.stringify(frData, null, 2), 'utf8');
                    rpZip.updateFile(entry.entryName, buf);
                }
            }

            rpZip.writeZip(rpPath);
            res.json({ ok: true, fixed: fixedCount, skipped: skippedCount });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

}

module.exports = register;
module.exports.getMinecraftInstancesPath = getMinecraftInstancesPath;
module.exports.detectMinecraftInstancesDir = detectMinecraftInstancesDir;
module.exports.resolveInstanceDir = resolveInstanceDir;
module.exports.mcRoot = mcRoot;
