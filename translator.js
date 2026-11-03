'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { mapLimit } = require('./modules/utils/map-limit');
const { createEngineRegistry, runEnginePhase } = require('./modules/utils/translation-engines');

/* ================================================================
   REGISTRE DES MOTEURS
   Source unique de l'ordre de repli, des tailles de lot et des erreurs
   fatales. Les translateXxxBatch ci-dessous sont des déclarations de
   fonction, donc hissées : les passer ici est sûr malgré leur position.
   ================================================================ */
const ENGINES = createEngineRegistry({
    translateDeepLBatch: (...a) => translateDeepLBatch(...a),
    translateGoogleBatch: (...a) => translateGoogleBatch(...a),
    translateLibreBatch: (...a) => translateLibreBatch(...a),
    translateLibreBatchGPU: (...a) => translateLibreBatchGPU(...a),
    translateLibreBatchGPUProgressive: (...a) => translateLibreBatchGPUProgressive(...a),
    translateGeminiBatch: (...a) => translateGeminiBatch(...a),
    translateOpenRouterBatch: (...a) => translateOpenRouterBatch(...a),
    translateLmStudioBatch: (...a) => translateLmStudioBatch(...a),
    translateGoogle: (...a) => translateGoogle(...a),
    translateMyMemory: (...a) => translateMyMemory(...a),
});

/* ================================================================
   DeepL API KEY  — loaded from APIcle.json (optional)
   ================================================================ */
let DEEPL_KEY = null;
let DEEPL_FREE = true;

/**
 * Load the DeepL API key from data/APIcle.json.
 * @returns {boolean} True if a valid key was loaded.
 */
function loadDeepLKey() {
    const keyPath = path.join(__dirname, 'data', 'APIcle.json');
    try {
        if (fs.existsSync(keyPath)) {
            const data = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
            const key = (data.deepl && data.deepl.key) ? data.deepl.key.trim() : '';
            if (key && key.length > 5) {
                DEEPL_KEY = key;
                // DeepL Free keys end with ":fx"
                DEEPL_FREE = key.endsWith(':fx');
                return true;
            }
        }
    } catch (e) {
        // ignore malformed file
    }
    DEEPL_KEY = null;
    return false;
}

// Load on module init
let DEEPL_AVAILABLE = loadDeepLKey();

/* ================================================================
   LibreTranslate  — local self-hosted translation (optional)
   ================================================================ */
let LIBRE_URL = null;
let LIBRE_AVAILABLE = false;
let LIBRE_MODE = 'auto'; // 'auto' | 'gpu' | 'cpu' | 'gpu_progressive' | 'dual_gpu'

/**
 * Load LibreTranslate endpoint configuration from data/APIcle.json.
 * @returns {boolean} True if an endpoint is configured.
 */
function loadLibreTranslateConfig() {
    const keyPath = path.join(__dirname, 'data', 'APIcle.json');
    try {
        if (fs.existsSync(keyPath)) {
            const data = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
            if (data.libretranslate && data.libretranslate.enabled) {
                const url = (data.libretranslate.url || '').trim();
                if (url) {
                    LIBRE_URL = url.replace(/\/+$/, '');
                    return true;
                }
            }
        }
    } catch {}
    LIBRE_URL = null;
    return false;
}

// Check if LibreTranslate is reachable at startup (uses /health — lighter than /languages)
/**
 * Check whether the configured LibreTranslate instance is reachable.
 * @returns {Promise<boolean>} True if the /health endpoint reports OK.
 */
async function checkLibreTranslate() {
    if (!LIBRE_URL) return false;
    try {
        const url = new URL('/health', LIBRE_URL);
        const proto = url.protocol === 'https:' ? https : http;
        return await new Promise((resolve) => {
            const req = proto.get(url.href, { timeout: 3000 }, (res) => {
                let d = '';
                res.on('data', c => { d += c; });
                res.on('end', () => {
                    try {
                        const data = JSON.parse(d);
                        resolve(data && data.status === 'ok');
                    } catch { resolve(false); }
                });
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    } catch { return false; }
}

/**
 * Upload our glossary to LibreTranslate's /glossary endpoint.
 * Converts our sectioned format → flat {name, source, target, entries}.
 * LibreTranslate will then handle glossary terms server-side automatically.
 */
let libreGlossaryUploadedKeys = new Set();
async function uploadGlossaryToLibre(srcLang, tgtLang, glossaryFile, logger) {
    const uploadKey = `${glossaryFile || 'bg3/glossary.json'}:${srcLang}:${tgtLang}`;
    if (libreGlossaryUploadedKeys.has(uploadKey) || !LIBRE_URL) return false;
    libreGlossaryUploadedKeys.add(uploadKey);

    const glossaryPath = path.join(__dirname, 'data', glossaryFile || 'bg3/glossary.json');
    try {
        if (!fs.existsSync(glossaryPath)) return false;
        const raw = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));

        // Flatten sectioned glossary → flat entries
        const entries = {};
        for (const [section, sectionEntries] of Object.entries(raw)) {
            if (section.startsWith('_')) continue;
            if (typeof sectionEntries !== 'object') continue;
            for (const [en, localized] of Object.entries(sectionEntries)) {
                if (typeof localized === 'string') {
                    entries[en] = localized;
                }
            }
        }

        const entryCount = Object.keys(entries).length;
        if (entryCount === 0) return false;

        const src = srcLang === 'auto' ? 'en' : srcLang;
        const glossaryName = `translator-${src}-${tgtLang}`;

        // First, try to delete any existing glossary with same source/target
        try {
            const delUrl = new URL(`/glossary/${src}/${tgtLang}`, LIBRE_URL);
            const proto = delUrl.protocol === 'https:' ? https : http;
            await new Promise((resolve) => {
                const req = proto.request(delUrl.href, { method: 'DELETE', timeout: 5000 }, (res) => {
                    let d = ''; res.on('data', c => d += c); res.on('end', () => resolve());
                });
                req.on('error', () => resolve());
                req.on('timeout', () => { req.destroy(); resolve(); });
                req.end();
            });
        } catch {}

        // Upload the glossary
        const url = new URL('/glossary', LIBRE_URL);
        const body = JSON.stringify({
            name: glossaryName,
            source: src,
            target: tgtLang,
            entries: entries,
        });

        const proto = url.protocol === 'https:' ? https : http;
        const result = await new Promise((resolve, reject) => {
            const req = proto.request(url.href, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: 15000,
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ ok: true, status: res.statusCode, data });
                    } else {
                        resolve({ ok: false, status: res.statusCode, data });
                    }
                });
            });
            req.on('error', (e) => resolve({ ok: false, error: e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
            req.write(body);
            req.end();
        });

        if (result.ok) {
            logger(`  📖 Glossaire uploadé à LibreTranslate: ${entryCount} termes (${src}→${tgtLang})`);
            return true;
        } else {
            logger(`  ⚠️ Glossaire upload échoué: HTTP ${result.status || 'ERR'} ${result.error || result.data?.slice(0, 100)}`);
            return false;
        }
    } catch (e) {
        logger(`  ⚠️ Glossaire upload erreur: ${e.message}`);
        return false;
    }
}

/**
 * Get LLM status from LibreTranslate (GET /llm)
 */
