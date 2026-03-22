"use client";

import { useState, useEffect, useMemo } from "react";
import IcebergVisual from "../components/IcebergVisual";
import PortfolioSummary from "../components/PortfolioSummary";

export type Artist = {
  name: string;
  stickiness_score: number;
  conviction_score: number;
  composite_score: number;
  total_listeners: number;
  top_tags: string[];
  source_seeds: { name: string; percentile: number; }[];
};

export type GenreWeight = {
  name: string;
  weight: number;
};

export type DiscoveryData = {
  artists: Artist[];
  top_genres: GenreWeight[];
  deepest_date?: string;
  active_seed_count?: number;
};

type SortType = "composite" | "conviction" | "stickiness" | "listeners";

export default function Home() {
  const defaultUsername = process.env.NEXT_PUBLIC_LASTFM_USERNAME || "Arnuv_J";
  const [username, setUsername] = useState(defaultUsername);
  const [inputLocal, setInputLocal] = useState(defaultUsername);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [topGenres, setTopGenres] = useState<GenreWeight[]>([]);
  const [deepestDate, setDeepestDate] = useState<string | undefined>(undefined);
  const [activeSeedCount, setActiveSeedCount] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [wakingUp, setWakingUp] = useState(false);
  const [sortBy, setSortBy] = useState<SortType>("composite");

  const topMomentumSeeds = useMemo(() => {
    if (artists.length === 0) return [];
    const seedMap = new Map<string, number>();
    artists.forEach(a => {
      a.source_seeds?.forEach(seed => {
        if (!seedMap.has(seed.name) || seed.percentile > seedMap.get(seed.name)!) {
          seedMap.set(seed.name, seed.percentile);
        }
      });
    });
    return Array.from(seedMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(entry => ({ name: entry[0], percentile: entry[1] }));
  }, [artists]);

  const totalUniqueSeeds = useMemo(() => {
    const s = new Set<string>();
    artists.forEach(a => a.source_seeds?.forEach(seed => s.add(seed.name)));
    return s.size;
  }, [artists]);

  const stickinessThreshold = useMemo(() => {
    if (artists.length < 1) return Infinity;
    const scores = artists.map(a => a.stickiness_score).sort((a, b) => b - a);
    const thresholdIndex = Math.max(0, Math.floor(scores.length * 0.1) - 1);
    return scores[thresholdIndex] || Infinity;
  }, [artists]);

  const sortedArtists = useMemo(() => {
    const arr = [...artists];
    if (sortBy === "composite") arr.sort((a, b) => b.composite_score - a.composite_score);
    else if (sortBy === "conviction") arr.sort((a, b) => b.conviction_score - a.conviction_score);
    else if (sortBy === "stickiness") arr.sort((a, b) => b.stickiness_score - a.stickiness_score);
    else if (sortBy === "listeners") arr.sort((a, b) => b.total_listeners - a.total_listeners);
    return arr;
  }, [artists, sortBy]);

  useEffect(() => {
    const fetchArtists = async () => {
      if (!inputLocal.trim()) return;
      setUsername(inputLocal);
      setLoading(true);
      setArtists([]);
      setTopGenres([]);
      setDeepestDate(undefined);
      setActiveSeedCount(0);
      setWakingUp(false);

      const wakeupTimer = setTimeout(() => {
        setWakingUp(true);
      }, 20000); // Wait 20 seconds to bypass organic Last.fm paginations before assuming cold start

      try {
        const apiUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
        const response = await fetch(`${apiUrl}/api/discovery?username=${inputLocal}&period=overall`);
        if (response.ok) {
          const data: DiscoveryData = await response.json();
          setArtists(data.artists || []);
          setTopGenres(data.top_genres || []);
          setDeepestDate(data.deepest_date);
          setActiveSeedCount(data.active_seed_count || 0);
        } else {
          console.error("Failed to fetch artists:", response.statusText);
          setArtists([]);
          setTopGenres([]);
        }
      } catch (e) {
        console.error("Error fetching data:", e);
        setArtists([]);
        setTopGenres([]);
      } finally {
        clearTimeout(wakeupTimer);
        setWakingUp(false);
        setLoading(false);
      }
    };
    fetchArtists();
  }, [username]);

  return (
    <div className="flex flex-col gap-8 w-full max-w-6xl mx-auto p-4 md:p-8 animate-in fade-in duration-1000 min-h-screen">
      {/* Header & Search Area */}
      <div className="flex flex-col md:flex-row justify-between items-end border-b border-white/10 pb-6 gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-4xl font-extrabold tracking-tight bg-gradient-to-br from-white to-white/40 bg-clip-text text-transparent">
            Obscurity Engine
          </h1>
          <p className="text-xs text-white/40 tracking-widest uppercase font-semibold">
            Sonic Depth Analysis & Underground Metrics
          </p>
        </div>

        <div className="flex flex-col md:flex-row items-center gap-4 w-full md:w-auto">
          <form 
            onSubmit={(e) => { e.preventDefault(); setUsername(inputLocal); }}
            className="flex relative group shadow-xl"
          >
            <input 
              type="text" 
              value={inputLocal}
              onChange={(e) => setInputLocal(e.target.value)}
              placeholder="Last.fm Username"
              className="bg-white/5 border border-white/10 text-white px-5 py-2.5 rounded-l-xl text-sm outline-none w-56 focus:bg-white/10 focus:border-white/20 transition-all backdrop-blur-md"
            />
            <button type="submit" className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white px-6 py-2.5 text-sm font-semibold rounded-r-xl transition-all shadow-[0_0_20px_rgba(37,99,235,0.4)]">
              Scan
            </button>
          </form>
          
        </div>
      </div>

      {/* EXECUTIVE PORTFOLIO SUMMARY */}
      {!loading && topGenres.length > 0 && (
        <PortfolioSummary 
          genres={topGenres} 
          seedsAnalyzed={activeSeedCount || totalUniqueSeeds} 
          totalPool={artists.length} 
          deepestDate={deepestDate}
        />
      )}

      {/* SEEDS USED MATRIX */}
      {topMomentumSeeds.length > 0 && !loading && (
        <div className="w-full bg-white/[0.02] border border-white/10 rounded-xl p-5 backdrop-blur-xl shadow-lg relative overflow-hidden mt-6">
          <div className="absolute top-0 left-0 w-1 h-full bg-[#10b981]/80 rounded-l-xl shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
          <h3 className="text-[11px] uppercase tracking-[0.2em] text-[#10b981] mb-4 font-bold flex items-center gap-3">
             Top 5 Momentum Seeds
            <div className="h-[1px] flex-1 bg-gradient-to-r from-[#10b981]/20 to-transparent" />
          </h3>
          <div className="flex flex-wrap gap-3">
            {topMomentumSeeds.map(seed => (
              <span 
                key={seed.name} 
                className="bg-white/5 border border-white/10 px-3 py-1.5 rounded-lg text-[10px] text-white/70 font-mono tracking-wider hover:bg-white/10 hover:text-white transition-colors cursor-default shadow-inner flex gap-2 items-center"
              >
                {seed.name} 
                <span className="text-[#10b981]">{seed.percentile.toFixed(2)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Main Glassmorphic Table Panel */}
      <div className="w-full bg-white/[0.02] border border-white/10 rounded-2xl overflow-hidden backdrop-blur-2xl shadow-2xl relative">
        <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/5 text-[10px] uppercase tracking-widest text-white/30 bg-white/[0.01]">
                <th className="p-5 font-semibold w-16 text-center">Rnk</th>
                <th className="p-5 font-semibold">Artist & Sources</th>
                <th 
                  className={`p-5 font-semibold text-center w-32 cursor-pointer hover:text-white transition-colors duration-300 ${sortBy === 'composite' ? 'text-purple-400' : ''}`}
                  onClick={() => setSortBy('composite')}
                >
                  <div className="flex items-center justify-center gap-1">
                    Composite Grid {sortBy === 'composite' && <span className="text-[8px]">▼</span>}
                  </div>
                </th>
                <th 
                  className={`p-5 font-semibold text-center w-32 cursor-pointer hover:text-white transition-colors duration-300 ${sortBy === 'conviction' ? 'text-[#10b981]' : ''}`}
                  onClick={() => setSortBy('conviction')}
                >
                  <div className="flex items-center justify-center gap-1">
                    Percentile Weight {sortBy === 'conviction' && <span className="text-[8px]">▼</span>}
                  </div>
                </th>
                <th 
                  className={`p-5 font-semibold text-right w-40 cursor-pointer hover:text-white transition-colors duration-300 ${sortBy === 'stickiness' ? 'text-emerald-400' : ''}`}
                  onClick={() => setSortBy('stickiness')}
                >
                  <div className="flex items-center justify-end gap-1">
                    Stickiness {sortBy === 'stickiness' && <span className="text-[8px]">▼</span>}
                  </div>
                </th>
                <th 
                  className={`p-5 font-semibold text-right w-32 cursor-pointer hover:text-white transition-colors duration-300 ${sortBy === 'listeners' ? 'text-blue-400' : ''}`}
                  onClick={() => setSortBy('listeners')}
                >
                  <div className="flex items-center justify-end gap-1">
                    Listeners {sortBy === 'listeners' && <span className="text-[8px]">▼</span>}
                  </div>
                </th>
                <th className="p-5 font-semibold text-center w-20">Audit</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {loading ? (
                <tr>
                  <td colSpan={7} className="p-16 text-center flex-col gap-4 text-white/40 tracking-widest font-mono text-xs animate-pulse">
                    <div>{wakingUp ? "WAKING_UP_THE_ENGINE..." : "SCANNING_THE_ABYSS..."}</div>
                    {wakingUp && (
                      <div className="mt-4 text-[10px] text-white/30 lowercase font-sans tracking-normal max-w-sm mx-auto animate-in fade-in duration-500">
                        (the free-tier backend is spinning up and will be ready shortly)
                      </div>
                    )}
                  </td>
                </tr>
              ) : sortedArtists.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-16 text-center text-white/30 tracking-widest font-mono text-xs">
                    NO_ACOUSTIC_SIGNATURES_FOUND.
                  </td>
                </tr>
              ) : (
                sortedArtists.map((artist, idx) => {
                  const isHighConviction = artist.conviction_score >= 250;
                  const rowGlow = isHighConviction 
                    ? "bg-emerald-500/[0.03] hover:bg-emerald-500/[0.06] border-emerald-500/10" 
                    : "hover:bg-white/[0.04] border-white/5";

                  return (
                    <tr 
                      key={idx} 
                      className={`relative border-b last:border-0 transition-colors group cursor-default ${rowGlow}`}
                    >
                      <td className="p-0 text-center w-16 relative">
                        <div className={`absolute left-0 top-0 bottom-0 w-1 ${isHighConviction ? 'bg-[#10b981] shadow-[0_0_10px_rgba(16,185,129,1)]' : 'bg-white/5'}`} />
                        <div className="py-5 text-white/20 font-mono text-xs">
                          {(idx + 1).toString().padStart(2, '0')}
                        </div>
                      </td>
                      <td className="p-5 font-semibold text-white/80 transition-colors">
                        <div className="flex flex-col gap-1.5 justify-center">
                          <div className="flex items-center gap-2">
                            <span className="text-[14px] group-hover:text-white transition-colors">{artist.name}</span>
                            <div className="flex gap-1">
                              {artist.top_tags?.slice(0, 3).map(tag => (
                                <span key={tag} className="bg-white/5 border border-white/10 px-1.5 py-0.5 rounded text-[9px] font-mono tracking-wider text-white/40 uppercase">
                                  {tag}
                                </span>
                              ))}
                            </div>
                          </div>
                          {artist.source_seeds && artist.source_seeds.length > 0 && (
                            <span className="text-[10px] text-white/30 font-medium tracking-wide">
                              Sources: {artist.source_seeds.slice(0, 3).map(s => `${s.name} (${s.percentile.toFixed(2)})`).join(', ')}{artist.source_seeds.length > 3 ? '...' : ''}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-5 text-center">
                        <span className={`bg-purple-500/10 ${sortBy === 'composite' ? 'text-purple-400 border-purple-500/50 shadow-[0_0_15px_rgba(168,85,247,0.3)]' : 'text-purple-400/70 border-purple-500/20 shadow-[0_0_10px_rgba(168,85,247,0.1)]'} px-2 py-1 rounded text-xs font-bold font-mono transition-colors`}>
                          {(artist.composite_score / 100).toFixed(2)}
                        </span>
                      </td>
                      <td className="p-5 text-center">
                        <span className={`bg-[#10b981]/10 ${artist.conviction_score >= 250 ? 'text-[#10b981] border-[#10b981]/50 shadow-[0_0_15px_rgba(16,185,129,0.3)]' : 'text-[#10b981]/70 border-[#10b981]/20 shadow-[0_0_10px_rgba(16,185,129,0.1)]'} px-2 py-1 rounded text-xs font-bold font-mono transition-colors`}>
                          {(artist.conviction_score / 100).toFixed(2)}
                        </span>
                      </td>
                      <td className="p-5 text-right">
                        {artist.stickiness_score >= stickinessThreshold ? (
                          <span className="bg-[#10b981]/15 text-[#10b981] border border-[#10b981]/40 px-3 py-1.5 rounded-full text-[12px] font-mono font-bold shadow-[0_0_15px_rgba(16,185,129,0.3)] animate-pulse group-hover:border-[#10b981]/70 transition-colors inline-block min-w-[70px] text-center">
                             ★ {artist.stickiness_score.toFixed(2)}
                          </span>
                        ) : (
                          <span className="bg-blue-500/10 text-blue-300 border border-blue-500/20 px-3 py-1.5 rounded-full text-xs font-mono font-medium shadow-[0_0_15px_rgba(59,130,246,0.15)] group-hover:border-blue-400/50 transition-colors inline-block min-w-[70px] text-center">
                            {artist.stickiness_score.toFixed(2)}
                          </span>
                        )}
                      </td>
                      <td className="p-5 text-right text-white/30 font-mono text-xs tabular-nums group-hover:text-white/50 transition-colors">
                        {artist.total_listeners.toLocaleString()}
                      </td>
                      <td className="p-5 text-center">
                        <a 
                          href={`https://music.youtube.com/search?q=${encodeURIComponent(artist.name)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center w-7 h-7 rounded border border-white/5 text-white/20 font-bold font-mono tracking-widest hover:text-[#10b981] hover:bg-[#10b981]/10 hover:border-[#10b981]/30 hover:shadow-[0_0_15px_rgba(16,185,129,0.3)] transition-all bg-white/[0.02]"
                          title={`Audit ${artist.name}`}
                        >
                          &gt;
                        </a>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ICEBERG COMPONENT WRAPPER */}
      <div className="mt-2 bg-white/[0.02] border border-white/10 rounded-2xl p-6 backdrop-blur-2xl shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/10 rounded-full blur-[100px]" />
        <h2 className="text-xs tracking-widest text-indigo-300 mb-6 uppercase opacity-90 flex items-center gap-4 relative z-10">
          <span className="font-bold">Depth Analysis Visualizer</span>
          <div className="flex-1 h-[1px] bg-gradient-to-r from-indigo-500/30 to-transparent" />
        </h2>
        <div className="rounded-xl overflow-hidden shadow-inner border border-white/5 relative z-10">
          <IcebergVisual artists={artists} />
        </div>
      </div>
    </div>
  );
}
