const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const TMDB_KEY = process.env.TMDB_API_KEY;
const PORT = process.env.PORT || 7000;
const TOTAL = 200;
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // jednou za tyden

if (!TMDB_KEY) {
  console.error("Chybi promenna prostredi TMDB_API_KEY");
  process.exit(1);
}

// Definice katalogu: id, nazev a parametry pro TMDB /discover/movie
const CATALOGS = [
  {
    id: "tmdb-top200",
    name: "TMDB Top 200 (1950–2000)",
    params: {
      sort_by: "vote_average.desc",
      "primary_release_date.gte": "1950-01-01",
      "primary_release_date.lte": "2000-12-31",
      "vote_count.gte": "1000",
    },
  },
  {
    id: "tmdb-cz-top200",
    name: "České a československé filmy",
    params: {
      sort_by: "vote_average.desc",
      // CZ = Cesko, CS = Ceskoslovensko (pipe znamena NEBO)
      with_origin_country: "CZ|CS",
      // ceske filmy maji min hlasu, proto nizsi prah
      "vote_count.gte": "100",
    },
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

async function loadTop(params) {
  const metas = [];
  for (let page = 1; page <= 15 && metas.length < TOTAL; page++) {
    const data = await tmdb("/discover/movie", { ...params, page });
    if (!data.results || data.results.length === 0) break;
    // Stremio potrebuje IMDb ID, TMDB ho vraci az v detailu
    const details = await Promise.all(
      data.results.map((m) =>
        tmdb(`/movie/${m.id}`, { append_to_response: "external_ids" }).catch(() => null)
      )
    );
    for (const d of details) {
      const imdb = d && d.external_ids && d.external_ids.imdb_id;
      if (!imdb) continue;
      metas.push({
        id: imdb,
        type: "movie",
        name: d.title,
        poster: d.poster_path ? "https://image.tmdb.org/t/p/w500" + d.poster_path : undefined,
        background: d.backdrop_path ? "https://image.tmdb.org/t/p/w1280" + d.backdrop_path : undefined,
        releaseInfo: (d.release_date || "").slice(0, 4),
        description: d.overview,
      });
    }
    if (page >= data.total_pages) break;
  }
  return metas.slice(0, TOTAL);
}

const cache = {};

async function refresh() {
  for (const c of CATALOGS) {
    try {
      cache[c.id] = await loadTop(c.params);
      console.log(`${c.name}: nacteno ${cache[c.id].length} filmu`);
    } catch (e) {
      console.error(`Chyba nacitani (${c.name}):`, e.message);
      cache[c.id] = cache[c.id] || [];
    }
  }
}

let ready = refresh();
setInterval(() => (ready = refresh()), REFRESH_MS);

const manifest = {
  id: "community.tmdb.top200.1950-2000",
  version: "1.1.0",
  name: "TMDB Top 200",
  description: "Žebříčky filmů podle TMDB: světový výběr 1950–2000 a české/československé filmy.",
  resources: ["catalog"],
  types: ["movie"],
  catalogs: CATALOGS.map((c) => ({ type: "movie", id: c.id, name: c.name })),
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "movie" || !CATALOGS.some((c) => c.id === id)) return { metas: [] };
  await ready;
  const skip = parseInt((extra && extra.skip) || 0, 10);
  return { metas: (cache[id] || []).slice(skip, skip + 100) };
});

serveHTTP(builder.getInterface(), { port: PORT });
