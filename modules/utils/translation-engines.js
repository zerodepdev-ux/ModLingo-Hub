'use strict';

/**
 * translation-engines.js — registre des moteurs de traduction.
 *
 * Les dix fonctions de traduction de translator.js ont des signatures qui vont
 * de trois à sept paramètres (texts, srcLang, tgtLang, puis selon les cas
 * logger, glossaryFile, opts, compact, contextHint, batchMode). Résultat :
 * l'ordre de repli et les tailles de lot étaient câblés en dur dans les
 * 985 lignes de translateBatch, et rien n'était testable sans réseau.
 *
 * Ce module ne contient aucune logique de traduction : il décrit les moteurs
 * (taille de lot, clés de stats, erreurs fatales) et expose pour chacun un
 * `call(texts, ctx)` uniforme qui adapte l'appel à la vraie fonction. Les
 * implémentations sont injectées, donc les tests passent des doublures.
 *
 *   const registry = createEngineRegistry({ translateDeepLBatch, ... });
 *   const engine = registry.get('gemini');
 *   const out = await engine.call(texts, { srcLang, tgtLang, logger });
 */

/**
 * Ordre de repli, du plus souhaitable au dernier recours.
 * C'est la seule source de vérité de cet ordre.
 */
const FALLBACK_ORDER = [
    'deepl',        // payant, meilleure qualité, lots de 50
    'google-fast',  // voie rapide pour les chaînes courtes et simples
    'libre',        // local, illimité
    'gemini',       // nuage, seulement si LM Studio n'est pas prêt
    'openrouter',   // nuage gratuit, en parallèle des autres
    'lmstudio',     // local, gratuit, lent
    'google',       // par vagues, avec progression
    'mymemory',     // dernier recours
];

/**
 * Descripteurs. `fatalErrors` liste les messages d'erreur qui doivent
 * désactiver le moteur pour le reste du lot au lieu de simplement passer au
 * suivant (clé invalide, quota épuisé, langue non supportée).
 */
const DESCRIPTORS = {
    deepl: {
        label: 'DeepL',
        emoji: '📦',
        chunkSize: 50,
        statKey: 'deeplCalls',
        errorKey: 'deeplErrors',
        fatalErrors: ['DEEPL_AUTH_FAILED', 'DEEPL_QUOTA_EXCEEDED', 'DEEPL_NO_KEY', 'DEEPL_UNSUPPORTED_LANG'],
        cloud: true,
        batch: true,
    },
    'google-fast': {
        label: 'Google (voie rapide)',
        emoji: '⚡',
        chunkSize: 100,
        statKey: 'googleFastCalls',
        errorKey: null,
        fatalErrors: [],
        cloud: true,
        batch: true,
    },
    libre: {
        label: 'LibreTranslate',
        emoji: '🧠',
        chunkSize: 100,
        statKey: 'libreCalls',
        errorKey: 'libreErrors',
        fatalErrors: ['LIBRE_NOT_CONFIGURED'],
        cloud: false,
        batch: true,
    },
    gemini: {
        label: 'Gemini',
        emoji: '✨',
        chunkSize: 150,
        statKey: 'geminiCalls',
        errorKey: 'geminiErrors',
        fatalErrors: ['GEMINI_AUTH_FAILED'],
        cloud: true,
        batch: true,
    },
    openrouter: {
        label: 'OpenRouter',
        emoji: '🌐',
        chunkSize: 24,
        statKey: 'openrouterCalls',
        errorKey: 'openrouterErrors',
        fatalErrors: ['OPENROUTER_AUTH_FAILED'],
        cloud: true,
        batch: true,
    },
    lmstudio: {
        label: 'LM Studio',
        emoji: '🖥️',
        chunkSize: 12,
        statKey: 'lmstudioCalls',
        errorKey: 'lmstudioErrors',
        fatalErrors: [],
        cloud: false,
        batch: true,
        needsGlossary: true,
    },
    google: {
        label: 'Google',
        emoji: '🌍',
        chunkSize: 1,
        statKey: 'googleCalls',
        errorKey: null,
        fatalErrors: [],
        cloud: true,
        batch: false,
    },
    mymemory: {
        label: 'MyMemory',
        emoji: '📖',
        chunkSize: 1,
        statKey: 'mymemoryCalls',
        errorKey: null,
        fatalErrors: [],
        cloud: true,
        batch: false,
    },
};

