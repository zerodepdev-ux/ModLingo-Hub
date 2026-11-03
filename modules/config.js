'use strict';

const https = require('https');
const path = require('path');
const fs = require('fs');
const { loadConfig, saveConfig, invalidateApicleCache, dirExists, looksLikeWindowsPath, detectBg3GameDirs, loadLinks } = require('./shared');
const { detectMinecraftInstancesDir, getMinecraftInstancesPath } = require('./minecraft');
const { reloadApicleConfig, getLmStudioStatus } = require('../translator');

module.exports = function register(app) {
    const saveEnvPath = path.join(__dirname, '..', 'data', 'Save_Autre', 'Save.env');
    const exampleEnvPath = path.join(__dirname, '..', 'data', 'Save_Autre', 'ExSave.env');
    const secretEnvKeys = new Set(['KeyOpenRouter', 'KeyGemini', 'KeyDeepL']);
    const editableEnvKeys = new Set([
        'KeyOpenRouter', 'KeyGemini', 'KeyDeepL',
        'LMStudioUrl', 'LMStudioModel', 'LMStudioEnabled', 'LMStudioParallel',
        'LMStudioMaxTokens', 'LMStudioContextTokens', 'LMStudioMode',
        'GoogleFastEnabled', 'GoogleFastConcurrency', 'GoogleFastDelayMs',
        'GoogleFastMaxRetries', 'GoogleFastMaxChars', 'GoogleFastMaxTokens',
        'OpenRouterModel', 'OpenRouterMinIntervalMs', 'OpenRouterMaxRetries',
        'OpenRouterChunkMax', 'MaxApiCallsPerSecond', 'TargetLanguage',
        'SourceLanguage', 'CacheEnabled', 'CacheSaveDelayMs', 'ProviderSplit',
        'PrivacyMode',
    ]);

    function parseEnvLines(content) {
        const values = {};
        for (const line of String(content || '').split(/\r?\n/)) {
            const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
        }
        return values;
    }

    function readEnvFile(filePath) {
        try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
    }

    function extractEnvKeys(content) {
        const keys = new Set();
        for (const match of String(content || '').matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) keys.add(match[1]);
        return keys;
    }

    function ensureSaveEnv() {
        fs.mkdirSync(path.dirname(saveEnvPath), { recursive: true });
        const example = readEnvFile(exampleEnvPath);
        if (!fs.existsSync(saveEnvPath)) {
            fs.writeFileSync(saveEnvPath, example || '# Save.env\n', { mode: 0o600 });
            return;
        }

        // Merge only missing KEY= entries from ExSave.env. Existing values,
        // comments and unknown application options are never removed or read
        // back to the client. This lets the template grow safely over time.
        const current = readEnvFile(saveEnvPath);
        const currentKeys = extractEnvKeys(current);
        const missingLines = [];
        for (const line of example.split(/\r?\n/)) {
            const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (match && !currentKeys.has(match[1])) {
                missingLines.push(line.trim());
                currentKeys.add(match[1]);
            }
        }
        if (missingLines.length > 0) {
            const suffix = current.replace(/\s*$/, '');
            fs.writeFileSync(saveEnvPath, `${suffix}\n${missingLines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
        }
    }

    // Synchronise missing template keys once when the server starts.
    ensureSaveEnv();

    function maskEnvValue(key, value) {
        if (!value || value === 'Null') return { configured: false, value: '' };
        if (!secretEnvKeys.has(key)) return { configured: true, value };
        return { configured: true, value: `${value.slice(0, 4)}...${value.slice(-4)}` };
    }

    function updateEnvWithoutDeleting(values) {
        ensureSaveEnv();
        const original = readEnvFile(saveEnvPath);
        const seen = new Set();
        const lines = original.split(/\r?\n/).map(line => {
            const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*?)(\s*)$/);
            if (!match || !Object.prototype.hasOwnProperty.call(values, match[2])) return line;
            const key = match[2];
            const value = String(values[key] ?? '');
            seen.add(key);
            return `${match[1]}${key}${match[3]}${value}${match[5]}`;
        });
        for (const [key, value] of Object.entries(values)) {
            if (seen.has(key)) continue;
            lines.push(`${key}=${String(value ?? '')}`);
        }
        const output = lines.join('\n').replace(/\n*$/, '\n');
        fs.writeFileSync(saveEnvPath, output, { encoding: 'utf8', mode: 0o600 });
    }

    app.get('/api/save-env/config', (req, res) => {
        try {
            ensureSaveEnv();
            const values = parseEnvLines(readEnvFile(saveEnvPath));
            const safeValues = {};
            for (const key of editableEnvKeys) {
                if (Object.prototype.hasOwnProperty.call(values, key)) safeValues[key] = maskEnvValue(key, values[key]);
            }
            res.json({ ok: true, keys: safeValues, path: 'data/Save_Autre/Save.env' });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    app.post('/api/save-env/config', (req, res) => {
        try {
            const input = req.body && typeof req.body.values === 'object' ? req.body.values : {};
            const values = {};
            for (const [key, value] of Object.entries(input)) {
                if (!editableEnvKeys.has(key)) continue;
                if (secretEnvKeys.has(key) && (!value || String(value).includes('...'))) continue;
                values[key] = String(value ?? '');
            }
            updateEnvWithoutDeleting(values);
            res.json({ ok: true, updated: Object.keys(values).length, path: 'data/Save_Autre/Save.env' });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    app.get('/api/config', (req, res) => {
        try { getMinecraftInstancesPath(); } catch {}
        res.json(loadConfig());
    });

    const PATH_KEYS = [
        'modsFolder', 'hytaleLanguageFolder', 'hytaleModsFolder',
        'satisfactoryModsFolder', 'minecraftInstancesFolder',
        'advrModsFolder', 'ror2ProfileFolder',
        'repoGameFolder', 'repoModsFolder', 'backupFolder',
    ];

    function describePath(value) {
        const v = (value || '').trim();
        return {
            value: v,
            exists: dirExists(v),
            windowsOnLinux: !!(v && looksLikeWindowsPath(v) && process.platform !== 'win32'),
        };
    }

    app.get('/api/config/paths-status', (req, res) => {
        const cfg = loadConfig();
        const paths = {};
        for (const k of PATH_KEYS) {
            const live = req.query[k];
            paths[k] = describePath(live != null ? String(live) : cfg[k]);
        }
        res.json({
            platform: process.platform,
            linux: process.platform !== 'win32',
            paths,
            detectedBg3: detectBg3GameDirs(),
            detectedMinecraft: detectMinecraftInstancesDir() || '',
        });
    });

    app.post('/api/config/detect', (req, res) => {
        const game = String((req.body && req.body.game) || '');
        if (game === 'bg3') {
            const found = detectBg3GameDirs();
            return res.json({
                ok: !!found,
                game,
                paths: found ? { modsFolder: found.modsFolder, modsettingsPath: found.modsettingsPath } : {},
                error: found ? null : 'BG3 introuvable (pas de prefix Proton / jeu pas installé).',
            });
        }
        if (game === 'minecraft') {
            const found = detectMinecraftInstancesDir();
            return res.json({
                ok: !!found,
                game,
                paths: found ? { minecraftInstancesFolder: found } : {},
                error: found ? null : 'Dossier instances introuvable (PrismLauncher Flatpak / natif, MultiMC, ATLauncher).',
            });
        }
        res.json({ ok: false, game, paths: {}, error: 'Laisse vide pour l’auto-détection de ce jeu.' });
    });

    /* ════════════════════════════════════════════════════════════
       SMART INSTALL — détecte TOUS les dossiers en une passe
       ════════════════════════════════════════════════════════════ */

    // Helper: normaliser les chemins host vus depuis un sandbox Flatpak
    // /var/home/USER → $HOME (le flatpak mappe ~/ vers $HOME)
    function normalizeHostPath(p) {
        if (!p) return p;
        const home = process.env.HOME || '';
        const hostHome = '/var/home/' + (process.env.USER || '') || home;
        return p.replace(new RegExp('^/var/home/' + (process.env.USER || '[^/]+')), home || '/var/home/' + (process.env.USER || ''));
    }

    // Helper: liste des racines Steam (common) détectables depuis ce process
    function steamCommonRoots() {
        const roots = [];
        const home = process.env.HOME || '';
        if (process.platform !== 'win32') {
            for (const base of [
                path.join(home, '.steam', 'steam'),
                path.join(home, '.local', 'share', 'Steam'),
                path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.steam', 'steam'),
                path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
            ]) {
                if (fs.existsSync(path.join(base, 'steamapps'))) roots.push(base);
            }
            // libraryfolders.vdf (natif + flatpak Steam)
            for (const libFile of [
                path.join(home, '.steam', 'steam', 'steamapps', 'libraryfolders.vdf'),
                path.join(home, '.local', 'share', 'Steam', 'steamapps', 'libraryfolders.vdf'),
            ]) {
                if (!fs.existsSync(libFile)) continue;
                try {
                    const content = fs.readFileSync(libFile, 'utf8');
                    const m = content.match(/"path"\s+"([^"]+)"/g) || [];
                    for (const mm of m) {
                        let p = mm.replace(/^"path"\s+"/, '').replace(/"$/, '');
                        p = normalizeHostPath(p);
                        if (fs.existsSync(path.join(p, 'steamapps'))) roots.push(p);
                    }
                } catch {}
            }
        } else {
            roots.push('C:\\Program Files (x86)\\Steam');
        }
        return roots;
    }

    // Helper: trouver un dossier de jeu sous les racines Steam
    function findSteamGame(rel) {
        for (const root of steamCommonRoots()) {
            const cand = path.join(root, 'steamapps', 'common', rel);
            if (fs.existsSync(cand)) return cand;
        }
        return null;
    }

    app.get('/api/config/smart-detect', (req, res) => {
        const result = { detected: {}, missing: {} };
        const cfg = loadConfig();

        // BG3
        try {
            const found = detectBg3GameDirs();
            result.detected.modsFolder = found ? found.modsFolder : null;
            result.detected.modsettingsPath = found ? found.modsettingsPath : null;
        } catch { result.detected.modsFolder = null; }

        // Minecraft (instances)
        try {
            result.detected.minecraftInstancesFolder = detectMinecraftInstancesDir() || null;
        } catch { result.detected.minecraftInstancesFolder = null; }

        // Satisfactory — scan des bibliothèques Steam
        try {
            const candidates = [];
            if (process.platform !== 'win32') {
                const common = [
                    '/mnt/Jeux/SteamLibrary/steamapps/common',
                ];
                for (const base of common) {
                    const p = path.join(base, 'Satisfactory', 'FactoryGame', 'Mods');
                    if (fs.existsSync(p)) candidates.push(p);
                }
            }
            const game = findSteamGame('Satisfactory');
            if (game) candidates.push(path.join(game, 'FactoryGame', 'Mods'));
            result.detected.satisfactoryModsFolder = candidates.find(fs.existsSync) || null;
        } catch { result.detected.satisfactoryModsFolder = null; }

        // Hytale — dossier UserData
        try {
            const home = process.env.HOME || process.env.USERPROFILE || '';
            const candidates = [
                path.join(home, '.var', 'app', 'com.hytale.Hytale', 'config', 'Hytale', 'UserData'),
                path.join(home, 'AppData', 'Roaming', 'Hytale', 'UserData'),
                path.join(home, '.local', 'share', 'Hytale', 'UserData'),
            ];
            const hytaleMods = candidates
                .map(c => path.join(c, 'Mods'))
                .find(fs.existsSync);
            result.detected.hytaleModsFolder = hytaleMods || null;
            result.detected.hytaleLanguageFolder = hytaleMods || null;
        } catch { result.detected.hytaleModsFolder = null; }

        // RoR2 — r2modman profiles
        try {
            const home = process.env.HOME || process.env.USERPROFILE || '';
            const candidates = [
                path.join(home, 'AppData', 'Roaming', 'r2modmanPlus-local', 'RiskOfRain2', 'profiles', 'Default'),
                path.join(home, '.local', 'share', 'r2modmanPlus-local', 'RiskOfRain2', 'profiles', 'Default'),
                path.join(home, '.var', 'app', 'com.Thunderstore.r2modman', 'config', 'r2modmanPlus-local', 'RiskOfRain2', 'profiles', 'Default'),
            ];
            const found = candidates.find(fs.existsSync);
            if (found) {
                // Trouver le dernier profil modifié sinon
                result.detected.ror2ProfileFolder = found;
            } else {
                // Chercher tous les profils
                const base = candidates[0] && candidates[0].replace(/Default$/, '');
                if (base && fs.existsSync(base)) {
                    const profs = fs.readdirSync(base).filter(d => fs.existsSync(path.join(base, d, 'BepInEx')));
                    if (profs.length) result.detected.ror2ProfileFolder = path.join(base, profs[0]);
                }
            }
        } catch { result.detected.ror2ProfileFolder = null; }

        // R.E.P.O.
        try {
            const candidates = [
                '/mnt/Jeux/SteamLibrary/steamapps/common/REPO',
            ];
            const game = findSteamGame('REPO');
            if (game) candidates.push(game);
            result.detected.repoGameFolder = candidates.find(fs.existsSync) || null;
        } catch { result.detected.repoGameFolder = null; }

        // ADVR
        try {
            const home = process.env.HOME || process.env.USERPROFILE || '';
            const candidates = [
                path.join(home, 'AppData', 'LocalLow', 'AncientDungeonVR', 'Mods'),
                path.join(home, 'AppData', 'LocalLow', 'Ancient Dungeon VR', 'Mods'),
                path.join(home, '.config', 'unity3d', 'AncientDungeonVR'),
            ];
            result.detected.advrModsFolder = candidates.find(fs.existsSync) || null;
        } catch { result.detected.advrModsFolder = null; }

        res.json(result);
    });

    /* ════════════════════════════════════════════════════════════
       SMART INSTALL — applique les chemins détectés dans la config
       ════════════════════════════════════════════════════════════ */
    app.post('/api/config/smart-apply', (req, res) => {
        const updates = (req.body && req.body.paths) || {};
        const cfg = loadConfig();
        let changed = 0;
        for (const key of Object.keys(updates)) {
            const v = (updates[key] || '').trim();
            if (!v) continue;
            if (cfg[key] !== v) { cfg[key] = v; changed++; }
        }
        if (changed > 0) saveConfig(cfg);
        res.json({ ok: true, changed, config: cfg });
    });

    app.post('/api/config', (req, res) => {
        const { modsFolder, modsettingsPath, hytaleLanguageFolder, hytaleModsFolder, satisfactoryModsFolder, minecraftInstancesFolder, advrModsFolder, ror2ProfileFolder, repoGameFolder, repoModsFolder, backupFolder, libreTranslateUrl, libreTranslateEnabled } = req.body;
        const cfg = loadConfig();
        if (modsFolder !== undefined) cfg.modsFolder = modsFolder;
        if (modsettingsPath !== undefined) cfg.modsettingsPath = modsettingsPath;
        if (hytaleLanguageFolder !== undefined) cfg.hytaleLanguageFolder = hytaleLanguageFolder;
        if (hytaleModsFolder !== undefined) cfg.hytaleModsFolder = hytaleModsFolder;
        if (satisfactoryModsFolder !== undefined) cfg.satisfactoryModsFolder = satisfactoryModsFolder;
        if (minecraftInstancesFolder !== undefined) cfg.minecraftInstancesFolder = minecraftInstancesFolder;
        if (advrModsFolder !== undefined) cfg.advrModsFolder = advrModsFolder;
        if (ror2ProfileFolder !== undefined) cfg.ror2ProfileFolder = ror2ProfileFolder;
        if (repoGameFolder !== undefined) cfg.repoGameFolder = repoGameFolder;
        if (repoModsFolder !== undefined) cfg.repoModsFolder = repoModsFolder;
        if (backupFolder !== undefined) cfg.backupFolder = backupFolder;
        if (libreTranslateUrl !== undefined) cfg.libreTranslateUrl = libreTranslateUrl;
        if (libreTranslateEnabled !== undefined) cfg.libreTranslateEnabled = libreTranslateEnabled;
        saveConfig(cfg);
        res.json({ ok: true, config: cfg });
    });

    app.post('/api/libretranslate-config', (req, res) => {
        const { url, enabled } = req.body;
        try {
            const apiPath = path.join(__dirname, '..', 'data', 'APIcle.json');
            const apiData = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
            if (!apiData.libretranslate) apiData.libretranslate = {};
            if (url !== undefined) apiData.libretranslate.url = url;
            if (enabled !== undefined) apiData.libretranslate.enabled = enabled;
            fs.writeFileSync(apiPath, JSON.stringify(apiData, null, 2) + '\n', 'utf8');
            invalidateApicleCache();
            reloadApicleConfig();
            res.json({ ok: true });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    app.post('/api/gemini-config', (req, res) => {
        const { key, model } = req.body;
        try {
            const apiPath = path.join(__dirname, '..', 'data', 'APIcle.json');
            const apiData = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
            if (!apiData.gemini) apiData.gemini = {};
            if (key !== undefined) apiData.gemini.key = key;
            if (model !== undefined) apiData.gemini.model = model;
            fs.writeFileSync(apiPath, JSON.stringify(apiData, null, 2) + '\n', 'utf8');
            invalidateApicleCache();
            reloadApicleConfig();
            res.json({ ok: true });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    app.get('/api/gemini-config', (req, res) => {
        try {
            const apiPath = path.join(__dirname, '..', 'data', 'APIcle.json');
            const apiData = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
            const g = apiData.gemini || {};
            // Never send the full key — just a masked hint
            const key = g.key || '';
            const maskedKey = key.length > 8 ? key.slice(0, 6) + '...' + key.slice(-4) : (key ? '***' : '');
            res.json({ hasKey: !!key, maskedKey, model: g.model || 'gemini-2.0-flash-lite' });
        } catch (e) {
            res.json({ hasKey: false, maskedKey: '', model: 'gemini-2.0-flash-lite' });
        }
    });

    app.post('/api/curseforge-config', async (req, res) => {
        const { key } = req.body || {};
        if (typeof key !== 'string' || key.length > 200 || /[\r\n]/.test(key)) return res.json({ ok: false, error: 'Clé invalide' });
        try {
            const apiPath = path.join(__dirname, '..', 'data', 'APIcle.json');
            const apiData = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
            if (!apiData.curseforge) apiData.curseforge = {};
            apiData.curseforge.key = key.trim();
            fs.writeFileSync(apiPath, JSON.stringify(apiData, null, 2) + '\n', 'utf8');
            invalidateApicleCache();
            let valid = null, status = null;
            if (key.trim()) {
                try {
                    const r = await fetch('https://api.curseforge.com/v1/mods/925200', { headers: { 'x-api-key': key.trim(), Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
                    status = r.status; valid = r.ok;
                } catch { valid = null; }
            }
            res.json({ ok: true, hasKey: !!key.trim(), valid, status });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    app.get('/api/curseforge-config', (req, res) => {
        try {
            const apiData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'APIcle.json'), 'utf8'));
            const key = String(apiData.curseforge?.key || '');
            const maskedKey = key.length > 8 ? key.slice(0, 4) + '...' + key.slice(-4) : (key ? '***' : '');
            res.json({ hasKey: !!key, maskedKey });
        } catch (e) {
            res.json({ hasKey: false, maskedKey: '' });
        }
    });

    app.post('/api/openrouter-config', (req, res) => {
        const { key, model } = req.body;
        try {
            const apiPath = path.join(__dirname, '..', 'data', 'APIcle.json');
            const apiData = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
            if (!apiData.openrouter) apiData.openrouter = {};
            if (key !== undefined) apiData.openrouter.key = key;
            if (model !== undefined) apiData.openrouter.model = model || 'openrouter/free';
            fs.writeFileSync(apiPath, JSON.stringify(apiData, null, 2) + '\n', 'utf8');
            invalidateApicleCache();
            reloadApicleConfig();
            res.json({ ok: true });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    app.get('/api/openrouter-config', (req, res) => {
        try {
            const apiPath = path.join(__dirname, '..', 'data', 'APIcle.json');
            const apiData = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
            const cfg = apiData.openrouter || {};
            const key = cfg.key || '';
            const maskedKey = key.length > 8 ? key.slice(0, 6) + '...' + key.slice(-4) : (key ? '***' : '');
            res.json({ hasKey: !!key, maskedKey, model: cfg.model || 'openrouter/free' });
        } catch (e) {
            res.json({ hasKey: false, maskedKey: '', model: 'openrouter/free' });
        }
    });

    app.get('/api/openrouter-models', (req, res) => {
        try {
            const apiPath = path.join(__dirname, '..', 'data', 'APIcle.json');
            const apiData = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
            const key = String(apiData.openrouter?.key || '').trim();
            if (!key) return res.json({ ok: false, error: 'Clé OpenRouter manquante' });
            const request = https.get('https://openrouter.ai/api/v1/models', {
                headers: { Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://github.com/zerodepdev-ux/ModLingo-Hub', 'X-Title': 'ModLingo-Hub' },
                timeout: 15000,
            }, upstream => {
                let raw = '';
                upstream.on('data', chunk => { raw += chunk; });
                upstream.on('end', () => {
                    try {
                        const payload = JSON.parse(raw);
                        if (upstream.statusCode !== 200) return res.json({ ok: false, error: payload.error?.message || `OpenRouter HTTP ${upstream.statusCode}` });
                        const models = (payload.data || [])
                            .filter(model => model && model.id && /:free$/i.test(model.id))
                            .filter(model => !/(safety|embed|moderation|audio|image|vision)/i.test(`${model.id} ${model.name || ''}`))
                            .map(model => ({
                                id: model.id,
                                name: model.name || model.id,
                                contextLength: model.context_length || 0,
                                promptPrice: model.pricing?.prompt || '0',
                                completionPrice: model.pricing?.completion || '0',
                                maxCompletionTokens: model.top_provider?.max_completion_tokens || 0,
                            }))
                            .sort((a, b) => a.name.localeCompare(b.name));
                        res.json({ ok: true, models, count: models.length });
                    } catch { res.json({ ok: false, error: 'Réponse OpenRouter invalide' }); }
                });
            });
            request.on('error', error => res.json({ ok: false, error: error.message }));
            request.on('timeout', () => request.destroy(new Error('Timeout OpenRouter')));
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    app.post('/api/libretranslate-test', async (req, res) => {
        const { url } = req.body;
        if (!url) return res.json({ ok: false, error: 'URL manquante' });
        try {
            const proto = url.startsWith('https') ? require('https') : require('http');
            const langUrl = url.replace(/\/+$/, '') + '/languages';
            const result = await new Promise((resolve, reject) => {
                const reqApi = proto.get(langUrl, { timeout: 5000 }, (apiRes) => {
                    let data = '';
                    apiRes.on('data', c => { data += c; });
                    apiRes.on('end', () => {
                        if (apiRes.statusCode !== 200) {
                            reject(new Error(`HTTP ${apiRes.statusCode}`));
                            return;
                        }
                        try { resolve(JSON.parse(data)); }
                        catch { reject(new Error('Réponse invalide')); }
                    });
                });
                reqApi.on('error', reject);
                reqApi.on('timeout', () => { reqApi.destroy(); reject(new Error('Timeout')); });
            });
            if (Array.isArray(result) && result.length > 0) {
                res.json({ ok: true, languages: result.length });
            } else {
                res.json({ ok: false, error: 'Aucune langue disponible' });
            }
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    app.get('/api/lmstudio-config', (req, res) => {
        try {
            const apiPath = path.join(__dirname, '..', 'data', 'APIcle.json');
            const apiData = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
            const cfg = apiData.lmstudio || {};
            ensureSaveEnv();
            const env = parseEnvLines(readEnvFile(saveEnvPath));
            const envValue = (key, fallback) => {
                const value = env[key];
                return value === undefined || value === '' || value.toLowerCase() === 'null' ? fallback : value;
            };
            res.json({
                url: envValue('LMStudioUrl', cfg.url || 'http://127.0.0.1:1234'),
                model: envValue('LMStudioModel', cfg.model || ''),
                enabled: String(envValue('LMStudioEnabled', cfg.enabled !== false)).toLowerCase() !== 'false',
                parallel: Math.max(1, Math.min(4, parseInt(envValue('LMStudioParallel', cfg.parallel), 10) || 4)),
                maxTokens: Math.max(256, Math.min(4096, parseInt(envValue('LMStudioMaxTokens', cfg.maxTokens), 10) || 2048)),
                contextTokens: Math.max(2048, Math.min(32768, parseInt(envValue('LMStudioContextTokens', cfg.contextTokens), 10) || 4096)),
                mode: envValue('LMStudioMode', cfg.mode) === 'fast' ? 'fast' : 'quality',
            });
        } catch (e) {
            res.json({ url: 'http://127.0.0.1:1234', model: '', enabled: true, parallel: 4, maxTokens: 2048, contextTokens: 4096, mode: 'quality', error: e.message });
        }
    });

    app.post('/api/lmstudio-config', (req, res) => {
        const { url, model, enabled, parallel, maxTokens, contextTokens, mode } = req.body;
        try {
            const apiPath = path.join(__dirname, '..', 'data', 'APIcle.json');
            const apiData = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
            if (!apiData.lmstudio) apiData.lmstudio = {};
            if (url !== undefined) apiData.lmstudio.url = url;
            if (model !== undefined) apiData.lmstudio.model = model;
            if (enabled !== undefined) apiData.lmstudio.enabled = enabled;
            if (parallel !== undefined) {
                const n = parseInt(parallel, 10);
                apiData.lmstudio.parallel = Number.isFinite(n) ? Math.max(1, Math.min(4, n)) : 4;
            }
            if (maxTokens !== undefined) {
                const n = parseInt(maxTokens, 10);
                apiData.lmstudio.maxTokens = Number.isFinite(n) ? Math.max(256, Math.min(4096, n)) : 2048;
            }
            if (contextTokens !== undefined) {
                const n = parseInt(contextTokens, 10);
                apiData.lmstudio.contextTokens = Number.isFinite(n) ? Math.max(2048, Math.min(32768, n)) : 4096;
            }
            if (mode !== undefined) apiData.lmstudio.mode = mode === 'fast' ? 'fast' : 'quality';
            fs.writeFileSync(apiPath, JSON.stringify(apiData, null, 2) + '\n', 'utf8');
            const envValues = {};
            if (url !== undefined) envValues.LMStudioUrl = String(url);
            if (model !== undefined) envValues.LMStudioModel = String(model);
            if (enabled !== undefined) envValues.LMStudioEnabled = String(enabled);
            if (parallel !== undefined) envValues.LMStudioParallel = String(apiData.lmstudio.parallel);
            if (maxTokens !== undefined) envValues.LMStudioMaxTokens = String(apiData.lmstudio.maxTokens);
            if (contextTokens !== undefined) envValues.LMStudioContextTokens = String(apiData.lmstudio.contextTokens);
            if (mode !== undefined) envValues.LMStudioMode = apiData.lmstudio.mode;
            if (Object.keys(envValues).length) updateEnvWithoutDeleting(envValues);
            invalidateApicleCache();
            reloadApicleConfig();
            res.json({ ok: true });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    /* ================================================================
       EXPORT / IMPORT CONFIGURATION
       ================================================================ */
    app.get('/api/config/export', (req, res) => {
        try {
            const root = path.join(__dirname, '..');
            const cfg = loadConfig();
            const links = loadLinks();

            const readJson = (p) => {
                try { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')); } catch { return {}; }
            };

            const exportData = {
                exportedAt: new Date().toISOString(),
                config: cfg,
                links,
                bg3Glossary: readJson('data/bg3/glossary.json'),
            };

            res.json({ ok: true, data: exportData });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/config/import', (req, res) => {
        try {
            const { data } = req.body;
            if (!data || typeof data !== 'object') return res.status(400).json({ ok: false, error: 'data manquant' });

            const root = path.join(__dirname, '..');

            if (data.config && typeof data.config === 'object') {
                saveConfig(data.config);
            }
            if (Array.isArray(data.links)) {
                const linksPath = path.join(root, 'data', 'links.json');
                fs.mkdirSync(path.dirname(linksPath), { recursive: true });
                fs.writeFileSync(linksPath, JSON.stringify({ links: data.links }, null, 2) + '\n', 'utf8');
            }
            if (data.bg3Glossary && typeof data.bg3Glossary === 'object') {
                const glossaryPath = path.join(root, 'data', 'bg3', 'glossary.json');
                fs.mkdirSync(path.dirname(glossaryPath), { recursive: true });
                fs.writeFileSync(glossaryPath, JSON.stringify(data.bg3Glossary, null, 2) + '\n', 'utf8');
            }

            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/lmstudio-status', async (req, res) => {
        try {
            const status = await getLmStudioStatus();
            res.json(status);
        } catch (e) {
            res.json({ ok: false, enabled: true, url: 'http://127.0.0.1:1234', model: '', contextTokens: 4096, mode: 'quality', error: e.message });
        }
    });

};
