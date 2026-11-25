# write0-sync — tester, installer, mettre à jour

Fork privé de [write0](https://github.com/omarbdri/write0) : les textes sont enregistrés sur
l'hébergement Infomaniak par un petit `api.php`. L'interface de write0 reste la même (en anglais).

## Fonctionnement

- **Une seule session a la main.** Une session est un onglet, sur cet ordinateur ou un autre.
  Seule la session qui a la main peut écrire, créer, renommer ou supprimer.
- **Les autres sessions sont passives.** Elles affichent un bandeau bleu, sont en lecture seule
  et suivent le texte en direct :
  - instantanément entre onglets du même navigateur ;
  - toutes les 2 à 3 secondes entre navigateurs ou ordinateurs différents.
- **Reprendre la main.** Cliquez ou tapez dans le texte d'une session passive :
  1. l'ancienne session termine ses envois, puis devient passive ;
  2. la nouvelle récupère le texte à jour et prend la main.

  Si l'ancienne session ne répond pas (veille, réseau coupé), la main est prise après 10 secondes,
  et le texte qu'elle n'avait pas envoyé est abandonné.

- **Texte orange** : ce qui n'est pas encore enregistré sur le serveur. L'envoi a lieu toutes les
  2 secondes ; une fois enregistré, le texte reprend sa couleur normale.
- **Nuage rouge « Offline »** : le serveur est injoignable. Vous pouvez continuer d'écrire : le
  texte reste orange, et il est envoyé au retour du réseau.
- **Pas de réseau à l'ouverture** : l'appli ne démarre pas, et un écran propose de réessayer.

### Côté serveur

- Les textes sont dans `~/write0-data/`, hors de tout site.
- Chaque texte est un fichier `docs/<nom>.md`. « New Document » demande un nom : le fichier est
  créé tout de suite sous ce nom (« Journal de novembre » → `journal-de-novembre.md`), et ce nom
  reste figé, même si le texte est renommé ensuite dans l'appli. Si deux textes ont le même nom,
  le second reçoit un suffixe (`mon-titre-2.md`).
- Cas particulier, un texte sans nom choisi (le texte d'accueil de write0) : le fichier
  s'appelle `brouillon-xxxxxxxx.md`, puis prend le nom de sa première ligne dès qu'elle est
  terminée (touche Entrée).
- Un texte supprimé va dans `trash/`, avec la date de suppression dans son nom. Il est effacé
  définitivement au bout de 30 jours.
- `state.json` contient l'index des textes et le verrou de session. `config.php` contient le hash
  du mot de passe.

### Sécurité

- Un seul mot de passe, stocké en hash bcrypt.
- Session de connexion de 30 jours, dans un cookie signé `HttpOnly`, `Secure` et
  `SameSite=Strict`.
- Après 5 essais ratés, la connexion est bloquée 15 minutes.
- Aucun service externe : Tailwind et les polices sont intégrés au build.

## 1. Tester sur cet ordinateur

```bash
cd ~/projets/editeur-ecriture/write0
npm ci
npm run setup      # choisit un mot de passe de test → .dev-data/config.php
npm run dev:api    # terminal 1 : api.php sur http://127.0.0.1:8765
npm run dev        # terminal 2 : l'appli sur http://localhost:3000
npm test           # tous les tests (dont api.php, lancé avec PHP)
```

Pour essayer les sessions, ouvrez http://localhost:3000 dans deux onglets, ou dans deux navigateurs.
Les textes de test sont dans `.dev-data/`, ignoré par git.

## 2. Préparer l'hébergement (une seule fois)

Le guide suppose un hébergement Web Infomaniak avec PHP 8.1 ou plus et un accès SSH, mais tout
hébergement Apache/PHP avec SSH convient.

1. Créez un site (par exemple le sous-domaine `ecrire.votre-site.fr`) en Apache/PHP, avec le
   certificat SSL gratuit. Sur Infomaniak, son dossier est `~/sites/ecrire.votre-site.fr/`.
2. Créez un utilisateur FTP + SSH, puis ajoutez un raccourci `infomaniak` dans
   `~/.ssh/config` sur votre ordinateur :
   ```
   Host infomaniak
       HostName ADRESSE_DU_SERVEUR_SSH
       User VOTRE_UTILISATEUR
   ```
   Toutes les commandes ci-dessous l'utilisent. Les identifiants ne sont jamais écrits dans le
   dépôt.
3. Créez le dossier des textes, hors de tout site :
   ```bash
   ssh infomaniak 'mkdir -m 700 ~/write0-data'
   ```
   `api.php` le cherche à deux niveaux au-dessus de lui (`~/sites/<site>/` → `~/`).
4. Indiquez où envoyer l'appli, dans un fichier local `.deploy-target` (ignoré par git) :
   ```bash
   echo "infomaniak:sites/ecrire.votre-site.fr/" > .deploy-target
   ```

## 3. Créer le mot de passe sur le serveur (une seule fois)

Lancez :

```bash
scp server/setup.php infomaniak:
ssh -t infomaniak 'php setup.php ~/write0-data && rm setup.php'
```

Le script demande le mot de passe sans l'afficher, avec 12 caractères minimum. Pour **changer
de mot de passe**, relancez ces deux commandes. Toutes les sessions ouvertes sont alors
déconnectées.

## 4. Mettre en ligne (et chaque mise à jour)

```bash
npm run deploy
```

Cette commande fait deux choses :

1. elle construit `dist/` (l'appli, `api.php` et le `.htaccess` du site) ;
2. elle l'envoie avec `rsync --delete` à l'emplacement indiqué dans `.deploy-target`.

L'option `--delete` est sans risque : les textes sont dans `~/write0-data`, hors du site.

## 5. Vérifier

1. Ouvrez l'adresse de votre site : l'écran de connexion s'affiche.
2. Connectez-vous et écrivez une phrase. Elle est orange, puis redevient normale en 2 à
   3 secondes.
3. Ouvrez un deuxième onglet : il est passif (bandeau bleu) et suit la frappe du premier.
   Cliquez dans son texte : il prend la main.
4. Coupez le réseau et écrivez : le nuage devient rouge et le texte reste orange. Rétablissez le
   réseau : tout s'enregistre.
5. En SSH, `ls ~/write0-data/docs` affiche vos textes en `.md`.

## Sauvegarde sur cet ordinateur

```bash
rsync -av infomaniak:write0-data/docs/ ~/sauvegardes/write0/
```

Infomaniak sauvegarde aussi l'hébergement automatiquement (rubrique « Restauration »).

## Limites connues

- La première frappe ou le premier clic dans une session passive sert à demander la main. Ce
  caractère n'est pas inséré : il faut retaper une fois la main obtenue.
- Les réglages (thème, modes) restent propres à chaque navigateur.
- Se déconnecter n'efface pas le cache local du navigateur.
