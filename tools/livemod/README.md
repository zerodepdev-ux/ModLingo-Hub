# ModLingo-Hub-live — ModLingo-Hub en ligne de commande

> **Version bêta** (`0.2.0-beta.1`). Elle fonctionne et elle est testée, mais elle n'a pas encore été essayée par beaucoup de monde : des défauts sont possibles.
> Seuls **Minecraft** et **Baldur's Gate 3** sont gérés. Dis-nous ce qui ne va pas via les *Issues* du dépôt.

Deux outils légers, sans aucune dépendance (Node 18+ suffit) :

| | Pour quoi faire |
|---|---|
| **Interface de traduction** | Traduire un modpack Minecraft en français depuis un terminal, étape par étape. |
| **Serveur MCP** | Laisser une IA (Claude Code, Cursor, VS Code…) consulter tes traductions et glossaires. |

## Version portable (dossier autonome)

`build.sh` (Linux/macOS) ou `build.ps1` (Windows) assemblent un dossier qui n'a besoin de rien d'autre :

```
ModLingo-Hub-live/
├─ LiveMod.sh | LiveMod.cmd          lanceurs (utilisent Dependence/node en priorité)
├─ livemod.js, Livemod_inteface.js, locales/, README.md
├─ Dependence/
│   ├─ Tradution/                    le code de traduction (Minecraft…) + serveur sans interface web
│   └─ node/                         Node portable, téléchargé et vérifié par le build
└─ config/                           réglages de ModLingo-Hub-live (token, langue, historique, tools.d/, commands.d/)
```

```bash
./tools/livemod/build.sh                          # télécharge Node (LTS) et assemble → tools/livemod/dist/ModLingo-Hub-live
./tools/livemod/build.sh --out ~/ModLingo-Hub-live          # autre dossier
./tools/livemod/build.sh --node-bin /usr/bin/node # sans réseau : copie ce Node
```
```powershell
powershell -ExecutionPolicy Bypass -File tools\livemod\build.ps1
```

- **Rebuild sans rien perdre** : le code est remplacé, mais `Dependence/Tradution/data/` (caches, clés, réglages) est conservé.
- **Tradution** : `ModLingo-Hub-live` y démarre son propre serveur de traduction (127.0.0.1, arrêté à la sortie) : le gros projet n'est pas nécessaire.
  Il contient le code de **Minecraft** et de **BG3** (14 fichiers du projet + express, adm-zip, fast-xml-parser).
  Ses fichiers sont copiés du projet au build (aucun double à maintenir) ; `--with-cache` ajoute le cache de traductions Minecraft.
- **Node se met à jour tout seul** (réglage `nodeUpdate` : `auto` par défaut, `ask` prévient seulement, `off` désactive ; `update-node` force la vérification).
  Même version majeure, LTS uniquement, empreinte SHA-256 vérifiée avant extraction, au plus une fois par 24 h, jamais en mode `--stdio`.
  La mise à jour est préparée puis appliquée **au lancement suivant** ; l'ancien Node reste dans `Dependence/node.old`, et le lanceur revient
  automatiquement dessus si le nouveau ne démarre pas.

## Première utilisation : l'assistant (`setup`)

Au tout premier lancement, un assistant en 3 étapes démarre tout seul :

1. **Langue** de l'interface : Français, English, ou une autre si un fichier `locales/<code>.json` existe.
2. **Tes jeux** : ceux que tu veux traduire (ils sont marqués ★ dans `help trad`).
3. **Options de traduction** (facultatif) : ajouter une clé API (DeepL, OpenRouter, Gemini) ou régler LM Studio.
   Les clés sont tapées sans affichage et enregistrées par l'app elle-même (`Save.env`) ; ModLingo-Hub-live ne les garde nulle part.

Pour le rejouer : tape `setup` dans l'interface, ou lance `./tools/livemod/LiveMod.sh --Debug-start`
(force l'assistant comme à la première utilisation ; rien n'est effacé, Entrée garde tes réglages actuels).

**Ajouter une langue** : copie `locales/en.json` en `locales/<code>.json`, change `_name` et traduis les valeurs.
Une phrase absente reste en français.

## Démarrage rapide

```bash
./tools/livemod/LiveMod.sh        # Linux / macOS
tools\livemod\LiveMod.cmd         # Windows
```

