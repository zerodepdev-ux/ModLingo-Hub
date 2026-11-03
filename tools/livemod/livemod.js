#!/usr/bin/env node
'use strict';
// ModLingo-Hub-live — mini serveur MCP du projet ModLingo-Hub.
// Zéro dépendance : Node seul. Usage : mcp start|stop|info|edit|add|connect

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const LIVEMOD_VERSION = require('./version');
const PROTOCOL = '2024-11-05';
const { ROOT, STATE, PORTABLE, CLIENT_ROOT } = require('./paths');
const nodeUpdate = require('./node-update'); // LIVEMOD_STATE : état isolé (tests)
const F = {
    config: path.join(STATE, 'config.json'),
    pid: path.join(STATE, 'livemod.pid'),
    log: path.join(STATE, 'livemod.log'),
    tools: path.join(STATE, 'tools.d'),
    cmds: path.join(STATE, 'commands.d'),
};
const DEFAULTS = { port: 3950, maxReadBytes: 200000, allowRead: true, web: true, dataDir: '', nodeUpdate: 'auto', token: '' };

// Jamais lisibles par un client MCP (clés API, tokens, dépôt, binaires).
const DENY = [/(^|\/)\.git(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.livemod(\/|$)/, /APIcle\.json$/i,
    /Save_Autre(\/|$)/, /\.env(\.|$)/i, /\.key$/i, /\.sig$/i, /\.pem$/i, /(^|\/)\.ssh(\/|$)/];

// ── config ──────────────────────────────────────────────────────────────────
function loadConfig() {
    fs.mkdirSync(STATE, { recursive: true });
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(F.config, 'utf8')); } catch { /* première fois */ }
    cfg = { ...DEFAULTS, ...cfg };
    CFG_DATA = cfg.dataDir ? path.resolve(cfg.dataDir.replace(/^~(?=$|\/)/, os.homedir())) : '';
    if (!cfg.token) { cfg.token = crypto.randomBytes(24).toString('hex'); saveConfig(cfg); }
    return cfg;
}
function saveConfig(cfg) {
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(F.config, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}
function readPid() {
    try {
        const pid = parseInt(fs.readFileSync(F.pid, 'utf8'), 10);
        process.kill(pid, 0);
        return pid;
    } catch { return 0; }
}

// ── connaissance du projet ──────────────────────────────────────────────────
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
// Dossier de données : celui de l'app qui tourne vraiment. Le flatpak écrit dans ~/.var/app/…, pas dans <projet>/data.
// Config « dataDir » vide = auto (le dossier dont un cache.json a été modifié en dernier) ; sinon chemin imposé.
let CFG_DATA = '';
let dataCache = { at: 0, dir: '' };
function dataCandidates() {
    if (PORTABLE) return [path.join(ROOT, 'data')];   // dossier portable : seule sa propre data/ compte
    const h = os.homedir();
    return [path.join(ROOT, 'data'),
        path.join(h, '.var/app/com.translator.app/data/com.translator.app/server/data'),
        path.join(h, '.var/app/com.translator.app.admin/data/com.translator.app.admin/server/data')]
        .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}
function newestCache(dir) {
    let t = 0;
    try { for (const g of fs.readdirSync(dir)) { try { t = Math.max(t, fs.statSync(path.join(dir, g, 'cache.json')).mtimeMs); } catch { /* pas de cache */ } } } catch { /* illisible */ }
    return t;
}
function dataDir() {
    if (CFG_DATA) { try { if (fs.statSync(CFG_DATA).isDirectory()) return CFG_DATA; } catch { /* retombe sur auto */ } }
    if (Date.now() - dataCache.at < 5000 && dataCache.dir) return dataCache.dir;
    let best = path.join(ROOT, 'data'), bestT = newestCache(best);
    for (const d of dataCandidates()) { const t = newestCache(d); if (t > bestT) { best = d; bestT = t; } }
    dataCache = { at: Date.now(), dir: best };
    return best;
}

function gameDirs() {
    try {
        return fs.readdirSync(dataDir(), { withFileTypes: true })
            .filter((e) => e.isDirectory() && !['Save_Autre', 'repo', 'custom-games'].includes(e.name))
            .map((e) => e.name);
    } catch { return []; }
}

// Le cache est { _meta, "en|fr": { source: traduction } } ; on aplatit toutes les paires de langues.
function cachePairs(game) {
    const c = readJson(path.join(dataDir(), game, 'cache.json')) || {};
    const out = [];
    for (const [pair, map] of Object.entries(c)) {
        if (pair.startsWith('_') || !map || typeof map !== 'object') continue;
        for (const [src, dst] of Object.entries(map)) out.push({ pair, source: src, translation: typeof dst === 'string' ? dst : JSON.stringify(dst) });
    }
    return out;
}
function glossaryEntries(game) {
    const g = readJson(path.join(dataDir(), game, 'glossary.json')) || {};
    const out = [];
    for (const [section, map] of Object.entries(g)) {
        if (section.startsWith('_') || !map || typeof map !== 'object') continue;
        for (const [src, dst] of Object.entries(map)) out.push({ section, source: src, translation: String(dst) });
    }
    return out;
}
function gameSummary(game) {
    const d = path.join(dataDir(), game);
    const mtime = (f) => { try { return fs.statSync(path.join(d, f)).mtime.toISOString(); } catch { return null; } };
    return {
        game,
        translations: cachePairs(game).length,
        glossaryTerms: glossaryEntries(game).length,
        cacheUpdated: mtime('cache.json'),
    };
}
function projectInfo() {
    const v = readJson(path.join(dataDir(), 'version.json')) || {};
    const pkg = readJson(path.join(ROOT, 'package.json')) || {};
    return { name: v.name || pkg.name, appVersion: v.version, appDate: v.date, notes: v.details, root: ROOT, games: gameDirs().map(gameSummary) };
}
function safePath(rel) {
    const abs = path.resolve(ROOT, String(rel || ''));
    let real = abs;
    try { real = fs.realpathSync(abs); } catch { /* inexistant : testé ensuite */ }
    const relOut = path.relative(ROOT, real).split(path.sep).join('/');
    if (relOut.startsWith('..') || path.isAbsolute(relOut)) throw new Error('Hors du projet');
    if (DENY.some((re) => re.test(relOut))) throw new Error('Chemin protégé');
    return { abs: real, rel: relOut };
}
const git = (args) => new Promise((resolve) =>
    execFile('git', args, { cwd: ROOT, timeout: 5000 }, (e, out) => resolve(e ? `git: ${e.message}` : out.trim())));

// ── outils MCP ──────────────────────────────────────────────────────────────
const gameArg = { type: 'string', description: 'Dossier du jeu dans data/ (bg3, minecraft, valheim…)' };
const BUILTIN = [
    {
        name: 'project_info', description: 'Version de l\'app, jeux gérés et nombre de traductions par jeu.',
        inputSchema: { type: 'object', properties: {} }, run: () => projectInfo(),
    },
    {
        name: 'translation_stats', description: 'Statistiques globales (data/stats.json) : sessions, traductions, moteurs.',
        inputSchema: { type: 'object', properties: {} }, run: () => readJson(path.join(dataDir(), 'stats.json')) || {},
    },
    {
        name: 'lookup_translation', description: 'Cherche la traduction exacte d\'un texte source dans le cache d\'un jeu.',
        inputSchema: { type: 'object', properties: { game: gameArg, text: { type: 'string' } }, required: ['game', 'text'] },
        run: ({ game, text }) => {
            if (!gameDirs().includes(game)) throw new Error('Jeu inconnu : ' + game);
            const hit = cachePairs(game).find((p) => p.source === text);
            return hit || { found: false };
        },
    },
    {
        name: 'search_translations', description: 'Recherche plein texte (source ou traduction) dans le cache d\'un jeu.',
        inputSchema: { type: 'object', properties: { game: gameArg, query: { type: 'string' }, limit: { type: 'number', default: 20 } }, required: ['game', 'query'] },
        run: ({ game, query, limit }) => {
            if (!gameDirs().includes(game)) throw new Error('Jeu inconnu : ' + game);
            const q = String(query).toLowerCase();
            const max = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
            const hits = cachePairs(game).filter((p) => p.source.toLowerCase().includes(q) || p.translation.toLowerCase().includes(q));
            return { total: hits.length, results: hits.slice(0, max) };
        },
    },
    {
        name: 'get_glossary', description: 'Glossaire d\'un jeu (termes à traduire de façon cohérente), filtrable.',
        inputSchema: { type: 'object', properties: { game: gameArg, query: { type: 'string' } }, required: ['game'] },
        run: ({ game, query }) => {
            if (!gameDirs().includes(game)) throw new Error('Jeu inconnu : ' + game);
            const q = String(query || '').toLowerCase();
            return glossaryEntries(game).filter((e) => !q || e.source.toLowerCase().includes(q) || e.translation.toLowerCase().includes(q));
        },
    },
    {
        name: 'list_modules', description: 'Modules JS du projet (modules/*.js) avec leur taille.',
        inputSchema: { type: 'object', properties: {} },
        run: () => fs.readdirSync(path.join(ROOT, 'modules')).filter((f) => f.endsWith('.js'))
            .map((f) => ({ module: f, bytes: fs.statSync(path.join(ROOT, 'modules', f)).size })),
    },
    {
        name: 'recent_changes', description: 'git status court + 10 derniers commits du projet.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => ({ status: await git(['status', '--short']), log: await git(['log', '--oneline', '-10']) }),
    },
    {
        name: 'read_project_file', description: 'Lit un fichier texte du projet (lecture seule, secrets exclus).',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relatif à la racine du projet' }, maxBytes: { type: 'number' } }, required: ['path'] },
        run: (a, ctx) => {
            if (!ctx.cfg.allowRead) throw new Error('Lecture désactivée (mcp edit allowRead true)');
            const { abs } = safePath(a.path);
            const st = fs.statSync(abs);
            if (!st.isFile()) throw new Error('Pas un fichier');
            const max = Math.min(parseInt(a.maxBytes, 10) || ctx.cfg.maxReadBytes, ctx.cfg.maxReadBytes);
            const buf = Buffer.alloc(Math.min(max, st.size));
            const fd = fs.openSync(abs, 'r');
            try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
            if (buf.includes(0)) throw new Error('Fichier binaire');
            return { size: st.size, truncated: st.size > max, content: buf.toString('utf8') };
        },
    },
];

function loadCustomTools() {
    const tools = [];
    let files = [];
    try { files = fs.readdirSync(F.tools).filter((f) => f.endsWith('.js')); } catch { /* aucun */ }
    for (const f of files) {
        try {
            const t = require(path.join(F.tools, f));
            if (t && t.name && typeof t.run === 'function') tools.push({ inputSchema: { type: 'object', properties: {} }, description: '', ...t, custom: f });
        } catch (e) { logLine(`outil ${f} ignoré : ${e.message}`); }
    }
    return tools;
}

// ── dispatcher JSON-RPC (partagé stdio / HTTP) ──────────────────────────────
const logBuf = [];
const sseClients = new Set();
const startedAt = Date.now();
function logLine(msg) {
    const line = `${new Date().toISOString()} ${msg}`;
    logBuf.push(line); if (logBuf.length > 100) logBuf.shift();
    broadcast('log', line);
    if (process.env.LIVEMOD_VERBOSE) process.stderr.write(line + '\n');
}
function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(msg);
}

