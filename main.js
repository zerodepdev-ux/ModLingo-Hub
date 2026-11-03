'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const { readLSPK, readEntryData, writeLSPK, closeLSPK, parseLoca, buildLoca } = require('./lspk');
const { createTranslator, LANGUAGES, resolveLang } = require('./translator');
const { verifyPak } = require('./verify-pak');

/* ================================================================
   ANSI COLORS  (no external dependency)
   ================================================================ */
const C = {
    reset:   '\x1b[0m',
    bold:    '\x1b[1m',
    dim:     '\x1b[2m',
    green:   '\x1b[32m',
    yellow:  '\x1b[33m',
    red:     '\x1b[31m',
    cyan:    '\x1b[36m',
    magenta: '\x1b[35m',
    white:   '\x1b[37m',
};

/**
 * Print a colored message to the console.
 * @param {string} msg - The message to print.
 * @param {string} [color=''] - ANSI color prefix.
 */
function log(msg, color = '') { console.log(`${color}${msg}${C.reset}`); }

/* ================================================================
   XML PARSER / BUILDER CONFIG  (fast-xml-parser v4)
   ================================================================ */
const xmlParserOpts = {
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    trimValues: false,
    processEntities: true,
    stopNodes: [],
    parseTagValue: false,
};

const xmlBuilderOpts = {
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    processEntities: true,
    format: true,
    indentBy: '  ',
    suppressEmptyNode: false,
    suppressBooleanAttributes: false,
};

/* ================================================================
   XML TREE HELPERS  (walk preserveOrder output)
   ================================================================ */
/**
 * Recursively collect XML nodes that represent <content> elements.
 * @param {Array<Object>} nodes - Parsed XML tree nodes (preserveOrder format).
 * @param {Array<Object>} [results=[]] - Accumulator for found elements.
 * @returns {Array<Object>} List of content element descriptors.
 */
function findContentElements(nodes, results = []) {
    if (!Array.isArray(nodes)) return results;
    for (const node of nodes) {
        for (const key of Object.keys(node)) {
            if (key === ':@' || key === '#text' || key.startsWith('?') || key.startsWith('!')) continue;
            if (key.toLowerCase() === 'content') {
                results.push({ node, tagKey: key, children: node[key], attrs: node[':@'] || {} });
            }
            if (Array.isArray(node[key])) {
                findContentElements(node[key], results);
            }
        }
    }
    return results;
}

/**
 * Extract the concatenated text value from an array of XML child nodes.
 * @param {Array<Object>} children - XML child nodes.
 * @returns {string} Combined text content.
 */
function getTextContent(children) {
    if (!Array.isArray(children)) return '';
    return children.filter(c => '#text' in c).map(c => String(c['#text'])).join('');
}

/**
 * Replace the text content of an XML child array with a new string.
 * @param {Array<Object>} children - XML child nodes.
 * @param {string} text - New text value to insert.
 */
function setTextContent(children, text) {
    if (!Array.isArray(children)) return;
    // Remove existing text nodes
    for (let i = children.length - 1; i >= 0; i--) {
        if ('#text' in children[i]) children.splice(i, 1);
    }
    // Insert new text node at the beginning
    children.unshift({ '#text': text });
}

/* ================================================================
   INTEGRITY VERIFICATION  — 8 checks, same as browser version
   ================================================================ */
/**
 * Compute a structural snapshot of a parsed XML tree for integrity checks.
 * @param {Array<Object>} parsedTree - Parsed XML nodes.
 * @returns {Object} Snapshot with counts, tag names, IDs, attributes and hashes.
 */
function xmlSnapshot(parsedTree) {
    const snap = {
        elementCount: 0, tagNames: [], ids: [], attrs: [],
        contentTexts: [], structHash: '', childCounts: [],
    };

    function walk(nodes, depth) {
        if (!Array.isArray(nodes)) return;
        for (const node of nodes) {
            for (const key of Object.keys(node)) {
                if (key === ':@' || key === '#text' || key.startsWith('?') || key.startsWith('!')) continue;

                snap.elementCount++;
                snap.tagNames.push(key);

                const children = Array.isArray(node[key]) ? node[key] : [];
                const childElCount = children.filter(c =>
                    Object.keys(c).some(k => k !== ':@' && k !== '#text' && !k.startsWith('?') && !k.startsWith('!'))
                ).length;
                snap.childCounts.push(childElCount);

                const attrs = node[':@'] || {};
                for (const [aKey, aVal] of Object.entries(attrs)) {
                    const attrName = aKey.replace(/^@_/, '');
                    snap.attrs.push(`${key}|${attrName}|${aVal}`);
                    if (['id', 'uid', 'contentuid'].includes(attrName.toLowerCase())) {
                        snap.ids.push(String(aVal));
                    }
                }

                if (key.toLowerCase() === 'content') {
                    snap.contentTexts.push(getTextContent(children));
                }

                snap.structHash += `<${key}:${depth}>`;
                walk(children, depth + 1);
                snap.structHash += `</${key}>`;
            }
        }
    }

    walk(parsedTree, 0);
    return snap;
}

/**
 * Compare two XML snapshots and report any structural differences.
 * @param {Object} before - Snapshot before translation.
 * @param {Object} after - Snapshot after translation.
 * @param {string} fileName - Name of the file being verified.
 * @returns {Object} Object with passed flag, checks array and file name.
 */
function verifyIntegrity(before, after, fileName) {
    const checks = [];
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    checks.push({
        name: 'Element Count',
        passed: before.elementCount === after.elementCount,
        detail: before.elementCount === after.elementCount
            ? `${before.elementCount} (OK)`
            : `MISMATCH ${before.elementCount} → ${after.elementCount}`,
    });

    let ok = eq(before.tagNames, after.tagNames);
    checks.push({ name: 'Tag Names & Order', passed: ok,
        detail: ok ? `${before.tagNames.length} tags (OK)` : 'Changed!' });

    const bIds = new Set(before.ids), aIds = new Set(after.ids);
    const miss = [...bIds].filter(x => !aIds.has(x));
    const extra = [...aIds].filter(x => !bIds.has(x));
    ok = miss.length === 0 && extra.length === 0;
    checks.push({ name: 'IDs Preserved', passed: ok,
        detail: ok ? `${bIds.size} IDs (OK)` : `Missing:[${miss.join(',')}] Extra:[${extra.join(',')}]` });

    ok = eq([...before.attrs].sort(), [...after.attrs].sort());
    checks.push({ name: 'Attributes Preserved', passed: ok,
        detail: ok ? `${before.attrs.length} attrs (OK)` : 'Modified!' });

    ok = before.structHash === after.structHash;
    checks.push({ name: 'XML Nesting', passed: ok, detail: ok ? 'OK' : 'Changed!' });

    ok = eq(before.childCounts, after.childCounts);
    checks.push({ name: 'Child Counts', passed: ok, detail: ok ? 'OK' : 'Changed!' });

    ok = before.contentTexts.length === after.contentTexts.length;
    checks.push({ name: 'Content Count', passed: ok,
        detail: ok ? `${before.contentTexts.length} (OK)` : `${before.contentTexts.length} → ${after.contentTexts.length}` });

    let emptied = 0;
    for (let i = 0; i < Math.min(before.contentTexts.length, after.contentTexts.length); i++) {
        if (before.contentTexts[i].trim() && !after.contentTexts[i].trim()) emptied++;
    }
    checks.push({ name: 'No Content Loss', passed: emptied === 0,
        detail: emptied === 0 ? 'OK' : `${emptied} emptied!` });

    return { passed: checks.every(c => c.passed), checks, fileName };
}

