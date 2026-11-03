'use strict';
// Mise à jour du Node portable (Dependence/node) : vérifiée, jamais bloquante, appliquée au lancement suivant.
//  - même version majeure seulement (22.x → 22.y), versions LTS uniquement ;
//  - empreinte SHA-256 vérifiée avec SHASUMS256.txt avant toute extraction ;
//  - préparée dans Dependence/node.new puis échangée par le lanceur ; l'ancienne reste dans node.old (retour arrière).
// Réglage : config « nodeUpdate » = auto (défaut) | ask (prévient seulement) | off.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { PORTABLE, NODE_DIR, STATE } = require('./paths');

const DIST = (process.env.LIVEMOD_NODE_DIST || 'https://nodejs.org/dist').replace(/\/$/, '');
const NEW_DIR = NODE_DIR + '.new', TMP_DIR = NODE_DIR + '.tmp';
const STAMP = path.join(STATE, 'node-update.json');
const DAY = 24 * 3600 * 1000, MAX_ARCHIVE = 250 * 1024 * 1024;

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
function cmp(a, b) { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }

function archiveName(version, platform = process.platform, arch = process.arch) {
    const a = { x64: 'x64', arm64: 'arm64' }[arch];
    if (!a) return null;
    if (platform === 'linux' || platform === 'darwin') return `node-${version}-${platform}-${a}.tar.gz`;
    if (platform === 'win32') return `node-${version}-win-${a}.zip`;
    return null;
}
// Dernière version LTS de la MÊME majeure que `current`, ou null.
function newestSameMajor(index, current) {
    const major = parse(current)[0];
    const best = (Array.isArray(index) ? index : []).filter((e) => e && e.lts && parse(e.version)[0] === major).map((e) => e.version).sort(cmp).pop();
    return best && cmp(best, current) > 0 ? best : null;
}

// HTTPS obligatoire (http seulement vers 127.0.0.1, pour les tests) ; pas de redirection.
function fetchTo(url, { toFile, maxBytes = 5 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const local = u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
        if (u.protocol !== 'https:' && !local) return reject(new Error('HTTPS requis'));
        const req = (local ? http : https).get(u, { timeout: 15000 }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${u.pathname}`)); }
            const hash = crypto.createHash('sha256'); let size = 0; const chunks = [];
            const out = toFile ? fs.createWriteStream(toFile, { mode: 0o600 }) : null;
            res.on('data', (c) => {
                size += c.length;
                if (size > maxBytes) { req.destroy(new Error('fichier trop gros')); return; }
                hash.update(c); if (out) out.write(c); else chunks.push(c);
            });
            res.on('end', () => { const done = () => resolve({ sha256: hash.digest('hex'), body: out ? null : Buffer.concat(chunks).toString('utf8') }); if (out) out.end(done); else done(); });
            res.on('error', reject);
        });
        req.on('error', reject).on('timeout', () => req.destroy(new Error('délai dépassé')));
    });
}

function runtimeInfo() {
    return { version: process.version, portable: PORTABLE && path.dirname(path.dirname(process.execPath)) === NODE_DIR || (PORTABLE && path.dirname(process.execPath) === NODE_DIR), execPath: process.execPath };
}
function pending() { const r = readJson(path.join(NEW_DIR, '.ready')); return fs.existsSync(path.join(NEW_DIR, '.ready')) ? (r || {}) : null; }

async function prepare(version) {
    const file = archiveName(version);
    if (!file) throw new Error(`plateforme non gérée : ${process.platform}-${process.arch}`);
    const sums = (await fetchTo(`${DIST}/${version}/SHASUMS256.txt`)).body;
    const line = sums.split('\n').find((l) => l.trim().endsWith('  ' + file));
    const expected = line && line.trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{64}$/.test(expected || '')) throw new Error(`empreinte introuvable pour ${file}`);

    const cache = path.join(STATE, 'cache'); fs.mkdirSync(cache, { recursive: true });
    const archive = path.join(cache, file + '.part');
    try {
        const { sha256 } = await fetchTo(`${DIST}/${version}/${file}`, { toFile: archive, maxBytes: MAX_ARCHIVE });
        const a = Buffer.from(sha256), b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('empreinte SHA-256 différente : archive rejetée');
        fs.rmSync(TMP_DIR, { recursive: true, force: true }); fs.mkdirSync(TMP_DIR, { recursive: true });
        const t = spawnSync('tar', ['-xf', archive, '-C', TMP_DIR, '--strip-components=1'], { timeout: 120000 });
        if (t.status !== 0) throw new Error('extraction impossible (tar) : ' + String(t.stderr || '').trim().slice(0, 200));
        const bin = path.join(TMP_DIR, process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'));
        const v = spawnSync(bin, ['-v'], { timeout: 10000 });
        if (v.status !== 0 || String(v.stdout).trim() !== version) throw new Error('le nouveau Node ne répond pas correctement');
        fs.rmSync(NEW_DIR, { recursive: true, force: true });
        fs.renameSync(TMP_DIR, NEW_DIR);
        fs.writeFileSync(path.join(NEW_DIR, '.ready'), JSON.stringify({ version, sha256: expected, at: new Date().toISOString() }));
    } finally { fs.rmSync(archive, { force: true }); fs.rmSync(TMP_DIR, { recursive: true, force: true }); }
}

// mode : auto | ask | off. Renvoie { status, version?, message? } ; ne lève jamais.
async function check({ mode = 'auto', force = false } = {}) {
    try {
        if (!PORTABLE) return { status: 'skipped', message: 'pas en mode portable' };
        if (mode === 'off' && !force) return { status: 'skipped', message: 'désactivé (nodeUpdate = off)' };
        const ready = pending();
        if (ready) return { status: 'prepared', version: ready.version };
        const stamp = readJson(STAMP) || {};
        if (!force && Date.now() - (stamp.lastCheck || 0) < DAY) return { status: 'skipped', message: 'vérifié il y a moins de 24 h' };
        fs.mkdirSync(STATE, { recursive: true });
        const write = (extra) => fs.writeFileSync(STAMP, JSON.stringify({ ...stamp, lastCheck: Date.now(), ...extra }, null, 2));
        const index = JSON.parse((await fetchTo(`${DIST}/index.json`, { maxBytes: 8 * 1024 * 1024 })).body);
        const version = newestSameMajor(index, process.version);
        if (!version) { write({ lastResult: 'à jour' }); return { status: 'uptodate', version: process.version }; }
        if (mode === 'ask' && !force) { write({ lastResult: 'disponible ' + version }); return { status: 'available', version }; }
        await prepare(version);
        write({ lastResult: 'préparé ' + version });
        return { status: 'prepared', version };
    } catch (e) {
        try { fs.mkdirSync(STATE, { recursive: true }); fs.appendFileSync(path.join(STATE, 'node-update.log'), `${new Date().toISOString()} ${e.message}\n`); } catch { /* journal facultatif */ }
        return { status: 'error', message: e.message };
    }
}

module.exports = { check, pending, runtimeInfo, newestSameMajor, archiveName, cmp };
