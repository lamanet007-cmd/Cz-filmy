const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const TMDB_KEY = process.env.TMDB_API_KEY;
const PORT = process.env.PORT || 7000;
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

if (!TMDB_KEY) {
  console.error("Chybi promenna prostredi TMDB_API_KEY");
  process.exit(1);
}

const today = () => new Date().toISOString().slice(0, 10);

// Popis katalogu:
//  type    - "movie" nebo "series"
//  total   - kolik poloziek ma katalog mit
//  sort    - "rating" (podle hodnoceni) nebo "date" (podle data vydani, nejnovejsi prvni)
//  ttl     - po jake dobe se katalog obnovi
//  pages   - kolik stranek z TMDB se maximalne prochazi na jeden dotaz
//  queries - funkce vracejici parametry pro TMDB /discover (vice dotazu se spoji)
const CATALOGS = [
  {
    id: "tmdb-top200",
    name: "TMDB Top 200 (1950–2000)",
    type: "movie",
    total: 200,
    sort: "rating",
    ttl: WEEK,
    pages: 15,
    queries: () => [
      {
        sort_by: "vote_average.desc",
        "primary_release_date.gte": "1950-01-01",
        "primary_release_date.lte": "2000-12-31",
        "vote_count.gte": "1000",
      },
    ],
  },
  {
    id: "tmdb-cz-top200",
    name: "České a československé filmy",
    type: "movie",
    total: 200,
    sort: "rating",
    ttl: WEEK,
    pages: 15,
    queries: () => [
      // ceske filmy (puvodni jazyk cestina)
      {
        sort_by: "vote_average.desc",
        with_original_language: "cs",
        "vote_count.gte": "25",
      },
      // slovenske filmy jen z doby Ceskoslovenska
      {
        sort_by: "vote_average.desc",
        with_original_language: "sk",
        "primary_release_date.lte": "1992-12-31",
        "vote_count.gte": "25",
      },
    ],
  },
  {
    id: "tmdb-horror-top200",
    name: "Nejlepší horory",
    type: "movie",
    total: 200,
    sort: "rating",
    ttl: WEEK,
    pages: 15,
    queries: () => [
      { sort_by: "vote_average.desc", with_genres: "27", "vote_count.gte": "1000" },
    ],
  },
  {
    id: "tmdb-scifi-top200",
    name: "Nejlepší sci-fi",
    type: "movie",
    total: 200,
    sort: "rating",
    ttl: WEEK,
    pages: 15,
    queries: () => [
      { sort_by: "vote_average.desc", with_genres: "878", "vote_count.gte": "1000" },
    ],
  },
  {
    id: "tmdb-new-movies",
    name: "Nejnovější filmy",
    type: "movie",
    total: 50,
    sort: "date",
    ttl: DAY,
    pages: 8,
    queries: () => [
      {
        sort_by: "primary_release_date.desc",
        "primary_release_date.lte": today(),
        "vote_count.gte": "30",
      },
    ],
  },
  {
    id: "tmdb-new-horror",
    name: "Nejnovější horory",
    type: "movie",
    total: 50,
    sort: "date",
    ttl: DAY,
    pages: 8,
    queries: () => [
      {
        sort_by: "primary_release_date.desc",
        "primary_release_date.lte": today(),
        with_genres: "27",
        "vote_count.gte": "20",
      },
    ],
  },
  {
    id: "tmdb-new-series",
    name: "Nejnovější seriály",
    type: "series",
    total: 50,
    sort: "date",
    ttl: DAY,
    pages: 8,
    queries: () => [
      {
        sort_by: "first_air_date.desc",
        "first_air_date.lte": today(),
        "vote_count.gte": "10",
      },
    ],
  },
  {
    id: "tmdb-new-docs",
    name: "Nejnovější dokumenty",
    type: "movie",
    total: 50,
    sort: "date",
    ttl: DAY,
    pages: 8,
    queries: () => [
      {
        sort_by: "primary_release_date.desc",
        "primary_release_date.lte": today(),
        with_genres: "99",
        "vote_count.gte": "10",
      },
    ],
  },
];

