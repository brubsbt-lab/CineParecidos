import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";

const API_KEY_STORAGE = "tmdb-api-key";
const OMDB_KEY_STORAGE = "omdb-api-key";
const WATCHED_STORAGE = "tmdb-watched-films";
const DISMISSED_STORAGE = "tmdb-dismissed-ids";
const IMG_BASE = "https://image.tmdb.org/t/p/w342";
const IMG_BASE_SMALL = "https://image.tmdb.org/t/p/w92";
const MIN_RATING_FLOOR = 6;
const MIN_RATING_CEIL = 9;
const DEFAULT_MIN_RATING = 7;
const MIN_RATING_STORAGE = "min-rating";

// TMDB has two credential formats: a short v3 "API Key" (appended as a query
// param) and a long v4 "Read Access Token" (a JWT, sent as a Bearer header).
// We detect which one the user pasted and build requests accordingly.
function isV4Token(key) {
  return key.length > 60 || key.split(".").length === 3;
}

function tmdbUrl(path, apiKey, extraParams = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  if (!isV4Token(apiKey)) url.searchParams.set("api_key", apiKey);
  Object.entries(extraParams).forEach(([k, v]) => url.searchParams.set(k, v));
  return url.toString();
}

function tmdbHeaders(apiKey) {
  return isV4Token(apiKey) ? { Authorization: `Bearer ${apiKey}`, accept: "application/json" } : { accept: "application/json" };
}

