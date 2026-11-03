# Sécurité

## Versions concernées
Le projet est en bêta : seule la **dernière version** reçoit des correctifs.

## Signaler une vulnérabilité
**N'ouvre pas d'issue publique.** Utilise le signalement privé de GitHub : onglet **Security → Report a vulnerability** de ce dépôt.
Décris le problème, comment le reproduire et son impact. Nous répondons en général sous quelques jours et nous te tiendrons au courant de la correction.
Merci de nous laisser le temps de corriger avant toute divulgation publique.

## Ce qui nous intéresse particulièrement
- contournement de l'authentification du serveur MCP (token) ou des contrôles `Host` / `Origin` ;
- lecture de fichiers hors du projet ou de fichiers protégés (clés, `.env`, `.git`) via `read_project_file` ;
- écriture ou exécution de code à distance via le serveur MCP, la mise à jour de Node ou les scripts de build ;
- fuite d'une clé API ou du token (journaux, fichiers, messages d'erreur) ;
- faille dans la vérification SHA-256 du Node téléchargé.

## Comment c'est protégé aujourd'hui
- Le serveur MCP n'écoute que sur `127.0.0.1`, exige un token (mode HTTP), refuse les `Host`/`Origin` étrangers et est **en lecture seule**.
- `config/config.json` (qui contient le token) est créé avec les droits `0600` ; il ne doit jamais être partagé.
- Les clés API sont saisies sans affichage et ne sont envoyées qu'au serveur de traduction **local**.
- Le Node téléchargé par `build.sh` / `build.ps1` et par la mise à jour automatique est vérifié par son empreinte SHA-256 (HTTPS obligatoire) ; une mise à jour qui ne démarre pas est annulée.
- Les paquets npm sont verrouillés (`package-lock.json`) et installés **sans exécuter de scripts**.

## Limites connues
- Les **signatures GPG** des publications de Node.js ne sont pas vérifiées (seulement l'empreinte publiée sur nodejs.org).
- En mode `stdio`, le client qui lance le serveur MCP n'a pas de token : c'est le comportement normal de ce mode.
