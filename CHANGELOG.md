# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; versionnage [SemVer](https://semver.org/lang/fr/).

## [0.2.0-beta.1] — 2026-11-03

Première version publique (bêta).

### Ajouté
- **Interface de traduction en ligne de commande** : `minecraft scan` et `bg3 scan` (trouver le modpack / le dossier Mods, analyser, choisir quoi traduire, traduire).
- **Minecraft** : mods (resource pack français), FTB Quests, KubeJS, BetterQuesting ; analyse locale des `.jar` sans dépendance.
- **Baldur's Gate 3** : détection du dossier Mods (Steam/Proton, Windows, partition Windows montée), analyse par langue, traduction mod par mod vers les 16 langues du jeu.
- **Assistant de première utilisation** (`setup`, `--Debug-start`) : langue de l'interface (français, anglais, ou toute langue ajoutée dans `locales/`), langue cible, jeux, clés de traduction (saisie masquée).
- **Serveur MCP en lecture seule** (stdio ou HTTP avec token) : `project_info`, `translation_stats`, `lookup_translation`, `search_translations`, `get_glossary`, `list_modules`, `recent_changes`, `read_project_file`.
- **Dossier portable** (`build.sh` / `build.ps1`) avec son propre Node, mise à jour automatique de Node vérifiée (SHA-256, même version majeure, retour arrière).
- Commandes `clr`, `version`, `lang`, `help trad`, historique (flèche haut) et complétion (Tab).

### Limites connues
- Minecraft : traduction vers le français uniquement ; seuls deux jeux sont gérés.
- `build.ps1` et `LiveMod.cmd` n'ont pas encore été essayés sur une vraie machine Windows.
- Les signatures GPG de Node.js ne sont pas vérifiées.
