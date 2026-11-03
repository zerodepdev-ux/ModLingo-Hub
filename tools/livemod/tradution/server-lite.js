'use strict';
// Serveur de traduction minimal pour ModLingo-Hub-live : pas d'interface web, seulement la config, Minecraft et BG3.
// Lancé par l'interface (« minecraft scan ») ; n'écoute que sur 127.0.0.1.
const express = require('express');

const PORT = parseInt(process.env.PORT, 10) || 3951;
const app = express();

// Anti DNS-rebinding / CSRF : seulement l'hôte local, jamais d'Origin étrangère.
const local = new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}$`);
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!local.test(req.headers.host || '') || (origin && !local.test(origin.replace(/^https?:\/\//, '')))) return res.status(403).end('forbidden');
    next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

require('./modules/config')(app);
require('./modules/minecraft')(app);
require('./modules/pak')(app);         // BG3 : liste et analyse des .pak
require('./modules/translate')(app);   // BG3 : traduction d'un .pak (lance main.js)

const server = app.listen(PORT, '127.0.0.1', () => console.log(`Tradution (lite) : http://127.0.0.1:${PORT}`));
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} déjà utilisé` : e.message); process.exit(1); });

let stopping = false;
async function shutdown() {
    if (stopping) return;
    stopping = true;
    try { await require('./translator').flushAllTranslationCaches(); } catch (e) { console.error('[Cache]', e.message); }
    server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
