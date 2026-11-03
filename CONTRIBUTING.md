# Contribuer à ModLingo-Hub-live

Merci de vouloir aider ! Ce projet est en **bêta** : les retours, les corrections et les traductions de l'interface sont les bienvenus.

> Tu es une IA ou un agent ? Lis plutôt [`AGENTS.md`](AGENTS.md) et [`LLM.md`](LLM.md).

## Signaler un problème

Ouvre une *issue* avec le modèle « Bug ». Donne :
- la version (`LiveMod.sh --version`) et ton système (Linux / Windows / macOS, flatpak ou non) ;
- ce que tu as tapé, ce que tu attendais, ce qui s'est passé (copie le texte de l'erreur) ;
- le résultat de `LiveMod.sh info` (il ne contient ni clé ni token).

**Ne colle jamais** de clé API, le contenu de `config/config.json` (il contient le token du serveur MCP) ni de fichier de jeu. Pour une faille de sécurité, suis [`SECURITY.md`](SECURITY.md) au lieu d'ouvrir une issue publique.

## Proposer une amélioration

Ouvre d'abord une issue « Idée » pour en discuter, surtout pour ajouter un jeu ou changer le comportement de la traduction.

## Ajouter une langue d'interface

1. Copie `tools/livemod/locales/en.json` vers `tools/livemod/locales/<code>.json` (par exemple `de.json`).
2. Change `_name` (le nom de la langue, écrit dans cette langue) et traduis les valeurs. Les clés (le texte français) ne changent pas ; garde les `{0}`, `{1}`.
3. Lance les tests. Une phrase non traduite reste en français, ce n'est pas bloquant.

## Développer

```bash
git clone https://github.com/zerodepdev-ux/ModLingo-Hub.git && cd ModLingo-Hub
npm ci
node tools/livemod/test.js && node tools/livemod/test-interface.js && node tools/livemod/test-build.js
```

Les tests sont hermétiques : ils n'appellent aucun moteur de traduction et ne touchent ni à tes dossiers de jeu ni à ton application.

Règles de code :
- Node 18+, CommonJS, `'use strict'`, indentation 4 espaces, apostrophes simples ;
- **aucune dépendance** ajoutée aux quatre fichiers sans dépendance (`livemod.js`, `Livemod_inteface.js`, `node-update.js`, `build.js`) ;
- le texte affiché est en français dans `T('…')`, avec sa version anglaise dans `locales/en.json` (un test le vérifie) ;
- commentaires en français, qui expliquent *pourquoi* ;
- tout nouveau comportement a un test.

## Ce qu'on n'accepte pas

- des **fichiers de jeu**, des textes extraits de jeux, des caches de traduction ou des clés ;
- des appels à des adresses web **non officielles** ou non documentées ;
- tout ce qui permettrait au serveur MCP d'écrire ou de traduire (il est volontairement en lecture seule) ;
- du code dont tu n'es pas l'auteur ou dont la licence est incompatible avec la MIT.

## Pull requests

Petites et ciblées. Décris ce qui change et pourquoi, indique les tests lancés, mets à jour `CHANGELOG.md` si l'utilisateur le voit. En proposant ta contribution, tu acceptes qu'elle soit publiée sous la licence MIT du projet.

Merci de respecter le [code de conduite](CODE_OF_CONDUCT.md).