/* ================================================================
   TRANSLATE A SINGLE XML STRING
   ================================================================ */
/**
 * Translate a single XML string, preserving structure and integrity.
 * @param {string} xmlText - Source XML content.
 * @param {string} fileName - File name for logging/verification.
 * @param {Object} translator - Translator instance.
 * @param {Object} [globalProgress] - Optional global progress tracker.
 * @returns {Promise<Object>} Translated XML and verification result.
 */
async function translateXmlString(xmlText, fileName, translator, globalProgress) {
    const parser = new XMLParser(xmlParserOpts);
    let parsed = parser.parse(xmlText);

    let beforeSnap = xmlSnapshot(parsed);
    const contentEls = findContentElements(parsed);

    if (contentEls.length === 0) {
        log(`   [SKIP] No <content> elements in ${fileName}`, C.dim);
        return { xmlStr: xmlText, elementsTranslated: 0, verification: verifyIntegrity(beforeSnap, beforeSnap, fileName) };
    }

    // Collect unique text keys and map elements
    const unique = new Map();
    for (const el of contentEls) {
        const text = getTextContent(el.children);
        if (text && text.trim()) {
            const key = text.trim().replace(/\s+/g, ' ');
            if (!unique.has(key)) unique.set(key, []);
            unique.get(key).push(el);
        }
    }

    // Batch translate all unique keys with ETA tracking
    let translated = 0;
    let xmlDone = 0;
    const xmlT0 = performance.now();
    const uniqueKeys = [...unique.keys()];
    const logBuffer = [];
    const flushLogBuffer = () => {
        if (logBuffer.length) { console.log(logBuffer.join('\n')); logBuffer.length = 0; }
    };
    const results = await translator.translateBatch(uniqueKeys, (key, result, fromCache, err, meta) => {
        xmlDone++;
        if (globalProgress) globalProgress.done++;
        const provider = (meta && meta.provider) || (fromCache ? 'cache' : 'api');
        if (err) {
            logBuffer.push(`${C.red}   [ERR]   ${truncate(key)} — ${err.message}${C.reset}`);
        } else if (fromCache) {
            logBuffer.push(`${C.dim}   [CACHE] ${truncate(key)}${C.reset}`);
        } else {
            logBuffer.push(`${C.white}   [OK:${provider}]    ${truncate(key)} → ${truncate(result)}${C.reset}`);
        }
        if (logBuffer.length >= 20) flushLogBuffer();
        // ETA output
        if (globalProgress && (xmlDone % 10 === 0 || xmlDone === uniqueKeys.length)) {
            flushLogBuffer();
            const elapsed = (performance.now() - xmlT0) / 1000;
            const perStr = elapsed / xmlDone;
            const globalPct = globalProgress.total > 0 ? Math.round(globalProgress.done / globalProgress.total * 100) : 0;
            const globalRemain = globalProgress.total > 0 ? Math.max(0, Math.round(perStr * (globalProgress.total - globalProgress.done))) : 0;
            const etaStr = globalRemain >= 60 ? `${Math.floor(globalRemain/60)}m${globalRemain%60}s` : `${globalRemain}s`;
            log(`[ETA:${etaStr}|${globalPct}]`, '');
        }
    });
    flushLogBuffer();

    // Apply translations to the parsed tree
    for (const [key, els] of unique) {
        const tr = results.get(key);
        if (tr && tr !== key) {
            for (const el of els) {
                setTextContent(el.children, tr);
                translated++;
            }
        }
    }

    // Build output XML
    const builder = new XMLBuilder(xmlBuilderOpts);
    let xmlStr = builder.build(parsed);
    parsed = null; // free parsed tree

    // BG3 inline tags are stored as escaped text (&lt;LSTag ...&gt;).
    // Keep plain quotes in escaped LSTag attributes to match vanilla format.
    xmlStr = xmlStr.replace(/&lt;LSTag([\s\S]*?)&gt;/g, (m, attrs) => {
        return `&lt;LSTag${attrs.replace(/&quot;/g, '"')}&gt;`;
    });

    if (!xmlStr.trimStart().startsWith('<?xml')) {
        xmlStr = '<?xml version="1.0" encoding="utf-8"?>\n' + xmlStr;
    }

    // Verify integrity
    let afterParsed = parser.parse(xmlStr);
    let afterSnap = xmlSnapshot(afterParsed);
    const vr = verifyIntegrity(beforeSnap, afterSnap, fileName);
    beforeSnap = null;
    afterParsed = null;
    afterSnap = null;

    for (const c of vr.checks) {
        const icon = c.passed ? '✔' : '✘';
        const color = c.passed ? C.green : C.red;
        log(`   [VERIFY] ${icon} ${c.name}: ${c.detail}`, color);
    }
    log(vr.passed
        ? `   ✔ Integrity OK for ${fileName}`
        : `   ⚠ Integrity ISSUES in ${fileName}`,
        vr.passed ? C.green : C.red);

    return { xmlStr, elementsTranslated: translated, verification: vr };
}

/* ================================================================
   DEBUG HELPERS  — export LOCA entries as readable XML
   ================================================================ */
function escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Convert LOCA entries to BG3-native contentList XML (like the reference).
 * This produces the same format as Localization/French/ModName.xml
 */
/**
 * Convert LOCA entries to a BG3 contentList XML document.
 * @param {Array<{uid:string, version:number, text:string}>} entries - LOCA entries.
 * @returns {string} XML string in contentList format.
 */
function locaToContentXml(entries) {
    const lines = [];
    lines.push(`<?xml version="1.0" encoding="utf-8"?>`);
    lines.push(`<contentList>`);
    for (const e of entries) {
        if (!e.text && !e.uid) continue;
        // BG3 uses &lt; &gt; etc inside content — the text may already contain HTML-like tags
        // We need to escape only XML-invalid chars but preserve the text as-is for BG3
        const safeText = e.text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        lines.push(`    <content contentuid="${e.uid}" version="${e.version}">${safeText}</content>`);
    }
    lines.push(`</contentList>`);
    return lines.join('\n');
}

/**
 * Convert LOCA entries to a readable XML for inspection.
 * Each entry becomes:  <entry uid="..." version="N"><text>...</text></entry>
 */
