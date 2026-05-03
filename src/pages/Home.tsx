import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Sparkles, Star, ArrowRight, ShieldCheck, Image as ImageIcon, Crown, MoveHorizontal } from "lucide-react";

export default function Home() {
  const [sliderPos, setSliderPos] = useState(50);

  return (
    <div className="min-h-screen pb-32 bg-[#0a0a0a] text-white font-sans selection:bg-purple-500/30">
      <header className="fixed top-0 w-full z-50 bg-black/40 backdrop-blur-xl border-b border-white/5 flex justify-between items-center px-6 h-16">
        <div className="flex items-center gap-2">
          <Sparkles className="text-[#d8b4fe] w-5 h-5" />
          <span className="text-lg font-medium tracking-wide text-white">MyAURA</span>
        </div>
      </header>
      
      <main className="pt-24 px-5 max-w-md mx-auto">
        <section className="relative group mb-10">
          <div className="aspect-[4/5] w-full relative overflow-hidden rounded-2xl bg-[#141414] border border-white/10 shadow-2xl shadow-purple-900/20">
            {/* After Image */}
            <div className="absolute inset-0 w-full h-full bg-cover bg-center" style={{ backgroundImage: "url('https://images.unsplash.com/photo-1534528741775-53994a69daeb?q=80&w=1000&auto=format&fit=crop')" }}></div>
            
            {/* Before Image (Clipped) */}
            <div className="absolute inset-0 w-full h-full bg-cover bg-center" style={{ backgroundImage: "url('https://images.unsplash.com/photo-1544005313-94ddf0286df2?q=80&w=1000&auto=format&fit=crop')", clipPath: `inset(0 ${100 - sliderPos}% 0 0)` }}>
              <div className="absolute inset-0 w-full h-full bg-black/20"></div>
            </div>

            {/* Slider Handle & Line */}
            <div className="absolute top-0 bottom-0 w-0.5 bg-white/80 shadow-[0_0_10px_rgba(0,0,0,0.5)] z-10 pointer-events-none" style={{ left: `${sliderPos}%`, transform: 'translateX(-50%)' }}>
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center border border-gray-200">
                <MoveHorizontal className="w-4 h-4 text-gray-600" />
              </div>
            </div>

            {/* Invisible Range Input for Interaction */}
            <input 
              type="range" 
              min="0" max="100" 
              value={sliderPos} 
              onChange={(e) => setSliderPos(Number(e.target.value))}
              className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize z-20"
            />

            <div className="absolute bottom-4 left-4 flex gap-2 pointer-events-none z-10">
              <span className="px-3 py-1.5 bg-black/60 backdrop-blur-md rounded-full text-[10px] tracking-widest uppercase font-semibold text-white/80 border border-white/10">До</span>
            </div>
            <div className="absolute bottom-4 right-4 flex gap-2 pointer-events-none z-10">
              <span className="px-3 py-1.5 bg-[#d8b4fe]/90 backdrop-blur-md rounded-full text-[10px] tracking-widest uppercase font-semibold text-black shadow-lg shadow-purple-500/30">После</span>
            </div>
          </div>
        </section>

        <section className="mb-10 space-y-5 text-center">
          <h1 className="text-4xl font-light tracking-tight leading-[1.15] text-white">
            Твои премиальные фото <br />
            <span className="font-medium bg-gradient-to-r from-[#e9d5ff] to-[#c084fc] bg-clip-text text-transparent">с AI-фотостудией</span>
          </h1>
          <p className="text-white/60 text-[15px] leading-relaxed max-w-[320px] mx-auto font-light">
            Загрузи селфи и получи реалистичные портреты в студийном стиле — с сохранением лица, дорогим светом и премиальной подачей.
          </p>
        </section>

        <section className="space-y-4 mb-12">
          <Link to="/premium" className="w-full h-14 bg-gradient-to-r from-[#c084fc] to-[#a855f7] rounded-2xl text-white font-medium text-[15px] flex items-center justify-center gap-2 shadow-[0_0_30px_rgba(168,85,247,0.3)] hover:shadow-[0_0_40px_rgba(168,85,247,0.4)] transition-all active:scale-[0.98]">
            <Crown className="w-4 h-4 text-white/90" />
            <span>Создать Premium HD</span>
            <ArrowRight className="w-4 h-4 text-white/70 ml-1" />
          </Link>

          <Link to="/upload" className="w-full h-14 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl text-white font-medium text-[15px] flex items-center justify-center gap-2 transition-all active:scale-[0.98]">
            <span>Попробовать бесплатно</span>
          </Link>
        </section>

        <section className="flex flex-col gap-3 mb-16">
          <div className="flex items-center gap-4 px-5 py-4 rounded-2xl bg-white/[0.05] border border-white/10">
            <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center shrink-0">
              <ImageIcon className="text-[#e9d5ff] w-5 h-5" />
            </div>
            <div className="flex flex-col">
              <span className="text-[14px] font-medium text-white">1 бесплатный preview</span>
              <span className="text-[12px] text-white/60">Оцени качество до оплаты</span>
            </div>
          </div>
          
          <div className="flex items-center gap-4 px-5 py-4 rounded-2xl bg-white/[0.05] border border-white/10">
            <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center shrink-0">
              <ShieldCheck className="text-[#e9d5ff] w-5 h-5" />
            </div>
            <div className="flex flex-col">
              <span className="text-[14px] font-medium text-white">Реалистичный likeness</span>
              <span className="text-[12px] text-white/60">Максимальное сходство с оригиналом</span>
            </div>
          </div>
          
          <div className="flex items-center gap-4 px-5 py-4 rounded-2xl bg-white/[0.05] border border-white/10">
            <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center shrink-0">
              <Star className="text-[#e9d5ff] w-5 h-5" />
            </div>
            <div className="flex flex-col">
              <span className="text-[14px] font-medium text-white">HD для premium</span>
              <span className="text-[12px] text-white/60">Высокое разрешение и детализация</span>
            </div>
          </div>
        </section>
        
        <div className="text-center text-[11px] text-white/40 mt-8 flex items-center justify-center gap-3">
          <Link to="/privacy" className="hover:text-white/70 transition-colors">Политика конфиденциальности</Link>
          <span className="w-1 h-1 rounded-full bg-white/20"></span>
          <Link to="/terms" className="hover:text-white/70 transition-colors">Условия использования</Link>
          <span className="w-1 h-1 rounded-full bg-white/20"></span>
          <span>V2.0</span>
        </div>
      </main>
    </div>
  );
}
