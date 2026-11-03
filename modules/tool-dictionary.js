'use strict';

/**
 * modules/tool-dictionary.js
 *
 * Système de "function calling" pour améliorer la qualité de traduction
 * de TOUS les modèles LM Studio.
 *
 * Principe:
 *  1. On envoie au modèle un tool "lookup_term" avec le glossaire du jeu
 *  2. Le modèle demande la traduction de termes qu'il ne connait pas
 *  3. On répond avec la bonne traduction depuis le glossaire
 *  4. Le modèle produit une traduction finale correcte
 *
 * Avantage: fonctionne avec n'importe quel modèle (Bonsai, Gemma, Llama, etc.)
 * Le glossaire n'est plus juste dans le prompt — le modèle le consulte activement.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

/* ── État global ── */
let toolModeEnabled = false;       // activé/désactivé par l'utilisateur
let toolGlossaryCache = null;       // cache du glossaire chargé
let toolGlossaryPath = '';          // chemin du glossaire actuel

/* ── Chargement du glossaire ── */

function loadGlossaryForTools(glossaryFile) {
    const glossaryPath = path.join(__dirname, '..', 'data', glossaryFile || 'bg3/glossary.json');
    if (glossaryPath === toolGlossaryPath && toolGlossaryCache) return toolGlossaryCache;
    try {
        if (!fs.existsSync(glossaryPath)) {
            toolGlossaryCache = {};
            toolGlossaryPath = glossaryPath;
            return toolGlossaryCache;
        }
        const raw = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
        const flat = {};
        for (const [section, entries] of Object.entries(raw)) {
            if (section.startsWith('_')) continue;
            if (typeof entries !== 'object') continue;
            for (const [en, fr] of Object.entries(entries)) {
                if (typeof fr === 'string' && en) {
                    flat[en.toLowerCase()] = { en, fr, section };
                }
            }
        }
        toolGlossaryCache = flat;
        toolGlossaryPath = glossaryPath;
        return flat;
    } catch {
        toolGlossaryCache = {};
        return toolGlossaryCache;
    }
}

