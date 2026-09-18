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

const API_KEY = process.env.API_FOOTBALL_KEY;
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const API_BASE = "https://v3.football.api-sports.io";

if (!API_KEY) {
  console.error("ERREUR: API_FOOTBALL_KEY manquante. Copiez .env.example en .env et renseignez votre cle.");
  process.exit(1);
}

const app = express();
app.use(cors({
  origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true
}));

// ---- Competitions exposees a ScoreCI ----
// Chaque entree decrit comment RETROUVER l'id numerique API-FOOTBALL de la
// competition (on ne code pas les id en dur : on les resout une fois via
// /leagues puis on les met en cache, pour eviter toute erreur de mapping).
const COMPETITIONS = {
  can:         { search: "Africa Cup of Nations", country: null },
  cafcl:       { search: "CAF Champions League", country: null },
  qualifs:     { search: "World Cup - Qualification Africa", country: null },
  l1fr:        { search: "Ligue 1", country: "France" },
  pl:          { search: "Premier League", country: "England" },
  liga:        { search: "La Liga", country: "Spain" },
  seriea:      { search: "Serie A", country: "Italy" },
  bundesliga:  { search: "Bundesliga", country: "Germany" }
};

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
  // Si un pays est precise, on filtre dessus ; sinon on prend le 1er resultat
  // dont un "seasons" est marque current:true.
  let match = cfg.country
    ? results.find(r => r.country && r.country.name === cfg.country) || results[0]
    : results[0];

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
    // Standings CAN/qualifs sont souvent divisees en plusieurs groupes ; on les fusionne
    // et on garde le nom du groupe pour l'affichage.
    const teams = groups.flat().map(row => ({
      emoji: null,
      logo: row.team.logo,
      name: row.team.name,
      color: null,
      group: row.group || null,
      j: row.all.played,
      g: row.all.win,
      n: row.all.draw,
      d: row.all.lose,
      pts: row.points
    }));

    const payload = { comp: compId, label: name, season, teams, updatedAt: new Date().toISOString() };
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

app.listen(PORT, () => {
  console.log(`ScoreCI API proxy en ecoute sur le port ${PORT}`);
});
