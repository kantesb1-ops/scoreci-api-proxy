# ScoreCI - Proxy API-FOOTBALL

Petit serveur qui fait l'intermediaire entre ScoreCI et API-FOOTBALL, pour que
votre cle API ne soit **jamais visible** dans le code de la page web.

## Pourquoi ce proxy est necessaire

ScoreCI est un fichier HTML/JS statique : tout ce qui s'y trouve est visible
par n'importe quel visiteur (clic droit -> "Afficher le code source", ou
l'onglet Reseau du navigateur). Si la cle API-FOOTBALL etait ecrite
directement dans ce fichier, n'importe qui pourrait la copier et l'utiliser a
votre place - ce qui consommerait votre quota (les plans gratuits sont
limites a ~100 requetes/jour) voire ferait bloquer la cle.

Ce petit serveur Node.js garde la cle uniquement cote serveur (variable
d'environnement) et expose a ScoreCI des routes simplifiees et mises en
cache :
- `GET /api/standings/:comp` - classement (can, cafcl, qualifs, l1fr, pl, liga, seriea, bundesliga)
- `GET /api/fixtures/:comp?scope=results|upcoming` - resultats / calendrier

## Installation

```bash
npm install
cp .env.example .env
# Ouvrez .env et collez votre cle API-FOOTBALL dans API_FOOTBALL_KEY
npm start
```

Le serveur ecoute par defaut sur `http://localhost:3001`.

## Deploiement (gratuit)

N'importe quel hebergeur Node fonctionne. Deux options simples :

- **Render.com** (recommande, plan gratuit) : New -> Web Service -> connectez
  le dossier/repo -> Build command `npm install` -> Start command
  `npm start` -> ajoutez la variable d'environnement `API_FOOTBALL_KEY` dans
  Settings > Environment.
- **Railway.app** : meme principe, variables d'environnement dans l'onglet
  Variables.

Une fois deploye, vous obtenez une URL du type
`https://scoreci-api-proxy.onrender.com`.

## Cote ScoreCI (le fichier HTML)

Dans `ScoreCI_app.html`, tout en haut du `<script>`, se trouve :

```js
var API_BASE = ""; // ex: "https://scoreci-api-proxy.onrender.com"
```

Renseignez l'URL de votre proxy deploye. Tant que ce champ est vide,
ScoreCI continue d'utiliser les donnees de demonstration integrees
(comportement actuel).

**Important** : si vous testez ScoreCI dans l'apercu integre a Claude
(artifact claude.ai), les appels reseau vers un domaine externe comme votre
proxy sont bloques par la politique de securite de cet apercu - c'est normal
et volontaire (protection anti-fuite de donnees). Les vraies donnees
fonctionneront des que vous heberger ScoreCI vous-meme (Netlify, comme vos
autres projets, ou tout autre hebergeur).

## Limiter qui peut appeler le proxy

Dans `.env`, `ALLOWED_ORIGINS` restreint les domaines autorises a appeler ce
proxy (protection CORS). Mettez-y le domaine ou vous hebergerez ScoreCI, par
exemple :

```
ALLOWED_ORIGINS=https://scoreci.votredomaine.com
```

## Notes sur le mapping des competitions

Les identifiants de ligue API-FOOTBALL ne sont pas codes en dur : le serveur
les recherche par nom au premier appel (`/leagues?search=...`) et les met en
cache 24h. Si un nom de competition ne correspond pas exactement a la
nomenclature API-FOOTBALL, ajustez le champ `search` correspondant dans
`COMPETITIONS` (server.js).
