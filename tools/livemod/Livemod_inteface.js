#!/usr/bin/env node
'use strict';
// Livemod_inteface — ModLingo-Hub en mode texte (sans dépendance), sans dépendance.
//   Mode « nomcp » (base) : on pilote les traductions directement  →  trad minecraft scan
//   Mode « mcp »          : on voit ce que les clients MCP ont demandé et on gère le serveur MCP
// Usage : node Livemod_inteface.js            (interactif)
//         minecraft scan  →  trouve le modpack, demande quoi traduire (tout / mods / FTB Quests / KubeJS / BetterQuesting)
//         node Livemod_inteface.js trad minecraft scan

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const readline = require('readline');
const { spawn, spawnSync, execFile } = require('child_process');

const { ROOT, STATE, SERVER_SCRIPT } = require('./paths');
const nodeUpdate = require('./node-update');
const VERSION = require('./version');
const SELF_STATE = path.join(STATE, 'interface.json');
const HOME = process.env.LIVEMOD_HOME || os.homedir();

// ── langues ─────────────────────────────────────────────────────────────────
// Le français est la langue d'origine (aucun fichier). Une autre langue = locales/<code>.json
// avec "_name" et, pour chaque texte français, sa traduction. Un texte absent reste en français.
const LOCALES_DIR = path.join(__dirname, 'locales');
let LANG = 'fr', DICT = {};
function availableLocales() {
    const list = [{ code: 'fr', name: 'Français' }];
    try {
        for (const f of fs.readdirSync(LOCALES_DIR).filter((x) => x.endsWith('.json'))) {
            try { const d = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, f), 'utf8')); if (d._name) list.push({ code: f.slice(0, -5), name: d._name }); } catch { /* fichier invalide */ }
        }
    } catch { /* pas de dossier */ }
    return list;
}
function setLang(code) {
    LANG = 'fr'; DICT = {};
    if (!code || code === 'fr' || !/^[a-z]{2,3}(-[A-Za-z]+)?$/.test(code)) return LANG;
    try { DICT = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8')); LANG = code; } catch { /* langue absente : français */ }
    return LANG;
}
const T = (fr, ...a) => String(DICT[fr] || fr).replace(/\{(\d+)\}/g, (_, i) => a[i]);

// Langues que BG3 sait afficher (miroir de BG3_LANG_FOLDERS dans modules/shared.js ; un test vérifie qu'elles restent identiques).
const BG3_LANGS = ['en', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'pl', 'nl', 'ja', 'ko', 'zh-CN', 'zh-TW', 'tr', 'uk', 'cs'];
function langName(code) {
    for (const loc of [LANG, 'en']) { try { const n = new Intl.DisplayNames([loc], { type: 'language' }).of(code); if (n && n !== code) return n; } catch { /* locale inconnue */ } }
    return code;
}
// « de », « DE », « allemand » ou « german » → 'de' ; sinon null.
function parseLang(input) {
    const v = String(input || '').trim().toLowerCase();
    if (!v) return null;
    return BG3_LANGS.find((c) => c.toLowerCase() === v || langName(c).toLowerCase() === v || (() => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(c).toLowerCase() === v; } catch { return false; } })()) || null;
}

// ── affichage ───────────────────────────────────────────────────────────────
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c(1), dim = c(2), red = c(31), green = c(32), yellow = c(33), cyan = c(36);
const out = (s = '') => process.stdout.write(s + '\n');
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });

