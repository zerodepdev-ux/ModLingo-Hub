'use strict';

const fs = require('fs');
const path = require('path');
const { readLSPK, readEntryData, closeLSPK, parseLoca } = require('./lspk');
const { XMLParser } = require('fast-xml-parser');

const C = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

function makeLoggers(silent) {
    return {
        log: (msg, color = '') => { if (!silent) console.log(`${color}${msg}${C.reset}`); },
        error: (msg) => { if (!silent) console.error(`${C.red}[ERREUR] ${msg}${C.reset}`); },
        warn: (msg) => { if (!silent) console.warn(`${C.yellow}[WARN] ${msg}${C.reset}`); },
    };
}

function formatSummary(checks) {
    const allOk = checks.every(c => c.ok);
    let out = '\n' + '═'.repeat(55) + '\n';
    for (const c of checks) {
        const icon = c.ok ? '✔' : '✘';
        out += `  ${icon} ${c.name}: ${c.detail}\n`;
    }
    out += '═'.repeat(55) + '\n';
    out += allOk ? '  PAK VALIDE\n' : '  PAK INVALIDE / RISQUÉ\n';
    return out;
}

async function verifyPak(filePath, opts = {}) {
    const { silent = false } = opts;
    const { log, error, warn } = makeLoggers(silent);
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) {
        error(`Fichier non trouvé: ${abs}`);
        return { ok: false, filePath, error: 'Fichier non trouvé' };
    }

    const stats = fs.statSync(abs);
    log(`\nVérification de ${path.basename(abs)}`, C.cyan);
    log(`  Taille: ${(stats.size / 1024 / 1024).toFixed(2)} MB`, C.dim);

    const checks = [];
    let lspk = null;

    // 1) Ouvrir le .pak
    try {
        lspk = await readLSPK(abs);
        checks.push({ name: 'Ouverture LSPK', ok: true, detail: `${lspk.entries.length} entrée(s)` });
    } catch (e) {
        checks.push({ name: 'Ouverture LSPK', ok: false, detail: e.message });
        if (lspk) { try { await closeLSPK(lspk); } catch {} }
        return { ok: false, filePath, checks, error: e.message };
    }

    const total = lspk.entries.length;
    let readable = 0;
    let corrupt = 0;
    let xmlCount = 0;
    let locaCount = 0;
    let metaFound = false;
    let hasDependencies = false;
    const xmlParser = new XMLParser({
        preserveOrder: true,
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        textNodeName: '#text',
        parseTagValue: false,
    });

    for (let i = 0; i < total; i++) {
        const entry = lspk.entries[i];
        const lower = entry.name.toLowerCase();
        if (lower.endsWith('meta.lsx')) metaFound = true;
        if (lower.includes('dependencies')) hasDependencies = true;

        try {
            const data = await readEntryData(lspk.handle, entry);
            readable++;

            if (lower.endsWith('.loca')) {
                locaCount++;
                try {
                    const entries = parseLoca(data);
                    if (!entries.length) {
                        warn(`LOCA vide: ${entry.name}`);
                    }
                } catch (locaErr) {
                    corrupt++;
                    checks.push({ name: `LOCA ${entry.name}`, ok: false, detail: locaErr.message });
                }
            } else if (lower.endsWith('.xml')) {
                xmlCount++;
                try {
                    const text = data.toString('utf8');
                    if (text.length > 0 && !text.includes('<')) {
                        throw new Error('Contenu non XML');
                    }
                    xmlParser.parse(text);
                } catch (xmlErr) {
                    corrupt++;
                    checks.push({ name: `XML ${entry.name}`, ok: false, detail: xmlErr.message });
                }
            }
        } catch (readErr) {
            corrupt++;
            checks.push({ name: `Lecture ${entry.name}`, ok: false, detail: readErr.message });
        }
    }

    await closeLSPK(lspk);

    checks.push({ name: 'Entrées lisibles', ok: readable === total, detail: `${readable}/${total}` });
    if (locaCount) checks.push({ name: 'Fichiers LOCA', ok: true, detail: `${locaCount} fichier(s)` });
    if (xmlCount) checks.push({ name: 'Fichiers XML', ok: true, detail: `${xmlCount} fichier(s)` });
    checks.push({ name: 'meta.lsx présent', ok: metaFound, detail: metaFound ? 'OK' : 'Manquant' });
    if (hasDependencies) checks.push({ name: 'Dependencies', ok: true, detail: 'Présent' });

    if (!metaFound) {
        checks.push({ name: 'Compatibilité Mod Manager', ok: false, detail: 'meta.lsx manquant — le mod manager refusera probablement le .pak' });
    } else {
        checks.push({ name: 'Compatibilité Mod Manager', ok: corrupt === 0, detail: corrupt === 0 ? 'Aucun fichier corrompu' : `${corrupt} fichier(s) corrompu(s)` });
    }

    const allOk = checks.every(c => c.ok);
    if (!silent) {
        console.log(formatSummary(checks));
    }

    return {
        ok: allOk,
        filePath,
        checks,
        readable,
        total,
        corrupt,
        locaCount,
        xmlCount,
        metaFound,
        hasDependencies,
        stats,
    };
}

function printHelp() {
    console.log(`
Vérificateur de .pak pour BG3 / Divinity: Original Sin 2

Usage:
  node verify-pak.js <chemin_vers_fichier.pak>

Vérifie:
  - Signature et ouverture du .pak
  - Chaque entrée peut être lue
  - Les .loca sont parsables
  - Les .xml sont valides
  - meta.lsx est présent
  - Aucun fichier corrompu
`);
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h') || args.length === 0) {
        printHelp();
        process.exit(0);
    }
    const result = await verifyPak(args[0], { silent: false });
    process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
    main().catch(e => {
        console.error(`${C.red}[ERREUR] ${e.message}${C.reset}`);
        process.exit(1);
    });
}

module.exports = { verifyPak, formatSummary };
