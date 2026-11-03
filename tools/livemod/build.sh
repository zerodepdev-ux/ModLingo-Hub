#!/usr/bin/env bash
# build.sh — construit le dossier portable ModLingo-Hub-live/ (Linux / macOS).
#   ./build.sh                       télécharge Node (LTS, version majeure de node-major.txt) et assemble
#   ./build.sh --out /chemin/ModLingo-Hub-live dossier de sortie (défaut : tools/livemod/dist/ModLingo-Hub-live)
#   ./build.sh --node-bin /usr/bin/node   n'utilise PAS le réseau : copie ce binaire Node
#   ./build.sh --with-cache          inclut le cache de traductions Minecraft du projet
# Le téléchargement de Node est vérifié avec l'empreinte SHA-256 publiée sur nodejs.org.
set -euo pipefail
trap 'echo "build.sh : échec (ligne $LINENO)" >&2' ERR
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
OUT="$HERE/dist/ModLingo-Hub-live"; NODE_BIN=""; EXTRA=()
while [ $# -gt 0 ]; do
    case "$1" in
        --out) OUT="$(realpath -m "$2")"; shift 2 ;;
        --node-bin) NODE_BIN="$2"; shift 2 ;;
        --with-cache) EXTRA+=(--with-cache); shift ;;
        -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
        *) echo "Option inconnue : $1" >&2; exit 2 ;;
    esac
done
DEP="$OUT/Dependence"; NODE_DIR="$DEP/node"
mkdir -p "$DEP"

fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https' --tlsv1.2 "$1" -o "$2"; else wget -q --secure-protocol=TLSv1_2 "$1" -O "$2"; fi; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

if [ -n "$NODE_BIN" ]; then
    echo "Node : copie de $NODE_BIN (hors ligne)"
    rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR/bin"; cp "$NODE_BIN" "$NODE_DIR/bin/node"; chmod +x "$NODE_DIR/bin/node"
else
    case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) echo "Système non géré : $(uname -s) (utilise build.ps1 sous Windows)" >&2; exit 1 ;; esac
    case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "Architecture non gérée : $(uname -m)" >&2; exit 1 ;; esac
    MAJOR="$(tr -d '[:space:]' < "$HERE/node-major.txt")"
    TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
    echo "Node : recherche de la dernière LTS $MAJOR.x…"
    fetch "https://nodejs.org/dist/index.json" "$TMP/index.json"
    # Pas de « head -1 » dans un tube (SIGPIPE + pipefail = arrêt silencieux) : on trie et on prend la plus récente.
    VERSION="$(grep -o "\"version\":\"v$MAJOR\.[0-9]*\.[0-9]*\"[^}]*\"lts\":\"[^\"]*\"" "$TMP/index.json" | grep -o "^\"version\":\"v$MAJOR\.[0-9]*\.[0-9]*" | grep -o "v[0-9.]*" | sort -V | tail -n 1 || true)"
    [ -n "$VERSION" ] || { echo "Aucune LTS $MAJOR.x trouvée" >&2; exit 1; }
    FILE="node-$VERSION-$OS-$ARCH.tar.gz"
    echo "Node : $VERSION ($FILE)"
    fetch "https://nodejs.org/dist/$VERSION/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
    EXPECTED="$(grep "  $FILE\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1)"
    [ -n "$EXPECTED" ] || { echo "Empreinte introuvable pour $FILE" >&2; exit 1; }
    fetch "https://nodejs.org/dist/$VERSION/$FILE" "$TMP/$FILE"
    [ "$(sha256 "$TMP/$FILE")" = "$EXPECTED" ] || { echo "ERREUR : empreinte SHA-256 différente, archive rejetée." >&2; exit 1; }
    echo "Node : empreinte SHA-256 vérifiée"
    rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"; tar -xzf "$TMP/$FILE" -C "$NODE_DIR" --strip-components=1
fi
"$NODE_DIR/bin/node" -v >/dev/null || { echo "Le Node installé ne démarre pas" >&2; exit 1; }
echo "Node : $("$NODE_DIR/bin/node" -v) prêt"

# Paquets npm (express, adm-zip, fast-xml-parser) : build.js les copie depuis <racine>/node_modules.
# Dans un dépôt fraîchement cloné ils n'y sont pas : on les installe avec le npm du Node portable (versions verrouillées par package-lock.json, sans scripts).
REPO="$(cd "$HERE/../.." && pwd)"
if [ ! -d "$REPO/node_modules/express" ] || [ ! -d "$REPO/node_modules/adm-zip" ] || [ ! -d "$REPO/node_modules/fast-xml-parser" ]; then
    NPM_CLI="${LIVEMOD_NPM_CLI:-$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js}"
    [ -f "$NPM_CLI" ] || { echo "npm introuvable ($NPM_CLI) : lance « npm install » à la racine du dépôt puis relance build.sh." >&2; exit 1; }
    if [ -f "$REPO/package-lock.json" ]; then NPM_CMD=ci; else NPM_CMD=install; fi
    echo "Paquets npm : npm $NPM_CMD (express, adm-zip, fast-xml-parser…)"
    ( cd "$REPO" && "$NODE_DIR/bin/node" "$NPM_CLI" "$NPM_CMD" --omit=dev --ignore-scripts --no-audit --no-fund ) || { echo "npm $NPM_CMD a échoué" >&2; exit 1; }
fi

"$NODE_DIR/bin/node" "$HERE/build.js" --out "$OUT" "${EXTRA[@]+"${EXTRA[@]}"}"
echo
echo "Dossier prêt : $OUT"
echo "Lancer       : $OUT/LiveMod.sh"