// ── entrée : file de lignes (marche aussi quand l'entrée est un pipe) ───────
// Dans un vrai terminal : flèche haut/bas = historique (mémorisé entre les sessions), Tab = complétion.
const HISTORY_FILE = path.join(STATE, 'history');
const HISTORY_MAX = 200;
let rl = null; const queue = []; let waiter = null; let eof = false; let completing = false;
const loadHistory = () => { try { return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-HISTORY_MAX).reverse(); } catch { return []; } };
function remember(line) {
    const l = line.trim(); if (!l || /^(exit|quit)$/.test(l)) return;
    const all = loadHistory().reverse().filter((x) => x !== l); all.push(l);
    try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(HISTORY_FILE, all.slice(-HISTORY_MAX).join('\n') + '\n', { mode: 0o600 }); } catch { /* historique facultatif */ }
}
function completer(line) {
    if (!completing) return [[], line];
    const words = line.split(/\s+/), cur = words.pop(), done = words;
    let options = [];
    if (!done.length) options = ['trad', ...Object.keys(GAMES), 'help', 'lang', 'clr', 'clear', 'version', 'setup', 'mcp', 'nomcp', 'exit'];
    else if (GAMES[done[0]] && done.length === 1) options = Object.keys(GAMES[done[0]].actions);
    else if (done[0] === 'trad' && done.length === 1) options = [...Object.keys(GAMES), ...OTHER_GAMES];
    else if (done[0] === 'trad' && done.length === 2 && GAMES[done[1]]) options = Object.keys(GAMES[done[1]].actions);
    else if (done[0] === 'help' && done.length === 1) options = ['trad'];
    else if (done[0] === 'lang' && done.length === 1) options = BG3_LANGS;
    return [options.filter((o) => o.startsWith(cur)), cur];
}
function openInput() {
    eof = false;
    const terminal = !!(process.stdin.isTTY && process.stdout.isTTY);
    rl = readline.createInterface({ input: process.stdin, output: terminal ? process.stdout : undefined, terminal, history: terminal ? loadHistory() : undefined, historySize: HISTORY_MAX, completer });
    rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
    rl.on('close', () => { eof = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
}
// main=true : invite principale (historique + complétion). Les réponses aux questions n'entrent pas dans l'historique.
let notice = '';   // message à afficher avant la prochaine invite (mise à jour de Node)
class BackToMenu extends Error {}
// « clr » / « clear » / « cls » tapé à n'importe quelle question : on abandonne le parcours et on revient au menu.
async function ask(prompt, main = false, secret = false) {
    const l = await rawAsk(prompt, main, secret);
    if (l !== null && !main && !secret && /^(clr|clear|cls)$/i.test(l.trim())) throw new BackToMenu();
    return l;
}
function rawAsk(prompt, main = false, secret = false) {
    completing = main;
    if (main && notice) { out(dim(notice)); notice = ''; }
    if (rl.terminal) { rl.setPrompt(prompt); rl.prompt(); } else process.stdout.write(prompt);
    // Saisie masquée : rien n'est affiché pendant la frappe (clés API).
    const realWrite = rl.terminal && secret ? rl._writeToOutput : null;
    if (realWrite) rl._writeToOutput = () => {};
    const finish = (l) => {
        if (realWrite) { rl._writeToOutput = realWrite; process.stdout.write('\n'); }
        if (l !== null && rl.terminal && !main && rl.history) rl.history.shift();
        if (l !== null && main) remember(l);
        return l;
    };
    if (queue.length) { const l = queue.shift(); if (!rl.terminal) out(secret ? '' : l); return Promise.resolve(finish(l)); }
    if (eof) return Promise.resolve(null);
    return new Promise((resolve) => { waiter = (l) => resolve(finish(l)); });
}
async function confirm(q, def = true) {
    const a = await ask(`${q} ${dim(def ? '[O/n]' : '[o/N]')} `);
    if (a === null || !a.trim()) return def;
    return /^(o|oui|y|yes)$/i.test(a.trim());
}

// ── état mémorisé ───────────────────────────────────────────────────────────
const loadSelf = () => { try { return JSON.parse(fs.readFileSync(SELF_STATE, 'utf8')); } catch { return {}; } };
function saveSelf(v) { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(SELF_STATE, JSON.stringify(v, null, 2) + '\n'); }
const session = { pack: null, startedServer: null };

// ── lecture de .jar sans dépendance (central directory + inflate) ───────────
function readZipIndex(fd, size) {
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen); fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('zip invalide');
    const total = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xffffffff || total === 0xffff) throw new Error('zip64 non géré');
    const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
    const map = new Map(); let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
        const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), comLen = cd.readUInt16LE(p + 32);
        map.set(cd.toString('utf8', p + 46, p + 46 + nameLen), { method: cd.readUInt16LE(p + 10), csize: cd.readUInt32LE(p + 20), lho: cd.readUInt32LE(p + 42) });
        p += 46 + nameLen + extraLen + comLen;
    }
    return map;
}
function readZipEntry(fd, e) {
    const h = Buffer.alloc(30); fs.readSync(fd, h, 0, 30, e.lho);
    const start = e.lho + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
    const raw = Buffer.alloc(e.csize); fs.readSync(fd, raw, 0, e.csize, start);
    return e.method === 0 ? raw : zlib.inflateRawSync(raw);
}
function countKeys(buf, isLang) {
    const txt = buf.toString('utf8').replace(/^﻿/, '');
    if (isLang) return txt.split(/\r?\n/).filter((l) => /^[^#=\s][^=]*=/.test(l)).length;
    try { return Object.keys(JSON.parse(txt)).length; } catch { return 0; }
}
// Un jar → [{ id, en, fr, missing }] pour chaque namespace qui a une langue anglaise.
function scanJar(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const idx = readZipIndex(fd, fs.fstatSync(fd).size);
        const mods = new Map();
        for (const name of idx.keys()) {
            const m = name.match(/^assets\/([^/]+)\/lang\/(en_us)\.(json|lang)$/i);
            if (!m) continue;
            const id = m[1];
            const en = countKeys(readZipEntry(fd, idx.get(name)), m[3] === 'lang');
            const frName = [`assets/${id}/lang/fr_fr.json`, `assets/${id}/lang/fr_FR.lang`, `assets/${id}/lang/fr_fr.lang`].find((n) => idx.has(n));
            const fr = frName ? countKeys(readZipEntry(fd, idx.get(frName)), !frName.endsWith('.json')) : 0;
            mods.set(id, { id, jar: path.basename(file), en, fr, missing: Math.max(0, en - fr) });
        }
        return [...mods.values()];
    } finally { fs.closeSync(fd); }
}

// ── détection des lanceurs Minecraft ────────────────────────────────────────
function launcherCandidates() {
    const h = (...p) => path.join(HOME, ...p);
    const list = [
        ['Prism Launcher', h('.local/share/PrismLauncher/instances')],
        ['Prism Launcher (flatpak)', h('.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher/instances')],
        ['MultiMC', h('.local/share/multimc/instances')],
        ['MultiMC (flatpak)', h('.var/app/org.multimc.MultiMC5/data/multimc/instances')],
        ['ATLauncher', h('ATLauncher/instances')],
        ['ATLauncher (flatpak)', h('.var/app/com.atlauncher.ATLauncher/data/instances')],
        ['Modrinth App', h('.local/share/ModrinthApp/profiles')],
        ['Modrinth App (flatpak)', h('.var/app/com.modrinth.ModrinthApp/data/ModrinthApp/profiles')],
        ['CurseForge', h('curseforge/minecraft/Instances')],
        ['CurseForge', h('Documents/curseforge/minecraft/Instances')],
        ['GDLauncher', h('.local/share/gdlauncher_carbon/data/instances')],
        ['Minecraft officiel', h('.minecraft'), 'single'],
        ['Minecraft officiel (flatpak)', h('.var/app/com.mojang.Minecraft/.minecraft'), 'single'],
    ];
    if (process.platform === 'win32') {
        const ap = process.env.APPDATA || h('AppData/Roaming'), up = process.env.USERPROFILE || HOME;
        list.push(['Prism Launcher', path.join(ap, 'PrismLauncher', 'instances')], ['CurseForge', path.join(up, 'curseforge', 'minecraft', 'Instances')],
            ['Modrinth App', path.join(ap, 'ModrinthApp', 'profiles')], ['Minecraft officiel', path.join(ap, '.minecraft'), 'single']);
    }
    for (const p of loadSelf().mcPaths || []) list.push(['Chemin mémorisé', p]);
    return list.map(([launcher, dir, kind]) => ({ launcher, dir, kind: kind || 'instances' }));
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
function mcRoot(dir) { for (const s of ['minecraft', '.minecraft']) if (isDir(path.join(dir, s))) return path.join(dir, s); return dir; }
function packFromDir(dir, launcher) {
    const root = mcRoot(dir), modsDir = path.join(root, 'mods');
    if (!isDir(modsDir)) return null;
    const jars = fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar'));
    if (!jars.length) return null;
    return { name: path.basename(dir), launcher, dir, root, modsDir, modCount: jars.length, flatpak: dir.includes(`${path.sep}.var${path.sep}app${path.sep}`) };
}
function packsInDir(candidate) {
    if (!isDir(candidate.dir)) return [];
    if (candidate.kind === 'single') { const p = packFromDir(candidate.dir, candidate.launcher); return p ? [p] : []; }
    const direct = packFromDir(candidate.dir, candidate.launcher); // le chemin est lui-même un modpack
    if (direct) return [direct];
    let entries = []; try { entries = fs.readdirSync(candidate.dir, { withFileTypes: true }); } catch { /* illisible */ }
    return entries.filter((e) => e.isDirectory()).map((e) => packFromDir(path.join(candidate.dir, e.name), candidate.launcher)).filter(Boolean);
}
function findPacks() {
    const seen = new Set(), packs = [];
    for (const cand of launcherCandidates()) for (const p of packsInDir(cand)) { if (!seen.has(p.dir)) { seen.add(p.dir); packs.push(p); } }
    return packs;
}
const flatpakApps = () => new Promise((resolve) => {
    execFile('flatpak', ['list', '--app', '--columns=application'], { timeout: 4000 }, (e, o) => resolve(e ? [] : o.split('\n').map((s) => s.trim()).filter((s) => /prism|multimc|atlauncher|modrinth|minecraft|curseforge|gdlauncher/i.test(s))));
});

// ── scan d'un modpack ───────────────────────────────────────────────────────
function scanPack(pack) {
    const mods = [], unreadable = [];
    for (const jar of fs.readdirSync(pack.modsDir).filter((f) => f.endsWith('.jar'))) {
        try { mods.push(...scanJar(path.join(pack.modsDir, jar))); } catch (e) { unreadable.push(`${jar}: ${e.message}`); }
    }
    const rpDir = path.join(pack.root, 'resourcepacks');
    const packs = isDir(rpDir) ? fs.readdirSync(rpDir).filter((f) => /^FR_Traduction.*\.zip$/i.test(f)) : [];
    const need = mods.filter((m) => m.missing > 0).sort((a, b) => b.missing - a.missing);
    return { jars: pack.modCount, withLang: mods.length, complete: mods.length - need.length, need, missing: need.reduce((s, m) => s + m.missing, 0), unreadable, resourcePacks: packs };
}
function printScan(pack, r, src = {}) {
    out(`\n${bold(pack.name)} ${dim(`— ${pack.launcher}${pack.flatpak ? ' · flatpak' : ''}`)}`);
    out(`  ${dim(pack.root)}`);
    out(`  ${T('{0} mods (.jar), {1} avec fichiers de langue,', r.jars, r.withLang)} ${green(T('{0} déjà en français', r.complete))}, ${r.need.length ? yellow(T('{0} à traduire', r.need.length)) : T('rien à traduire')} ${T('({0} chaînes)', r.missing)}`);
    if (r.resourcePacks.length) out(`  ${T('Resource pack FR déjà présent :')} ${r.resourcePacks.join(', ')}`);
    if (r.unreadable.length) out(`  ${red(T('{0} jar illisible(s) ignoré(s)', r.unreadable.length))}`);
    r.need.slice(0, 8).forEach((m) => out(`   · ${m.id.padEnd(28)} ${String(m.missing).padStart(6)} ${T('chaînes')} ${dim(m.jar)}`));
    if (r.need.length > 8) out(dim(`   ${T('… et {0} autres mods', r.need.length - 8)}`));
    if (src.ftb) out(`  FTB Quests    : ${src.ftb.detail}${src.ftb.hasFr ? ' · ' + T('fr_fr déjà présent') : ''}`);
    if (src.kubejs) out(`  KubeJS        : ${src.kubejs.detail}`);
    if (src.bq) out(`  BetterQuesting: ${src.bq.detail}`);
}

// ── sélection du modpack (cœur de « trad minecraft scan ») ──────────────────
async function pickFrom(packs) {
    out(`\n${bold(T('{0} modpack(s) trouvé(s)', packs.length))} :`);
    packs.forEach((p, i) => out(`  ${String(i + 1).padStart(2)}. ${p.name.padEnd(34)} ${String(p.modCount).padStart(4)} mods  ${dim(p.launcher)}`));
    for (;;) {
        const a = await ask(`\n${T('Quel modpack ?')} ${dim(T('(numéro, nom, ou « p » pour saisir un chemin, « q » pour annuler)'))} `);
        if (a === null || /^q/i.test(a.trim())) return null;
        if (/^p$/i.test(a.trim())) return askPath();
        const t = a.trim(), n = parseInt(t, 10);
        const hit = (n >= 1 && n <= packs.length && String(n) === t) ? packs[n - 1] : packs.find((p) => p.name.toLowerCase() === t.toLowerCase()) || packs.filter((p) => p.name.toLowerCase().includes(t.toLowerCase())).length === 1 && packs.find((p) => p.name.toLowerCase().includes(t.toLowerCase()));
        if (hit) return hit;
        out(red(T('Choix invalide.')));
    }
}
async function askPath() {
    const apps = await flatpakApps();
    if (apps.length) {
        out(`\n${T('Lanceurs flatpak détectés :')} ${apps.join(', ')}`);
        out(dim('  ' + T('Leurs données sont dans ~/.var/app/<application>/data/… — si l\'app est un flatpak, elle doit avoir accès à ce dossier')));
        out(dim('  (flatpak override --user --filesystem=<dossier> com.translator.app).'));
    }
    for (;;) {
        const a = await ask(`\n${T('Chemin du dossier d\'instances (ou d\'un modpack)')} ${dim(T('(« q » pour annuler)'))} : `);
        if (a === null || /^q/i.test(a.trim())) return null;
        let p = a.trim().replace(/^["']|["']$/g, '').replace(/^~(?=$|[\\/])/, HOME);
        if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(p)) { out(red(T('Chemin Windows : inutilisable depuis Linux.'))); continue; }
        p = path.resolve(p);
        if (!isDir(p)) { out(red(`${T('Introuvable :')} ${p}`)); continue; }
        const packs = packsInDir({ launcher: 'Chemin manuel', dir: p, kind: 'instances' });
        if (!packs.length) { out(red(T('Aucun modpack (dossier avec mods/*.jar) trouvé ici ni dans ses sous-dossiers.'))); continue; }
        const self = loadSelf(); self.mcPaths = [...new Set([...(self.mcPaths || []), p])]; saveSelf(self);
        out(green(`${T('Chemin mémorisé :')} ${p}`));
        return packs.length === 1 ? packs[0] : pickFrom(packs);
    }
}
async function selectPack() {
    out(dim(T('Recherche des lanceurs Minecraft…')));
    const packs = findPacks();
    if (!packs.length) {
        out(yellow(T('Aucun modpack trouvé automatiquement (Prism, MultiMC, ATLauncher, Modrinth, CurseForge, GDLauncher, .minecraft — natif et flatpak).')));
        return askPath();
    }
    return pickFrom(packs);
}

// ── client du serveur de traduction (l'app) ─────────────────────────────────
function request(base, method, p, body, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const u = new URL(p, base); const data = body ? JSON.stringify(body) : null;
        const r = http.request(u, { method, timeout, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
            let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /* pas du JSON */ } resolve({ status: res.statusCode, json: j }); });
        });
        r.on('error', reject).on('timeout', () => r.destroy(new Error('timeout')));
        r.end(data);
    });
}
function sse(base, p, body, onEvent) {
    return new Promise((resolve, reject) => {
        const u = new URL(p, base); const data = JSON.stringify(body);
        const r = http.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
            if (res.statusCode !== 200) { let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => reject(new Error(`HTTP ${res.statusCode} ${d.slice(0, 200)}`))); return; }
            let buf = '';
            res.on('data', (chunk) => {
                buf += chunk; let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, i); buf = buf.slice(i + 2);
                    const ev = (block.match(/^event: (.*)$/m) || [])[1]; const dt = (block.match(/^data: (.*)$/m) || [])[1];
                    if (ev && dt) { try { onEvent(ev, JSON.parse(dt)); } catch { /* ligne illisible */ } }
                }
            });
            res.on('end', resolve); res.on('error', reject);
        });
        r.on('error', reject); r.end(data);
    });
}
async function findServer() {
    const ports = [process.env.TRANSLATOR_PORT, 3000, 3949, 3951].filter(Boolean);
    const bases = process.env.LIVEMOD_APP_URL ? [process.env.LIVEMOD_APP_URL] : ports.map((p) => `http://127.0.0.1:${p}`);
    for (const b of bases) { try { const r = await request(b, 'GET', '/api/config'); if (r.status === 200 && r.json) return b; } catch { /* pas ici */ } }
    return null;
}
async function ensureServer() {
    const found = await findServer();
    if (found) { out(dim(`${T('Serveur de traduction trouvé :')} ${found}`)); return found; }
    if (!await confirm(T('Le serveur de traduction n\'est pas lancé. Le démarrer (arrêté à la sortie) ?'))) return null;
    const port = 3951, log = fs.openSync(path.join(fs.mkdirSync(STATE, { recursive: true }) || STATE, 'server.log'), 'a');
    const child = spawn(process.execPath, [SERVER_SCRIPT], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', log, log] });
    session.startedServer = child;
    const base = `http://127.0.0.1:${port}`;
    process.stdout.write(T('Démarrage'));
    for (let i = 0; i < 90; i++) {
        if (child.exitCode !== null) { out(red(`\n${T('Le serveur s\'est arrêté (voir {0})', path.join(STATE, 'server.log'))}`)); session.startedServer = null; return null; }
        try { const r = await request(base, 'GET', '/api/config'); if (r.status === 200) { out(green(' ' + T('prêt.'))); return base; } } catch { /* pas encore */ }
        process.stdout.write('.'); await new Promise((r) => setTimeout(r, 1000));
    }
    out(red('\n' + T('Délai dépassé.'))); child.kill(); session.startedServer = null; return null;
}
const stopServer = () => { if (session.startedServer) { session.startedServer.kill(); session.startedServer = null; } };

// ── sources non-mods du modpack (FTB Quests, KubeJS, BetterQuesting) ────────
function scanSources(pack) {
    const root = pack.root, src = {};
    const quests = path.join(root, 'config', 'ftbquests', 'quests');
    if (isDir(quests)) {
        const lang = path.join(quests, 'lang'), chapters = path.join(quests, 'chapters');
        if (isDir(lang)) {
            const names = fs.readdirSync(lang), json5 = isDir(path.join(lang, 'en_us'));
            if (json5 || names.includes('en_us.snbt')) src.ftb = { mode: 'lang', format: json5 ? 'json5' : 'snbt', hasFr: names.includes('fr_fr') || names.includes('fr_fr.snbt'), detail: `${T('fichier de langue')} (${json5 ? 'json5' : 'snbt'})` };
        } else if (isDir(chapters)) {
            const files = fs.readdirSync(chapters).filter((f) => /\.(snbt|json5)$/.test(f));
            if (files.length) src.ftb = { mode: 'chapters', format: files.some((f) => f.endsWith('.json5')) ? 'json5' : 'snbt', hasFr: false, chaptersDir: chapters, detail: `${T('{0} chapitres', files.length)} (${files.some((f) => f.endsWith('.json5')) ? 'json5' : 'snbt'})` };
        }
    }
    const assets = path.join(root, 'kubejs', 'assets');
    if (isDir(assets)) {
        let files = 0, strings = 0, fr = 0;
        for (const mod of fs.readdirSync(assets)) {
            const en = path.join(assets, mod, 'lang', 'en_us.json');
            if (!fs.existsSync(en)) continue;
            files++; strings += countKeys(fs.readFileSync(en), false);
            if (fs.existsSync(path.join(assets, mod, 'lang', 'fr_fr.json'))) fr++;
        }
        if (files) src.kubejs = { files, strings, fr, detail: `${T('{0} fichier(s)', files)} · ${T('{0} chaînes', strings)}${fr ? ` · ${T('{0} déjà en français', fr)}` : ''}` };
    }
    if (fs.existsSync(path.join(root, 'config', 'betterquesting', 'DefaultQuests.json'))) src.bq = { detail: 'DefaultQuests.json' };
    return src;
}
const SOURCE_LABEL = { mods: 'Mods (langues des .jar)', ftb: 'FTB Quests', kubejs: 'KubeJS', bq: 'BetterQuesting' };
const ALIASES = { tout: 'all', all: 'all', mods: 'mods', mod: 'mods', ftb: 'ftb', ftbquest: 'ftb', ftbquests: 'ftb', quetes: 'ftb', kubejs: 'kubejs', kube: 'kubejs', bq: 'bq', betterquesting: 'bq', choisir: 'pick', pick: 'pick' };

// ── « Que traduire ? » ──────────────────────────────────────────────────────
function parseMods(txt, need) {
    const set = new Set();
    for (const part of txt.split(/[,\s]+/).filter(Boolean)) {
        const m = part.match(/^(\d+)(?:-(\d+))?$/);
        if (m) { const a = +m[1], b = m[2] ? +m[2] : a; if (a < 1 || b > need.length || a > b) return null; for (let i = a; i <= b; i++) set.add(i - 1); }
        else { const i = need.findIndex((x) => x.id.toLowerCase() === part.toLowerCase()); if (i < 0) return null; set.add(i); }
    }
    return [...set].map((i) => need[i]);
}
async function pickMods(need) {
    out(`\n${bold(T('Mods à traduire'))} ${dim(T('(du plus au moins de chaînes)'))}`);
    need.slice(0, 80).forEach((m, i) => out(`  ${String(i + 1).padStart(3)}. ${m.id.padEnd(28)} ${String(m.missing).padStart(6)} ${T('chaînes')} ${dim(m.jar)}`));
    if (need.length > 80) out(dim(`  ${T('… {0} autres : tape leur identifiant', need.length - 80)}`));
    for (;;) {
        const a = await ask(`\n${T('Lesquels ?')} ${dim(T('(« 1,3,5-8 » ou identifiants, « q » annule)'))} `);
        if (a === null || /^q/i.test(a.trim())) return null;
        const sel = parseMods(a.trim(), need); if (sel && sel.length) return sel;
        out(red(T('Sélection invalide.')));
    }
}
// Renvoie { mods: [...], ftb, kubejs, bq } ou null (annulé).
async function chooseWhat(r, src, flags) {
    const avail = [];
    if (r.need.length) avail.push({ key: 'mods', detail: `${T('{0} mods', r.need.length)} · ${T('{0} chaînes', r.missing)}` });
    if (src.ftb) avail.push({ key: 'ftb', detail: src.ftb.detail + (src.ftb.hasFr ? ' · ' + T('fr_fr déjà présent') : '') });
    if (src.kubejs) avail.push({ key: 'kubejs', detail: src.kubejs.detail });
    if (src.bq) avail.push({ key: 'bq', detail: src.bq.detail });
    if (!avail.length) { out(green('\n' + T('Rien à traduire dans ce modpack.'))); return null; }
    const keys = avail.map((a) => a.key);
    const result = (set, mods) => ({ mods: set.has('mods') ? (mods || r.need) : [], ftb: set.has('ftb'), kubejs: set.has('kubejs'), bq: set.has('bq') });

    const only = flags.only && flags.only.split(',').map((x) => ALIASES[x.trim().toLowerCase()]).filter(Boolean);
    if (only && only.length) return result(new Set(only.includes('all') ? keys : only.filter((k) => keys.includes(k))));
    if (flags.yes) return result(new Set(keys));

    const items = [{ n: 1, key: 'all', label: T('Tout'), detail: T('{0} source(s)', avail.length) }];
    avail.forEach((a, i) => items.push({ n: i + 2, key: a.key, label: T(SOURCE_LABEL[a.key]), detail: a.detail }));
    if (r.need.length) items.push({ n: items.length + 1, key: 'pick', label: T('Choisir des mods un par un'), detail: '' });
    out(`\n${bold(T('Étape 3/3 — Que traduire ?'))}`);
    items.forEach((it) => out(`  ${String(it.n).padStart(2)}. ${it.label.padEnd(30)} ${dim(it.detail)}`));
    for (;;) {
        const a = await ask(`\n${T('Ton choix ?')} ${dim(T('(numéros « 2,4 » ou noms « ftbquest, kubejs » · Entrée = tout · « q » annule)'))} `);
        if (a === null || /^q/i.test(a.trim())) return null;
        const set = new Set(); let bad = false, pick = false;
        for (const tok of (a.trim() ? a.trim().split(/[,\s]+/) : ['all'])) {
            const it = /^\d+$/.test(tok) ? items.find((x) => x.n === +tok) : { key: ALIASES[tok.toLowerCase()] };
            if (!it || !it.key) { bad = true; break; }
            if (it.key === 'pick') pick = true; else if (it.key === 'all') keys.forEach((k) => set.add(k)); else if (keys.includes(it.key)) set.add(it.key); else { bad = true; break; }
        }
        if (bad || (!set.size && !pick)) { out(red(T('Choix invalide.'))); continue; }
        if (pick) { const mods = await pickMods(r.need); if (!mods) return null; set.add('mods'); return result(set, mods); }
        return result(set);
    }
}

// ── traduction : un runner par source ───────────────────────────────────────
async function runSse(base, p, body) {
    let done = null, failed = null, lastStep = -1;
    const clear = () => process.stdout.write('\r' + ' '.repeat(78) + '\r');
    await sse(base, p, body, (ev, d) => {
        if (ev === 'progress') {
            const pct = d.total ? Math.floor((d.current / d.total) * 100) : 0;
            if (tty) {
                const fill = Math.round(pct / 5);
                process.stdout.write(`\r  [${cyan('█'.repeat(fill))}${dim('░'.repeat(20 - fill))}] ${String(pct).padStart(3)}%  ${d.current}/${d.total}  ${dim((d.text || '').slice(0, 30).padEnd(30))}`);
            } else if (Math.floor(pct / 25) !== lastStep) { lastStep = Math.floor(pct / 25); out(`  … ${pct}% (${d.current}/${d.total})`); }
        } else if (ev === 'log' && !/^\[TOTAL_STRINGS/.test(d.text)) { if (tty) clear(); out(dim('  ' + d.text.trim())); }
        else if (ev === 'done') done = d; else if (ev === 'error') failed = d.message;
    });
    if (tty) clear();
    if (failed || !done) throw new Error(failed || T('flux interrompu'));
    return done;
}
const must = (r, what) => { if (r.status !== 200 || !r.json || r.json.error) throw new Error(`${what} : ${(r.json && r.json.error) || 'HTTP ' + r.status}`); return r.json; };
const lang = () => 'fr';   // Minecraft : le serveur écrit toujours un resource pack fr_fr

async function doMods(base, pack, instance, mods, flags) {
    out(bold(`\n▶ Mods — ${T('{0} mod(s)', mods.length)}, ${T('{0} chaînes', mods.reduce((s, m) => s + m.missing, 0))}`));
    const done = await runSse(base, '/api/minecraft/mods-translate', { instance, modIds: mods.map((m) => m.id), lang: lang(flags) });
    out(green(T('Traduit : {0} nouvelles, {1} depuis le cache, {2} mod(s)', done.translated, done.cached, done.modCount)));
    const rp = await request(base, 'POST', '/api/minecraft/mods-resourcepack', { instance, modOutputs: done.modOutputs, patchouliOutputs: done.patchouliOutputs, legacyMods: done.legacyMods });
    const j = must(rp, T('Resource pack non créé'));
    out(green(`Resource pack : ${j.path}`) + (j.activated ? dim('  ' + T('(activé dans options.txt)')) : dim('  ' + T('(à activer dans Minecraft : Options → Packs de ressources)'))));
}
async function doFtb(base, pack, instance, flags) {
    const imp = must(await request(base, 'GET', `/api/minecraft/ftbquest-import?instance=${encodeURIComponent(instance)}`), 'Import FTB Quests');
    out(bold(`\n▶ FTB Quests — ${T('{0} chaînes', imp.translatableCount)} (${imp.mode}, ${imp.format})`));
    let body;
    if (imp.mode === 'chapters') body = { chapters: imp.chapters, mode: 'chapters', format: imp.format, lang: lang(flags), instance };
    else if (imp.format === 'json5') body = { fileContents: imp.fileContents, format: 'json5', lang: lang(flags), instance };
    else body = { content: imp.content, lang: lang(flags), instance };
    const done = await runSse(base, '/api/minecraft/ftbquest-translate', body);
    let save;
    if (done.mode === 'chapters') {
        // Les chapitres sont réécrits sur place : copie de sécurité d'abord.
        const dir = path.join(pack.root, 'config', 'ftbquests', 'quests', 'chapters');
        const bak = path.join(pack.root, 'livemod-backup', `ftbquests-chapters-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        fs.mkdirSync(path.dirname(bak), { recursive: true }); fs.cpSync(dir, bak, { recursive: true });
        out(dim(`${T('Sauvegarde des chapitres :')} ${bak}`));
        save = { instance, chapters: done.chapters, mode: 'chapters', format: done.format };
    } else if (done.format === 'json5') save = { instance, fileContents: done.fileContents, format: 'json5', locale: 'fr_fr', mode: 'lang' };
    else save = { instance, snbt: done.snbt, locale: 'fr_fr', mode: 'lang' };
    must(await request(base, 'POST', '/api/minecraft/ftbquest-save', save), 'Enregistrement FTB Quests');
    out(green(`FTB Quests : ${T('{0} nouvelles, {1} depuis le cache', done.translated, done.cached)} — ${T('enregistré')}`));
}
async function doKubejs(base, pack, instance, flags) {
    const imp = must(await request(base, 'GET', `/api/minecraft/kubejs-import?instance=${encodeURIComponent(instance)}`), 'Import KubeJS');
    out(bold(`\n▶ KubeJS — ${T('{0} chaînes', imp.translatableCount)} (${T('{0} fichier(s)', imp.mods.length)})`));
    const done = await runSse(base, '/api/minecraft/kubejs-translate', { entries: imp.entries, lang: lang(flags), instance });
    const saved = must(await request(base, 'POST', '/api/minecraft/kubejs-save', { instance, modOutputs: done.modOutputs, locale: 'fr_fr' }), 'Enregistrement KubeJS');
    out(green(`KubeJS : ${T('{0} nouvelles, {1} depuis le cache', done.translated, done.cached)} — ${T('{0} fichier(s)', saved.saved.length)} fr_fr.json`));
}
async function doBq(base, pack, instance, flags) {
    const imp = must(await request(base, 'GET', `/api/minecraft/bq-import?instance=${encodeURIComponent(instance)}`), 'Import BetterQuesting');
    out(bold(`\n▶ BetterQuesting — ${T('{0} chaînes', imp.translatableCount)} (${T('{0} quêtes', imp.questCount)})`));
    const done = await runSse(base, '/api/minecraft/bq-translate', { instance, lang: lang(flags) });
    const saved = must(await request(base, 'POST', '/api/minecraft/bq-save', { instance, content: done.content }), 'Enregistrement BetterQuesting');
    out(green(`BetterQuesting : ${T('{0} nouvelles, {1} depuis le cache', done.translated, done.cached)} — ${T('sauvegarde')} ${path.basename(saved.backup || '')}`));
}

// ── parcours guidé : scan → que traduire → traduction ───────────────────────
async function guided(pack, flags) {
    if (flags.target !== 'fr') out(yellow(T('Minecraft : traduction vers le français uniquement pour l\'instant (langue cible {0} ignorée).', langName(flags.target))));
    out(bold('\n' + T('Étape 2/3 — Analyse du modpack')));
    const r = scanPack(pack), src = scanSources(pack);
    printScan(pack, r, src);
    const sel = await chooseWhat(r, src, flags);
    if (!sel) { out(T('Annulé.')); return; }
    const parts = [];
    if (sel.mods.length) parts.push(`${T('{0} mod(s)', sel.mods.length)} (${T('{0} chaînes', sel.mods.reduce((s, m) => s + m.missing, 0))})`);
    if (sel.ftb) parts.push('FTB Quests'); if (sel.kubejs) parts.push('KubeJS'); if (sel.bq) parts.push('BetterQuesting');
    out(`\n${bold(T('À traduire'))} : ${parts.join(' · ')}  → ${T('français')}`);
    if (!flags.yes && !await confirm(T('Lancer la traduction ? (utilise le moteur configuré dans l\'app)'))) { out(T('Annulé.')); return; }

    const base = await ensureServer(); if (!base) { out(T('Pas de serveur : traduction impossible.')); return; }
    const instancesDir = path.dirname(pack.dir), instance = path.basename(pack.dir);
    await withAppConfig(base, 'minecraftInstancesFolder', instancesDir, flags, async () => {
        const started = Date.now(), failures = [];
        const steps = [[sel.mods.length > 0, 'Mods', () => doMods(base, pack, instance, sel.mods, flags)], [sel.ftb, 'FTB Quests', () => doFtb(base, pack, instance, flags)],
            [sel.kubejs, 'KubeJS', () => doKubejs(base, pack, instance, flags)], [sel.bq, 'BetterQuesting', () => doBq(base, pack, instance, flags)]];
        for (const [on, name, fn] of steps) {
            if (!on) continue;
            try { await fn(); } catch (e) { failures.push(name); out(red(`✗ ${name} : ${e.message}`)); }
        }
        out(`\n${failures.length ? yellow(T('Terminé avec des échecs :') + ' ' + failures.join(', ')) : green(T('Terminé'))} ${T('en {0}s.', Math.round((Date.now() - started) / 1000))}`);
    });
}

// L'app doit pointer sur le bon dossier le temps de la traduction ; on demande, puis on remet comme avant.
async function withAppConfig(base, key, wanted, flags, fn) {
    let previous = null, changed = false;
    try {
        const cfg = (await request(base, 'GET', '/api/config')).json || {};
        previous = String(cfg[key] || '').trim();
        if (path.resolve(previous || '/nonexistent') !== path.resolve(wanted)) {
            if (!flags.yes && !await confirm(T('L\'app pointe sur « {0} ». La faire pointer sur « {1} » le temps de la traduction (remis après) ?', previous || '(vide)', wanted))) { out(T('Annulé.')); return; }
            await request(base, 'POST', '/api/config', { [key]: wanted });
            changed = true;
        }
        await fn();
    } finally {
        if (changed) { try { await request(base, 'POST', '/api/config', { [key]: previous }); out(dim(T('Réglage de l\'app remis comme avant.'))); } catch { out(yellow(`${T('Remets manuellement ce réglage de l\'app :')} ${key} = ${previous}`)); } }
    }
}

// ── Baldur's Gate 3 ─────────────────────────────────────────────────────────
// Un « mod » = un .pak dans le dossier Mods. Le site fait le gros du travail (lecture des .pak, traduction
// via main.js, création de <mod>_fr.pak) ; ici on trouve le dossier, on analyse, on choisit et on suit l'avancement.
const BG3_APPID = '1086940';
const bg3Under = (gameDir) => path.join(gameDir, "Baldur's Gate 3", 'Mods');
const winAppData = (userDir) => path.join(userDir, 'AppData', 'Local', 'Larian Studios');
function steamLibraries() {
    const roots = [path.join(HOME, '.local/share/Steam'), path.join(HOME, '.steam/steam'), path.join(HOME, '.var/app/com.valvesoftware.Steam/.local/share/Steam')];
    const libs = new Set();
    for (const r of roots) {
        if (!isDir(path.join(r, 'steamapps'))) continue;
        libs.add(r);
        try { for (const m of fs.readFileSync(path.join(r, 'steamapps', 'libraryfolders.vdf'), 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1]); } catch { /* pas de vdf */ }
    }
    return [...libs];
}
function bg3Candidates() {
    const list = [];
    for (const lib of steamLibraries()) list.push(['Steam (Proton)', bg3Under(winAppData(path.join(lib, 'steamapps', 'compatdata', BG3_APPID, 'pfx', 'drive_c', 'users', 'steamuser')))]);
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) list.push(['Windows', bg3Under(path.join(process.env.LOCALAPPDATA, 'Larian Studios'))]);
    else {
        // Partitions Windows montées : <media>/<utilisateur>/<volume>/Users/<utilisateur Windows>/AppData/Local/…
        const media = process.env.LIVEMOD_MEDIA || '/run/media';
        const volumes = [];
        try { for (const u of fs.readdirSync(media)) for (const v of fs.readdirSync(path.join(media, u))) volumes.push(path.join(media, u, v)); } catch { /* pas de /run/media */ }
        try { if (!process.env.LIVEMOD_MEDIA) for (const v of fs.readdirSync('/mnt')) volumes.push(path.join('/mnt', v)); } catch { /* pas de /mnt */ }
        for (const v of volumes) { try { for (const wu of fs.readdirSync(path.join(v, 'Users'))) list.push([T('Partition Windows'), bg3Under(winAppData(path.join(v, 'Users', wu)))]); } catch { /* pas un volume Windows */ } }
    }
    try { const cfg = JSON.parse(fs.readFileSync(process.env.LIVEMOD_APP_CONFIG || path.join(ROOT, 'data', 'confightml.json'), 'utf8')); if (cfg.modsFolder) list.push([T('Réglage de l\'app'), cfg.modsFolder]); } catch { /* pas de config */ }
    for (const p of loadSelf().bg3Paths || []) list.push([T('Chemin mémorisé'), p]);
    const seen = new Set();
    return list.filter(([, d]) => isDir(d) && !seen.has(d) && seen.add(d)).map(([label, dir]) => ({ label, dir, paks: pakFiles(dir).length }));
}
function pakFiles(dir) { try { return fs.readdirSync(dir).filter((f) => /\.pak$/i.test(f)); } catch { return []; } }

async function askBg3Path() {
    for (;;) {
        const a = await ask(`\n${T('Chemin du dossier Mods de BG3')} ${dim('(…/Baldur\'s Gate 3/Mods — ' + T('« q » pour annuler') + ')')} : `);
        if (a === null || /^q/i.test(a.trim())) return null;
        let p = a.trim().replace(/^["']|["']$/g, '').replace(/^~(?=$|[\\/])/, HOME);
        if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(p)) { out(red(T('Chemin Windows : inutilisable depuis Linux.'))); continue; }
        p = path.resolve(p);
        if (!isDir(p)) { out(red(`${T('Introuvable :')} ${p}`)); continue; }
        if (isDir(path.join(p, 'Mods'))) p = path.join(p, 'Mods');
        if (path.basename(p) !== 'Mods' && !pakFiles(p).length) { out(red(T('Ce dossier ne ressemble pas au dossier Mods de BG3 (aucun .pak).'))); continue; }
        const self = loadSelf(); self.bg3Paths = [...new Set([...(self.bg3Paths || []), p])]; saveSelf(self);
        out(green(`${T('Chemin mémorisé :')} ${p}`));
        return p;
    }
}
async function selectBg3Folder() {
    out(dim(T('Recherche du dossier Mods de Baldur\'s Gate 3…')));
    const found = bg3Candidates();
    if (!found.length) { out(yellow(T('Aucun dossier Mods de BG3 trouvé automatiquement (Steam/Proton, partition Windows, Windows).'))); return askBg3Path(); }
    out(`\n${bold(T('{0} dossier(s) Mods trouvé(s)', found.length))} :`);
    found.forEach((f, i) => out(`  ${String(i + 1).padStart(2)}. ${String(f.paks).padStart(4)} .pak  ${dim(f.label)}\n        ${dim(f.dir)}`));
    if (found.length === 1) return found[0].dir;
    for (;;) {
        const a = ((await ask(`\n${T('Lequel ?')} ${dim(T('(numéro, « p » pour saisir un chemin, « q » pour annuler)'))} `)) || '').trim();
        if (!a || /^q/i.test(a)) return null;
        if (/^p$/i.test(a)) return askBg3Path();
        const n = parseInt(a, 10); if (String(n) === a && n >= 1 && n <= found.length) return found[n - 1].dir;
        out(red(T('Choix invalide.')));
    }
}

// Analyse via le site : liste des mods, puis « ce mod contient-il déjà du français ? »
async function bg3Analyse(base, lang) {
    const list = must(await request(base, 'GET', '/api/paks', null, 300000), T('Liste des mods'));   // 1re lecture des .pak : peut être longue
    if (list.error) throw new Error(list.error);
    const names = new Set(list.paks.map((p) => p.name.toLowerCase()));
    const mods = list.paks.map((p) => ({ id: p.name.replace(/\.pak$/i, ''), pak: p.name, modName: p.modName || p.name.replace(/\.pak$/i, ''), version: p.version, files: p.translatableFiles || 0, state: 'todo' }));
    const queue = [];
    for (const m of mods) {
        if (/_[a-z]{2}(-[a-z]{2})?\.pak$/i.test(m.pak)) m.state = 'translation';           // c'est déjà un pak de traduction
        else if (!m.files) m.state = 'nolang';                                              // rien à traduire dedans
        else if (names.has(`${m.id}_${lang}.pak`.toLowerCase())) m.state = 'done';           // un <mod>_fr.pak existe déjà
        else queue.push(m);
    }
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < queue.length) {
            const m = queue[next++];
            try { const r = (await request(base, 'GET', `/api/pak/${encodeURIComponent(m.pak)}/has-language?lang=${lang}`, null, 120000)).json; if (r && r.hasTarget) m.state = 'done'; } catch { /* on garde « à traduire » */ }
        }
    }));
    return mods;
}
function printBg3(folder, mods, lang) {
    const by = (s) => mods.filter((m) => m.state === s), todo = by('todo');
    out(`\n${bold(T('Dossier Mods de BG3'))}  ${dim(folder)}`);
    out(`  ${T('Traduire vers :')} ${bold(langName(lang))} (${lang})`);
    out(`  ${T('{0} mods (.pak)', mods.length - by('translation').length)}, ${green(T('{0} déjà en {1}', by('done').length, langName(lang)))}, ${todo.length ? yellow(T('{0} à traduire', todo.length)) : T('rien à traduire')}, ${dim(T('{0} sans texte à traduire', by('nolang').length))}, ${dim(T('{0} paks de traduction', by('translation').length))}`);
    const found = {};
    for (const m of by('translation')) { const code = BG3_LANGS.find((c) => m.pak.toLowerCase().endsWith(`_${c.toLowerCase()}.pak`)); if (code) found[code] = (found[code] || 0) + 1; }
    if (Object.keys(found).length) out(`  ${dim(T('Traductions existantes :') + ' ' + Object.entries(found).map(([c, n]) => `${langName(c)} ×${n}`).join(', '))}`);
    todo.slice(0, 10).forEach((m) => out(`   · ${m.modName.slice(0, 40).padEnd(40)} ${String(m.files).padStart(3)} ${T('fichier(s)')}  ${dim(m.pak)}`));
    if (todo.length > 10) out(dim(`   ${T('… et {0} autres mods', todo.length - 10)}`));
}
async function pickBg3Mods(todo) {
    out(`\n${bold(T('Mods à traduire'))}`);
    todo.slice(0, 80).forEach((m, i) => out(`  ${String(i + 1).padStart(3)}. ${m.modName.slice(0, 40).padEnd(40)} ${dim(m.pak)}`));
    if (todo.length > 80) out(dim(`  ${T('… {0} autres : tape leur identifiant', todo.length - 80)}`));
    for (;;) {
        const a = await ask(`\n${T('Lesquels ?')} ${dim(T('(« 1,3,5-8 » ou noms de fichier sans .pak, « q » annule)'))} `);
        if (a === null || /^q/i.test(a.trim())) return null;
        const sel = parseMods(a.trim(), todo); if (sel && sel.length) return sel;
        out(red(T('Sélection invalide.')));
    }
}
async function chooseBg3(todo, flags) {
    if (!todo.length) { out(green('\n' + T('Rien à traduire dans ce dossier.'))); return null; }
    if (flags.only) { const sel = parseMods(flags.only.split(',').join(' '), todo); return sel && sel.length ? sel : []; }
    if (flags.yes) return todo;
    out(`\n${bold(T('Étape 3/3 — Que traduire ?'))}`);
    out(`   1. ${T('Tout').padEnd(30)} ${dim(T('{0} mods', todo.length))}`);
    out(`   2. ${T('Choisir des mods un par un')}`);
    for (;;) {
        const a = ((await ask(`\n${T('Ton choix ?')} ${dim(T('(1 ou 2 · Entrée = tout · « q » annule)'))} `)) || '').trim().toLowerCase();
        if (/^q/.test(a)) return null;
        if (!a || a === '1' || a === 'tout' || a === 'all') return todo;
        if (a === '2' || a === 'choisir' || a === 'pick') return pickBg3Mods(todo);
        out(red(T('Choix invalide.')));
    }
}

// Flux de traduction du site : lignes « data: {"type":…} » (start, log, progress, error, done…)
function sseTyped(base, p, onEvent) {
    return new Promise((resolve, reject) => {
        const r = http.get(new URL(p, base), (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
            let buf = '';
            res.on('data', (chunk) => {
                buf += chunk; let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, i); buf = buf.slice(i + 2);
                    const dt = (block.match(/^data: (.*)$/m) || [])[1];
                    if (dt) { try { const o = JSON.parse(dt); onEvent(o.type, o); } catch { /* ligne illisible */ } }
                }
            });
            res.on('end', resolve); res.on('error', reject);
        });
        r.on('error', reject);
    });
}
async function translateBg3Mod(base, mod, lang) {
    let done = null, already = null, lastPct = -1; const errors = [], logs = [];
    const clear = () => process.stdout.write('\r' + ' '.repeat(78) + '\r');
    await sseTyped(base, `/api/translate/stream?pak=${encodeURIComponent(mod.pak)}&lang=${lang}`, (type, d) => {
        if (type === 'progress') {
            const pct = d.pct || 0;
            if (tty) { const fill = Math.round(pct / 5); process.stdout.write(`\r  [${cyan('█'.repeat(fill))}${dim('░'.repeat(20 - fill))}] ${String(pct).padStart(3)}%  ${dim(d.eta ? 'ETA ' + d.eta : '')}`.padEnd(70)); }
            else if (Math.floor(pct / 25) !== lastPct) { lastPct = Math.floor(pct / 25); out(`  … ${pct}%`); }
        } else if (type === 'error') errors.push(String(d.text || '').trim());
        else if (type === 'log') { logs.push(String(d.text || '').trim()); if (logs.length > 6) logs.shift(); }
        else if (type === 'already_translated') already = d;
        else if (type === 'done') done = d;
    });
    if (tty) clear();
    return { done, already, errors, logs };
}

async function bg3Guided(folder, flags) {
    out(bold('\n' + T('Étape 2/3 — Analyse du dossier Mods')));
    const base = await ensureServer(); if (!base) { out(T('Pas de serveur : traduction impossible.')); return; }
    const lang = flags.target || 'fr';
    await withAppConfig(base, 'modsFolder', folder, flags, async () => {
        const mods = await bg3Analyse(base, lang);
        printBg3(folder, mods, lang);
        const chosen = await chooseBg3(mods.filter((m) => m.state === 'todo'), flags);
        if (chosen === null) { out(T('Annulé.')); return; }
        if (!chosen.length) { out(red(T('Sélection invalide.'))); return; }
        out(`\n${bold(T('À traduire'))} : ${T('{0} mod(s)', chosen.length)}  → ${langName(lang)}`);
        if (!flags.yes && !await confirm(T('Lancer la traduction ? (utilise le moteur configuré dans l\'app)'))) { out(T('Annulé.')); return; }
        const started = Date.now(), ok = [], failed = [], skipped = [];
        for (const [i, m] of chosen.entries()) {
            out(bold(`\n▶ [${i + 1}/${chosen.length}] ${m.modName}`) + dim(`  ${m.pak}`));
            try {
                const r = await translateBg3Mod(base, m, lang);
                if (r.already) { skipped.push(m.modName); out(dim('  ' + T('Déjà traduit en {0} : ignoré.', langName(lang)))); }
                else if (r.done && r.done.code === 0) { ok.push(m.modName); out(green(`  ✓ ${r.done.output}`)); }
                else { failed.push(m.modName); out(red(`  ✗ ${T('Échec')} : ${(r.errors.pop() || r.logs.pop() || T('flux interrompu'))}`)); }
            } catch (e) { failed.push(m.modName); out(red(`  ✗ ${e.message}`)); }
        }
        out(`\n${failed.length ? yellow(T('Terminé avec des échecs :') + ' ' + failed.join(', ')) : green(T('Terminé'))} — ${T('{0} traduit(s), {1} ignoré(s), {2} échec(s)', ok.length, skipped.length, failed.length)} ${T('en {0}s.', Math.round((Date.now() - started) / 1000))}`);
        if (ok.length) out(dim(T('Les fichiers *_{0}.pak sont dans le dossier Mods : active-les dans ton gestionnaire de mods si besoin.', lang)));
    });
}

// ── commandes ───────────────────────────────────────────────────────────────
const GAMES = {
    minecraft: { label: 'Minecraft', actions: {
        scan: 'Trouve tes modpacks, analyse, demande quoi traduire (tout, mods, FTB Quests…)',
        translate: 'Idem sur le modpack déjà choisi',
        use: 'Change de modpack (sans traduire)',
    } },
    bg3: { label: 'Baldur\'s Gate 3', actions: {
        scan: 'Trouve le dossier Mods de BG3, analyse, demande quels mods traduire',
        translate: 'Idem sur le dossier déjà choisi',
        use: 'Change de dossier Mods (sans traduire)',
    } },
};
const OTHER_GAMES = ['hytale', 'satisfactory', 'valheim', 'outerwilds', 'riskofrain2', 'ancientdungeon'];

// Ce qui diffère d'un jeu à l'autre : où chercher, comment montrer le choix, et le parcours guidé.
const HANDLERS = {
    minecraft: {
        step1: 'Étape 1/3 — Chercher ton modpack', select: selectPack, session: 'pack',
        show: (pack) => { printScan(pack, scanPack(pack), scanSources(pack)); },
        guided: guided, next: 'Suite : trad minecraft translate',
    },
    bg3: {
        step1: 'Étape 1/3 — Trouver le dossier Mods', select: selectBg3Folder, session: 'bg3',
        show: (dir) => { out(`\n${bold(T('Dossier Mods de BG3'))}  ${dim(dir)}\n  ${T('{0} fichier(s) .pak', pakFiles(dir).length)}`); },
        guided: bg3Guided, next: 'Suite : trad bg3 translate',
    },
};

async function trad([game, action, ...rest]) {
    if (!game) { out(T('Usage : trad <jeu> <action>') + '\n  trad minecraft scan        ' + T(GAMES.minecraft.actions.scan) + '\n  trad bg3 scan              ' + T(GAMES.bg3.actions.scan) + '\n  trad <jeu> translate       ' + T(GAMES.minecraft.actions.translate) + '\n  trad <jeu> use             ' + T(GAMES.minecraft.actions.use)); return; }
    game = game.toLowerCase();
    if (OTHER_GAMES.includes(game)) { out(yellow(T('{0} n\'est pas encore géré en mode texte — utilise le site (translator → http://127.0.0.1:3000).', game))); return; }
    if (!GAMES[game]) { out(red(T('Jeu inconnu : {0}. Disponible : {1}  (bientôt : {2})', game, Object.keys(GAMES).join(', '), OTHER_GAMES.join(', ')))); return; }
    const flags = { yes: rest.includes('--yes'), only: (rest.find((a) => a.startsWith('--only=')) || '').slice(7) };
    const asked = rest.includes('--lang') ? rest[rest.indexOf('--lang') + 1] : (rest.find((a) => a.startsWith('--lang=')) || '').slice(7);
    if (asked) {
        flags.lang = parseLang(asked);
        if (!flags.lang) { out(red(T('Langue inconnue : {0}. Disponibles :', asked)) + ' ' + BG3_LANGS.map((c) => `${c} (${langName(c)})`).join(', ')); return; }
    }
    flags.target = flags.lang || parseLang(loadSelf().target) || 'fr';
    const H = HANDLERS[game];
    if (action && !GAMES[game].actions[action]) out(red(`${T('Action inconnue :')} ${action}`) + dim('  (help trad)'));
    else if (action === 'scan' || action === 'use') {
        if (action === 'scan') out(bold('\n' + T(H.step1)));
        const picked = await H.select();
        if (!picked) { out(T('Annulé.')); return; }
        session[H.session] = picked;
        if (action === 'use') { H.show(picked); out(dim('\n' + T(H.next))); }
        else await H.guided(picked, flags);
    } else if (action === 'translate') {
        const picked = session[H.session] || await H.select();
        if (!picked) { out(T('Annulé.')); return; }
        session[H.session] = picked; await H.guided(picked, flags);
    } else out(`${T('Actions pour {0} :', game)} ${Object.keys(GAMES[game].actions).join(', ')}`);
}

// ── assistant de première utilisation (« setup », ou --Debug-start pour le forcer) ──
const firstGame = () => ((loadSelf().games || []).find((g) => GAMES[g])) || 'minecraft';
const MASK = (v) => (v && v.length >= 12 ? '••••' + v.slice(-4) : '••••');
const KEYS = [['KeyDeepL', 'DeepL'], ['KeyOpenRouter', 'OpenRouter'], ['KeyGemini', 'Gemini']];

async function setupLanguage(self) {
    const locs = availableLocales(), cur = self.lang || 'fr';
    out(`\n${bold('1/4  Langue / Language')}`);
    locs.forEach((l, i) => out(`  ${i + 1}. ${l.name}${l.code === cur ? dim('  ←') : ''}`));
    out(`  ${locs.length + 1}. Autre / Other…`);
    for (;;) {
        const a = ((await ask(`\n${dim('(Enter = ' + cur + ')')} > `)) || '').trim();
        let code = cur;
        if (a) {
            const n = parseInt(a, 10);
            if (String(n) === a && n >= 1 && n <= locs.length) code = locs[n - 1].code;
            else if (String(n) === a && n === locs.length + 1) {
                const o = ((await ask('Code (de, es, it…) : ')) || '').trim().toLowerCase();
                if (!o) continue;
                if (locs.some((l) => l.code === o)) code = o;
                else { out(yellow(`${o} : not available yet / pas encore disponible → English.`)); out(dim(`  locales/${o}.json (voir README / see README)`)); code = 'en'; }
            } else { const hit = locs.find((l) => l.code === a.toLowerCase() || l.name.toLowerCase() === a.toLowerCase()); if (!hit) { out(red('?')); continue; } code = hit.code; }
        }
        self.lang = setLang(code);
        return;
    }
}
async function setupTarget(self) {
    const cur = parseLang(self.target) || 'fr';
    out(`\n${bold('2/4  ' + T('Traduire vers quelle langue ?'))}`);
    BG3_LANGS.forEach((c, i) => out(`  ${String(i + 1).padStart(2)}. ${langName(c).padEnd(24)} ${dim(c)}${c === cur ? '  ←' : ''}`));
    out(dim(`  ${T('Minecraft : français uniquement pour l\'instant')}`));
    for (;;) {
        const a = ((await ask(`\n${dim('(' + T('Entrée = garder') + ' : ' + cur + ')')} > `)) || '').trim();
        if (!a) { self.target = cur; return; }
        const n = parseInt(a, 10), code = String(n) === a ? BG3_LANGS[n - 1] : parseLang(a);
        if (code) { self.target = code; return; }
        out(red(T('Choix invalide.')));
    }
}
async function setupGames(self) {
    const mine = new Set(self.games && self.games.length ? self.games : [firstGame()]);
    const all = [...Object.keys(GAMES), ...OTHER_GAMES];
    out(`\n${bold('3/4  ' + T('Quels jeux veux-tu traduire ?'))}`);
    all.forEach((g, i) => out(`  ${String(i + 1).padStart(2)}. ${g.padEnd(16)} ${GAMES[g] ? green(T('disponible')) : dim(T('bientôt (site)'))}${mine.has(g) ? ' ★' : ''}`));
    for (;;) {
        const a = ((await ask(`\n${T('Numéros « 1,3 » ou noms')} ${dim('(' + T('Entrée = garder') + ' : ' + [...mine].join(', ') + ')')} : `)) || '').trim();
        if (!a) break;
        const pick = new Set();
        for (const tok of a.split(/[,\s]+/).filter(Boolean)) {
            const n = parseInt(tok, 10), g = String(n) === tok ? all[n - 1] : all.find((x) => x === tok.toLowerCase());
            if (!g) { pick.clear(); break; }
            pick.add(g);
        }
        if (!pick.size) { out(red(T('Choix invalide.'))); continue; }
        mine.clear(); pick.forEach((g) => mine.add(g)); break;
    }
    self.games = [...mine];
    for (const g of self.games.filter((x) => !GAMES[x])) out(yellow(`  ${T('{0} n\'est pas encore géré en mode texte — utilise le site (translator → http://127.0.0.1:3000).', g)}`));
}
async function setupOptions() {
    out(`\n${bold('4/4  ' + T('Options de traduction'))} ${dim('(' + T('facultatif') + ')')}`);
    let base = null;
    const needApp = async () => {
        if (base) return base;
        base = await findServer() || await ensureServer();
        if (!base) out(yellow(T('L\'app doit tourner pour enregistrer les réglages. Relance « setup » plus tard.')));
        return base;
    };
    const saveEnv = async (values) => {
        const r = await request(await needApp(), 'POST', '/api/save-env/config', { values });
        if (r.status !== 200 || !r.json || !r.json.ok) throw new Error((r.json && r.json.error) || 'HTTP ' + r.status);
    };
    for (;;) {
        out(`\n  1. ${T('Ajouter / modifier une clé API (DeepL, OpenRouter, Gemini)')}`);
        out(`  2. ${T('LM Studio (traduction locale, sans clé)')}`);
        out(`  3. ${T('Voir ce qui est configuré')}`);
        out(`  4. ${T('Terminer')}`);
        const a = ((await ask(`\n${T('Ton choix ?')} ${dim('(' + T('Entrée = terminer') + ')')} `)) || '4').trim();
        try {
            if (a === '4' || /^q/i.test(a) || a === '') return;
            if (a === '1') {
                KEYS.forEach(([, n], i) => out(`    ${i + 1}. ${n}`));
                const k = KEYS[parseInt((await ask(`  ${T('Laquelle ?')} `)) || '0', 10) - 1];
                if (!k) continue;
                if (!await needApp()) return;
                let v = ((await ask(`  ${T('Colle la clé {0} (rien ne s\'affiche, Entrée vide = annuler)', k[1])} : `, false, true)) || '').trim();
                if (!v) { out(dim(T('Annulé.'))); continue; }
                await saveEnv({ [k[0]]: v });
                out(green(`  ✓ ${T('Clé {0} enregistrée', k[1])} (${MASK(v)})`));
                v = '';
            } else if (a === '2') {
                if (!await needApp()) return;
                let cur = 'http://127.0.0.1:1234';
                try { const r = await request(base, 'GET', '/api/lmstudio-config'); if (r.json && r.json.url) cur = r.json.url; } catch { /* valeur par défaut */ }
                const url = ((await ask(`  URL LM Studio ${dim('(' + T('Entrée = {0}', cur) + ')')} : `)) || '').trim() || cur;
                if (!/^https?:\/\/[^\s]+$/.test(url)) { out(red(T('URL invalide.'))); continue; }
                const on = await confirm(`  ${T('Activer LM Studio ?')}`);
                await saveEnv({ LMStudioUrl: url, LMStudioEnabled: String(on) });
                out(green(`  ✓ LM Studio ${on ? T('activé') : T('désactivé')} — ${url}`));
            } else if (a === '3') {
                if (!await needApp()) return;
                const r = await request(base, 'GET', '/api/save-env/config');
                const keys = (r.json && r.json.keys) || {};
                // L'app renvoie { configured, value } (clés déjà masquées) ; on tolère aussi un simple texte.
                const info = (v) => (v && typeof v === 'object' ? { configured: !!v.configured, value: String(v.value || '') } : { configured: !!v && String(v).toLowerCase() !== 'null', value: String(v || '') });
                for (const [k, n] of KEYS) {
                    const v = info(keys[k]);
                    out(`  ${n.padEnd(11)} ${v.configured ? green('✓ ' + T('configurée')) + dim(' ••••' + v.value.slice(-4)) : dim('— ' + T('non configurée'))}`);
                }
                const lm = info(keys.LMStudioUrl);
                out(`  ${'LM Studio'.padEnd(11)} ${lm.configured ? green('✓ ' + lm.value) : dim('— ' + T('non configuré'))}`);
            } else out(red(T('Choix invalide.')));
        } catch (e) { if (e instanceof BackToMenu) throw e; out(red(`  ✗ ${e.message}`)); }
    }
}
async function setup({ forced = false } = {}) {
    const self = loadSelf();
    out(`\n${bold('ModLingo-Hub')} — ${bold('Setup')}${forced ? dim('  (--Debug-start)') : ''}`);
    await setupLanguage(self);
    await setupTarget(self);
    await setupGames(self);
    saveSelf({ ...loadSelf(), ...self });
    await setupOptions();
    saveSelf({ ...loadSelf(), ...self, setupDone: true, setupVersion: 1 });
    out(`\n${green('✓ ' + T('Configuration enregistrée.'))}  ${T('Langue')} : ${availableLocales().find((l) => l.code === LANG).name} · ${T('Traduire vers :')} ${langName(self.target)} · ${T('Jeux')} : ${self.games.join(', ')}`);
    out(`  ${T('Pour commencer, tape :')} ${cyan(firstGame() + ' scan')}  ${dim('· ' + T('« setup » pour refaire cet assistant'))}\n`);
}

function mcpView() {
    out(bold('\nMode MCP') + dim(' — ' + T('ce que les clients ont demandé (journal du serveur) :')));
    let lines = []; try { lines = fs.readFileSync(path.join(STATE, 'livemod.log'), 'utf8').trimEnd().split('\n').filter((l) => / tool /.test(l)).slice(-8); } catch { /* pas de journal */ }
    out(lines.length ? lines.join('\n') : dim('  ' + T('(aucune requête enregistrée)')));
    out(dim('\n' + T('« help » pour les commandes MCP, « nomcp » pour revenir au mode traduction.') + '\n'));
    rl.close(); queue.length = 0;
    spawnSync(process.execPath, [path.join(__dirname, 'livemod.js'), 'shell'], { stdio: 'inherit', env: { ...process.env, LIVEMOD_FROM_INTERFACE: '1' } });
    openInput();
    out(dim(T('Retour au mode traduction (nomcp).')));
}

function table(head, rows) {
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
    const line = (r) => '| ' + r.map((x, i) => String(x).padEnd(w[i])).join(' | ') + ' |';
    const sep = '|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|';
    out(bold(line(head))); out(sep); rows.forEach((r) => out(line(r)));
}
function help([topic]) {
    if (topic === 'trad') {
        const rows = [];
        for (const [g, def] of Object.entries(GAMES)) for (const [a, d] of Object.entries(def.actions)) rows.push([`trad ${g} ${a}`, T(d), def.label]);
        const mine = new Set(loadSelf().games || []);
        out(bold('\n' + T('Commandes disponibles')));
        table(['Command', 'Trad', 'Game'], rows);
        out(bold('\n' + T('Jeux')));
        table(['Game', T('Statut'), 'Actions'], [
            ...Object.entries(GAMES).map(([g, def]) => [(mine.has(g) ? '★ ' : '') + g, T('disponible'), Object.keys(def.actions).join(', ')]),
            ...OTHER_GAMES.map((g) => [(mine.has(g) ? '★ ' : '') + g, T('bientôt (site)'), '-']),
        ]);
        out(dim('\n★ = ' + T('tes jeux (assistant : setup)') + '  ·  ' + T('Tab complète les commandes · flèche haut/bas rappelle les anciennes commandes')));
        return;
    }
    out(`${bold(T('Comment ça marche'))}
  1. ${T('Tape')} ${cyan(firstGame() + ' scan')}      → ${T('trouve ton modpack, l\'analyse, te demande quoi traduire')}
  2. ${T('Choisis (tout, les mods, FTB Quests, KubeJS…)')}  → ${T('la traduction se fait toute seule')}

${bold(T('Commandes'))}
  ${cyan(firstGame() + ' scan')}     ${T('le parcours complet (le plus simple)')}
  ${cyan('help trad')}          ${T('tableau de toutes les commandes et jeux disponibles')}
  ${cyan('lang')}               ${T('langue vers laquelle on traduit (ex. lang de)')}
  ${cyan('clr')}                ${T('efface l\'écran et revient au menu (marche aussi pendant une question)')}
  ${cyan('version')}            ${T('affiche la version de ModLingo-Hub-live')}
  ${cyan('setup')}              ${T('refait l\'assistant (langue, jeux, clés de traduction)')}
  ${cyan('mcp')}                ${T('passe en mode MCP (pour les outils IA)')} · ${cyan('nomcp')} ${T('pour revenir')}
  ${cyan('exit')}               ${T('quitter')}

${dim(T('Astuces : Tab complète · flèche haut rappelle tes anciennes commandes · « q » annule une question'))}`);
}

const clearScreen = () => { if (tty) process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); };
// Le « menu » : titre + version + comment commencer.
function home() {
    out(`${bold('ModLingo-Hub')} ${dim('· ModLingo-Hub-live v' + VERSION + ' — ' + T('traduction en ligne de commande'))}`);
    out(`  ${T('Pour commencer, tape :')} ${cyan(firstGame() + ' scan')}`);
    const tg = parseLang(loadSelf().target) || 'fr';
    out(`  ${dim(T('Traduire vers :') + ' ' + langName(tg) + ' (' + tg + ') · ' + T('« lang » pour changer'))}`);
    out(`  ${dim(T('help = aide · clr = retour au menu · exit = quitter'))}\n`);
}
// « lang » : voir la langue cible ; « lang de » : la changer (mémorisé).
function setTarget(input) {
    const cur = parseLang(loadSelf().target) || 'fr';
    if (!input) {
        out(`${T('Traduire vers :')} ${bold(langName(cur))} (${cur})`);
        out(dim(BG3_LANGS.map((c) => `${c} ${langName(c)}`).join(' · ')));
        out(dim(T('Changer : lang <code>  ·  Minecraft : français uniquement pour l\'instant')));
        return;
    }
    const code = parseLang(input);
    if (!code) { out(red(T('Langue inconnue : {0}. Disponibles :', input)) + ' ' + BG3_LANGS.join(', ')); return; }
    saveSelf({ ...loadSelf(), target: code });
    out(green(`✓ ${T('Traduire vers :')} ${langName(code)} (${code})`));
}
function showVersion() {
    const rt = nodeUpdate.runtimeInfo();
    let app = ''; try { app = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'version.json'), 'utf8')).version; } catch { /* absent */ }
    out(`${bold('ModLingo-Hub-live')} v${VERSION}`);
    out(`  Node      ${rt.version} (${rt.portable ? T('portable') : T('système')})`);
    if (app) out(`  ModLingo-Hub  ${app}`);
    out(`  ${T('Langue')}    ${LANG}`);
}

async function run(argv = []) {
    const forced = argv.some((a) => /^--debug-start$/i.test(a));
    argv = argv.filter((a) => !/^--debug-start$/i.test(a));
    setLang(process.env.LIVEMOD_LANG || loadSelf().lang);
    openInput();
    const exec = async (line) => {
        const [cmd, ...args] = line.trim().split(/\s+/).filter(Boolean);
        if (!cmd) return true;
        if (cmd === 'exit' || cmd === 'quit') return false;
        if (cmd === 'help') help(args);
        else if (cmd === 'trad') await trad(args);
        else if (GAMES[cmd.toLowerCase()] || OTHER_GAMES.includes(cmd.toLowerCase())) await trad([cmd, ...args]);
        else if (cmd === 'clr' || cmd === 'clear' || cmd === 'cls') { session.pack = null; session.bg3 = null; clearScreen(); home(); }
        else if (cmd === 'version' || cmd === '--version') showVersion();
        else if (cmd === 'lang') setTarget(args[0]);
        else if (cmd === 'setup') await setup();
        else if (cmd === 'mcp') mcpView();
        else if (cmd === 'nomcp') out(T('Déjà en mode nomcp (traduction).'));
        else {
            const all = ['trad', ...Object.keys(GAMES), ...OTHER_GAMES, 'help', 'lang', 'clr', 'clear', 'version', 'mcp', 'nomcp', 'exit'];
            const near = all.find((c) => c.startsWith(cmd.toLowerCase().slice(0, 3)));
            out(red(`${T('Commande inconnue :')} ${cmd}`) + (near ? `  — ${T('tu voulais dire « {0} » ?', near)}` : '') + dim('  ' + T('(help pour la liste)')));
        }
        return true;
    };
    try {
        // Première utilisation (ou --Debug-start) : l'assistant passe avant tout.
        if (forced || (!argv.length && !loadSelf().setupDone && !process.env.LIVEMOD_NO_SETUP)) await setup({ forced });
        if (argv.length) { await exec(argv.join(' ')); return; }
        home();
        if (process.env.LIVEMOD_NO_UPDATE !== '1') {
            let mode = 'auto'; try { mode = JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8')).nodeUpdate || 'auto'; } catch { /* défaut */ }
            nodeUpdate.check({ mode }).then((r) => {
                if (r.status === 'prepared') notice = T('Node {0} prêt : il sera utilisé au prochain lancement.', r.version);
                else if (r.status === 'available') notice = T('Node {0} est disponible (« mcp update-node » pour l\'installer).', r.version);
            });
        }
        for (;;) {
            const l = await ask(`${cyan('›')} `, true);
            if (l === null) break;
            try { if (!await exec(l)) break; } catch (e) { if (e instanceof BackToMenu) { clearScreen(); home(); } else out(red(T('Erreur :') + ' ' + e.message)); }
        }
    } finally { stopServer(); rl.close(); }
}

module.exports = { run, setup, scanJar, scanPack, findPacks, packsInDir };
if (require.main === module) run(process.argv.slice(2)).then(() => process.exit(0));
