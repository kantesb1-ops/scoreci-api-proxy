// ScoreCI - Proxy API-FOOTBALL
// Garde la cle API cote serveur (jamais exposee au navigateur) et met en cache
// les reponses pour ne pas epuiser le quota (plans gratuits : ~100 requetes/jour).
//
// Demarrage : copiez .env.example en .env, renseignez API_FOOTBALL_KEY, puis :
//   npm install
//   npm start

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const admin = require("firebase-admin");
const RSSParser = require("rss-parser");
const rssParser = new RSSParser();

const API_KEY = process.env.API_FOOTBALL_KEY;
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const API_BASE = "https://v3.football.api-sports.io";

if (!API_KEY) {
  console.error("ERREUR: API_FOOTBALL_KEY manquante. Copiez .env.example en .env et renseignez votre cle.");
  process.exit(1);
}

// ---- Firebase Admin (notifications push) ----
// Optionnel : sans cle de service, l'API-FOOTBALL continue de fonctionner
// normalement, seules les routes /api/subscribe et l'envoi de notifs sont
// desactivees.
let messaging = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
  try {
    const json = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, "base64").toString("utf8");
    const serviceAccount = JSON.parse(json);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    messaging = admin.messaging();
    console.log("Firebase Admin initialise : notifications push activees.");
  } catch (err) {
    console.error("Impossible d'initialiser Firebase Admin :", err.message);
  }
} else {
  console.log("FIREBASE_SERVICE_ACCOUNT_B64 absente : notifications push desactivees.");
}

// Jetons des appareils abonnes (en memoire ; repart a zero si le serveur
// redemarre - suffisant pour demarrer, a migrer vers une vraie base plus tard).
const subscribedTokens = new Set();

const app = express();
app.use(cors({
  origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true
}));
app.use(express.json());

// ---- Competitions exposees a ScoreCI ----
// Chaque entree decrit comment RETROUVER l'id numerique API-FOOTBALL de la
// competition (on ne code pas les id en dur : on les resout une fois via
// /leagues puis on les met en cache, pour eviter toute erreur de mapping).
const COMPETITIONS = {
  ligue1ci:    { search: "Ligue 1", country: "Ivory Coast" },
  can:         { search: "Africa Cup of Nations", country: null },
  cafcl:       { search: "CAF Champions League", country: null },
  qualifs:     { search: "World Cup - Qualification Africa", country: null },
  ucl:         { search: "UEFA Champions League", country: null },
  uel:         { search: "UEFA Europa League", country: null },
  l1fr:        { search: "Ligue 1", country: "France" },
  pl:          { search: "Premier League", country: "England" },
  liga:        { search: "La Liga", country: "Spain" },
  seriea:      { search: "Serie A", country: "Italy" },
  bundesliga:  { search: "Bundesliga", country: "Germany" },
  eredivisie:  { search: "Eredivisie", country: "Netherlands" },
  primeira:    { search: "Primeira Liga", country: "Portugal" },
  superlig:    { search: "Super Lig", country: "Turkey" },
  saudipl:     { search: "Pro League", country: "Saudi-Arabia" },
  mls:         { search: "Major League Soccer", country: "USA" }
};

// Ordre d'affichage : grands championnats d'abord, le reste ensuite
// (utilise pour trier les groupes de matchs en direct).
const LEAGUE_PRIORITY = [
  "World Cup - Qualification Africa", "Africa Cup of Nations", "CAF Champions League",
  "UEFA Champions League", "UEFA Europa League",
  "Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1",
  "Primeira Liga", "Eredivisie", "Super Lig"
];
function leaguePriority(name) {
  const idx = LEAGUE_PRIORITY.indexOf(name);
  return idx === -1 ? 999 : idx;
}