Puis tape :

```
minecraft scan
```

C'est tout. L'outil :

1. **cherche ton modpack** (Prism, MultiMC, ATLauncher, Modrinth, CurseForge, GDLauncher, `.minecraft` — natif ou flatpak). S'il n'en trouve aucun, il te demande le dossier ;
2. **l'analyse** : combien de mods, combien sont déjà en français, combien de textes restent à traduire ;
3. **te demande quoi traduire** : tout, les mods, FTB Quests, KubeJS, BetterQuesting, ou des mods choisis un par un ;
4. traduit via l'app ModLingo-Hub et crée le resource pack français dans le modpack.

La traduction utilise l'app ModLingo-Hub. Si elle n'est pas lancée, l'outil propose de la démarrer
(et l'arrête à la sortie). Le moteur de traduction est celui que tu as réglé dans l'app.

### Astuces
- **Tab** complète les commandes · **flèche haut** rappelle les anciennes · **q** annule une question.
- `help` : aide courte · `help trad` : tableau des commandes et des jeux disponibles.
- Sans menu : `minecraft scan --only=ftbquest,kubejs` (ajoute `--yes` pour tout accepter).
- **`clr`** (ou `clear`, `cls`) efface l'écran et revient au menu. Tapé **en pleine question**, il abandonne le parcours en cours.
- **`version`** affiche la version de ModLingo-Hub-live, de Node et de la langue (aussi dans le titre du menu, et `LiveMod.sh --version`).
- Jeux gérés pour l'instant : **Minecraft** et **Baldur's Gate 3**. Les autres jeux se traduisent depuis le site.

### Langue cible

Par défaut on traduit vers le **français**. Pour une autre langue :

```
lang de                      # change la langue cible (mémorisée) · « lang » seul l'affiche
bg3 scan --lang ja           # juste pour cette fois
```

Les langues sont celles que **BG3 sait afficher** : anglais, français, allemand, espagnol, italien, portugais, russe, polonais, néerlandais,
japonais, coréen, chinois (simplifié/traditionnel), turc, ukrainien, tchèque. On peut les écrire en code (`de`) ou en toutes lettres (`allemand`, `german`).
L'assistant (`setup`, étape 2/4) la demande aussi.

- **Détection par langue** : un mod n'est « déjà traduit » que pour la langue choisie (texte dans le mod, ou un `<mod>_<langue>.pak` à côté, majuscules ou non).
  Un mod traduit seulement en français redevient « à traduire » si tu vises l'allemand.
- **Traductions existantes** : l'analyse liste les langues déjà présentes dans le dossier (`français ×2, allemand ×1`).
- **Minecraft** : français uniquement pour l'instant (le resource pack est toujours `fr_fr`) ; une autre langue cible est ignorée avec un avertissement.

### Baldur's Gate 3

```
bg3 scan
```

1. **cherche le dossier `Mods`** : Steam/Proton (y compris les bibliothèques Steam secondaires), Windows, partition Windows montée, ou le chemin
   réglé dans l'app. S'il n'en trouve aucun, il demande le chemin (le dossier `Mods` ou son parent « Baldur's Gate 3 ») et le mémorise ;
2. **analyse** chaque mod (`.pak`) avec le serveur de traduction : déjà en français (français dans le mod, ou un `<mod>_fr.pak` à côté),
   à traduire, sans texte à traduire, ou pak de traduction ;
3. **te demande quoi traduire** : tout, ou des mods choisis un par un (numéros ou noms) ;
4. traduit les mods un par un (barre de progression) et crée `<mod>_fr.pak` dans le dossier `Mods`. Un échec n'arrête pas les autres.

`bg3 scan --yes --only=ModA,ModB` traduit sans menu (ajoute `--lang de` pour une autre langue). L'app est réglée sur le bon dossier le temps de la traduction, puis remise comme avant.
Les `*_fr.pak` créés sont à activer dans ton gestionnaire de mods si besoin.