/**
 * Adaptateurs : ramènent les dix signatures à `(texts, ctx) => string[]`.
 * `ctx` porte srcLang, tgtLang, logger, glossaryFile, libreMode, compact,
 * contextHint — chaque adaptateur ne lit que ce dont il a besoin.
 */
const ADAPTERS = {
    deepl: (impl) => async (texts, ctx) =>
        impl.translateDeepLBatch(texts, ctx.srcLang, ctx.tgtLang),

    'google-fast': (impl) => async (texts, ctx) =>
        impl.translateGoogleBatch(texts, ctx.srcLang, ctx.tgtLang, ctx.opts || {}),

    libre: (impl) => async (texts, ctx) => {
        // Trois variantes : GPU progressif, GPU, puis CPU. La première
        // disponible gagne, comme dans translateBatch.
        if (ctx.gpu && ctx.progressive && impl.translateLibreBatchGPUProgressive) {
            return impl.translateLibreBatchGPUProgressive(texts, ctx.srcLang, ctx.tgtLang, ctx.logger, ctx.libreMode);
        }
        if (ctx.gpu && impl.translateLibreBatchGPU) {
            return impl.translateLibreBatchGPU(texts, ctx.srcLang, ctx.tgtLang, ctx.logger);
        }
        return impl.translateLibreBatch(texts, ctx.srcLang, ctx.tgtLang);
    },

    gemini: (impl) => async (texts, ctx) =>
        impl.translateGeminiBatch(texts, ctx.srcLang, ctx.tgtLang),

    openrouter: (impl) => async (texts, ctx) =>
        impl.translateOpenRouterBatch(texts, ctx.srcLang, ctx.tgtLang),

    lmstudio: (impl) => async (texts, ctx) =>
        impl.translateLmStudioBatch(
            texts, ctx.srcLang, ctx.tgtLang,
            ctx.glossaryFile, ctx.logger,
            ctx.compact === true,
            ctx.contextHint || '',
        ),

    google: (impl) => async (texts, ctx) =>
        Promise.all(texts.map(t => impl.translateGoogle(t, ctx.srcLang, ctx.tgtLang))),

    mymemory: (impl) => async (texts, ctx) =>
        Promise.all(texts.map(t => impl.translateMyMemory(t, ctx.srcLang, ctx.tgtLang))),
};

/**
 * Découpe une liste en tranches de `size`.
 * @param {Array} items - Éléments à découper.
 * @param {number} size - Taille maximale d'une tranche (>= 1).
 * @returns {Array<Array>} Les tranches, dans l'ordre.
 */
function chunk(items, size) {
    const n = Math.max(1, Math.floor(size) || 1);
    const out = [];
    for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
    return out;
}

/**
 * Construit le registre à partir des implémentations fournies.
 * @param {Object} impl - Les fonctions translateXxx de translator.js.
 * @returns {Object} Registre : get, list, order, has.
 */