// ---- Cache memoire simple (TTL) ----
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "x-apisports-key": API_KEY }
  });
  if (!res.ok) {
    throw new Error(`API-FOOTBALL ${path} -> HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    throw new Error(`API-FOOTBALL error: ${JSON.stringify(json.errors)}`);
  }
  return json.response;
}

// Resout et met en cache l'id de ligue + la saison en cours pour une competition.
async function resolveLeague(compId) {
  const cacheKey = `league:${compId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const cfg = COMPETITIONS[compId];
  if (!cfg) throw new Error(`Competition inconnue: ${compId}`);

  let qs = `search=${encodeURIComponent(cfg.search)}`;
  const results = await apiGet(`/leagues?${qs}`);
  if (!results || !results.length) {
    throw new Error(`Aucune ligue trouvee pour "${cfg.search}"`);
  }
  // Si un pays est precise, on exige une correspondance exacte (sinon on
  // risquerait de resoudre "Ligue 1" vers la France au lieu de la CI, par
  // exemple) ; sinon on prend le 1er resultat.
  let match;
  if (cfg.country) {
    match = results.find(r => r.country && r.country.name === cfg.country);
    if (!match) {
      throw new Error(`Ligue "${cfg.search}" introuvable pour le pays "${cfg.country}"`);
    }
  } else {
    match = results[0];
  }

  const currentSeason = (match.seasons || []).find(s => s.current) || (match.seasons || []).slice(-1)[0];
  const info = {
    leagueId: match.league.id,
    season: currentSeason ? currentSeason.year : new Date().getFullYear(),
    name: match.league.name
  };
  cacheSet(cacheKey, info, 24 * 60 * 60 * 1000); // 24h : les ids ne changent pas
  return info;
}

// GET /api/standings/:comp  -> classement normalise pour ScoreCI
app.get("/api/standings/:comp", async (req, res) => {
  const compId = req.params.comp;
  if (!COMPETITIONS[compId]) return res.status(404).json({ error: "Competition inconnue" });

  const cacheKey = `standings:${compId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const { leagueId, season, name } = await resolveLeague(compId);
    const response = await apiGet(`/standings?league=${leagueId}&season=${season}`);

    const groups = response?.[0]?.league?.standings || [];
    // Une competition peut avoir plusieurs groupes/poules (CAN, qualifs...).
    // On renvoie TOUS les groupes (avec leur label), le front les affiche
    // separement avec un en-tete par groupe plutot que de les fusionner
    // (ce qui melangeait les classements) ou de n'en garder qu'un seul
    // (ce qui cachait les autres poules).
    const ciGroupIdx = groups.findIndex(g => g.some(row => /ivoire|ivory coast/i.test(row.team.name)));
    const orderedGroups = ciGroupIdx > 0
      ? [groups[ciGroupIdx], ...groups.slice(0, ciGroupIdx), ...groups.slice(ciGroupIdx + 1)]
      : groups;

    const groupPayloads = orderedGroups.map(g => ({
      label: g[0]?.group || null,
      teams: g.map(row => ({
        emoji: null,
        logo: row.team.logo,
        name: row.team.name,
        color: null,
        j: row.all.played,
        g: row.all.win,
        n: row.all.draw,
        d: row.all.lose,
        pts: row.points
      }))
    }));

    const payload = { comp: compId, label: name, season, groups: groupPayloads, updatedAt: new Date().toISOString() };
    cacheSet(cacheKey, payload, 15 * 60 * 1000); // 15 min
    res.json(payload);
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: "Impossible de recuperer le classement", detail: err.message });
  }
});

// GET /api/fixtures/:comp?scope=results|upcoming
app.get("/api/fixtures/:comp", async (req, res) => {
  const compId = req.params.comp;
  const scope = req.query.scope === "upcoming" ? "upcoming" : "results";
  if (!COMPETITIONS[compId]) return res.status(404).json({ error: "Competition inconnue" });

  const cacheKey = `fixtures:${compId}:${scope}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const { leagueId, season, name } = await resolveLeague(compId);
    const param = scope === "upcoming" ? "next" : "last";
    const response = await apiGet(`/fixtures?league=${leagueId}&season=${season}&${param}=8`);

    const matches = response.map(f => ({
      id: f.fixture.id,
      date: f.fixture.date,
      status: f.fixture.status.short,
      home: f.teams.home.name,
      away: f.teams.away.name,
      homeLogo: f.teams.home.logo,
      awayLogo: f.teams.away.logo,
      homeScore: f.goals.home,
      awayScore: f.goals.away,
      comp: name
    }));

    const payload = { comp: compId, scope, matches, updatedAt: new Date().toISOString() };
    cacheSet(cacheKey, payload, 10 * 60 * 1000); // 10 min
    res.json(payload);
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: "Impossible de recuperer les matchs", detail: err.message });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// GET /api/live -> tous les matchs en direct, regroupes par championnat
app.get("/api/live", async (req, res) => {
  const cacheKey = "live:all";
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await apiGet(`/fixtures?live=all`);
    const flat = (response || []).slice(0, 60).map(f => ({
      id: f.fixture.id,
      date: f.fixture.date,
      status: f.fixture.status.short,
      elapsed: f.fixture.status.elapsed,
      home: f.teams.home.name,
      away: f.teams.away.name,
      homeLogo: f.teams.home.logo,
      awayLogo: f.teams.away.logo,
      homeScore: f.goals.home,
      awayScore: f.goals.away,
      comp: f.league.name,
      country: f.league.country,
      compLogo: f.league.logo
    }));
    // Regroupe par championnat pour l'affichage (fini le "tout mélangé")
    const groups = {};
    flat.forEach(m => {
      const key = m.comp + (m.country ? " (" + m.country + ")" : "");
      if (!groups[key]) groups[key] = { competition: m.comp, country: m.country, logo: m.compLogo, matches: [] };
      groups[key].matches.push(m);
    });
    const payload = {
      matches: flat,
      groups: Object.values(groups).sort((a, b) => leaguePriority(a.competition) - leaguePriority(b.competition) || b.matches.length - a.matches.length),
      updatedAt: new Date().toISOString()
    };
    cacheSet(cacheKey, payload, 60 * 1000); // 60s : donnees live, cache court
    res.json(payload);
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: "Impossible de recuperer les matchs en direct", detail: err.message });
  }
});

