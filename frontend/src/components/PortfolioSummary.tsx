import { GenreWeight } from "../app/page";

interface PortfolioSummaryProps {
  genres: GenreWeight[];
  seedsAnalyzed: number;
  totalPool: number;
  deepestDate?: string;
}

export default function PortfolioSummary({ genres, seedsAnalyzed, totalPool, deepestDate }: PortfolioSummaryProps) {
  if (genres.length === 0) return null;

  return (
    <div className="w-full bg-white/[0.02] border border-white/10 rounded-xl p-6 backdrop-blur-xl shadow-2xl flex flex-col md:flex-row gap-6 lg:gap-12 relative overflow-hidden mt-2">
      <div className="absolute top-0 left-0 w-1 h-full bg-[#10b981]/50 rounded-l-xl blur-[2px]" />

      <div className="flex flex-col gap-2 min-w-[220px] lg:border-r border-white/5 pr-6">
        <h3 className="text-[10px] uppercase tracking-widest text-[#10b981] font-bold mb-2 flex items-center gap-2">
          &gt; SCAN_INFO <span className="w-1.5 h-1.5 bg-[#10b981] rounded-full animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.8)]" />
        </h3>
        <div className="text-[11px] font-mono text-white/50 space-y-2">
          <div className="flex justify-between">
            <span>SEEDS_ANALYZED:</span>
            <span className="text-white font-bold ml-4">[{seedsAnalyzed}]</span>
          </div>
          <div className="flex justify-between">
            <span>ACTIVE_FILTER:</span>
            <span className="text-white font-bold ml-4">&lt;25K Lstnrs</span>
          </div>
          <div className="flex justify-between">
            <span>DISCOVERY_POOL:</span>
            <span className="text-white font-bold ml-4">[{totalPool}]</span>
          </div>
          {deepestDate && (
            <div className="flex justify-between border-t border-white/5 pt-2 mt-2">
              <span className="text-[#10b981]">TIME_DEPTH:</span>
              <span className="text-white font-bold ml-4" title={deepestDate}>{deepestDate.split(',')[0]}</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col justify-center gap-5">
        <div className="flex flex-wrap justify-between gap-y-5 gap-x-8">
          {genres.map(genre => (
            <div key={genre.name} className="flex flex-col min-w-[140px] flex-1">
              <div className="flex justify-between items-end mb-2">
                <span className="text-[11px] font-mono text-white/80 uppercase tracking-widest truncate mr-2 font-bold" title={genre.name}>
                  {genre.name}
                </span>
                <span className="text-[10px] font-mono text-[#10b981] font-bold tracking-wider">
                  {genre.weight.toFixed(1)}%
                </span>
              </div>
              <div className="w-full h-[2px] bg-white/5 rounded-full overflow-hidden shadow-inner flex">
                <div 
                  className="h-full bg-[#10b981] rounded-full shadow-[0_0_8px_rgba(16,185,129,0.8)]" 
                  style={{ width: `${genre.weight}%` }} 
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