### Ce qui est modifié chez toi
| Source | Résultat |
|---|---|
| Mods | un resource pack `FR_Traduction_….zip` (rien n'est touché dans les mods) |
| KubeJS | des fichiers `fr_fr.json` ajoutés à côté des originaux |
| BetterQuesting | `DefaultQuests.json` réécrit, sauvegarde `.bak` automatique |
| FTB Quests (chapitres) | réécrits sur place, copie dans `livemod-backup/` avant |

## Mode MCP

Dans l'interface, tape `mcp` pour voir ce que les IA ont demandé et gérer le serveur ; `nomcp` pour revenir.
Ou directement :

```bash
./tools/livemod/LiveMod.sh start      # lance le serveur (http://127.0.0.1:3950)
./tools/livemod/LiveMod.sh info       # état, jeux, outils
./tools/livemod/LiveMod.sh connect    # comment brancher ton IA (+ token)
./tools/livemod/LiveMod.sh stop
```

| Commande | Effet |
|---|---|
| `start [--no-web]` | démarre (`--no-web` : sans page web, plus léger) |
| `stop` / `info` / `data` | arrêter / état / dossier de données lu |
| `connect claude\|cursor\|vscode` | ajoute ModLingo-Hub-live à la config du client |
| `connect token` · `regen` · `test` | afficher / renouveler le token · tester la connexion |
| `setup` · `--Debug-start` | assistant de configuration / le forcer |
| `update-node` | vérifier/préparer la mise à jour du Node portable |
| `edit [clé valeur]` | régler `port`, `web`, `allowRead`, `maxReadBytes`, `dataDir`, `nodeUpdate` |
| `add <fichier.js>` | ajouter un outil MCP ou une commande du shell |

Outils proposés à l'IA (lecture seule) : `project_info`, `translation_stats`, `lookup_translation`,
`search_translations`, `get_glossary`, `list_modules`, `recent_changes`, `read_project_file`.

### Sécurité
- Le serveur n'écoute que sur **127.0.0.1** ; le mode HTTP exige un **token** (`connect token`).
- Les IA ne peuvent **ni traduire ni écrire** : tout est en lecture seule.
- `read_project_file` refuse les clés API, `.env`, `.git`, `node_modules`, les clés/certificats et tout ce qui sort du projet.
- Le token n'est jamais écrit dans un fichier du dépôt.

## Dépannage

| Problème | Solution |
|---|---|
| `node : non trouvé` | Installe Node 18+, ou `LIVEMOD_NODE=/chemin/vers/node ./LiveMod.sh`. Le lanceur essaie aussi bun, nvm et un distrobox. |
| « Aucun modpack trouvé » | Donne le dossier quand il le demande ; il est mémorisé. |
| Modpack en flatpak invisible depuis l'app | `flatpak override --user --filesystem=<dossier> <id de l'app>`. |
| L'IA ne voit pas les dernières traductions | `LiveMod.sh data` : vérifie le dossier lu, `edit dataDir <chemin>` pour l'imposer. |

## Mentions légales

- **Pas d'affiliation.** ModLingo-Hub-live est un outil indépendant. Il n'est ni affilié ni approuvé par Larian Studios, Mojang Studios / Microsoft,
  Hypixel Studios, Coffee Stain Studios ni aucun autre éditeur. Les noms de jeux et de lanceurs sont des marques de leurs propriétaires,
  cités uniquement pour dire avec quoi l'outil fonctionne.
- **Tu traduis tes propres fichiers.** L'outil lit les mods que tu as installés et écrit les traductions chez toi. Il ne contient aucun texte,
  fichier ni ressource de jeu. Respecte la licence de chaque mod avant de partager une traduction.
- **Moteurs de traduction.** Ce sont ceux que tu as réglés dans l'app (DeepL, OpenRouter, Gemini, LM Studio local…) avec tes propres clés :
  respecte leurs conditions d'utilisation.
- **Logiciels tiers.** Le dossier portable embarque Node.js et des paquets npm (express, adm-zip, fast-xml-parser…), chacun sous sa propre licence
  (fichiers `LICENSE` conservés dans `Dependence/`).
- **Licence.** MIT, voir `LICENSE`. Aucune garantie.

## Tests

```bash
node tools/livemod/test.js              # serveur MCP
node tools/livemod/test-interface.js    # interface de traduction (faux serveur, aucun moteur appelé)
node tools/livemod/test-build.js        # dossier portable : build hors ligne, serveur Tradution, mise à jour de Node (faux nodejs.org)
```