/**
 * Convert LOCA entries to a readable debug XML document.
 * @param {Array<{uid:string, version:number, text:string}>} entries - LOCA entries.
 * @param {string} sourceName - Source file name.
 * @param {string} label - Label for the debug export.
 * @returns {string} XML string for human inspection.
 */
function locaToXml(entries, sourceName, label) {
    const lines = [];
    lines.push(`<?xml version="1.0" encoding="utf-8"?>`);
    lines.push(`<!-- LOCA Debug Export: ${label} -->`);
    lines.push(`<!-- Source: ${sourceName} -->`);
    lines.push(`<!-- Entries: ${entries.length} -->`);
    lines.push(`<loca count="${entries.length}">`);
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const textBytes = Buffer.byteLength(e.text, 'utf8');
        lines.push(`  <entry index="${i}" uid="${escapeXml(e.uid)}" version="${e.version}" textBytes="${textBytes}">`);
        lines.push(`    <text>${escapeXml(e.text)}</text>`);
        lines.push(`  </entry>`);
    }
    lines.push(`</loca>`);
    return lines.join('\n');
}

/**
 * Create a DIFF XML showing original vs translated side by side.
 * Only entries that changed are included (plus a few unchanged for context).
 */
/**
 * Build a diff XML showing original vs translated LOCA entries.
 * @param {Array<{uid:string, version:number, text:string}>} origEntries - Original LOCA entries.
 * @param {Array<{uid:string, version:number, text:string}>} transEntries - Translated LOCA entries.
 * @param {string} sourceName - Source file name.
 * @returns {string} XML string with changed entries highlighted.
 */
function locaDiffXml(origEntries, transEntries, sourceName) {
    const lines = [];
    lines.push(`<?xml version="1.0" encoding="utf-8"?>`);
    lines.push(`<!-- LOCA Debug DIFF -->`);
    lines.push(`<!-- Source: ${sourceName} -->`);
    lines.push(`<!-- Total entries: ${origEntries.length} -->`);

    let changed = 0, unchanged = 0, uidMismatch = 0;
    for (let i = 0; i < origEntries.length; i++) {
        if (origEntries[i].uid !== transEntries[i]?.uid) uidMismatch++;
        if (origEntries[i].text !== transEntries[i]?.text) changed++;
        else unchanged++;
    }
    lines.push(`<!-- Changed: ${changed} | Unchanged: ${unchanged} | UID mismatches: ${uidMismatch} -->`);
    lines.push(`<diff>`);

    for (let i = 0; i < origEntries.length; i++) {
        const o = origEntries[i];
        const t = transEntries[i];
        if (!t) {
            lines.push(`  <entry index="${i}" status="MISSING_IN_TRANSLATED" uid="${escapeXml(o.uid)}">`);
            lines.push(`    <original>${escapeXml(o.text)}</original>`);
            lines.push(`  </entry>`);
            continue;
        }
        const uidOk = o.uid === t.uid;
        const verOk = o.version === t.version;
        const textChanged = o.text !== t.text;

        if (!uidOk || textChanged) {
            const status = !uidOk ? 'UID_CHANGED' : 'TRANSLATED';
            const origBytes = Buffer.byteLength(o.text, 'utf8');
            const transBytes = Buffer.byteLength(t.text, 'utf8');
            lines.push(`  <entry index="${i}" status="${status}" uid="${escapeXml(o.uid)}"${!uidOk ? ` newUid="${escapeXml(t.uid)}"` : ''} version="${o.version}"${!verOk ? ` newVersion="${t.version}"` : ''} origBytes="${origBytes}" transBytes="${transBytes}">`);
            lines.push(`    <original>${escapeXml(o.text)}</original>`);
            lines.push(`    <translated>${escapeXml(t.text)}</translated>`);
            lines.push(`  </entry>`);
        }
    }

    lines.push(`</diff>`);
    return lines.join('\n');
}

/* ================================================================
   BG3 LANGUAGE FOLDER MAP  — maps language codes to BG3 folder names
   ================================================================ */
const BG3_LANG_FOLDERS = {
    'en': 'English', 'fr': 'French', 'de': 'German', 'es': 'Spanish',
    'it': 'Italian', 'pt': 'PortugueseBrazil', 'pt-BR': 'PortugueseBrazil',
    'ru': 'Russian', 'pl': 'Polish', 'nl': 'Dutch', 'ja': 'Japanese',
    'ko': 'Korean', 'zh-CN': 'ChineseSimplified', 'zh-TW': 'ChineseTraditional',
    'tr': 'Turkish', 'uk': 'Ukrainian', 'cs': 'Czech', 'hu': 'Hungarian',
    'ro': 'Romanian', 'el': 'Greek', 'bg': 'Bulgarian', 'sv': 'Swedish',
    'da': 'Danish', 'fi': 'Finnish', 'no': 'Norwegian', 'ar': 'Arabic',
};

// Known BG3 localization folder names (for detection)
const BG3_KNOWN_LOCA_FOLDERS = new Set([
    'english', 'french', 'german', 'spanish', 'italian',
    'portuguesebrazil', 'brazilianportuguese', 'russian', 'polish',
    'dutch', 'japanese', 'korean', 'chinesesimplified', 'chinesetraditional',
    'turkish', 'ukrainian', 'czech', 'hungarian', 'romanian', 'greek',
    'bulgarian', 'swedish', 'danish', 'finnish', 'norwegian', 'arabic',
]);

/**
 * Remap a Localization path to the target language folder.
 * e.g. "Localization/English/foo.loca" → "Localization/French/foo.loca"
 *      "Localization/BrazilianPortuguese/bar.loca" → "Localization/French/bar.loca"
 */
/**
 * Remap a file path from its original language folder to the target language folder.
 * @param {string} entryName - Original archive entry path.
 * @param {string} tgtLangCode - Target language code (e.g. 'fr').
 * @returns {string} Entry path rewritten for the target language, if known.
 */
function remapLocalizationPath(entryName, tgtLangCode) {
    const tgtFolder = BG3_LANG_FOLDERS[tgtLangCode];
    if (!tgtFolder) return entryName; // unknown language, keep original

    const parts = entryName.split('/');

    // Case 1: Localization/<LangFolder>/rest...
    if (parts.length >= 3 && parts[0].toLowerCase() === 'localization') {
        const folder = parts[1].toLowerCase();
        if (BG3_KNOWN_LOCA_FOLDERS.has(folder)) {
            parts[1] = tgtFolder;
            return parts.join('/');
        }
    }

    // Case 2: .../Localization/<LangFolder>/rest... (e.g. Mods/X/Localization/English/file.xml)
    for (let i = 0; i < parts.length - 2; i++) {
        if (parts[i].toLowerCase() === 'localization' && BG3_KNOWN_LOCA_FOLDERS.has(parts[i + 1].toLowerCase())) {
            parts[i + 1] = tgtFolder;
            return parts.join('/');
        }
    }

    return entryName;
}

/* ================================================================
   HELPERS: meta.lsx generation for translation mods
   ================================================================ */
/**
 * Generate a random UUID v4.
 * @returns {string} A new UUID string.
 */