function createEngineRegistry(impl = {}) {
    const engines = new Map();

    for (const [id, desc] of Object.entries(DESCRIPTORS)) {
        const makeAdapter = ADAPTERS[id];
        engines.set(id, {
            id,
            ...desc,
            /**
             * Vrai si ce message d'erreur doit désactiver le moteur.
             * @param {Error|string} err - L'erreur remontée par l'appel.
             * @returns {boolean} True si l'erreur est fatale pour ce moteur.
             */
            isFatal(err) {
                const msg = err && err.message ? err.message : String(err || '');
                return desc.fatalErrors.includes(msg);
            },
            /**
             * Découpe une liste selon la taille de lot de ce moteur.
             * @param {Array} items - Éléments à découper.
             * @returns {Array<Array>} Les tranches.
             */
            chunk(items) {
                return chunk(items, desc.chunkSize);
            },
            call: makeAdapter ? makeAdapter(impl) : null,
        });
    }

    return {
        /**
         * @param {string} id - Identifiant du moteur.
         * @returns {Object|null} Le moteur, ou null s'il est inconnu.
         */
        get(id) {
            return engines.get(id) || null;
        },
        /** @returns {boolean} True si l'identifiant existe. */
        has(id) {
            return engines.has(id);
        },
        /** @returns {Array<Object>} Tous les moteurs, dans l'ordre de repli. */
        list() {
            return FALLBACK_ORDER.map(id => engines.get(id)).filter(Boolean);
        },
        /** @returns {Array<string>} L'ordre de repli. */
        order() {
            return [...FALLBACK_ORDER];
        },
    };
}

/**
 * Exécute une phase de traduction pour un moteur.
 *
 * Chacune des sept phases de translateBatch répétait la même mécanique :
 * découper en lots, appeler le moteur, remettre les tags en place, écrire au
 * cache, compter les stats, pousser les ratés vers le moteur suivant, et
 * désactiver le moteur sur une erreur fatale. C'est cette mécanique, et elle
 * seule, qui vit ici — les effets passent par `hooks`, donc elle se teste
 * sans réseau ni cache réel.
 *
 * @param {Object} params - Paramètres de la phase.
 * @param {Object} params.engine - Le moteur, issu du registre.
 * @param {Array<number>} params.indices - Indices des éléments à traduire.
 * @param {Function} params.getItem - (index) => l'élément préparé.
 * @param {Object} params.ctx - Contexte passé à engine.call.
 * @param {Object} params.hooks - Effets de bord (voir ci-dessous).
 * @returns {Promise<Array<number>>} Les indices non traduits, pour la phase suivante.
 */
async function runEnginePhase({ engine, indices, getItem, ctx = {}, hooks = {} }) {
    const {
        onTranslated = () => {},   // (item, texte, engineId) — restaure, cache, notifie
        onStat = () => {},         // (clé, n) — incrémente une stat
        onError = () => {},        // (erreur, engine, fatal)
        onFatal = () => {},        // (engine) — désactiver pour le reste du lot
        log = () => {},
        countPerItem = false,      // DeepL compte par texte, les autres par appel
    } = hooks;

    if (!engine || !engine.call || !indices || indices.length === 0) {
        return indices ? [...indices] : [];
    }

    const leftovers = [];
    const groups = engine.chunk(indices);

    for (let g = 0; g < groups.length; g++) {
        const group = groups[g];
        const items = group.map(getItem);

        let out;
        try {
            out = await engine.call(items.map(it => it.toSend), ctx);
        } catch (err) {
            const fatal = engine.isFatal(err);
            if (engine.errorKey) onStat(engine.errorKey, 1);
            onError(err, engine, fatal);
            leftovers.push(...group);
            if (fatal) {
                log(`   [${engine.label}] ${err && err.message ? err.message : err} — désactivation`);
                onFatal(engine);
                // Les lots pas encore tentés partent aussi au moteur suivant.
                for (let r = g + 1; r < groups.length; r++) leftovers.push(...groups[r]);
                break;
            }
            continue;
        }

        onStat('apiCalls', 1);
        onStat(engine.statKey, countPerItem ? items.length : 1);

        for (let j = 0; j < items.length; j++) {
            const item = items[j];
            const text = Array.isArray(out) ? out[j] : undefined;
            // Un retour vide, ou identique à l'entrée, vaut un échec : le
            // moteur n'a rien apporté, on laisse sa chance au suivant.
            if (!text || text === item.toSend) {
                leftovers.push(group[j]);
                continue;
            }
            onTranslated(item, text, engine.id);
        }
    }

    return leftovers;
}

module.exports = { createEngineRegistry, runEnginePhase, FALLBACK_ORDER, DESCRIPTORS, chunk };