// GET /api/news?zone=ci|afrique|monde -> actualites football en temps reel
// via Google News RSS (meme principe que le backend KSB Sport).
const NEWS_QUERIES = {
  ci: "football Cote d'Ivoire Ligue 1 Elephants ASEC Africa Sports",
  afrique: "CAN 2025 OR \"CAF Champions League\" OR football Afrique transferts",
  monde: "football Coupe du monde 2026 OR \"Champions League\" OR Premier League OR Liga OR Serie A transferts mercato"
};
app.get("/api/news", async (req, res) => {
  const zone = ["ci", "afrique", "monde"].includes(req.query.zone) ? req.query.zone : "ci";
  const cacheKey = `news:${zone}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const q = encodeURIComponent(NEWS_QUERIES[zone]);
    const url = `https://news.google.com/rss/search?q=${q}&hl=fr&gl=CI&ceid=CI:fr`;
    const feed = await rssParser.parseURL(url);
    const items = (feed.items || []).slice(0, 15).map(it => ({
      title: it.title,
      link: it.link,
      date: it.isoDate || it.pubDate,
      source: (it.title && it.title.includes(" - ")) ? it.title.split(" - ").pop() : (it.creator || "Google News")
    }));
    const payload = { zone, items, updatedAt: new Date().toISOString() };
    cacheSet(cacheKey, payload, 12 * 60 * 1000); // 12 min : plus a jour
    res.json(payload);
  } catch (err) {
    console.error("news:", err.message);
    res.status(502).json({ error: "Impossible de recuperer les actualites", detail: err.message });
  }
});