function generateUUID() {
    return crypto.randomUUID();
}

/**
 * Generate a meta.lsx XML document for a translation mod.
 * @param {string} modName - New translation mod folder/name.
 * @param {string} modUUID - New mod UUID.
 * @param {string} origModFolder - Original mod folder name.
 * @param {string} [version64='36028797018963968'] - Version64 value.
 * @param {string} [origModUUID=null] - Original mod UUID for dependency.
 * @param {string} [origModName=null] - Original mod display name.
 * @param {string} [origVersion64=null] - Original mod version.
 * @returns {string} XML content for meta.lsx.
 */
function generateMetaLsx(modName, modUUID, origModFolder, version64 = '36028797018963968', origModUUID = null, origModName = null, origVersion64 = null) {
    const depsBlock = (origModUUID && origModName) ? `<node id="Dependencies">
          <children>
            <node id="ModuleShortDesc">
              <attribute id="Folder" type="LSString" value="${origModFolder}" />
              <attribute id="MD5" type="LSString" value="" />
              <attribute id="Name" type="FixedString" value="${origModName}" />
              <attribute id="UUID" type="FixedString" value="${origModUUID}" />
              <attribute id="Version64" type="int64" value="${origVersion64 || version64}" />
            </node>
          </children>
        </node>` : `<node id="Dependencies" />`;
    return `<?xml version="1.0" encoding="utf-8"?>
<save>
  <version major="4" minor="0" revision="9" build="331" />
  <region id="Config">
    <node id="root">
      <children>
        ${depsBlock}
        <node id="ModuleInfo">
          <attribute id="Author" type="LSString" value="AutoTranslator" />
          <attribute id="CharacterCreationLevelName" type="FixedString" value="" />
          <attribute id="Description" type="LSString" value="Traduction du mod ${origModFolder}" />
          <attribute id="Folder" type="LSString" value="${modName}" />
          <attribute id="LobbyLevelName" type="FixedString" value="" />
          <attribute id="MD5" type="LSString" value="" />
          <attribute id="MainMenuBackgroundVideo" type="FixedString" value="" />
          <attribute id="MenuLevelName" type="FixedString" value="" />
          <attribute id="Name" type="FixedString" value="${modName}" />
          <attribute id="NumPlayers" type="uint8" value="4" />
          <attribute id="PhotoBooth" type="FixedString" value="" />
          <attribute id="StartupLevelName" type="FixedString" value="" />
          <attribute id="Tags" type="LSString" value="Translation" />
          <attribute id="Type" type="FixedString" value="Add-on" />
          <attribute id="UUID" type="FixedString" value="${modUUID}" />
          <attribute id="Version64" type="int64" value="${version64}" />
          <children>
            <node id="PublishVersion">
              <attribute id="Version64" type="int64" value="${version64}" />
            </node>
            <node id="Scripts" />
            <node id="TargetModes">
              <children>
                <node id="Target">
                  <attribute id="Object" type="FixedString" value="Story" />
                </node>
              </children>
            </node>
          </children>
        </node>
      </children>
    </node>
  </region>
</save>`;
}

/* ================================================================
   TRANSLATE .pak MODE
   ================================================================ */
/**
 * Translate all translatable entries inside a .pak (LSPK) file.
 * @param {string} inputPath - Path to the source .pak file.
 * @param {string} outputPath - Path where the translated .pak will be written.
 * @param {Object} translator - Translator instance.
 * @param {Object|null} debugOpts - Debug export options.
 * @param {string} tgtLangCode - Target language code.
 * @param {boolean} [xmlonly=false] - Convert .loca to .xml in output.
 * @returns {Promise<Object>} Summary with file/element counts, elapsed time and verifications.
 */
