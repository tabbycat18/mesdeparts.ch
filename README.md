# mesdeparts.ch

Tableau de départs des transports publics suisses (bus, tram, métro et trains), gratuit et accessible directement depuis un navigateur.

Le projet est né d’une frustration personnelle face aux solutions matérielles payantes et fermées.  
Il s’inspire :
- de l’horloge CFF animée popularisée par la communauté (voir projet et discussion Reddit ci-dessous),
- et d’appareils physiques comme Tramli, tout en faisant un choix volontairement différent : **aucun matériel propriétaire, aucun paiement, aucune inscription**.

L’objectif est de proposer une alternative simple et ouverte :
- choisir n’importe quel arrêt ou gare en Suisse,
- afficher les départs en continu,
- et pouvoir l’utiliser sur un ordinateur, une tablette ou un petit écran, sans contrainte matérielle spécifique.

L’interface s’inspire des panneaux officiels :
- style “panneau bus” pour les bus/trams,
- style “panneau train” pour les trains,
avec un affichage lisible à distance.

Données en temps réel via l’API transport.opendata.ch.  
Projet personnel, indépendant, sans affiliation avec les entreprises de transport public (p. ex. CFF/SBB/FFS).

## Inspirations

- Horloge CFF animée (projet communautaire)  
  https://cff-clock.slyc.ch/

- Discussion Reddit à l’origine de l’inspiration  
  https://www.reddit.com/r/Switzerland/comments/1fxt48a/want_a_sbb_clock_on_your_computer/

- Discussion Reddit sur l’expérience avec Tramli.ch  
  https://www.reddit.com/r/Switzerland/comments/1phax17/anyone_has_experience_with_tramlich/

- Tramli (appareil physique d’affichage des départs)  
  https://tramli.ch/en

## Fonctions principales
- Recherche d'arrêt avec suggestions et raccourcis favoris (stockés dans `localStorage`, pas de compte).
- Deux vues bus: par ligne (équilibrage par destination) ou chronologique; les trains sont toujours listés chronologiquement.
- Filtres rapides par quai/ligne + mode “Mes favoris” pour restreindre l'affichage.
- Horloge digitale + horloge CFF intégrée; rafraîchissement auto du board toutes les 10 s (~3 h d'horizon).
- Interface multilingue (FR/DE/IT/EN) et détection basique du réseau (TL/TPG/VBZ/TPN/MBC/VMCV) pour les couleurs de lignes.
- Liens profonds: `?stationName=...&stationId=...` pour ouvrir directement un arrêt.

## Démarrer en local
1) Prérequis: navigateur récent; aucun build ni dépendance. Un simple serveur HTTP suffit (évite les restrictions des modules ES en `file://`).
2) Lancer un serveur statique depuis `web-ui/`:
```sh
cd web-ui
python3 -m http.server 8000
```
3) Ouvrir http://localhost:8000 et rechercher un arrêt (ex: "Lausanne, motte").

## Déploiement
- Dossier `web-ui/` entièrement statique: à déposer tel quel sur Netlify/Vercel/S3/nginx/Apache.
- `main.js` est chargé comme module ES depuis `index.html`; conserver la structure de fichiers relative.

## Structure rapide
- `web-ui/index.html` : markup du tableau, popovers favoris/filtres, horloge.
- `web-ui/main.js` : bootstrap de l'app, boucle de rafraîchissement, persistance station/URL.
- `web-ui/logic.js` : appels transport.opendata.ch + normalisation (retards, quais, modes, filtres).
- `web-ui/ui.js` : rendu du board, recherche d'arrêt, gestion des favoris et filtres.
- `web-ui/state.js` : configuration globale (horizons, vues, seuils) et état partagé.
- `web-ui/i18n.js` : mini-lib de traduction (FR/DE/IT/EN) + switch langue.
- `web-ui/favourites.js` : stockage local des favoris (`md_favorites_v1`).
- `web-ui/style.css` : styles du board (modes, couleurs réseaux, popovers).

## Notes techniques
- Station par défaut: `Lausanne, motte`; le nom et l'id peuvent être forcés via l'URL ou `localStorage`.
- Rafraîchissement automatique toutes les 10 s; les données peuvent varier selon la couverture de l'API (horizon de 3 h max).
- Pas d'analytics ni backend; toutes les données utilisateur (langue, favoris) restent dans le navigateur.