async function dispatch(req, ctx) {
    const { id, method, params } = req;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (id === undefined) return null; // notification
    switch (method) {
        case 'initialize':
            return ok({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'modlingo-hub-live', version: LIVEMOD_VERSION } });
        case 'ping': return ok({});
        case 'tools/list':
            return ok({ tools: ctx.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case 'tools/call': {
            const tool = ctx.tools.find((t) => t.name === (params && params.name));
            if (!tool) return err(-32602, 'Outil inconnu : ' + (params && params.name));
            try {
                const out = await tool.run((params && params.arguments) || {}, ctx);
                logLine(`tool ${tool.name} ok`);
                return ok({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
            } catch (e) {
                logLine(`tool ${tool.name} erreur : ${e.message}`);
                return ok({ isError: true, content: [{ type: 'text', text: e.message }] });
            }
        }
        default: return err(-32601, 'Méthode inconnue : ' + method);
    }
}

function makeCtx(cfg) { return { cfg, tools: [...BUILTIN, ...loadCustomTools()] }; }

// ── serveur HTTP + interface web ────────────────────────────────────────────
const PAGE = `<!doctype html><meta charset=utf-8><title>ModLingo-Hub-live</title>
<style>body{font:14px ui-monospace,monospace;background:#0e1116;color:#d6dde6;margin:0;padding:20px;max-width:900px}
h1{font-size:18px}h2{font-size:13px;color:#7d8ba1;text-transform:uppercase;margin:22px 0 6px}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:3px 10px 3px 0}th{color:#7d8ba1;font-weight:normal}
#log{background:#161b22;padding:10px;height:220px;overflow:auto;white-space:pre-wrap;font-size:12px}.ok{color:#3fb950}</style>
<h1>ModLingo-Hub-live <span id=v></span> <span class=ok>● en ligne</span></h1>
<div id=meta></div><h2>Jeux</h2><table id=games></table><h2>Outils</h2><div id=tools></div><h2>Activité (live)</h2><div id=log></div>
<script>
const $=id=>document.getElementById(id);
function row(t,cells){const tr=document.createElement('tr');for(const c of cells){const e=document.createElement(t);e.textContent=c??'—';tr.append(e)}return tr}
async function load(){const i=await (await fetch('/api/info')).json();
$('v').textContent='v'+i.livemod;$('meta').textContent='App '+i.project.appVersion+' · port '+i.port+' · '+i.project.root;
const g=$('games');g.replaceChildren(row('th',['jeu','traductions','glossaire','cache modifié']));
for(const x of i.project.games)g.append(row('td',[x.game,x.translations,x.glossaryTerms,x.cacheUpdated&&x.cacheUpdated.slice(0,16).replace('T',' ')]));
$('tools').textContent=i.tools.map(t=>t.name+(t.custom?' *':'')).join('  ·  ');
for(const l of i.log)add(l)}
function add(l){const d=$('log');d.append(l+'\\n');d.scrollTop=d.scrollHeight}
load();const es=new EventSource('/events');es.addEventListener('log',e=>add(JSON.parse(e.data)));
es.addEventListener('data',e=>{add('~ données modifiées : '+JSON.parse(e.data));load()});
</script>`;

function buildInfo(cfg, ctx) {
    return {
        livemod: LIVEMOD_VERSION, port: cfg.port, pid: process.pid, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        project: projectInfo(), tools: ctx.tools.map((t) => ({ name: t.name, description: t.description, custom: t.custom })), log: logBuf.slice(-30),
    };
}

function startHttp(cfg, ctx) {
    const hostOk = (h) => new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${cfg.port}$`).test(h || '');
    const server = http.createServer(async (req, res) => {
        // Anti DNS-rebinding / CSRF : seulement l'hôte local, jamais d'Origin étrangère.
        if (!hostOk(req.headers.host)) { res.writeHead(403).end('host'); return; }
        const origin = req.headers.origin;
        if (origin && !hostOk(origin.replace(/^https?:\/\//, ''))) { res.writeHead(403).end('origin'); return; }
        const url = req.url.split('?')[0];
        if (cfg.web && req.method === 'GET' && url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE); return; }
        if (cfg.web && req.method === 'GET' && url === '/api/info') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(buildInfo(cfg, ctx))); return; }
        if (cfg.web && req.method === 'GET' && url === '/events') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            res.write(': ok\n\n'); sseClients.add(res); req.on('close', () => sseClients.delete(res)); return;
        }
        if (req.method === 'POST' && url === '/mcp') {
            const auth = Buffer.from(req.headers.authorization || '');
            const want = Buffer.from('Bearer ' + cfg.token);
            if (auth.length !== want.length || !crypto.timingSafeEqual(auth, want)) { res.writeHead(401).end('token'); return; }
            let body = ''; let size = 0;
            for await (const chunk of req) { size += chunk.length; if (size > 1e6) { res.writeHead(413).end(); return; } body += chunk; }
            let msg;
            try { msg = JSON.parse(body); } catch { res.writeHead(400).end('json'); return; }
            const batch = Array.isArray(msg);
            const replies = (await Promise.all((batch ? msg : [msg]).map((m) => dispatch(m, ctx)))).filter(Boolean);
            if (!replies.length) { res.writeHead(202).end(); return; }
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(batch ? replies : replies[0]));
            return;
        }
        res.writeHead(404).end();
    });
    server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${cfg.port} occupé (mcp edit port <n>)` : e.message); process.exit(1); });
    server.listen(cfg.port, '127.0.0.1', () => logLine(`ModLingo-Hub-live ${LIVEMOD_VERSION} sur http://127.0.0.1:${cfg.port} (${cfg.web ? 'web actif' : 'sans interface'})`));

    // Mises à jour en direct : surveille data/ et chaque dossier de jeu.
    let timer = null;
    const onChange = (_e, name) => { clearTimeout(timer); timer = setTimeout(() => broadcast('data', name || 'data'), 300); };
    // Mode sans interface : aucun watcher, aucune connexion SSE, seul /mcp répond.
    if (cfg.web) for (const d of [dataDir(), ...gameDirs().map((g) => path.join(dataDir(), g))]) {
        try { fs.watch(d, onChange); } catch { /* dossier absent */ }
    }
    return server;
}

