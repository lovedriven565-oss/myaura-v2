import React, { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Camera, X, Sparkles, Sun, Wand2, Wallet } from "lucide-react";

// Detect Telegram Mini App IDs for delivery
function getTelegramIds(): { chatId: string | null; userId: string | null } {
  try {
    const tg = (window as any).Telegram?.WebApp;
    if (tg) tg.ready();
    if (!tg) return { chatId: null, userId: null };
    const userId = tg?.initDataUnsafe?.user?.id;
    const explicitChatId = tg?.initDataUnsafe?.chat?.id;
    return {
      chatId: explicitChatId ? String(explicitChatId) : null,
      userId: userId ? String(userId) : null
    };
  } catch {
    return { chatId: null, userId: null };
  }
}

export default function UploadFree() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [freeCredits, setFreeCredits] = useState(0);
  const [paidCredits, setPaidCredits] = useState(0);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const navigate = useNavigate();
  const { userId: tgUserId } = getTelegramIds();

  // Preview mode: free_credits first, then paid_credits
  const canGenerate = freeCredits > 0 || paidCredits > 0;

  // Fetch balance on mount
  useEffect(() => {
    const fetchBalance = async () => {
      try {
        const url = tgUserId ? `/api/user/balance?telegramId=${tgUserId}` : `/api/user/balance`;
        const res = await fetch(url);
        const data = await res.json();
        setFreeCredits(data.freeCredits ?? 0);
        setPaidCredits(data.paidCredits ?? 0);
      } catch {
        setFreeCredits(1);
        setPaidCredits(0);
      } finally {
        setBalanceLoading(false);
      }
    };
    fetchBalance();
  }, [tgUserId]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setError("");
    }
  };

  const handleUpload = async () => {
    if (loading || balanceLoading) return; // Prevent double submit
    if (!canGenerate) {
      navigate("/premium");
      return;
    }
    if (!file) {
      setError("Пожалуйста, выберите фото");
      return;
    }
    if (!agreed) {
      setError("Необходимо согласие с условиями");
      return;
    }

    setLoading(true);
    setError("");

    const { chatId, userId } = getTelegramIds();

    if (!userId) {
      setError("Откройте приложение через Telegram для генерации");
      setLoading(false);
      return;
    }
    
    const formData = new FormData();
    formData.append("images", file);
    formData.append("packageId", "free");
    formData.append("mode", "preview");
    formData.append("styleIds", JSON.stringify(["business"]));
    formData.append("telegramUserId", userId);
    if (chatId) formData.append("telegramChatId", chatId);

    try {
      const tg = (window as any).Telegram?.WebApp;
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "X-Telegram-Init-Data": tg?.initData || "" },
        body: formData,
      });
      const data = await res.json();

      if (res.status === 403 && data.code === "INSUFFICIENT_FUNDS") {
        setError("У вас закончились бесплатные генерации. Перейдите в раздел Premium, чтобы продолжить!");
        setFreeCredits(0);
        setPaidCredits(0);
        setLoading(false);
        return;
      }

      if (res.status === 404 && data.code === "USER_NOT_FOUND") {
        setError("Пользователь не найден. Перезапустите приложение.");
        setLoading(false);
        return;
      }

      if (!res.ok) throw new Error("Произошла ошибка при генерации. Попробуйте ещё раз.");

      navigate(`/processing/${data.id}`);
    } catch (err: any) {
      setError(err.message || "Произошла ошибка. Попробуйте ещё раз.");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0a0a] text-white font-sans selection:bg-purple-500/30">
      <header className="fixed top-0 w-full z-50 bg-black/40 backdrop-blur-xl flex items-center justify-between px-6 h-16 border-b border-white/5">
        <div className="flex items-center gap-2">
          <Sparkles className="text-[#d8b4fe] w-5 h-5" />
          <span className="font-medium text-lg tracking-wide">MyAURA</span>
        </div>
        <Link to="/" className="text-white/60 hover:text-white transition-colors">
          <X className="w-6 h-6" />
        </Link>
      </header>

      <main className="flex-grow pt-24 pb-32 px-6 flex flex-col max-w-lg mx-auto w-full">
        <section className="mb-6">
          <h1 className="text-3xl font-light tracking-tight mb-2">Бесплатный Preview</h1>
          <p className="text-white/60 text-[15px] leading-relaxed font-light">
            Загрузите одно селфи, чтобы увидеть качество генерации.
          </p>
        </section>

        {/* Free credits badge */}
        <div className="mb-8 flex justify-center">
          {balanceLoading ? (
            <div className="px-4 py-2 rounded-full bg-white/5 border border-white/10 text-[13px] text-white/40">Загрузка...</div>
          ) : (
            <div className={`px-5 py-2.5 rounded-full border flex items-center gap-2.5 ${canGenerate ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
              <Wallet className={`w-4 h-4 ${canGenerate ? 'text-emerald-400' : 'text-red-400'}`} />
              <span className={`text-[13px] font-medium ${canGenerate ? 'text-emerald-300' : 'text-red-300'}`}>
                {freeCredits > 0
                  ? "1 бесплатная генерация доступна"
                  : paidCredits > 0
                    ? `Баланс: ${paidCredits} генераций`
                    : "Бесплатная генерация использована"}
              </span>
            </div>
          )}
        </div>

        <label className="relative group cursor-pointer mb-8 block">
          <input type="file" accept="image/jpeg, image/png" className="hidden" onChange={handleFileChange} />
          <div className="w-full aspect-[4/5] rounded-2xl bg-white/[0.02] border border-white/10 flex flex-col items-center justify-center overflow-hidden transition-all duration-300 hover:bg-white/[0.04] hover:border-white/20 relative">
            {file ? (
              <img src={URL.createObjectURL(file)} alt="Preview" className="w-full h-full object-cover" />
            ) : (
              <div className="flex flex-col items-center text-center p-8 z-10">
                <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                  <Camera className="text-[#d8b4fe] w-8 h-8" />
                </div>
                <p className="text-[15px] font-medium text-white/90 mb-1">Нажмите для загрузки</p>
                <p className="text-[13px] text-white/50">JPG, PNG до 10 МБ</p>
              </div>
            )}
          </div>
        </label>

        {error && <div className="text-red-400 text-[14px] mb-6 text-center bg-red-400/10 py-3 rounded-xl border border-red-400/20">{error}</div>}

        <section className="grid grid-cols-1 gap-3 mb-10">
          <div className="flex items-center gap-4 p-4 rounded-xl bg-white/[0.03] border border-white/5">
            <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
              <Camera className="text-[#d8b4fe] w-5 h-5" />
            </div>
            <p className="text-[14px] font-medium text-white/90">Одно лицо крупным планом</p>
          </div>
          <div className="flex items-center gap-4 p-4 rounded-xl bg-white/[0.03] border border-white/5">
            <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
              <Sun className="text-[#d8b4fe] w-5 h-5" />
            </div>
            <p className="text-[14px] font-medium text-white/90">Хорошее естественное освещение</p>
          </div>
          <div className="flex items-center gap-4 p-4 rounded-xl bg-white/[0.03] border border-white/5">
            <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
              <Wand2 className="text-[#d8b4fe] w-5 h-5" />
            </div>
            <p className="text-[14px] font-medium text-white/90">Без сильных фильтров и очков</p>
          </div>
        </section>

        <div className="mt-auto space-y-6">
          <label className="flex items-start gap-3 cursor-pointer group">
            <div className="relative mt-0.5">
              <input type="checkbox" className="peer sr-only" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <div className="w-5 h-5 border border-white/20 rounded-md transition-all peer-checked:bg-[#c084fc] peer-checked:border-[#c084fc]"></div>
              <svg className="absolute inset-0 w-5 h-5 text-white opacity-0 peer-checked:opacity-100 p-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            </div>
            <div className="text-[13px] text-white/60 leading-relaxed font-light">
              Я согласен с обработкой фото и условиями сервиса.
              <div className="mt-1.5 flex gap-4">
                <Link to="/privacy" className="text-[#d8b4fe] hover:text-[#e9d5ff] transition-colors underline decoration-white/20 underline-offset-4">Политика</Link>
                <Link to="/terms" className="text-[#d8b4fe] hover:text-[#e9d5ff] transition-colors underline decoration-white/20 underline-offset-4">Соглашение</Link>
              </div>
            </div>
          </label>

          <button 
            onClick={handleUpload}
            disabled={loading || balanceLoading}
            className="w-full h-14 bg-white/10 hover:bg-white/15 border border-white/10 text-white font-medium text-[15px] rounded-2xl transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loading ? (
              <span>Генерация...</span>
            ) : canGenerate ? (
              <>
                <span>Создать бесплатно</span>
                <Sparkles className="w-4 h-4 text-white/70" />
              </>
            ) : (
              <span>Перейти к Premium</span>
            )}
          </button>
          
          <div className="text-center mt-4">
            <Link to="/premium" className="text-[14px] text-[#d8b4fe] hover:text-[#e9d5ff] transition-colors">
              Или попробуйте Premium (больше стилей)
            </Link>
          </div>
        </div>

        <p className="text-center text-[10px] text-white/20 mt-6">v3.1</p>
      </main>
    </div>
  );
}
