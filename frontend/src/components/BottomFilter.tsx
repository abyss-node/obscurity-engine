"use client";

import { motion, AnimatePresence } from "framer-motion";

interface BottomFilterProps {
  isOpen: boolean;
  onClose: () => void;
  currentPeriod: string;
  setPeriod: (val: string) => void;
}

export default function BottomFilter({ isOpen, onClose, currentPeriod, setPeriod }: BottomFilterProps) {
  const periods = [
    { id: '7day', label: '7D' },
    { id: '1month', label: '30D' },
    { id: '12month', label: '1Y' },
    { id: 'overall', label: 'ALL' }
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* SCRIM (Backdrop) */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-neutral-900/60 backdrop-blur-sm z-[90]"
          />

          {/* BOTTOM SHEET DRAWER */}
          <motion.div 
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed bottom-0 left-0 right-0 bg-white rounded-t-[3rem] z-[100] shadow-[0_-20px_80px_rgba(0,0,0,0.15)] flex flex-col p-10 md:p-14 border-t border-neutral-100"
          >
             {/* Handle Pill */}
             <div className="w-12 h-1 bg-neutral-100 rounded-full mx-auto mb-12" />

             <h4 className="text-[10px] uppercase tracking-[0.4em] text-neutral-300 font-bold mb-10 text-center">Temporal Horizon</h4>

             <div className="grid grid-cols-2 gap-6 w-full mb-12 lg:grid-cols-4">
                {periods.map(p => (
                   <button 
                     key={p.id}
                     onClick={() => { setPeriod(p.id); onClose(); }}
                     className={`flex flex-col items-center gap-3 py-6 px-4 rounded-3xl border transition-all duration-700 
                        ${currentPeriod === p.id 
                            ? 'bg-neutral-900 text-white border-black shadow-xl scale-105' 
                            : 'bg-white text-neutral-400 border-neutral-50 hover:border-neutral-200'}`}
                   >
                      <span className="text-xl font-serif italic">{p.label}</span>
                      <span className="text-[8px] uppercase tracking-widest font-bold opacity-60">Discovery Depth</span>
                   </button>
                ))}
             </div>

             <button 
               onClick={onClose}
               className="w-full py-5 text-[10px] tracking-[0.3em] font-bold text-neutral-400 uppercase border border-neutral-100 rounded-2xl bg-neutral-50 hover:bg-neutral-100 transition-colors"
             >
                Close Filters
             </button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
