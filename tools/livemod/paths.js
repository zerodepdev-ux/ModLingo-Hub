'use strict';
// Où se trouve quoi. Deux dispositions :
//  - dépôt   : tools/livemod/ dans le gros projet  → réglages dans <projet>/.livemod, serveur = <projet>/server.js
//  - portable: dossier ModLingo-Hub-live/ avec Dependence/   → réglages dans config/, serveur = Dependence/Tradution/server-lite.js
const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;
const PORTABLE = fs.existsSync(path.join(APP_DIR, 'Dependence'));
const REPO = path.resolve(APP_DIR, '..', '..');
const TRADUTION = path.join(APP_DIR, 'Dependence', 'Tradution');
const NODE_DIR = path.join(APP_DIR, 'Dependence', 'node');

// ROOT = le « projet » vu par le MCP (données, modules, lecture de fichiers).
const ROOT = PORTABLE ? TRADUTION : REPO;
const STATE = process.env.LIVEMOD_STATE || (PORTABLE ? path.join(APP_DIR, 'config') : path.join(REPO, '.livemod'));
const SERVER_SCRIPT = path.join(ROOT, PORTABLE ? 'server-lite.js' : 'server.js');
// Où écrire .mcp.json & co : le dossier de travail de l'utilisateur en mode portable.
const CLIENT_ROOT = PORTABLE ? process.cwd() : REPO;

module.exports = { APP_DIR, PORTABLE, REPO, TRADUTION, NODE_DIR, ROOT, STATE, SERVER_SCRIPT, CLIENT_ROOT };
