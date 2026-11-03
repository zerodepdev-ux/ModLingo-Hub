#!/usr/bin/env node
'use strict';
// Test du dossier portable : build hors ligne (--node-bin = ce Node, aucun téléchargement), serveur Tradution,
// isolation de config/, conservation de data/, et mise à jour de Node contre un faux nodejs.org local.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const AdmZip = require(path.join(__dirname, '..', '..', 'node_modules', 'adm-zip'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'livemod-build-'));
const OUT = path.join(TMP, 'ModLingo-Hub-live');
const ENV = { ...process.env, LIVEMOD_STATE: '', LIVEMOD_NO_UPDATE: '1' };
delete ENV.LIVEMOD_STATE;
let passed = 0; const failed = [];
async function t(name, fn) { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); } }
const build = () => spawnSync('bash', [path.join(__dirname, 'build.sh'), '--out', OUT, '--node-bin', process.execPath], { encoding: 'utf8' });
// Asynchrone : le faux nodejs.org tourne dans CE processus, il ne doit pas être bloqué pendant que le lanceur travaille.
const launch = (args, env = {}) => new Promise((resolve) => {
    const p = spawn(path.join(OUT, 'LiveMod.sh'), args, { env: { ...ENV, ...env }, cwd: TMP });
    let stdout = '', stderr = ''; p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
});
function req(port, { method = 'GET', p = '/', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: body ? { 'content-type': 'application/json', ...headers } : headers, timeout: 5000 }, (res) => {
            let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
    });
}