async function translatePak(inputPath, outputPath, translator, debugOpts, tgtLangCode, xmlonly = false) {
    log(`\nParsing .pak file...`, C.cyan);
    let lspk = await readLSPK(inputPath);
    const totalEntries = lspk.entries.length;

    // Identify translatable files: .xml and .loca
    const isTranslatable = (name) => {
        const lower = name.toLowerCase();
        return lower.endsWith('.xml') || lower.endsWith('.loca');
    };
    const translatableEntries = lspk.entries.filter(e => isTranslatable(e.name));
    const xmlCount = lspk.entries.filter(e => e.name.toLowerCase().endsWith('.xml')).length;
    const locaCount = lspk.entries.filter(e => e.name.toLowerCase().endsWith('.loca')).length;

    log(`  Found ${totalEntries} entries (${xmlCount} XML, ${locaCount} LOCA, ${totalEntries - xmlCount - locaCount} other)`, C.white);

    // Find original mod name + version from meta.lsx
    let origModName = path.basename(inputPath, '.pak');
    let origModDisplayName = origModName;
    let origModUUID = null;
    let origVersion64 = '36028797018963968'; // default 1.0.0.0
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
            if (nameMatch) { origModName = nameMatch[1]; origModDisplayName = nameMatch[1]; }
            if (uuidMatch) origModUUID = uuidMatch[1];
            if (folderMatch) origModName = folderMatch[1]; // Folder is more reliable
            const versionMatch = txt.match(/id="Version64"[^>]*value="([^"]*)"/) || txt.match(/id="Version"[^>]*value="([^"]*)"/);
            if (versionMatch) origVersion64 = versionMatch[1];
            break;
        }
    }

    // Read ONLY translatable entries
    log(`\nReading translatable entries...`, C.cyan);
    const translatedEntries = [];
    for (const entry of lspk.entries) {
        if (isTranslatable(entry.name)) {
            const data = await readEntryData(lspk.handle, entry);
            translatedEntries.push({
                name: entry.name,
                data,
                archivePart: 0,
                originalFlags: 0, // uncompressed like the reference
                uncompSize: data.length,
                modified: true,
            });
        }
    }
    await closeLSPK(lspk);
    lspk = null; // free pak reader

    // Count total translatable strings across all entries for ETA
    let grandTotalStrings = 0;
    for (const entry of translatedEntries) {
        const lower = entry.name.toLowerCase();
        if (lower.endsWith('.loca')) {
            try { grandTotalStrings += parseLoca(entry.data).filter(e => e.text && e.text.trim()).length; } catch {}
        } else if (lower.endsWith('.xml')) {
            const matches = entry.data.toString('utf8').match(/<content\s/g);
            grandTotalStrings += matches ? matches.length : 0;
        }
    }

    // Translate all translatable entries
    log(`\nTranslating ${translatableEntries.length} files (${xmlCount} XML + ${locaCount} LOCA)...`, C.cyan);
    log(`[TOTAL_STRINGS:${grandTotalStrings}]`, C.dim);
    const t0 = performance.now();
    let ok = 0, totalEl = 0;
    const globalProgress = { done: 0, total: grandTotalStrings };
    const allVerifications = [];

    for (let i = 0; i < translatedEntries.length; i++) {
        const entry = translatedEntries[i];
        const lower = entry.name.toLowerCase();

        if (lower.endsWith('.xml')) {
            // --- XML translation ---
            const n = ++ok;
            log(`\n  [${n}/${translatableEntries.length}] ${C.bold}${entry.name}${C.reset}`, C.yellow);

            try {
                const xmlText = entry.data.toString('utf8');
                const r = await translateXmlString(xmlText, entry.name, translator, globalProgress);
                entry.data = Buffer.from(r.xmlStr, 'utf8');
                totalEl += r.elementsTranslated;
                allVerifications.push(r.verification);

                // Remap XML path under Localization/ to target language
                const newName = remapLocalizationPath(entry.name, tgtLangCode);
                if (newName !== entry.name) {
                    log(`   → Path: ${entry.name} → ${newName}`, C.cyan);
                    entry.name = newName;
                }

                log(`   ✔ ${r.elementsTranslated} elements translated`, C.green);
            } catch (e) {
                log(`   ✘ Error: ${e.message}`, C.red);
            }

        } else if (lower.endsWith('.loca')) {
            // --- LOCA translation ---
            const n = ++ok;
            log(`\n  [${n}/${translatableEntries.length}] ${C.bold}${entry.name}${C.reset} ${C.dim}(LOCA)${C.reset}`, C.yellow);

            try {
                const locaEntries = parseLoca(entry.data);
                const originalData = debugOpts ? Buffer.from(entry.data) : null; // keep copy for debug

                // DEBUG: save originals before translation
                if (debugOpts) {
                    const debugDir = path.join(path.dirname(outputPath), 'debug');
                    const baseName = path.basename(entry.name, '.loca');
                    const exportLoca = debugOpts.toLoca || (!debugOpts.toLoca && !debugOpts.toXml);
                    const exportXml = debugOpts.toXml || (!debugOpts.toLoca && !debugOpts.toXml);

                    if (exportLoca) {
                        const locaDir = path.join(debugDir, 'loca');
                        await fsp.mkdir(locaDir, { recursive: true });
                        await fsp.writeFile(path.join(locaDir, `${baseName}_ORIGINAL.loca`), originalData);
                        log(`   [DEBUG] Saved: debug/loca/${baseName}_ORIGINAL.loca`, C.dim);
                    }
                    if (exportXml) {
                        const xmlDir = path.join(debugDir, 'xml');
                        await fsp.mkdir(xmlDir, { recursive: true });
                        const xmlOrig = locaToXml(locaEntries, entry.name, 'ORIGINAL');
                        await fsp.writeFile(path.join(xmlDir, `${baseName}_ORIGINAL.xml`), xmlOrig, 'utf8');
                        log(`   [DEBUG] Saved: debug/xml/${baseName}_ORIGINAL.xml`, C.dim);
                    }
                }

                // Collect unique keys for batch translation
                const keyMap = new Map();
                for (let li = 0; li < locaEntries.length; li++) {
                    const text = locaEntries[li].text;
                    if (!text || !text.trim()) continue;
                    const key = text.trim().replace(/\s+/g, ' ');
                    if (!keyMap.has(key)) keyMap.set(key, []);
                    keyMap.get(key).push(li);
                }

                const uniqueKeys = [...keyMap.keys()];
                log(`   ${uniqueKeys.length} unique strings (${locaEntries.length} total)`, C.dim);

                // Batch translate with progress + ETA
                let done = 0;
                const fileT0 = performance.now();
                const results = await translator.translateBatch(uniqueKeys, (key, result, fromCache) => {
                    done++;
                    globalProgress.done++;
                    if (done % 10 === 0 || done === uniqueKeys.length) {
                        const pct = Math.round(done / uniqueKeys.length * 100);
                        const elapsed = (performance.now() - fileT0) / 1000;
                        const perStr = elapsed / done;
                        const remaining = Math.max(0, Math.round(perStr * (uniqueKeys.length - done)));
                        const globalPct = globalProgress.total > 0 ? Math.round(globalProgress.done / globalProgress.total * 100) : pct;
                        const globalRemain = globalProgress.total > 0 ? Math.max(0, Math.round(perStr * (globalProgress.total - globalProgress.done))) : remaining;
                        const etaStr = globalRemain >= 60 ? `${Math.floor(globalRemain/60)}m${globalRemain%60}s` : `${globalRemain}s`;
                        process.stdout.write(`\r   ${C.dim}${done}/${uniqueKeys.length} (${pct}%) — ETA: ${etaStr} [${globalPct}% total]${C.reset}  `);
                        log(`[ETA:${etaStr}|${globalPct}]`, '');
                    }
                });
                if (uniqueKeys.length > 0) process.stdout.write('\n');

                // Apply translations
                let locaTranslated = 0;
                for (const [key, indices] of keyMap) {
                    const translated = results.get(key);
                    if (translated && translated !== key) {
                        for (const li of indices) {
                            locaEntries[li].text = translated;
                            locaTranslated++;
                        }
                    }
                }

                entry.data = buildLoca(locaEntries);
                totalEl += locaTranslated;

                // Remap path to target language folder
                const newName = remapLocalizationPath(entry.name, tgtLangCode);
                if (newName !== entry.name) {
                    log(`   → Path: ${entry.name} → ${newName}`, C.cyan);
                    entry.name = newName;
                }

                log(`   ✔ ${locaTranslated}/${locaEntries.length} strings translated`, C.green);

                // DEBUG: save translated versions
                if (debugOpts) {
                    const debugDir = path.join(path.dirname(outputPath), 'debug');
                    const baseName = path.basename(entry.name, '.loca');
                    const exportLoca = debugOpts.toLoca || (!debugOpts.toLoca && !debugOpts.toXml);
                    const exportXml = debugOpts.toXml || (!debugOpts.toLoca && !debugOpts.toXml);

                    if (exportLoca) {
                        const locaDir = path.join(debugDir, 'loca');
                        await fsp.writeFile(path.join(locaDir, `${baseName}_TRANSLATED.loca`), entry.data);
                        log(`   [DEBUG] Saved: debug/loca/${baseName}_TRANSLATED.loca`, C.dim);
                    }
                    if (exportXml) {
                        const xmlDir = path.join(debugDir, 'xml');
                        const xmlTr = locaToXml(locaEntries, entry.name, 'TRANSLATED');
                        await fsp.writeFile(path.join(xmlDir, `${baseName}_TRANSLATED.xml`), xmlTr, 'utf8');
                        log(`   [DEBUG] Saved: debug/xml/${baseName}_TRANSLATED.xml`, C.dim);

                        const origEntries = parseLoca(originalData);
                        const xmlDiff = locaDiffXml(origEntries, locaEntries, entry.name);
                        await fsp.writeFile(path.join(xmlDir, `${baseName}_DIFF.xml`), xmlDiff, 'utf8');
                        log(`   [DEBUG] Saved: debug/xml/${baseName}_DIFF.xml`, C.dim);
                    }
                }
            } catch (e) {
                log(`   ✘ Error: ${e.message}`, C.red);
            }
        }

        // Save cache periodically
        if (ok % 5 === 0) translator.flush();
    }

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    translator.flush();

    // Generate translation mod meta.lsx
    const tgtLangName = BG3_LANG_FOLDERS[tgtLangCode] || tgtLangCode;
    const modName = `${origModName} ${tgtLangName}`;

    // Reuse UUID from existing translation pak if it exists (keeps modsettings.lsx intact)
    let modUUID = null;
    if (fs.existsSync(outputPath)) {
        try {
            const existingLspk = await readLSPK(outputPath);
            for (const e of existingLspk.entries) {
                if (e.name.toLowerCase().endsWith('meta.lsx')) {
                    const d = await readEntryData(existingLspk.handle, e);
                    const fullTxt = d.toString('utf8');
                    const miIdx = fullTxt.indexOf('id="ModuleInfo"');
                    const txt = miIdx >= 0 ? fullTxt.slice(miIdx) : fullTxt;
                    const m = txt.match(/id="UUID"[^>]*value="([^"]*)"/);
                    if (m) modUUID = m[1];
                    break;
                }
            }
            await closeLSPK(existingLspk);
            if (modUUID) log(`\n  Reusing existing UUID: ${modUUID}`, C.dim);
        } catch (_) { /* ignore read errors */ }
    }
    if (!modUUID) modUUID = generateUUID();

    const metaLsx = generateMetaLsx(modName, modUUID, origModName, origVersion64, origModUUID, origModDisplayName, origVersion64);
    log(`\n  Generated meta.lsx for mod: "${modName}"`, C.dim);
    log(`  UUID: ${modUUID}`, C.dim);
    log(`  Version: ${origVersion64}`, C.dim);

    // Build final entries: translated files + meta.lsx
    const finalEntries = [];
    const finalEntryNames = new Set();

    function pushFinalEntry(name, data) {
        if (finalEntryNames.has(name)) return;
        finalEntryNames.add(name);
        finalEntries.push({
            name,
            data,
            archivePart: 0,
            originalFlags: 0,
            uncompSize: data.length,
            modified: true,
        });
    }

    // Helper: push XML entry AND a language-named variant (french.xml alongside english.xml)
    const tgtLangFileName = tgtLangName.toLowerCase() + '.xml';
    function pushXmlEntry(xmlPath, data) {
        pushFinalEntry(xmlPath, data);
        if (/english\.xml$/i.test(xmlPath) && tgtLangFileName !== 'english.xml') {
            pushFinalEntry(xmlPath.replace(/english\.xml$/i, tgtLangFileName), data);
        }
    }

    // Add translated files (uncompressed, like reference)
    // BG3 engine needs .loca files in Localization/<Lang>/ folders.
    // Script Extender reads .xml contentList files.
    // Like working reference mods (e.g. Community Library FR), we include BOTH formats.
    for (const entry of translatedEntries) {
        if (entry.name.toLowerCase().endsWith('.loca')) {
            // Always include the .loca binary (BG3 engine needs this)
            pushFinalEntry(entry.name, entry.data);
            log(`  [LOCA] ${entry.name} (${(entry.data.length / 1024).toFixed(1)} KB)`, C.cyan);

            // Mirror under translated mod folder for module-path-sensitive lookups.
            if (entry.name.includes('/Localization/')) {
                const modulePathPrefix = `Mods/${origModName}/`;
                if (entry.name.startsWith(modulePathPrefix)) {
                    const translatedModulePath = `Mods/${modName}/` + entry.name.slice(modulePathPrefix.length);
                    pushFinalEntry(translatedModulePath, entry.data);
                    log(`  [LOCA] ${translatedModulePath} (module mirror)`, C.dim);
                }
            }

            // Also include .xml contentList version (for Script Extender compatibility)
            const locaEntries = parseLoca(entry.data);
            const xmlContent = locaToContentXml(locaEntries);
            const xmlBuf = Buffer.from(xmlContent, 'utf8');
            const xmlName = entry.name.replace(/\.loca$/i, '.xml');
            log(`  [XML]  ${xmlName} (${locaEntries.length} entries, ${(xmlBuf.length / 1024).toFixed(1)} KB)`, C.cyan);
            pushXmlEntry(xmlName, xmlBuf);

            if (xmlName.includes('/Localization/')) {
                const modulePathPrefix = `Mods/${origModName}/`;
                if (xmlName.startsWith(modulePathPrefix)) {
                    const translatedModuleXmlPath = `Mods/${modName}/` + xmlName.slice(modulePathPrefix.length);
                    pushXmlEntry(translatedModuleXmlPath, xmlBuf);
                    log(`  [XML]  ${translatedModuleXmlPath} (module mirror)`, C.dim);
                }
            }
        } else {
            pushXmlEntry(entry.name, entry.data);

            if (entry.name.includes('/Localization/')) {
                const modulePathPrefix = `Mods/${origModName}/`;
                if (entry.name.startsWith(modulePathPrefix)) {
                    const translatedModulePath = `Mods/${modName}/` + entry.name.slice(modulePathPrefix.length);
                    pushXmlEntry(translatedModulePath, entry.data);
                    log(`  [XML]  ${translatedModulePath} (module mirror)`, C.dim);
                }
            }
        }
    }

    // Add meta.lsx
    const metaBuf = Buffer.from(metaLsx, 'utf8');
    pushFinalEntry(`Mods/${modName}/meta.lsx`, metaBuf);

    // Rebuild minimal .pak
    log(`\nRebuilding minimal .pak (${finalEntries.length} files)...`, C.magenta);
    for (const e of finalEntries) {
        log(`  → ${e.name} (${(e.data.length / 1024).toFixed(1)} KB)`, C.dim);
    }

    // Backup existing output before overwriting
    if (fs.existsSync(outputPath)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupPath = outputPath.replace(/\.pak$/i, `.bak.${ts}.pak`);
        try {
            fs.copyFileSync(outputPath, backupPath);
            log(`  Backup: ${path.basename(backupPath)}`, C.dim);
        } catch (e) {
            log(`  ⚠ Backup failed: ${e.message}`, C.yellow);
        }
    }

    await writeLSPK(outputPath, {
        flags: 0,
        priority: 0,
        md5: Buffer.alloc(16, 0),
        numParts: 1,
    }, finalEntries);

    const outSize = fs.statSync(outputPath).size;
    const sizeStr = outSize > 1024 * 1024
        ? `${(outSize / 1024 / 1024).toFixed(2)} MB`
        : `${(outSize / 1024).toFixed(1)} KB`;
    log(`  Output: ${path.basename(outputPath)} (${sizeStr})`, C.green);

    // Vérifier automatiquement le .pak généré
    try {
        const vr = await verifyPak(outputPath, { silent: true });
        if (!vr.ok) {
            log(`\n  ⚠ Vérification du .pak généré: ${vr.corrupt} problème(s) détecté(s)`, C.yellow);
            for (const c of vr.checks) {
                if (!c.ok) log(`    ✘ ${c.name}: ${c.detail}`, C.red);
            }
        } else {
            log(`  ✔ .pak vérifié: ${vr.total} entrée(s), aucun problème`, C.green);
        }
    } catch (e) {
        log(`  ⚠ Impossible de vérifier le .pak: ${e.message}`, C.yellow);
    }

    // Statistiques de traduction
    const stats = translator && translator.stats ? translator.stats : {};
    log(`\n  Statistiques:`, C.cyan);
    log(`    Total traduit: ${ok}/${translatableEntries.length} fichiers, ${totalEl} éléments`, C.dim);
    if (stats.hits != null) log(`    Cache: ${stats.hits} hit(s), ${stats.misses} miss, ${stats.errors} erreur(s)`, C.dim);
    if (stats.apiCalls > 0) log(`    Appels API: ${stats.apiCalls} total (DeepL ${stats.deeplCalls}, Libre ${stats.libreCalls}, Gemini ${stats.geminiCalls}, LMStudio ${stats.lmstudioCalls})`, C.dim);
    if (stats.glossaryApplied) log(`    Glossaire: ${stats.glossaryApplied} application(s)`, C.dim);

    return { ok, total: translatableEntries.length, totalEl, elapsed, allVerifications, stats };
}

