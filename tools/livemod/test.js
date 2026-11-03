#!/usr/bin/env node
'use strict';
// Test de bout en bout de ModLingo-Hub-live, dans un état isolé (ne touche pas à .livemod/ ni au serveur en cours).
// Usage : node tools/livemod/test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const JS = path.join(__dirname, 'livemod.js');
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'livemod-test-'));
const ENV = { ...process.env, LIVEMOD_STATE: STATE, LIVEMOD_NO_UPDATE: '1' };

// Données de test fabriquées : le test ne dépend d'aucune donnée réelle (ni caches ni glossaires de la machine).
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'livemod-data-'));
fs.mkdirSync(path.join(DATA, 'valheim'), { recursive: true }); fs.mkdirSync(path.join(DATA, 'minecraft'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'valheim', 'cache.json'), JSON.stringify({ _meta: {}, 'en|fr': { 'a sword': 'une épée', 'a shield': 'un bouclier', 'an axe': 'une hache', 'a bow': 'un arc', 'a hammer': 'un marteau' } }));
fs.writeFileSync(path.join(DATA, 'minecraft', 'glossary.json'), JSON.stringify({ _info: 'test', mod_names: { 'Refined Storage': 'Refined Storage', 'Functional Storage': 'Stockage fonctionnel', 'Create': 'Create' } }));
fs.writeFileSync(path.join(DATA, 'version.json'), JSON.stringify({ name: 'ModLingo-Hub', version: '0.0.0-test' }));
fs.writeFileSync(path.join(STATE, 'config.json'), JSON.stringify({ dataDir: DATA }));
let passed = 0; const failed = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); }
}

// ── stdio ───────────────────────────────────────────────────────────────────
function stdioSession() {
    const p = spawn(process.execPath, [JS, 'start', '--stdio'], { env: ENV, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = ''; const waiters = new Map();
    p.stdout.on('data', (c) => {
        buf += c; let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
            if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
        }
    });
    let id = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => {
        const i = ++id; const to = setTimeout(() => reject(new Error('timeout ' + method)), 5000);
        waiters.set(i, (m) => { clearTimeout(to); resolve(m); });
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    });
    const call = async (name, args) => {
        const r = await rpc('tools/call', { name, arguments: args });
        const text = r.result.content[0].text;
        return { isError: !!r.result.isError, text, json: () => JSON.parse(text) };
    };
    return { rpc, call, close: () => p.kill() };
}

