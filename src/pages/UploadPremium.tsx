import React, { useState, useEffect } from "react";

import { useNavigate, Link } from "react-router-dom";

import { Camera, X, Sparkles, Star, Check, Crown, Image as ImageIcon, ShieldCheck, ArrowRight, Wallet, Zap, Lock, Briefcase, Flame, Moon } from "lucide-react";

import { apiFetch } from "../lib/api";

import { requestUploadUrls, uploadFilesToR2 } from "../lib/uploadToR2";



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

interface CatalogPkg {
  id: string;
  title: string;
  generations: number;
  priceBYN: number;
  priceRUB: number;
  starsPrice: number;
  badge: string | null;
}



// Premium style catalog.
// `exclusive: true` marks server-gated premium-only styles (see
// src/server/prompts.ts:PREMIUM_EXCLUSIVE_STYLES). These are surfaced with an
// "EXCLUSIVE" badge and, for users without paid credits, a lock affordance
// that opens the purchase flow instead of selecting the style.
type PremiumStyle = {
  id: string;
  name: string;
  desc: string;
  exclusive?: boolean;
  // Tailwind gradient classes for the small icon medallion on exclusive tiles.
  accentGradient?: string;
};

const PREMIUM_STYLES: PremiumStyle[] = [
  { id: "business",   name: "Бизнес-портрет",      desc: "Строгий и дорогой корпоративный стиль" },
  { id: "lifestyle",  name: "Премиум lifestyle",   desc: "Естественный свет, дорогие интерьеры" },
  { id: "cinematic",  name: "Кинематографичный",   desc: "Глубокие тени, киношная цветокоррекция" },
  { id: "editorial",  name: "Studio Editorial",    desc: "Журнальная обложка, fashion-свет" },
  { id: "luxury",     name: "Luxury",              desc: "Эстетика old money, вечерние образы" },
  { id: "aura",       name: "Aura",                desc: "Фирменный стиль с мягким свечением" },
  // ── Premium-exclusive (server-gated) ──────────────────────────────────────
  { id: "cyberpunk",  name: "Cyberpunk",           desc: "Неоновый город, блейд-раннер атмосфера",      exclusive: true, accentGradient: "from-fuchsia-500 to-cyan-400" },
  { id: "corporate",  name: "Corporate Executive", desc: "CEO-уровень, институциональная уверенность",  exclusive: true, accentGradient: "from-amber-400 to-orange-500" },
  { id: "ethereal",   name: "Ethereal",            desc: "Небесный, живописный, ренессансный свет",     exclusive: true, accentGradient: "from-indigo-400 to-pink-300" },
];

// Map style → icon for the exclusive tiles. Regular styles stay icon-free to
// preserve the existing clean grid density.
const EXCLUSIVE_STYLE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  cyberpunk: Flame,
  corporate: Briefcase,
  ethereal:  Moon,
};



