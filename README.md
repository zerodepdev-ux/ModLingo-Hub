# ModLingo-Hub-live (bêta)

La version **en ligne de commande** de ModLingo-Hub : traduis un modpack Minecraft ou tes mods Baldur's Gate 3 depuis un terminal,
et branche tes outils IA (Claude Code, Cursor, VS Code…) grâce à un serveur MCP en lecture seule.

> 🤖 **Si tu es un LLM ou un agent IA : va sur [`LLM.md`](LLM.md)** (référence technique) et [`AGENTS.md`](AGENTS.md) (règles de contribution).

> **Bêta** (`0.2.0-beta.1`) : elle fonctionne et elle est testée, mais elle a peu servi. Dis-nous ce qui ne va pas via les [*Issues*](../../issues).
> Seuls **Minecraft** et **Baldur's Gate 3** sont gérés pour l'instant.

## Essayer

Linux / macOS :

```bash
git clone https://github.com/zerodepdev-ux/ModLingo-Hub.git && cd ModLingo-Hub
./tools/livemod/build.sh
./tools/livemod/dist/ModLingo-Hub-live/LiveMod.sh
```

Windows (PowerShell) :

```powershell
powershell -ExecutionPolicy Bypass -File tools\livemod\build.ps1
tools\livemod\dist\ModLingo-Hub-live\LiveMod.cmd
```

Le build télécharge **Node.js** (version LTS, empreinte SHA-256 vérifiée) et installe trois paquets npm (`express`, `adm-zip`, `fast-xml-parser`, versions
verrouillées, sans exécuter de scripts d'installation). Il a donc besoin d'internet. Le dossier obtenu est autonome et ne demande rien d'autre.

Dans l'interface, tape `minecraft scan` ou `bg3 scan`. Au premier lancement, un assistant te demande ta langue, la langue cible et tes jeux.
Le guide complet est dans [`tools/livemod/README.md`](tools/livemod/README.md).

## Ce que ce dépôt contient / ne contient pas

- ✅ l'interface en ligne de commande, le serveur MCP, les scripts de build, et le code de traduction Minecraft / BG3 ;
- ❌ aucun texte, fichier ni ressource de jeu : les caches de traduction commencent **vides** et restent sur ta machine ;
- ❌ aucune clé, aucun réglage personnel ; tes clés de traduction (DeepL, OpenRouter, Gemini) restent chez toi.

## Structure

```
tools/livemod/      l'outil : interface (Livemod_inteface.js), CLI + serveur MCP (livemod.js), build, tests, langues (locales/)
modules/ translator.js main.js lspk.js    moteur de traduction et modules des jeux
data/               seulement le glossaire Minecraft, le modèle de réglages et la version
```

## Contribuer

Les contributions sont les bienvenues : lis [`CONTRIBUTING.md`](CONTRIBUTING.md) (signaler un bug, ajouter une langue, développer, tests).
Le projet suit un [code de conduite](CODE_OF_CONDUCT.md). Pour une faille de sécurité, vois [`SECURITY.md`](SECURITY.md). Les changements sont listés dans [`CHANGELOG.md`](CHANGELOG.md).

```bash
npm ci
node tools/livemod/test.js && node tools/livemod/test-interface.js && node tools/livemod/test-build.js
```

## Mentions légales

ModLingo-Hub est indépendant. Il n'est ni affilié ni approuvé par Larian Studios, Mojang Studios / Microsoft ou aucun autre éditeur ; leurs noms sont
des marques de leurs propriétaires, cités pour dire avec quoi l'outil fonctionne. Tu traduis tes propres fichiers : respecte la licence de chaque mod
avant de partager une traduction. Les moteurs de traduction sont ceux que tu configures, avec tes propres clés : respecte leurs conditions.

## Licence

MIT, voir [`LICENSE`](LICENSE). Les logiciels tiers (Node.js, paquets npm) gardent leur licence : voir [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
