'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { readLSPK, readEntryData, writeLSPK, closeLSPK, parseLoca } = require('../lspk');
const { createJsonFileCache } = require('./utils/json-file-cache');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'confightml.json');
const LINKS_FILE = path.join(__dirname, '..', 'data', 'links.json');
const MODS_REGISTRY_FILE = path.join(__dirname, '..', 'data', 'mods_registry.json');
const APICLE_FILE = path.join(__dirname, '..', 'data', 'APIcle.json');
const PAK_UID_CACHE_FILE = path.join(__dirname, '..', 'data', 'bg3', 'pak_uid_cache.json');

const configCache = createJsonFileCache(CONFIG_FILE, () => ({ modsFolder: '', modsettingsPath: '' }));
const linksCache = createJsonFileCache(LINKS_FILE, () => ({ links: [] }));
const modsRegistryCache = createJsonFileCache(MODS_REGISTRY_FILE, () => ({ mods: [] }));
const apicleCache = createJsonFileCache(APICLE_FILE, () => ({}));

/* ================================================================
   PAK METADATA CACHE
   ================================================================ */
const pakMetaCache = new Map();

async function getCachedPakMeta(filePath, stat) {
    const name = path.basename(filePath);
    const cached = pakMetaCache.get(name);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.meta;
    }

    const meta = {
        translatableFiles: 0,
        version: null, modName: null, folder: null,
        uuid: null, version64: null, description: null,
    };

    try {
        const lspk = await readLSPK(filePath);
        for (const entry of lspk.entries) {
            const lower = entry.name.toLowerCase();
            if (lower.endsWith('.loca') || (lower.endsWith('.xml') && lower.includes('localization'))) {
                meta.translatableFiles++;
            }
            if (lower.endsWith('meta.lsx') && !meta.folder) {
                try {
                    const data = await readEntryData(lspk.handle, entry);
                    const txt = data.toString('utf8');
                    const miIdx = txt.indexOf('id="ModuleInfo"');
                    const searchTxt = miIdx >= 0 ? txt.slice(miIdx) : txt;
                    const get = (id) => {
                        const r = searchTxt.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`));
                        return r ? r[1] : null;
                    };
                    meta.folder = get('Folder');
                    meta.modName = get('Name');
                    meta.uuid = get('UUID');
                    meta.version64 = get('Version64');
                    meta.description = get('Description');
                    if (meta.version64) {
                        try {
                            const v64 = BigInt(meta.version64);
                            const major = Number((v64 >> 55n) & 0xFFn);
                            const minor = Number((v64 >> 47n) & 0xFFn);
                            const rev   = Number((v64 >> 31n) & 0xFFFFn);
                            const build = Number(v64 & 0x7FFFFFFFn);
                            meta.version = `${major}.${minor}.${rev}.${build}`;
                        } catch {}
                    }
                } catch {}
            }
        }
        await closeLSPK(lspk);
    } catch {}

    pakMetaCache.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
    return meta;
}

/* ================================================================
   PAK UID CACHE  — memory + disk (mtime/size keyed)
   ================================================================ */
const pakUidMemoryCache = new Map();
let pakUidDiskCache = null;
let pakUidDiskDirty = false;
let pakUidSaveTimer = null;

function loadPakUidDiskCache() {
    if (pakUidDiskCache) return pakUidDiskCache;
    try {
        pakUidDiskCache = JSON.parse(fs.readFileSync(PAK_UID_CACHE_FILE, 'utf8'));
    } catch {
        pakUidDiskCache = {};
    }
    return pakUidDiskCache;
}

function schedulePakUidDiskSave() {
    if (pakUidSaveTimer) return;
    pakUidSaveTimer = setTimeout(() => {
        pakUidSaveTimer = null;
        if (!pakUidDiskDirty || !pakUidDiskCache) return;
        try {
            fs.mkdirSync(path.dirname(PAK_UID_CACHE_FILE), { recursive: true });
            fs.writeFileSync(PAK_UID_CACHE_FILE, JSON.stringify(pakUidDiskCache), 'utf8');
            pakUidDiskDirty = false;
        } catch {}
    }, 5000);
}

/* ================================================================
   SECURITY
   ================================================================ */
function safePakName(name) {
    if (!name || typeof name !== 'string') throw new Error('Nom de fichier invalide');
    const base = path.basename(name);
    if (base !== name) throw new Error('Caractères de chemin non autorisés');
    // Reject Windows-style backslash paths even on POSIX (cross-platform safety)
    if (name.includes('\\')) throw new Error('Caractères de chemin non autorisés');
    if (!base.toLowerCase().endsWith('.pak')) throw new Error('Fichier non .pak');
    return base;
}

const ALLOWED_GAME_IDS = new Set([
    'bg3', 'hytale', 'satisfactory', 'minecraft', 'ancientdungeon', 'riskofrain2',
]);

const GAME_ID_ALIASES = { ror2: 'riskofrain2' };

function safeGameId(game) {
    let id = String(game || 'bg3').toLowerCase();
    id = GAME_ID_ALIASES[id] || id;
    if (!ALLOWED_GAME_IDS.has(id)) throw new Error('Jeu invalide');
    return id;
}

function safeInstanceName(name) {
    if (!name || typeof name !== 'string') throw new Error('Instance requise');
    const base = path.basename(name.trim());
    if (!base || base !== name.trim() || base.includes('..')) {
        throw new Error('Nom d\'instance invalide');
    }
    return base;
}

function safeModId(mod) {
    if (!mod || typeof mod !== 'string' || !/^[a-z0-9_]+$/i.test(mod)) {
        throw new Error('Identifiant mod invalide');
    }
    return mod;
}

function isDebugMode() {
    const cfg = loadConfig();
    return process.env.NODE_ENV === 'development' || !!cfg.debugMode;
}

function safeErrorMessage(e, fallback = 'Une erreur est survenue') {
    if (isDebugMode() && e && e.message) return e.message;
    return fallback;
}

/* ================================================================
   CONFIG
   ================================================================ */
function dirExists(p) {
    if (!p || typeof p !== 'string') return false;
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function fileExists(p) {
    if (!p || typeof p !== 'string') return false;
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function looksLikeWindowsPath(p) {
    return typeof p === 'string' && /^[A-Za-z]:[\\/]/.test(p);
}

function homePathCandidates() {
    const homes = new Set();
    try { homes.add(require('os').homedir()); } catch {}
    for (const h of [process.env.HOME, process.env.USERPROFILE]) {
        if (h) homes.add(h);
    }
    try {
        const u = require('os').userInfo().username;
        if (u) {
            homes.add('/home/' + u);
            homes.add('/var/home/' + u);
        }
    } catch {}
    return [...homes].filter(Boolean);
}

function parseSteamLibraryFolders(content) {
    const paths = [];
    const re = /"path"\s+"([^"]+)"/gi;
    let m;
    while ((m = re.exec(content))) paths.push(m[1].replace(/\\\\/g, '\\'));
    return paths;
}

function steamLibraryRoots() {
    const roots = [];
    const vdfs = [];
    for (const home of homePathCandidates()) {
        vdfs.push(
            path.join(home, '.steam', 'steam', 'steamapps', 'libraryfolders.vdf'),
            path.join(home, '.local', 'share', 'Steam', 'steamapps', 'libraryfolders.vdf'),
            path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam', 'steamapps', 'libraryfolders.vdf'),
        );
    }
    const seen = new Set();
    for (const vdf of vdfs) {
        if (!fileExists(vdf)) continue;
        try {
            const libs = parseSteamLibraryFolders(fs.readFileSync(vdf, 'utf8'));
            for (const lib of libs) {
                if (lib && !seen.has(lib)) { seen.add(lib); roots.push(lib); }
            }
            const steamRoot = path.dirname(path.dirname(vdf));
            if (!seen.has(steamRoot)) { seen.add(steamRoot); roots.push(steamRoot); }
        } catch {}
    }
    return roots;
}

const BG3_STEAM_APPID = '1086940';

function bg3ModsRelUnderPrefix(prefix) {
    return path.join(prefix, 'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Local', 'Larian Studios', "Baldur's Gate 3");
}

/** Proton / native candidates for BG3 Mods + modsettings.lsx */
function detectBg3GameDirs() {
    const found = [];
    for (const root of steamLibraryRoots()) {
        found.push(bg3ModsRelUnderPrefix(path.join(root, 'steamapps', 'compatdata', BG3_STEAM_APPID)));
    }
    for (const home of homePathCandidates()) {
        found.push(path.join(home, '.local', 'share', 'Larian Studios', "Baldur's Gate 3"));
        found.push(bg3ModsRelUnderPrefix(path.join(home, '.steam', 'steam', 'steamapps', 'compatdata', BG3_STEAM_APPID)));
        found.push(bg3ModsRelUnderPrefix(path.join(home, '.local', 'share', 'Steam', 'steamapps', 'compatdata', BG3_STEAM_APPID)));
    }
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA;
        if (local) found.push(path.join(local, 'Larian Studios', "Baldur's Gate 3"));
    } else {
        // Partitions Windows montées : /run/media/<linux-user>/<volume>/Users/<windows-user>/AppData/Local/...
        const mediaRoot = '/run/media';
        try {
            for (const linuxUser of fs.readdirSync(mediaRoot)) {
                const userMount = path.join(mediaRoot, linuxUser);
                for (const volume of fs.readdirSync(userMount)) {
                    const usersDir = path.join(userMount, volume, 'Users');
                    if (!dirExists(usersDir)) continue;
                    for (const windowsUser of fs.readdirSync(usersDir)) {
                        found.push(path.join(usersDir, windowsUser, 'AppData', 'Local', 'Larian Studios', "Baldur's Gate 3"));
                    }
                }
            }
        } catch {}
    }
    for (const gameDir of found) {
        const mods = path.join(gameDir, 'Mods');
        if (dirExists(mods)) {
            const ms = path.join(gameDir, 'PlayerProfiles', 'Public', 'modsettings.lsx');
            return { modsFolder: mods, modsettingsPath: fileExists(ms) ? ms : '' };
        }
    }
    return null;
}

/**
 * Use configured folder if it exists; otherwise auto-detect Proton/Linux.
 * Persists a detected path when the config still points at a dead Windows folder.
 */
function getBg3ModsFolder() {
    const cfg = loadConfig();
    if (dirExists(cfg.modsFolder)) return cfg.modsFolder;
    const detected = detectBg3GameDirs();
    if (detected && detected.modsFolder) {
        cfg.modsFolder = detected.modsFolder;
        if (detected.modsettingsPath && !fileExists(cfg.modsettingsPath)) {
            cfg.modsettingsPath = detected.modsettingsPath;
        }
        try { saveConfig(cfg); } catch {}
        return detected.modsFolder;
    }
    return '';
}

function bg3ModsFolderError(configured) {
    const hint = process.platform === 'win32'
        ? '%LOCALAPPDATA%\\Larian Studios\\Baldur\'s Gate 3\\Mods'
        : '…/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur\'s Gate 3/Mods';
    const deadWin = configured && looksLikeWindowsPath(configured) && process.platform !== 'win32';
    if (deadWin) {
        return 'Ce chemin est un chemin Windows — normal qu’il soit introuvable ici (Linux). Change-le dans Configuration vers le dossier Proton.';
    }
    if (configured) {
        return `Dossier Mods introuvable : ${configured}. Vérifie le chemin dans Configuration.`;
    }
    return `Dossier Mods BG3 non configuré. Ouvre Configuration et pointe vers ${hint}`;
}

function bg3ModsFolderMeta(configured) {
    return {
        windowsPathOnLinux: !!(configured && looksLikeWindowsPath(configured) && process.platform !== 'win32'),
        configured: configured || '',
        platform: process.platform,
    };
}

function loadConfig() {
    return configCache.load();
}

function saveConfig(cfg) {
    configCache.save(cfg);
}

function invalidateApicleCache() {
    apicleCache.invalidate();
}

/* ================================================================
   BG3 LANGUAGE FOLDER MAP
   ================================================================ */
const BG3_LANG_FOLDERS = {
    'en': 'English', 'fr': 'French', 'de': 'German', 'es': 'Spanish',
    'it': 'Italian', 'pt': 'PortugueseBrazil', 'ru': 'Russian', 'pl': 'Polish',
    'nl': 'Dutch', 'ja': 'Japanese', 'ko': 'Korean', 'zh-CN': 'ChineseSimplified',
    'zh-TW': 'ChineseTraditional', 'tr': 'Turkish', 'uk': 'Ukrainian', 'cs': 'Czech',
};
const BG3_KNOWN_LOCA_FOLDERS = new Set([
    'english', 'french', 'german', 'spanish', 'italian', 'portuguesebrazil',
    'brazilianportuguese', 'russian', 'polish', 'dutch', 'japanese', 'korean',
    'chinesesimplified', 'chinesetraditional', 'turkish', 'ukrainian', 'czech',
]);

/* ================================================================
   PAK HELPERS
   ================================================================ */
function version64ToStr(v) {
    try {
        const n = BigInt(v);
        const major = Number((n >> 55n) & 0xFFn);
        const minor = Number((n >> 47n) & 0xFFn);
        const revision = Number((n >> 31n) & 0xFFFFn);
        const build = Number(n & 0x7FFFFFFFn);
        return `${major}.${minor}.${revision}.${build}`;
    } catch { return v; }
}

async function readPakMeta(pakPath) {
    const stat = await fsp.stat(pakPath);
    return getCachedPakMeta(pakPath, stat);
}

async function readPakUIDsFromFile(pakPath) {
    const uids = new Map();
    let lspk;
    try {
        lspk = await readLSPK(pakPath);
        for (const e of lspk.entries) {
            const lower = e.name.toLowerCase();
            if (!lower.includes('localization')) continue;
            if (!lower.endsWith('.loca') && !lower.endsWith('.xml')) continue;
            try {
                const data = await readEntryData(lspk.handle, e);
                if (lower.endsWith('.loca')) {
                    for (const le of parseLoca(data)) {
                        if (le.uid && le.text && le.text.trim()) uids.set(le.uid, le.text);
                    }
                } else {
                    const txt = data.toString('utf8');
                    const re = /contentuid="([^"]+)"[^>]*>([^<]*)</g;
                    let m;
                    while ((m = re.exec(txt))) {
                        if (m[2].trim()) uids.set(m[1], m[2]);
                    }
                }
            } catch {}
        }
        return uids;
    } finally {
        if (lspk) try { await closeLSPK(lspk); } catch (_) {}
    }
}

async function readPakUIDs(pakPath) {
    const stat = await fsp.stat(pakPath);
    const mem = pakUidMemoryCache.get(pakPath);
    if (mem && mem.mtimeMs === stat.mtimeMs && mem.size === stat.size) {
        return mem.uids;
    }

    const fileKey = path.basename(pakPath);
    const disk = loadPakUidDiskCache()[fileKey];
    if (disk && disk.mtimeMs === stat.mtimeMs && disk.size === stat.size && disk.uids) {
        const uids = new Map(Object.entries(disk.uids));
        pakUidMemoryCache.set(pakPath, { mtimeMs: stat.mtimeMs, size: stat.size, uids });
        return uids;
    }

    const uids = await readPakUIDsFromFile(pakPath);
    pakUidMemoryCache.set(pakPath, { mtimeMs: stat.mtimeMs, size: stat.size, uids });

    const diskData = {};
    for (const [uid, text] of uids) diskData[uid] = text;
    loadPakUidDiskCache()[fileKey] = { mtimeMs: stat.mtimeMs, size: stat.size, uids: diskData };
    pakUidDiskDirty = true;
    schedulePakUidDiskSave();

    return uids;
}

async function pakHasTargetLanguage(pakPath, langCode) {
    const tgtFolder = (BG3_LANG_FOLDERS[langCode] || '').toLowerCase();
    if (!tgtFolder) return { hasTarget: false, langFolder: null, fileCount: 0, stringCount: 0 };

    let lspk;
    try {
        lspk = await readLSPK(pakPath);
        let fileCount = 0;
        let stringCount = 0;

        for (const entry of lspk.entries) {
            const parts = entry.name.split('/');
            for (let i = 0; i < parts.length - 1; i++) {
                if (parts[i].toLowerCase() === 'localization' && i + 1 < parts.length) {
                    if (parts[i + 1].toLowerCase() === tgtFolder) {
                        const lower = entry.name.toLowerCase();
                        if (lower.endsWith('.loca') || lower.endsWith('.xml')) {
                            fileCount++;
                            try {
                                const data = await readEntryData(lspk.handle, entry);
                                if (lower.endsWith('.loca')) {
                                    const entries = parseLoca(data);
                                    stringCount += entries.filter(e => e.text && e.text.trim()).length;
                                } else if (lower.endsWith('.xml')) {
                                    const matches = data.toString('utf8').match(/<content\s/g);
                                    stringCount += matches ? matches.length : 0;
                                }
                            } catch {}
                        }
                    }
                }
            }
        }

        return {
            hasTarget: fileCount > 0 && stringCount > 0,
            langFolder: BG3_LANG_FOLDERS[langCode],
            fileCount,
            stringCount,
        };
    } catch (e) {
        return { hasTarget: false, langFolder: null, fileCount: 0, stringCount: 0, error: e.message };
    } finally {
        if (lspk) try { await closeLSPK(lspk); } catch {}
    }
}

/* ================================================================
   LINKS
   ================================================================ */
function loadLinks() {
    const data = linksCache.load();
    return Array.isArray(data.links) ? data.links : [];
}

function saveLinks(links) {
    linksCache.save({ links });
}

/* ================================================================
   TRANSLATION QUEUE STATE
   ================================================================ */
const translationState = {
    busy: false,
    activeProcesses: new Map(),
};

/* ================================================================
   MODS REGISTRY
   ================================================================ */
function loadModsRegistry() {
    return modsRegistryCache.load();
}

function saveModsRegistry(reg) {
    modsRegistryCache.save(reg);
}

function loadNexusKey() {
    try {
        const api = apicleCache.load();
        return (api.nexus && api.nexus.key) || '';
    } catch {
        return '';
    }
}

function loadCurseForgeKey() {
    try {
        const api = apicleCache.load();
        return (api.curseforge && api.curseforge.key) || '';
    } catch {
        return '';
    }
}

function loadApicle() {
    return apicleCache.load();
}

module.exports = {
    CONFIG_FILE,
    LINKS_FILE,
    pakMetaCache,
    getCachedPakMeta,
    safePakName,
    safeGameId,
    safeInstanceName,
    safeModId,
    isDebugMode,
    safeErrorMessage,
    ALLOWED_GAME_IDS,
    loadConfig,
    saveConfig,
    getBg3ModsFolder,
    bg3ModsFolderError,
    bg3ModsFolderMeta,
    dirExists,
    fileExists,
    looksLikeWindowsPath,
    homePathCandidates,
    steamLibraryRoots,
    detectBg3GameDirs,
    invalidateApicleCache,
    BG3_LANG_FOLDERS,
    BG3_KNOWN_LOCA_FOLDERS,
    version64ToStr,
    readPakMeta,
    readPakUIDs,
    pakHasTargetLanguage,
    loadLinks,
    saveLinks,
    translationState,
    MODS_REGISTRY_FILE,
    loadModsRegistry,
    saveModsRegistry,
    loadNexusKey,
    loadCurseForgeKey,
    loadApicle,
};