function startStdio(cfg) {
    const ctx = makeCtx(cfg);
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            dispatch(msg, ctx).then((r) => { if (r) process.stdout.write(JSON.stringify(r) + '\n'); });
        }
    });
    process.stdin.on('end', () => process.exit(0));
}

// ── commandes CLI ───────────────────────────────────────────────────────────
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });
const out = (s = '') => process.stdout.write(s + '\n');
const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

function mcpCall(cfg, method) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method });
        const r = http.request({ host: '127.0.0.1', port: cfg.port, path: '/mcp', method: 'POST', timeout: 1500,
            headers: { authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
        r.on('error', reject).on('timeout', () => r.destroy(new Error('timeout')));
        r.end(body);
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COMMANDS = {
    async start(args) {
        const cfg = loadConfig();
        const p = parseInt(flag(args, '--port'), 10);
        if (p) cfg.port = p;
        if (args.includes('--no-web')) cfg.web = false;
        if (args.includes('--web')) cfg.web = true;
        if (p || args.includes('--no-web') || args.includes('--web')) saveConfig(cfg);
        if (args.includes('--stdio')) return startStdio(cfg);
        if (args.includes('--foreground')) {
            fs.writeFileSync(F.pid, String(process.pid));
            process.on('exit', () => { try { fs.unlinkSync(F.pid); } catch { /* déjà parti */ } });
            for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
            process.env.LIVEMOD_VERBOSE = '1';
            const srv = startHttp(cfg, makeCtx(cfg));
            if (process.env.LIVEMOD_NO_UPDATE !== '1') nodeUpdate.check({ mode: cfg.nodeUpdate }).then((r) => { if (r.status === 'prepared') logLine(`Node ${r.version} prêt (appliqué au prochain lancement)`); });
            return srv;
        }
        if (readPid()) { out(`Déjà lancé (pid ${readPid()}) — http://127.0.0.1:${cfg.port}`); return; }
        fs.mkdirSync(STATE, { recursive: true });
        const fd = fs.openSync(F.log, 'a');
        const child = spawn(process.execPath, [__filename, 'start', '--foreground'], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
        child.unref();
        await new Promise((r) => setTimeout(r, 600));
        if (!readPid()) { out(`Échec du démarrage — voir ${F.log}`); process.exitCode = 1; return; }
        out(`ModLingo-Hub-live ${LIVEMOD_VERSION} démarré (pid ${readPid()})\n  web : http://127.0.0.1:${cfg.port}\n  mcp : http://127.0.0.1:${cfg.port}/mcp`.replace(/  web : .*\n/, cfg.web ? '$&' : '  web : désactivée (sans interface)\n'));
    },
    async stop() {
        const pid = readPid();
        if (!pid) { out('Pas lancé.'); return; }
        process.kill(pid, 'SIGTERM');
        out(`Arrêté (pid ${pid}).`);
    },
    async info() {
        const cfg = loadConfig();
        const pid = readPid();
        out(`ModLingo-Hub-live ${LIVEMOD_VERSION}  —  ${pid ? `en ligne (pid ${pid}, port ${cfg.port})` : 'arrêté'}`);
        const ctx = makeCtx(cfg);
        const p = projectInfo();
        out(`Projet  : ${p.name} ${p.appVersion} (${p.appDate}) — ${p.root}`);
        out('\nJeux :');
        for (const g of p.games) out(`  ${g.game.padEnd(14)} ${String(g.translations).padStart(6)} traductions  ${String(g.glossaryTerms).padStart(4)} termes`);
        out('\nOutils :');
        for (const t of ctx.tools) out(`  ${t.name.padEnd(20)} ${t.custom ? '[custom] ' : ''}${t.description}`);
        out(`\nConfig  : ${F.config}  (lecture fichiers: ${cfg.allowRead ? 'oui' : 'non'}, max ${cfg.maxReadBytes} o)`);
        const rt = nodeUpdate.runtimeInfo(), up = nodeUpdate.pending();
        out(`Node    : ${rt.version} (${rt.portable ? 'portable' : 'système'})${up ? ` — mise à jour ${up.version} prête (appliquée au prochain lancement)` : ''}${PORTABLE ? ` · mise à jour auto : ${cfg.nodeUpdate}` : ''}`);
        out(`Données : ${dataDir()}  (${CFG_DATA ? 'imposé' : 'auto'} — mcp data)`);
        out(`Web     : ${cfg.web ? `actif (http://127.0.0.1:${cfg.port})` : 'désactivé — mode léger'}`);
        if (pid) out(`Uptime  : ${Math.round((Date.now() - fs.statSync(F.pid).mtimeMs) / 1000)}s`);
    },
    async 'update-node'() {
        const cfg = loadConfig();
        if (!PORTABLE) { out('Pas de Node portable ici (dossier créé par build.sh / build.ps1).'); return; }
        out(`Node actuel : ${process.version} — recherche d'une mise à jour (même version majeure, LTS)…`);
        const r = await nodeUpdate.check({ mode: cfg.nodeUpdate === 'off' ? 'auto' : cfg.nodeUpdate, force: true });
        const msg = { uptodate: 'Déjà à jour.', prepared: `Node ${r.version} téléchargé et vérifié (SHA-256). Il sera utilisé au prochain lancement.`, available: `Node ${r.version} est disponible.`, skipped: r.message, error: 'Échec : ' + r.message };
        out(msg[r.status] || r.status);
        if (r.status === 'error') process.exitCode = 1;
    },
    async data() {
        loadConfig();
        const active = dataDir();
        out(`Dossiers de données connus (actif : ${CFG_DATA ? 'imposé' : 'auto'}) :`);
        for (const d of dataCandidates()) {
            const t = newestCache(d);
            out(`  ${d === active ? '→' : ' '} ${d}\n      dernier cache modifié : ${t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '—'}`);
        }
        out('\nImposer un dossier : mcp edit dataDir <chemin>   ·   revenir à l\'auto : mcp edit dataDir ""');
    },
    async edit(args) {
        const cfg = loadConfig();
        const [key, ...rest] = args;
        if (!key) {
            const editor = process.env.EDITOR || process.env.VISUAL || (process.platform === 'win32' ? 'notepad' : 'nano');
            spawn(editor, [F.config], { stdio: 'inherit', shell: process.platform === 'win32' }).on('exit', () => out('Relance avec : mcp stop && mcp start'));
            return;
        }
        if (!(key in DEFAULTS) || key === 'token') { out(`Clé inconnue. Possibles : ${Object.keys(DEFAULTS).filter((k) => k !== 'token').join(', ')}`); process.exitCode = 1; return; }
        if (!rest.length) { out(String(cfg[key])); return; }
        const raw = rest.join(' ').replace(/^""$/, '');
        cfg[key] = typeof DEFAULTS[key] === 'boolean' ? raw === 'true' : typeof DEFAULTS[key] === 'number' ? Number(raw) : raw;
        saveConfig(cfg);
        out(`${key} = ${cfg[key]}  (relance : mcp stop && mcp start)`);
    },
    async add(args) {
        if (args[0] === '--remove') {
            const file = path.basename(args[1] || '') + (String(args[1]).endsWith('.js') ? '' : '.js');
            const target = [F.tools, F.cmds].map((d) => path.join(d, file)).find((f) => fs.existsSync(f));
            if (!target) { out('Introuvable.'); process.exitCode = 1; return; }
            fs.unlinkSync(target); out('Retiré.'); return;
        }
        const src = args[0];
        if (!src || !src.endsWith('.js') || !fs.existsSync(src)) { out('Usage : mcp add <fichier.js> | mcp add --remove <nom>\nOutil MCP : exporte { name, description, inputSchema, run(args, ctx) }.\nCommande du shell : exporte { type: "command", name, help, run(args, ctx) }.'); process.exitCode = 1; return; }
        const t = require(path.resolve(src));
        if (t.type === 'command' && t.name && typeof t.run === 'function') {
            fs.mkdirSync(F.cmds, { recursive: true });
            fs.copyFileSync(src, path.join(F.cmds, path.basename(src)));
            out(`Commande « ${t.name} » ajoutée au shell (mcp shell).`);
            return;
        }
        if (!t.name || typeof t.run !== 'function') { out('Le fichier doit exporter { name, run }.'); process.exitCode = 1; return; }
        if (BUILTIN.some((b) => b.name === t.name)) { out(`« ${t.name} » est déjà un outil intégré.`); process.exitCode = 1; return; }
        fs.mkdirSync(F.tools, { recursive: true });
        fs.copyFileSync(src, path.join(F.tools, path.basename(src)));
        out(`Outil « ${t.name} » ajouté. Relance : mcp stop && mcp start`);
    },
    async connect(args) {
        const cfg = loadConfig();
        const [sub, ...rest] = args;
        const cmd = process.platform === 'win32' ? path.join(__dirname, 'LiveMod.cmd') : path.join(__dirname, 'LiveMod.sh');
        const stdioEntry = { type: 'stdio', command: cmd, args: ['start', '--stdio'] };
        // Chaque client a son fichier et sa clé racine. Le token HTTP n'est JAMAIS écrit dans le dépôt (.mcp.json est versionné).
        const TARGETS = {
            claude: { file: path.join(CLIENT_ROOT, '.mcp.json'), key: 'mcpServers' },
            cursor: { file: path.join(CLIENT_ROOT, '.cursor', 'mcp.json'), key: 'mcpServers' },
            vscode: { file: path.join(CLIENT_ROOT, '.vscode', 'mcp.json'), key: 'servers' },
        };
        if (TARGETS[sub] || (sub === 'remove' && TARGETS[rest[0]])) {
            const remove = sub === 'remove';
            const t = TARGETS[remove ? rest[0] : sub];
            const json = readJson(t.file) || {};
            json[t.key] = { ...(json[t.key] || {}) };
            if (remove) { delete json[t.key]['modlingo-hub-live']; delete json[t.key].livemod; } else json[t.key]['modlingo-hub-live'] = stdioEntry;   // « livemod » = ancien nom, retiré aussi
            fs.mkdirSync(path.dirname(t.file), { recursive: true });
            fs.writeFileSync(t.file, JSON.stringify(json, null, 2) + '\n', );
            out(`${remove ? 'livemod retiré de' : `livemod ajouté (stdio) à`} ${t.file}`);
            return;
        }
        if (sub === 'token') { out(cfg.token); return; }
        if (sub === 'regen') {
            cfg.token = crypto.randomBytes(24).toString('hex'); saveConfig(cfg);
            out('Nouveau token généré (les clients HTTP doivent être reconfigurés ; serveur à relancer).'); return;
        }
        if (sub === 'test') {
            if (!readPid()) { out('Serveur arrêté (mcp start).'); process.exitCode = 1; return; }
            try { const r = await mcpCall(cfg, 'tools/list'); out(`OK — ${r.result.tools.length} outils sur http://127.0.0.1:${cfg.port}/mcp`); }
            catch (e) { out('Injoignable : ' + e.message); process.exitCode = 1; }
            return;
        }
        if (sub) { out('Usage : mcp connect [claude|cursor|vscode] | remove <cible> | token | regen | test'); process.exitCode = 1; return; }
        out('Stdio (le client lance ModLingo-Hub-live lui-même) :\n' + JSON.stringify({ mcpServers: { 'modlingo-hub-live': stdioEntry } }, null, 2));
        out('\nHTTP (serveur lancé par « mcp start ») :');
        out(`  url    : http://127.0.0.1:${cfg.port}/mcp`);
        out(`  header : Authorization: Bearer ${cfg.token}`);
        out(`\nClaude Code, hors dépôt (le token reste chez toi) :\n  claude mcp add --transport http --scope user livemod http://127.0.0.1:${cfg.port}/mcp --header "Authorization: Bearer ${cfg.token}"`);
        out('\nInstaller (stdio) : mcp connect claude|cursor|vscode   Retirer : mcp connect remove <cible>');
        out('Autres   : mcp connect token | regen | test');
        out(readPid() ? '\nServeur en ligne.' : '\n(serveur arrêté — mcp start)');
    },
};

// ── mini shell interactif (tout ce que fait le web, en texte) ───────────────
const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
function loadShellCommands() {
    const cmds = {};
    let files = [];
    try { files = fs.readdirSync(F.cmds).filter((f) => f.endsWith('.js')); } catch { /* aucune */ }
    for (const f of files) {
        try { const c = require(path.join(F.cmds, f)); if (c.name && typeof c.run === 'function') cmds[c.name] = { help: '', ...c, custom: true }; }
        catch (e) { out(`commande ${f} ignorée : ${e.message}`); }
    }
    return cmds;
}

async function shell() {
    const readline = require('readline');
    let cfg = loadConfig();
    const ctx = makeCtx(cfg);
    const callTool = (name, a) => {
        const t = ctx.tools.find((x) => x.name === name);
        if (!t) throw new Error('Outil inconnu : ' + name);
        return t.run(a, ctx);
    };
    const restart = async () => {
        if (!readPid()) return;
        await COMMANDS.stop(); await sleep(400); await COMMANDS.start([]);
    };
    let watchStop = null;
    const REPL = {
        help: { help: 'cette aide', run: () => {
            out('Commandes :');
            for (const [n, c] of Object.entries(commands)) out(`  ${n.padEnd(22)} ${c.help}${c.custom ? '  [custom]' : ''}`);
        } },
        info: { help: 'version, jeux, outils, état', run: () => COMMANDS.info([]) },
        data: { help: 'dossiers de données (app/flatpak) et lequel est lu', run: () => COMMANDS.data([]) },
        games: { help: 'jeux et nombre de traductions', run: () => { for (const g of gameDirs().map(gameSummary)) out(`  ${g.game.padEnd(14)} ${String(g.translations).padStart(6)} trad.  ${String(g.glossaryTerms).padStart(4)} termes  ${(g.cacheUpdated || '-').slice(0, 16)}`); } },
        stats: { help: 'statistiques globales', run: () => out(pretty(callTool('translation_stats', {}))) },
        search: { help: 'search <jeu> <texte>', run: ([g, ...q]) => out(pretty(callTool('search_translations', { game: g, query: q.join(' '), limit: 10 }))) },
        lookup: { help: 'lookup <jeu> <texte exact>', run: ([g, ...q]) => out(pretty(callTool('lookup_translation', { game: g, text: q.join(' ') }))) },
        glossary: { help: 'glossary <jeu> [filtre]', run: ([g, ...q]) => { for (const e of callTool('get_glossary', { game: g, query: q.join(' ') })) out(`  ${e.source} → ${e.translation}`); } },
        tools: { help: 'liste des outils MCP', run: () => { for (const t of ctx.tools) out(`  ${t.name.padEnd(20)} ${t.description}`); } },
        call: { help: 'call <outil> [json]  — appelle un outil MCP', run: async ([n, ...j]) => out(pretty(await callTool(n, j.length ? JSON.parse(j.join(' ')) : {}))) },
        log: { help: 'log [n]  — dernières lignes du journal du serveur', run: ([n]) => { try { out(fs.readFileSync(F.log, 'utf8').trimEnd().split('\n').slice(-(parseInt(n, 10) || 20)).join('\n')); } catch { out('(pas de journal)'); } } },
        web: { help: 'web on|off  — active/désactive l\'interface web (off = léger)', run: async ([v]) => {
            if (v !== 'on' && v !== 'off') { out(`web : ${cfg.web ? 'on' : 'off'}`); return; }
            cfg.web = v === 'on'; saveConfig(cfg); out(`web ${v}`); await restart();
        } },
        start: { help: 'lance le serveur MCP', run: (a) => COMMANDS.start(a) },
        stop: { help: 'arrête le serveur MCP', run: () => COMMANDS.stop() },
        edit: { help: 'edit [clé valeur]', run: async (a) => { await COMMANDS.edit(a); cfg = loadConfig(); } },
        add: { help: 'add <fichier.js>  — outil MCP ou commande du shell', run: (a) => COMMANDS.add(a) },
        connect: { help: 'connect [claude|cursor|vscode] | remove | token | regen | test', run: (a) => COMMANDS.connect(a) },
        status: { help: 'état court (serveur, port, web, uptime)', run: () => {
            const pid = readPid();
            out(pid ? `en ligne · pid ${pid} · port ${cfg.port} · web ${cfg.web ? 'on' : 'off'} · ${Math.round((Date.now() - fs.statSync(F.pid).mtimeMs) / 1000)}s` : 'arrêté');
        } },
        watch: { help: 'suivi en direct (journal + modifs des données) — Entrée pour arrêter', run: async () => {
            const stops = [];
            let size = 0; try { size = fs.statSync(F.log).size; } catch { /* pas encore de journal */ }
            const poll = setInterval(() => {
                try {
                    const st = fs.statSync(F.log);
                    if (st.size < size) size = 0;
                    if (st.size > size) { const fd = fs.openSync(F.log, 'r'); const buf = Buffer.alloc(st.size - size); fs.readSync(fd, buf, 0, buf.length, size); fs.closeSync(fd); size = st.size; out(buf.toString('utf8').trimEnd()); }
                } catch { /* journal absent */ }
            }, 500);
            stops.push(() => clearInterval(poll));
            let timer = null;
            for (const d of [dataDir(), ...gameDirs().map((g) => path.join(dataDir(), g))]) {
                try { const w = fs.watch(d, (_e, n) => { clearTimeout(timer); timer = setTimeout(() => out(`~ données modifiées : ${path.relative(dataDir(), path.join(d, n || ''))}`), 300); }); stops.push(() => w.close()); } catch { /* absent */ }
            }
            out('(suivi actif — Entrée pour arrêter)');
            await new Promise((resolve) => { watchStop = resolve; });
            stops.forEach((f) => f());
        } },
        token: { help: 'affiche le token HTTP', run: () => COMMANDS.connect(['token']) },
        reload: { help: 'recharge les commandes custom', run: () => { Object.assign(commands, loadShellCommands()); out('ok'); } },
        nomcp: { help: 'retour à l\'interface de traduction (mode nomcp)', run: () => process.exit(0) },
        exit: { help: 'quitter (le serveur reste lancé)', run: () => process.exit(0) },
    };
    const commands = { ...REPL, ...loadShellCommands() };
    out(`ModLingo-Hub-live ${LIVEMOD_VERSION} — ${readPid() ? 'serveur en ligne' : 'serveur arrêté'}, web ${cfg.web ? 'on' : 'off'}. « help » pour les commandes.`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'mcp> ', completer: (l) => { const h = Object.keys(commands).filter((c) => c.startsWith(l)); return [h, l]; } });
    rl.prompt();
    let chain = Promise.resolve();
    rl.on('line', (line) => { if (watchStop) { watchStop(); watchStop = null; return; } chain = chain.then(() => handle(line)); });
    rl.on('close', () => chain.then(() => process.exit(0)));
    const handle = async (line) => {
        const [name, ...args] = line.trim().split(/\s+/).filter(Boolean);
        if (name) {
            const c = commands[name];
            try { if (c) await c.run(args, { cfg, callTool, tools: ctx.tools }); else out(`Commande inconnue : ${name} (help)`); }
            catch (e) { out('Erreur : ' + e.message); }
        }
        rl.prompt();
    };
}

if (require.main === module) {
    const [cmd, ...args] = process.argv.slice(2);
    if (cmd === '--version' || cmd === '-v' || cmd === 'version') { out(`ModLingo-Hub-live ${LIVEMOD_VERSION}`); return; }
    if (cmd === 'ui' || cmd === 'setup' || /^--debug-start$/i.test(cmd || '') || (!cmd && process.stdin.isTTY)) {
        require('./Livemod_inteface.js').run(cmd === 'ui' || !cmd ? args : [cmd, ...args]).then(() => process.exit(0));
    } else if (cmd === 'shell') {
        shell();
    } else if (!COMMANDS[cmd]) {
        out(`ModLingo-Hub-live ${LIVEMOD_VERSION} — MCP du projet ModLingo-Hub\n\nUsage : mcp <commande>   (sans commande : interface de traduction)\n  ui                 interface de traduction en texte (minecraft scan…)\n  setup              assistant de configuration (langue, jeux, clés de traduction)\n  update-node        cherche une mise à jour du Node portable (vérifiée SHA-256)\n  --Debug-start      relance l'assistant comme à la première utilisation\n  shell              shell MCP (recherche, glossaire, appel d'outils…)\n  start [--port n] [--no-web|--web]   lance le serveur MCP (--no-web = sans interface, léger)\n  stop               arrête le serveur\n  info               version, jeux, outils, état\n  data               dossier de données lu (projet ou flatpak)\n  edit [clé valeur]  édite la config (sans args : ouvre l'éditeur)\n  add <fichier.js>   ajoute un outil MCP ou une commande du shell\n  connect [claude|cursor|vscode] | remove <cible> | token | regen | test`);
        process.exitCode = cmd ? 1 : 0;
    } else {
        COMMANDS[cmd](args).catch((e) => { console.error(e.message); process.exitCode = 1; });
    }
}