/* ── Dictionnaire de corrections communes (hors glossaire) ── */
const COMMON_CORRECTIONS = {
    // Satisfactory
    'automated miner': { fr: 'Mineur Automatisé', note: 'Mineur est masculin' },
    'iron ore': { fr: 'minerai de fer', note: 'ore = minerai, jamais ore' },
    'copper ore': { fr: 'minerai de cuivre' },
    'ore': { fr: 'minerai', note: 'ore se traduit toujours par minerai, jamais ore' },
    'the ore': { fr: 'le minerai', note: 'ore = minerai' },
    'coal': { fr: 'charbon' },
    'oil': { fr: 'pétrole' },
    'conveyor belt': { fr: 'convoyeur', note: 'bande transporteuse aussi accepté' },
    'resource node': { fr: 'nœud de ressource' },
    'resource nodes': { fr: 'nœuds de ressource' },
    'iron ingot': { fr: 'lingot de fer', note: 'ingot = lingot' },
    'iron ingots': { fr: 'lingots de fer', note: 'ingot = lingot' },
    'copper ingot': { fr: 'lingot de cuivre' },
    'copper ingots': { fr: 'lingots de cuivre' },
    'building': { fr: 'bâtiment', note: 'ne jamais laisser building en anglais' },
    'smelter': { fr: 'Fonderie' },
    'constructor': { fr: 'Constructeur' },
    'assembler': { fr: 'Assembleur' },
    'manufacturer': { fr: 'Fabricant' },
    'biomass': { fr: 'Biomasse' },
    'splitter': { fr: 'Répartiteur' },
    'merger': { fr: 'Fusionneur' },
    // RPG général
    'altar': { fr: 'autel', note: 'jamais altare (italien)' },
    'mortal': { fr: 'mortel', note: 'masculin' },
    'turn back': { fr: 'fais demi-tour', note: 'pas "revenir" ni "rejoignez le chemin"' },
    'your kind': { fr: 'ton genre', note: 'pas "ton espèce"' },
    'ancient': { fr: 'ancien', note: 'masculin' },
    'runes': { fr: 'runes', note: 'féminin' },
    // Minecraft
    'log': { fr: 'bûche', note: 'Log = Bûche dans Minecraft' },
    'planks': { fr: 'planches' },
    'ingot': { fr: 'lingot' },
    'spawner': { fr: 'générateur' },
    // Verbes communs
    'extracts': { fr: 'extrait', note: 'extract = extraire' },
    'extract': { fr: 'extraire' },
    'processed': { fr: 'transformé', note: 'process = transformer/traiter' },
    'processed into': { fr: 'transformé en', note: 'process into = transformer en' },
    'placed': { fr: 'placé' },
    'connected': { fr: 'connecté' },
    'powered': { fr: 'alimenté', note: 'powered = alimenté en énergie' },
    'requires': { fr: 'nécessite' },
    'approach': { fr: 'approchez', note: 'you approach = vous approchez' },
    'glow': { fr: 'brillent', note: 'glow = briller' },
    'whispers': { fr: 'murmure' },
    'lies': { fr: 'se trouve', note: 'what lies beyond = ce qui se trouve au-delà' },
    // BG3 / D&D
    'rogue': { fr: 'Roublard' },
    'wizard': { fr: 'Magicien' },
    'sorcerer': { fr: 'Ensorceleur' },
    'warlock': { fr: 'Occultiste' },
    'cleric': { fr: 'Clerc' },
    'ranger': { fr: 'Rôdeur' },
    'fighter': { fr: 'Guerrier' },
    'barbarian': { fr: 'Barbare' },
    'spell': { fr: 'sort' },
    'cantrip': { fr: 'tour de magie' },
    'saving throw': { fr: 'jet de sauvegarde' },
    'hit points': { fr: 'points de vie' },
    'armor class': { fr: 'classe d\'armure' },
};

/* ── Recherche de terme ── */

function lookupTerm(englishTerm, glossary) {
    const key = englishTerm.toLowerCase().trim();
    // 1. Glossaire du jeu
    if (glossary && glossary[key]) {
        const entry = glossary[key];
        return { french: entry.fr, note: `glossaire (${entry.section})` };
    }
    // 2. Corrections communes
    if (COMMON_CORRECTIONS[key]) {
        const c = COMMON_CORRECTIONS[key];
        return { french: c.fr, note: c.note || 'correction commune' };
    }
    // 3. Recherche partielle dans le glossaire
    if (glossary) {
        for (const [glossKey, entry] of Object.entries(glossary)) {
            if (glossKey.includes(key) || key.includes(glossKey)) {
                return { french: entry.fr, note: `glossaire partiel (${entry.section})` };
            }
        }
    }
    // 4. Non trouvé
    return { french: englishTerm, note: 'terme non trouvé, garder tel quel' };
}

/* ── Définition du tool ── */

function getToolDefinition() {
    return [{
        type: 'function',
        function: {
            name: 'lookup_term',
            description: 'Look up the correct French translation for an English term. Use this for nouns, verbs, adjectives, technical terms, game-specific vocabulary, or ANY word you are not 100% sure how to translate correctly. Always check gender and spelling.',
            parameters: {
                type: 'object',
                properties: {
                    english_term: {
                        type: 'string',
                        description: 'The English term to look up (single word or short phrase)',
                    },
                },
                required: ['english_term'],
            },
        },
    }];
}

/* ── Requête HTTP vers LM Studio ── */

function httpPost(url, bodyStr, timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            port: parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
                'User-Agent': 'GameTranslator/1.0',
            },
        };
        const proto = parsed.protocol === 'https:' ? https : http;
        const req = proto.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP_${res.statusCode}: ${data.slice(0, 200)}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid JSON')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(bodyStr);
        req.end();
    });
}

