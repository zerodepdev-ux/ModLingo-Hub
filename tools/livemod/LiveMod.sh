#!/usr/bin/env bash
# ModLingo-Hub-live — lanceur Linux/macOS. Usage : ./LiveMod.sh [setup|start|stop|info|edit|add|connect|update-node…]
# Runtime JS, dans l'ordre : Dependence/node (portable) → LIVEMOD_NODE → node → bun → nvm → distrobox.
HERE="$(dirname "$(readlink -f "$0")")"
JS="$HERE/livemod.js"
BOX="${LIVEMOD_BOX:-}"   # nom d'un distrobox contenant node (hôte immuable) ; vide = ignoré
DEP="$HERE/Dependence"

# Mise à jour de Node préparée au lancement précédent (vérifiée par node-update.js) : on l'échange maintenant,
# avant d'utiliser le runtime. Si le nouveau ne démarre pas, retour automatique à l'ancien.
if [ -f "$DEP/node.new/.ready" ]; then
    rm -rf "$DEP/node.old"
    if mv "$DEP/node" "$DEP/node.old" 2>/dev/null && mv "$DEP/node.new" "$DEP/node"; then
        rm -f "$DEP/node/.ready"
        if ! "$DEP/node/bin/node" -v >/dev/null 2>&1; then rm -rf "$DEP/node"; mv "$DEP/node.old" "$DEP/node"; echo "ModLingo-Hub-live : mise à jour de Node annulée (le nouveau ne démarre pas)." >&2; fi
    fi
fi

if [ -x "$DEP/node/bin/node" ]; then exec "$DEP/node/bin/node" "$JS" "$@"; fi
if [ -n "${LIVEMOD_NODE:-}" ] && [ -x "$LIVEMOD_NODE" ]; then exec "$LIVEMOD_NODE" "$JS" "$@"; fi
if command -v node >/dev/null 2>&1; then exec node "$JS" "$@"; fi
if command -v bun >/dev/null 2>&1; then exec bun "$JS" "$@"; fi
if [ -x "$HOME/.bun/bin/bun" ]; then exec "$HOME/.bun/bin/bun" "$JS" "$@"; fi
for n in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node; do
    [ -x "$n" ] && exec "$n" "$JS" "$@"
done
# Hôte immuable (Bazzite) : node vit dans un distrobox.
if [ -n "$BOX" ] && command -v distrobox >/dev/null 2>&1 && distrobox list 2>/dev/null | grep -qw "$BOX"; then
    exec distrobox enter "$BOX" -- node "$JS" "$@"
fi
echo "ModLingo-Hub-live : aucun runtime JavaScript trouvé (Dependence/node, node, bun, nvm$([ -n "$BOX" ] && echo ", distrobox '$BOX'"))." >&2
echo "  Dossier portable : lance build.sh (il télécharge Node). Sinon : LIVEMOD_NODE=/chemin/vers/node ./LiveMod.sh" >&2
echo "  Distrobox : LIVEMOD_BOX=<nom-du-conteneur> ./LiveMod.sh" >&2
exit 127