// ── http ────────────────────────────────────────────────────────────────────
function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 3000 }, (res) => {
            let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        r.on('error', reject).on('timeout', () => r.destroy(new Error('timeout')));
        r.end(body);
    });
}
async function startHttp(port, extra = []) {
    const p = spawn(process.execPath, [JS, 'start', '--foreground', '--port', String(port), ...extra], { env: ENV, stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
        try { await req(port, { path: '/nope' }); return p; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    p.kill(); throw new Error('serveur HTTP non démarré');
}
const rpcBody = (o) => JSON.stringify({ jsonrpc: '2.0', ...o });

(async () => {
    console.log('stdio');
    const s = stdioSession();
    await t('initialize annonce livemod', async () => {
        const r = await s.rpc('initialize'); assert.strictEqual(r.result.serverInfo.name, 'modlingo-hub-live');
    });
    await t('tools/list expose les 8 outils intégrés', async () => {
        const names = (await s.rpc('tools/list')).result.tools.map((x) => x.name);
        for (const n of ['project_info', 'translation_stats', 'lookup_translation', 'search_translations', 'get_glossary', 'list_modules', 'recent_changes', 'read_project_file']) assert(names.includes(n), n);
    });
    await t('project_info liste les jeux avec leurs traductions', async () => {
        const j = (await s.call('project_info', {})).json();
        assert(j.appVersion && j.games.length > 0); assert(j.games.some((g) => g.translations > 0));
    });
    await t('search_translations trouve et respecte limit', async () => {
        const j = (await s.call('search_translations', { game: 'valheim', query: 'a', limit: 3 })).json();
        assert(j.total >= 3 && j.results.length === 3);
    });
    await t('lookup_translation : absent => found:false', async () => {
        assert.strictEqual((await s.call('lookup_translation', { game: 'valheim', text: '\u0000nope' })).json().found, false);
    });
    await t('get_glossary filtre', async () => {
        const all = (await s.call('get_glossary', { game: 'minecraft' })).json();
        const some = (await s.call('get_glossary', { game: 'minecraft', query: 'storage' })).json();
        assert(all.length > some.length && some.length > 0);
    });
    await t('jeu inconnu => isError', async () => { assert((await s.call('get_glossary', { game: '../etc' })).isError); });
    await t('outil inconnu => erreur JSON-RPC', async () => { assert((await s.rpc('tools/call', { name: 'zzz' })).error); });
    await t('read_project_file lit un fichier normal', async () => {
        assert(JSON.parse((await s.call('read_project_file', { path: 'data/version.json' })).json().content).version);
    });
    for (const bad of ['data/APIcle.json', 'data/Save_Autre/Save.env', '.git/config', '../../etc/passwd', '/etc/passwd', 'node_modules/../data/APIcle.json', 'tools/livemod/../../data/APIcle.json']) {
        await t(`read_project_file refuse ${bad}`, async () => { assert((await s.call('read_project_file', { path: bad })).isError); });
    }
    await t('read_project_file refuse un binaire', async () => {
        const exe = fs.readdirSync(path.join(__dirname, '..', '..')).find((f) => f.endsWith('.exe'));
        if (!exe) return; assert((await s.call('read_project_file', { path: exe })).isError);
    });
    s.close();

    console.log('http (web actif)');
    const port = 39500 + Math.floor(Math.random() * 400);
    const srv = await startHttp(port);
    const token = JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8')).token;
    const auth = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
    await t('/mcp sans token => 401', async () => { assert.strictEqual((await req(port, { method: 'POST', path: '/mcp', body: '{}' })).status, 401); });
    await t('/mcp mauvais token => 401', async () => { assert.strictEqual((await req(port, { method: 'POST', path: '/mcp', headers: { authorization: 'Bearer x' }, body: '{}' })).status, 401); });
    await t('Host étranger => 403 (anti DNS-rebinding)', async () => { assert.strictEqual((await req(port, { path: '/api/info', headers: { host: 'evil.com' } })).status, 403); });
    await t('Origin étrangère => 403 (anti CSRF)', async () => { assert.strictEqual((await req(port, { path: '/api/info', headers: { origin: 'https://evil.com' } })).status, 403); });
    await t('/mcp avec token => résultat', async () => {
        const r = await req(port, { method: 'POST', path: '/mcp', headers: auth, body: rpcBody({ id: 1, method: 'tools/list' }) });
        assert.strictEqual(r.status, 200); assert.strictEqual(JSON.parse(r.body).result.tools.length, 8);
    });
    await t('notification => 202', async () => { assert.strictEqual((await req(port, { method: 'POST', path: '/mcp', headers: auth, body: rpcBody({ method: 'notifications/initialized' }) })).status, 202); });
    await t('batch JSON-RPC', async () => {
        const body = JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
        const r = JSON.parse((await req(port, { method: 'POST', path: '/mcp', headers: auth, body })).body); assert.strictEqual(r.length, 2);
    });
    await t('JSON invalide => 400', async () => { assert.strictEqual((await req(port, { method: 'POST', path: '/mcp', headers: auth, body: '{oops' })).status, 400); });
    await t('page web et /api/info servis', async () => {
        assert.strictEqual((await req(port, { path: '/' })).status, 200);
        const i = JSON.parse((await req(port, { path: '/api/info' })).body); assert(i.project.games.length && !JSON.stringify(i).includes(token));
    });
    srv.kill();

    console.log('http (--no-web)');
    const port2 = port + 400;
    const srv2 = await startHttp(port2, ['--no-web']);
    await t('web off : / , /api/info, /events => 404', async () => {
        for (const p of ['/', '/api/info', '/events']) assert.strictEqual((await req(port2, { path: p })).status, 404, p);
    });
    await t('web off : /mcp répond toujours', async () => {
        const tok = JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8')).token;
        const r = await req(port2, { method: 'POST', path: '/mcp', headers: { authorization: 'Bearer ' + tok }, body: rpcBody({ id: 1, method: 'ping' }) });
        assert.strictEqual(r.status, 200);
    });
    srv2.kill();

    console.log('cli');
    await t('info / connect token / usage', async () => {
        for (const a of [['info'], ['connect', 'token'], ['connect']]) assert.strictEqual(spawnSync(process.execPath, [JS, ...a], { env: ENV }).status, 0, a.join(' '));
        assert.notStrictEqual(spawnSync(process.execPath, [JS, 'zzz'], { env: ENV }).status, 0);
    });

    fs.rmSync(STATE, { recursive: true, force: true }); fs.rmSync(DATA, { recursive: true, force: true });
    console.log(`\n${passed} ok, ${failed.length} échec(s)`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