/* ── Traduction avec tool calls (multi-turn) ── */

/**
 * Traduit un batch de textes en utilisant les tool calls.
 * Le modèle consulte le dictionnaire avant de traduire.
 *
 * @param {string[]} texts - Textes à traduire
 * @param {string} systemPrompt - Prompt système
 * @param {string} lmStudioUrl - URL de LM Studio
 * @param {string} model - Nom du modèle
 * @param {Object} glossary - Glossaire chargé
 * @param {Object} sampling - { temperature, top_p }
 * @param {Function} logger - Logger
 * @returns {Promise<string[]>} - Traductions
 */
async function translateWithTools(texts, systemPrompt, lmStudioUrl, model, glossary, sampling, logger) {
    const base = lmStudioUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
    const url = base + '/v1/chat/completions';
    const tools = getToolDefinition();
    const thinkOff = {
        reasoning: 'off',
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false, thinking: false },
    };

    const input = JSON.stringify(texts);
    const messages = [
        { role: 'system', content: systemPrompt + '\n\nCRITICAL INSTRUCTIONS FOR TOOL USE:\n1. You MUST call lookup_term for EVERY noun, verb, adjective, and technical term in the text.\n2. Especially check words like: ore, miner, building, ingot, node, belt, altar, mortal, spell, rune.\n3. Even if you think you know the translation, CALL THE TOOL to verify.\n4. Never leave an English word untranslated in the French output.\n5. After all lookups, produce the final JSON translation.' },
        { role: 'user', content: input },
    ];

    const log = logger || (() => {});

    // Étape 1: Demander au modèle de traduire avec tools
    let maxRounds = 2; // 1 round forcé + 1 round auto
    let totalToolCalls = 0;
    const askedTerms = new Set(); // éviter les boucles

    for (let round = 0; round < maxRounds; round++) {
        const body = {
            model,
            messages,
            tools,
            tool_choice: round === 0 ? 'required' : 'auto', // forcer le 1er tour
            temperature: sampling.temperature,
            top_p: sampling.top_p,
            ...thinkOff,
            max_tokens: 4000,
        };

        log(`[tools] Round ${round + 1}: envoi...`);
        const resp = await httpPost(url, JSON.stringify(body));

        const choice = resp.choices?.[0];
        if (!choice) throw new Error('Pas de choix dans la réponse');

        const msg = choice.message;

        // Si le modèle a fait des tool calls
        if (msg.tool_calls && msg.tool_calls.length > 0) {
            // Ajouter la réponse de l'assistant avec les tool calls
            messages.push({
                role: 'assistant',
                content: msg.content || null,
                tool_calls: msg.tool_calls,
            });

            // Répondre à chaque tool call
            let newTerms = 0;
            for (const tc of msg.tool_calls) {
                const fn = tc.function;
                let term = '';
                try { term = JSON.parse(fn.arguments).english_term; } catch { term = fn.arguments; }
                const termKey = term.toLowerCase().trim();
                const result = lookupTerm(term, glossary);
                totalToolCalls++;
                log(`[tools] → "${term}" = "${result.french}" (${result.note})`);
                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify(result),
                });
                if (!askedTerms.has(termKey)) {
                    askedTerms.add(termKey);
                    newTerms++;
                }
            }
            // Si tous les termes ont déjà été demandés, on force la traduction
            if (newTerms === 0 && round > 0) {
                log(`[tools] ⚠️ Termes répétés, passage à la traduction...`);
                break;
            }
            // Continuer au prochain round pour laisser le modèle traduire
            continue;
        }

        // Si pas de tool calls, on a la traduction finale
        if (msg.content) {
            log(`[tools] ✅ Traduction reçue après ${totalToolCalls} lookup(s)`);
            // Parser le JSON
            const stripped = String(msg.content).replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
            let parsed;
            try {
                parsed = JSON.parse(stripped);
            } catch {
                const match = stripped.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
                if (!match) {
                    // Si pas de JSON, retourner le texte brut pour chaque entrée
                    return texts.map(() => String(msg.content).trim());
                }
                parsed = JSON.parse(match[0]);
            }
            let arr;
            if (Array.isArray(parsed)) arr = parsed;
            else if (parsed && Array.isArray(parsed.translations)) arr = parsed.translations;
            else {
                // Pas de format attendu, retourner le texte brut
                return texts.map(() => String(msg.content).trim());
            }
            while (arr.length < texts.length) arr.push('');
            if (arr.length > texts.length) arr.length = texts.length;
            return arr.map(x => (x == null ? '' : String(x)));
        }

        // Si contenu vide et pas de tool calls, réessayer sans tools
        log(`[tools] ⚠️ Réponse vide au round ${round + 1}, retry sans tools...`);
        break;
    }

    // Fallback: traduire sans tools (mode normal)
    log(`[tools] Fallback: traduction sans tools après ${totalToolCalls} lookup(s)`);
    const fallbackBody = {
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: input },
        ],
        temperature: sampling.temperature,
        top_p: sampling.top_p,
        ...thinkOff,
        max_tokens: 4000,
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'translations',
                strict: true,
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        translations: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['translations'],
                },
            },
        },
    };
    const fallbackResp = await httpPost(url, JSON.stringify(fallbackBody));
    const fallbackMsg = fallbackResp.choices?.[0]?.message?.content || '';
    const stripped = String(fallbackMsg).replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    try {
        const parsed = JSON.parse(stripped);
        let arr;
        if (Array.isArray(parsed)) arr = parsed;
        else if (parsed && Array.isArray(parsed.translations)) arr = parsed.translations;
        else arr = texts.map(() => '');
        while (arr.length < texts.length) arr.push('');
        if (arr.length > texts.length) arr.length = texts.length;
        return arr.map(x => (x == null ? '' : String(x)));
    } catch {
        return texts.map(() => '');
    }
}

