#!/bin/sh
# Envoie dist/ vers l'hébergement. La cible (ex. infomaniak:sites/ecrire.votre-site.fr/)
# est lue dans .deploy-target, un fichier local ignoré par git.
set -e
if [ ! -s .deploy-target ]; then
  echo "Créez d'abord .deploy-target, par exemple :" >&2
  echo '  echo "infomaniak:sites/ecrire.votre-site.fr/" > .deploy-target' >&2
  exit 1
fi
target=$(head -n 1 .deploy-target)
rsync -av --delete dist/ "$target"
