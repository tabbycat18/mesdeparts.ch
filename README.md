# mesdeparts.ch

Tableau de départs des transports publics suisses (bus, tram, métro, trains) affiché façon board CFF. Données en temps réel via l'API transport.opendata.ch.

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
