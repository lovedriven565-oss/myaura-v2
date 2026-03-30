import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Camera, X, Sparkles, Star, Check, Crown, Image as ImageIcon, ShieldCheck, ArrowRight } from "lucide-react";

const PREMIUM_STYLES = [
  { id: "business", name: "Бизнес-портрет", desc: "Строгий и дорогой корпоративный стиль" },
  { id: "lifestyle", name: "Премиум lifestyle", desc: "Естественный свет, дорогие интерьеры" },
  { id: "cinematic", name: "Кинематографичный", desc: "Глубокие тени, киношная цветокоррекция" },
  { id: "editorial", name: "Studio Editorial", desc: "Журнальная обложка, fashion-свет" },
  { id: "luxury", name: "Luxury", desc: "Эстетика old money, вечерние образы" },
  { id: "aura", name: "Aura", desc: "Фирменный стиль с мягким свечением" }
];

const PACKAGES = [
  { id: "starter", name: "Starter", photos: "5 HD фото", styles: "1 стиль", recommended: false },
  { id: "signature", name: "Signature", photos: "10 HD фото", styles: "2–3 стиля", recommended: true },
  { id: "premium", name: "Premium", photos: "15 HD фото", styles: "Максимальная вариативность", recommended: false }
];

export default function UploadPremium() {
  const [files, setFiles] = useState<File[]>([]);
  const [selectedStyle, setSelectedStyle] = useState("business");
  const [selectedPackage, setSelectedPackage] = useState("signature");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const navigate = useNavigate();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const newFiles = Array.from(e.target.files);
      setFiles(prev => [...prev, ...newFiles].slice(0, 15)); // Max 15 files
      setError("");
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handlePaymentAndUpload = async () => {
    if (files.length < 10) { // Enforce 10-15 images for premium quality
      setError("Пожалуйста, загрузите от 10 до 15 фото для достижения высокого качества");
      return;
    }
    if (!agreed) {
      setError("Необходимо согласие с условиями");
      return;
    }

    setShowPayment(true);
  };

  const confirmPayment = async () => {
    setLoading(true);
    setShowPayment(false);
    setError("");

    const formData = new FormData();
    // Just sending the first file for the MVP API
    formData.append("image", files[0]);
    formData.append("type", "premium");
    formData.append("preset", selectedStyle);
    formData.append("package", selectedPackage);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Ошибка загрузки");

      navigate(`/processing/${data.id}`);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0a0a] text-white font-sans selection:bg-purple-500/30">
      <header className="fixed top-0 w-full z-50 bg-black/40 backdrop-blur-xl border-b border-white/5 flex items-center justify-between px-6 h-16">
        <div className="flex items-center gap-2">
          <Crown className="text-[#d8b4fe] w-5 h-5" />
          <span className="font-medium text-lg tracking-wide text-white">MyAURA Premium</span>
        </div>
        <Link to="/" className="text-white/60 hover:text-white transition-colors">
          <X className="w-6 h-6" />
        </Link>
      </header>

      <main className="flex-grow pt-24 pb-32 px-5 flex flex-col max-w-md mx-auto w-full">
        <section className="mb-8 text-center">
          <h1 className="text-3xl font-light tracking-tight mb-3">Premium HD фотосессия</h1>
          <p className="text-white/60 text-[14px] leading-relaxed font-light">
            Загрузи 10–15 фото, выбери стиль и получи набор HD-портретов с более сильным likeness, дорогой постановкой света и премиальным результатом.
          </p>
        </section>

        <div className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[13px] font-medium tracking-widest uppercase text-white/50">Выберите стиль</h2>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {PREMIUM_STYLES.map((style) => (
              <div 
                key={style.id}
                onClick={() => setSelectedStyle(style.id)}
                className={`p-4 rounded-2xl border cursor-pointer transition-all duration-300 ${selectedStyle === style.id ? 'border-[#c084fc] bg-[#c084fc]/10 shadow-[0_0_20px_rgba(192,132,252,0.15)]' : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]'}`}
              >
                <div className="flex justify-between items-start mb-2">
                  <span className={`font-medium text-[14px] ${selectedStyle === style.id ? 'text-[#e9d5ff]' : 'text-white/90'}`}>{style.name}</span>
                  {selectedStyle === style.id && <Check className="w-4 h-4 text-[#c084fc] shrink-0 ml-1" />}
                </div>
                <p className="text-[12px] text-white/50 leading-snug">{style.desc}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[13px] font-medium tracking-widest uppercase text-white/50">Загрузка фото (10-15 шт)</h2>
            <span className="text-[12px] text-[#c084fc]">{files.length}/15</span>
          </div>
          
          <div className="bg-white/[0.02] border border-white/10 rounded-3xl p-5 mb-4">
            <ul className="space-y-2 mb-5">
              <li className="flex items-center gap-3 text-[13px] text-white/70">
                <Check className="w-4 h-4 text-[#c084fc]" /> Только портреты и селфи
              </li>
              <li className="flex items-center gap-3 text-[13px] text-white/70">
                <Check className="w-4 h-4 text-[#c084fc]" /> Разные ракурсы и освещение
              </li>
              <li className="flex items-center gap-3 text-[13px] text-white/70">
                <Check className="w-4 h-4 text-[#c084fc]" /> Без очков и сильного макияжа
              </li>
            </ul>

            <label className="relative group cursor-pointer block">
              <input type="file" accept="image/jpeg, image/png" multiple className="hidden" onChange={handleFileChange} />
              <div className="w-full py-8 rounded-2xl bg-white/[0.03] border border-dashed border-white/20 flex flex-col items-center justify-center transition-all duration-300 hover:bg-white/[0.05] hover:border-[#c084fc]/50">
                <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform duration-300">
                  <Camera className="text-[#d8b4fe] w-5 h-5" />
                </div>
                <p className="text-[14px] font-medium text-white/90 mb-1">Выбрать фото</p>
                <p className="text-[12px] text-white/40">JPG, PNG</p>
              </div>
            </label>
          </div>

          {files.length > 0 && (
            <div className="flex gap-3 overflow-x-auto pb-2 snap-x">
              {files.map((file, idx) => (
                <div key={idx} className="relative w-20 h-20 shrink-0 rounded-xl overflow-hidden snap-start border border-white/10">
                  <img src={URL.createObjectURL(file)} alt="Preview" className="w-full h-full object-cover" />
                  <button onClick={() => removeFile(idx)} className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center backdrop-blur-md">
                    <X className="w-3 h-3 text-white" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mb-10">
          <h2 className="text-[13px] font-medium tracking-widest uppercase text-white/50 mb-4">Пакеты</h2>
          <div className="space-y-3">
            {PACKAGES.map((pkg) => (
              <div 
                key={pkg.id}
                onClick={() => setSelectedPackage(pkg.id)}
                className={`relative p-5 rounded-2xl border cursor-pointer transition-all duration-300 flex items-center justify-between ${selectedPackage === pkg.id ? 'border-[#c084fc] bg-[#c084fc]/10 shadow-[0_0_20px_rgba(192,132,252,0.1)]' : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]'}`}
              >
                {pkg.recommended && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-gradient-to-r from-[#c084fc] to-[#a855f7] rounded-full text-[10px] font-bold tracking-wider uppercase text-white shadow-lg">
                    Лучший выбор
                  </div>
                )}
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`font-medium text-[16px] ${selectedPackage === pkg.id ? 'text-[#e9d5ff]' : 'text-white/90'}`}>{pkg.name}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[13px] text-white/50">
                    <span className="flex items-center gap-1"><ImageIcon className="w-3 h-3" /> {pkg.photos}</span>
                    <span className="w-1 h-1 rounded-full bg-white/20"></span>
                    <span className="flex items-center gap-1"><Sparkles className="w-3 h-3" /> {pkg.styles}</span>
                  </div>
                </div>
                <div className={`w-6 h-6 rounded-full border flex items-center justify-center ${selectedPackage === pkg.id ? 'border-[#c084fc] bg-[#c084fc]' : 'border-white/20'}`}>
                  {selectedPackage === pkg.id && <Check className="w-4 h-4 text-white" />}
                </div>
              </div>
            ))}
          </div>
        </div>

        {error && <div className="text-red-400 text-[13px] mb-6 text-center bg-red-400/10 py-3 rounded-xl border border-red-400/20">{error}</div>}

        <div className="mt-auto space-y-6">
          <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-4">
            <label className="flex items-start gap-3 cursor-pointer group">
              <div className="relative mt-0.5 shrink-0">
                <input type="checkbox" className="peer sr-only" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                <div className="w-5 h-5 border border-white/20 rounded transition-all peer-checked:bg-[#c084fc] peer-checked:border-[#c084fc] bg-black/20"></div>
                <svg className="absolute inset-0 w-5 h-5 text-white opacity-0 peer-checked:opacity-100 p-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
              </div>
              <div className="text-[12px] text-white/50 leading-relaxed font-light">
                Я соглашаюсь с обработкой фото для AI-генерации и принимаю <Link to="/privacy" className="text-white/80 hover:text-white underline decoration-white/30 underline-offset-2">Политику конфиденциальности</Link> и <Link to="/terms" className="text-white/80 hover:text-white underline decoration-white/30 underline-offset-2">Условия использования</Link>.
              </div>
            </label>
            <div className="mt-3 pt-3 border-t border-white/5 flex items-center gap-2 text-[11px] text-white/40">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Исходные фото хранятся временно только для обработки.</span>
            </div>
          </div>

          <button 
            onClick={handlePaymentAndUpload}
            disabled={loading}
            className="w-full h-14 bg-gradient-to-r from-[#c084fc] to-[#a855f7] text-white font-medium text-[15px] rounded-2xl shadow-[0_0_30px_rgba(168,85,247,0.3)] hover:shadow-[0_0_40px_rgba(168,85,247,0.4)] active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-50 disabled:active:scale-100"
          >
            <span>{loading ? "Загрузка..." : "Продолжить"}</span>
            {!loading && <ArrowRight className="w-4 h-4 ml-1" />}
          </button>
        </div>
      </main>

      {/* Payment Placeholder Modal */}
      {showPayment && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-5 bg-black/80 backdrop-blur-sm">
          <div className="bg-[#141414] rounded-3xl p-6 w-full max-w-sm shadow-2xl border border-white/10">
            <h3 className="text-xl font-medium mb-2 text-white">Подтверждение</h3>
            <p className="text-[14px] text-white/60 mb-6 font-light">Выбран пакет <strong>{PACKAGES.find(p => p.id === selectedPackage)?.name}</strong>. В реальном приложении здесь будет интеграция с платежным шлюзом (Telegram Stars).</p>
            
            <div className="space-y-3">
              <button 
                onClick={confirmPayment}
                className="w-full h-12 bg-gradient-to-r from-[#c084fc] to-[#a855f7] text-white font-medium rounded-xl hover:opacity-90 transition-opacity"
              >
                Симулировать оплату
              </button>
              <button 
                onClick={() => setShowPayment(false)}
                className="w-full h-12 bg-white/5 border border-white/10 text-white font-medium rounded-xl hover:bg-white/10 transition-colors"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