async function tmdb(path, params = {}) {
  const url = new URL("https://api.themoviedb.org/3" + path);
  url.searchParams.set("api_key", TMDB_KEY);
  url.searchParams.set("language", "cs-CZ");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status} ${path}`);
  return res.json();
}

const itemDate = (m) => m.release_date || m.first_air_date || "";

async function loadCatalog(c) {
  const isTv = c.type === "series";

  // 1) sesbirat kandidaty ze vsech dotazu
  const seen = new Map();
  for (const params of c.queries()) {
    for (let page = 1; page <= c.pages; page++) {
      const data = await tmdb(isTv ? "/discover/tv" : "/discover/movie", { ...params, page });
      if (!data.results || data.results.length === 0) break;
      for (const m of data.results) seen.set(m.id, m);
      if (page >= data.total_pages) break;
    }
  }
  const sorted = [...seen.values()].sort((a, b) =>
    c.sort === "date"
      ? itemDate(b).localeCompare(itemDate(a))
      : b.vote_average - a.vote_average
  );

  // 2) po davkach dohledat IMDb ID (Stremio ho potrebuje)
  const metas = [];
  for (let i = 0; i < sorted.length && metas.length < c.total; i += 20) {
    const batch = sorted.slice(i, i + 20);
    const details = await Promise.all(
      batch.map((m) =>
        tmdb(`/${isTv ? "tv" : "movie"}/${m.id}`, { append_to_response: "external_ids" }).catch(
          () => null
        )
      )
    );
    for (const d of details) {
      const imdb = d && d.external_ids && d.external_ids.imdb_id;
      if (!imdb) continue;
      metas.push({
        id: imdb,
        type: c.type,
        name: isTv ? d.name : d.title,
        poster: d.poster_path ? "https://image.tmdb.org/t/p/w500" + d.poster_path : undefined,
        background: d.backdrop_path ? "https://image.tmdb.org/t/p/w1280" + d.backdrop_path : undefined,
        releaseInfo: itemDate(d).slice(0, 4),
        description: d.overview,
      });
    }
  }
  return metas.slice(0, c.total);
}

const cache = {}; // id -> { metas, at }
const loading = new Set();

async function refreshCatalog(c) {
  if (loading.has(c.id)) return;
  loading.add(c.id);
  try {
    const metas = await loadCatalog(c);
    cache[c.id] = { metas, at: Date.now() };
    console.log(`${c.name}: nacteno ${metas.length} poloziek`);
  } catch (e) {
    console.error(`Chyba nacitani (${c.name}):`, e.message);
    if (!cache[c.id]) cache[c.id] = { metas: [], at: 0 };
  } finally {
    loading.delete(c.id);
  }
}

async function refreshAll() {
  for (const c of CATALOGS) await refreshCatalog(c);
}

const ready = refreshAll();

const manifest = {
  id: "community.tmdb.top200.1950-2000",
  version: "1.4.0",
  name: "TMDB Top 200",
  description:
    "Žebříčky podle TMDB: světový výběr, české a československé filmy, horory, sci-fi a nejnovější filmy, seriály a dokumenty.",
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: CATALOGS.map((c) => ({ type: c.type, id: c.id, name: c.name })),
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const c = CATALOGS.find((x) => x.id === id && x.type === type);
  if (!c) return { metas: [] };
  await ready;
  const entry = cache[id];
  // zastarali katalog se obnovi na pozadi, vratime zatim stavajici data
  if (!entry || Date.now() - entry.at > c.ttl) refreshCatalog(c);
  const skip = parseInt((extra && extra.skip) || 0, 10);
  return { metas: ((entry && entry.metas) || []).slice(skip, skip + 100) };
});

serveHTTP(builder.getInterface(), { port: PORT });