/* ================================================================
   TRANSLATE XML FOLDER MODE
   ================================================================ */
/**
 * Translate all .xml files found recursively under a directory.
 * @param {string} inputDir - Root input directory.
 * @param {string} outputDir - Root output directory.
 * @param {Object} translator - Translator instance.
 * @returns {Promise<Object>} Summary with file/element counts and verifications.
 */
async function translateFolder(inputDir, outputDir, translator) {
    // Find all .xml files
    const files = [];
    const scan = async (dir) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await scan(full);
            else if (e.name.toLowerCase().endsWith('.xml')) files.push(full);
        }
    };
    await scan(inputDir);

    if (files.length === 0) {
        log('No XML files found in the folder.', C.red);
        return { ok: 0, total: 0, totalEl: 0, elapsed: '0', allVerifications: [] };
    }

    log(`\nFound ${files.length} XML file(s)`, C.cyan);
    await fsp.mkdir(outputDir, { recursive: true });

    const t0 = performance.now();
    let ok = 0, totalEl = 0;
    const allVerifications = [];

    for (let i = 0; i < files.length; i++) {
        const filePath = files[i];
        const relPath = path.relative(inputDir, filePath);
        log(`\n  [${i + 1}/${files.length}] ${C.bold}${relPath}${C.reset}`, C.yellow);

        try {
            const xmlText = await fsp.readFile(filePath, 'utf8');
            const r = await translateXmlString(xmlText, relPath, translator);
            const outFile = path.join(outputDir, relPath);
            await fsp.mkdir(path.dirname(outFile), { recursive: true });
            await fsp.writeFile(outFile, r.xmlStr, 'utf8');
            totalEl += r.elementsTranslated;
            allVerifications.push(r.verification);
            ok++;
            log(`   ✔ ${r.elementsTranslated} elements → ${relPath}`, C.green);
        } catch (e) {
            log(`   ✘ Error: ${e.message}`, C.red);
        }

        if (ok % 5 === 0) translator.flush();
    }

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    translator.flush();

    return { ok, total: files.length, totalEl, elapsed, allVerifications };
}