export default function CineParecidos() {
  const [apiKey, setApiKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [omdbKey, setOmdbKey] = useState("");
  const [omdbKeyInput, setOmdbKeyInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState("descobrir"); // descobrir | prateleira

  const [watched, setWatched] = useState([]); // [{id,title,year,poster_path,genre_ids}]
  const [dismissedIds, setDismissedIds] = useState(() => new Set());
  const [loaded, setLoaded] = useState(false);

  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

  const [recommendations, setRecommendations] = useState([]);
  const [recLoading, setRecLoading] = useState(false);
  const [providerFilter, setProviderFilter] = useState("all"); // all | netflix | prime
  const [minRating, setMinRating] = useState(DEFAULT_MIN_RATING);
  const [recError, setRecError] = useState("");
  const [awardsCache, setAwardsCache] = useState({}); // movieId -> { awards } | null while loading

  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);
  const searchDebounce = useRef(null);

  function showToast(msg) {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2200);
  }

  // ---- load saved keys + watched list + dismissed list (plain browser localStorage) ----
  useEffect(() => {
    try {
      const k = localStorage.getItem(API_KEY_STORAGE);
      if (k) {
        setApiKey(k);
        setKeyInput(k);
      }
    } catch (e) {
      // localStorage unavailable — fine, just won't persist
    }
    try {
      const ok = localStorage.getItem(OMDB_KEY_STORAGE);
      if (ok) {
        setOmdbKey(ok);
        setOmdbKeyInput(ok);
      }
    } catch (e) {
      // none saved yet
    }
    try {
      const w = localStorage.getItem(WATCHED_STORAGE);
      if (w) setWatched(JSON.parse(w));
    } catch (e) {
      // none saved yet
    }
    try {
      const d = localStorage.getItem(DISMISSED_STORAGE);
      if (d) setDismissedIds(new Set(JSON.parse(d)));
    } catch (e) {
      // none saved yet
    }
    try {
      const mr = localStorage.getItem(MIN_RATING_STORAGE);
      if (mr) setMinRating(Number(mr));
    } catch (e) {
      // none saved yet
    }
    setLoaded(true);
  }, []);

  // ---- persist watched list + dismissed list ----
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(WATCHED_STORAGE, JSON.stringify(watched));
    } catch (e) {
      console.error("Falha ao salvar prateleira", e);
    }
  }, [watched, loaded]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(DISMISSED_STORAGE, JSON.stringify([...dismissedIds]));
    } catch (e) {
      console.error("Falha ao salvar exclusões", e);
    }
  }, [dismissedIds, loaded]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(MIN_RATING_STORAGE, String(minRating));
    } catch (e) {
      console.error("Falha ao salvar nota mínima", e);
    }
  }, [minRating, loaded]);

  function saveKey() {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setApiKey(trimmed);
    try {
      localStorage.setItem(API_KEY_STORAGE, trimmed);
    } catch (e) {
      // will still work for this session
    }
    const trimmedOmdb = omdbKeyInput.trim();
    if (trimmedOmdb) {
      setOmdbKey(trimmedOmdb);
      try {
        localStorage.setItem(OMDB_KEY_STORAGE, trimmedOmdb);
      } catch (e) {
        // will still work for this session
      }
    }
    setShowSettings(false);
    showToast("Chave(s) salva(s)");
  }

  function dismissRecommendation(movie) {
    setDismissedIds((prev) => new Set(prev).add(movie.id));
    showToast(`Removido das recomendações: ${movie.title}`);
  }

  // ---- search TMDB ----
  useEffect(() => {
    clearTimeout(searchDebounce.current);
    if (!apiKey || query.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    searchDebounce.current = setTimeout(async () => {
      setSearching(true);
      setSearchError("");
      try {
        const res = await fetch(
          tmdbUrl("/search/movie", apiKey, { language: "pt-BR", query }),
          { headers: tmdbHeaders(apiKey) }
        );
        const data = await res.json();
        if (res.status === 401) {
          throw new Error("A chave foi rejeitada pelo TMDB (401). Confira se copiou o valor completo, sem espaços.");
        }
        if (!res.ok) throw new Error(data.status_message || "Erro na busca");
        setSearchResults((data.results || []).slice(0, 8));
      } catch (e) {
        setSearchError(e.message || "Não deu pra buscar agora. Tente de novo em instantes.");
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(searchDebounce.current);
  }, [query, apiKey]);

  const watchedIds = useMemo(() => new Set(watched.map((w) => w.id)), [watched]);

  function addWatched(movie) {
    if (watchedIds.has(movie.id)) return;
    const entry = {
      id: movie.id,
      title: movie.title,
      year: (movie.release_date || "").slice(0, 4),
      poster_path: movie.poster_path,
      genre_ids: movie.genre_ids || [],
    };
    setWatched((prev) => [...prev, entry]);
    setQuery("");
    setSearchResults([]);
    showToast(`Marcado como visto: ${movie.title}`);
  }

  function removeWatched(movie) {
    setWatched((prev) => prev.filter((w) => w.id !== movie.id));
    showToast(`Removido: ${movie.title}`);
  }

  // ---- build recommendations from TMDB's own similar/recommendations endpoints,
  // then rank by a mix of (a) how many watched films point to the candidate and
  // (b) the candidate's own TMDB rating — so a title isn't recommended purely
  // because it shares a genre with something you saw. Anything dismissed by
  // the user, or rated below MIN_RATING, never enters the pool. ----
  const RECS_TARGET = 12;
  const RECS_CANDIDATE_CAP = 120;
  const PROVIDER_BATCH = 15;

  function matchesProvider(entry, needle) {
    if (needle === "all") return true;
    return entry.providers.some((p) => p.toLowerCase().includes(needle));
  }

  const fetchRecommendations = useCallback(async () => {
    if (!apiKey || watched.length === 0) {
      setRecommendations([]);
      return;
    }
    setRecLoading(true);
    setRecError("");
    try {
      const tally = new Map(); // movieId -> { movie, count, sources:Set }
      for (const w of watched) {
        // Pull a couple of pages per watched film so there's enough raw
        // material left after the rating cut and the streaming filter.
        for (let page = 1; page <= 2; page++) {
          const res = await fetch(
            tmdbUrl(`/movie/${w.id}/recommendations`, apiKey, { language: "pt-BR", page: String(page) }),
            { headers: tmdbHeaders(apiKey) }
          );
          if (res.status === 401) {
            throw new Error("A chave foi rejeitada pelo TMDB (401). Confira se copiou o valor completo, sem espaços.");
          }
          if (!res.ok) break;
          const data = await res.json();
          for (const m of data.results || []) {
            if (watchedIds.has(m.id)) continue;
            if (dismissedIds.has(m.id)) continue;
            if (!tally.has(m.id)) {
              tally.set(m.id, { movie: m, count: 0, sources: new Set() });
            }
            const entry = tally.get(m.id);
            entry.count += 1;
            entry.sources.add(w.title);
          }
          if (page >= (data.total_pages || 1)) break;
        }
      }

      // Require a minimum vote count (so a handful of 10/10 ratings can't
      // outrank something genuinely well-reviewed) and a minimum rating —
      // below that, it's not worth showing regardless of genre overlap.
      const scored = [...tally.values()]
        .filter((e) => (e.movie.vote_count || 0) >= 20 && (e.movie.vote_average || 0) >= minRating)
        .map((e) => ({
          ...e,
          combinedScore: e.count * 3 + (e.movie.vote_average || 0),
        }))
        .sort((a, b) => b.combinedScore - a.combinedScore);

      // Fetch streaming availability (Brazil) in batches, going deeper into
      // the ranked list until every filter (Todos / Netflix / Amazon Prime
      // Video) has at least RECS_TARGET matches, or we run out of candidates.
      let annotated = [];
      let idx = 0;
      while (idx < scored.length && idx < RECS_CANDIDATE_CAP) {
        const batch = scored.slice(idx, idx + PROVIDER_BATCH);
        const withProviders = await Promise.all(
          batch.map(async (entry) => {
            try {
              const pRes = await fetch(
                tmdbUrl(`/movie/${entry.movie.id}/watch/providers`, apiKey),
                { headers: tmdbHeaders(apiKey) }
              );
              const pData = await pRes.json();
              const flatrate = pData?.results?.BR?.flatrate || [];
              return { ...entry, providers: flatrate.map((p) => p.provider_name) };
            } catch (e) {
              return { ...entry, providers: [] };
            }
          })
        );
        annotated = annotated.concat(withProviders);
        idx += PROVIDER_BATCH;

        const enoughAll = annotated.length >= RECS_TARGET;
        const enoughNetflix = annotated.filter((e) => matchesProvider(e, "netflix")).length >= RECS_TARGET;
        const enoughPrime = annotated.filter((e) => matchesProvider(e, "prime video")).length >= RECS_TARGET;
        if (enoughAll && enoughNetflix && enoughPrime) break;
      }

      setRecommendations(annotated);
    } catch (e) {
      setRecError(e.message || "Não foi possível carregar recomendações agora.");
    } finally {
      setRecLoading(false);
    }
  }, [apiKey, watched, watchedIds, dismissedIds, minRating]);

  useEffect(() => {
    fetchRecommendations();
  }, [fetchRecommendations]);

  const visibleRecommendations = useMemo(() => {
    let list = recommendations.filter((r) => !dismissedIds.has(r.movie.id));
    if (providerFilter !== "all") {
      const needle = providerFilter === "netflix" ? "netflix" : "prime video";
      list = list.filter((r) => r.providers.some((p) => p.toLowerCase().includes(needle)));
    }
    return list.slice(0, 12);
  }, [recommendations, dismissedIds, providerFilter]);

  // ---- fetch awards text from OMDb for whatever is currently visible ----
  useEffect(() => {
    if (!omdbKey || visibleRecommendations.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const { movie } of visibleRecommendations) {
        if (awardsCache[movie.id] !== undefined) continue;
        try {
          const extRes = await fetch(
            tmdbUrl(`/movie/${movie.id}/external_ids`, apiKey),
            { headers: tmdbHeaders(apiKey) }
          );
          const extData = await extRes.json();
          const imdbId = extData.imdb_id;
          if (!imdbId) {
            if (!cancelled) setAwardsCache((prev) => ({ ...prev, [movie.id]: null }));
            continue;
          }
          const omdbRes = await fetch(
            `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(omdbKey)}`
          );
          const omdbData = await omdbRes.json();
          const awards = omdbData.Awards && omdbData.Awards !== "N/A" ? omdbData.Awards : null;
          if (!cancelled) setAwardsCache((prev) => ({ ...prev, [movie.id]: awards }));
        } catch (e) {
          if (!cancelled) setAwardsCache((prev) => ({ ...prev, [movie.id]: null }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visibleRecommendations, omdbKey, apiKey, awardsCache]);

  return (
    <div style={styles.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Space+Mono:wght@400;700&display=swap');
        * { box-sizing: border-box; }
        .film-card { transition: transform 0.15s ease, border-color 0.15s ease; }
        .film-card:hover { transform: translateY(-2px); }
        button { font-family: inherit; cursor: pointer; }
        input { font-family: inherit; }
        ::selection { background: #D4A017; color: #1B1714; }
        .search-item:hover { background: #2A241F; }
        @media (max-width: 480px) {
          .header-row { flex-direction: column; }
        }
      `}</style>

      <header style={styles.header}>
        <div style={{ display: "flex", gap: 16 }} className="header-row">
          <div style={styles.reelMark}>◐</div>
          <div>
            <h1 style={styles.h1}>Catálogo de Semelhanças</h1>
            <p style={styles.subhead}>Marque o que você já viu. O TMDB aponta o próximo.</p>
          </div>
        </div>
        <button style={styles.settingsBtn} onClick={() => setShowSettings((s) => !s)}>
          {apiKey ? "Chave da API" : "Configurar chave"}
        </button>
      </header>

      {showSettings && (
        <div style={styles.settingsPanel}>
          <label style={styles.settingsLabel}>Chave da API do TMDB (v3 API Key ou v4 Read Access Token)</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            <input
              type="text"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Cole sua chave do TMDB aqui"
              style={styles.settingsInput}
            />
          </div>
          <label style={styles.settingsLabel}>Chave da API do OMDb (opcional — mostra prêmios e indicações)</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="text"
              value={omdbKeyInput}
              onChange={(e) => setOmdbKeyInput(e.target.value)}
              placeholder="Cole sua chave do OMDb aqui"
              style={styles.settingsInput}
            />
            <button style={styles.markBtn} onClick={saveKey}>Salvar</button>
          </div>
          <p style={styles.settingsHint}>
            As chaves ficam salvas só neste navegador. A do OMDb é opcional — sem ela, o app funciona normal, só não mostra prêmios.
          </p>
        </div>
      )}

      {!apiKey && !showSettings && (
        <div style={styles.emptyState}>
          <p style={styles.emptyStateText}>
            Para buscar filmes reais e gerar recomendações, configure sua chave gratuita da API do TMDB.
          </p>
          <button style={styles.markBtn} onClick={() => setShowSettings(true)}>Configurar agora</button>
        </div>
      )}

      {apiKey && (
        <>
          <div style={styles.tabRow}>
            <button
              style={activeTab === "descobrir" ? styles.tabActive : styles.tab}
              onClick={() => setActiveTab("descobrir")}
            >
              Descobrir
            </button>
            <button
              style={activeTab === "prateleira" ? styles.tabActive : styles.tab}
              onClick={() => setActiveTab("prateleira")}
            >
              Prateleira · {watched.length}
            </button>
          </div>

          {activeTab === "descobrir" && (
            <>
              {/* SEARCH */}
              <section style={{ marginBottom: 32 }}>
                <div style={styles.sectionLabel}><span>BUSCAR E ADICIONAR</span></div>
                <input
                  type="text"
                  placeholder="Digite o nome de um filme que você já assistiu…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={styles.searchInput}
                />
                {searching && <p style={styles.hintText}>Buscando…</p>}
                {searchError && <p style={styles.hintText}>{searchError}</p>}
                {searchResults.length > 0 && (
                  <div style={styles.searchDropdown}>
                    {searchResults.map((m) => (
                      <div
                        key={m.id}
                        className="search-item"
                        style={styles.searchItem}
                        onClick={() => addWatched(m)}
                      >
                        {m.poster_path ? (
                          <img src={`${IMG_BASE_SMALL}${m.poster_path}`} alt="" style={styles.searchPoster} />
                        ) : (
                          <div style={styles.searchPosterFallback} />
                        )}
                        <div>
                          <div style={{ fontSize: 14.5 }}>{m.title}</div>
                          <div style={styles.meta}>{(m.release_date || "").slice(0, 4) || "—"}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* RECOMMENDATIONS */}
              <section style={styles.recSection}>
                <div style={styles.recHeaderRow}>
                  <div style={styles.ratingControl}>
                    <span style={styles.sectionLabel}>NOTA MÍNIMA · ★ {minRating.toFixed(1)}</span>
                    <input
                      type="range"
                      min={MIN_RATING_FLOOR}
                      max={MIN_RATING_CEIL}
                      step={0.5}
                      value={minRating}
                      onChange={(e) => setMinRating(Number(e.target.value))}
                      style={styles.ratingSlider}
                    />
                  </div>
                  <div style={styles.providerFilterRow}>
                    {[
                      { key: "all", label: "Todos" },
                      { key: "netflix", label: "Netflix" },
                      { key: "prime", label: "Amazon Prime Video" },
                    ].map((opt) => (
                      <button
                        key={opt.key}
                        onClick={() => setProviderFilter(opt.key)}
                        style={providerFilter === opt.key ? styles.providerPillActive : styles.providerPill}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                {recLoading && <p style={styles.hintText}>Cruzando recomendações e disponibilidade de streaming… pode levar alguns segundos.</p>}
                {recError && <p style={styles.hintText}>{recError}</p>}
                {!recLoading && watched.length === 0 && (
                  <p style={styles.hintText}>Marque filmes na prateleira para ver sugestões aqui.</p>
                )}
                {!recLoading && watched.length > 0 && recommendations.length === 0 && !recError && (
                  <p style={styles.hintText}>Nenhuma recomendação com nota {minRating.toFixed(1)}+ encontrada ainda para essa combinação.</p>
                )}
                {!recLoading && recommendations.length > 0 && visibleRecommendations.length === 0 && (
                  <p style={styles.hintText}>Nenhuma recomendação bem avaliada disponível nessa plataforma no momento.</p>
                )}
                {!recLoading && providerFilter !== "all" && visibleRecommendations.length > 0 && visibleRecommendations.length < RECS_TARGET && (
                  <p style={styles.hintText}>
                    Só encontramos {visibleRecommendations.length} recomendações bem avaliadas disponíveis nessa plataforma no momento.
                  </p>
                )}
                <div style={styles.recGrid}>
                  {visibleRecommendations.map(({ movie, sources }) => {
                    const awards = awardsCache[movie.id];
                    return (
                      <div key={movie.id} style={styles.recCard} className="film-card">
                        {movie.poster_path ? (
                          <img src={`${IMG_BASE}${movie.poster_path}`} alt="" style={styles.recPoster} />
                        ) : (
                          <div style={styles.recPosterFallback} />
                        )}
                        <div style={styles.recCardBody}>
                          <h3 style={styles.recTitle}>{movie.title}</h3>
                          <p style={styles.meta}>
                            {(movie.release_date || "").slice(0, 4) || "—"}
                            {movie.vote_average ? ` · ★ ${movie.vote_average.toFixed(1)}` : ""}
                          </p>
                          <p style={styles.whyLine}>
                            Parecido com {[...sources].slice(0, 2).join(" e ")}
                            {sources.size > 2 ? ` e mais ${sources.size - 2}` : ""}.
                          </p>
                          {awards && <p style={styles.awardsBadge}>🏆 {awards}</p>}
                          <div style={styles.recCardActions}>
                            <button style={styles.markBtn} onClick={() => addWatched(movie)}>Marcar visto</button>
                            <button style={styles.dismissBtn} onClick={() => dismissRecommendation(movie)}>Não me interessa</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <p style={styles.attribution}>
                Dados via TMDB{omdbKey ? " e OMDb (prêmios)" : ""}. Disponibilidade de streaming (Brasil) via JustWatch, através da TMDB.
                Este produto usa a API do TMDB mas não é endossado ou certificado por eles.
              </p>
            </>
          )}

          {activeTab === "prateleira" && (
            <section style={{ marginBottom: 36 }}>
              <div style={styles.sectionLabel}>
                <span>PRATELEIRA · {watched.length} {watched.length === 1 ? "filme visto" : "filmes vistos"}</span>
              </div>
              {watched.length === 0 ? (
                <div style={styles.emptyShelf}>Vá até a aba "Descobrir" e marque pelo menos um filme para começar.</div>
              ) : (
                <div style={styles.shelfGrid}>
                  {watched.map((f) => (
                    <div key={f.id} style={styles.shelfCard}>
                      {f.poster_path ? (
                        <img src={`${IMG_BASE_SMALL}${f.poster_path}`} alt="" style={styles.shelfCardPoster} />
                      ) : (
                        <div style={styles.shelfCardPosterFallback} />
                      )}
                      <div style={styles.shelfCardBody}>
                        <span style={styles.shelfChipTitle}>{f.title}</span>
                        {f.year && <span style={styles.meta}>{f.year}</span>}
                      </div>
                      <button aria-label={`Remover ${f.title}`} onClick={() => removeWatched(f)} style={styles.shelfChipRemove}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {toast && <div style={styles.toast}>{toast}</div>}
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#1B1714",
    color: "#EDE6D6",
    fontFamily: "'Fraunces', Georgia, serif",
    padding: "28px 20px 60px",
    maxWidth: 980,
    margin: "0 auto",
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 24,
    borderBottom: "1px solid #3A322C",
    paddingBottom: 24,
    flexWrap: "wrap",
  },
  reelMark: { fontSize: 34, color: "#D4A017", lineHeight: 1, marginTop: 4 },
  h1: { fontSize: 28, fontWeight: 600, margin: 0, letterSpacing: "-0.01em" },
  subhead: { margin: "6px 0 0", color: "#B3A99B", fontSize: 14.5, fontFamily: "Georgia, serif", fontStyle: "italic" },
  settingsBtn: {
    background: "transparent",
    border: "1px solid #4A4038",
    color: "#B3A99B",
    borderRadius: 4,
    padding: "8px 12px",
    fontSize: 12.5,
    fontFamily: "'Space Mono', monospace",
    height: "fit-content",
  },
  settingsPanel: {
    background: "#241E19",
    border: "1px solid #4A4038",
    borderRadius: 6,
    padding: "16px 18px",
    marginBottom: 28,
  },
  settingsLabel: { display: "block", fontSize: 12.5, color: "#B3A99B", marginBottom: 8, fontFamily: "'Space Mono', monospace" },
  settingsInput: {
    flex: "1 1 220px",
    background: "#1B1714",
    border: "1px solid #4A4038",
    borderRadius: 4,
    padding: "9px 12px",
    color: "#EDE6D6",
    fontSize: 14,
  },
  settingsHint: { fontSize: 12.5, color: "#8A8078", marginTop: 10, marginBottom: 0, lineHeight: 1.5 },
  emptyState: {
    border: "1px dashed #4A4038",
    borderRadius: 6,
    padding: "24px 20px",
    marginBottom: 28,
    textAlign: "center",
  },
  emptyStateText: { color: "#B3A99B", fontSize: 14.5, marginBottom: 14 },
  errorBanner: {
    background: "#2E1F1B",
    border: "1px solid #6B3A2E",
    color: "#E0B5A3",
    borderRadius: 4,
    padding: "12px 16px",
    fontSize: 13.5,
    marginBottom: 24,
  },
  sectionLabel: { fontFamily: "'Space Mono', monospace", fontSize: 11, letterSpacing: "0.08em", color: "#8A8078", marginBottom: 14 },
  tabRow: { display: "flex", gap: 4, marginBottom: 28, borderBottom: "1px solid #3A322C" },
  tab: {
    background: "transparent", border: "none", borderBottom: "2px solid transparent",
    color: "#8A8078", padding: "10px 4px", marginRight: 20, fontSize: 14.5,
    fontFamily: "'Fraunces', Georgia, serif",
  },
  tabActive: {
    background: "transparent", border: "none", borderBottom: "2px solid #D4A017",
    color: "#EDE6D6", padding: "10px 4px", marginRight: 20, fontSize: 14.5,
    fontFamily: "'Fraunces', Georgia, serif", fontWeight: 600,
  },
  searchInput: {
    width: "100%",
    background: "#241E19",
    border: "1px solid #4A4038",
    borderRadius: 4,
    padding: "10px 12px",
    color: "#EDE6D6",
    fontSize: 14.5,
  },
  hintText: { fontSize: 13, color: "#8A8078", marginTop: 8 },
  searchDropdown: {
    marginTop: 8,
    border: "1px solid #3A322C",
    borderRadius: 4,
    overflow: "hidden",
  },
  searchItem: { display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", cursor: "pointer" },
  searchPoster: { width: 32, height: 48, objectFit: "cover", borderRadius: 2, flexShrink: 0 },
  searchPosterFallback: { width: 32, height: 48, background: "#3A322C", borderRadius: 2, flexShrink: 0 },
  emptyShelf: { border: "1px dashed #4A4038", borderRadius: 4, padding: "18px 20px", color: "#8A8078", fontSize: 14 },
  shelfRow: { display: "flex", flexWrap: "wrap", gap: 8 },
  shelfGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 },
  shelfCard: {
    display: "flex", alignItems: "center", gap: 10,
    background: "#241E19", border: "1px solid #3A322C", borderRadius: 4, padding: 10,
  },
  shelfCardPoster: { width: 40, height: 58, objectFit: "cover", borderRadius: 2, flexShrink: 0 },
  shelfCardPosterFallback: { width: 40, height: 58, background: "#3A322C", borderRadius: 2, flexShrink: 0 },
  shelfCardBody: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 },
  shelfChip: {
    display: "flex", alignItems: "center", gap: 8,
    background: "#2A241F", border: "1px solid #4A4038", borderRadius: 999,
    padding: "6px 10px 6px 6px",
  },
  shelfPoster: { width: 22, height: 32, objectFit: "cover", borderRadius: 2 },
  shelfChipTitle: { fontSize: 13.5 },
  shelfChipRemove: { background: "none", border: "none", color: "#B3A99B", fontSize: 18, width: 22, height: 22, borderRadius: "50%", lineHeight: 1 },
  recSection: { marginBottom: 24, background: "#241E19", border: "1px solid #3A322C", borderRadius: 6, padding: "22px 20px" },
  recHeaderRow: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 14, marginBottom: 18 },
  ratingControl: { display: "flex", alignItems: "center", gap: 10 },
  ratingSlider: { width: 120, accentColor: "#D4A017" },
  providerFilterRow: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  providerPill: {
    background: "transparent", border: "1px solid #4A4038", color: "#B3A99B",
    borderRadius: 999, padding: "4px 10px", fontSize: 12, fontFamily: "'Space Mono', monospace",
  },
  providerPillActive: {
    background: "#3E6259", border: "1px solid #3E6259", color: "#EDE6D6",
    borderRadius: 999, padding: "4px 10px", fontSize: 12, fontFamily: "'Space Mono', monospace",
  },
  awardsBadge: {
    fontSize: 11.5, color: "#D4A017", fontFamily: "Georgia, serif", fontStyle: "italic", margin: "0 0 8px", lineHeight: 1.4,
  },
  recCardActions: { display: "flex", gap: 8, flexWrap: "wrap" },
  dismissBtn: {
    background: "transparent", border: "1px solid #4A4038", color: "#8A8078",
    borderRadius: 3, padding: "6px 10px", fontSize: 12, fontFamily: "'Space Mono', monospace",
  },
  recGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 },
  recCard: { display: "flex", gap: 12, background: "#1B1714", border: "1px solid #4A4038", borderRadius: 4, padding: 12 },
  recPoster: { width: 64, height: 96, objectFit: "cover", borderRadius: 3, flexShrink: 0 },
  recPosterFallback: { width: 64, height: 96, background: "#3A322C", borderRadius: 3, flexShrink: 0 },
  recCardBody: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  recTitle: { fontSize: 15.5, margin: 0, fontWeight: 600, lineHeight: 1.25 },
  meta: { fontSize: 12.5, color: "#8A8078", margin: 0, fontFamily: "Georgia, serif" },
  whyLine: { fontSize: 12.5, color: "#B3A99B", fontFamily: "Georgia, serif", lineHeight: 1.4, margin: "2px 0 6px" },
  markBtn: {
    background: "#D4A017", color: "#1B1714", border: "none", borderRadius: 3,
    padding: "6px 10px", fontSize: 12, fontFamily: "'Space Mono', monospace", fontWeight: 700, alignSelf: "flex-start",
  },
  attribution: { fontSize: 11, color: "#6B6259", textAlign: "center", marginTop: 8 },
  toast: {
    position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)",
    background: "#D4A017", color: "#1B1714", padding: "9px 18px", borderRadius: 999,
    fontSize: 13, fontFamily: "'Space Mono', monospace", fontWeight: 700, boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
  },
};
