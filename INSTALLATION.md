# Installation — GCC Deal Tracker

## 1. Créer le dépôt
1. Sur github.com, cliquez sur **New repository**.
2. Nom : `gcc-tracker` (ou autre). **Cochez « Public »** — c'est important : les dépôts publics ont des minutes GitHub Actions illimitées et gratuites ; les dépôts privés sont limités (~2000 min/mois gratuites), ce qui serait vite dépassé avec un scan toutes les 30 minutes.
   *(Les données publiées ne sont que les enchères déjà visibles publiquement sur GCC — rien de personnel.)*
3. Ne cochez aucune case d'initialisation (pas de README, pas de .gitignore).

## 2. Envoyer les fichiers
Sur votre ordinateur, dans le dossier dézippé :
```
git init
git add .
git commit -m "Premier envoi"
git branch -M main
git remote add origin https://github.com/VOTRE-PSEUDO/gcc-tracker.git
git push -u origin main
```
(Si vous n'avez pas `git` installé, GitHub propose aussi un envoi par glisser-déposer des fichiers via l'interface web, dans l'onglet **Add file → Upload files**.)

## 3. Activer GitHub Pages
1. Dans le dépôt : **Settings → Pages**.
2. Source : **Deploy from a branch**. Branche : **main**, dossier : **/docs**. Enregistrer.
3. Après 1-2 minutes, l'adresse de votre appli s'affiche en haut de cette page (`https://VOTRE-PSEUDO.github.io/gcc-tracker/`).

## 4. Lancer le premier scan
1. Onglet **Actions** du dépôt.
2. Cliquez sur le workflow **Scan GCC**, puis **Run workflow** (bouton à droite) pour le lancer manuellement une première fois, sans attendre les 30 minutes.
3. Suivez son exécution (5-10 minutes, le temps d'installer un navigateur automatisé). En cas d'erreur, l'onglet affiche le journal complet — copiez-le-moi si besoin.
4. Une fois terminé, rechargez la page de l'appli : les enchères doivent apparaître.

## 5. Ajouter l'appli à l'écran d'accueil (téléphone)
- **iPhone (Safari)** : ouvrez le lien → icône de partage → « Sur l'écran d'accueil ».
- **Android (Chrome)** : ouvrez le lien → menu ⋮ → « Ajouter à l'écran d'accueil ».

## Réglages
Le fichier `scraper/config.json` contrôle la marge de sécurité, les frais, l'horizon (enchères finissant sous X heures) et le nombre max de cartes scannées par passage. Modifiez-le et repoussez (`git push`) pour changer le comportement — pas besoin de toucher au reste du code.

## Si le scan échoue systématiquement
eBay peut bloquer les requêtes venant des serveurs GitHub (adresses « datacenter », plus surveillées qu'une connexion résidentielle). Si le journal Actions montre des blocages répétés, dites-le-moi : on ajustera l'approche (ralentir encore le rythme, changer de source, etc.).