(async () => {
    console.log('build');
    let b;
    await t('build.sh --node-bin assemble le dossier', async () => { b = build(); assert.strictEqual(b.status, 0, b.stdout + b.stderr); });
    await t('arborescence : lanceurs, Dependence/{node,Tradution}, config/', async () => {
        for (const f of ['LiveMod.sh', 'LiveMod.cmd', 'livemod.js', 'Livemod_inteface.js', 'node-update.js', 'paths.js', 'README.md', 'locales/en.json', 'config', 'Dependence/node/bin/node',
            'Dependence/Tradution/server-lite.js', 'Dependence/Tradution/translator.js', 'Dependence/Tradution/modules/minecraft.js', 'Dependence/Tradution/modules/config.js', 'Dependence/Tradution/modules/pak.js', 'Dependence/Tradution/modules/translate.js', 'Dependence/Tradution/main.js', 'Dependence/Tradution/node_modules/fast-xml-parser/package.json', 'version.js',
            'Dependence/Tradution/node_modules/express/package.json', 'Dependence/Tradution/node_modules/adm-zip/package.json', 'Dependence/Tradution/data/minecraft/glossary.json', 'Dependence/Tradution/data/Save_Autre/ExSave.env']) assert(fs.existsSync(path.join(OUT, f)), 'manquant : ' + f);
    });
    await t('seulement le nécessaire : pas de BG3/Hytale/admin, pas de cache ni de clés copiés', async () => {
        const mods = fs.readdirSync(path.join(OUT, 'Dependence/Tradution/modules'));
        for (const bad of ['hytale.js', 'ancientdungeon.js', 'backup.js', 'update.js', 'satisfactory.js']) assert(!mods.includes(bad), bad);
        assert(!fs.existsSync(path.join(OUT, 'Dependence/Tradution/data/minecraft/cache.json')));
        assert.strictEqual(fs.readFileSync(path.join(OUT, 'Dependence/Tradution/data/APIcle.json'), 'utf8').trim(), '{}');
        assert(!fs.existsSync(path.join(OUT, 'Dependence/Tradution/data/Save_Autre/Save.env')));
    });
    await t('le lanceur utilise Dependence/node (portable) et range ses réglages dans config/', async () => {
        const r = await launch(['info']);
        assert.strictEqual(r.status, 0, r.stderr); assert(/Node\s+: v[\d.]+ \(portable\)/.test(r.stdout), r.stdout);
        assert(fs.existsSync(path.join(OUT, 'config/config.json')), 'config/config.json absent');
        assert(r.stdout.includes(path.join(OUT, 'Dependence/Tradution/data')), 'le MCP doit lire Dependence/Tradution/data');
    });

    console.log('serveur Tradution (lite)');
    const PORT = 39100 + Math.floor(Math.random() * 500);
    const node = path.join(OUT, 'Dependence/node/bin/node');
    const srv = spawn(node, [path.join(OUT, 'Dependence/Tradution/server-lite.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
    for (let i = 0; i < 50; i++) { try { await req(PORT, { p: '/api/config' }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const inst = path.join(TMP, 'instances'), mods = path.join(inst, 'MonPack/minecraft/mods');
    fs.mkdirSync(mods, { recursive: true });
    const z = new AdmZip(); z.addFile('assets/alpha/lang/en_us.json', Buffer.from(JSON.stringify({ 'item.a': 'A', 'item.b': 'B' }))); z.writeZip(path.join(mods, 'alpha.jar'));
    await t('démarre seul (sans le gros projet) et répond', async () => { const r = await req(PORT, { p: '/api/config' }); assert.strictEqual(r.status, 200, log); });
    await t('refuse un Host étranger (403)', async () => { assert.strictEqual((await req(PORT, { p: '/api/config', headers: { host: 'evil.com' } })).status, 403); });
    await t('refuse une Origin étrangère (403)', async () => { assert.strictEqual((await req(PORT, { p: '/api/config', headers: { origin: 'https://evil.com' } })).status, 403); });
    await t('Minecraft : dossier d\'instances, liste et scan d\'un modpack', async () => {
        const set = await req(PORT, { method: 'POST', p: '/api/config', body: { minecraftInstancesFolder: inst } }); assert.strictEqual(set.status, 200);
        const list = JSON.parse((await req(PORT, { p: '/api/minecraft/instances' })).body); assert(list.found && list.instances.some((i) => i.name === 'MonPack'), JSON.stringify(list).slice(0, 300));
        const scan = JSON.parse((await req(PORT, { p: '/api/minecraft/mods-scan?instance=MonPack' })).body);
        assert.strictEqual(scan.totalMods, 1); assert.strictEqual(scan.needTranslation, 1, JSON.stringify(scan).slice(0, 300));
    });
    await t('BG3 : le serveur Tradution lit de vrais .pak (liste, langue française déjà présente)', async () => {
        const { writeLSPK, buildLoca } = require(path.join(OUT, 'Dependence/Tradution/lspk.js'));
        const modsDir = path.join(TMP, 'bg3mods'); fs.mkdirSync(modsDir, { recursive: true });
        const info = { flags: 0, priority: 0, md5: Buffer.alloc(16, 0), numParts: 1 };
        const loca = (uid, text) => buildLoca([{ uid, version: 1, text }]);
        await writeLSPK(path.join(modsDir, 'Neuf.pak'), info, [{ name: 'Mods/Neuf/Localization/English/neuf.loca', data: loca('h0001', 'Hello') }]);
        await writeLSPK(path.join(modsDir, 'Deja.pak'), info, [{ name: 'Mods/Deja/Localization/English/deja.loca', data: loca('h0002', 'Hello') }, { name: 'Mods/Deja/Localization/French/deja.loca', data: loca('h0002', 'Bonjour') }]);
        assert.strictEqual((await req(PORT, { method: 'POST', p: '/api/config', body: { modsFolder: modsDir } })).status, 200);
        const list = JSON.parse((await req(PORT, { p: '/api/paks' })).body);
        assert.deepStrictEqual(list.paks.map((x) => [x.name, x.translatableFiles]), [['Deja.pak', 2], ['Neuf.pak', 1]], JSON.stringify(list).slice(0, 300));
        const lang = async (n) => JSON.parse((await req(PORT, { p: `/api/pak/${n}/has-language?lang=fr` })).body);
        assert.strictEqual((await lang('Neuf.pak')).hasTarget, false); const d = await lang('Deja.pak');
        assert.strictEqual(d.hasTarget, true); assert.strictEqual(d.stringCount, 1);
        assert.strictEqual((await req(PORT, { p: '/api/translate/status' })).status, 200, 'module de traduction BG3 chargé');
        assert(fs.existsSync(path.join(OUT, 'Dependence/Tradution/main.js')), 'main.js (lancé par la traduction) présent');
    });
    await t('les réglages vont dans Dependence/Tradution/data (pas dans le projet)', async () => {
        assert(fs.existsSync(path.join(OUT, 'Dependence/Tradution/data/confightml.json')));
    });
    srv.kill('SIGTERM'); await new Promise((r) => srv.on('close', r));

    console.log('reconstruction');
    await t('rebuild : data/ conservé, code remplacé', async () => {
        const cache = path.join(OUT, 'Dependence/Tradution/data/minecraft/cache.json'); fs.writeFileSync(cache, '{"mon":"cache"}');
        fs.writeFileSync(path.join(OUT, 'Dependence/Tradution/modules/zzz-vieux.js'), '//');
        const r = build(); assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        assert.strictEqual(fs.readFileSync(cache, 'utf8'), '{"mon":"cache"}'); assert(!fs.existsSync(path.join(OUT, 'Dependence/Tradution/modules/zzz-vieux.js')));
        assert(JSON.parse(fs.readFileSync(path.join(OUT, 'Dependence/Tradution/data/confightml.json'), 'utf8')).minecraftInstancesFolder === inst, 'réglages perdus');
    });

    console.log('mise à jour de Node (faux nodejs.org local)');
    const cur = process.version, major = cur.split('.')[0];
    const NEWV = `${major}.99.0`;
    const real = process.execPath;
    const stage = path.join(TMP, 'stage', `node-${NEWV}-${process.platform}-${process.arch}`); fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'bin/node'), `#!/bin/sh\nif [ "$1" = "-v" ]; then echo ${NEWV}; exit 0; fi\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const archiveName = `node-${NEWV}-${process.platform}-${process.arch}.tar.gz`; const archive = path.join(TMP, archiveName);
    assert.strictEqual(spawnSync('tar', ['-czf', archive, '-C', path.join(TMP, 'stage'), path.basename(stage)]).status, 0);
    const good = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    let mode = 'good', indexVersions = [{ version: NEWV, lts: 'Jod' }, { version: 'v99.0.0', lts: 'Zed' }, { version: `${major}.100.0`, lts: false }];
    const dist = http.createServer((q, r) => {
        if (q.url === '/index.json') return r.end(JSON.stringify(indexVersions));
        if (q.url === `/${NEWV}/SHASUMS256.txt`) return r.end(`${mode === 'bad' ? '0'.repeat(64) : good}  ${archiveName}\n`);
        if (q.url === `/${NEWV}/${archiveName}`) return r.end(fs.readFileSync(archive));
        r.statusCode = 404; r.end();
    });
    await new Promise((r) => dist.listen(0, '127.0.0.1', r));
    const D = { LIVEMOD_NODE_DIST: `http://127.0.0.1:${dist.address().port}` };
    const dep = (p) => path.join(OUT, 'Dependence', p);
    const stamp = path.join(OUT, 'config/node-update.json');

    await t('empreinte fausse => rejetée, rien n\'est installé', async () => {
        mode = 'bad'; const r = await launch(['update-node'], D);
        assert(/Échec : empreinte SHA-256 différente/.test(r.stdout), r.stdout); assert(!fs.existsSync(dep('node.new')));
        assert(fs.readdirSync(path.join(OUT, 'config')).every((f) => !f.endsWith('.part')) && !fs.existsSync(path.join(OUT, 'config/cache', archiveName + '.part')));
    });
    await t('HTTPS exigé hors 127.0.0.1', async () => {
        const r = await launch(['update-node'], { LIVEMOD_NODE_DIST: 'http://example.com/dist' }); assert(/HTTPS requis/.test(r.stdout), r.stdout);
    });
    await t('seulement la même version majeure, LTS (ni v99, ni non-LTS)', async () => {
        indexVersions = [{ version: 'v99.0.0', lts: 'Zed' }, { version: `${major}.100.0`, lts: false }];
        const r = await launch(['update-node'], D); assert(/Déjà à jour/.test(r.stdout), r.stdout); assert(!fs.existsSync(dep('node.new')));
        indexVersions = [{ version: NEWV, lts: 'Jod' }, { version: 'v99.0.0', lts: 'Zed' }];
    });
    const autoCheck = (m) => new Promise((resolve) => {
        const p = spawn(dep('node/bin/node'), ['-e', `require('./node-update').check({ mode: '${m}' }).then((r) => console.log(JSON.stringify(r)))`], { cwd: OUT, env: { ...ENV, ...D } });
        let o = ''; p.stdout.on('data', (d) => { o += d; }); p.on('close', () => resolve(JSON.parse(o.trim().split('\n').pop())));
    });
    await t('vérification automatique, mode ask : signale sans rien télécharger', async () => {
        mode = 'good'; fs.rmSync(stamp, { force: true });
        const r = await autoCheck('ask'); assert.deepStrictEqual({ status: r.status, version: r.version }, { status: 'available', version: NEWV });
        assert(!fs.existsSync(dep('node.new')));
    });
    await t('vérification automatique, mode off : ignorée', async () => {
        fs.rmSync(stamp, { force: true }); assert.strictEqual((await autoCheck('off')).status, 'skipped'); assert(!fs.existsSync(dep('node.new')));
    });
    await t('vérification automatique : au plus une fois par 24 h', async () => {
        fs.rmSync(stamp, { force: true }); await autoCheck('ask');
        assert.strictEqual((await autoCheck('ask')).status, 'skipped');
    });
    await t('bonne empreinte => préparée (node.new/.ready), runtime courant intact', async () => {
        mode = 'good'; const r = await launch(['update-node'], D);
        assert(/téléchargé et vérifié \(SHA-256\)/.test(r.stdout), r.stdout); assert(fs.existsSync(dep('node.new/.ready')));
        assert.strictEqual(spawnSync(dep('node/bin/node'), ['-v'], { encoding: 'utf8' }).stdout.trim(), cur);
    });
    await t('lancement suivant : le lanceur échange, ancien gardé dans node.old', async () => {
        const r = await launch(['info']); assert.strictEqual(r.status, 0, r.stderr);
        assert(fs.existsSync(dep('node.old')) && !fs.existsSync(dep('node.new')));
        assert.strictEqual(spawnSync(dep('node/bin/node'), ['-v'], { encoding: 'utf8' }).stdout.trim(), NEWV);
        assert(!fs.existsSync(dep('node/.ready')));
    });
    await t('nouveau Node cassé => retour automatique à l\'ancien', async () => {
        fs.mkdirSync(dep('node.new/bin'), { recursive: true }); fs.writeFileSync(dep('node.new/bin/node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }); fs.writeFileSync(dep('node.new/.ready'), '{}');
        const r = await launch(['info']); assert(/mise à jour de Node annulée/.test(r.stderr), r.stderr + r.stdout);
        assert.strictEqual(spawnSync(dep('node/bin/node'), ['-v'], { encoding: 'utf8' }).stdout.trim(), NEWV);
    });
    dist.close();

    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\n${passed} ok, ${failed.length} échec(s)`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
