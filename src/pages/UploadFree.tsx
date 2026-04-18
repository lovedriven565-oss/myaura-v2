import React, { useState, useEffect, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Camera, X, Sparkles, Sun, Wand2, Wallet } from "lucide-react";
import { apiFetch } from "../lib/api";

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

const FREE_V2 = import.meta.env.VITE_FREE_MULTI_REF_V2_ENABLED === "true";
const FREE_MAX_PHOTOS = FREE_V2 ? 5 : 1;

export default function UploadFree() {
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [freeCredits, setFreeCredits] = useState(0);
  const [paidCredits, setPaidCredits] = useState(0);
  const [ageTier, setAgeTier] = useState<"young" | "mature" | "distinguished">("young");
  const [gender, setGender] = useState<"male" | "female" | "unset">("unset");
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [debugInfo, setDebugInfo] = useState<string>("");
  const navigate = useNavigate();
  const { userId: tgUserId } = getTelegramIds();

  // Preview mode: free_credits first, then paid_credits
  const canGenerate = freeCredits > 0 || paidCredits > 0;

  // Cache object URLs to prevent memory leaks in Telegram WebView
  const objectUrls = useMemo(() => {
    const urls = files.map(f => URL.createObjectURL(f));
    console.log('[UploadFree] Created object URLs:', urls.length, 'for', files.length, 'files');
    return urls;
  }, [files]);

  // Cleanup object URLs on unmount or when files change
  useEffect(() => {
    return () => {
      objectUrls.forEach(url => {
        URL.revokeObjectURL(url);
        console.log('[UploadFree] Revoked object URL:', url.substring(0, 50) + '...');
      });
    };
  }, [objectUrls]);

  // Fetch balance on mount
  useEffect(() => {
    const fetchBalance = async () => {
      try {
        const url = tgUserId ? `/api/user/balance?telegramId=${tgUserId}` : `/api/user/balance`;
        const res = await apiFetch(url);
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
    if (e.target.files && e.target.files.length > 0) {
      const newFiles = Array.from(e.target.files);
      console.log('[UploadFree] Selected files:', newFiles.length, 'names:', newFiles.map(f => f.name));
      const merged = [...files, ...newFiles].slice(0, FREE_MAX_PHOTOS);
      console.log('[UploadFree] Total files after merge:', merged.length);
      setFiles(merged);
      setDebugInfo(`Загружено ${merged.length} фото`);
      setError("");
    }
  };

  const removeFile = (index: number) => {
    console.log('[UploadFree] Removing file at index:', index);
    setFiles(prev => {
      const newFiles = prev.filter((_, i) => i !== index);
      console.log('[UploadFree] Files after removal:', newFiles.length);
      setDebugInfo(`Загружено ${newFiles.length} фото`);
      return newFiles;
    });
  };

  const handleUpload = async () => {
    if (loading || balanceLoading) return; // Prevent double submit
    if (!canGenerate) {
      navigate("/premium");
      return;
    }
    if (files.length === 0) {
      setError("Пожалуйста, выберите хотя бы одно фото");
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
    files.forEach(f => formData.append("images", f));
    formData.append("packageId", "free");
    formData.append("mode", "preview");
    formData.append("styleIds", JSON.stringify(["business"]));
    formData.append("ageTier", ageTier);
    formData.append("gender", gender);
    formData.append("telegramUserId", userId);
    if (chatId) formData.append("telegramChatId", chatId);

    try {
      const res = await apiFetch("/api/generate", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      // Handle auth errors (401) from initData validation
      if (res.status === 401) {
        setError(data.error || "Ошибка авторизации. Перезапустите приложение.");
        setLoading(false);
        return;
      }

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

      if (res.status === 400 && data.code === "PHOTO_QUALITY_REJECTED") {
        setError(data.error || "Фото не прошли проверку качества. Загрузите более чёткие фото.");
        setLoading(false);
        return;
      }

      if (!res.ok) throw new Error("Произошла ошибка при генерации. Попробуйте ещё раз.");

      // Async mode: server returns { id, status: "processing" }
      const _uid = (window as any).Telegram?.WebApp?.initDataUnsafe?.user?.id;
      const _key = _uid ? `myaura_active_gen_${_uid}` : "myaura_active_gen";
      localStorage.setItem(_key, data.id);
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
            {FREE_V2
              ? "Загрузите до 5 фото для лучшего сохранения внешности."
              : "Загрузите одно селфи, чтобы увидеть качество генерации."}
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

        {/* Photo upload area */}
        {FREE_V2 ? (
          <div className="mb-8">
            {files.length > 0 && (
              <div className="grid grid-cols-3 gap-2 mb-3">
                {files.map((f, i) => (
                  <div key={f.name + i} className="relative aspect-square rounded-xl overflow-hidden border border-white/10">
                    <img src={objectUrls[i]} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 flex items-center justify-center hover:bg-red-500/80 transition-colors"
                    >
                      <X className="w-3.5 h-3.5 text-white" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {files.length < FREE_MAX_PHOTOS && (
              <label className="relative group cursor-pointer block">
                <input type="file" accept="image/jpeg, image/png" className="hidden" onChange={handleFileChange} multiple />
                <div className="w-full py-8 rounded-2xl bg-white/[0.02] border border-dashed border-white/10 flex flex-col items-center justify-center transition-all duration-300 hover:bg-white/[0.04] hover:border-white/20">
                  <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform duration-300">
                    <Camera className="text-[#d8b4fe] w-6 h-6" />
                  </div>
                  <p className="text-[14px] font-medium text-white/90 mb-0.5">
                    {files.length === 0 ? "Нажмите для загрузки" : "Добавить ещё фото"}
                  </p>
                  <p className="text-[12px] text-white/40">{files.length}/{FREE_MAX_PHOTOS} фото · JPG, PNG</p>
                </div>
              </label>
            )}
          </div>
        ) : (
          <label className="relative group cursor-pointer mb-8 block">
            <input type="file" accept="image/jpeg, image/png" className="hidden" onChange={handleFileChange} />
            <div className="w-full aspect-[4/5] rounded-2xl bg-white/[0.02] border border-white/10 flex flex-col items-center justify-center overflow-hidden transition-all duration-300 hover:bg-white/[0.04] hover:border-white/20 relative">
              {files.length > 0 ? (
                <img src={objectUrls[0]} alt="Preview" className="w-full h-full object-cover" />
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
        )}

        {error && <div className="text-red-400 text-[14px] mb-6 text-center bg-red-400/10 py-3 rounded-xl border border-red-400/20">{error}</div>}

        {/* Debug info for Telegram WebView troubleshooting */}
        {debugInfo && (
          <div className="text-emerald-400 text-[12px] mb-4 text-center bg-emerald-500/10 py-2 rounded-lg border border-emerald-500/20">
            {debugInfo} {FREE_V2 ? `(макс. ${FREE_MAX_PHOTOS})` : ''}
          </div>
        )}

        <section className="grid grid-cols-1 gap-3 mb-10">
          <div className="flex items-center gap-4 p-4 rounded-xl bg-white/[0.03] border border-white/5">
            <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
              <Camera className="text-[#d8b4fe] w-5 h-5" />
            </div>
            <p className="text-[14px] font-medium text-white/90">{FREE_V2 ? "Лицо крупным планом, 1-5 фото" : "Одно лицо крупным планом"}</p>
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

        {/* Age Tier Selector */}
        <div className="mb-5">
          <p className="text-[12px] text-white/40 uppercase tracking-widest mb-3">Возрастной диапазон</p>
          <div className="grid grid-cols-3 gap-2">
            {([
              { id: "young", label: "До 30 лет" },
              { id: "mature", label: "30–50 лет" },
              { id: "distinguished", label: "Старше 50" },
            ] as const).map((tier) => (
              <button
                key={tier.id}
                type="button"
                onClick={() => setAgeTier(tier.id)}
                className={`py-2.5 px-2 rounded-xl border text-[12px] font-medium transition-all duration-200 ${
                  ageTier === tier.id
                    ? 'border-[#c084fc] bg-[#c084fc]/10 text-[#e9d5ff]'
                    : 'border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.04]'
                }`}
              >
                {tier.label}
              </button>
            ))}
          </div>
        </div>

        {/* Gender Selector */}
        <div className="mb-8">
          <p className="text-[12px] text-white/40 uppercase tracking-widest mb-3">Пол</p>
          <div className="grid grid-cols-3 gap-2">
            {([
              { id: "male", label: "Мужской" },
              { id: "female", label: "Женский" },
              { id: "unset", label: "Не указан" },
            ] as const).map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setGender(g.id)}
                className={`py-2.5 px-2 rounded-xl border text-[12px] font-medium transition-all duration-200 ${
                  gender === g.id
                    ? 'border-[#c084fc] bg-[#c084fc]/10 text-[#e9d5ff]'
                    : 'border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.04]'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>

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

        <p className="text-center text-[10px] text-white/20 mt-6">v3.2</p>
      </main>
    </div>
  );
}