/* ================================================================
   CLI
   ================================================================ */
function truncate(t, m = 50) {
    if (!t) return '[Empty]';
    return t.length > m ? t.slice(0, m) + '...' : t;
}

function printHelp() {
    console.log(`
${C.bold}BG3 .pak / XML Mass Translator${C.reset}

${C.cyan}Usage:${C.reset}
  node main.js <input> [options]

${C.cyan}Arguments:${C.reset}
  <input>          Path to a .pak file or XML folder

${C.cyan}Options:${C.reset}
  --from, -f       Source language (default: auto)
  --to, -t         Target language (default: French)
  --output, -o     Output path (default: auto-generated)
  --cache          Cache file path (default: data/cache.json)
  --concurrency    Parallel API requests (default: 3)
  --delay          Delay between batches in ms (default: 120)
  --debug          Debug mode: exports LOCA/XML files for inspection
  --ToLoca         (with --debug) Export original + translated .loca files
  --ToXml          (with --debug) Export .loca entries as readable .xml files
  --xmlonly        Convert .loca to .xml in output pak (test mode)
  --list           List supported languages
  --help, -h       Show this help

${C.cyan}Examples:${C.reset}
  node main.js my_mod.pak --to fr
  node main.js my_mod.pak --from en --to "Chinese (Simplified)"
  node main.js my_mod.pak --debug --ToLoca --ToXml --to fr
  node main.js ./xml_folder --to es --output ./translated
  node main.js --list
`);
}

function printLanguages() {
    log(`\n${C.bold}Supported Languages:${C.reset}\n`, '');
    const entries = Object.entries(LANGUAGES).filter(([n]) => n !== 'Auto Detect');
    const col1 = entries.slice(0, Math.ceil(entries.length / 2));
    const col2 = entries.slice(Math.ceil(entries.length / 2));
    for (let i = 0; i < col1.length; i++) {
        const left = col1[i] ? `  ${col1[i][0].padEnd(22)} (${col1[i][1]})` : '';
        const right = col2[i] ? `  ${col2[i][0].padEnd(22)} (${col2[i][1]})` : '';
        console.log(`${left.padEnd(40)}${right}`);
    }
    console.log();
}

/**
 * Parse command-line arguments and options.
 * @returns {Object} Parsed CLI options.
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        input: null, from: 'auto', to: 'fr', output: null,
        cache: path.join('data', 'bg3', 'cache.json'), concurrency: 3, delay: 120,
        help: false, list: false,
        debug: false, toLoca: false, toXml: false, xmlonly: false,
    };

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--help' || a === '-h') { opts.help = true; continue; }
        if (a === '--list') { opts.list = true; continue; }
        if (a === '--debug') { opts.debug = true; continue; }
        if (a.toLowerCase() === '--toloca') { opts.toLoca = true; continue; }
        if (a.toLowerCase() === '--toxml') { opts.toXml = true; continue; }
        if (a.toLowerCase() === '--xmlonly') { opts.xmlonly = true; continue; }
        if ((a === '--from' || a === '-f') && args[i + 1]) { opts.from = args[++i]; continue; }
        if ((a === '--to' || a === '-t') && args[i + 1]) { opts.to = args[++i]; continue; }
        if ((a === '--output' || a === '-o') && args[i + 1]) { opts.output = args[++i]; continue; }
        if (a === '--cache' && args[i + 1]) { opts.cache = args[++i]; continue; }
        if (a === '--concurrency' && args[i + 1]) { opts.concurrency = parseInt(args[++i], 10) || 3; continue; }
        if (a === '--delay' && args[i + 1]) { opts.delay = parseInt(args[++i], 10) || 120; continue; }
        if (!a.startsWith('-') && !opts.input) { opts.input = a; continue; }
    }

    return opts;
}

/**
 * Print a formatted translation summary to the console.
 * @param {Object} result - Translation result summary.
 * @param {string} srcName - Source language name.
 * @param {string} tgtName - Target language name.
 * @param {Object} stats - Translator statistics.
 */
