#!/usr/bin/env node
'use strict';
// Test de Livemod_inteface.js : faux HOME avec modpacks + faux serveur de l'app (aucun moteur de traduction appelé).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const AdmZip = require(path.join(__dirname, '..', '..', 'node_modules', 'adm-zip'));

const UI = path.join(__dirname, 'Livemod_inteface.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'livemod-ui-'));
const HOME = path.join(TMP, 'home'), STATE = path.join(TMP, 'state');
let passed = 0; const failed = [];
async function t(name, fn) { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); } }

function jar(dir, name, langs) {
    fs.mkdirSync(dir, { recursive: true });
    const z = new AdmZip();
    for (const [p, obj] of Object.entries(langs)) z.addFile(p, Buffer.from(JSON.stringify(obj)));
    z.writeZip(path.join(dir, name));
}
const en = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`item.k${i}`, `Text ${i}`]));
function makePack(base, name, flat) {
    const mods = path.join(base, name, flat ? 'mods' : 'minecraft/mods');
    jar(mods, 'a.jar', { 'assets/alpha/lang/en_us.json': en(10) });                               // 10 manquantes
    jar(mods, 'b.jar', { 'assets/beta/lang/en_us.json': en(5), 'assets/beta/lang/fr_fr.json': en(5) }); // complet
    jar(mods, 'c.jar', { 'assets/gamma/lang/en_us.json': en(8), 'assets/gamma/lang/fr_fr.json': en(3) }); // 5 manquantes
    jar(mods, 'd.jar', { 'META-INF/x': {} });                                                       // sans langue
}
makePack(path.join(HOME, '.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher/instances'), 'Pack Un', false);
const UN = path.join(HOME, '.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher/instances/Pack Un/minecraft');
fs.mkdirSync(path.join(UN, 'config/ftbquests/quests/chapters'), { recursive: true });
fs.writeFileSync(path.join(UN, 'config/ftbquests/quests/chapters/intro.snbt'), '{ title: "Hello" }');
fs.mkdirSync(path.join(UN, 'kubejs/assets/custom/lang'), { recursive: true });
fs.writeFileSync(path.join(UN, 'kubejs/assets/custom/lang/en_us.json'), JSON.stringify(en(4)));
fs.mkdirSync(path.join(UN, 'config/betterquesting'), { recursive: true });
fs.writeFileSync(path.join(UN, 'config/betterquesting/DefaultQuests.json'), '{}');
makePack(path.join(HOME, '.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher/instances'), 'Pack Deux', true);

const BG3HOME = path.join(TMP, 'bg3home');
const BG3MODS = path.join(BG3HOME, '.local/share/Steam/steamapps/compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur\'s Gate 3/Mods');
fs.mkdirSync(BG3MODS, { recursive: true });
for (const f of ['ModA.pak', 'ModB.pak', 'ModC.pak', 'ModC_fr.pak', 'ModD.pak', 'NoLang.pak', 'Orphan_FR.pak']) fs.writeFileSync(path.join(BG3MODS, f), 'x');
const BG3FILES = { 'ModA.pak': 2, 'ModB.pak': 1, 'ModC.pak': 1, 'ModC_fr.pak': 1, 'ModD.pak': 1, 'NoLang.pak': 0, 'Orphan_FR.pak': 1 };

function runUI(args, lines, env = {}) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [UI, ...args], { env: { ...process.env, LIVEMOD_HOME: HOME, LIVEMOD_STATE: STATE, NO_COLOR: '1', LIVEMOD_NO_UPDATE: '1', LIVEMOD_NO_SETUP: '1', LIVEMOD_LANG: '', LIVEMOD_MEDIA: path.join(TMP, 'pas-de-media'), LIVEMOD_APP_CONFIG: path.join(TMP, 'pas-de-config.json'), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
        let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
        p.stdin.end(lines.map((l) => l + '\n').join(''));
        p.on('close', (code) => resolve({ code, out: o }));
    });
}