async function getLibreLLMStatus() {
    if (!LIBRE_URL) return null;
    try {
        const url = new URL('/llm', LIBRE_URL);
        const proto = url.protocol === 'https:' ? https : http;
        return await new Promise((resolve) => {
            const req = proto.get(url.href, { timeout: 5000 }, (res) => {
                let d = '';
                res.on('data', c => { d += c; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try { resolve(JSON.parse(d)); } catch { resolve(null); }
                    } else { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
    } catch { return null; }
}

/**
 * Enable/disable LLM on LibreTranslate (POST /llm/enable or /llm/disable)
 */
async function setLibreLLM(enable, logger) {
    if (!LIBRE_URL) return false;
    const endpoint = enable ? '/llm/enable' : '/llm/disable';
    try {
        const url = new URL(endpoint, LIBRE_URL);
        const proto = url.protocol === 'https:' ? https : http;
        const result = await new Promise((resolve) => {
            const req = proto.request(url.href, { method: 'POST', timeout: 5000,
                headers: { 'Content-Type': 'application/json', 'Content-Length': 0 }
            }, (res) => {
                let d = '';
                res.on('data', c => { d += c; });
                res.on('end', () => resolve(res.statusCode === 200));
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
        if (result) {
            logger(`  🧠 LLM ${enable ? 'activé' : 'désactivé'} sur LibreTranslate`);
        }
        return result;
    } catch { return false; }
}

/**
 * Update LLM configuration on LibreTranslate (POST /llm)
 */
async function updateLibreLLMConfig(config) {
    if (!LIBRE_URL) return null;
    try {
        const url = new URL('/llm', LIBRE_URL);
        const body = JSON.stringify(config);
        const proto = url.protocol === 'https:' ? https : http;
        return await new Promise((resolve) => {
            const req = proto.request(url.href, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                timeout: 5000,
            }, (res) => {
                let d = '';
                res.on('data', c => { d += c; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try { resolve(JSON.parse(d)); } catch { resolve(null); }
                    } else { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(body);
            req.end();
        });
    } catch { return null; }
}

/**
 * Get current LLM system prompt (GET /llm/prompt)
 */
async function getLibreLLMPrompt() {
    if (!LIBRE_URL) return null;
    try {
        const url = new URL('/llm/prompt', LIBRE_URL);
        const proto = url.protocol === 'https:' ? https : http;
        return await new Promise((resolve) => {
            const req = proto.get(url.href, { timeout: 5000 }, (res) => {
                let d = '';
                res.on('data', c => { d += c; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try { resolve(JSON.parse(d)); } catch { resolve(null); }
                    } else { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
    } catch { return null; }
}

/**
 * Set LLM system prompt (POST /llm/prompt)
 */
async function setLibreLLMPrompt(systemPrompt) {
    if (!LIBRE_URL) return null;
    try {
        const url = new URL('/llm/prompt', LIBRE_URL);
        const body = JSON.stringify({ system_prompt: systemPrompt });
        const proto = url.protocol === 'https:' ? https : http;
        return await new Promise((resolve) => {
            const req = proto.request(url.href, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                timeout: 5000,
            }, (res) => {
                let d = '';
                res.on('data', c => { d += c; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try { resolve(JSON.parse(d)); } catch { resolve(null); }
                    } else { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(body);
            req.end();
        });
    } catch { return null; }
}

/**
 * Verify cache translations via LLM (POST /llm/verify_cache)
 */
async function verifyLibreCache(translations, source, target, opts = {}) {
    if (!LIBRE_URL) return null;
    const { limit = 200, batch_size = 10, cooldown = 1.0, num_predict = 1024 } = opts;
    try {
        const url = new URL('/llm/verify_cache', LIBRE_URL);
        const body = JSON.stringify({
            translations,
            source: source || 'en',
            target: target || 'fr',
            limit,
            batch_size,
            cooldown,
            num_predict,
        });
        const proto = url.protocol === 'https:' ? https : http;
        return await new Promise((resolve) => {
            const req = proto.request(url.href, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                timeout: 300000,
            }, (res) => {
                let d = '';
                res.on('data', c => { d += c; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try { resolve(JSON.parse(d)); } catch { resolve(null); }
                    } else { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(body);
            req.end();
        });
    } catch { return null; }
}

let LIBRE_CONFIG_LOADED = loadLibreTranslateConfig();

/* ================================================================
   GLOSSARY  — loaded from glossary.json (optional)
   ================================================================ */
let GLOSSARY = null;   // legacy fallback
let GLOSSARY_REGEX = null;
let GLOSSARY_MOD_MAP = null;
let GLOSSARY_MOD_REGEX = null;

/**
 * Build the in-memory glossary state from a JSON file.
 * @param {string} glossaryFile - Path/identifier of the glossary, relative to data/.
 * @returns {{map:Map<string,string>, regex:RegExp, lowerSet:Set<string>}|null} Glossary state or null.
 */
function buildGlossaryState(glossaryFile) {
    const glossaryPath = path.join(__dirname, 'data', glossaryFile || 'bg3/glossary.json');
    try {
        if (!fs.existsSync(glossaryPath)) return null;
        const raw = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
        const flat = new Map();        // all terms (every section)
        const modMap = new Map();      // mod_names only — these get __GL__ tokens
        const modNames = [];
        for (const [section, entries] of Object.entries(raw)) {
            if (section.startsWith('_')) continue;
            if (typeof entries !== 'object') continue;
            const isMod = section === 'mod_names';
            for (const [en, localized] of Object.entries(entries)) {
                if (typeof localized === 'string') {
                    flat.set(en, localized);
                    if (isMod) { modMap.set(en, localized); modNames.push(en); }
                }
            }
        }
        if (flat.size === 0) return null;

        // Full regex (all terms) — used by isFullyGlossary fast-path
        const allTerms = [...flat.keys()].sort((a, b) => b.length - a.length);
        const allEscaped = allTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const regex = new RegExp('\\b(' + allEscaped.join('|') + ')\\b', 'gi');

        // Mod-only regex — used by protectGlossary (only mod names get __GL__ tokens)
        let modRegex = null;
        if (modMap.size > 0) {
            const modTerms = [...modMap.keys()].sort((a, b) => b.length - a.length);
            const modEscaped = modTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            modRegex = new RegExp('\\b(' + modEscaped.join('|') + ')\\b', 'gi');
        }

        const lowerSet = new Set([...flat.keys()].map(k => k.toLowerCase()));
        return { map: flat, modMap, regex, modRegex, lowerSet, modNames };
    } catch {
        return null;
    }
}

/**
 * Load the global glossary for a target language.
 * @param {string} tgtLang - Target language code.
 * @param {string} glossaryFile - Path/identifier of the glossary.
 * @returns {boolean} True if a glossary was loaded.
 */
function loadGlossary(tgtLang, glossaryFile) {
    const state = buildGlossaryState(glossaryFile);
    if (!state) return false;
    GLOSSARY = state.map;
    GLOSSARY_REGEX = state.regex;
    GLOSSARY_MOD_MAP = state.modMap;
    GLOSSARY_MOD_REGEX = state.modRegex;
    return true;
}

function _gl(state) {
    return state || { map: GLOSSARY, modMap: GLOSSARY_MOD_MAP, regex: GLOSSARY_REGEX, modRegex: GLOSSARY_MOD_REGEX };
}

/**
 * Glossary protection: finds English D&D terms in SOURCE text,
 * replaces with placeholders before translation, then restores
 * with correct French (target) translations after.
 */
/**
 * Replace glossary terms in a source text with placeholders before translation.
 * @param {string} sourceText - Original text.
 * @param {Object} [glossaryState] - Optional glossary state (defaults to global).
 * @returns {{cleaned:string, glossaryTerms:Array<Object>}} Cleaned text and protected terms.
 */
function protectGlossary(sourceText, glossaryState) {
    // Only mod names are protected with __GL__ tokens.
    // Other glossary terms (items, blocks, materials…) stay visible in the
    // source text so the model can apply correct French grammar (articles,
    // gender, number). They are still passed as context hints via
    // getGlossaryContext().
    const { modMap, modRegex } = _gl(glossaryState);
    if (!modMap || !modRegex) return { cleaned: sourceText, glossaryTerms: [] };
    const glossaryTerms = [];
    let cleaned = sourceText;
    modRegex.lastIndex = 0;
    const matches = [...sourceText.matchAll(modRegex)];
    // Process from end to start to preserve indices
    const sorted = matches.sort((a, b) => b.index - a.index);
    // Deduplicate overlapping matches
    const used = new Set();
    for (const m of sorted) {
        const start = m.index;
        const end = start + m[0].length;
        let overlaps = false;
        for (const [us, ue] of used) {
            if (start < ue && end > us) { overlaps = true; break; }
        }
        if (overlaps) continue;
        used.add([start, end]);
        // Find the correct mod name (case-insensitive key lookup)
        let replacement = null;
        for (const [key, val] of modMap) {
            if (key.toLowerCase() === m[0].toLowerCase()) {
                replacement = val;
                break;
            }
        }
        if (replacement) {
            const ph = `__GL${glossaryTerms.length}__`;
            glossaryTerms.push({ ph, original: m[0], translated: replacement, index: start });
            cleaned = cleaned.substring(0, start) + ph + cleaned.substring(end);
        }
    }
    return { cleaned, glossaryTerms };
}

function restoreProtectedToken(text, token, value) {
    if (!text || !token) return text;
    const re = new RegExp(String(token).replace(/_/g, '_\\s*'), 'gi');
    return text.replace(re, value == null ? '' : value);
}

/**
 * Restore glossary placeholders in translated text with the correct localized terms.
 * @param {string} translatedText - Text with placeholders.
 * @param {Array<Object>} glossaryTerms - Protected glossary terms.
 * @returns {string} Text with glossary terms restored.
 */
/**
 * Vrai si un jeton de glossaire a disparu de la traduction.
 *
 * Les petits modèles ne préservent pas toujours les marqueurs __GLn__ : au lieu
 * de les recopier, ils les remplacent par un mot plausible pris dans les
 * indications du prompt. Mesuré avec gemma-4-e4b : « The Huntress and the
 * __GL0__ reach the Teleporter » est revenu en « La Chasseresse et le
 * Téléporteur atteignent le Téléporteur » — le nom protégé avait été écrasé.
 * Restaurer dans ce cas ne répare rien et laisse un contresens, donc on
 * préfère déclarer la traduction ratée et la confier au moteur suivant.
 *
 * @param {string} translatedText - Sortie du moteur.
 * @param {Array<Object>} glossaryTerms - Jetons posés avant traduction.
 * @returns {boolean} True si au moins un jeton manque.
 */
function hasLostGlossaryToken(translatedText, glossaryTerms) {
    if (!glossaryTerms || glossaryTerms.length === 0) return false;
    const text = String(translatedText || '');
    for (const { ph } of glossaryTerms) {
        if (ph && !text.includes(ph)) return true;
    }
    return false;
}

function restoreGlossary(translatedText, glossaryTerms) {
    if (!glossaryTerms || glossaryTerms.length === 0) return translatedText;
    let result = translatedText;
    const terms = [...glossaryTerms].sort((a, b) => String(b.ph).length - String(a.ph).length);
    for (const { ph, translated } of terms) {
        result = restoreProtectedToken(result, ph, translated);
    }
    return ensureRestoredTermSpacing(result, terms.map(t => t.translated));
}

/** After restoring a glossary term, keep a space if the model glued it (Createle → Create le). */
function ensureRestoredTermSpacing(text, terms) {
    let result = String(text || '');
    const unique = [...new Set((terms || []).filter(Boolean))].sort((a, b) => String(b).length - String(a).length);
    for (const term of unique) {
        if (String(term).length < 3) continue;
        const esc = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(`(${esc})(?=[A-Za-zÀ-ÿ])`, 'g'), '$1 ');
        result = result.replace(new RegExp(`(?<=[A-Za-zÀ-ÿ])(${esc})`, 'g'), ' $1');
    }
    return result;
}

/**
 * Check if the entire source text is made up ONLY of glossary terms +
 * whitespace / punctuation.  If so we can translate via glossary alone,
 * no API call needed.
 */
function isFullyGlossary(text, glossaryLowerSet, glossaryState) {
    const { map, regex } = _gl(glossaryState);
    if (!map || !regex || !glossaryLowerSet || glossaryLowerSet.size === 0) return false;
    let stripped = text.replace(regex, '');
    return /^[\s,;:\-–—.!?()/'"]*$/.test(stripped);
}

/**
 * Translate text using ONLY the glossary (no API call).
 * Returns the translated string with each glossary term replaced.
 */
/**
 * Translate a string by replacing glossary terms without any API call.
 * @param {string} text - Source text.
 * @param {Object} [glossaryState] - Optional glossary state.
 * @returns {string} Text with glossary terms replaced.
 */
function translateViaGlossary(text, glossaryState) {
    const { map, regex } = _gl(glossaryState);
    if (!map || !regex) return text;
    let result = text;
    regex.lastIndex = 0;
    result = result.replace(new RegExp(regex.source, 'gi'), (match) => {
        for (const [key, val] of map) {
            if (key.toLowerCase() === match.toLowerCase()) return val;
        }
        return match;
    });
    return result;
}

/**
 * Strings that need no API call — numbers, pure placeholders, punctuation-only.
 */
/**
 * Determine whether a string does not need translation (numbers, placeholders only, etc.).
 * @param {string} text - Text to inspect.
 * @returns {boolean} True if translation can be skipped.
 */
function isSkippableTranslation(text) {
    const t = normalizeKey(text);
    if (!t) return true;
    if (/^[\s\W_]*$/.test(t)) return true;
    if (t.length === 1 && !/[a-zA-ZÀ-ÿ]/.test(t)) return true;
    if (/^\d+([.,]\d+)?$/.test(t)) return true;

    let stripped = t;
    stripped = stripped.replace(PLACEHOLDER_PATTERN, '');
    stripped = stripped.replace(/%(\d+\$)?[sdif]/gi, '');
    stripped = stripped.replace(/%%/g, '');
    stripped = stripped.replace(/\s+/g, '');
    if (!stripped || /^[\W_]*$/.test(stripped)) return true;

    return false;
}

/* ================================================================
   LANGUAGE MAP
   ================================================================ */
const LANGUAGES = {
    "Auto Detect":"auto","Afrikaans":"af","Albanian":"sq","Arabic":"ar","Azerbaijani":"az",
    "Basque":"eu","Bengali":"bn","Belarusian":"be","Bulgarian":"bg","Catalan":"ca",
    "Chinese (Simplified)":"zh-CN","Chinese (Traditional)":"zh-TW","Croatian":"hr","Czech":"cs",
    "Danish":"da","Dutch":"nl","English":"en","Esperanto":"eo","Estonian":"et","Filipino":"tl",
    "Finnish":"fi","French":"fr","Galician":"gl","Georgian":"ka","German":"de","Greek":"el",
    "Gujarati":"gu","Haitian Creole":"ht","Hebrew":"he","Hindi":"hi","Hungarian":"hu",
    "Icelandic":"is","Indonesian":"id","Irish":"ga","Italian":"it","Japanese":"ja","Kannada":"kn",
    "Korean":"ko","Latin":"la","Latvian":"lv","Lithuanian":"lt","Macedonian":"mk","Malay":"ms",
    "Maltese":"mt","Norwegian":"no","Persian":"fa","Polish":"pl","Portuguese":"pt","Romanian":"ro",
    "Russian":"ru","Serbian":"sr","Slovak":"sk","Slovenian":"sl","Spanish":"es","Swahili":"sw",
    "Swedish":"sv","Tamil":"ta","Telugu":"te","Thai":"th","Turkish":"tr","Ukrainian":"uk",
    "Urdu":"ur","Vietnamese":"vi","Welsh":"cy","Yiddish":"yi"
};

/* Default tag pattern — BG3 tags only (LSTag / br) */
const TAG_PATTERN_BG3 = /<LSTag[^>]*?>|<\/LSTag>|<LSTag[^>]*?\/>|<br>/g;

/* Curly-brace placeholders — e.g. {who}, {item_name}, {0}
   AND Patchouli/Ars Nouveau macros — $(bold), $(br), $(l:item), $() */
const PLACEHOLDER_PATTERN = /\{[^}]+\}|\$\([^)]*\)/g;

/**
 * Load a tag filter file (e.g. data/tag.json) and build a regex from it.
 * Returns a RegExp with the 'gi' flags, or null if file not found.
 */
function loadTagFilter(tagFile) {
    if (!tagFile) return null;
    const filePath = path.isAbsolute(tagFile)
        ? tagFile
        : path.join(process.cwd(), 'data', tagFile);
    if (!fs.existsSync(filePath)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!data.tags || !Array.isArray(data.tags)) return null;
        const parts = data.tags.map(t => t.regex).filter(Boolean);
        if (parts.length === 0) return null;
        return new RegExp(parts.join('|'), 'gi');
    } catch {
        return null;
    }
}

/* DeepL language code mapping (DeepL uses different codes than Google) */
const DEEPL_LANG_MAP = {
    'auto': null, 'en': 'EN', 'fr': 'FR', 'de': 'DE', 'es': 'ES', 'it': 'IT',
    'pt': 'PT-BR', 'nl': 'NL', 'pl': 'PL', 'ru': 'RU', 'ja': 'JA', 'zh-CN': 'ZH-HANS',
    'zh-TW': 'ZH-HANT', 'ko': 'KO', 'cs': 'CS', 'da': 'DA', 'el': 'EL', 'et': 'ET',
    'fi': 'FI', 'hu': 'HU', 'id': 'ID', 'lt': 'LT', 'lv': 'LV', 'nb': 'NB', 'no': 'NB',
    'ro': 'RO', 'sk': 'SK', 'sl': 'SL', 'sv': 'SV', 'tr': 'TR', 'uk': 'UK', 'bg': 'BG',
    'ar': 'AR'
};

/* ================================================================
   HELPERS
   ================================================================ */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Canonical cache key — collapses whitespace, invisible chars, NFC unicode */
/**
 * Normalize a string for use as a cache key.
 * @param {string} text - Raw text.
 * @returns {string} Normalized cache key.
 */
function normalizeCacheKey(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/\u0000/g, '')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .replace(/\u00a0/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .normalize('NFC');
}

/** Normalize cache keys: strip null bytes and normalize whitespace */
/**
 * Alias for normalizeCacheKey.
 * @param {string} text - Raw text.
 * @returns {string} Normalized key.
 */
function normalizeKey(text) {
    return normalizeCacheKey(text);
}

function hasCorruptedTranslationText(text) {
    if (typeof text !== 'string') return true;
    if (!text.trim()) return true;

    // Unrestored protection tokens indicate a broken translation output.
    if (/__(?:GL|PH|T|SC)\d+__/i.test(text)) return true;

    // HTML wrapper leaks from some providers when token-preservation failed.
    if (/<span[^>]*translate=\"?no\"?[^>]*>/i.test(text)) return true;
    if (/&lt;span[^>]*translate=\"?no\"?[^>]*&gt;/i.test(text)) return true;

    // Provider error pages occasionally bubble into outputs.
    if (/Error 500 \(Server Error\)/i.test(text)) return true;
    if (/^\s*<html[\s>]/i.test(text)) return true;

    return false;
}

function toHttpCode(statusCode) {
    if (statusCode === 429) return 'HTTP_429';
    return `HTTP_${statusCode}`;
}

/* ================================================================
   RATE LIMITER + USER-AGENT ROTATION (évite les bans API)
   ================================================================ */
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
];
let _uaIdx = Math.floor(Math.random() * USER_AGENTS.length);
function nextUserAgent() {
    _uaIdx = (_uaIdx + 1) % USER_AGENTS.length;
    return USER_AGENTS[_uaIdx];
}

// Rate limiter global par host — limite les appels par seconde
const _hostRateState = new Map(); // host -> { lastCall, minInterval, tokens, maxTokens, refillMs }
function getRateLimiter(host, opts = {}) {
    const key = host;
    if (!_hostRateState.has(key)) {
        _hostRateState.set(key, {
            minInterval: opts.minInterval || 100,  // ms minimum entre 2 appels
            lastCall: 0,
            tokens: opts.maxTokens || 10,
            maxTokens: opts.maxTokens || 10,
            refillMs: opts.refillMs || 1000,  // 1 token / 100ms
            lastRefill: Date.now(),
            cooldownUntil: 0,  // timestamp jusqu'où on est en cooldown (429)
        });
    }
    return _hostRateState.get(key);
}

async function acquireToken(host, opts = {}) {
    const rl = getRateLimiter(host, opts);
    const now = Date.now();

    // Si on est en cooldown (429 reçu), attendre
    if (rl.cooldownUntil > now) {
        const wait = rl.cooldownUntil - now;
        await sleep(wait);
    }

    // Refill tokens
    const elapsed = now - rl.lastRefill;
    const refilled = Math.floor(elapsed / rl.refillMs);
    if (refilled > 0) {
        rl.tokens = Math.min(rl.maxTokens, rl.tokens + refilled);
        rl.lastRefill = now;
    }

    // Si pas de token, attendre
    if (rl.tokens <= 0) {
        const wait = rl.refillMs;
        await sleep(wait);
        rl.tokens = 1;
    }

    // Minimum interval entre appels
    const sinceLast = now - rl.lastCall;
    if (sinceLast < rl.minInterval) {
        await sleep(rl.minInterval - sinceLast);
    }

    rl.tokens--;
    rl.lastCall = Date.now();
}

function triggerCooldown(host, durationMs) {
    const rl = _hostRateState.get(host);
    if (rl) {
        rl.cooldownUntil = Math.max(rl.cooldownUntil, Date.now() + durationMs);
        rl.tokens = 0;  // vider les tokens
    }
}

async function httpGet(url, opts = {}) {
    const urlObj = new URL(url);
    const host = urlObj.hostname;

    // Hors du constructeur de Promise : un rejet d'acquireToken y serait avalé
    // et la promesse ne se règlerait jamais — le timeout n'étant armé qu'après,
    // l'appelant resterait bloqué indéfiniment.
    await acquireToken(host, opts.rateLimit || {});

    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': nextUserAgent(),
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
                'Accept-Encoding': 'identity',  // pas de gzip pour simplifier
                ...(opts.headers || {}),
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                // Respecter Retry-After header
                const retryAfter = res.headers['retry-after'];
                if (res.statusCode === 429 || res.statusCode === 503) {
                    let waitMs = 2000;
                    if (retryAfter) {
                        const sec = parseInt(retryAfter, 10);
                        if (!isNaN(sec)) waitMs = sec * 1000;
                        else {
                            const date = new Date(retryAfter);
                            if (!isNaN(date.getTime())) waitMs = Math.max(1000, date.getTime() - Date.now());
                        }
                    }
                    triggerCooldown(host, waitMs);
                    reject(new Error('HTTP_429'));
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(toHttpCode(res.statusCode)));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid JSON response')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(opts.timeout || 15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });
}

function httpPost(hostname, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const postData = typeof body === 'string' ? body : JSON.stringify(body);
        const options = {
            hostname,
            port: 443,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'BG3Translator/1.0',
                ...headers,
            },
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode === 429) {
                    reject(new Error('HTTP_429'));
                    return;
                }
                if (res.statusCode === 403 || res.statusCode === 401) {
                    reject(new Error('DEEPL_AUTH_FAILED'));
                    return;
                }
                if (res.statusCode === 456) {
                    reject(new Error('DEEPL_QUOTA_EXCEEDED'));
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(toHttpCode(res.statusCode)));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid JSON response')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(postData);
        req.end();
    });
}

/* ================================================================
   TRANSLATION CACHE  — persists to cache.json between runs
   Stores a glossary hash to auto-invalidate when glossary changes.
   Singleton per path + debounced disk writes.
   ================================================================ */
const CACHE_INSTANCES = new Map();
const CACHE_INIT_DONE = new Set();
const CACHE_SAVE_DELAY_MS = 3000;

class TranslationCache {
    constructor(cachePath) {
        this.path = path.resolve(cachePath);
        this.data = {};
        this.dirty = false;
        this._glossaryHash = null;
        this._saveTimer = null;
        this._savePromise = null;
        this._fileMtimeMs = 0;
        this._indexes = null;
    }

    _buildIndexes() {
        this._indexes = {};
        for (const langPair of Object.keys(this.data)) {
            if (langPair === '_meta') continue;
            const bucket = this.data[langPair];
            const index = new Map();
            for (const [k, v] of Object.entries(bucket)) {
                if (k === '_identity') continue;
                const nk = normalizeCacheKey(k);
                if (!nk) continue;
                const prev = index.get(nk);
                if (prev === undefined) {
                    index.set(nk, v);
                } else if (prev === nk && v !== nk) {
                    index.set(nk, v);
                }
            }
            this._indexes[langPair] = index;
        }
    }

    load() {
        try {
            if (fs.existsSync(this.path)) {
                const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
                if (raw._meta) {
                    this._glossaryHash = raw._meta.glossaryHash || null;
                    delete raw._meta;
                }
                this.data = raw;
                try {
                    this._fileMtimeMs = fs.statSync(this.path).mtimeMs;
                } catch {
                    this._fileMtimeMs = 0;
                }
            }
        } catch (e) {
            console.warn(`  Warning: could not load cache (${e.message}), starting fresh.`);
            this.data = {};
            this._fileMtimeMs = 0;
        }

        // Load SuperCacher.json (user overrides) and merge on top
        try {
            const dir = path.dirname(this.path);
            const superPath = path.join(dir, 'SuperCacher.json');
            if (fs.existsSync(superPath)) {
                const overrides = JSON.parse(fs.readFileSync(superPath, 'utf8'));
                let count = 0;
                for (const [lp, entries] of Object.entries(overrides)) {
                    if (!this.data[lp]) this.data[lp] = {};
                    for (const [key, val] of Object.entries(entries)) {
                        if (key === '_identity') continue;
                        const nk = normalizeCacheKey(key);
                        if (!nk) continue;
                        this.data[lp][nk] = val;
                        if (!this.data[lp]._identity) this.data[lp]._identity = {};
                        this.data[lp]._identity[nk] = true;
                        count++;
                    }
                }
                if (count > 0) {
                    console.log(`  SuperCacher: ${count} override(s) loaded`);
                }
            }
        } catch (e) {
            // ignore
        }

        if (this.needsCanonicalize()) {
            const canon = this.canonicalize();
            if (canon.merged > 0) {
                console.log(`  Cache: ${canon.merged} entrée(s) fusionnée(s) (clés normalisées)`);
            }
        }
        this._buildIndexes();
    }

    needsCanonicalize() {
        for (const langPair of Object.keys(this.data)) {
            if (langPair === '_meta') continue;
            const bucket = this.data[langPair];
            if (!bucket._identity) return true;
            for (const key of Object.keys(bucket)) {
                if (key === '_identity') continue;
                if (key !== normalizeCacheKey(key)) return true;
            }
        }
        return false;
    }

    /** Merge duplicate keys after normalization; preserve confirmed identity entries */
    canonicalize() {
        let merged = 0;
        for (const langPair of Object.keys(this.data)) {
            if (langPair === '_meta') continue;
            const bucket = this.data[langPair];
            const oldIdentity = bucket._identity || {};
            const newBucket = { _identity: { ...oldIdentity } };
            const newIdentity = newBucket._identity;

            for (const [key, val] of Object.entries(bucket)) {
                if (key === '_identity') continue;
                const nk = normalizeCacheKey(key);
                if (!nk) continue;

                if (oldIdentity[key] || oldIdentity[nk]) {
                    newIdentity[nk] = true;
                }

                if (val !== nk) {
                    const prev = newBucket[nk];
                    if (prev !== val) {
                        merged++;
                        newBucket[nk] = val;
                        delete newIdentity[nk];
                    }
                } else if (newIdentity[nk]) {
                    if (newBucket[nk] !== nk) merged++;
                    newBucket[nk] = nk;
                }
            }

            for (const [ik, flag] of Object.entries(oldIdentity)) {
                if (!flag) continue;
                const nk = normalizeCacheKey(ik);
                if (!nk) continue;
                newIdentity[nk] = true;
                if (newBucket[nk] === undefined) {
                    newBucket[nk] = nk;
                }
            }

            this.data[langPair] = newBucket;
        }
        if (merged > 0) this.dirty = true;
        return { merged };
    }

    _lookupInPair(langPair, nk) {
        const bucket = this.data[langPair];
        if (!bucket) return undefined;

        const resolve = (k, v) => {
            if (v === undefined) return undefined;
            if (v !== k) return v;
            if (bucket._identity?.[k]) return v;
            return undefined;
        };

        const index = this._indexes?.[langPair];
        if (index) {
            const v = index.get(nk);
            if (v !== undefined) return resolve(nk, v);
            return undefined;
        }

        if (nk in bucket) {
            const direct = resolve(nk, bucket[nk]);
            if (direct !== undefined) return direct;
        }

        for (const [k, v] of Object.entries(bucket)) {
            if (k === '_identity') continue;
            if (normalizeCacheKey(k) === nk) return resolve(nk, v);
        }
        return undefined;
    }

    get(langPair, key) {
        const nk = normalizeCacheKey(key);
        if (!nk) return undefined;

        let hit = this._lookupInPair(langPair, nk);
        if (hit !== undefined) return hit;

        // en|fr and auto|fr are equivalent for English→French
        const altPair = langPair === 'en|fr' ? 'auto|fr'
            : (langPair === 'auto|fr' ? 'en|fr' : null);
        if (altPair) return this._lookupInPair(altPair, nk);

        return undefined;
    }

    set(langPair, key, value, opts = {}) {
        const nk = normalizeCacheKey(key);
        const nv = typeof value === 'string' ? value.normalize('NFC') : value;
        if (!nk || typeof nv !== 'string') return;

        if (!this.data[langPair]) this.data[langPair] = { _identity: {} };
        if (!this.data[langPair]._identity) this.data[langPair]._identity = {};

        if (nv === nk) {
            if (!opts.confirmed) return;
            this.data[langPair]._identity[nk] = true;
            this.data[langPair][nk] = nk;
        } else {
            delete this.data[langPair]._identity[nk];
            this.data[langPair][nk] = nv;
        }

        if (!this._indexes) this._buildIndexes();
        if (this._indexes[langPair]) {
            this._indexes[langPair].set(nk, nv === nk ? nk : nv);
        }

        this.dirty = true;
        this.scheduleSave();
    }

    scheduleSave() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this.save();
        }, CACHE_SAVE_DELAY_MS);
    }

    flushSave() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        this.save();
    }

    /** Remove identity entries (key === value) — useless translations */
    deduplicate() {
        let removed = 0;
        for (const langPair of Object.keys(this.data)) {
            if (langPair === '_meta') continue;
            const entries = this.data[langPair];
            for (const key of Object.keys(entries)) {
                if (key === '_identity') continue;
                if (entries[key] === key && !entries._identity?.[key]) {
                    delete entries[key];
                    removed++;
                }
            }
        }
        if (removed > 0) this.dirty = true;
        return removed;
    }

    /** Remove cache entries that contain broken token artifacts or HTML error pages. */
    purgeCorruptedEntries() {
        let purged = 0;
        for (const langPair of Object.keys(this.data)) {
            if (langPair === '_meta') continue;
            const entries = this.data[langPair];
            for (const key of Object.keys(entries)) {
                if (key === '_identity') continue;
                if (hasCorruptedTranslationText(entries[key])) {
                    delete entries[key];
                    delete entries._identity?.[key];
                    purged++;
                }
            }
        }
        if (purged > 0) this.dirty = true;
        return purged;
    }

    /** Remove cached entries whose source text is entirely composed of
     *  glossary terms (those are resolved without API, no need to cache). */
    purgeGlossaryEntries(glossaryMap) {
        if (!glossaryMap || glossaryMap.size === 0) return 0;
        let purged = 0;
        const glossaryLower = new Set([...glossaryMap.keys()].map(k => k.toLowerCase()));
        const terms = [...glossaryMap.keys()].sort((a, b) => b.length - a.length);
        const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const purgeRegex = escaped.length ? new RegExp('\\b(' + escaped.join('|') + ')\\b', 'gi') : null;
        const purgeState = { map: glossaryMap, regex: purgeRegex, lowerSet: glossaryLower };
        for (const langPair of Object.keys(this.data)) {
            if (langPair === '_meta') continue;
            const entries = this.data[langPair];
            for (const key of Object.keys(entries)) {
                if (key === '_identity') continue;
                if (isFullyGlossary(key, glossaryLower, purgeState)) {
                    delete entries[key];
                    delete entries._identity?.[key];
                    purged++;
                }
            }
        }
        if (purged > 0) this.dirty = true;
        return purged;
    }

    /** Invalidate cache entries that contain glossary terms.
     *  Called when glossary has changed since last save. */
    invalidateForGlossary(glossaryMap) {
        if (!glossaryMap || glossaryMap.size === 0) return 0;
        let invalidated = 0;
        const terms = [...glossaryMap.keys()]
            .map(k => k.toLowerCase())
            .filter(k => k.length > 0)
            .sort((a, b) => b.length - a.length);

        let glossaryRegex = null;
        if (terms.length > 0 && terms.length <= 800) {
            try {
                const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                glossaryRegex = new RegExp(escaped.join('|'), 'i');
            } catch {
                glossaryRegex = null;
            }
        }

        for (const langPair of Object.keys(this.data)) {
            if (langPair === '_meta') continue;
            const entries = this.data[langPair];
            for (const key of Object.keys(entries)) {
                if (key === '_identity') continue;
                let hit = false;
                if (glossaryRegex) {
                    hit = glossaryRegex.test(key);
                } else {
                    const lower = key.toLowerCase();
                    for (const gk of terms) {
                        if (lower.includes(gk)) { hit = true; break; }
                    }
                }
                if (hit) {
                    delete entries[key];
                    delete entries._identity?.[key];
                    invalidated++;
                }
            }
        }
        if (invalidated > 0) {
            this.dirty = true;
            this.scheduleSave();
        }
        return invalidated;
    }

    save() {
        if (!this.dirty) return this._savePromise;
        if (this._savePromise) return this._savePromise;

        // JSON.stringify is kept in memory, but disk I/O is asynchronous so a
        // large cache cannot freeze the translation server/UI for minutes.
        const toSave = { _meta: { glossaryHash: this._glossaryHash, savedAt: new Date().toISOString() }, ...this.data };
        const payload = JSON.stringify(toSave);
        const tempPath = `${this.path}.tmp-${process.pid}`;
        this.dirty = false;
        this._savePromise = fsp.mkdir(path.dirname(this.path), { recursive: true })
            .then(() => fsp.writeFile(tempPath, payload, 'utf8'))
            .then(() => fsp.rename(tempPath, this.path))
            .then(() => {
                try { this._fileMtimeMs = fs.statSync(this.path).mtimeMs; } catch { this._fileMtimeMs = 0; }
            })
            .catch((e) => {
                this.dirty = true;
                try { fs.unlinkSync(tempPath); } catch {}
                console.error(`  Error saving cache: ${e.message}`);
            })
            .finally(() => {
                this._savePromise = null;
                if (this.dirty) this.scheduleSave();
            });
        return this._savePromise;
    }

    count(langPair) {
        const bucket = this.data[langPair] || {};
        return Object.keys(bucket).filter(k => k !== '_identity').length;
    }

    totalCount() {
        return Object.values(this.data).reduce((s, v) => {
            if (typeof v !== 'object') return s;
            return s + Object.keys(v).filter(k => k !== '_identity').length;
        }, 0);
    }

    /** Keep only the requested language pairs in memory to limit RAM usage. */
    prune(keepLangPairs) {
        const keep = new Set(keepLangPairs);
        for (const lp of Object.keys(this.data)) {
            if (lp === '_meta' || keep.has(lp)) continue;
            delete this.data[lp];
            if (this._indexes) delete this._indexes[lp];
            this.dirty = true;
        }
    }
}

/**
 * Get or create a singleton TranslationCache for a given file path.
 * @param {string} cachePath - Path to the cache JSON file.
 * @returns {TranslationCache} Cache instance.
 */
function getTranslationCache(cachePath) {
    const normalized = path.resolve(cachePath);
    if (!CACHE_INSTANCES.has(normalized)) {
        const cache = new TranslationCache(normalized);
        cache.load();
        CACHE_INSTANCES.set(normalized, cache);
        return cache;
    }

    const cache = CACHE_INSTANCES.get(normalized);
    try {
        if (fs.existsSync(normalized)) {
            const stat = fs.statSync(normalized);
            if (stat.mtimeMs > cache._fileMtimeMs) {
                cache.load();
            }
        }
    } catch {}
    return cache;
}

/**
 * Flush all in-memory translation caches to disk synchronously.
 */
function flushAllTranslationCaches() {
    return Promise.all(
        [...CACHE_INSTANCES.values()]
            .map(cache => cache.flushSave())
            .filter(Boolean)
    );
}

process.on('beforeExit', () => flushAllTranslationCaches());

/* ================================================================
   GLOBAL LIBRETRANSLATE CHECK  — shared across translator instances
   ================================================================ */
const globalLibreState = {
    checked: false,
    active: LIBRE_CONFIG_LOADED && !!LIBRE_URL,
    glossaryUploaded: false,
    checkPromise: null,
};

async function ensureGlobalLibreChecked(srcLang, tgtLang, glossaryFile, logger) {
    if (globalLibreState.checked) return globalLibreState.active;
    if (globalLibreState.checkPromise) return globalLibreState.checkPromise;

    globalLibreState.checkPromise = (async () => {
        globalLibreState.checked = true;
        if (!globalLibreState.active) return false;

        const ok = await checkLibreTranslate();
        globalLibreState.active = ok;
        if (ok) {
            logger(`  LibreTranslate: ✅ connecté (${LIBRE_URL})`);
            if (GLOSSARY && GLOSSARY.size > 0) {
                const uploaded = await uploadGlossaryToLibre(srcLang, tgtLang, glossaryFile, logger);
                if (uploaded) globalLibreState.glossaryUploaded = true;
            }
            const llmStatus = await getLibreLLMStatus();
            if (llmStatus) {
                if (!llmStatus.enabled && llmStatus.ollama_available) {
                    await setLibreLLM(true, logger);
                } else if (llmStatus.enabled && llmStatus.ollama_available) {
                    logger(`  🧠 LLM déjà actif: ${llmStatus.model} (GPU threshold: ${llmStatus.gpu_word_threshold}+ mots, complexity ≥${llmStatus.gpu_complexity_threshold})`);
                } else if (!llmStatus.ollama_available) {
                    logger(`  🧠 LLM: Ollama non disponible (${llmStatus.ollama_url}) — CPU seulement`);
                }
                if (llmStatus.ollama_available && (llmStatus.enabled || llmStatus.ollama_available)) {
                    const gamePrompt = getGamePrompt(glossaryFile, tgtLang);
                    if (gamePrompt) {
                        const pr = await setLibreLLMPrompt(gamePrompt);
                        if (pr) logger(`  🧠 Prompt LLM auto-configuré (${gamePrompt.length} chars)`);
                    }
                }
            }
        } else {
            logger(`  LibreTranslate: ❌ non joignable — désactivé`);
        }
        return globalLibreState.active;
    })();

    return globalLibreState.checkPromise;
}

/* ================================================================
   TRANSLATION APIs  — DeepL (priority), Google, MyMemory fallback
   ================================================================ */
async function translateDeepL(text, srcLang, tgtLang) {
    if (!DEEPL_KEY) throw new Error('DEEPL_NO_KEY');
    const tgtCode = DEEPL_LANG_MAP[tgtLang];
    if (!tgtCode) throw new Error(`DEEPL_UNSUPPORTED_LANG: ${tgtLang}`);
    const srcCode = srcLang === 'auto' ? undefined : DEEPL_LANG_MAP[srcLang];

    const hostname = DEEPL_FREE ? 'api-free.deepl.com' : 'api.deepl.com';

    // DeepL Free API requires application/x-www-form-urlencoded format
    const params = new URLSearchParams();
    params.append('text', text);
    params.append('target_lang', tgtCode);
    if (srcCode) params.append('source_lang', srcCode);
    const postData = params.toString();

    const result = await new Promise((resolve, reject) => {
        const req = https.request({
            hostname,
            port: 443,
            path: '/v2/translate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
                'Authorization': `DeepL-Auth-Key ${DEEPL_KEY}`,
                'User-Agent': 'BG3Translator/1.0',
            },
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode === 429) { reject(new Error('HTTP_429')); return; }
                if (res.statusCode === 403 || res.statusCode === 401) { reject(new Error('DEEPL_AUTH_FAILED')); return; }
                if (res.statusCode === 456) { reject(new Error('DEEPL_QUOTA_EXCEEDED')); return; }
                if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`)); return; }
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid JSON response')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(postData);
        req.end();
    });

    if (result.translations && result.translations[0]) {
        return result.translations[0].text;
    }
    throw new Error('DeepL: empty response');
}

/* DeepL BATCH — send up to 50 texts in a single API call */
const DEEPL_BATCH_SIZE = ENGINES.get('deepl').chunkSize;

async function translateDeepLBatch(texts, srcLang, tgtLang) {
    if (!DEEPL_KEY) throw new Error('DEEPL_NO_KEY');
    if (!texts.length) return [];
    const tgtCode = DEEPL_LANG_MAP[tgtLang];
    if (!tgtCode) throw new Error(`DEEPL_UNSUPPORTED_LANG: ${tgtLang}`);
    const srcCode = srcLang === 'auto' ? undefined : DEEPL_LANG_MAP[srcLang];

    const hostname = DEEPL_FREE ? 'api-free.deepl.com' : 'api.deepl.com';

    const params = new URLSearchParams();
    for (const t of texts) params.append('text', t);
    params.append('target_lang', tgtCode);
    if (srcCode) params.append('source_lang', srcCode);
    const postData = params.toString();

    const result = await new Promise((resolve, reject) => {
        const req = https.request({
            hostname,
            port: 443,
            path: '/v2/translate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
                'Authorization': `DeepL-Auth-Key ${DEEPL_KEY}`,
                'User-Agent': 'BG3Translator/1.0',
            },
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode === 429) { reject(new Error('HTTP_429')); return; }
                if (res.statusCode === 403 || res.statusCode === 401) { reject(new Error('DEEPL_AUTH_FAILED')); return; }
                if (res.statusCode === 456) { reject(new Error('DEEPL_QUOTA_EXCEEDED')); return; }
                if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`)); return; }
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid JSON response')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(postData);
        req.end();
    });

    if (result.translations && result.translations.length === texts.length) {
        return result.translations.map(t => t.text);
    }
    throw new Error(`DeepL batch: expected ${texts.length} translations, got ${result.translations ? result.translations.length : 0}`);
}

/* ================================================================
   LibreTranslate API  — local, unlimited, batch-capable
   ================================================================ */
const LIBRE_BATCH_SIZE = ENGINES.get('libre').chunkSize;   // texts per API call (max, reduced for long texts)
const LIBRE_BATCH_CHARS = 5000; // max total chars per batch (adaptive sizing)
const LIBRE_PARALLEL  = 2;     // concurrent batch requests
const LIBRE_GPU_TIMEOUT = 600000; // 10 min timeout for GPU single-shot batch

// Token pattern: __GL0__, __PH0__, __T0__ etc. used for glossary/placeholder/tag protection
const TOKEN_RE = /(__(?:GL|PH|T)\d+__)/g;

/**
 * Wrap protection tokens in <span translate="no"> for HTML-mode LibreTranslate.
 * This prevents LibreTranslate from altering/translating our placeholders.
 */
function wrapTokensForHtml(text) {
    return text.replace(TOKEN_RE, '<span translate="no">$1</span>');
}

/**
 * Strip <span translate="no">...</span> wrappers from translated text,
 * restoring the original __GL0__ / __PH0__ / __T0__ tokens.
 */
function unwrapTokensFromHtml(text) {
    return text.replace(/<span[^>]*translate="no"[^>]*>(.*?)<\/span>/gi, '$1');
}

async function translateLibre(text, srcLang, tgtLang) {
    if (!LIBRE_URL) throw new Error('LIBRE_NOT_CONFIGURED');
    const url = new URL('/translate', LIBRE_URL);

    // If text contains protection tokens, use HTML format to preserve them
    const hasTokens = TOKEN_RE.test(text);
    TOKEN_RE.lastIndex = 0;
    const qText = hasTokens ? wrapTokensForHtml(text) : text;
    const body = JSON.stringify({
        q: qText,
        source: srcLang === 'auto' ? 'auto' : srcLang,
        target: tgtLang,
        format: hasTokens ? 'html' : 'text',
        mode: LIBRE_MODE,
    });

    const proto = url.protocol === 'https:' ? https : http;
    const result = await new Promise((resolve, reject) => {
        const req = proto.request(url.href, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`LibreTranslate HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('LibreTranslate: invalid JSON')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('LibreTranslate timeout')); });
        req.write(body);
        req.end();
    });

    if (result.translatedText) {
        let translated = result.translatedText;
        if (hasTokens) translated = unwrapTokensFromHtml(translated);
        return { text: translated, engine: result.engine || null, timing_ms: result.timing_ms || null };
    }
    throw new Error('LibreTranslate: empty response');
}

async function translateLibreBatch(texts, srcLang, tgtLang) {
    if (!LIBRE_URL) throw new Error('LIBRE_NOT_CONFIGURED');
    if (!texts.length) return [];

    // Check which texts have protection tokens → use HTML wrapping for those
    const hasAnyTokens = texts.some(t => { TOKEN_RE.lastIndex = 0; return TOKEN_RE.test(t); });
    const wrappedTexts = hasAnyTokens ? texts.map(t => wrapTokensForHtml(t)) : texts;

    const src = srcLang === 'auto' ? 'auto' : srcLang;
    const fmt = hasAnyTokens ? 'html' : 'text';

    // Strategy: /translate_batch corrupts tokens inside <span translate="no">,
    // so use /translate with q:[array] + format:html when tokens are present (perfect preservation),
    // and /translate_batch for plain text (parallel execution, higher throughput).
    const endpoint = hasAnyTokens ? '/translate' : '/translate_batch';
    const url = new URL(endpoint, LIBRE_URL);

    let body;
    if (hasAnyTokens) {
        // /translate with q as array — format html preserves tokens perfectly
        body = JSON.stringify({ q: wrappedTexts, source: src, target: tgtLang, format: fmt, mode: LIBRE_MODE });
    } else {
        // /translate_batch — parallel execution, no tokens to protect
        body = JSON.stringify({ texts: wrappedTexts.map(t => ({ q: t, source: src, target: tgtLang, format: fmt, mode: LIBRE_MODE })) });
    }

    const proto = url.protocol === 'https:' ? https : http;
    const result = await new Promise((resolve, reject) => {
        const req = proto.request(url.href, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`LibreTranslate HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('LibreTranslate: invalid JSON')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(180000, () => { req.destroy(); reject(new Error('LibreTranslate batch timeout')); });
        req.write(body);
        req.end();
    });

    // Parse response based on which endpoint was used
    if (hasAnyTokens) {
        // /translate returns { translatedText: [...], engine: ... }
        if (result.translatedText && Array.isArray(result.translatedText)) {
            if (result.translatedText.length !== texts.length) {
                throw new Error(`LibreTranslate batch: expected ${texts.length}, got ${result.translatedText.length}`);
            }
            return { texts: result.translatedText.map(t => unwrapTokensFromHtml(t)), engine: result.engine || null, timing_ms: result.timing_ms || null };
        }
        throw new Error('LibreTranslate batch: unexpected response format');
    } else {
        // /translate_batch returns { translations: [{translatedText: ..., engine: ...}, ...] }
        if (result.translations && Array.isArray(result.translations)) {
            if (result.translations.length !== texts.length) {
                throw new Error(`LibreTranslate batch: expected ${texts.length}, got ${result.translations.length}`);
            }
            const engines = result.translations.map(t => t.engine || null);
            return {
                texts: result.translations.map((t, i) => {
                    if (t.error) throw new Error(`LibreTranslate batch item ${i}: ${t.error}`);
                    return t.translatedText;
                }),
                engine: engines[0] || null,
                engines,
                timing_ms: result.translations.reduce((s, t) => s + (t.timing_ms || 0), 0)
            };
        }
        throw new Error('LibreTranslate batch: unexpected response format');
    }
}

/**
 * GPU single-shot batch: send ALL texts in one request using the simple string array format.
 * Only used when mode=gpu. Avoids chunking overhead and reduces API calls to 1.
 * Uses a health-check watchdog instead of a fixed timeout: polls /health every 20s.
 * If health responds OK → GPU is still working → keep waiting.
 * If health fails → server is dead → abort.
 */
async function translateLibreBatchGPU(texts, srcLang, tgtLang, logger) {
    if (!LIBRE_URL) throw new Error('LIBRE_NOT_CONFIGURED');
    if (!texts.length) return { texts: [], engine: 'ollama', timing_ms: 0 };

    const hasAnyTokens = texts.some(t => { TOKEN_RE.lastIndex = 0; return TOKEN_RE.test(t); });
    const wrappedTexts = hasAnyTokens ? texts.map(t => wrapTokensForHtml(t)) : texts;

    const src = srcLang === 'auto' ? 'auto' : srcLang;
    const url = new URL('/translate_batch', LIBRE_URL);
    const body = JSON.stringify({
        texts: wrappedTexts,
        source: src,
        target: tgtLang,
        format: hasAnyTokens ? 'html' : 'text',
        mode: 'gpu',
    });

    const proto = url.protocol === 'https:' ? https : http;
    const startTime = Date.now();

    const result = await new Promise((resolve, reject) => {
        let settled = false;
        let healthCheckInterval = null;
        let healthFailCount = 0;

        const req = proto.request(url.href, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                settled = true;
                if (healthCheckInterval) clearInterval(healthCheckInterval);
                if (res.statusCode !== 200) {
                    reject(new Error(`LibreTranslate GPU HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('LibreTranslate GPU: invalid JSON')); }
            });
        });
        req.on('error', (e) => {
            settled = true;
            if (healthCheckInterval) clearInterval(healthCheckInterval);
            reject(e);
        });
        // No fixed timeout — watchdog handles it
        req.write(body);
        req.end();

        // Health-check watchdog: poll /health every 20s
        healthCheckInterval = setInterval(async () => {
            if (settled) { clearInterval(healthCheckInterval); return; }
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            try {
                const alive = await checkLibreTranslate();
                if (alive) {
                    healthFailCount = 0;
                    if (logger) {
                        const mins = Math.floor(elapsed / 60);
                        const secs = elapsed % 60;
                        logger(`   🧠 GPU en cours... ${mins}m${secs.toString().padStart(2, '0')}s — serveur OK`);
                    }
                } else {
                    healthFailCount++;
                    if (logger) logger(`   ⚠️ Health check échoué (${healthFailCount}/3) — ${elapsed}s écoulées`);
                    if (healthFailCount >= 3) {
                        clearInterval(healthCheckInterval);
                        req.destroy();
                        if (!settled) {
                            settled = true;
                            reject(new Error('LibreTranslate GPU: serveur non joignable (health check 3x échoué)'));
                        }
                    }
                }
            } catch {
                healthFailCount++;
                if (healthFailCount >= 3 && !settled) {
                    clearInterval(healthCheckInterval);
                    req.destroy();
                    settled = true;
                    reject(new Error('LibreTranslate GPU: serveur non joignable (health check erreur)'));
                }
            }
        }, 20000);
    });

    const totalMs = Date.now() - startTime;

    // Response: { translations: [{translatedText, engine, timing_ms}, ...] }
    if (result.translations && Array.isArray(result.translations)) {
        if (result.translations.length !== texts.length) {
            throw new Error(`LibreTranslate GPU batch: expected ${texts.length}, got ${result.translations.length}`);
        }
        const engines = result.translations.map(t => t.engine || 'ollama');
        return {
            texts: result.translations.map((t, i) => {
                if (t.error) throw new Error(`LibreTranslate GPU batch item ${i}: ${t.error}`);
                let txt = t.translatedText;
                if (hasAnyTokens) txt = unwrapTokensFromHtml(txt);
                return txt;
            }),
            engine: 'ollama',
            engines,
            timing_ms: totalMs
        };
    }
    throw new Error('LibreTranslate GPU batch: unexpected response format');
}

/**
 * GPU Progressive / Dual-GPU batch: sorts texts by difficulty tier,
 * translates with tier-aware GPU routing, returns per-tier timing stats.
 * mode param controls the strategy sent to LibreTranslate.
 */
async function translateLibreBatchGPUProgressive(texts, srcLang, tgtLang, logger, batchMode) {
    if (!LIBRE_URL) throw new Error('LIBRE_NOT_CONFIGURED');
    if (!texts.length) return { texts: [], engine: 'ollama', timing_ms: 0, stats: null };

    const modeToSend = batchMode || 'gpu_progressive';
    const isDual = modeToSend === 'dual_gpu';
    const modeLabel = isDual ? 'Dual-GPU' : 'GPU Progressive';

    const hasAnyTokens = texts.some(t => { TOKEN_RE.lastIndex = 0; return TOKEN_RE.test(t); });
    const wrappedTexts = hasAnyTokens ? texts.map(t => wrapTokensForHtml(t)) : texts;

    const src = srcLang === 'auto' ? 'auto' : srcLang;
    const url = new URL('/translate_batch', LIBRE_URL);
    const body = JSON.stringify({
        texts: wrappedTexts,
        source: src,
        target: tgtLang,
        format: hasAnyTokens ? 'html' : 'text',
        mode: modeToSend,
    });

    const proto = url.protocol === 'https:' ? https : http;
    const startTime = Date.now();

    const result = await new Promise((resolve, reject) => {
        let settled = false;
        let healthCheckInterval = null;
        let healthFailCount = 0;

        const req = proto.request(url.href, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                settled = true;
                if (healthCheckInterval) clearInterval(healthCheckInterval);
                if (res.statusCode !== 200) {
                    reject(new Error(`LibreTranslate ${modeLabel} HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error(`LibreTranslate ${modeLabel}: invalid JSON`)); }
            });
        });
        req.on('error', (e) => {
            settled = true;
            if (healthCheckInterval) clearInterval(healthCheckInterval);
            reject(e);
        });
        req.write(body);
        req.end();

        // Health-check watchdog
        healthCheckInterval = setInterval(async () => {
            if (settled) { clearInterval(healthCheckInterval); return; }
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            try {
                const alive = await checkLibreTranslate();
                if (alive) {
                    healthFailCount = 0;
                    if (logger) {
                        const mins = Math.floor(elapsed / 60);
                        const secs = elapsed % 60;
                        logger(`   🧠 ${modeLabel} en cours... ${mins}m${secs.toString().padStart(2, '0')}s — serveur OK`);
                    }
                } else {
                    healthFailCount++;
                    if (logger) logger(`   ⚠️ Health check échoué (${healthFailCount}/3) — ${elapsed}s`);
                    if (healthFailCount >= 3) {
                        clearInterval(healthCheckInterval);
                        req.destroy();
                        if (!settled) { settled = true; reject(new Error(`LibreTranslate ${modeLabel}: serveur non joignable`)); }
                    }
                }
            } catch {
                healthFailCount++;
                if (healthFailCount >= 3 && !settled) {
                    clearInterval(healthCheckInterval);
                    req.destroy();
                    settled = true;
                    reject(new Error(`LibreTranslate ${modeLabel}: serveur non joignable`));
                }
            }
        }, 20000);
    });

    const totalMs = Date.now() - startTime;

    if (result.translations && Array.isArray(result.translations)) {
        if (result.translations.length !== texts.length) {
            throw new Error(`LibreTranslate ${modeLabel}: expected ${texts.length}, got ${result.translations.length}`);
        }
        return {
            texts: result.translations.map((t, i) => {
                if (t.error) throw new Error(`LibreTranslate ${modeLabel} item ${i}: ${t.error}`);
                let txt = t.translatedText;
                if (hasAnyTokens) txt = unwrapTokensFromHtml(txt);
                return txt;
            }),
            engine: 'ollama',
            timing_ms: totalMs,
            tierStats: result.stats || null,
        };
    }
    throw new Error(`LibreTranslate ${modeLabel}: unexpected response format`);
}

// Moteur « Google rapide » retiré de l'édition publique : il utilisait des adresses non officielles de Google, contraires à ses conditions.
// Cette fonction ne fait plus d'appel réseau : elle renvoie le texte tel quel, ce que les appelants traitent comme « échec » pour passer au moteur suivant.
async function translateGoogle(text) { return text; }

/* Google fallback batch — parallel waves with adaptive backoff on 429 */
const GOOGLE_SAFE_CONCURRENCY = 8;   // réduit de 12 → 8 pour éviter bans
const GOOGLE_MAX_CONCURRENCY = 12;   // réduit de 15 → 12
const GOOGLE_SAFE_DELAY_MS = 150;    // augmenté de 120 → 150
const GOOGLE_MAX_RETRIES = 4;        // augmenté de 2 → 4
const MYMEMORY_SAFE_CONCURRENCY = 4;
const MYMEMORY_SAFE_DELAY_MS = 400;
const GOOGLE_FAST_MAX_CHARS = 80;
const GOOGLE_FAST_MAX_TOKENS = 24;

function isFastGoogleCandidate() {
    return false;   // voie rapide Google retirée de l'édition publique
}

async function translateGoogleBatch(texts, srcLang, tgtLang, opts = {}) {
    if (!texts.length) return [];
    let concurrency = Math.min(Math.max(opts.concurrency || GOOGLE_SAFE_CONCURRENCY, 4), GOOGLE_MAX_CONCURRENCY);
    let delayMs = Math.max(opts.delayMs || GOOGLE_SAFE_DELAY_MS, 80);
    const onRateLimit = opts.onRateLimit;
    const results = new Array(texts.length);

    for (let i = 0; i < texts.length; ) {
        const waveSize = Math.min(concurrency, texts.length - i);
        const chunk = texts.slice(i, i + waveSize);
        const chunkResults = await Promise.all(chunk.map(async (text) => {
            for (let attempt = 0; attempt <= GOOGLE_MAX_RETRIES; attempt++) {
                try {
                    return await translateGoogle(text, srcLang, tgtLang);
                } catch (e) {
                    if (e.message === 'HTTP_429') {
                        // Backoff exponentiel + jitter
                        const base = Math.min(delayMs * Math.pow(2, attempt), 5000);
                        const jitter = Math.floor(Math.random() * 500);
                        const wait = base + jitter;
                        concurrency = Math.max(2, Math.floor(concurrency / 2));
                        delayMs = Math.min(delayMs * 2, 3000);
                        if (onRateLimit) onRateLimit(concurrency, delayMs);
                        if (attempt < GOOGLE_MAX_RETRIES) {
                            await sleep(wait);
                        } else {
                            return text;  // abandon après max retries
                        }
                    } else if (attempt < GOOGLE_MAX_RETRIES) {
                        // Retry avec backoff pour autres erreurs
                        const wait = 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
                        await sleep(wait);
                    } else {
                        return text;
                    }
                }
            }
            return text;
        }));

        for (let j = 0; j < chunk.length; j++) {
            results[i + j] = chunkResults[j];
        }
        i += waveSize;

        if (typeof opts.onProgress === 'function') {
            opts.onProgress(Math.min(i, texts.length), texts.length, concurrency, delayMs);
        }
        if (i < texts.length) {
            // Jitter sur le delay entre vagues aussi
            const jitter = Math.floor(Math.random() * 50);
            await sleep(delayMs + jitter);
        }
    }

    return results;
}

async function translateMyMemoryBatch(texts, srcLang, tgtLang, opts = {}) {
    if (!texts.length) return [];
    const concurrency = Math.min(opts.concurrency || MYMEMORY_SAFE_CONCURRENCY, 5);
    const delayMs = Math.max(opts.delayMs || MYMEMORY_SAFE_DELAY_MS, 300);
    const results = new Array(texts.length);

    for (let i = 0; i < texts.length; i += concurrency) {
        const chunk = texts.slice(i, i + concurrency);
        const chunkResults = await Promise.all(chunk.map(async (text) => {
            try {
                return await translateMyMemory(text, srcLang, tgtLang);
            } catch {
                return text;
            }
        }));
        for (let j = 0; j < chunk.length; j++) {
            results[i + j] = chunkResults[j];
        }
        if (i + concurrency < texts.length) {
            await sleep(delayMs);
        }
    }

    return results;
}

async function translateMyMemory(text, srcLang, tgtLang) {
    const pair = `${srcLang === 'auto' ? 'en' : srcLang}|${tgtLang}`;
    const url = `https://api.mymemory.translated.net/get`
        + `?q=${encodeURIComponent(text)}`
        + `&langpair=${encodeURIComponent(pair)}`;
    const d = await httpGet(url);
    if (d.responseStatus === 200 && d.responseData?.translatedText)
        return d.responseData.translatedText;
    throw new Error(d.responseDetails || 'MyMemory failed');
}

/* ================================================================
   GEMINI API  — Google Gemini free tier (15 RPM, 1000 RPD)
   ================================================================ */
let GEMINI_KEY = null;
let GEMINI_MODEL = 'gemini-2.5-flash';

function loadGeminiKey() {
    const keyPath = path.join(__dirname, 'data', 'APIcle.json');
    try {
        if (fs.existsSync(keyPath)) {
            const data = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
            const key = (data.gemini && data.gemini.key) ? data.gemini.key.trim() : '';
            if (key && key.length > 5) {
                GEMINI_KEY = key;
                GEMINI_MODEL = (data.gemini && data.gemini.model) ? data.gemini.model.trim() : 'gemini-2.5-flash';
                return true;
            }
        }
    } catch (e) { /* ignore */ }
    GEMINI_KEY = null;
    return false;
}

let GEMINI_AVAILABLE = loadGeminiKey();

/* ================================================================
   OPENROUTER API — modèle gratuit openrouter/free (optionnel)
   ================================================================ */
let OPENROUTER_KEY = null;
let OPENROUTER_MODEL = 'openrouter/free';

function loadSaveEnvValues() {
    const values = {};
    const envPath = path.join(__dirname, 'data', 'Save_Autre', 'Save.env');
    try {
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
            const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
        }
    } catch {}
    return values;
}

function loadOpenRouterKey() {
    const temporaryKey = String(process.env.OPENROUTER_KEY || '').trim();
    if (temporaryKey.length > 10) {
        OPENROUTER_KEY = temporaryKey;
        OPENROUTER_MODEL = String(process.env.OPENROUTER_MODEL || 'openrouter/free').trim() || 'openrouter/free';
        return true;
    }
    const keyPath = path.join(__dirname, 'data', 'APIcle.json');
    try {
        if (fs.existsSync(keyPath)) {
            const data = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
            const cfg = data.openrouter || {};
            const key = String(cfg.key || '').trim();
            OPENROUTER_MODEL = String(cfg.model || 'openrouter/free').trim() || 'openrouter/free';
            // "enabled": false in APIcle.json turns OpenRouter off without deleting the key
            OPENROUTER_KEY = key.length > 10 && cfg.enabled !== false ? key : null;
            return !!OPENROUTER_KEY;
        }
    } catch {}
    OPENROUTER_KEY = null;
    OPENROUTER_MODEL = 'openrouter/free';
    return false;
}

let OPENROUTER_AVAILABLE = loadOpenRouterKey();
const OPENROUTER_MIN_INTERVAL_MS = 3000; // ≈20 requêtes/minute pour les modèles :free
const OPENROUTER_MAX_RETRIES = 4;
let openRouterLastRequestAt = 0;
let openRouterQueue = Promise.resolve();

async function waitOpenRouterSlot() {
    const elapsed = Date.now() - openRouterLastRequestAt;
    if (elapsed < OPENROUTER_MIN_INTERVAL_MS) {
        await new Promise(resolve => setTimeout(resolve, OPENROUTER_MIN_INTERVAL_MS - elapsed));
    }
    openRouterLastRequestAt = Date.now();
}

function queueOpenRouterRequest(task) {
    const run = openRouterQueue.then(task, task);
    openRouterQueue = run.catch(() => {});
    return run;
}

/* ================================================================
   LM STUDIO  — local OpenAI-compatible / native /api/v1/chat
   ================================================================ */
let LMSTUDIO_URL = 'http://127.0.0.1:1234';
let LMSTUDIO_MODEL = '';
let LMSTUDIO_ENABLED = true;
let LMSTUDIO_PARALLEL = 4;
let LMSTUDIO_MAX_TOKENS = 2048;
let LMSTUDIO_CONTEXT_TOKENS = 4096;
let LMSTUDIO_MODE = 'quality';
const LMSTUDIO_PROMPT_TOKENS = 1100;
const LMSTUDIO_CHUNK_MAX = ENGINES.get('lmstudio').chunkSize;
const LMSTUDIO_PARALLEL_MAX = 4;
let lmStudioNativeMissing = false;
let lmStudioSolo = false;
const lmStudioInflight = new Set();

function enterLmStudioSolo(logger) {
    if (lmStudioSolo) return;
    lmStudioSolo = true;
    for (const req of [...lmStudioInflight]) {
        try { req.destroy(); } catch {}
    }
    if (logger) logger('   [LM Studio] contexte trop long — stop des requêtes, 1 seule à la fois (VRAM)');
}

function isLmStudioAbortError(err) {
    return /lmstudio-solo|ECONNRESET|socket hang up|aborted|destroyed/i.test(String(err && err.message || ''));
}

function clampLmStudioParallel(n) {
    const v = parseInt(n, 10);
    if (!Number.isFinite(v)) return 4;
    return Math.max(1, Math.min(LMSTUDIO_PARALLEL_MAX, v));
}

function clampLmStudioMaxTokens(n) {
    const v = parseInt(n, 10);
    if (!Number.isFinite(v)) return 2048;
    return Math.max(256, Math.min(4096, v));
}

function clampLmStudioContext(n) {
    const v = parseInt(n, 10);
    if (!Number.isFinite(v)) return 4096;
    // Keep within the safe 32k token ceiling — modern LLMs support 32k+
    return Math.max(2048, Math.min(32768, v));
}

function normalizeLmStudioMode(mode) {
    return mode === 'fast' ? 'fast' : 'quality';
}

function lmStudioSampling() {
    return LMSTUDIO_MODE === 'fast'
        ? { temperature: 0.1, top_p: 0.9, top_k: 40, min_p: 0.05 }
        : { temperature: 0.2, top_p: 0.95, top_k: 64, min_p: 0.05 };
}
const lmStudioState = { checked: false, active: false, model: '', models: [], contextTokens: 0, endpoint: '', modelsLoaded: 0 };

function loadLmStudioConfig() {
    let cfg = {};
    try {
        const keyPath = path.join(__dirname, 'data', 'APIcle.json');
        if (fs.existsSync(keyPath)) cfg = JSON.parse(fs.readFileSync(keyPath, 'utf8')).lmstudio || {};
    } catch {}
    const env = loadSaveEnvValues();
    const envValue = (key, fallback) => {
        const value = env[key];
        return value === undefined || value === '' || value.toLowerCase() === 'null' ? fallback : value;
    };
    const boolValue = (value, fallback) => {
        if (value === undefined) return fallback;
        return String(value).toLowerCase() !== 'false';
    };

    LMSTUDIO_ENABLED = boolValue(envValue('LMStudioEnabled', cfg.enabled !== false), true);
    LMSTUDIO_URL = String(envValue('LMStudioUrl', cfg.url || 'http://127.0.0.1:1234')).replace(/\/+$/, '');
    LMSTUDIO_MODEL = String(envValue('LMStudioModel', cfg.model || '')).trim();
    LMSTUDIO_PARALLEL = clampLmStudioParallel(envValue('LMStudioParallel', cfg.parallel));
    LMSTUDIO_MAX_TOKENS = clampLmStudioMaxTokens(envValue('LMStudioMaxTokens', cfg.maxTokens));
    LMSTUDIO_CONTEXT_TOKENS = clampLmStudioContext(envValue('LMStudioContextTokens', cfg.contextTokens));
    LMSTUDIO_MODE = normalizeLmStudioMode(envValue('LMStudioMode', cfg.mode));
    return LMSTUDIO_ENABLED;
}

let LMSTUDIO_AVAILABLE = loadLmStudioConfig();

/**
 * Reload API and service configuration from data/APIcle.json.
 */
function reloadApicleConfig() {
    DEEPL_AVAILABLE = loadDeepLKey();
    LIBRE_CONFIG_LOADED = loadLibreTranslateConfig();
    GEMINI_AVAILABLE = loadGeminiKey();
    OPENROUTER_AVAILABLE = loadOpenRouterKey();
    LMSTUDIO_AVAILABLE = loadLmStudioConfig();
    if (typeof globalLibreState !== 'undefined') {
        globalLibreState.checked = false;
        globalLibreState.active = LIBRE_CONFIG_LOADED && !!LIBRE_URL;
    }
    lmStudioState.checked = false;
    lmStudioState.active = false;
    lmStudioState.model = '';
    lmStudioState.models = [];
    lmStudioState.contextTokens = 0;
    lmStudioState.endpoint = '';
    lmStudioState.modelsLoaded = 0;
    lmStudioNativeMissing = false;
}

function unwrapLmContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(c => {
            if (typeof c === 'string') return c;
            if (!c || typeof c !== 'object') return '';
            if (c.type === 'reasoning' || c.type === 'thought') return '';
            return c.text || c.content || c.output_text || '';
        }).join('');
    }
    return '';
}

function extractLmStudioText(data) {
    if (!data || typeof data !== 'object') return '';
    if (Array.isArray(data.output)) {
        const msg = data.output.find(o => o && (o.type === 'message' || o.type === 'text' || o.type === 'output_text'))
            || data.output.find(o => o && o.type !== 'reasoning' && o.type !== 'thought' && (o.content || o.text));
        const fromMsg = unwrapLmContent(msg && (msg.content || msg.text));
        if (fromMsg) return fromMsg;
        const joined = data.output
            .filter(o => o && o.type !== 'reasoning' && o.type !== 'thought')
            .map(o => unwrapLmContent(o && (o.content || o.text)))
            .filter(Boolean)
            .join('\n');
        if (joined) return joined;
    }
    if (typeof data.output === 'string') return data.output;
    const choice = data.choices && data.choices[0];
    const msg = choice && choice.message;
    const fromChoice = unwrapLmContent(msg && msg.content)
        || unwrapLmContent(choice && choice.text)
        || unwrapLmContent(msg && msg.parsed && JSON.stringify(msg.parsed));
    if (fromChoice) return fromChoice;
    const direct = unwrapLmContent(data.content) || unwrapLmContent(data.response);
    return direct;
}

function lmStudioReasoningOnly(data) {
    if (!data || typeof data !== 'object') return false;
    if (Array.isArray(data.output) && data.output.length) {
        return data.output.every(o => o && (o.type === 'reasoning' || o.type === 'thought'));
    }
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) return false;
    const content = unwrapLmContent(msg.content);
    const think = unwrapLmContent(msg.reasoning_content || msg.reasoning);
    return !content && !!think;
}

function estimateLmTokens(s) {
    return Math.ceil(String(s || '').length / 3);
}

function lmStudioSafeContext() {
    // Cap total context at 32k tokens — modern LLMs (Gemma 3, Qwen 3) support 32k+
    return Math.max(2048, Math.min(32768, lmStudioState.contextTokens || LMSTUDIO_CONTEXT_TOKENS));
}

function buildLmStudioSystemPrompt(glossaryFile, tgtLang, n, compact, contextHint = '') {
    const langLabel = tgtLang === 'fr' ? 'français' : tgtLang;
    const context = contextHint ? `\nCONTEXTE DU MODPACK : ${contextHint}\nRespecte les noms de mods et le vocabulaire fourni. Traduis le sens de la phrase, pas le nom de l'objet.` : '';
    const tail = `Traduis ${n} texte(s) anglais → ${langLabel}. Réponds UNIQUEMENT {"translations":["..."]} avec exactement ${n} chaînes. Copie __PH0__ __GL0__ __T0__ __SC0__ tels quels.${context}`;
    if (compact) return `Traducteur anglais → ${langLabel}. ${tail}`;
    const full = `${getGamePrompt(glossaryFile, tgtLang)}\n${tail}`;
    const maxSys = LMSTUDIO_PROMPT_TOKENS - 80;
    if (estimateLmTokens(full) <= maxSys) return full;
    return `Traducteur anglais → ${langLabel}. ${tail}`;
}

function httpPostLmStudio(url, bodyStr) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            port: parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
                'User-Agent': 'GameTranslator/1.0',
            },
        };
        const proto = parsed.protocol === 'https:' ? https : http;
        const req = proto.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    let detail = '';
                    try {
                        const j = JSON.parse(data);
                        detail = (j.error && (j.error.message || j.error)) || j.message || '';
                    } catch {
                        detail = data;
                    }
                    detail = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 180);
                    reject(new Error(detail ? `HTTP_${res.statusCode} ${detail}` : `HTTP_${res.statusCode}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid JSON response')); }
            });
        });
        lmStudioInflight.add(req);
        const forget = () => lmStudioInflight.delete(req);
        req.on('close', forget);
        req.on('error', (e) => { forget(); reject(e); });
        req.setTimeout(180000, () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(bodyStr);
        req.end();
    });
}

function lmStudioResponseFormat() {
    // LM Studio expects this OpenAI wrapper. The model receives the exact schema
    // requested by the user: an object containing a translations string array.
    return {
        type: 'json_schema',
        json_schema: {
            name: 'translations',
            strict: true,
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    translations: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                },
                required: ['translations'],
            },
        },
    };
}

function parseJsonArrayFromLm(raw, expectedLen) {
    const stripped = String(raw || '').replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    let parsed;
    try {
        parsed = JSON.parse(stripped);
    } catch {
        const match = stripped.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (!match) throw new Error('LM Studio: pas de JSON');
        parsed = JSON.parse(match[0]);
    }
    let arr;
    if (Array.isArray(parsed)) arr = parsed;
    else if (parsed && Array.isArray(parsed.translations)) arr = parsed.translations;
    else throw new Error('LM Studio: pas de tableau translations');
    while (arr.length < expectedLen) arr.push('');
    if (arr.length > expectedLen) arr.length = expectedLen;
    return arr.map(x => (x == null ? '' : String(x)));
}

async function ensureLmStudioChecked(logger) {
    if (!LMSTUDIO_ENABLED) {
        lmStudioState.active = false;
        return false;
    }
    if (lmStudioState.checked) return lmStudioState.active;
    lmStudioState.checked = true;
    try {
        const base = LMSTUDIO_URL.replace(/\/+$/, '').replace(/\/v1$/i, '');
        const url = new URL('/v1/models', base.endsWith('/') ? base : base + '/');
        const proto = url.protocol === 'https:' ? https : http;
        const data = await new Promise((resolve, reject) => {
            const req = proto.get(url.href, { timeout: 3000 }, (res) => {
                let d = '';
                res.on('data', c => { d += c; });
                res.on('end', () => {
                    if (res.statusCode !== 200) { reject(new Error('HTTP_' + res.statusCode)); return; }
                    try { resolve(JSON.parse(d)); }
                    catch { reject(new Error('Invalid JSON')); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
        const models = (data.data || []).filter(m => m && m.id && !/embed/i.test(m.id));
        lmStudioState.modelsLoaded = models.length;
        const ids = models.map(m => m.id);
        lmStudioState.models = ids;
        if (!ids.length) {
            lmStudioState.active = false;
            if (logger) logger('  LM Studio: ❌ aucun modèle chargé');
            return false;
        }
        if (LMSTUDIO_MODEL) {
            if (!ids.includes(LMSTUDIO_MODEL)) {
                lmStudioState.model = '';
                lmStudioState.active = false;
                if (logger) logger(`  LM Studio: ❌ modèle configuré introuvable: ${LMSTUDIO_MODEL}`);
                return false;
            }
            lmStudioState.model = LMSTUDIO_MODEL;
        } else if (ids.length === 1) {
            lmStudioState.model = ids[0];
        } else {
            // Never silently use an arbitrary model when several are loaded.
            lmStudioState.model = '';
            lmStudioState.active = false;
            if (logger) logger(`  LM Studio: ⚠️ ${ids.length} modèles disponibles — sélectionne explicitement le modèle dans Configuration`);
            return false;
        }
        const picked = models.find(m => m.id === lmStudioState.model) || models[0];
        const detected = parseInt(
            picked.max_model_len || picked.context_length || picked.loaded_context_length
            || picked.max_context_length || picked.n_ctx || 0, 10
        );
        if (Number.isFinite(detected) && detected >= 1024) {
            lmStudioState.contextTokens = Math.min(detected, LMSTUDIO_CONTEXT_TOKENS || detected);
        }
        lmStudioState.active = true;
        lmStudioState.endpoint = '/v1/chat/completions';
        if (logger) logger(`  LM Studio: ✅ ${lmStudioState.model} (${base}) ctx ${lmStudioSafeContext()} · mode ${LMSTUDIO_MODE}`);
        return true;
    } catch (e) {
        lmStudioState.active = false;
        if (logger) logger(`  LM Studio: ❌ non joignable (${LMSTUDIO_URL})`);
        return false;
    }
}

function isLmStudioContextError(err) {
    return /context size|KV cache|n_ctx|too many tokens|exceeded/i.test(String(err && err.message || ''));
}

function describeLmStudioError(err) {
    const message = String(err && err.message || err || 'Erreur inconnue');
    if (/ECONNREFUSED|ENOTFOUND|connect/i.test(message)) return 'LM Studio non lancé ou URL inaccessible';
    if (/timeout/i.test(message)) return 'LM Studio a dépassé le délai de réponse';
    if (isLmStudioContextError(err)) return 'Contexte trop petit pour ce lot — réduction automatique du lot';
    if (/HTTP_404/i.test(message)) return 'Endpoint LM Studio indisponible';
    if (/JSON|translations|réponse vide|thinking only/i.test(message)) return 'Réponse du modèle invalide ou uniquement en reasoning';
    if (/429|rate limit/i.test(message)) return 'LM Studio limite les requêtes';
    return message.slice(0, 220);
}

function splitLongText(text, maxTok) {
    const s = String(text || '');
    const limit = Math.max(40, maxTok || 200);
    if (estimateLmTokens(s) <= limit) return [s];
    const pieces = s.split(/(\n\n+|\n|(?<=[.!?…])\s+)/);
    const chunks = [];
    let buf = '';
    const pushBuf = () => {
        if (buf) { chunks.push(buf); buf = ''; }
    };
    for (const piece of pieces) {
        if (!piece) continue;
        if (estimateLmTokens(buf + piece) > limit && buf) {
            pushBuf();
            buf = piece;
        } else {
            buf += piece;
        }
    }
    pushBuf();
    const out = [];
    const maxChars = Math.max(80, Math.floor(limit * 3.5));
    for (const c of chunks) {
        if (estimateLmTokens(c) <= limit) { out.push(c); continue; }
        let i = 0;
        while (i < c.length) {
            let end = Math.min(c.length, i + maxChars);
            if (end < c.length) {
                const sp = c.lastIndexOf(' ', end);
                if (sp > i + Math.floor(maxChars * 0.4)) end = sp + 1;
                const open = c.lastIndexOf('__', end);
                if (open >= i) {
                    const close = c.indexOf('__', open + 2);
                    if (close !== -1 && close + 2 > end && open > i) end = open;
                }
            }
            if (end <= i) end = Math.min(c.length, i + maxChars);
            out.push(c.slice(i, end));
            i = end;
        }
    }
    return out.length ? out : [s];
}

function lmStudioOutputBudget(systemPrompt, input) {
    const ctx = lmStudioSafeContext();
    const inTok = estimateLmTokens(systemPrompt) + estimateLmTokens(input) + 80;
    // Reserve only the actual prompt tokens. Subtracting the configured max output
    // here used to cap small batches at ~325 tokens and caused truncated JSON.
    const room = ctx - inTok - 64;
    if (room < 128) return 0;
    const wantOut = Math.max(estimateLmTokens(input) * 2, 256);
    return Math.max(128, Math.min(LMSTUDIO_MAX_TOKENS, 1024, room, wantOut));
}

function packLmStudioChunks(indices, prepared, userBudgetTok) {
    const budgetTok = Math.max(40, userBudgetTok || 400);
    const chunks = [];
    let cur = [];
    let tok = 0;
    for (const idx of indices) {
        const t = String((prepared[idx] && prepared[idx].toSend) || '');
        const tTok = estimateLmTokens(t) + 4;
        const long = tTok >= 160;
        if (cur.length && (long || cur.length >= (LMSTUDIO_MODE === 'fast' ? 10 : LMSTUDIO_CHUNK_MAX) || tok + tTok > budgetTok)) {
            chunks.push(cur);
            cur = [];
            tok = 0;
        }
        cur.push(idx);
        tok += tTok;
        if (long && cur.length) {
            chunks.push(cur);
            cur = [];
            tok = 0;
        }
    }
    if (cur.length) chunks.push(cur);
    return chunks;
}

async function lmStudioTryBodies(url, bodies, logger, label) {
    let lastErr = null;
    for (const body of bodies) {
        try {
            const data = await httpPostLmStudio(url, JSON.stringify(body));
            const text = extractLmStudioText(data);
            if (text) return text;
            lastErr = new Error(lmStudioReasoningOnly(data)
                ? 'thinking only (Gemma a tout mis en reasoning — Thinking Off dans LM Studio)'
                : 'réponse vide');
        } catch (e) {
            lastErr = e;
            if (/HTTP_404/.test(e.message) && /\/api\/v1\/chat/.test(url)) {
                lmStudioNativeMissing = true;
                break;
            }
            if (isLmStudioContextError(e)) {
                if (logger) logger(`   [LM Studio] ${label}: ${describeLmStudioError(e)}`);
                throw e;
            }
        }
    }
    if (logger && lastErr) logger(`   [LM Studio] ${label}: ${lastErr.message}`);
    return '';
}

async function lmStudioChat(systemPrompt, input, logger, expectedLen, responseFormat, maxTokens) {
    const base = LMSTUDIO_URL.replace(/\/+$/, '').replace(/\/v1$/i, '');
    const model = lmStudioState.model || LMSTUDIO_MODEL || '';
    const response_format = responseFormat || lmStudioResponseFormat(expectedLen);
    const maxTok = Math.max(96, Math.min(4096, parseInt(maxTokens, 10) || LMSTUDIO_MAX_TOKENS));
    const sampling = lmStudioSampling();
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input },
    ];
    const thinkOff = {
        // LM Studio native /api/v1/chat expects a string enum, not an object.
        reasoning: 'off',
        // Gemma 4 ignore les clés ci-dessus sur /v1/chat/completions et met
        // tout en reasoning : mesuré 441 tokens de réflexion sur 500 de
        // budget, réponse tronquée, 6 s. Avec reasoning_effort, 0 token de
        // réflexion et 1,2 s. C'est la clé que comprend l'API OpenAI de
        // LM Studio — elle évite d'avoir à basculer Thinking Off à la main.
        reasoning_effort: 'none',
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false, thinking: false },
    };

    const openaiText = await lmStudioTryBodies(base + '/v1/chat/completions', [
        {
            model,
            messages,
            response_format,
            temperature: sampling.temperature,
            top_p: sampling.top_p,
            ...thinkOff,
            max_tokens: maxTok,
        },
    ], logger, '/v1/chat/completions');
    if (openaiText) {
        lmStudioState.endpoint = '/v1/chat/completions';
        return openaiText;
    }
    if (lmStudioNativeMissing) throw new Error('LM Studio: endpoint natif indisponible après échec de /v1/chat/completions');

    const nativeText = await lmStudioTryBodies(base + '/api/v1/chat', [
        {
            model,
            system_prompt: systemPrompt,
            input,
            // Native /api/v1/chat does not support OpenAI response_format or
            // chat_template_kwargs. The prompt enforces the JSON shape instead.
            temperature: sampling.temperature,
            top_p: sampling.top_p,
            reasoning: 'off',
            reasoning_effort: 'none',
            store: false,
            max_output_tokens: maxTok,
        },
    ], logger, '/api/v1/chat');
    if (nativeText) {
        lmStudioState.endpoint = '/api/v1/chat';
        return nativeText;
    }

    throw new Error('LM Studio: aucune réponse exploitable avec le schéma JSON translations');
}

async function translateLmStudioBatch(texts, srcLang, tgtLang, glossaryFile, logger, compact, contextHint = '') {
    const n = texts.length;
    const systemPrompt = buildLmStudioSystemPrompt(glossaryFile, tgtLang, n, compact, contextHint);
    const input = JSON.stringify(texts);
    const outTok = lmStudioOutputBudget(systemPrompt, input);
    if (outTok < 64) {
        enterLmStudioSolo(logger);
        throw new Error('Context size has been exceeded.');
    }

    // Tool mode: utiliser le dictionnaire par tool calls si activé
    try {
        const { isToolModeEnabled, translateWithTools, loadGlossaryForTools } = require('./modules/tool-dictionary');
        if (isToolModeEnabled()) {
            const log = logger || (() => {});
            log('[tools] Tool mode activé — consultation du dictionnaire...');
            const glossary = loadGlossaryForTools(glossaryFile);
            const sampling = lmStudioSampling();
            const model = lmStudioState.model || LMSTUDIO_MODEL || '';
            const translations = await translateWithTools(
                texts,
                systemPrompt,
                LMSTUDIO_URL,
                model,
                glossary,
                sampling,
                log
            );
            return translations;
        }
    } catch (e) {
        // Si le tool mode échoue, fallback sur le mode normal
        if (logger) logger(`[tools] Erreur tool mode, fallback normal: ${e.message}`);
    }

    const raw = await lmStudioChat(systemPrompt, input, logger, n, null, outTok);
    return parseJsonArrayFromLm(raw, n);
}

/**
 * Probe LM Studio and return its current status.
 * @returns {Promise<Object>} Status object with ok, url, model, etc.
 */
async function getLmStudioStatus() {
    lmStudioState.checked = false;
    const ok = await ensureLmStudioChecked();
    return {
        ok,
        url: LMSTUDIO_URL,
        enabled: LMSTUDIO_ENABLED,
        model: lmStudioState.model || LMSTUDIO_MODEL || '',
        configuredModel: LMSTUDIO_MODEL,
        models: lmStudioState.models || [],
        selectionRequired: !LMSTUDIO_MODEL && (lmStudioState.models || []).length > 1,
        configuredModelMissing: !!LMSTUDIO_MODEL && (lmStudioState.models || []).length > 0 && !lmStudioState.models.includes(LMSTUDIO_MODEL),
        parallel: LMSTUDIO_PARALLEL,
        maxTokens: LMSTUDIO_MAX_TOKENS,
        contextTokens: LMSTUDIO_CONTEXT_TOKENS,
        detectedContextTokens: lmStudioState.contextTokens || 0,
        mode: LMSTUDIO_MODE,
        endpoint: lmStudioState.endpoint || '',
        modelsLoaded: lmStudioState.modelsLoaded || 0,
    };
}

function cachePatternStatus(src, tgt) {
    const specRe = /%(?:\d+\$)?[sdfnbcBoOxXeEgGhHaAtT%]/g;
    const a = String(src).match(specRe) || [];
    const b = String(tgt).match(specRe) || [];
    if (a.join('\0') !== b.join('\0')) return 'bad_pattern';
    return null;
}

function decodeHtmlEntities(s) {
    return String(s == null ? '' : s)
        .replace(/&#(\d+);/g, (_, n) => {
            const c = Number(n);
            return (c >= 32 && c <= 0x10ffff) ? String.fromCodePoint(c) : _;
        })
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
            const c = parseInt(h, 16);
            return (c >= 32 && c <= 0x10ffff) ? String.fromCodePoint(c) : _;
        })
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&nbsp;/g, ' ');
}

function cacheLetterCount(s) {
    return (String(s).match(/[\p{L}]/gu) || []).length;
}

function isCacheNoisePair(src, tgt) {
    const s = decodeHtmlEntities(src).trim();
    const t = decodeHtmlEntities(tgt).trim();
    if (!s || !t) return true;
    if (/^[\d\s.,:%+\-/#]+$/.test(s)) return true;
    if (s.length < 6 && !/\s/.test(s)) return true;
    if (cacheLetterCount(s) < 4 || cacheLetterCount(t) < 2) return true;
    if (/^&#(?:x[0-9a-fA-F]+|\d+);$/.test(String(src).trim())) return true;
    if (/^&#(?:x[0-9a-fA-F]+|\d+);$/.test(String(tgt).trim())) return true;
    if (/^__\w+\d+__$/.test(s)) return true;
    return false;
}

function cacheLetterBag(s) {
    return [...decodeHtmlEntities(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')]
        .filter(ch => /\p{L}/u.test(ch))
        .sort()
        .join('');
}

function isShortUiLabel(s) {
    const t = decodeHtmlEntities(s).trim();
    const words = t.split(/\s+/).filter(Boolean);
    return t.length <= 18 && words.length <= 2;
}

function looksEnglishLeftover(src, fr) {
    const s = decodeHtmlEntities(src).trim().toLowerCase();
    const f = decodeHtmlEntities(fr).trim().toLowerCase();
    if (!s || !f) return false;
    if (f === s) return true;
    if (/^[a-z0-9 '"._-]+$/.test(f) && f.split(/\s+/).every(w => /^[a-z0-9._-]+$/.test(w)) && f.length >= 6) {
        return !/[àâäéèêëïîôùûüçœæ]/i.test(fr);
    }
    return false;
}

function isUselessVerifySuggestion(src, tgt, suggested) {
    const s = decodeHtmlEntities(src).trim();
    const cur = decodeHtmlEntities(tgt).trim();
    const sug = decodeHtmlEntities(suggested).trim();
    if (!sug || sug === cur) return true;
    if (sug.toLowerCase() === s.toLowerCase()) return true;
    if (/^[\d\s.,:%+\-/#]+$/.test(sug)) return true;
    if (s.length >= 12 && sug.length < 3) return true;
    if (cacheLetterCount(sug) < 2) return true;
    if (cur.length >= 40 && sug.length < Math.floor(cur.length * 0.55)) return true;
    if (cur.length >= 80 && sug.length < 24) return true;
    if (sug.length <= 40 && cur.includes(sug) && cur.length > sug.length * 2) return true;
    if (isShortUiLabel(cur) && !looksEnglishLeftover(src, cur)) return true;
    if (isShortUiLabel(cur) && isShortUiLabel(sug)) {
        const a = cacheLetterBag(cur);
        const b = cacheLetterBag(sug);
        if (a && b && (a === b || a.includes(b) || b.includes(a))) return true;
    }
    return false;
}

const MC_VERIFY_KEEP = {
    'the end': ['l\'end', "l’end", 'le end', 'end', "l'end"],
    'end': ['end', 'l\'end', "l’end", 'le end'],
    'the nether': ['le nether', 'nether'],
    'nether': ['nether', 'le nether'],
    'overworld': ['overworld', 'le overworld', 'surface'],
    'wither': ['wither'],
    'enderman': ['enderman'],
    'endermen': ['endermen', 'enderman'],
    'ender dragon': ['dragon de l\'end', "dragon de l’end", 'ender dragon', 'dragon de lend'],
    'redstone': ['redstone'],
    'creeper': ['creeper'],
    'ghast': ['ghast'],
    'blaze': ['blaze'],
    'shulker': ['shulker'],
    'elytra': ['élytres', 'elytres', 'elytra'],
    'netherite': ['netherite'],
    'end stone': ['pierre de l\'end', "pierre de l’end", 'end stone'],
    'end portal': ['portail de l\'end', "portail de l’end", 'end portal'],
};

function normalizeMcKey(s) {
    return decodeHtmlEntities(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

function isMinecraftKeepPair(src, fr) {
    const accepted = MC_VERIFY_KEEP[normalizeMcKey(src)];
    if (!accepted) return false;
    const f = normalizeMcKey(fr);
    return accepted.some(a => a === f);
}

function isBadMinecraftSuggestion(src, suggested) {
    const key = normalizeMcKey(src);
    const sug = normalizeMcKey(suggested);
    if ((key === 'the end' || key === 'end') && /^(la )?fin$/.test(sug)) return true;
    if (/end/.test(key) && /de la fin/.test(sug)) return true;
    if (/nether/.test(key) && /n[eé]ant|enfer/.test(sug)) return true;
    if (key === 'redstone' && /pierre rouge|poudre rouge/.test(sug)) return true;
    return false;
}

const GEMMA_VERIFY_SYSTEM = `Tu es google/gemma-4-e4b. Relis des traductions de JEU, surtout Minecraft (anglais → français).

But: trouver UNIQUEMENT les FR vraiment fausses. Dans le doute: rien.

VOCABULAIRE MINECRAFT (ne "corrige" JAMAIS ça):
The End = L'End / Le End   (PAS "La Fin")
Nether = Nether / Le Nether   (PAS Néant, PAS Enfer)
Enderman, Wither, Creeper, Ghast, Blaze, Shulker, Redstone, Netherite = on garde le nom
Ender Dragon = Dragon de l'End   (PAS Dragon de la Fin)
Elytra = Élytres

FAUX (tu signales):
- le FR est encore de l'anglais (ex: "Iron Chestplate")
- texte cassé / illisible
- le FR dit autre chose que l'EN de façon évidente

PAS FAUX (tu ignores, corrections=[]):
- termes Minecraft ci-dessus
- mots courts d'item: Gel, Vol, Gant, Gazé
- verbe/nom, genre, synonymes, calque acceptable

Si tu corriges: "suggested" = le FR COMPLET, pas un extrait.
Réponse JSON seulement: {"corrections":[]} ou {"corrections":[{"i":0,"suggested":"...","status":"wrong"}]}`;

function parseVerifyCorrections(raw) {
    const stripped = String(raw || '').replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    let parsed;
    try {
        parsed = JSON.parse(stripped);
    } catch {
        const match = stripped.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (!match) return [];
        try { parsed = JSON.parse(match[0]); } catch { return []; }
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.corrections)) return parsed.corrections;
    if (parsed && Array.isArray(parsed.results)) return parsed.results;
    return [];
}

function lmStudioVerifyFormat() {
    return {
        type: 'json_schema',
        json_schema: {
            name: 'cache_verify',
            strict: true,
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    corrections: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                i: { type: 'integer' },
                                suggested: { type: 'string' },
                                status: { type: 'string' },
                            },
                            required: ['i', 'suggested', 'status'],
                        },
                    },
                },
                required: ['corrections'],
            },
        },
    };
}

/**
 * Review cache pairs with LM Studio (same result shape as /llm/verify_cache).
 */
async function verifyLmStudioCache(translations, source, target, opts = {}) {
    const { limit = 200, batch_size = 10, cooldown = 1.0 } = opts;
    const logger = typeof opts.logger === 'function' ? opts.logger : null;
    lmStudioState.checked = false;
    const ready = await ensureLmStudioChecked(logger);
    if (!ready) return null;

    const max = Math.max(1, limit);
    const MAX_CHARS = 700;
    const usable = Object.entries(translations)
        .filter(([src, tgt]) => !isCacheNoisePair(src, tgt))
        .filter(([, tgt]) => decodeHtmlEntities(tgt).length <= MAX_CHARS)
        .sort((a, b) => decodeHtmlEntities(a[1]).length - decodeHtmlEntities(b[1]).length)
        .slice(0, max);
    const corrections = [];
    let pattern_detected = 0;
    const toLlm = [];

    for (const [src, tgt] of usable) {
        const pat = cachePatternStatus(src, tgt);
        if (pat) {
            pattern_detected++;
            continue;
        }
        const fr = decodeHtmlEntities(tgt);
        if (isMinecraftKeepPair(src, fr)) continue;
        if (isShortUiLabel(fr) && !looksEnglishLeftover(src, fr)) continue;
        toLlm.push([src, fr]);
    }

    const systemPrompt = GEMMA_VERIFY_SYSTEM;

    const format = lmStudioVerifyFormat();

    const jobs = [];
    let i = 0;
    while (i < toLlm.length) {
        const long = decodeHtmlEntities(toLlm[i][1]).length >= 180;
        const size = long ? 1 : Math.max(1, Math.min(6, batch_size || 4));
        jobs.push(toLlm.slice(i, i + size));
        i += jobs[jobs.length - 1].length;
    }

    const parallel = Math.max(1, Math.min(LMSTUDIO_PARALLEL, jobs.length || 1));
    const onCorrection = typeof opts.onCorrection === 'function' ? opts.onCorrection : null;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    if (logger) logger(`  [LM Studio verify] ${toLlm.length} textes → ${jobs.length} lot(s) ×${parallel}`);

    async function runVerifyJob(batch) {
        const payload = batch.map(([en, fr], idx) => ({ i: idx, en, fr }));
        const needTok = Math.min(LMSTUDIO_MAX_TOKENS, Math.max(256, Math.ceil(batch.reduce((n, [, fr]) => n + fr.length, 0) / 2) + 256));
        const raw = await lmStudioChat(systemPrompt, JSON.stringify(payload), logger, batch.length, format, needTok);
        const found = parseVerifyCorrections(raw);
        const out = [];
        for (const item of found) {
            const idx = Number(item.i);
            if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue;
            const suggested = String(item.suggested || '').trim();
            if (isUselessVerifySuggestion(batch[idx][0], batch[idx][1], suggested)) continue;
            if (isBadMinecraftSuggestion(batch[idx][0], suggested)) continue;
            if (isMinecraftKeepPair(batch[idx][0], batch[idx][1])) continue;
            if (item.status === 'awkward') continue;
            out.push({
                source: batch[idx][0],
                current: batch[idx][1],
                suggested,
                status: 'wrong',
            });
        }
        return out;
    }

    let jobsDone = 0;
    await mapLimit(jobs, parallel, async (batch, jobIdx) => {
        let found = [];
        try {
            found = await runVerifyJob(batch);
        } catch (e) {
            if (logger) logger(`  [LM Studio verify] lot ${jobIdx + 1}: ${e.message}`);
        }
        jobsDone++;
        for (const item of found) {
            corrections.push(item);
            if (onCorrection) onCorrection(item);
        }
        if (logger) logger(`  [LM Studio verify] lot ${jobsDone}/${jobs.length} — ${found.length} correction(s)`);
        if (onProgress) onProgress({ done: jobsDone, total: jobs.length, corrections: corrections.length, checked: toLlm.length });
        if (parallel === 1 && cooldown > 0 && jobsDone < jobs.length) {
            await sleep(Math.round(cooldown * 1000));
        }
        return found;
    });

    return {
        total_entries: usable.length,
        checked_by_llm: toLlm.length,
        pattern_detected,
        corrections_found: corrections.length,
        corrections,
        engine: 'lmstudio',
        model: lmStudioState.model || '',
    };
}

/* Rate limiter: 14 calls/min (stay under 15 RPM free tier)
   Also enforces a minimum interval between calls to avoid per-second burst 429s */
const _geminiReqLog = [];
const GEMINI_RPM = 14;
// Minimum ms between consecutive requests: 60000/14 ≈ 4286ms, use 4500ms to be safe
const GEMINI_MIN_INTERVAL_MS = Math.ceil(60000 / GEMINI_RPM) + 200;

async function waitForGeminiSlot() {
    while (true) {
        const now = Date.now();
        // Clean entries older than 60s (sliding window)
        while (_geminiReqLog.length > 0 && now - _geminiReqLog[0] > 60000) _geminiReqLog.shift();
        // Enforce per-minute cap
        if (_geminiReqLog.length >= GEMINI_RPM) {
            const waitMs = 60000 - (now - _geminiReqLog[0]) + 250;
            await sleep(Math.max(waitMs, 500));
            continue;
        }
        // Enforce minimum interval between consecutive calls (burst protection)
        if (_geminiReqLog.length > 0) {
            const lastReq = _geminiReqLog[_geminiReqLog.length - 1];
            const elapsed = now - lastReq;
            if (elapsed < GEMINI_MIN_INTERVAL_MS) {
                await sleep(GEMINI_MIN_INTERVAL_MS - elapsed + 100);
                continue;
            }
        }
        _geminiReqLog.push(Date.now());
        return;
    }
}

/* HTTP POST with full URL (for Gemini — avoids DEEPL-specific error codes) */
function httpPostFull(url, bodyStr) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            port: parseInt(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
                'User-Agent': 'BG3Translator/1.0',
            },
        };
        const proto = parsed.protocol === 'https:' ? https : http;
        const req = proto.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode === 429) { reject(new Error('HTTP_429')); return; }
                if (res.statusCode === 400) { reject(new Error('GEMINI_INVALID_REQUEST')); return; }
                if (res.statusCode === 401 || res.statusCode === 403) { reject(new Error('GEMINI_AUTH_FAILED')); return; }
                if (res.statusCode !== 200) { reject(new Error(`HTTP_${res.statusCode}`)); return; }
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid JSON response')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(bodyStr);
        req.end();
    });
}

const OPENROUTER_CHUNK_MAX = ENGINES.get('openrouter').chunkSize;

function httpPostOpenRouter(url, bodyStr) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = https.request({
            hostname: parsed.hostname,
            port: parseInt(parsed.port, 10) || 443,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${OPENROUTER_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
                'HTTP-Referer': 'https://github.com/zerodepdev-ux/ModLingo-Hub',
                'X-Title': 'ModLingo-Hub',
            },
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('OPENROUTER_AUTH_FAILED'));
                if (res.statusCode === 429) return reject(new Error('OPENROUTER_RATE_LIMIT'));
                if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`OPENROUTER_HTTP_${res.statusCode}`));
                try { resolve(JSON.parse(data)); } catch { reject(new Error('OPENROUTER_INVALID_JSON')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('OPENROUTER_TIMEOUT')); });
        req.write(bodyStr);
        req.end();
    });
}

async function translateOpenRouterBatchInternal(texts, srcLang, tgtLang) {
    if (!OPENROUTER_KEY || !texts.length) throw new Error('No OpenRouter API key');
    const langLabel = tgtLang === 'fr' ? 'French' : tgtLang;
    const prompt = `Translate these ${texts.length} video game text(s) from English to ${langLabel}. Return ONLY a valid JSON array with exactly ${texts.length} translations in the same order. Preserve placeholders and markup. No explanations.\n\n${JSON.stringify(texts)}`;
    const body = JSON.stringify({
        model: OPENROUTER_MODEL || 'openrouter/free',
        messages: [
            { role: 'system', content: 'You are a video game localization translator. Preserve tags, placeholders and formatting.' },
            { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 32768,
    });
    const data = await httpPostOpenRouter('https://openrouter.ai/api/v1/chat/completions', body);
    const message = data.choices?.[0]?.message || {};
    const raw = Array.isArray(message.content)
        ? message.content.map(part => typeof part === 'string' ? part : (part?.text || part?.content || '')).join('')
        : (typeof message.content === 'string' ? message.content : '');
    const match = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').match(/\[[\s\S]*\]/);
    if (!match) throw new Error('OPENROUTER_INVALID_RESPONSE');
    const translations = JSON.parse(match[0]);
    if (!Array.isArray(translations)) throw new Error('OPENROUTER_INVALID_ARRAY');
    while (translations.length < texts.length) translations.push(null);
    return translations.slice(0, texts.length);
}

async function translateOpenRouterBatch(texts, srcLang, tgtLang) {
    return queueOpenRouterRequest(async () => {
        let lastError;
        for (let attempt = 0; attempt <= OPENROUTER_MAX_RETRIES; attempt++) {
            await waitOpenRouterSlot();
            try {
                return await translateOpenRouterBatchInternal(texts, srcLang, tgtLang);
            } catch (error) {
                lastError = error;
                if (error.message === 'OPENROUTER_AUTH_FAILED') throw error;
                const rateLimited = error.message === 'OPENROUTER_RATE_LIMIT';
                if (attempt >= OPENROUTER_MAX_RETRIES) break;
                const delay = rateLimited
                    ? Math.min(60000, 10000 * (2 ** attempt))
                    : Math.min(15000, 1500 * (2 ** attempt));
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError || new Error('OPENROUTER_FAILED');
    });
}


async function translateGeminiBatch(texts, srcLang, tgtLang) {
    if (!GEMINI_KEY) throw new Error('No Gemini API key');
    await waitForGeminiSlot();
    const langLabel = tgtLang === 'fr' ? 'French' : tgtLang;
    const prompt = `Translate these ${texts.length} text(s) from English to ${langLabel}. Return ONLY a valid JSON array with exactly ${texts.length} translation(s) in the same order. No explanations, no markdown.\n\n${JSON.stringify(texts)}`;
    const body = JSON.stringify({
        systemInstruction: {
            parts: [{ text: "You are a professional video game localization translator. Translate naturally for gamers. Preserve markup tags like <LSTag>, [1], {placeholders}, HTML tags. Keep proper nouns, character names, and game terms unless they have an established translation. Maintain tone, humor, and style of the original." }]
        },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 32768 }
    });
    const model = GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
    const data = await httpPostFull(url, body);
    if (data.error) throw new Error(`Gemini: ${data.error.message || 'API error'}`);
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const stripped = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const match = stripped.match(/\[[\s\S]*\]/);
    if (!match) throw new Error(`Gemini: no JSON array in response`);
    const translations = JSON.parse(match[0]);
    if (!Array.isArray(translations)) throw new Error(`Gemini: response is not a JSON array`);
    // Gemini sometimes returns N+1 items (e.g. an extra empty string at the end) — trim to expected length
    if (translations.length > texts.length) return translations.slice(0, texts.length);
    // Fewer items than expected — pad with null so callers fall back to Google for missing ones
    if (translations.length < texts.length) {
        while (translations.length < texts.length) translations.push(null);
    }
    return translations;
}

/* ================================================================
   TAG PROTECTION  — preserve markup tags during translation
   ================================================================ */
function protectTags(text, pattern) {
    const tags = [];
    let cleaned = text;
    pattern.lastIndex = 0;
    const matches = text.match(pattern) || [];
    matches.forEach((tag, i) => {
        const ph = `__T${i}__`;
        tags.push({ ph, tag });
        cleaned = cleaned.replace(tag, ph);
    });
    return { cleaned, tags };
}

function restoreTags(text, tags) {
    let result = text;
    const ordered = [...(tags || [])].sort((a, b) => String(b.ph).length - String(a.ph).length);
    ordered.forEach(({ ph, tag }) => { result = restoreProtectedToken(result, ph, tag); });
    return result;
}

/* Placeholder protection — preserve {who}, {item_name}, {0} etc. */
function protectPlaceholders(text) {
    const placeholders = [];
    let cleaned = text;
    const matches = text.match(PLACEHOLDER_PATTERN) || [];
    matches.forEach((ph, i) => {
        const token = `__PH${i}__`;
        placeholders.push({ token, original: ph });
        cleaned = cleaned.replace(ph, token);
    });
    return { cleaned, placeholders };
}

function restorePlaceholders(text, placeholders) {
    let result = text;
    const ordered = [...(placeholders || [])].sort((a, b) => String(b.token).length - String(a.token).length);
    for (const { token, original } of ordered) {
        result = restoreProtectedToken(result, token, original);
    }
    return ensurePlaceholderSpacing(result);
}

/** Keep a space around {variables} when the model glued them (via{method} → via {method}). */
function ensurePlaceholderSpacing(text) {
    if (!text) return text;
    return String(text)
        .replace(/([^\s{])(\{)/g, '$1 {')
        .replace(/(\})([A-Za-zÀ-ÿ])/g, '$1 $2')
        .replace(/(__(?:GL|PH|T|SC)\d+__)(?=[A-Za-zÀ-ÿ])/gi, '$1 ')
        .replace(/([A-Za-zÀ-ÿ])(__(?:GL|PH|T|SC)\d+__)/gi, '$1 $2');
}

/**
 * FTB / Minecraft format codes: Gemma often writes "&rde" instead of "&r de".
 * Only insert a space after &r (reset) — never break stacked codes like &6&lTitle.
 */
function ensureMinecraftFormatSpacing(text) {
    if (text == null || text === '') return text;
    return String(text)
        .replace(/(&r)(?=[A-Za-zÀ-ÿ0-9«»])/gi, '$1 ')
        .replace(/([A-Za-zÀ-ÿ0-9])((?:&[0-9a-fk-orA-FK-OR])+)(?=[A-Za-zÀ-ÿ])/g, (m, letter, codes) => (
            /&r$/i.test(codes) ? m : `${letter} ${codes}`
        ));
}

/* Slash-command protection — preserve /home, /spark tps, /ftbteambases lobby, etc. */
const SLASH_CMD_PATTERN = /\/[A-Za-z][A-Za-z0-9_]*(?:\s+[A-Za-z0-9_.@-]+)*/g;

function protectSlashCommands(text) {
    const slashCommands = [];
    SLASH_CMD_PATTERN.lastIndex = 0;
    const cleaned = text.replace(SLASH_CMD_PATTERN, (match) => {
        const token = `__SC${slashCommands.length}__`;
        slashCommands.push({ token, original: match });
        return token;
    });
    return { cleaned, slashCommands };
}

function restoreSlashCommands(text, slashCommands) {
    let result = text;
    const ordered = [...(slashCommands || [])].sort((a, b) => String(b.token).length - String(a.token).length);
    for (const { token, original } of ordered) {
        result = restoreProtectedToken(result, token, original);
    }
    return result;
}

/** Restore original slash commands when a cached/API result translated them anyway. */
function reconcileSlashCommands(original, translated) {
    if (!original || !translated || original === translated) return translated;
    let result = translated;

    // Minecraft color-coded commands: &a/home&r, &2/sethome&f, …
    const colorCmdRe = /(&[0-9a-fk-or])(\/[^&|]+?)(&[0-9a-fk-or])/gi;
    const origParts = [...original.matchAll(colorCmdRe)];
    if (origParts.length) {
        let idx = 0;
        result = result.replace(/(&[0-9a-fk-or])(\/[^&|]+?)(&[0-9a-fk-or])/gi, (m, p1, p2, p3) => {
            const orig = origParts[idx++];
            return orig ? `${orig[1]}${orig[2]}${orig[3]}` : m;
        });
    }

    SLASH_CMD_PATTERN.lastIndex = 0;
    const origCmds = original.match(SLASH_CMD_PATTERN);
    if (origCmds?.length) {
        let i = 0;
        SLASH_CMD_PATTERN.lastIndex = 0;
        result = result.replace(SLASH_CMD_PATTERN, () => origCmds[i++] ?? '');
    }
    return result;
}

/* ================================================================
   GAME-AWARE LLM PROMPTS
   ================================================================ */

// Game name mapping for template variables
const GAME_NAMES = {
    minecraft: 'Minecraft',
    bg3: "Baldur's Gate 3",
    satisfactory: 'Satisfactory',
    hytale: 'Hytale',
    ancientdungeon: 'Ancient Dungeon VR',
    ror2: 'Risk of Rain 2',
    riskofrain2: 'Risk of Rain 2',
};

/**
 * Replace template variables in a prompt string:
 *   {GameName}, {gamename}, {GAMENAME}  → actual game name
 *   {Lang}, {lang}                      → target language label
 *   {Config.GameName} etc.              → same as {GameName}
 */
function resolvePromptVars(prompt, gameName, lang) {
    if (!prompt) return prompt;
    return prompt.replace(/\{(?:Config\.)?(?:NameGame|GameName|gamename|Game|game)\}/gi, gameName || 'Jeu')
                 .replace(/\{(?:Lang|lang|Language|language)\}/gi, lang || 'francais');
}

function getGamePrompt(glossaryFile, tgtLang) {
    const lang = tgtLang === 'fr' ? 'francais' : tgtLang;
    const gf = (glossaryFile || '').toLowerCase();

    // Detect game for name resolution
    let gameName = '';
    for (const [key, name] of Object.entries(GAME_NAMES)) {
        if (gf.includes(key)) { gameName = name; break; }
    }

    if (gf.includes('hytale')) {
        return `Tu es un expert en localisation de jeux vidéo, spécialisé dans l'interface (UI) du jeu Hytale. Ta mission est de traduire l'anglais vers le ${lang} de manière fluide et professionnelle.

CONSIGNES CRITIQUES (À RESPECTER ABSOLUMENT) :
1. ESPACEMENT DES VARIABLES (TRES IMPORTANT) : Tu dois TOUJOURS mettre un espace avant et après les variables entre accolades. 
   -> INTERDIT : "via{method}", "Par{ownerName}"
   -> OBLIGATOIRE : "via {method}", "Par {ownerName}"
2. SYNTAXE ET NATUREL : Ne fais JAMAIS de traduction mot à mot. Ajoute les articles manquants ("Hytale servers" -> "les serveurs de Hytale") et place les adjectifs correctement ("Creative Tools" -> "Outils créatifs").
3. MAJUSCULES : En français, on ne met pas de majuscule à chaque mot dans un titre ou un bouton. Seul le premier mot prend une majuscule (ex: "Hide Server Addresses" -> "Masquer les adresses de serveur").
4. PONCTUATION : Mets toujours un espace avant les deux-points ":" (ex: "UUID : {uuid}").
5. TOKENS TECHNIQUES : Laisse absolument intacts les tags HTML (<u>, <a>, href) et les caractères d'échappement (\\n).

EXEMPLES DE TRADUCTIONS PARFAITES :
- "Connected via {method}" -> "Connecté via {method}"
- "By {ownerName}" -> "Par {ownerName}"
- "Supported Languages: {languages}" -> "Langues prises en charge : {languages}"
- "Failed to set up connection. Try again or check firewall settings." -> "Échec de la configuration de la connexion. Réessayez ou vérifiez les paramètres du pare-feu."
- "No private servers found. Add a custom server to see it here." -> "Aucun serveur privé trouvé. Ajoutez un serveur personnalisé pour l'afficher ici."
- "Hide server addresses" -> "Masquer les adresses de serveur"
- "Resolve Block Spawners" -> "Résoudre les générateurs de blocs"
- "Unleash your Avatar potential and develop your domain with powerful creative tools." -> "Libérez le potentiel de votre avatar et développez votre domaine avec des outils créatifs puissants."
- "Failed to delete world" -> "Échec de la suppression du monde"

Renvoie UNIQUEMENT le texte traduit pour le JSON, sans aucun commentaire ni guillemets supplémentaires.`;
}
    if (gf.includes('minecraft')) {
        return `ROLE: Traducteur Minecraft anglais vers ${lang}.\n\nREGLES STRICTES:\n1. Reponds UNIQUEMENT avec la traduction. Rien d'autre.\n2. Ne traduis JAMAIS les noms de mods (Menril, Hexerei, Mekanism, etc.).\n3. Ne traduis JAMAIS les tags techniques (#ae2:all_nether_quartz, #forge:ingots, etc.). Garde-les exactement tels quels.\n4. Ne mets JAMAIS le texte anglais entre parentheses dans ta reponse.\n5. ESPACES : garde un espace autour des codes couleur &a &r &6&l etc. INTERDIT: "&rde" "&lPorte&rajoute". OBLIGATOIRE: "&r de" "&lPorte&r ajoute".\n\nVOCABULAIRE MINECRAFT OBLIGATOIRE:\nLog=Buche, Logs=Buches, Planks=Planches, Stairs=Escaliers, Slab=Dalle, Fence=Barriere, Trapdoor=Trappe, Chest=Coffre, Ore=Minerai, Ingot=Lingot, Pickaxe=Pioche, Axe=Hache, Sword=Epee, Helmet=Casque, Chestplate=Plastron, Leggings=Jambieres, Boots=Bottes, Spawner=Generateur, Deepslate=Ardoise des abimes, Ancient Debris=Débris anciens, Brick=Brique, Item=Objet, Player=Joueur, Craft=Fabriquer, Disabled=Desactive.\n\nEXEMPLES (suis ce format exactement):\nIron Chestplate -> Plastron en fer\nMenril Logs -> Buches de Menril\nOak Stairs -> Escaliers en chene\nAny #ae2:all_nether_quartz -> Tout #ae2:all_nether_quartz\nDiamond Pickaxe -> Pioche en diamant\nHexerei Candle -> Bougie Hexerei\nThe &6&lHeat Generator&r has 2 modes -> Le &6&lGénérateur de chaleur&r a 2 modes`;
    }
    if (gf.includes('bg3')) {
        return `Tu es un expert de Baldur's Gate 3 et des Royaumes Oublies (D&D 5e). Tu es un traducteur expert en ${lang}. Tu connais la terminologie D&D: Rogue=Roublard, Wizard=Magicien, Sorcerer=Ensorceleur, Warlock=Occultiste, Cleric=Clerc, Ranger=Rodeur, Fighter=Guerrier, Barbarian=Barbare, Bard=Barde, Monk=Moine, Druid=Druide, Spell=Sort, Cantrip=Tour de magie, Saving Throw=Jet de sauvegarde, Hit Points=Points de vie, Armor Class=Classe d'armure. Tu ne traduis jamais les noms propres. Tu reponds UNIQUEMENT avec la traduction.`;
    }
    if (gf.includes('satisfactory')) {
        return `Tu es un expert de Satisfactory. Tu es un traducteur expert en ${lang}. Tu connais les termes: Conveyor Belt=Convoyeur, Splitter=Repartiteur, Merger=Fusionneur, Smelter=Fonderie, Constructor=Constructeur, Assembler=Assembleur, Manufacturer=Fabricant, Biomass=Biomasse, Iron Ore=Minerai de fer, Coal=Charbon, Oil=Petrole. Tu reponds UNIQUEMENT avec la traduction.`;
    }
    // Default / general
    return `Tu es un traducteur expert anglais vers ${lang}. Tu traduis de maniere naturelle et precise. Tu gardes les noms propres en anglais. Tu reponds UNIQUEMENT avec la traduction.`;
}

/* ================================================================
   TRANSLATOR FACTORY  — queue, cache, retry, batching
   ================================================================ */
/**
 * Create a translator instance with cache, retry, batching and multi-engine fallback.
 * @param {Object} [options={}] - Translator options.
 * @param {string} [options.srcLang='auto'] - Source language code.
 * @param {string} [options.tgtLang='fr'] - Target language code.
 * @param {string} [options.cachePath] - Path to the translation cache file.
 * @param {number} [options.concurrency=3] - Max concurrent API requests.
 * @param {number} [options.delayMs=120] - Delay between batches in ms.
 * @param {number} [options.maxRetries=3] - Max retries on API failure.
 * @param {number} [options.retryBaseMs=500] - Base retry delay.
 * @param {Function} [options.logger=console.log] - Logging function.
 * @param {string} [options.glossaryFile] - Glossary file identifier.
 * @param {string} [options.tagFile] - Custom tag filter file identifier.
 * @returns {{translate:Function, translateBatch:Function, flush:Function, stats:Object, cache:TranslationCache, langPair:string}} Translator API.
 */
function createTranslator(options = {}) {
    const {
        srcLang = 'auto',
        tgtLang = 'fr',
        cachePath = path.join(process.cwd(), 'data', 'bg3', 'cache.json'),
        concurrency = 3,
        delayMs = 120,
        maxRetries = 3,
        retryBaseMs = 500,
        logger = console.log,
        glossaryFile = null,
        tagFile = null,
        localOnly = false,
    } = options;

    // Build tag pattern: external file tags + BG3 defaults
    const externalTagPattern = loadTagFilter(tagFile);
    const tagPattern = externalTagPattern || TAG_PATTERN_BG3;
    if (externalTagPattern) {
        logger(`  Tag filter loaded: ${tagFile} (${tagPattern.source.split('|').length} patterns)`);
    }

    const langPair = `${srcLang}|${tgtLang}`;
    const cache = getTranslationCache(cachePath);
    const altPair = langPair === 'en|fr' ? 'auto|fr' : (langPair === 'auto|fr' ? 'en|fr' : null);
    const keepPairs = altPair ? [langPair, altPair] : [langPair];
    const beforePrune = cache.totalCount();
    cache.prune(keepPairs);
    const afterPrune = cache.totalCount();
    if (afterPrune < beforePrune) {
        logger(`  Cache pruned: ${afterPrune}/${beforePrune} entries kept for ${keepPairs.join(', ')}`);
    }
    const cacheInitKey = path.resolve(cachePath);

    if (!CACHE_INIT_DONE.has(cacheInitKey)) {
        CACHE_INIT_DONE.add(cacheInitKey);

        const deduped = cache.deduplicate();
        if (deduped > 0) {
            logger(`  Cache cleanup: ${deduped} identity entries removed`);
        }

        const purgedCorrupted = cache.purgeCorruptedEntries();
        if (purgedCorrupted > 0) {
            logger(`  Cache cleanup: ${purgedCorrupted} corrupted entries removed`);
        }
    }

    // Load glossary for target language (per-translator instance)
    const glossaryState = buildGlossaryState(glossaryFile);
    const glossaryLowerSet = glossaryState ? glossaryState.lowerSet : new Set();

    function getGlossaryContext(texts) {
        if (!glossaryState) return '';
        const source = texts.map(t => String(t || '')).join(' ');
        const foundMods = (glossaryState.modNames || [])
            .filter(name => new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i').test(source))
            .slice(0, 6);
        const rules = [];
        for (const [en, fr] of glossaryState.map) {
            if (source.toLowerCase().includes(en.toLowerCase()) && en.toLowerCase() !== String(fr).toLowerCase()) {
                rules.push(`${en} = ${fr}`);
            }
        }
        return [...foundMods.map(m => `mod ${m}`), ...rules.slice(0, 12)].join('; ');
    }
    if (glossaryState && !CACHE_INIT_DONE.has(cacheInitKey + ':glossary')) {
        CACHE_INIT_DONE.add(cacheInitKey + ':glossary');
        logger(`  Glossary loaded: ${glossaryState.map.size} terms`);

        const purged = cache.purgeGlossaryEntries(glossaryState.map);
        if (purged > 0) {
            logger(`  Cache cleanup: ${purged} glossary-only entries purged`);
        }

        const glossaryHashPath = path.join(__dirname, 'data', glossaryFile || 'bg3/glossary.json');
        let currentHash = null;
        try {
            const glossaryContent = fs.readFileSync(glossaryHashPath, 'utf8');
            currentHash = crypto.createHash('md5').update(glossaryContent).digest('hex');
        } catch {}

        if (currentHash && cache._glossaryHash && cache._glossaryHash !== currentHash) {
            const invalidated = cache.invalidateForGlossary(glossaryState.map);
            logger(`  Glossary changed! ${invalidated} cached translations invalidated`);
        }
        cache._glossaryHash = currentHash;
    } else if (!glossaryState) {
        loadGlossary(tgtLang, glossaryFile);
    }

    // Check DeepL availability
    let deeplActive = !localOnly && DEEPL_AVAILABLE && !!DEEPL_KEY;
    if (deeplActive) {
        logger(`  DeepL API: ${DEEPL_FREE ? 'Free' : 'Pro'} key loaded`);
    } else {
        logger(`  DeepL API: no key`);
    }

    // LibreTranslate — global connection check shared across instances
    let libreActive = globalLibreState.active;
    if (LIBRE_CONFIG_LOADED && LIBRE_URL && !globalLibreState.checked) {
        logger(`  LibreTranslate: ${LIBRE_URL} (sera vérifié au premier appel)`);
    }

    // Check Gemini availability
    let geminiActive = !localOnly && GEMINI_AVAILABLE && !!GEMINI_KEY;
    if (geminiActive) {
        logger(`  Gemini API: ${GEMINI_MODEL} (15 req/min — phase fallback)`);
    }

    let openRouterActive = !localOnly && OPENROUTER_AVAILABLE && !!OPENROUTER_KEY;
    if (openRouterActive) {
        logger(`  OpenRouter: ${OPENROUTER_MODEL} (modèle gratuit, quotas variables — phase fallback)`);
    }

    let lmStudioActive = LMSTUDIO_ENABLED;
    if (lmStudioActive) {
        logger(`  LM Studio: ${LMSTUDIO_URL} (sera vérifié au premier lot)`);
    }

    const pipe = [];
    if (deeplActive) pipe.push('DeepL');
    if (libreActive) pipe.push('LibreTranslate local');
    if (geminiActive) pipe.push('Gemini');
    if (openRouterActive) pipe.push('OpenRouter/free');
    if (lmStudioActive) pipe.push('LM Studio local');
    if (!localOnly) pipe.push('Google/MyMemory');
    logger(`  Pipeline: ${pipe.join(' → ')}`);

    const stats = {
        hits: 0, misses: 0, errors: 0, apiCalls: 0,
        deeplCalls: 0, deeplErrors: 0, libreCalls: 0, libreErrors: 0,
        geminiCalls: 0, geminiErrors: 0, openrouterCalls: 0, openrouterErrors: 0,
        lmstudioCalls: 0, lmstudioErrors: 0,
        googleCalls: 0, googleFastCalls: 0, googleFallbacks: 0, mymemoryCalls: 0,
        retries: 0, glossaryApplied: 0, gpuCalls: 0, cpuCalls: 0, tierStats: null,
        startedAt: Date.now(), elapsedMs: 0, averageMs: 0,
        localAiDetected: false, googleOnly: false,
        lmstudio: { model: '', configuredModel: LMSTUDIO_MODEL, contextTokens: LMSTUDIO_CONTEXT_TOKENS, detectedContextTokens: 0, endpoint: '', modelsLoaded: 0, mode: LMSTUDIO_MODE },
    };

    /* ---- single text with retry + API fallback (DeepL → LibreTranslate → Google → MyMemory) ---- */
    async function translateRaw(text, contextText = text) {
        libreActive = await ensureGlobalLibreChecked(srcLang, tgtLang, glossaryFile, logger);
        // Track engines that returned identity (untranslated) so we can fall through them
        let lastIdentityResult = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            // 1) Try DeepL first (if key is valid)
            if (deeplActive) {
                try {
                    stats.apiCalls++;
                    stats.deeplCalls++;
                    const r = await translateDeepL(text, srcLang, tgtLang);
                    if (r && r !== text) return r;
                    lastIdentityResult = r;
                } catch (eDeepL) {
                    if (eDeepL.message === 'DEEPL_AUTH_FAILED') {
                        logger(`   [DeepL] Invalid API key — disabling DeepL for this session`);
                        deeplActive = false;
                    } else if (eDeepL.message === 'DEEPL_QUOTA_EXCEEDED') {
                        logger(`   [DeepL] Quota exceeded — fallback LibreTranslate/Google/MyMemory`);
                        deeplActive = false;
                    } else if (eDeepL.message.startsWith('DEEPL_UNSUPPORTED_LANG')) {
                        deeplActive = false;
                    } else {
                        stats.deeplErrors++;
                        // Fall through to LibreTranslate
                    }
                }
            }

            // 2) Try LibreTranslate (local, unlimited)
            if (libreActive) {
                try {
                    stats.apiCalls++;
                    stats.libreCalls++;
                    const libreResult = await translateLibre(text, srcLang, tgtLang);
                    if (libreResult.engine === 'ollama' || libreResult.engine === 'gpu') stats.gpuCalls++;
                    else stats.cpuCalls++;
                    if (libreResult.text && libreResult.text !== text) return libreResult.text;
                    lastIdentityResult = libreResult.text;
                } catch (eLibre) {
                    stats.libreErrors++;
                    if (eLibre.message.includes('ECONNREFUSED') || eLibre.message.includes('timeout') || eLibre.message.includes('ECONNRESET') || eLibre.message.includes('socket hang up')) {
                        logger(`   [LibreTranslate] Serveur non joignable (${eLibre.message}) — désactivation`);
                        libreActive = false;
                    }
                    // Fall through to Google
                }
            }

            // 2.5) Try Gemini
            if (geminiActive) {
                try {
                    stats.apiCalls++;
                    stats.geminiCalls++;
                    const gRes = await translateGeminiBatch([text], srcLang, tgtLang);
                    const gText = gRes[0];
                    if (gText && gText !== text) return gText;
                    lastIdentityResult = gText;
                } catch (eGemini) {
                    stats.geminiErrors++;
                    if (eGemini.message === 'GEMINI_AUTH_FAILED') {
                        logger(`   [Gemini] Clé invalide — désactivation`);
                        geminiActive = false;
                    }
                    // Fall through to LM Studio / Google
                }
            }

            // 2.6) Try LM Studio (local, free)
            if (lmStudioActive) {
                lmStudioActive = await ensureLmStudioChecked(logger);
                stats.localAiDetected = !!(lmStudioActive || libreActive);
                stats.googleOnly = !stats.localAiDetected && !geminiActive && !deeplActive;
                stats.lmstudio = {
                    model: lmStudioState.model || '',
                    configuredModel: LMSTUDIO_MODEL,
                    contextTokens: LMSTUDIO_CONTEXT_TOKENS,
                    detectedContextTokens: lmStudioState.contextTokens || 0,
                    endpoint: lmStudioState.endpoint || '',
                    modelsLoaded: lmStudioState.modelsLoaded || 0,
                    mode: LMSTUDIO_MODE,
                };
                if (!lmStudioActive && stats.googleOnly) logger('  [Pipeline] Aucune IA locale détectée — utilisation directe de Google API');
            }
            if (lmStudioActive) {
                try {
                    stats.apiCalls++;
                    stats.lmstudioCalls++;
                    const lmRes = await translateLmStudioBatch([text], srcLang, tgtLang, glossaryFile, logger, false, getGlossaryContext([contextText]));
                    const lmText = lmRes[0];
                    if (lmText && lmText !== text) return lmText;
                    lastIdentityResult = lmText;
                } catch (eLm) {
                    stats.lmstudioErrors++;
                    if (eLm.message.includes('ECONNREFUSED') || eLm.message.includes('timeout') || eLm.message.includes('ECONNRESET')) {
                        logger(`   [LM Studio] Non joignable (${eLm.message}) — désactivation`);
                        lmStudioActive = false;
                    }
                }
            }

            // 2.7) Try OpenRouter/free as a cloud fallback
            if (openRouterActive) {
                try {
                    stats.apiCalls++;
                    stats.openrouterCalls++;
                    const orRes = await translateOpenRouterBatch([text], srcLang, tgtLang);
                    const orText = orRes[0];
                    if (orText && orText !== text) return orText;
                    lastIdentityResult = orText;
                } catch (eOpenRouter) {
                    stats.openrouterErrors++;
                    if (eOpenRouter.message === 'OPENROUTER_AUTH_FAILED') {
                        logger('   [OpenRouter] Clé invalide — désactivation');
                        openRouterActive = false;
                    }
                }
            }

            // In local-only mode, never contact cloud translation services.
            if (localOnly) {
                throw new Error('LOCAL_AI_NOT_AVAILABLE');
            }

            // 3) Try Google
            try {
                stats.apiCalls++;
                stats.googleCalls++;
                stats.googleFallbacks++;
                const r = await translateGoogle(text, srcLang, tgtLang);
                if (r && r !== text) return r;
                lastIdentityResult = r;
                // If Google also returned identity, try MyMemory before giving up
                try {
                    stats.apiCalls++;
                    const r2 = await translateMyMemory(text, srcLang, tgtLang);
                    if (r2 && r2 !== text) return r2;
                    lastIdentityResult = r2 || lastIdentityResult;
                } catch (_) { /* swallow MyMemory error — we already have identity */ }
                // All engines returned identity — give up and return source
                return lastIdentityResult || text;
            } catch (e1) {
                // 4) Try MyMemory
                try {
                    stats.apiCalls++;
                    const r = await translateMyMemory(text, srcLang, tgtLang);
                    if (r && r !== text) return r;
                    lastIdentityResult = r;
                    return lastIdentityResult || text;
                } catch (e2) {
                    if (e1.message === 'HTTP_429' || e2.message === 'HTTP_429') {
                        const delay = retryBaseMs * Math.pow(2, attempt);
                        stats.retries++;
                        logger(`   [429] Rate limited — waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
                        await sleep(delay);
                    } else if (attempt < maxRetries) {
                        const delay = retryBaseMs * Math.pow(2, attempt);
                        stats.retries++;
                        logger(`   [RETRY] ${e1.message} — attempt ${attempt + 1}/${maxRetries}, waiting ${delay}ms`);
                        await sleep(delay);
                    } else {
                        throw new Error(`All APIs failed after ${maxRetries + 1} attempts: ${e1.message}`);
                    }
                }
            }
        }
    }

    /* ---- single text: cache check + glossary fast-path + tag/glossary protection ---- */
    async function translate(text) {
        if (!text || !text.trim()) return text;
        const key = normalizeKey(text);

        // 0) Cache hit → return immediately
        const cached = cache.get(langPair, key);
        if (cached !== undefined) {
            stats.hits++;
            return cached;
        }

        // 1) GLOSSARY-ONLY fast path: if text is entirely glossary terms,
        //    translate via glossary directly — no API call, no caching
        if (glossaryState && isFullyGlossary(key, glossaryLowerSet, glossaryState)) {
            const result = translateViaGlossary(key, glossaryState);
            stats.glossaryApplied++;
            stats.hits++;
            return result;
        }

        let toTranslate = key;
        let tags = [];
        let glossaryTerms = [];
        let placeholders = [];

        // 2) Protect {placeholders} like {who}, {item_name}, {0}
        PLACEHOLDER_PATTERN.lastIndex = 0;
        if (PLACEHOLDER_PATTERN.test(toTranslate)) {
            const pp = protectPlaceholders(toTranslate);
            toTranslate = pp.cleaned;
            placeholders = pp.placeholders;
        }

        // 3) Protect markup tags BEFORE glossary (glossary would corrupt tag names like <color> → <Couleur>)
        tagPattern.lastIndex = 0;
        if (tagPattern.test(toTranslate)) {
            tagPattern.lastIndex = 0;
            const prot = protectTags(toTranslate, tagPattern);
            toTranslate = prot.cleaned;
            tags = prot.tags;
        }

        // Save pre-glossary text for LibreTranslate (server handles glossary natively)
        const toTranslateLibre = toTranslate;

        // 4) Protect glossary terms (for DeepL/Google/MyMemory — client-side protection)
        if (glossaryState) {
            const gp = protectGlossary(toTranslate, glossaryState);
            toTranslate = gp.cleaned;
            glossaryTerms = gp.glossaryTerms;
        }

        try {
            let result;
            if (libreActive) {
                libreActive = await ensureGlobalLibreChecked(srcLang, tgtLang, glossaryFile, logger);
            }
            // If LibreTranslate has the glossary loaded, try it first with unprotected text
            if (libreActive && globalLibreState.glossaryUploaded) {
                try {
                    stats.apiCalls++;
                    stats.libreCalls++;
                    const libreResult = await translateLibre(toTranslateLibre, srcLang, tgtLang);
                    if (libreResult.engine === 'ollama' || libreResult.engine === 'gpu') stats.gpuCalls++;
                    else stats.cpuCalls++;
                    result = libreResult.text;
                    // Restore only tags/placeholders (glossary handled server-side)
                    if (tags.length) result = restoreTags(result, tags);
                    if (placeholders.length) result = restorePlaceholders(result, placeholders);
                    if (result && result !== key) cache.set(langPair, key, result, { confirmed: true });
                    stats.misses++;
                    return result;
                } catch (eLibre) {
                    stats.libreErrors++;
                    if (eLibre.message.includes('ECONNREFUSED') || eLibre.message.includes('timeout') || eLibre.message.includes('ECONNRESET') || eLibre.message.includes('socket hang up')) {
                        logger(`   [LibreTranslate] Serveur non joignable (${eLibre.message}) — désactivation`);
                        libreActive = false;
                    }
                    // Fall through to translateRaw with client-side glossary tokens
                }
            }
            result = await translateRaw(toTranslate, key);
            // Restore in reverse order: glossary first, then tags
            if (glossaryTerms.length) {
                result = restoreGlossary(result, glossaryTerms);
                stats.glossaryApplied += glossaryTerms.length;
            }
            if (tags.length) result = restoreTags(result, tags);
            if (placeholders.length) result = restorePlaceholders(result, placeholders);
            if (result && result !== key) cache.set(langPair, key, result, { confirmed: true });
            stats.misses++;
            return result;
        } catch (e) {
            stats.errors++;
            throw e;
        }
    }

    /* ---- batch translate with DeepL batch + fallback ---- */
    async function translateBatch(uniqueKeys, onProgress) {
        const totalInput = uniqueKeys.length;
        if (totalInput > 500) {
            logger(`  📦 Scan cache: ${totalInput} chaînes...`);
        }

        libreActive = await ensureGlobalLibreChecked(srcLang, tgtLang, glossaryFile, logger);
        if (lmStudioActive) {
            lmStudioActive = await ensureLmStudioChecked(logger);
        }
        stats.localAiDetected = !!(lmStudioActive || libreActive);
        stats.googleOnly = !stats.localAiDetected && !geminiActive && !deeplActive;
        stats.lmstudio = {
            model: lmStudioState.model || '', configuredModel: LMSTUDIO_MODEL,
            contextTokens: LMSTUDIO_CONTEXT_TOKENS,
            detectedContextTokens: lmStudioState.contextTokens || 0,
            endpoint: lmStudioState.endpoint || '', modelsLoaded: lmStudioState.modelsLoaded || 0,
            mode: LMSTUDIO_MODE,
        };
        if (stats.googleOnly) logger('  [Pipeline] Aucune IA locale détectée — utilisation directe de Google API');
        const results = new Map();
        const toTranslate = [];

        function notify(key, result, fromCache, err, provider, sent) {
            if (typeof onProgress === 'function') {
                onProgress(key, result, fromCache, err || null, {
                    provider: provider || (fromCache ? 'cache' : 'api'),
                    sent: sent != null ? sent : key,
                });
            }
        }

        for (let i = 0; i < uniqueKeys.length; i++) {
            const key = uniqueKeys[i];
            const normalKey = normalizeKey(key);
            const cached = cache.get(langPair, normalKey);
            if (cached !== undefined) {
                const fixed = reconcileSlashCommands(key, cached);
                results.set(key, fixed);
                if (fixed !== cached) {
                    cache.set(langPair, normalKey, fixed, { confirmed: true });
                }
                stats.hits++;
                notify(key, fixed, true, null, 'cache');
            } else if (glossaryState && isFullyGlossary(normalKey, glossaryLowerSet, glossaryState)) {
                const glResult = translateViaGlossary(normalKey, glossaryState);
                results.set(key, glResult);
                stats.glossaryApplied++;
                stats.hits++;
                notify(key, glResult, true, null, 'glossary');
            } else if (isSkippableTranslation(normalKey)) {
                results.set(key, key);
                stats.hits++;
                notify(key, key, true, null, 'cache');
            } else {
                toTranslate.push(key);
            }

            if (i > 0 && i % 80 === 0) await sleep(0);
            if (totalInput > 5000 && i > 0 && i % 5000 === 0) {
                logger(`  📦 Scan cache: ${i}/${totalInput}...`);
            }
        }

        if (totalInput > 500) {
            logger(`  📦 Cache: ${stats.hits} trouvées, ${toTranslate.length} à traduire`);
        }

        if (toTranslate.length === 0) {
            cache.flushSave();
            return results;
        }

        if (toTranslate.length > 500) {
            logger(`  📦 Préparation: ${toTranslate.length} chaînes (tags/glossaire)...`);
        }

        // --- Pre-process all strings: protect placeholders/tags/glossary ---
        const prepared = [];
        for (let pi = 0; pi < toTranslate.length; pi++) {
            const key = toTranslate[pi];
            const normalKey = normalizeKey(key);
            let toSend = normalKey;
            let tags = [];
            let glossaryTerms = [];
            let placeholders = [];
            let slashCommands = [];

            // 1) Protect {placeholders} like {who}, {item_name}, {0}
            PLACEHOLDER_PATTERN.lastIndex = 0;
            if (PLACEHOLDER_PATTERN.test(toSend)) {
                const pp = protectPlaceholders(toSend);
                toSend = pp.cleaned;
                placeholders = pp.placeholders;
            }

            // 2) Protect slash commands (/home, /spark tps, …)
            SLASH_CMD_PATTERN.lastIndex = 0;
            if (SLASH_CMD_PATTERN.test(toSend)) {
                SLASH_CMD_PATTERN.lastIndex = 0;
                const sc = protectSlashCommands(toSend);
                toSend = sc.cleaned;
                slashCommands = sc.slashCommands;
            }

            // 3) Protect markup tags BEFORE glossary
            tagPattern.lastIndex = 0;
            if (tagPattern.test(toSend)) {
                tagPattern.lastIndex = 0;
                const prot = protectTags(toSend, tagPattern);
                toSend = prot.cleaned;
                tags = prot.tags;
            }

            // Save pre-glossary text for LibreTranslate (server handles glossary natively)
            const toSendLibre = toSend;

            // 4) Protect glossary terms (for DeepL/Google/MyMemory — client-side protection)
            if (glossaryState) {
                const gp = protectGlossary(toSend, glossaryState);
                toSend = gp.cleaned;
                glossaryTerms = gp.glossaryTerms;
            }

            prepared.push({ key, normalKey, toSend, toSendLibre, tags, glossaryTerms, placeholders, slashCommands });

            if (toTranslate.length > 5000 && pi > 0 && pi % 5000 === 0) {
                logger(`  📦 Préparation: ${pi}/${toTranslate.length}...`);
                await sleep(0);
            }
        }

        function salvageTokens(p, result) {
            result = String(result || '').replace(/<\/?(__(?:GL|PH|T|SC)\d+__)>/gi, '$1');
            if (p.glossaryTerms.length) result = restoreGlossary(result, p.glossaryTerms);
            if (p.tags.length) result = restoreTags(result, p.tags);
            if (p.placeholders.length) result = restorePlaceholders(result, p.placeholders);
            if (p.slashCommands.length) result = restoreSlashCommands(result, p.slashCommands);
            result = reconcileSlashCommands(p.key, result);
            return ensureMinecraftFormatSpacing(result);
        }

        // --- Post-process helper: restore glossary/tags/placeholders ---
        function postProcess(p, result) {
            if (p.glossaryTerms.length) {
                if (hasLostGlossaryToken(result, p.glossaryTerms)) {
                    // Le moteur a mangé un marqueur : la phrase contient un
                    // contresens, pas une traduction. On rend la source pour
                    // que le moteur suivant la reprenne.
                    stats.glossaryLost = (stats.glossaryLost || 0) + 1;
                    return p.key;
                }
                result = restoreGlossary(result, p.glossaryTerms);
                stats.glossaryApplied += p.glossaryTerms.length;
            }
            if (p.tags.length) result = restoreTags(result, p.tags);
            if (p.placeholders.length) result = restorePlaceholders(result, p.placeholders);
            if (p.slashCommands.length) result = restoreSlashCommands(result, p.slashCommands);
            result = reconcileSlashCommands(p.key, result);
            if (hasCorruptedTranslationText(result)) result = salvageTokens(p, result);
            if (hasCorruptedTranslationText(result)) return p.key;
            return ensureMinecraftFormatSpacing(result);
        }

        // Post-process for LibreTranslate: skip glossary restore (server handles it)
        function postProcessLibre(p, result) {
            if (p.tags.length) result = restoreTags(result, p.tags);
            if (p.placeholders.length) result = restorePlaceholders(result, p.placeholders);
            if (p.slashCommands.length) result = restoreSlashCommands(result, p.slashCommands);
            result = reconcileSlashCommands(p.key, result);
            if (hasCorruptedTranslationText(result)) return p.key;
            return ensureMinecraftFormatSpacing(result);
        }

        /** Free large prepared input strings once the result has been cached. */
        function releasePrepared(p) {
            p.toSend = null;
            p.toSendLibre = null;
        }

        const needFallback = []; // indices into prepared[] that need Google/MyMemory

        // --- PHASE 1: DeepL batch (up to 50 texts per API call) ---
        if (deeplActive && prepared.length > 0) {
            logger(`  📦 DeepL batch: ${prepared.length} textes → ~${Math.ceil(prepared.length / DEEPL_BATCH_SIZE)} appel(s) API`);

            for (let i = 0; i < prepared.length; i += DEEPL_BATCH_SIZE) {
                const chunk = prepared.slice(i, i + DEEPL_BATCH_SIZE);
                const textsToSend = chunk.map(p => p.toSend);
                let batchSuccess = false;

                for (let attempt = 0; attempt <= maxRetries; attempt++) {
                    try {
                        const translations = await translateDeepLBatch(textsToSend, srcLang, tgtLang);
                        stats.apiCalls++;
                        stats.deeplCalls += chunk.length;

                        for (let j = 0; j < chunk.length; j++) {
                            const p = chunk[j];
                            let result = postProcess(p, translations[j]);
                            cache.set(langPair, p.normalKey, result, { confirmed: true });
                            results.set(p.key, result);
                            releasePrepared(p);
                            stats.misses++;
                            notify(p.key, result, false, null, 'deepl', p.toSend);
                        }

                        batchSuccess = true;
                        break;
                    } catch (e) {
                        if (e.message === 'DEEPL_AUTH_FAILED') {
                            logger(`   [DeepL] Clé API invalide — désactivation DeepL`);
                            deeplActive = false;
                            break;
                        } else if (e.message === 'DEEPL_QUOTA_EXCEEDED') {
                            logger(`   [DeepL] Quota dépassé — fallback Google/MyMemory`);
                            deeplActive = false;
                            break;
                        } else if (e.message.startsWith('DEEPL_UNSUPPORTED_LANG')) {
                            deeplActive = false;
                            break;
                        } else if (e.message === 'HTTP_429' && attempt < maxRetries) {
                            const delay = retryBaseMs * Math.pow(2, attempt);
                            logger(`   [DeepL batch] Rate limited — attente ${delay}ms (essai ${attempt + 1}/${maxRetries})...`);
                            await sleep(delay);
                        } else {
                            stats.deeplErrors++;
                            logger(`   [DeepL batch] Erreur: ${e.message} — fallback individuel`);
                            break;
                        }
                    }
                }

                if (!batchSuccess) {
                    // Mark this chunk for individual fallback
                    for (let j = 0; j < chunk.length; j++) {
                        needFallback.push(i + j);
                    }
                    // If DeepL is permanently disabled, mark ALL remaining too
                    if (!deeplActive) {
                        for (let k = i + DEEPL_BATCH_SIZE; k < prepared.length; k++) {
                            if (!results.has(prepared[k].key)) needFallback.push(k);
                        }
                        break;
                    }
                }

                // Rate-limit delay between batch calls
                if (batchSuccess && i + DEEPL_BATCH_SIZE < prepared.length) {
                    await sleep(delayMs);
                }
            }
        } else {
            // No DeepL → all need LibreTranslate or individual fallback
            for (let i = 0; i < prepared.length; i++) needFallback.push(i);
        }

        // --- PHASE 1.5: Google fast lane for short, simple strings ---
        // Start Google without awaiting it: LM Studio/OpenRouter can work at
        // the same time on the remaining indices.
        let fastGooglePromise = null;
        if (!localOnly && needFallback.length > 0) {
            const fastCandidates = needFallback.filter(idx => isFastGoogleCandidate(prepared[idx]));
            const googleShare = (lmStudioActive || openRouterActive)
                ? Math.ceil(fastCandidates.length / 2)
                : fastCandidates.length;
            const fastIndices = fastCandidates.slice(0, googleShare);
            if (fastIndices.length > 0) {
                const fastItems = fastIndices.map(idx => prepared[idx]);
                logger(`  ⚡ Google rapide: ${fastItems.length}/${fastCandidates.length} textes courts → ${Math.min(GOOGLE_MAX_CONCURRENCY, GOOGLE_SAFE_CONCURRENCY)} requêtes parallèles (en parallèle des autres moteurs)`);
                fastGooglePromise = (async () => {
                    const fastTranslations = await translateGoogleBatch(
                        fastItems.map(p => p.toSend),
                        srcLang,
                        tgtLang,
                        {
                            concurrency: GOOGLE_SAFE_CONCURRENCY,
                            delayMs: GOOGLE_SAFE_DELAY_MS,
                            onProgress: (done, total, concurrency, delay) => {
                                if (done === total || done % (concurrency * 10) === 0) {
                                    logger(`     Google rapide: ${done}/${total} (${concurrency} parallèles, pause ${delay}ms)`);
                                }
                            },
                        }
                    );
                    stats.apiCalls += fastItems.length;
                    stats.googleCalls += fastItems.length;
                    stats.googleFastCalls = (stats.googleFastCalls || 0) + fastItems.length;
                    const stillNeedFastFallback = [];
                    for (let j = 0; j < fastItems.length; j++) {
                        const p = fastItems[j];
                        const translated = fastTranslations[j];
                        if (!translated || translated === p.toSend) {
                            stillNeedFastFallback.push(fastIndices[j]);
                            continue;
                        }
                        const result = postProcess(p, translated);
                        cache.set(langPair, p.normalKey, result, { confirmed: true });
                        results.set(p.key, result);
                        releasePrepared(p);
                        stats.misses++;
                        notify(p.key, result, false, null, 'google-fast', p.toSend);
                    }
                    return stillNeedFastFallback;
                })();
                const fastSet = new Set(fastIndices);
                const remainingIndices = needFallback.filter(idx => !fastSet.has(idx));
                needFallback.length = 0;
                needFallback.push(...remainingIndices);
            }
        }

        // --- PHASE 2: LibreTranslate batch (local, unlimited, parallel) ---
        // If glossary was uploaded to LibreTranslate, use toSendLibre (no client-side glossary tokens)
        // so the server handles glossary natively — better quality, no token corruption risk.
        const useLibreGlossary = globalLibreState.glossaryUploaded;
        if (libreActive && needFallback.length > 0) {
            const stillNeedFallback = [];
            const fallbackItems = needFallback.map(idx => prepared[idx]);
            const avgLen = fallbackItems.reduce((s, p) => s + (useLibreGlossary ? p.toSendLibre : p.toSend).length, 0) / fallbackItems.length;
            const totalChars = Math.round(avgLen * fallbackItems.length);

            // ============================================================
            // GPU SINGLE-SHOT: send ALL texts in one request (no chunking)
            // ============================================================
            if (LIBRE_MODE === 'gpu' || LIBRE_MODE === 'gpu_progressive' || LIBRE_MODE === 'dual_gpu') {
                const isProgressive = LIBRE_MODE === 'gpu_progressive' || LIBRE_MODE === 'dual_gpu';
                const isDual = LIBRE_MODE === 'dual_gpu';
                const modeIcon = isDual ? '⚡' : (LIBRE_MODE === 'gpu_progressive' ? '📊' : '🧠');
                const modeTag = isDual ? 'Dual-GPU (iGPU easy + dGPU medium/hard)' : (LIBRE_MODE === 'gpu_progressive' ? 'GPU Progressive' : 'GPU single-shot');
                logger(`  ${modeIcon} LibreTranslate ${modeTag}: ${needFallback.length} textes (${totalChars} chars total, avg ${Math.round(avgLen)} chars)${useLibreGlossary ? ' 📖glossaire serveur' : ''}`);

                const allTexts = useLibreGlossary
                    ? fallbackItems.map(p => p.toSendLibre)
                    : fallbackItems.map(p => p.toSend);

                for (let attempt = 0; attempt <= maxRetries; attempt++) {
                    try {
                        const batchResult = isProgressive
                            ? await translateLibreBatchGPUProgressive(allTexts, srcLang, tgtLang, logger, LIBRE_MODE)
                            : await translateLibreBatchGPU(allTexts, srcLang, tgtLang, logger);
                        const translations = batchResult.texts;
                        stats.apiCalls++;
                        stats.libreCalls += fallbackItems.length;
                        stats.gpuCalls += fallbackItems.length;

                        for (let j = 0; j < fallbackItems.length; j++) {
                            const p = fallbackItems[j];
                            let result = useLibreGlossary
                                ? postProcessLibre(p, translations[j])
                                : postProcess(p, translations[j]);
                            cache.set(langPair, p.normalKey, result, { confirmed: true });
                            results.set(p.key, result);
                            releasePrepared(p);
                            stats.misses++;
                            notify(p.key, result, false, null, 'libre', useLibreGlossary ? p.toSendLibre : p.toSend);
                        }
                        if (batchResult.timing_ms) {
                            logger(`  ${modeIcon} ${modeTag} terminé: ${fallbackItems.length} textes en ${Math.round(batchResult.timing_ms / 1000)}s (1 appel API)`);
                        }
                        // Log tier stats for gpu_progressive / dual_gpu
                        if (isProgressive && batchResult.tierStats) {
                            stats.tierStats = batchResult.tierStats;
                            const ts = batchResult.tierStats;
                            if (isDual) {
                                logger(`  ⚡ Dual-GPU Tiers:`);
                                if (ts.easy) logger(`     🟢 iGPU  Easy   ${ts.easy.count} textes — ${ts.easy.time.toFixed(2)}s (${ts.easy.avg_per_text.toFixed(3)}s/texte)`);
                                if (ts.medium) logger(`     🟡 dGPU  Medium ${ts.medium.count} textes — ${ts.medium.time.toFixed(2)}s (${ts.medium.avg_per_text.toFixed(3)}s/texte) — ${ts.medium.multiplier || '?'}x`);
                                if (ts.hard) logger(`     🔴 dGPU  Hard   ${ts.hard.count} textes — ${ts.hard.time.toFixed(2)}s (${ts.hard.avg_per_text.toFixed(3)}s/texte) — ${ts.hard.multiplier || '?'}x`);
                            } else {
                                logger(`  📊 Tiers:`);
                                if (ts.easy) logger(`     Easy   ${ts.easy.count} textes — ${ts.easy.time.toFixed(2)}s (${ts.easy.avg_per_text.toFixed(3)}s/texte) — 1.0x`);
                                if (ts.medium) logger(`     Medium ${ts.medium.count} textes — ${ts.medium.time.toFixed(2)}s (${ts.medium.avg_per_text.toFixed(3)}s/texte) — ${ts.medium.multiplier || '?'}x`);
                                if (ts.hard) logger(`     Hard   ${ts.hard.count} textes — ${ts.hard.time.toFixed(2)}s (${ts.hard.avg_per_text.toFixed(3)}s/texte) — ${ts.hard.multiplier || '?'}x`);
                            }
                        }
                        break; // success
                    } catch (e) {
                        if (e.message.includes('ECONNREFUSED') || e.message.includes('ECONNRESET') || e.message.includes('socket hang up')) {
                            logger(`   [LibreTranslate ${modeTag}] Serveur non joignable (${e.message}) — désactivation`);
                            libreActive = false;
                            for (const idx of needFallback) stillNeedFallback.push(idx);
                            break;
                        } else if (e.message.includes('timeout')) {
                            logger(`   [LibreTranslate ${modeTag}] Timeout — fallback chunked`);
                            for (const idx of needFallback) stillNeedFallback.push(idx);
                            break;
                        } else if (attempt < maxRetries) {
                            const delay = retryBaseMs * Math.pow(2, attempt);
                            logger(`   [LibreTranslate ${modeTag}] Erreur: ${e.message} — retry ${attempt + 1}/${maxRetries}`);
                            await sleep(delay);
                        } else {
                            stats.libreErrors++;
                            logger(`   [LibreTranslate ${modeTag}] Erreur: ${e.message} — fallback`);
                            for (const idx of needFallback) stillNeedFallback.push(idx);
                        }
                    }
                }
            } else {
            // ============================================================
            // CHUNKED MODE (auto/cpu): adaptive chunking by count + chars
            // ============================================================
            const allChunks = [];
            let chunk = [], chunkIndices = [], chunkChars = 0;
            for (let i = 0; i < fallbackItems.length; i++) {
                const textLen = (useLibreGlossary ? fallbackItems[i].toSendLibre : fallbackItems[i].toSend).length;
                if (chunk.length > 0 && (chunk.length >= LIBRE_BATCH_SIZE || chunkChars + textLen > LIBRE_BATCH_CHARS)) {
                    allChunks.push({ items: chunk, indices: chunkIndices });
                    chunk = []; chunkIndices = []; chunkChars = 0;
                }
                chunk.push(fallbackItems[i]);
                chunkIndices.push(needFallback[i]);
                chunkChars += textLen;
            }
            if (chunk.length > 0) allChunks.push({ items: chunk, indices: chunkIndices });

            const parallel = avgLen > 150 ? 1 : LIBRE_PARALLEL;
            const modeLabel = LIBRE_MODE === 'cpu' ? '💻 CPU forcé' : '🔄 AUTO';
            logger(`  🏠 LibreTranslate batch: ${needFallback.length} textes → ${allChunks.length} chunk(s) (avg ${Math.round(avgLen)} chars), ‖${parallel} [${modeLabel}]${useLibreGlossary ? ' 📖glossaire serveur' : ''}`);

            for (let w = 0; w < allChunks.length; w += parallel) {
                if (!libreActive) {
                    for (let r = w; r < allChunks.length; r++) {
                        for (const idx of allChunks[r].indices) stillNeedFallback.push(idx);
                    }
                    break;
                }

                const wave = allChunks.slice(w, w + parallel);
                const wavePromises = wave.map(async ({ items: chunk, indices: chunkIndices }) => {
                    for (let attempt = 0; attempt <= maxRetries; attempt++) {
                        try {
                            const textsToSend = useLibreGlossary
                                ? chunk.map(p => p.toSendLibre)
                                : chunk.map(p => p.toSend);
                            const batchResult = await translateLibreBatch(textsToSend, srcLang, tgtLang);
                            const translations = batchResult.texts;
                            stats.apiCalls++;
                            stats.libreCalls += chunk.length;
                            if (batchResult.engines) {
                                for (const eng of batchResult.engines) {
                                    if (eng === 'ollama' || eng === 'gpu') stats.gpuCalls++;
                                    else stats.cpuCalls++;
                                }
                            } else if (batchResult.engine) {
                                const eng = batchResult.engine;
                                const inc = chunk.length;
                                if (eng === 'ollama' || eng === 'gpu') stats.gpuCalls += inc;
                                else stats.cpuCalls += inc;
                            }

                            for (let j = 0; j < chunk.length; j++) {
                                const p = chunk[j];
                                let result = useLibreGlossary
                                    ? postProcessLibre(p, translations[j])
                                    : postProcess(p, translations[j]);
                                cache.set(langPair, p.normalKey, result, { confirmed: true });
                                results.set(p.key, result);
                                releasePrepared(p);
                                stats.misses++;
                                notify(p.key, result, false, null, 'libre', useLibreGlossary ? p.toSendLibre : p.toSend);
                            }
                            return { ok: true };
                        } catch (e) {
                            if (e.message.includes('ECONNREFUSED') || e.message.includes('timeout') || e.message.includes('ECONNRESET') || e.message.includes('socket hang up')) {
                                logger(`   [LibreTranslate] Serveur non joignable (${e.message}) — désactivation`);
                                libreActive = false;
                                return { ok: false, indices: chunkIndices };
                            } else if (attempt < maxRetries) {
                                const delay = retryBaseMs * Math.pow(2, attempt);
                                logger(`   [LibreTranslate batch] Erreur: ${e.message} — retry ${attempt + 1}/${maxRetries}`);
                                await sleep(delay);
                            } else {
                                stats.libreErrors++;
                                logger(`   [LibreTranslate batch] Erreur: ${e.message} — fallback Google/MyMemory`);
                                return { ok: false, indices: chunkIndices };
                            }
                        }
                    }
                    return { ok: false, indices: chunkIndices };
                });

                const waveResults = await Promise.all(wavePromises);
                for (const wr of waveResults) {
                    if (!wr.ok && wr.indices) {
                        for (const idx of wr.indices) stillNeedFallback.push(idx);
                    }
                }

                if (w + parallel < allChunks.length && libreActive) {
                    await sleep(200);
                }
            }
            } // end chunked mode

            // Replace needFallback with remaining items
            needFallback.length = 0;
            needFallback.push(...stillNeedFallback);
        }

        // --- PHASE 2.5: Gemini fallback ---
        // When LM Studio is available, medium/long strings stay local. Gemini
        // remains a cloud fallback only when no local LM Studio model is ready.
        if (geminiActive && !lmStudioActive && needFallback.length > 0) {
            // Première phase passée sur runEnginePhase (modules/utils/
            // translation-engines.js) : découpage, reliquats, stats et
            // désactivation sur clé invalide y sont génériques et testés.
            const gemini = ENGINES.get('gemini');
            logger(`  ✨ Gemini: ${needFallback.length} textes → ${gemini.chunk(needFallback).length} appel(s) (max ${gemini.chunkSize}/appel)`);

            const leftovers = await runEnginePhase({
                engine: gemini,
                indices: needFallback,
                getItem: (idx) => prepared[idx],
                ctx: { srcLang, tgtLang, logger },
                hooks: {
                    onTranslated: (p, text) => {
                        const result = postProcess(p, text);
                        cache.set(langPair, p.normalKey, result, { confirmed: true });
                        results.set(p.key, result);
                        releasePrepared(p);
                        stats.misses++;
                        notify(p.key, result, false, null, 'gemini', p.toSend);
                    },
                    onStat: (key, n) => { stats[key] = (stats[key] || 0) + n; },
                    onError: (err, engine, fatal) => {
                        if (!fatal) logger(`   [${engine.label}] Erreur: ${err.message} — fallback Google`);
                    },
                    onFatal: () => { geminiActive = false; },
                    log: logger,
                },
            });

            needFallback.length = 0;
            needFallback.push(...leftovers);
            if (stats.geminiCalls > 0) logger(`  ✅ Gemini: ${stats.geminiCalls} appel(s), ${needFallback.length} non traduits → LM Studio/Google`);
        }

        async function runOpenRouterLane(indices) {
            if (!openRouterActive || !indices.length) return [];
            const stillNeedFallback = [];
            const chunks = [];
            for (let i = 0; i < indices.length; i += OPENROUTER_CHUNK_MAX) {
                chunks.push(indices.slice(i, i + OPENROUTER_CHUNK_MAX));
            }
            logger(`  🌐 OpenRouter/free: ${indices.length} textes → ${chunks.length} appel(s) en parallèle des autres moteurs`);
            let openRouterDone = 0;
            for (const chunk of chunks) {
                const items = chunk.map(idx => prepared[idx]);
                try {
                    const translations = await translateOpenRouterBatch(items.map(p => p.toSend), srcLang, tgtLang);
                    stats.openrouterCalls++;
                    stats.apiCalls++;
                    for (let j = 0; j < items.length; j++) {
                        const p = items[j];
                        const translated = translations[j];
                        if (!translated || translated === p.toSend) {
                            stillNeedFallback.push(chunk[j]);
                            continue;
                        }
                        const result = postProcess(p, translated);
                        cache.set(langPair, p.normalKey, result, { confirmed: true });
                        results.set(p.key, result);
                        releasePrepared(p);
                        stats.misses++;
                        notify(p.key, result, false, null, 'openrouter', p.toSend);
                    }
                } catch (error) {
                    stats.openrouterErrors++;
                    if (error.message === 'OPENROUTER_AUTH_FAILED') {
                        openRouterActive = false;
                        logger('   [OpenRouter] Clé invalide — désactivation');
                    } else {
                        logger(`   [OpenRouter] ${error.message} — fallback Google/MyMemory`);
                    }
                    stillNeedFallback.push(...chunk);
                }
                openRouterDone++;
                logger(`     OpenRouter/free lot ${openRouterDone}/${chunks.length} terminé (${items.length} textes, ${stillNeedFallback.length} restant(s))`);
            }
            logger(`  ✅ OpenRouter/free terminé : ${indices.length - stillNeedFallback.length}/${indices.length} textes, ${stillNeedFallback.length} restant(s)`);
            return stillNeedFallback;
        }

        // --- PHASE 2.6: partage LM Studio / OpenRouter ---
        // Quand les deux moteurs sont disponibles, répartir les textes environ
        // moitié/moitié. OpenRouter est ensuite sérialisé par sa file de quota.
        let openRouterAssigned = [];
        if (openRouterActive && needFallback.length > 0) {
            const mixed = needFallback.splice(0, needFallback.length);
            if (lmStudioActive && mixed.length > 1) {
                mixed.forEach((idx, position) => {
                    if (position % 2 === 1) openRouterAssigned.push(idx);
                    else needFallback.push(idx);
                });
                logger(`  ⚖️ Répartition locale/cloud : ${needFallback.length} LM Studio · ${openRouterAssigned.length} OpenRouter/free`);
            } else {
                openRouterAssigned = mixed;
            }
        }
        // OpenRouter démarre maintenant, sans attendre la fin de LM Studio.
        const openRouterPromise = runOpenRouterLane(openRouterAssigned);

        // --- PHASE 2.7: LM Studio local (free) — lots in one chat, then fallback ---
        if (lmStudioActive && needFallback.length > 0) {
            const stillNeedFallback = [];
            const sysTok = estimateLmTokens(buildLmStudioSystemPrompt(glossaryFile, tgtLang, 6, true));
            // Use the available context budget (capped at 8000) minus the output allowance and a safety margin
            const userBudgetTok = Math.max(80, lmStudioSafeContext() - sysTok - LMSTUDIO_MAX_TOKENS - 256);
            const chunks = packLmStudioChunks(needFallback, prepared, userBudgetTok);
            lmStudioSolo = false;
            let lmSlots = Math.max(1, Math.min(4, LMSTUDIO_PARALLEL, chunks.length || 1));
            logger(`  🖥️ LM Studio: ${needFallback.length} textes → ${chunks.length} appel(s) ×${lmSlots} (passe à 1 si contexte plein)`);

            function finalizeLmStudioText(p, raw) {
                const src = raw == null ? '' : String(raw).trim();
                if (!src) return '';
                let result = postProcess(p, src);
                if (result && !hasCorruptedTranslationText(result) && result !== p.key) return result;
                result = salvageTokens(p, src);
                if (hasCorruptedTranslationText(result)) {
                    result = String(result).replace(/__(?:GL|PH|T|SC)\d+__/gi, '').replace(/\s{2,}/g, ' ').trim();
                }
                return result || '';
            }

            function keepLmStudio(p, result) {
                cache.set(langPair, p.normalKey, result, { confirmed: true });
                results.set(p.key, result);
                releasePrepared(p);
                stats.misses++;
                notify(p.key, result, false, null, 'lmstudio', p.toSend);
            }

            let lmConnFails = 0;

            async function translateOversizedIndex(idx) {
                const p = prepared[idx];
                let segs = splitLongText(p.toSend, 220);
                if (segs.length > 4) segs = splitLongText(p.toSend, Math.ceil(estimateLmTokens(p.toSend) / 4)).slice(0, 4);
                if (segs.length < 2) return { ok: false, leftover: [idx] };
                logger(`   [LM Studio] texte long (${p.toSend.length} car.) → ${segs.length} morceaux`);
                const pieces = [];
                for (const seg of segs) {
                    try {
                        const t = await translateLmStudioBatch([seg], srcLang, tgtLang, glossaryFile, logger, true, getGlossaryContext([p.key]));
                        pieces.push(t[0] || '');
                    } catch (e) {
                        logger(`   [LM Studio] morceau sauté: ${e.message}`);
                        pieces.push('');
                    }
                }
                const result = finalizeLmStudioText(p, pieces.join(''));
                if (!result) return { ok: false, leftover: [idx] };
                keepLmStudio(p, result);
                return { ok: true, leftover: [] };
            }

            async function runLmChunk(chunk) {
                if (!lmStudioActive) return { ok: false, leftover: chunk };
                if (chunk.length === 1) {
                    const one = String((prepared[chunk[0]] && prepared[chunk[0]].toSend) || '');
                    if (estimateLmTokens(one) > userBudgetTok) return translateOversizedIndex(chunk[0]);
                }
                if (chunk.length > 1) {
                    const probe = chunk.map(idx => String((prepared[idx] && prepared[idx].toSend) || ''));
                    const tooFat = estimateLmTokens(probe.join('')) > userBudgetTok || chunk.length > (LMSTUDIO_MODE === 'fast' ? 10 : LMSTUDIO_CHUNK_MAX);
                    if (tooFat) {
                        const mid = Math.ceil(chunk.length / 2);
                        const a = await runLmChunk(chunk.slice(0, mid));
                        const b = await runLmChunk(chunk.slice(mid));
                        return { ok: a.ok && b.ok, leftover: [...(a.leftover || []), ...(b.leftover || [])] };
                    }
                }
                const chunkItems = chunk.map(idx => prepared[idx]);
                const textsToSend = chunkItems.map(p => p.toSend);
                let translations = null;
                let lastErr = null;
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        translations = await translateLmStudioBatch(textsToSend, srcLang, tgtLang, glossaryFile, logger, false, getGlossaryContext(chunkItems.map(p => p.key)));
                        lastErr = null;
                        lmConnFails = 0;
                        break;
                    } catch (e) {
                        lastErr = e;
                        const conn = /ECONNREFUSED|timeout|ECONNRESET|socket hang up|EPIPE/i.test(e.message);
                        if (conn) lmConnFails++;
                        if (isLmStudioContextError(e)) {
                            enterLmStudioSolo(logger);
                            lmSlots = 1;
                            if (chunk.length > 1) {
                                logger(`   [LM Studio] contexte plein — 1 texte à la fois`);
                                const leftover = [];
                                for (const idx of chunk) {
                                    const one = await runLmChunk([idx]);
                                    leftover.push(...(one.leftover || []));
                                }
                                return { ok: leftover.length === 0, leftover };
                            }
                            logger(`   [LM Studio] contexte plein — découpe le texte`);
                            return translateOversizedIndex(chunk[0]);
                        }
                        if (isLmStudioAbortError(e)) {
                            return { ok: false, leftover: chunk };
                        }
                        if (attempt === 0) await sleep(conn ? 600 : 120);
                    }
                }
                if (!translations) {
                    stats.lmstudioErrors++;
                    const conn = lastErr && /ECONNREFUSED|timeout|ECONNRESET|socket hang up|EPIPE/i.test(lastErr.message);
                    if (conn && lmConnFails >= 2) {
                        logger(`   [LM Studio] ${describeLmStudioError(lastErr)} — fallback Google API`);
                        lmStudioActive = false;
                    } else {
                        logger(`   [LM Studio] Erreur: ${lastErr ? lastErr.message : 'vide'} — retry lot suivant`);
                    }
                    return { ok: false, leftover: chunk };
                }
                stats.lmstudioCalls++;
                stats.apiCalls++;
                const leftover = [];
                for (let j = 0; j < chunkItems.length; j++) {
                    const p = chunkItems[j];
                    const result = finalizeLmStudioText(p, translations[j]);
                    if (!result) leftover.push(chunk[j]);
                    else keepLmStudio(p, result);
                }
                return { ok: true, leftover };
            }

            let lmDone = 0;
            async function runLmQueue(list) {
                const q = list.slice();
                let active = 0;
                await new Promise((resolve) => {
                    const kick = () => {
                        if (!q.length && active === 0) return resolve();
                        const cap = lmStudioSolo ? 1 : lmSlots;
                        while (active < cap && q.length) {
                            const chunk = q.shift();
                            active++;
                            (async () => {
                                if (!lmStudioActive) {
                                    stillNeedFallback.push(...chunk);
                                    return;
                                }
                                const wr = await runLmChunk(chunk);
                                lmDone++;
                                if (wr.leftover && wr.leftover.length) stillNeedFallback.push(...wr.leftover);
                                logger(`  [LM Studio] lot ${lmDone} (${chunk.length} textes)${wr.ok ? '' : ' — retry'}${lmStudioSolo ? ' [×1]' : ''}`);
                            })().catch(() => {
                                stillNeedFallback.push(...chunk);
                            }).finally(() => {
                                active--;
                                kick();
                            });
                        }
                    };
                    kick();
                });
            }

            await runLmQueue(chunks);

            if (lmStudioActive && stillNeedFallback.length > 0) {
                const retry = stillNeedFallback.splice(0, stillNeedFallback.length);
                const retrySysTok = estimateLmTokens(buildLmStudioSystemPrompt(glossaryFile, tgtLang, 6, true));
                const retryBudgetTok = Math.max(80, lmStudioSafeContext() - retrySysTok - LMSTUDIO_MAX_TOKENS - 256);
                const retryChunks = packLmStudioChunks(retry, prepared, retryBudgetTok);
                logger(`  🖥️ LM Studio retry: ${retry.length} cases vides → ${retryChunks.length} lot(s)${lmStudioSolo ? ' ×1' : ''}`);
                await runLmQueue(retryChunks);
            }

            // Ne pas perdre les lots vides : ils doivent continuer vers
            // OpenRouter puis Google/MyMemory au lieu de devenir l'original.
            needFallback.length = 0;
            needFallback.push(...stillNeedFallback);
            if (lmStudioActive) {
                logger(`  ✅ LM Studio: ${stats.lmstudioCalls} appel(s), ${needFallback.length} restants → OpenRouter/Google`);
            } else if (stats.lmstudioCalls > 0) {
                logger(`  ✅ LM Studio: ${stats.lmstudioCalls} appel(s), ${needFallback.length} restants → Google`);
            }
        }

        // Wait for the OpenRouter lane only after LM Studio has had time to run.
        // This is the synchronization point for the three parallel lanes.
        const lmLeftovers = needFallback.splice(0, needFallback.length);
        const openRouterLeftovers = await openRouterPromise;
        const combinedLeftovers = [...lmLeftovers, ...openRouterLeftovers];
        needFallback.push(...combinedLeftovers);
        if (combinedLeftovers.length > 0 && openRouterActive) {
            const retryLeftovers = await runOpenRouterLane(combinedLeftovers);
            needFallback.length = 0;
            needFallback.push(...retryLeftovers);
        }

        // --- PHASE 3: Google waves (streaming progress) → MyMemory for leftovers ---
        if (localOnly && needFallback.length > 0) {
            throw new Error('LOCAL_AI_NOT_AVAILABLE: démarre LM Studio ou LibreTranslate local avant de lancer la traduction Outer Wilds');
        }
        if (needFallback.length > 0) {
            let googleConcurrency = Math.min(
                Math.max(concurrency, GOOGLE_SAFE_CONCURRENCY),
                GOOGLE_MAX_CONCURRENCY
            );
            let googleDelay = Math.max(delayMs, GOOGLE_SAFE_DELAY_MS);
            const totalGoogle = needFallback.length;
            logger(`  🔄 Google batch: ${totalGoogle} textes (‖${googleConcurrency}, pause ${googleDelay}ms)`);

            const stillNeedMyMemory = [];
            let googleDone = 0;

            for (let wi = 0; wi < needFallback.length; wi += googleConcurrency) {
                const waveIndices = needFallback.slice(wi, wi + googleConcurrency);
                const wavePrepared = waveIndices.map(idx => prepared[idx]);
                stats.googleCalls += wavePrepared.length;
                stats.googleFallbacks += wavePrepared.length;

                const waveResults = await Promise.all(wavePrepared.map(async (p) => {
                    const text = p.toSend;
                    for (let attempt = 0; attempt <= GOOGLE_MAX_RETRIES; attempt++) {
                        try {
                            return await translateGoogle(text, srcLang, tgtLang);
                        } catch (e) {
                            if (attempt < GOOGLE_MAX_RETRIES) stats.retries++;
                            if (e.message === 'HTTP_429') {
                                googleConcurrency = Math.max(2, Math.floor(googleConcurrency / 2));
                                googleDelay = Math.min(googleDelay * 2, 3000);
                                const base = Math.min(googleDelay * Math.pow(2, attempt), 5000);
                                const jitter = Math.floor(Math.random() * 500);
                                logger(`   [Google] Rate limit — ‖${googleConcurrency}, pause ${base + jitter}ms (essai ${attempt + 1}/${GOOGLE_MAX_RETRIES})`);
                                if (attempt < GOOGLE_MAX_RETRIES) {
                                    await sleep(base + jitter);
                                } else {
                                    return text;
                                }
                            } else if (attempt < GOOGLE_MAX_RETRIES) {
                                const wait = 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
                                await sleep(wait);
                            } else {
                                return text;
                            }
                        }
                    }
                    return text;
                }));
                stats.apiCalls += wavePrepared.length;

                for (let j = 0; j < wavePrepared.length; j++) {
                    const p = wavePrepared[j];
                    const raw = waveResults[j];
                    googleDone++;

                    if (!raw || raw === p.toSend) {
                        stillNeedMyMemory.push(waveIndices[j]);
                        continue;
                    }
                    let result = postProcess(p, raw);
                    if (result === p.key || hasCorruptedTranslationText(result)) {
                        stillNeedMyMemory.push(waveIndices[j]);
                        continue;
                    }
                    cache.set(langPair, p.normalKey, result, { confirmed: true });
                    results.set(p.key, result);
                    releasePrepared(p);
                    stats.misses++;
                    notify(p.key, result, false, null, 'google', p.toSend);
                }

                if (googleDone % 600 < googleConcurrency || googleDone === totalGoogle) {
                    logger(`  🔄 Google: ${googleDone}/${totalGoogle} traduits...`);
                }

                if (wi + googleConcurrency < needFallback.length) {
                    await sleep(googleDelay);
                }
            }

            if (stillNeedMyMemory.length > 0) {
                logger(`  🔄 MyMemory: ${stillNeedMyMemory.length} textes restants (‖${MYMEMORY_SAFE_CONCURRENCY})`);
                let mmDone = 0;
                const mmTotal = stillNeedMyMemory.length;

                for (let mi = 0; mi < stillNeedMyMemory.length; mi += MYMEMORY_SAFE_CONCURRENCY) {
                    const mmWave = stillNeedMyMemory.slice(mi, mi + MYMEMORY_SAFE_CONCURRENCY);
                    const mmResults = await Promise.all(mmWave.map(async (prepIdx) => {
                        const p = prepared[prepIdx];
                        try {
                            return await translateMyMemory(p.toSend, srcLang, tgtLang);
                        } catch {
                            return p.toSend;
                        }
                    }));

                    for (let k = 0; k < mmWave.length; k++) {
                        const prepIdx = mmWave[k];
                        const p = prepared[prepIdx];
                        const raw = mmResults[k];
                        stats.apiCalls++;
                        mmDone++;

                        if (!raw || raw === p.toSend) {
                            results.set(p.key, p.key);
                            stats.misses++;
                            notify(p.key, p.key, false, null, 'mymemory', p.toSend);
                            continue;
                        }
                        let result = postProcess(p, raw);
                        if (result === p.key || hasCorruptedTranslationText(result)) {
                            if (result === p.key) {
                                results.set(p.key, p.key);
                                stats.misses++;
                                notify(p.key, p.key, false, null, 'mymemory', p.toSend);
                            } else {
                                stats.errors++;
                                notify(p.key, null, false, new Error('Corrupted translation'), 'mymemory', p.toSend);
                            }
                            continue;
                        }
                        cache.set(langPair, p.normalKey, result, { confirmed: true });
                        results.set(p.key, result);
                        releasePrepared(p);
                        stats.misses++;
                        notify(p.key, result, false, null, 'mymemory', p.toSend);
                    }

                    if (mmDone % 200 < MYMEMORY_SAFE_CONCURRENCY || mmDone === mmTotal) {
                        logger(`  🔄 MyMemory: ${mmDone}/${mmTotal}...`);
                    }

                    if (mi + MYMEMORY_SAFE_CONCURRENCY < stillNeedMyMemory.length) {
                        await sleep(MYMEMORY_SAFE_DELAY_MS);
                    }
                }
            }
        }

        // Log GPU/CPU breakdown if LibreTranslate was used
        if (stats.libreCalls > 0 && (stats.gpuCalls > 0 || stats.cpuCalls > 0)) {
            logger(`  📊 Engine: 🧠 GPU ${stats.gpuCalls} | 💻 CPU ${stats.cpuCalls} (mode: ${LIBRE_MODE})`);
        }

        if (fastGooglePromise) {
            const googleLeftovers = await fastGooglePromise.catch(error => {
                logger(`   [Google rapide] Erreur: ${error.message} — fallback MyMemory`);
                return [];
            });
            if (googleLeftovers.length > 0) {
                const leftoverItems = googleLeftovers.map(idx => prepared[idx]);
                const fallbackTranslations = await translateMyMemoryBatch(
                    leftoverItems.map(p => p.toSend), srcLang, tgtLang
                );
                for (let i = 0; i < leftoverItems.length; i++) {
                    const p = leftoverItems[i];
                    const result = postProcess(p, fallbackTranslations[i] || p.key);
                    cache.set(langPair, p.normalKey, result, { confirmed: true });
                    results.set(p.key, result);
                    releasePrepared(p);
                    stats.misses++;
                    stats.mymemoryCalls++;
                    notify(p.key, result, false, null, 'mymemory', p.toSend);
                }
            }
        }

        cache.flushSave();
        stats.elapsedMs = Date.now() - stats.startedAt;
        stats.averageMs = totalInput > 0 ? Math.round(stats.elapsedMs / totalInput) : 0;
        stats.cacheHits = stats.hits;
        stats.lmstudio.model = lmStudioState.model || '';
        stats.lmstudio.detectedContextTokens = lmStudioState.contextTokens || 0;
        stats.lmstudio.endpoint = lmStudioState.endpoint || '';
        stats.lmstudio.modelsLoaded = lmStudioState.modelsLoaded || 0;
        logger(`  📊 Stats: cache ${stats.hits} · appels ${stats.apiCalls} · erreurs ${stats.errors} · retries ${stats.retries} · Google ${stats.googleFallbacks} · ${stats.averageMs} ms/texte`);
        return results;
    }

    function flush() {
        cache.flushSave();
    }

    return { translate, translateBatch, flush, stats, cache, langPair };
}

/* ================================================================
   RESOLVE LANGUAGE  — accepts name or code
   ================================================================ */
/**
 * Resolve a language input (code, full or partial name) to a known language.
 * @param {string} input - User-supplied language string.
 * @returns {{name:string, code:string}|null} Language descriptor or null.
 */
function resolveLang(input) {
    if (!input) return null;
    const lower = input.toLowerCase().trim();
    // Direct code match
    for (const [name, code] of Object.entries(LANGUAGES)) {
        if (code === lower) return { name, code };
    }
    // Name match (case-insensitive)
    for (const [name, code] of Object.entries(LANGUAGES)) {
        if (name.toLowerCase() === lower) return { name, code };
    }
    // Partial name match
    for (const [name, code] of Object.entries(LANGUAGES)) {
        if (name.toLowerCase().includes(lower)) return { name, code };
    }
    return null;
}

function getLibreMode() { return LIBRE_MODE; }
function setLibreMode(mode) {
    if (['auto', 'gpu', 'cpu', 'gpu_progressive', 'dual_gpu'].includes(mode)) {
        LIBRE_MODE = mode;
        return true;
    }
    return false;
}

module.exports = { createTranslator, getTranslationCache, flushAllTranslationCaches, normalizeKey, normalizeCacheKey, LANGUAGES, TAG_PATTERN_BG3, loadTagFilter, resolveLang, getLibreLLMStatus, setLibreLLM, updateLibreLLMConfig, getLibreLLMPrompt, setLibreLLMPrompt, verifyLibreCache, verifyLmStudioCache, getLibreMode, setLibreMode, resolvePromptVars, GAME_NAMES, reconcileSlashCommands, reloadApicleConfig, getLmStudioStatus, ensureMinecraftFormatSpacing };