function printSummary(result, srcName, tgtName, stats) {
    log(`\n${'═'.repeat(55)}`, C.cyan);
    log(`  ${C.bold}TRANSLATION COMPLETED!${C.reset}`, C.green);
    log(`${'═'.repeat(55)}`, C.cyan);
    log(`  Files:      ${result.ok}/${result.total}`, C.white);
    log(`  Elements:   ${result.totalEl}`, C.white);
    log(`  Time:       ${result.elapsed}s`, C.white);
    log(`  Direction:  ${srcName} → ${tgtName}`, C.white);
    log(`  API calls:  ${stats.apiCalls}${stats.deeplCalls ? ` (DeepL: ${stats.deeplCalls})` : ''}`, C.white);
    log(`  Cache:      ${stats.hits} hits, ${stats.misses} new translations`, C.white);
    if (stats.glossaryApplied > 0) {
        log(`  Glossary:   ${stats.glossaryApplied} corrections applied`, C.white);
    }
    log(`  Errors:     ${stats.errors}${stats.deeplErrors ? ` (DeepL: ${stats.deeplErrors})` : ''}`, stats.errors > 0 ? C.red : C.white);

    // Verification summary
    const allV = result.allVerifications;
    if (allV.length > 0) {
        const allPassed = allV.every(v => v.passed);
        const failed = allV.filter(v => !v.passed);
        log(`\n  ${C.bold}Integrity Verification:${C.reset}`, '');
        if (allPassed) {
            log(`  ✔ ALL ${allV.length} FILES PASSED integrity checks`, C.green);
        } else {
            log(`  ✘ ${failed.length} file(s) with issues:`, C.red);
            for (const v of failed) {
                log(`    ${v.fileName}:`, C.red);
                for (const c of v.checks.filter(c => !c.passed)) {
                    log(`      ✘ ${c.name}: ${c.detail}`, C.red);
                }
            }
        }
        // Per-check summary
        const checkNames = allV[0]?.checks.map(c => c.name) || [];
        log(`\n  ${C.bold}Per-check results:${C.reset}`, '');
        for (const name of checkNames) {
            const passed = allV.filter(v => v.checks.find(c => c.name === name)?.passed).length;
            const icon = passed === allV.length ? '✔' : '✘';
            const color = passed === allV.length ? C.green : C.red;
            log(`    ${icon} ${name}: ${passed}/${allV.length}`, color);
        }
    }
    log(`${'═'.repeat(55)}\n`, C.cyan);
}

/* ================================================================
   MAIN
   ================================================================ */
/**
 * Main entry point: parse CLI, create translator and run the requested mode.
 * @returns {Promise<void>}
 */
async function main() {
    const opts = parseArgs();

    if (opts.help) { printHelp(); return; }
    if (opts.list) { printLanguages(); return; }
    if (!opts.input) {
        log('Error: No input specified. Use --help for usage.', C.red);
        process.exit(1);
    }

    // Resolve languages
    const srcLang = resolveLang(opts.from) || { name: 'Auto Detect', code: 'auto' };
    const tgtLang = resolveLang(opts.to);
    if (!tgtLang) {
        log(`Error: Unknown target language "${opts.to}". Use --list to see supported languages.`, C.red);
        process.exit(1);
    }

    // Detect mode
    const inputPath = path.resolve(opts.input);
    const inputStat = await fsp.stat(inputPath).catch(() => null);
    if (!inputStat) {
        log(`Error: Input not found: ${inputPath}`, C.red);
        process.exit(1);
    }

    const isPak = inputStat.isFile() && inputPath.toLowerCase().endsWith('.pak');
    const isFolder = inputStat.isDirectory();

    if (!isPak && !isFolder) {
        log('Error: Input must be a .pak file or a directory containing XML files.', C.red);
        process.exit(1);
    }

    // Auto-generate output path
    let outputPath = opts.output;
    if (!outputPath) {
        if (isPak) {
            outputPath = inputPath.replace(/\.pak$/i, `_${tgtLang.code}.pak`);
        } else {
            outputPath = inputPath + `_${tgtLang.code}`;
        }
    }
    outputPath = path.resolve(outputPath);

    // Banner
    log(`\n${C.bold}BG3 .pak / XML Translator${C.reset}`, C.cyan);
    log(`${'─'.repeat(40)}`, C.dim);
    log(`  Mode:     ${isPak ? '.pak file' : 'XML folder'}`, C.white);
    log(`  Input:    ${path.basename(inputPath)}`, C.white);
    log(`  Output:   ${path.basename(outputPath)}`, C.white);
    log(`  From:     ${srcLang.name} (${srcLang.code})`, C.white);
    log(`  To:       ${tgtLang.name} (${tgtLang.code})`, C.white);
    log(`  Cache:    ${opts.cache}`, C.white);
    log(`  Queue:    ${opts.concurrency} concurrent, ${opts.delay}ms delay`, C.white);
    if (opts.debug) {
        const debugModes = [];
        if (opts.toLoca) debugModes.push('ToLoca');
        if (opts.toXml) debugModes.push('ToXml');
        if (debugModes.length === 0) debugModes.push('ToLoca', 'ToXml'); // default: both
        log(`  Debug:    ${debugModes.join(' + ')}`, C.yellow);
    }
    log(`${'─'.repeat(40)}`, C.dim);

    // Create translator
    const translator = createTranslator({
        srcLang: srcLang.code,
        tgtLang: tgtLang.code,
        cachePath: path.resolve(opts.cache),
        concurrency: opts.concurrency,
        delayMs: opts.delay,
        maxRetries: 3,
        retryBaseMs: 500,
        logger: (msg) => log(`  ${msg}`, C.dim),
    });

    const cacheCount = translator.cache.totalCount();
    if (cacheCount > 0) {
        log(`  Cache loaded: ${cacheCount} entries`, C.dim);
    }

    // Run
    let result;
    const debugOpts = opts.debug ? { debug: true, toLoca: opts.toLoca, toXml: opts.toXml } : null;
    const xmlonly = opts.xmlonly || false;
    try {
        if (isPak) {
            result = await translatePak(inputPath, outputPath, translator, debugOpts, tgtLang.code, xmlonly);
        } else {
            result = await translateFolder(inputPath, outputPath, translator);
        }
    } catch (e) {
        log(`\nFatal error: ${e.message}`, C.red);
        translator.flush();
        process.exit(1);
    }

    // Summary
    printSummary(result, srcLang.name, tgtLang.name, translator.stats);
    log(`Cache saved: ${translator.cache.totalCount()} total entries`, C.dim);
}

main().catch(e => {
    console.error(`\nUnhandled error: ${e.message}`);
    process.exit(1);
});
