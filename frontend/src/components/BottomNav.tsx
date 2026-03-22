"use client";

interface BottomNavProps {
  currentPeriod: string;
  setPeriod: (p: string) => void;
}

export default function BottomNav({ currentPeriod, setPeriod }: BottomNavProps) {
  const periods = [
    { id: '7day', label: '7D' },
    { id: '1month', label: '30D' },
    { id: '12month', label: '1Y' },
    { id: 'overall', label: 'ALL' }
  ];

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 md:hidden animate-in slide-in-from-bottom duration-500">
      {/* Background with 80% Opacity #050505 and Emerald Top Border */}
      <div className="bg-[#050505]/80 backdrop-blur-xl border-t border-emerald-500/30 px-6 py-6 pb-10 shadow-[0_-10px_30px_rgba(0,0,0,0.5)]">
        <div className="flex justify-between items-center gap-2">
          {periods.map(p => (
            <button
              key={p.id}
              onClick={() => setPeriod(p.id)}
              className={`flex-1 py-3 px-2 rounded-xl text-[10px] font-bold tracking-[0.2em] transition-all duration-300 uppercase
                ${currentPeriod === p.id 
                  ? 'bg-emerald-500 text-black shadow-[0_0_20px_rgba(16,185,129,0.5)] scale-105' 
                  : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60'
                }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