export default function UploadPremium() {

  const [files, setFiles] = useState<File[]>([]);

  const [selectedStyle, setSelectedStyle] = useState("business");

  const [ageTier, setAgeTier] = useState<"young" | "mature" | "distinguished">("young");

  const [gender, setGender] = useState<"male" | "female" | "unset">("unset");

  const [loading, setLoading] = useState(false);

  const [error, setError] = useState("");

  const [agreed, setAgreed] = useState(false);

  const [showStore, setShowStore] = useState(false);

  const [freeCredits, setFreeCredits] = useState(0);

  const [paidCredits, setPaidCredits] = useState(0);

  const [balanceLoading, setBalanceLoading] = useState(true);

  // Phase 2 direct-to-R2 upload progress
  const [uploadPhase, setUploadPhase] = useState<null | "uploading" | "starting">(null);
  const [uploadPct, setUploadPct] = useState<number>(0);

  const [catalog, setCatalog] = useState<CatalogPkg[]>([]);

  const [selectedStorePkg, setSelectedStorePkg] = useState("pro");

  const [confirmedPackageId, setConfirmedPackageId] = useState<string | null>(null);

  const navigate = useNavigate();

  const { userId: tgUserId } = getTelegramIds();



  // Premium HD: ONLY paid credits count. Free credits are for Preview only.

  const canGenerate = paidCredits > 0;

  // Resolved from catalog only after explicit confirmation in modal — the ONLY package used for generation

  const confirmedPkg = catalog.find(p => p.id === confirmedPackageId) ?? null;

  // If the balance changes (e.g. user exhausts paid credits between mount and
  // re-render), auto-demote any selected exclusive style to `business` so we
  // never ship a `styleId` the backend will reject. This guards the edge case
  // where a user pre-selected Cyberpunk and then used up their last credit in
  // another tab.
  useEffect(() => {
    const selected = PREMIUM_STYLES.find(s => s.id === selectedStyle);
    if (selected?.exclusive && !canGenerate) {
      setSelectedStyle("business");
    }
  }, [canGenerate, selectedStyle]);



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

      setFiles(prev => [...prev, ...newFiles].slice(0, 15));

      setError("");

    }

  };



  const removeFile = (index: number) => {

    setFiles(prev => prev.filter((_, i) => i !== index));

  };



  // Open store and fetch catalog

  const openStore = async () => {

    try {

      const res = await apiFetch("/api/payment/catalog");

      const data = await res.json();

      setCatalog(data.catalog || []);

      setShowStore(true);

    } catch {

      setError("Не удалось загрузить каталог");

    }

  };



  // Purchase via Telegram Stars

  const handlePurchase = async (pkgId: string) => {

    const tg = (window as any).Telegram?.WebApp;

    if (!tg || !tgUserId) {

      setError("Оплата доступна только внутри Telegram");

      return;

    }

    try {

      const res = await apiFetch("/api/payment/create-invoice", {

        method: "POST",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({ packageId: pkgId, telegramId: tgUserId }),

      });

      const data = await res.json();

      if (data.invoiceLink) {

        tg.openInvoice(data.invoiceLink, (status: string) => {

          if (status === "paid") {

            apiFetch(`/api/user/balance?telegramId=${tgUserId}`)

              .then(r => r.json())

              .then(d => {

                setFreeCredits(d.freeCredits ?? 0);

                setPaidCredits(d.paidCredits ?? 0);

                setShowStore(false);

              });

          }

        });

      }

    } catch {

      setError("Ошибка при создании инвойса");

    }

  };



  const handleMainAction = async () => {
    // Global try-catch to catch ANY error (sync or async) for debugging
    try {
      // Double-click / re-entry guard
      if (loading) return;

      if (!canGenerate) {
        openStore();
        return;
      }

      // If the user has paid credits but hasn't explicitly picked a package
      // (e.g. credits granted manually via Supabase for testing, or they already
      // bought a pack earlier), transparently default to the smallest tier
      // ("starter") so they can spend their existing credit seamlessly instead
      // of being forced back into the purchase modal.
      let effectivePackageId = confirmedPackageId;
      if (!effectivePackageId && paidCredits > 0) {
        effectivePackageId = "starter";
        setConfirmedPackageId("starter");
        console.log("[GEN] Auto-selected 'starter' package for existing paid credit holder");
      }

      if (!effectivePackageId) {
        openStore();
        return;
      }

      if (files.length < 10) {
        setError("Пожалуйста, загрузите от 10 до 15 фото для достижения высокого качества");
        return;
      }

      if (!agreed) {
        setError("Необходимо согласие с условиями");
        return;
      }

      setLoading(true);
      setError("");
      setUploadPhase(null);
      setUploadPct(0);

      const { chatId, userId } = getTelegramIds();

      if (!userId) {
        setError("Откройте приложение через Telegram для генерации");
        setLoading(false);
        return;
      }

      console.log("[GEN] Starting R2 upload flow", {
        filesCount: files.length,
        effectivePackageId,
        selectedStyle,
        ageTier,
        gender,
      });

      // Phase 2 direct-to-R2 upload:
      //   1) /api/upload-urls mints presigned PUT URLs (one per file).
      //   2) Browser PUTs originals directly to R2 — no canvas compression,
      //      no multipart payload through Cloud Run (bypassing the 32 MB limit).
      //   3) /api/generate receives only the resulting R2 object keys.
      let imageKeys: string[];
      try {
        setUploadPhase("uploading");
        const slots = await requestUploadUrls({
          files,
          packageId: effectivePackageId as "starter" | "pro" | "max",
        });
        imageKeys = await uploadFilesToR2(files, slots, (progress) => {
          const loaded = progress.reduce((s, p) => s + p.loaded, 0);
          const total = progress.reduce((s, p) => s + p.total, 0) || 1;
          setUploadPct(Math.round((loaded / total) * 100));
        });
        console.log(`[GEN] Uploaded ${imageKeys.length} files to R2`);
      } catch (uploadErr: any) {
        console.error("[GEN] R2 upload failed:", uploadErr);
        const msg = uploadErr?.details?.error || uploadErr?.message || "Не удалось загрузить фото";
        setError("Ошибка загрузки: " + msg);
        setLoading(false);
        setUploadPhase(null);
        return;
      }

      setUploadPhase("starting");
      const res = await apiFetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packageId: effectivePackageId,
          mode: "premium",
          styleIds: [selectedStyle],
          ageTier,
          gender,
          telegramUserId: userId,
          ...(chatId ? { telegramChatId: chatId } : {}),
          imageKeys,
        }),
      });

      console.log("[GEN DEBUG] Response received:", res.status, res.statusText);

      const data = await res.json();
      console.log("[GEN DEBUG] Response data:", data);

      // Handle auth errors (401) from initData validation
      if (res.status === 401) {
        setError(data.error || "Ошибка авторизации. Перезапустите приложение.");
        setLoading(false);
        return;
      }

      if (res.status === 403 && data.code === "INSUFFICIENT_FUNDS") {
        setError("У вас недостаточно оплаченных генераций. Купите пакет, чтобы продолжить!");
        openStore();
        setLoading(false);
        return;
      }

      if (res.status === 404 && data.code === "USER_NOT_FOUND") {
        setError("Пользователь не найден. Перезапустите приложение.");
        setLoading(false);
        return;
      }

      if (!res.ok) {
        throw new Error(data.error || data.message || "Произошла ошибка при генерации. Попробуйте ещё раз.");
      }

      // Async mode: server returns { id, status: "processing" }
      const _uid = (window as any).Telegram?.WebApp?.initDataUnsafe?.user?.id;
      const _key = _uid ? `myaura_active_gen_${_uid}` : "myaura_active_gen";
      localStorage.setItem(_key, data.id);
      navigate(`/processing/${data.id}`);

    } catch (err: any) {
      // CRITICAL: Log exact error and show alert for debugging
      console.error("GEN ERROR:", err);
      console.error("GEN ERROR stack:", err?.stack);
      alert("GEN ERROR: " + (err?.message || "Unknown error"));
      
      setError(err?.message || "Произошла ошибка. Попробуйте ещё раз.");
      setLoading(false);
      setUploadPhase(null);
    }
  };



  return (

    <div className="min-h-screen flex flex-col bg-[#0a0a0a] text-white font-sans selection:bg-purple-500/30">

      {/* Loading Overlay */}

      {loading && (

        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center">

          <div className="text-center space-y-4">

            <div className="w-16 h-16 border-4 border-[#c084fc] border-t-transparent rounded-full animate-spin mx-auto"></div>

            <h2 className="text-2xl font-light text-white">Генерируем фотографии...</h2>

            <p className="text-white/60 text-[15px]">Это может занять несколько минут</p>

          </div>

        </div>

      )}

      

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



        {/* Balance Badge */}

        <div className="mb-8 flex justify-center">

          {balanceLoading ? (

            <div className="px-4 py-2 rounded-full bg-white/5 border border-white/10 text-[13px] text-white/40">Загрузка баланса...</div>

          ) : (

            <div className="flex flex-col items-center gap-1.5">

              <div className={`px-5 py-2.5 rounded-full border flex items-center gap-2.5 ${canGenerate ? 'bg-[#c084fc]/10 border-[#c084fc]/30' : 'bg-red-500/10 border-red-500/30'}`}>

                <Wallet className={`w-4 h-4 ${canGenerate ? 'text-[#c084fc]' : 'text-red-400'}`} />

                <span className={`text-[13px] font-medium ${canGenerate ? 'text-[#e9d5ff]' : 'text-red-300'}`}>

                  {paidCredits > 0

                    ? `Баланс: ${paidCredits} генераций`

                    : "Нет оплаченных генераций"}

                </span>

                {!canGenerate && (

                  <button onClick={openStore} className="text-[11px] text-[#c084fc] underline underline-offset-2 ml-1">Купить</button>

                )}

              </div>

              {canGenerate && confirmedPkg && (

                <div className="text-[12px] text-white/50">

                  Пакет: <span className="text-[#e9d5ff]">{confirmedPkg.title} · {confirmedPkg.generations} фото</span>

                  {' · '}

                  <button onClick={openStore} className="text-[#c084fc] underline underline-offset-2">Изменить</button>

                </div>

              )}

            </div>

          )}

        </div>



        <div className="mb-10">

          <div className="flex items-center justify-between mb-4">

            <h2 className="text-[13px] font-medium tracking-widest uppercase text-white/50">Выберите стиль</h2>
            <span className="text-[11px] text-[#d8b4fe]/70 flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              <span>3 новых</span>
            </span>

          </div>

          <div className="grid grid-cols-2 gap-3">

            {PREMIUM_STYLES.map((style) => {
              const isSelected = selectedStyle === style.id;
              // Locked = exclusive style AND user has no paid credits.
              // UploadPremium is gated by paid credits anyway, but a user who
              // arrived here with 0 paid credits can still browse — we want
              // them to see the premium catalog and convert, not silently pick
              // a style that will fail at generation time.
              const isLocked = !!style.exclusive && !canGenerate;
              const Icon = style.exclusive ? EXCLUSIVE_STYLE_ICONS[style.id] : null;
              return (
                <div
                  key={style.id}
                  onClick={() => {
                    if (isLocked) {
                      openStore();
                      return;
                    }
                    setSelectedStyle(style.id);
                  }}
                  className={`relative p-4 rounded-2xl border cursor-pointer transition-all duration-300 overflow-hidden ${
                    isSelected
                      ? 'border-[#c084fc] bg-[#c084fc]/10 shadow-[0_0_20px_rgba(192,132,252,0.15)]'
                      : style.exclusive
                        ? 'border-[#c084fc]/25 bg-gradient-to-br from-white/[0.03] to-[#c084fc]/[0.04] hover:from-white/[0.05] hover:to-[#c084fc]/[0.07]'
                        : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]'
                  } ${isLocked ? 'opacity-80' : ''}`}
                >
                  {style.exclusive && (
                    <div className={`absolute top-2 right-2 px-1.5 py-0.5 rounded-md text-[8px] font-bold tracking-widest uppercase bg-gradient-to-r ${style.accentGradient ?? 'from-[#c084fc] to-[#a855f7]'} text-white/95 shadow-[0_0_10px_rgba(192,132,252,0.25)]`}>
                      {isLocked ? 'LOCKED' : 'EXCL.'}
                    </div>
                  )}

                  {Icon && style.accentGradient && (
                    <div className={`w-8 h-8 mb-2 rounded-lg bg-gradient-to-br ${style.accentGradient} flex items-center justify-center shadow-[0_0_12px_rgba(192,132,252,0.2)]`}>
                      {isLocked
                        ? <Lock className="w-4 h-4 text-white/90" />
                        : <Icon className="w-4 h-4 text-white" />
                      }
                    </div>
                  )}

                  <div className="flex justify-between items-start mb-2">
                    <span className={`font-medium text-[14px] ${isSelected ? 'text-[#e9d5ff]' : 'text-white/90'}`}>
                      {style.name}
                    </span>
                    {isSelected && <Check className="w-4 h-4 text-[#c084fc] shrink-0 ml-1" />}
                  </div>

                  <p className="text-[12px] text-white/50 leading-snug">{style.desc}</p>
                </div>
              );
            })}

          </div>

        </div>



        {/* Age Tier Selector */}
        <div className="mb-6">
          <h2 className="text-[13px] font-medium tracking-widest uppercase text-white/50 mb-4">Возрастной диапазон</h2>
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
                className={`py-3 px-2 rounded-xl border text-[13px] font-medium transition-all duration-200 ${
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
        <div className="mb-10">
          <h2 className="text-[13px] font-medium tracking-widest uppercase text-white/50 mb-4">Пол</h2>
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
                className={`py-3 px-2 rounded-xl border text-[13px] font-medium transition-all duration-200 ${
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

        <div className="mb-10">

          <div className="flex items-center justify-between mb-4">

            <h2 className="text-[13px] font-medium tracking-widest uppercase text-white/50">Загрузка фото (10-15 шт)</h2>

            <span className="text-[12px] text-[#c084fc]">{files.length}/15</span>

          </div>

          

          <div className="bg-white/[0.02] border border-white/10 rounded-3xl p-5 mb-4">

            <ul className="space-y-2.5 mb-5">

              <li className="flex items-start gap-3 text-[13px] text-white/70">

                <Check className="w-4 h-4 text-[#c084fc] shrink-0 mt-0.5" />

                <span>Только портреты и селфи — лицо чётко видно, без групповых фото</span>

              </li>

              <li className="flex items-start gap-3 text-[13px] text-white/70">

                <Check className="w-4 h-4 text-[#c084fc] shrink-0 mt-0.5" />

                <span>2–3 фото с разных ракурсов: прямо, вполоборота, чуть сбоку</span>

              </li>

              <li className="flex items-start gap-3 text-[13px] text-white/70">

                <Check className="w-4 h-4 text-[#c084fc] shrink-0 mt-0.5" />

                <span>Разное освещение: дневной свет, тёплый интерьер, вечер</span>

              </li>

              <li className="flex items-start gap-3 text-[13px] text-white/70">

                <Check className="w-4 h-4 text-[#c084fc] shrink-0 mt-0.5" />

                <span>Нейтральное выражение и мягкая улыбка — по 1–2 фото каждого</span>

              </li>

              <li className="flex items-start gap-3 text-[13px] text-white/70">

                <Check className="w-4 h-4 text-[#c084fc] shrink-0 mt-0.5" />

                <span>Без очков, масок, сильного макияжа и фильтров — нужно естественное лицо</span>

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

            onClick={handleMainAction}

            disabled={loading || balanceLoading}

            className="w-full h-14 bg-gradient-to-r from-[#c084fc] to-[#a855f7] text-white font-medium text-[15px] rounded-2xl shadow-[0_0_30px_rgba(168,85,247,0.3)] hover:shadow-[0_0_40px_rgba(168,85,247,0.4)] active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-50 disabled:active:scale-100"

          >

            {loading ? (

              <span>
                {uploadPhase === "uploading"
                  ? `Загрузка ${uploadPct}%...`
                  : uploadPhase === "starting"
                  ? "Запуск генерации..."
                  : "Генерация..."}
              </span>

            ) : canGenerate && confirmedPkg ? (

              <>

                <Zap className="w-4 h-4" />

                <span>Использовать 1 кредит · {confirmedPkg.generations} фото</span>

              </>

            ) : canGenerate && !confirmedPkg ? (

              <>

                <Star className="w-4 h-4" />

                <span>Выбрать пакет →</span>

              </>

            ) : (

              <>

                <Star className="w-4 h-4" />

                <span>Купить пакет (от 150 ⭐️)</span>

              </>

            )}

          </button>

        </div>



        <p className="text-center text-[10px] text-white/20 mt-6">v3.2 Premium</p>

      </main>



      {/* Store Modal */}

      {showStore && (

        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm">

          <div className="bg-[#141414] rounded-t-3xl sm:rounded-3xl p-6 w-full max-w-sm shadow-2xl border border-white/10 max-h-[85vh] overflow-y-auto">

            <div className="flex items-center justify-between mb-5">

              <h3 className="text-xl font-medium text-white">Купить генерации</h3>

              <button onClick={() => setShowStore(false)} className="text-white/40 hover:text-white transition-colors">

                <X className="w-5 h-5" />

              </button>

            </div>



            <div className="space-y-3 mb-5">

              {catalog.map((pkg) => (

                <div

                  key={pkg.id}

                  onClick={() => setSelectedStorePkg(pkg.id)}

                  className={`relative p-4 rounded-2xl border cursor-pointer transition-all duration-200 ${

                    selectedStorePkg === pkg.id

                      ? 'border-[#c084fc] bg-[#c084fc]/10 shadow-[0_0_15px_rgba(192,132,252,0.1)]'

                      : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]'

                  }`}

                >

                  {pkg.badge && (

                    <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-gradient-to-r from-[#c084fc] to-[#a855f7] rounded-full text-[9px] font-bold tracking-wider uppercase text-white">

                      {pkg.badge}

                    </div>

                  )}

                  <div className="flex items-center justify-between">

                    <div>

                      <span className="font-medium text-[15px] text-white">{pkg.title}</span>

                      <p className="text-[12px] text-white/50 mt-0.5">+{pkg.generations} фото</p>

                    </div>

                    <div className="text-right">

                      <div className="text-[18px] font-bold text-white">{pkg.starsPrice} ⭐️</div>

                      <div className="text-[11px] text-white/40 mt-0.5">(~{pkg.priceBYN} BYN / {pkg.priceRUB} RUB)</div>

                    </div>

                  </div>

                </div>

              ))}

            </div>



            <button

              onClick={() => handlePurchase(selectedStorePkg)}

              disabled={!selectedStorePkg}

              className="w-full h-14 bg-gradient-to-r from-[#c084fc] to-[#a855f7] text-white font-medium rounded-xl hover:opacity-90 transition-opacity flex items-center justify-center gap-2 disabled:opacity-50"

            >

              <Star className="w-5 h-5" />

              <span>Оплатить {selectedStorePkg ? catalog.find(p => p.id === selectedStorePkg)?.starsPrice + ' ⭐️' : ''}</span>

              <Star className="w-5 h-5" />

            </button>

          </div>

        </div>

      )}

    </div>

  );

}