/* ── API ── */

module.exports = function register(app) {
    // Obtenir l'état du tool mode
    app.get('/api/llm/tool-mode', (req, res) => {
        res.json({ enabled: toolModeEnabled });
    });

    // Activer/désactiver le tool mode
    app.post('/api/llm/tool-mode', (req, res) => {
        const { enabled } = req.body;
        if (typeof enabled === 'boolean') {
            toolModeEnabled = enabled;
            console.log(`[tools] Tool mode ${enabled ? 'activé' : 'désactivé'}`);
        }
        res.json({ enabled: toolModeEnabled });
    });

    // Tester le tool mode sur un texte
    app.post('/api/llm/tool-test', async (req, res) => {
        const { text, glossaryFile } = req.body;
        if (!text) return res.json({ ok: false, error: 'texte requis' });

        try {
            const glossary = loadGlossaryForTools(glossaryFile);
            const lmStudioUrl = 'http://localhost:1234';
            const model = 'prism-ml/bonsai-27b'; // sera détecté dynamiquement
            const logs = [];
            const logger = (msg) => { logs.push(msg); console.log(msg); };

            const translations = await translateWithTools(
                [text],
                'Translate to French. Return ONLY {"translations":["..."]}.',
                lmStudioUrl,
                model,
                glossary,
                { temperature: 0.2, top_p: 0.9 },
                logger
            );

            res.json({ ok: true, translation: translations[0], logs, toolCalls: logs.filter(l => l.includes('→')).length });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });
};

/* ── Exports pour translator.js ── */

module.exports.translateWithTools = translateWithTools;
module.exports.loadGlossaryForTools = loadGlossaryForTools;
module.exports.isToolModeEnabled = () => toolModeEnabled;
module.exports.setToolMode = (v) => { toolModeEnabled = v; };
module.exports.lookupTerm = lookupTerm;
module.exports.COMMON_CORRECTIONS = COMMON_CORRECTIONS;