// POST /api/subscribe { token } -> enregistre un appareil pour les notifications
// GET /api/fixture/:id -> detail complet d'un match (evenements, stade, arbitre)
app.get("/api/fixture/:id", async (req, res) => {
  const id = req.params.id;
  const cacheKey = `fixture:${id}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await apiGet(`/fixtures?id=${id}`);
    const f = response && response[0];
    if (!f) return res.status(404).json({ error: "Match introuvable" });

    const events = (f.events || []).map(e => ({
      minute: e.time.elapsed + (e.time.extra ? "+" + e.time.extra : ""),
      type: e.type,          // "Goal", "Card", "subst"...
      detail: e.detail,      // "Normal Goal", "Yellow Card"...
      team: e.team.name,
      player: e.player.name,
      assist: e.assist ? e.assist.name : null
    }));

    const payload = {
      id: f.fixture.id,
      date: f.fixture.date,
      status: f.fixture.status.short,
      elapsed: f.fixture.status.elapsed,
      venue: f.fixture.venue ? f.fixture.venue.name : null,
      referee: f.fixture.referee || null,
      home: f.teams.home.name,
      away: f.teams.away.name,
      homeLogo: f.teams.home.logo,
      awayLogo: f.teams.away.logo,
      homeScore: f.goals.home,
      awayScore: f.goals.away,
      comp: f.league.name,
      country: f.league.country,
      round: f.league.round,
      events,
      updatedAt: new Date().toISOString()
    };
    cacheSet(cacheKey, payload, 30 * 1000); // 30s : peut evoluer si le match est en cours
    res.json(payload);
  } catch (err) {
    console.error("fixture detail:", err.message);
    res.status(502).json({ error: "Impossible de recuperer le detail du match", detail: err.message });
  }
});

app.post("/api/subscribe", (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "token manquant" });
  subscribedTokens.add(token);
  res.json({ ok: true, total: subscribedTokens.size });
});

// POST /api/notify { title, body } -> envoie une notif a tous les appareils abonnes
// (route manuelle, utile pour tester ; la detection automatique de buts
// utilise la meme fonction en interne, voir plus bas)
async function sendNotification(title, body) {
  if (!messaging || !subscribedTokens.size) return { sent: 0 };
  const tokens = Array.from(subscribedTokens);
  const res = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    webpush: { fcmOptions: { link: "/" } }
  });
  // Nettoie les jetons invalides/expires
  res.responses.forEach((r, i) => {
    if (!r.success) subscribedTokens.delete(tokens[i]);
  });
  return { sent: res.successCount };
}
app.post("/api/notify", async (req, res) => {
  if (!messaging) return res.status(503).json({ error: "Notifications non configurees" });
  const { title, body } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: "title et body requis" });
  try {
    const result = await sendNotification(title, body);
    res.json(result);
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: "Envoi echoue", detail: err.message });
  }
});

// ---- Detection automatique de buts sur les matchs en direct ----
// Toutes les 60s, compare les scores en direct au dernier releve connu et
// notifie les abonnes si un score a change.
const lastScores = new Map(); // fixtureId -> "home-away"
async function checkLiveGoals() {
  if (!messaging || !subscribedTokens.size) return;
  try {
    const response = await apiGet(`/fixtures?live=all`);
    (response || []).forEach(f => {
      const id = f.fixture.id;
      const score = `${f.goals.home ?? 0}-${f.goals.away ?? 0}`;
      const prev = lastScores.get(id);
      if (prev && prev !== score) {
        sendNotification(
          "⚽ But !",
          `${f.teams.home.name} ${score} ${f.teams.away.name} (${f.league.name})`
        ).catch(e => console.error("Notif echouee:", e.message));
      }
      lastScores.set(id, score);
    });
  } catch (err) {
    console.error("checkLiveGoals:", err.message);
  }
}
setInterval(checkLiveGoals, 60 * 1000);

app.listen(PORT, () => {
  console.log(`ScoreCI API proxy en ecoute sur le port ${PORT}`);
});
