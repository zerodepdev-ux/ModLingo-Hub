#!/usr/bin/env node
'use strict';
// Assemble le dossier portable ModLingo-Hub-live/ (appelé par build.sh / build.ps1, qui s'occupent d'abord de Node).
//   ModLingo-Hub-live/  lanceurs + livemod.js + Livemod_inteface.js + locales/
//     Dependence/Tradution/  le code de traduction (copié du projet) + express & adm-zip + server-lite.js
//     Dependence/node/       Node portable (mis en place par le script appelant)
//     config/                réglages de ModLingo-Hub-live
// Usage : node build.js [--out <dossier>] [--with-cache]
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const HERE = __dirname, REPO = path.resolve(HERE, '..', '..');
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const OUT = path.resolve(arg('--out') || path.join(HERE, 'dist', 'ModLingo-Hub-live'));
const TRAD = path.join(OUT, 'Dependence', 'Tradution');
const ENTRIES = ['modules/minecraft.js', 'modules/config.js', 'modules/pak.js', 'modules/translate.js', 'main.js', 'translator.js'];   // server-lite + main.js (lancé par la traduction BG3)
const NPM = ['express'];                                                           // + ce que les entrées requièrent (adm-zip…)
const log = (s) => console.log('  ' + s);

function copy(src, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.cpSync(src, dst, { recursive: true }); }
function copyIfMissing(src, dst) { if (fs.existsSync(dst) || !fs.existsSync(src)) return false; copy(src, dst); return true; }

// Fichiers du projet nécessaires, trouvés en suivant les require() depuis les entrées.
function projectClosure() {
    const files = new Set(), pkgs = new Set();
    for (const e of ENTRIES) (function walk(f) {
        if (files.has(f)) return;
        files.add(f);
        for (const m of fs.readFileSync(f, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
            const r = m[1];
            if (r.startsWith('.')) {
                const t = path.resolve(path.dirname(f), r);
                const hit = [t, t + '.js', path.join(t, 'index.js')].find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
                if (!hit) throw new Error(`require introuvable : ${r} (dans ${path.relative(REPO, f)})`);
                walk(hit);
            } else if (!builtinModules.includes(r.replace(/^node:/, ''))) pkgs.add(r.startsWith('@') ? r.split('/').slice(0, 2).join('/') : r.split('/')[0]);
        }
    })(path.join(REPO, e));
    return { files: [...files], pkgs: [...pkgs] };
}
// Paquet npm + toutes ses dépendances (depuis le node_modules du projet : mêmes versions que l'app).
function npmClosure(names) {
    const seen = new Set();
    function add(n) {
        if (seen.has(n)) return;
        const dir = path.join(REPO, 'node_modules', n);
        if (!fs.existsSync(dir)) throw new Error(`paquet manquant dans le projet : ${n} (npm install)`);
        seen.add(n);
        const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        for (const d of Object.keys(pj.dependencies || {})) add(d);
    }
    for (const n of names) add(n);
    return seen;
}

function main() {
    console.log(`Assemblage dans ${OUT}`);
    fs.mkdirSync(OUT, { recursive: true });

    // 1. ModLingo-Hub-live lui-même
    for (const f of ['livemod.js', 'Livemod_inteface.js', 'node-update.js', 'paths.js', 'version.js', 'LiveMod.sh', 'LiveMod.cmd', 'README.md']) copy(path.join(HERE, f), path.join(OUT, f));
    fs.rmSync(path.join(OUT, 'locales'), { recursive: true, force: true });
    copy(path.join(HERE, 'locales'), path.join(OUT, 'locales'));
    try { fs.chmodSync(path.join(OUT, 'LiveMod.sh'), 0o755); } catch { /* windows */ }
    log('ModLingo-Hub-live : lanceurs, interface, langues');

    // 2. Dependence/Tradution : code (remplacé à chaque build) ; data/ (conservé : caches, clés, réglages)
    const { files, pkgs } = projectClosure();
    for (const sub of ['modules', 'node_modules']) fs.rmSync(path.join(TRAD, sub), { recursive: true, force: true });
    for (const f of files) copy(f, path.join(TRAD, path.relative(REPO, f)));
    copy(path.join(HERE, 'tradution', 'server-lite.js'), path.join(TRAD, 'server-lite.js'));
    log(`Tradution : ${files.length} fichiers du projet (${files.map((f) => path.basename(f)).join(', ')})`);

    const need = new Set();
    for (const n of [...NPM, ...pkgs]) for (const x of npmClosure([n])) need.add(x);
    for (const n of need) copy(path.join(REPO, 'node_modules', n), path.join(TRAD, 'node_modules', n));
    log(`Paquets npm : ${need.size} (${[...NPM, ...pkgs].join(', ')} + dépendances)`);

    const data = (rel) => ({ src: path.join(REPO, 'data', rel), dst: path.join(TRAD, 'data', rel) });
    const added = [];
    for (const rel of ['minecraft/glossary.json', 'minecraft/tag.json', 'Save_Autre/ExSave.env', 'version.json']) { const d = data(rel); if (copyIfMissing(d.src, d.dst)) added.push(rel); }
    if (process.argv.includes('--with-cache') && copyIfMissing(data('minecraft/cache.json').src, data('minecraft/cache.json').dst)) added.push('minecraft/cache.json');
    const apicle = path.join(TRAD, 'data', 'APIcle.json');
    if (!fs.existsSync(apicle)) { fs.mkdirSync(path.dirname(apicle), { recursive: true }); fs.writeFileSync(apicle, '{}\n', { mode: 0o600 }); added.push('APIcle.json (vide)'); }
    fs.writeFileSync(path.join(TRAD, 'package.json'), JSON.stringify({ name: 'livemod-tradution', private: true, version: (JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'version.json'), 'utf8')).version) }, null, 2) + '\n');
    log(`data/ conservé tel quel ; ajouté : ${added.join(', ') || 'rien (déjà présent)'}`);

    // 3. config/
    fs.mkdirSync(path.join(OUT, 'config'), { recursive: true });
    fs.mkdirSync(path.join(OUT, 'Dependence'), { recursive: true });
    log('config/ prêt');
    console.log('Terminé.');
}
main();