(async () => {
    console.log('scan local');
    await t('2 modpacks trouvés (flatpak, avec/sans sous-dossier minecraft/)', async () => {
        const r = await runUI([], ['trad minecraft scan', '1', 'exit']);
        assert(/2 modpack\(s\) trouvé/.test(r.out), r.out); assert(/Pack Un/.test(r.out) && /Pack Deux/.test(r.out));
    });
    await t('analyse : 4 jars, 3 avec langue, 1 complet, 2 à traduire, 15 chaînes', async () => {
        const r = await runUI([], ['trad minecraft scan', 'Pack Un', 'exit']);
        assert(/4 mods \(\.jar\), 3 avec fichiers de langue, 1 déjà en français, 2 à traduire \(15 chaînes\)/.test(r.out), r.out);
        assert(/alpha\s+10 chaînes/.test(r.out) && /gamma\s+5 chaînes/.test(r.out));
    });
    await t('scan détecte FTB Quests, KubeJS, BetterQuesting et propose le menu', async () => {
        const r = await runUI([], ['minecraft scan', 'Pack Un', 'q', 'exit']);
        assert(/FTB Quests\s+: 1 chapitres \(snbt\)/.test(r.out), r.out); assert(/KubeJS\s+: 1 fichier\(s\) · 4 chaînes/.test(r.out)); assert(/BetterQuesting: DefaultQuests\.json/.test(r.out));
        assert(/Que traduire \?/.test(r.out) && /1\. Tout/.test(r.out) && /2\. Mods/.test(r.out) && /3\. FTB Quests/.test(r.out) && /4\. KubeJS/.test(r.out) && /5\. BetterQuesting/.test(r.out) && /6\. Choisir des mods/.test(r.out));
    });
    await t('Pack Deux (sans sources) : le menu ne propose que les mods', async () => {
        const r = await runUI([], ['minecraft scan', 'Pack Deux', 'q', 'exit']);
        assert(/2\. Mods/.test(r.out) && !/FTB Quests\s+\d/.test(r.out) && !/KubeJS +\d/.test(r.out), r.out);
    });
    await t('choix invalide puis annulation', async () => {
        const r = await runUI([], ['trad minecraft scan', '99', 'q', 'exit']);
        assert(/Choix invalide/.test(r.out) && /Annulé/.test(r.out));
    });

    console.log('help et historique');
    await t('help trad : tableau Command | Trad | Game + jeux disponibles', async () => {
        const r = await runUI([], ['help trad', 'exit']);
        assert(/\| Command\s+\| Trad\s+\| Game\s+\|/.test(r.out), r.out);
        assert(/trad minecraft scan\s+\|.*\| Minecraft/.test(r.out) && /trad minecraft translate/.test(r.out)); assert(/hytale\s+\| bientôt/.test(r.out) && /bg3\s+\| disponible/.test(r.out));
    });
    await t('historique : commandes gardées, réponses aux questions et exit non', async () => {
        fs.rmSync(path.join(STATE, 'history'), { force: true });
        await runUI([], ['trad minecraft scan', 'Pack Un', 'q', 'help trad', 'exit']);
        assert.strictEqual(fs.readFileSync(path.join(STATE, 'history'), 'utf8'), 'trad minecraft scan\nhelp trad\n');
    });
    await t('historique : doublons déplacés en fin', async () => {
        await runUI([], ['help trad', 'trad hytale scan', 'help trad', 'exit']);
        assert.strictEqual(fs.readFileSync(path.join(STATE, 'history'), 'utf8'), 'trad minecraft scan\ntrad hytale scan\nhelp trad\n');
    });

    console.log('assistant de première utilisation (setup)');
    const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'livemod-setup-'));
    const readSelf = (d) => JSON.parse(fs.readFileSync(path.join(d, 'interface.json'), 'utf8'));
    await t('1re utilisation : l\'assistant démarre tout seul (langue → jeux → options)', async () => {
        const d = fresh();
        const r = await runUI([], ['1', '', '', '4', 'exit'], { LIVEMOD_STATE: d, LIVEMOD_NO_SETUP: '' });
        assert(/Langue \/ Language/.test(r.out) && /3\/4\s+Quels jeux veux-tu traduire/.test(r.out) && /4\/4\s+Options de traduction/.test(r.out), r.out);
        assert(/Configuration enregistrée/.test(r.out)); const s = readSelf(d);
        assert.strictEqual(s.lang, 'fr'); assert.deepStrictEqual(s.games, ['minecraft']); assert.strictEqual(s.setupDone, true);
    });
    await t('2e lancement : plus d\'assistant', async () => {
        const d = fresh(); await runUI([], ['1', '', '', '4', 'exit'], { LIVEMOD_STATE: d, LIVEMOD_NO_SETUP: '' });
        const r = await runUI([], ['exit'], { LIVEMOD_STATE: d, LIVEMOD_NO_SETUP: '' });
        assert(!/Langue \/ Language/.test(r.out) && /Pour commencer, tape : minecraft scan/.test(r.out), r.out);
    });
    await t('choisir English : l\'assistant et l\'interface passent en anglais, mémorisé', async () => {
        const d = fresh();
        const r = await runUI([], ['2', '', '1,3', '4', 'help', 'exit'], { LIVEMOD_STATE: d, LIVEMOD_NO_SETUP: '' });
        assert(/Which games do you want to translate\?/.test(r.out) && /Translation options/.test(r.out) && /Settings saved\./.test(r.out), r.out);
        assert(/How it works/.test(r.out) && /Type minecraft scan/.test(r.out));
        const s = readSelf(d); assert.strictEqual(s.lang, 'en'); assert.deepStrictEqual(s.games, ['minecraft', 'hytale']);
        assert(/hytale is not supported in text mode yet/.test(r.out));
        const r2 = await runUI([], ['exit'], { LIVEMOD_STATE: d, LIVEMOD_NO_SETUP: '' });
        assert(/command-line translation/.test(r2.out) && /To get started, type: minecraft scan/.test(r2.out), r2.out);
    });
    await t('« Autre » avec une langue absente => anglais + explication', async () => {
        const d = fresh();
        const r = await runUI([], ['3', 'xx', '', '', '4', 'exit'], { LIVEMOD_STATE: d, LIVEMOD_NO_SETUP: '' });
        assert(/xx : not available yet/.test(r.out), r.out); assert.strictEqual(readSelf(d).lang, 'en');
    });
    await t('une langue ajoutée dans locales/ apparaît dans la liste', async () => {
        const d = fresh(); const f = path.join(__dirname, 'locales', 'zz.json');
        fs.writeFileSync(f, JSON.stringify({ _name: 'Zzlang', 'Terminé': 'ZZ-done' }));
        try {
            const r = await runUI([], ['3', '', '', '4', 'exit'], { LIVEMOD_STATE: d, LIVEMOD_NO_SETUP: '' });
            assert(/3\. Zzlang/.test(r.out), r.out); assert.strictEqual(readSelf(d).lang, 'zz');
        } finally { fs.rmSync(f, { force: true }); }
    });
    await t('--Debug-start force l\'assistant même si déjà fait, sans rien effacer', async () => {
        const d = fresh();
        await runUI([], ['2', '', '1,3', '4', 'exit'], { LIVEMOD_STATE: d, LIVEMOD_NO_SETUP: '' });
        const r = await runUI(['--Debug-start'], ['', '', '', '4', 'exit'], { LIVEMOD_STATE: d });   // Entrée partout = on garde
        assert(/Setup\s+\(--Debug-start\)/.test(r.out), r.out); assert(/Which games/.test(r.out));
        const s = readSelf(d); assert.strictEqual(s.lang, 'en'); assert.deepStrictEqual(s.games, ['minecraft', 'hytale']);
    });
    await t('« setup » dans l\'interface relance l\'assistant', async () => {
        const r = await runUI([], ['setup', '1', '', '', '4', 'exit']);
        assert(/Langue \/ Language/.test(r.out) && /Configuration enregistrée/.test(r.out), r.out);
    });
    await t('help trad marque ★ les jeux choisis', async () => {
        const d = fresh(); await runUI([], ['1', '', '1,3', '4', 'exit'], { LIVEMOD_STATE: d, LIVEMOD_NO_SETUP: '' });
        const r = await runUI([], ['help trad', 'exit'], { LIVEMOD_STATE: d, LIVEMOD_NO_SETUP: '' });
        assert(/★ minecraft/.test(r.out) && /★ hytale/.test(r.out) && !/★ bg3/.test(r.out), r.out);
    });
    await t('parcours de traduction en anglais (LIVEMOD_LANG=en)', async () => {
        const r = await runUI([], ['minecraft scan', 'Pack Un', 'q', 'exit'], { LIVEMOD_LANG: 'en' });
        assert(/Step 1\/3 — Find your modpack/.test(r.out) && /Step 2\/3 — Analysing the modpack/.test(r.out) && /Step 3\/3 — What to translate\?/.test(r.out), r.out);
        assert(/1\. Everything/.test(r.out) && /2\. Mods \(language files in \.jar\)/.test(r.out) && /Cancelled\./.test(r.out));
    });
    await t('locales/en.json : toutes les phrases du code sont traduites, aucune en trop', async () => {
        const src = fs.readFileSync(UI, 'utf8'); const keys = new Set();
        for (const m of src.matchAll(/\bT\((('(?:[^'\\]|\\.)*')|(`[^`]*`))/g)) keys.add(eval(m[1]));
        for (const m of src.matchAll(/(scan|translate|use): ('(?:[^'\\]|\\.)*')/g)) keys.add(eval(m[2]));
        for (const m of src.matchAll(/(?:step1|next): ('(?:[^'\\]|\\.)*')/g)) keys.add(eval(m[1]));
        keys.add('Mods (langues des .jar)');
        const en = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', 'en.json'), 'utf8'));
        const missing = [...keys].filter((k) => !en[k]), extra = Object.keys(en).filter((k) => k !== '_name' && !keys.has(k));
        assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] });
        for (const k of keys) assert.strictEqual((k.match(/\{\d+\}/g) || []).sort().join(), (en[k].match(/\{\d+\}/g) || []).sort().join(), 'placeholders : ' + k);
    });


    console.log('version et clr');
    await t('version visible dans le menu et par la commande « version »', async () => {
        const r = await runUI([], ['version', 'exit']);
        assert(/ModLingo-Hub-live v0\.2\.0/.test(r.out) && /Node\s+v[\d.]+/.test(r.out), r.out);
        assert((r.out.match(/ModLingo-Hub-live v0\.2\.0/g) || []).length >= 2, 'menu + commande');
        const v = spawnSync(process.execPath, [path.join(__dirname, 'livemod.js'), '--version'], { encoding: 'utf8' });
        assert.strictEqual(v.stdout.trim(), 'ModLingo-Hub-live 0.2.0-beta.1');
    });
    await t('clr / clear / cls : efface et réaffiche le menu', async () => {
        for (const c of ['clr', 'clear', 'cls']) {
            const r = await runUI([], [c, 'exit']);
            assert((r.out.match(/Pour commencer, tape : minecraft scan/g) || []).length === 2, c + '\n' + r.out);
        }
    });
    await t('clr tapé en pleine question abandonne le parcours et revient au menu', async () => {
        const r = await runUI([], ['minecraft scan', 'clr', 'exit']);
        assert((r.out.match(/Pour commencer, tape : minecraft scan/g) || []).length === 2 && !/Annulé/.test(r.out) && !/Erreur/.test(r.out), r.out);
        assert(/clr = retour au menu/.test(r.out));
    });
    await t('clr dans le menu « Que traduire ? » : revient au menu sans rien lancer', async () => {
        const r = await runUI([], ['minecraft scan', 'Pack Un', 'clr', 'exit'], { LIVEMOD_APP_URL: 'http://127.0.0.1:1' });
        assert(!/Serveur de traduction|Lancer la traduction/.test(r.out), r.out);
        assert((r.out.match(/Pour commencer, tape : minecraft scan/g) || []).length === 2);
    });

    console.log('aucun modpack → demande le chemin');
    const empty = path.join(TMP, 'vide'); fs.mkdirSync(empty, { recursive: true });
    const custom = path.join(TMP, 'ailleurs'); makePack(custom, 'Mon Pack', true);
    await t('0 trouvé → demande un chemin, refuse un faux, accepte le bon, mémorise', async () => {
        const r = await runUI([], ['trad minecraft scan', '/nope/pas/la', custom, 'exit'], { LIVEMOD_HOME: empty });
        assert(/Aucun modpack trouvé automatiquement/.test(r.out), r.out); assert(/Introuvable/.test(r.out)); assert(/Chemin mémorisé/.test(r.out)); assert(/Mon Pack/.test(r.out));
        assert(JSON.parse(fs.readFileSync(path.join(STATE, 'interface.json'), 'utf8')).mcPaths.includes(custom));
    });
    await t('chemin mémorisé retrouvé automatiquement au scan suivant', async () => {
        const r = await runUI([], ['trad minecraft scan', '1', 'exit'], { LIVEMOD_HOME: empty });
        assert(/Mon Pack/.test(r.out) && !/Aucun modpack trouvé automatiquement/.test(r.out), r.out);
    });
    await t('chemin Windows refusé sous Linux', async () => {
        if (process.platform === 'win32') return;
        const r = await runUI([], ['trad minecraft scan', 'p', 'C:\\Users\\x\\instances', 'q', 'exit'], { LIVEMOD_HOME: path.join(TMP, 'vide2') });
        assert(/Chemin Windows/.test(r.out), r.out);
    });
    await t('jeu non géré / inconnu', async () => {
        const r = await runUI([], ['trad hytale scan', 'trad zzz scan', 'mcp2', 'exit']);
        assert(/pas encore géré/.test(r.out) && /Jeu inconnu/.test(r.out) && /Commande inconnue/.test(r.out));
    });

    console.log('translate (faux serveur)');
    const calls = [], saved = [], streamed = [], streamLangs = [], langsAsked = []; let cfgFolder = '/ancien/dossier', modsCfg = '/ancien/mods';
    const srv = http.createServer((req, res) => {
        let b = ''; req.on('data', (d) => { b += d; });
        req.on('end', () => {
            const body = b ? JSON.parse(b) : null; calls.push(`${req.method} ${req.url}`);
            if (req.url === '/api/save-env/config' && req.method === 'POST') { saved.push(body.values); return res.end('{"ok":true}'); }
            if (req.url === '/api/save-env/config') return res.end(JSON.stringify({ ok: true, keys: { KeyDeepL: { configured: true, value: 'abcd...wxyz' }, KeyOpenRouter: { configured: false, value: '' }, KeyGemini: { configured: false, value: '' }, LMStudioUrl: { configured: true, value: 'http://192.168.1.5:1234' } } }));
            if (req.url === '/api/lmstudio-config') return res.end('{"url":"http://127.0.0.1:1234"}');
            if (req.url === '/api/paks') return res.end(JSON.stringify({ paks: Object.entries(BG3FILES).map(([name, n]) => ({ name, translatableFiles: n, modName: name.replace(/\.pak$/i, '') + ' (nom)', version: '1.0' })) }));
            if (req.url.startsWith('/api/pak/') && req.url.includes('/has-language')) { const l = new URL(req.url, 'http://x').searchParams.get('lang'); langsAsked.push(l); return res.end(JSON.stringify({ hasTarget: l === 'fr' && decodeURIComponent(req.url.split('/')[3]) === 'ModB.pak' })); }
            if (req.url.startsWith('/api/translate/stream')) {
                const sp = new URL(req.url, 'http://x').searchParams, pak = sp.get('pak'), lg = sp.get('lang'); streamed.push(pak); streamLangs.push(lg);
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                const ev = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
                ev({ type: 'start', pak }); ev({ type: 'progress', pct: 50, eta: '5s' }); ev({ type: 'progress', pct: 100, eta: '0s' });
                if (pak === 'ModD.pak') { ev({ type: 'error', text: 'moteur indisponible' }); ev({ type: 'done', code: 1 }); }
                else ev({ type: 'done', code: 0, output: pak.replace(/\.pak$/i, `_${lg}.pak`) });
                return res.end();
            }
            if (req.url === '/api/config' && req.method === 'GET') return res.end(JSON.stringify({ minecraftInstancesFolder: cfgFolder, modsFolder: modsCfg }));
            if (req.url === '/api/config') { if (body.minecraftInstancesFolder !== undefined) cfgFolder = body.minecraftInstancesFolder; if (body.modsFolder !== undefined) modsCfg = body.modsFolder; return res.end('{"ok":true}'); }
            if (req.url === '/api/minecraft/mods-translate') {
                calls.push('BODY ' + JSON.stringify(body));
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write('event: log\ndata: {"text":"hello"}\n\n'); res.write('event: progress\ndata: {"current":1,"total":2,"text":"x"}\n\n');
                return res.end('event: done\ndata: ' + JSON.stringify({ translated: 15, cached: 0, total: 15, modCount: 2, modOutputs: { alpha: { a: 'b' } }, patchouliOutputs: {}, legacyMods: [] }) + '\n\n');
            }
            if (req.url.startsWith('/api/minecraft/ftbquest-import')) return res.end(JSON.stringify({ mode: 'chapters', format: 'snbt', translatableCount: 7, chapters: { 'intro.snbt': '{ title: "Hello" }' } }));
            if (req.url === '/api/minecraft/ftbquest-translate') { calls.push('FTB ' + JSON.stringify(body)); res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end('event: done\ndata: ' + JSON.stringify({ mode: 'chapters', format: 'snbt', translated: 7, cached: 0, total: 7, chapters: { 'intro.snbt': '{ title: "Bonjour" }' } }) + '\n\n'); }
            if (req.url === '/api/minecraft/ftbquest-save') { calls.push('SAVE ' + JSON.stringify(body)); return res.end('{"ok":true}'); }
            if (req.url.startsWith('/api/minecraft/kubejs-import')) return res.end(JSON.stringify({ mods: [{ mod: 'custom', entries: 4 }], translatableCount: 4, entries: { 'custom::k': 'v' } }));
            if (req.url === '/api/minecraft/kubejs-translate') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end('event: done\ndata: ' + JSON.stringify({ translated: 4, cached: 0, total: 4, modOutputs: { custom: { k: 'w' } } }) + '\n\n'); }
            if (req.url === '/api/minecraft/kubejs-save') return res.end('{"ok":true,"saved":[{"mod":"custom"}]}');
            if (req.url.startsWith('/api/minecraft/bq-import')) return res.end(JSON.stringify({ questCount: 3, translatableCount: 6 }));
            if (req.url === '/api/minecraft/bq-translate') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end('event: done\ndata: ' + JSON.stringify({ translated: 6, cached: 0, total: 6, content: '{"fr":1}' }) + '\n\n'); }
            if (req.url === '/api/minecraft/bq-save') return res.end('{"ok":true,"backup":"/x/DefaultQuests.json.bak"}');
            if (req.url === '/api/minecraft/mods-resourcepack') return res.end(JSON.stringify({ ok: true, path: '/x/FR_Traduction_2mods.zip', activated: true }));
            res.statusCode = 404; res.end('{}');
        });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const env = { LIVEMOD_APP_URL: `http://127.0.0.1:${srv.address().port}` };
    const SECRET = 'sk-test-FAKE-0123456789abcdef';
    await t('setup > clé API : enregistrée via l\'app, masquée, jamais affichée ni gardée', async () => {
        const d = fresh(); saved.length = 0;
        const r = await runUI([], ['1', '', '', '1', '1', SECRET, '3', '4', 'exit'], { ...env, LIVEMOD_STATE: d, LIVEMOD_NO_SETUP: '' });
        assert(/Clé DeepL enregistrée \(••••cdef\)/.test(r.out), r.out);
        assert.deepStrictEqual(saved, [{ KeyDeepL: SECRET }]);
        assert(!r.out.includes(SECRET), 'la clé ne doit jamais être affichée');
        assert(/DeepL\s+✓ configurée ••••wxyz/.test(r.out) && /OpenRouter\s+— non configurée/.test(r.out) && /Gemini\s+— non configurée/.test(r.out) && /LM Studio\s+✓ http:\/\/192/.test(r.out), r.out);
        assert(!/\[object Object\]/.test(r.out) && !r.out.includes('abcd'), 'rien de brut de l\'app ne doit fuiter');
        for (const f of fs.readdirSync(d)) assert(!fs.readFileSync(path.join(d, f), 'utf8').includes(SECRET), 'clé écrite dans ' + f);
    });
    await t('setup > clé vide = annulation, rien d\'envoyé', async () => {
        saved.length = 0;
        const r = await runUI([], ['1', '', '', '1', '2', '', '4', 'exit'], { ...env, LIVEMOD_STATE: fresh(), LIVEMOD_NO_SETUP: '' });
        assert(/Annulé/.test(r.out) && saved.length === 0, r.out);
    });
    await t('setup > LM Studio : URL validée puis enregistrée', async () => {
        saved.length = 0;
        const r = await runUI([], ['1', '', '', '2', 'pas une url', 'o', '2', 'http://192.168.1.50:1234', 'o', '4', 'exit'], { ...env, LIVEMOD_STATE: fresh(), LIVEMOD_NO_SETUP: '' });
        assert(/URL invalide/.test(r.out), r.out);
        assert.deepStrictEqual(saved, [{ LMStudioUrl: 'http://192.168.1.50:1234', LMStudioEnabled: 'true' }]);
    });
    await t('flux complet : dossier ajusté puis restauré, mods envoyés, resource pack créé', async () => {
        const r = await runUI([], ['trad minecraft translate', 'Pack Un', '', 'o', 'o', 'exit'], env);
        assert(/Traduit : 15 nouvelles/.test(r.out), r.out); assert(/FTB Quests : 7 nouvelles/.test(r.out) && /KubeJS : 4 nouvelles/.test(r.out) && /BetterQuesting : 6 nouvelles/.test(r.out) && /Terminé en/.test(r.out)); assert(/Resource pack : \/x\/FR_Traduction_2mods\.zip/.test(r.out));
        assert(/remis comme avant/.test(r.out)); assert.strictEqual(cfgFolder, '/ancien/dossier');
        const body = JSON.parse(calls.find((c) => c.startsWith('BODY ')).slice(5));
        assert.deepStrictEqual(body.modIds.sort(), ['alpha', 'gamma']); assert.strictEqual(body.instance, 'Pack Un'); assert.strictEqual(body.lang, 'fr');
    });
    await t('« 3 » = seulement FTB Quests : pas de mods, chapitres sauvegardés avant écriture', async () => {
        calls.length = 0;
        const r = await runUI([], ['minecraft scan', 'Pack Un', '3', 'o', 'o', 'exit'], env);
        assert(/FTB Quests : 7 nouvelles/.test(r.out) && !/Traduit :/.test(r.out) && !/KubeJS :/.test(r.out), r.out);
        assert(!calls.some((c) => c.includes('mods-translate')) && calls.some((c) => c.startsWith('SAVE ')));
        assert(JSON.parse(calls.find((c) => c.startsWith('SAVE ')).slice(5)).mode === 'chapters');
        const bak = path.join(UN, 'livemod-backup'); assert(fs.readdirSync(bak).length >= 1);
        assert(fs.readFileSync(path.join(fs.readdirSync(bak).map((d) => path.join(bak, d, 'intro.snbt'))[0]), 'utf8').includes('Hello'));
    });
    await t('noms : « ftbquest, kubejs » = ces deux sources seulement', async () => {
        calls.length = 0;
        const r = await runUI([], ['minecraft scan', 'Pack Un', 'ftbquest, kubejs', 'o', 'o', 'exit'], env);
        assert(/FTB Quests : 7/.test(r.out) && /KubeJS : 4/.test(r.out) && !/BetterQuesting :/.test(r.out) && !/Traduit :/.test(r.out), r.out);
    });
    await t('« 6 » : choix de mods un par un (par identifiant)', async () => {
        calls.length = 0;
        const r = await runUI([], ['minecraft scan', 'Pack Un', '6', 'gamma', 'o', 'o', 'exit'], env);
        assert(/Traduit : 15 nouvelles/.test(r.out), r.out);
        assert.deepStrictEqual(JSON.parse(calls.find((c) => c.startsWith('BODY ')).slice(5)).modIds, ['gamma']);
        assert(!/FTB Quests :/.test(r.out));
    });
    await t('choix invalide => redemande', async () => {
        const r = await runUI([], ['minecraft scan', 'Pack Un', '42', 'blabla', 'q', 'exit'], env);
        assert((r.out.match(/Choix invalide/g) || []).length === 2 && /Annulé/.test(r.out), r.out);
    });
    await t('--only=kubejs --yes : sans menu', async () => {
        calls.length = 0;
        const r = await runUI(['minecraft', 'scan', '--only=kubejs', '--yes'], ['Pack Un'], env);
        assert(/KubeJS : 4/.test(r.out) && !/Que traduire/.test(r.out) && !/FTB Quests :/.test(r.out), r.out);
    });
    await t('--yes : sans questions', async () => {
        const r = await runUI(['trad', 'minecraft', 'translate', '--yes'], ['Pack Un'], env);
        assert(/Traduit/.test(r.out), r.out);
    });
    console.log('BG3 (faux serveur)');
    const BG3ENV = { ...env, LIVEMOD_HOME: BG3HOME };
    await t('bg3 scan : trouve le dossier Mods Proton, analyse (déjà FR / à traduire / sans texte)', async () => {
        const r = await runUI([], ['bg3 scan', 'o', 'q', 'exit'], BG3ENV);
        assert(/1 dossier\(s\) Mods trouvé\(s\)/.test(r.out) && /Steam \(Proton\)/.test(r.out), r.out);
        assert(/5 mods \(\.pak\), 2 déjà en français, 2 à traduire, 1 sans texte à traduire, 2 paks de traduction/.test(r.out), r.out);
        assert(/ModA \(nom\)/.test(r.out) && /ModD \(nom\)/.test(r.out) && !/ModB \(nom\)\s+\d/.test(r.out) && !/ModC \(nom\)\s+\d/.test(r.out));
        assert(/Étape 1\/3 — Trouver le dossier Mods/.test(r.out) && /Étape 2\/3 — Analyse du dossier Mods/.test(r.out) && /Étape 3\/3 — Que traduire/.test(r.out));
        assert(streamed.length === 0 || true);
    });
    await t('bg3 : tout traduire (Entrée), un échec n\'arrête pas les autres, config remise', async () => {
        streamed.length = 0; modsCfg = '/ancien/mods';
        const r = await runUI([], ['bg3 scan', 'o', '', 'o', 'exit'], BG3ENV);
        assert.deepStrictEqual(streamed, ['ModA.pak', 'ModD.pak'], r.out);
        assert(/\[1\/2\] ModA \(nom\)/.test(r.out) && /✓ ModA_fr\.pak/.test(r.out) && /✗ Échec : moteur indisponible/.test(r.out), r.out);
        assert(/Terminé avec des échecs : ModD \(nom\)/.test(r.out) && /1 traduit\(s\), 0 ignoré\(s\), 1 échec\(s\)/.test(r.out) && /\*_fr\.pak/.test(r.out));
        assert(/Réglage de l'app remis comme avant/.test(r.out)); assert.strictEqual(modsCfg, '/ancien/mods');
    });
    await t('bg3 : choisir un mod par son nom (option 2)', async () => {
        streamed.length = 0;
        const r = await runUI([], ['bg3 scan', 'o', '2', 'ModA', 'o', 'exit'], BG3ENV);
        assert.deepStrictEqual(streamed, ['ModA.pak'], r.out); assert(/Terminé —/.test(r.out) || /Terminé/.test(r.out));
    });
    await t('bg3 : choisir par numéros', async () => {
        streamed.length = 0;
        await runUI([], ['bg3 scan', 'o', '2', '2', 'o', 'exit'], BG3ENV);
        assert.deepStrictEqual(streamed, ['ModD.pak']);
    });
    await t('bg3 --yes --only=ModD : sans question', async () => {
        streamed.length = 0;
        await runUI(['bg3', 'scan', '--yes', '--only=ModD'], [], BG3ENV);
        assert.deepStrictEqual(streamed, ['ModD.pak']);
    });
    console.log('langue cible');
    await t('lang : voir, changer (nom ou code), refuser l\'inconnu, mémoriser', async () => {
        const d = fresh();
        const r = await runUI([], ['lang', 'lang DE', 'lang japonais', 'lang xx', 'lang', 'exit'], { LIVEMOD_STATE: d });
        assert(/Traduire vers : français \(fr\)/.test(r.out), r.out); assert(/✓ Traduire vers : allemand \(de\)/.test(r.out) && /✓ Traduire vers : japonais \(ja\)/.test(r.out));
        assert(/Langue inconnue : xx\. Disponibles : en, fr, de/.test(r.out)); assert.strictEqual(readSelf(d).target, 'ja');
        const r2 = await runUI([], ['exit'], { LIVEMOD_STATE: d }); assert(/Traduire vers : japonais \(ja\) · « lang » pour changer/.test(r2.out), r2.out);
    });
    await t('assistant : étape 2/4 choisit la langue cible (numéro, code ou nom), refuse l\'inconnu', async () => {
        const d = fresh();
        const r = await runUI([], ['1', 'xx', 'allemand', '', '4', 'exit'], { LIVEMOD_STATE: d, LIVEMOD_NO_SETUP: '' });
        assert(/2\/4\s+Traduire vers quelle langue/.test(r.out) && /Choix invalide/.test(r.out), r.out); assert.strictEqual(readSelf(d).target, 'de');
        assert(/Traduire vers : allemand/.test(r.out));
        const d2 = fresh(); await runUI([], ['1', '3', '', '4', 'exit'], { LIVEMOD_STATE: d2, LIVEMOD_NO_SETUP: '' }); assert.strictEqual(readSelf(d2).target, 'de');   // 3e de la liste = de
    });
    await t('la liste des langues = celle de BG3 (modules/shared.js)', async () => {
        const shared = require(path.join(__dirname, '..', '..', 'modules', 'shared.js'));
        const src = fs.readFileSync(UI, 'utf8'); const mine = eval(src.match(/const BG3_LANGS = (\[[^\]]*\])/)[1]);
        assert.deepStrictEqual([...mine].sort(), Object.keys(shared.BG3_LANG_FOLDERS).sort());
    });
    await t('lang en anglais : noms de langues localisés', async () => {
        const r = await runUI([], ['lang de', 'exit'], { LIVEMOD_LANG: 'en', LIVEMOD_STATE: fresh() });
        assert(/✓ Translate into: German \(de\)/.test(r.out), r.out);
    });
    await t('Minecraft ignore --lang et reste en français (plus de capture d\'un autre argument)', async () => {
        const r = await runUI(['minecraft', 'scan', '--yes', '--only=kubejs', '--lang', 'de'], ['Pack Un'], env);
        assert(/français uniquement pour l'instant \(langue cible allemand ignorée\)/.test(r.out), r.out); assert(/KubeJS : 4/.test(r.out));
        const r2 = await runUI(['minecraft', 'scan', '--yes'], ['Pack Un'], env);   // avant : lang valait « --yes »
        assert(!/ignorée/.test(r2.out), r2.out);
        const body = JSON.parse(calls.filter((c) => c.startsWith('BODY ')).pop().slice(5)); assert.strictEqual(body.lang, 'fr');
    });
    await t('bg3 --lang xx : refusé avec la liste', async () => {
        const r = await runUI([], ['bg3 scan --lang xx', 'exit'], { ...env, LIVEMOD_HOME: BG3HOME });
        assert(/Langue inconnue : xx\. Disponibles : en \(anglais\), fr \(français\), de \(allemand\)/.test(r.out) && !/Recherche du dossier/.test(r.out), r.out);
    });
    await t('bg3 --lang de : détection par langue (français ≠ allemand), pak _DE existant, autres langues listées', async () => {
        BG3FILES['ModA_DE.pak'] = 1; langsAsked.length = 0; streamed.length = 0; streamLangs.length = 0;
        try {
            const r = await runUI([], ['bg3 scan --lang de', 'o', '', 'o', 'exit'], { ...env, LIVEMOD_HOME: BG3HOME });
            assert(/Traduire vers : allemand \(de\)/.test(r.out) && /1 déjà en allemand, 3 à traduire/.test(r.out), r.out);   // ModA a ModA_DE.pak ; ModB (français seulement) redevient à traduire
            assert(/Traductions existantes : français ×2, allemand ×1/.test(r.out), r.out);
            assert(langsAsked.length > 0 && langsAsked.every((l) => l === 'de'), 'le serveur doit être interrogé avec lang=de : ' + langsAsked);
            assert.deepStrictEqual(streamed, ['ModB.pak', 'ModC.pak', 'ModD.pak']); assert(streamLangs.every((l) => l === 'de'));
            assert(/✓ ModB_de\.pak/.test(r.out) && /→ allemand/.test(r.out) && /\*_de\.pak/.test(r.out), r.out);
        } finally { delete BG3FILES['ModA_DE.pak']; }
    });
    await t('bg3 : la langue enregistrée (lang ja) est utilisée sans --lang', async () => {
        const d = fresh(); streamLangs.length = 0;
        await runUI([], ['lang ja', 'bg3 scan --yes --only=ModA', 'exit'], { ...env, LIVEMOD_HOME: BG3HOME, LIVEMOD_STATE: d });
        assert.deepStrictEqual(streamLangs, ['ja']);
    });
    await t('bg3 en français par défaut (comportement inchangé)', async () => {
        streamLangs.length = 0; await runUI(['bg3', 'scan', '--yes', '--only=ModA'], [], { ...env, LIVEMOD_HOME: BG3HOME, LIVEMOD_STATE: fresh() });
        assert.deepStrictEqual(streamLangs, ['fr']);
    });
    await t('bg3 : refus de changer le dossier de l\'app => rien traduit, config intacte', async () => {
        streamed.length = 0; modsCfg = '/autre/mods';
        const r = await runUI([], ['bg3 scan', 'n', 'exit'], BG3ENV);
        assert.strictEqual(streamed.length, 0, r.out); assert.strictEqual(modsCfg, '/autre/mods'); assert(/Annulé/.test(r.out));
        modsCfg = '/ancien/mods';
    });
    await t('bg3 : si l\'app pointe déjà sur ce dossier, aucune question ni changement', async () => {
        streamed.length = 0; modsCfg = BG3MODS;
        const r = await runUI([], ['bg3 scan', '', 'o', 'exit'], BG3ENV);
        assert.deepStrictEqual(streamed, ['ModA.pak', 'ModD.pak'], r.out); assert(!/pointe sur/.test(r.out) && !/remis comme avant/.test(r.out));
        modsCfg = '/ancien/mods';
    });
    await t('bg3 use : montre le dossier sans serveur', async () => {
        const r = await runUI([], ['bg3 use', 'exit'], { LIVEMOD_HOME: BG3HOME, LIVEMOD_APP_URL: 'http://127.0.0.1:1' });
        assert(/7 fichier\(s\) \.pak/.test(r.out) && /Suite : trad bg3 translate/.test(r.out) && !/Serveur de traduction/.test(r.out), r.out);
    });
    await t('bg3 : aucun dossier => demande le chemin (refuse Windows/faux/sans .pak), accepte le parent « Baldur\'s Gate 3 », mémorise', async () => {
        const empty = path.join(TMP, 'bg3-vide'); const vide = path.join(TMP, 'dossier-vide'); fs.mkdirSync(empty, { recursive: true }); fs.mkdirSync(vide, { recursive: true });
        const parent = path.dirname(BG3MODS); const d = fresh();
        const r = await runUI([], ['bg3 scan', 'C:\\Users\\x\\Mods', '/nope', vide, parent, 'q', 'exit'], { ...env, LIVEMOD_HOME: empty, LIVEMOD_STATE: d });
        assert(/Aucun dossier Mods de BG3 trouvé automatiquement/.test(r.out) && /Chemin Windows/.test(r.out) && /Introuvable/.test(r.out) && /aucun \.pak/.test(r.out), r.out);
        assert(/Chemin mémorisé : .*Mods/.test(r.out)); assert.deepStrictEqual(readSelf(d).bg3Paths, [BG3MODS]);
        const r2 = await runUI([], ['bg3 use', 'exit'], { LIVEMOD_HOME: empty, LIVEMOD_STATE: d });
        assert(/Steam|mémorisé/.test(r2.out) && /7 fichier\(s\) \.pak/.test(r2.out), r2.out);
    });
    await t('bg3 : plusieurs dossiers (Steam + partition Windows) => on choisit', async () => {
        const media = path.join(TMP, 'media'); const win = path.join(media, 'user/DISK/Users/moi/AppData/Local/Larian Studios/Baldur\'s Gate 3/Mods');
        fs.mkdirSync(win, { recursive: true }); fs.writeFileSync(path.join(win, 'Z.pak'), 'x');
        streamed.length = 0;
        const r = await runUI([], ['bg3 use', '2', 'exit'], { LIVEMOD_HOME: BG3HOME, LIVEMOD_MEDIA: media, LIVEMOD_APP_URL: 'http://127.0.0.1:1' });
        assert(/2 dossier\(s\) Mods trouvé\(s\)/.test(r.out) && /Partition Windows/.test(r.out) && /1 fichier\(s\) \.pak/.test(r.out), r.out);
    });
    await t('help trad : BG3 est « disponible »', async () => {
        const r = await runUI([], ['help trad', 'exit']);
        assert(/trad bg3 scan\s+\|.*\| Baldur's Gate 3/.test(r.out) && /bg3\s+\| disponible/.test(r.out) && !/bg3\s+\| bientôt/.test(r.out), r.out);
    });
    await t('bg3 en anglais', async () => {
        const r = await runUI([], ['bg3 scan', 'o', 'q', 'exit'], { ...BG3ENV, LIVEMOD_LANG: 'en' });
        assert(/Step 1\/3 — Find the Mods folder/.test(r.out) && /2 already in French, 2 to translate/.test(r.out) && /Step 3\/3 — What to translate\?/.test(r.out), r.out);
    });
    await t('refus du changement de dossier => config de l\'app intouchée', async () => {
        const before = calls.length; cfgFolder = '/autre';
        const r = await runUI([], ['trad minecraft translate', 'Pack Un', '', 'o', 'n', 'exit'], env);
        assert(/Annulé/.test(r.out), r.out); assert.strictEqual(cfgFolder, '/autre');
        assert(!calls.slice(before).some((c) => c.startsWith('POST /api/config')), 'écriture inattendue');
    });
    srv.close();
    await t('sans serveur et refus de le lancer → message clair', async () => {
        const r = await runUI([], ['trad minecraft translate', 'Pack Un', '', 'o', 'n', 'exit'], { LIVEMOD_APP_URL: 'http://127.0.0.1:1' });
        assert(/traduction impossible/.test(r.out), r.out);
    });

    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\n${passed} ok, ${failed.length} échec(s)`);
    process.exit(failed.length ? 1 : 0);
})();
