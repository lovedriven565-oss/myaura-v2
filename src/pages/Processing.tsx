import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Sparkles, Check, AlertTriangle, Clock } from "lucide-react";

function getActiveGenKey(): string {
  const uid = (window as any).Telegram?.WebApp?.initDataUnsafe?.user?.id;
  return uid ? `myaura_active_gen_${uid}` : "myaura_active_gen";
}

function getTgUserId(): string | null {
  const uid = (window as any).Telegram?.WebApp?.initDataUnsafe?.user?.id;
  return uid ? String(uid) : null;
}

const TIMEOUT_MS = 240 * 60 * 1000; // 4 hours hard ceiling (to comfortably support 100+ photo Max package generations)

const PROCESSING_MESSAGES = [
  "Анализируем черты лица...",
  "Настраиваем освещение...",
  "Подбираем текстуру кожи...",
  "Применяем стиль...",
  "Финальный рендеринг...",
  "Проверяем качество...",
  "Балансируем тени и свет...",
  "Полируем детали...",
];

interface ProgressData {
  completed: number;
  failed: number;
  total: number;
}

export default function Processing() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [progress, setProgress] = useState<ProgressData>({ completed: 0, failed: 0, total: 1 });
  const [status, setStatus] = useState<string>("processing");
  const [etaText, setEtaText] = useState<string | null>(null);
  const [msgIndex, setMsgIndex] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const [timeoutCountdown, setTimeoutCountdown] = useState(5);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cycle status messages every 3.5s
  useEffect(() => {
    const t = setInterval(() => setMsgIndex(i => (i + 1) % PROCESSING_MESSAGES.length), 3500);
    return () => clearInterval(t);
  }, []);

  // Hard timeout: 7 minutes from mount
  useEffect(() => {
    const t = setTimeout(() => {
      if (pollRef.current) clearInterval(pollRef.current);
      localStorage.removeItem(getActiveGenKey());
      setTimedOut(true);
      // Countdown then auto-redirect
      let count = 5;
      const cd = setInterval(() => {
        count -= 1;
        setTimeoutCountdown(count);
        if (count <= 0) {
          clearInterval(cd);
          navigate("/", { replace: true });
        }
      }, 1000);
    }, TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCancel = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    localStorage.removeItem(getActiveGenKey());
    // Fire-and-forget: mark generation as cancelled on backend
    const tg = (window as any).Telegram?.WebApp;
    fetch(`/api/cancel/${id}`, {
      method: "POST",
      headers: { "X-Init-Data": tg?.initData || "" },
    }).catch(() => {});
    navigate("/", { replace: true });
  };

  useEffect(() => {
    const tgUserId = getTgUserId();
    const statusUrl = tgUserId ? `/api/status/${id}?tgUserId=${tgUserId}` : `/api/status/${id}`;

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(statusUrl);

        // 403 = stale/foreign session in localStorage → silently clean up and go home
        if (res.status === 403) {
          if (pollRef.current) clearInterval(pollRef.current);
          localStorage.removeItem(getActiveGenKey());
          navigate("/", { replace: true });
          return;
        }

        const data = await res.json();

        if (data.progress) setProgress(data.progress);
        setStatus(data.status);
        setEtaText(data.etaText ?? null);

        const prog = data.progress || { completed: 0, failed: 0, total: 1 };
        const allDone = prog.total > 0 && (prog.completed + prog.failed) >= prog.total;

        if (data.status === "completed" || data.status === "partial" || (allDone && prog.completed > 0)) {
          if (pollRef.current) clearInterval(pollRef.current);
          localStorage.removeItem(getActiveGenKey());
          setTimeout(() => navigate(`/result/${id}`), 800);
        } else if (data.status === "failed" || data.status === "cancelled" || (allDone && prog.completed === 0)) {
          if (pollRef.current) clearInterval(pollRef.current);
          localStorage.removeItem(getActiveGenKey());
          alert("Ошибка генерации: " + (data.error || "Неизвестная ошибка"));
          navigate("/");
        }
      } catch (err) {
        console.error("Polling error", err);
      }
    }, 6000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [id, navigate]);

  const pct = progress.total > 0
    ? Math.round(((progress.completed + progress.failed) / progress.total) * 100)
    : 0;
  const isMulti = progress.total > 1;
  const currentMsg = PROCESSING_MESSAGES[msgIndex];

  return (
    <div className="bg-[#0a0a0a] text-white font-sans min-h-screen flex flex-col items-center justify-center p-6 overflow-hidden relative selection:bg-purple-500/30">

      {/* Timeout overlay */}
      {timedOut && (
        <div className="fixed inset-0 z-[100] bg-[#0a0a0a]/98 flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-orange-500/10 border border-orange-500/20 flex items-center justify-center mb-6">
            <Clock className="text-orange-400 w-7 h-7" />
          </div>
          <h2 className="text-xl font-light text-white mb-3">Превышено время ожидания</h2>
          <p className="text-white/50 text-[14px] font-light leading-relaxed max-w-[280px] mb-8">
            Сервер занял слишком много времени. Результат придёт в Telegram, если генерация завершилась.
          </p>
          <button
            onClick={() => navigate("/", { replace: true })}
            className="px-8 py-3 rounded-2xl bg-white/[0.06] border border-white/10 text-white/80 text-[14px] font-medium hover:bg-white/[0.10] transition-all"
          >
            На главную &mdash; {timeoutCountdown}
          </button>
        </div>
      )}

      {/* Top linear progress bar */}
      <div className="fixed top-0 left-0 right-0 h-[3px] bg-white/5 z-50">
        <div
          className="h-full bg-gradient-to-r from-[#c084fc] to-[#a855f7] transition-all duration-700 ease-out"
          style={{ width: `${Math.max(4, pct)}%` }}
        />
      </div>

      <header className="fixed top-0 w-full z-40 flex justify-between items-center px-6 py-8 bg-gradient-to-b from-black/80 to-transparent">
        <div className="text-[#d8b4fe] font-medium tracking-wide text-xl">MyAURA</div>
      </header>

      <main className="relative flex flex-col items-center justify-center w-full max-w-md mx-auto z-10">
        <div className="absolute -top-40 -left-20 w-80 h-80 blur-[120px] bg-[#c084fc]/20 rounded-full pointer-events-none"></div>
        <div className="absolute -bottom-40 -right-20 w-96 h-96 blur-[120px] bg-[#a855f7]/10 rounded-full pointer-events-none"></div>

        {/* Spinner circle: shows counter for multi-photo, icon for single */}
        <div className="relative w-56 h-56 mb-8 flex items-center justify-center">
          <div className="absolute inset-0 border border-white/5 rounded-full animate-pulse scale-110"></div>
          <div className="absolute inset-4 border-2 border-transparent border-t-[#c084fc] border-r-[#c084fc]/20 rounded-full animate-[spin_3s_linear_infinite]"></div>

          <div className="relative w-44 h-44 rounded-full bg-white/[0.02] border border-white/5 flex flex-col items-center justify-center shadow-[0_0_50px_rgba(192,132,252,0.1)] overflow-hidden backdrop-blur-sm">
            <div className="absolute inset-0 bg-gradient-to-tr from-[#c084fc]/10 to-transparent"></div>
            {isMulti ? (
              <>
                <span className="text-4xl font-light text-white z-10 leading-none">{progress.completed}</span>
                <span className="text-[13px] text-white/40 z-10 mt-1">из {progress.total}</span>
              </>
            ) : (
              <>
                <Sparkles className="text-[#d8b4fe] w-9 h-9 mb-2 z-10" />
                <div className="text-[10px] uppercase tracking-[0.2em] text-white/50 font-medium z-10">
                  {status === "processing" ? "Обработка" : "Готово"}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Progress bar + cycling message for multi-photo */}
        {isMulti && (
          <div className="w-full mb-8 px-1">
            <div className="flex justify-between items-center mb-2">
              <span
                key={msgIndex}
                className="text-[12px] text-white/50 transition-opacity duration-500"
              >
                {currentMsg}
              </span>
              <span className="text-[12px] text-[#c084fc] font-medium tabular-nums">{pct}%</span>
            </div>
            <div className="w-full h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-[#c084fc] to-[#a855f7] rounded-full transition-all duration-700 ease-out"
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
          </div>
        )}

        <div className="text-center space-y-3 px-4 mb-10">
          <h1 className="text-2xl font-light tracking-tight text-white leading-tight">
            {isMulti
              ? `Генерируем ваши образы: ${progress.completed} из ${progress.total}...`
              : "Создаем ваш образ..."}
          </h1>
          {isMulti ? (
            <>
              <p className="text-[11px] uppercase tracking-[0.18em] text-[#c084fc]/60 font-medium">
                Nano Banana Pro · максимальная детализация
              </p>
              {progress.failed > 0 && (
                <p className="text-red-400/70 text-[13px] font-light">
                  {progress.failed} {progress.failed === 1 ? "не удалось" : "не удалось"}
                </p>
              )}
              <p className="text-[#c084fc]/80 text-[14px] font-light">
                {etaText ? `Осталось ~${etaText}` : "Считаем время..."}
              </p>
            </>
          ) : (
            <p className="text-white/60 text-[15px] font-light leading-relaxed max-w-[280px] mx-auto">
              {currentMsg}
            </p>
          )}
        </div>

        <div className="w-full space-y-3">
          <div className="flex items-center gap-4 px-5 py-3.5 rounded-2xl bg-white/[0.05] border border-white/10 transition-all duration-500">
            <div className="w-6 h-6 rounded-full bg-[#c084fc] flex items-center justify-center shrink-0">
              <Check className="text-white w-3.5 h-3.5" />
            </div>
            <span className="text-white/90 font-medium text-[14px]">Анализируем фото</span>
          </div>

          <div className={`flex items-center gap-4 px-5 py-3.5 rounded-2xl border transition-all duration-500 ${
            progress.completed > 0 ? "bg-white/[0.05] border-white/10" : "bg-white/[0.03] border-white/5"
          }`}>
            <div className="shrink-0">
              {(progress.completed + progress.failed) >= progress.total && progress.total > 1 ? (
                <div className="w-6 h-6 rounded-full bg-[#c084fc] flex items-center justify-center">
                  <Check className="text-white w-3.5 h-3.5" />
                </div>
              ) : (
                <div className="w-6 h-6 rounded-full border-2 border-white/10 border-t-[#c084fc] animate-spin"></div>
              )}
            </div>
            <span className="text-white/90 font-medium text-[14px]">
              {isMulti ? "Генерация изображений" : "Подбираем стиль"}
            </span>
            {!isMulti && (
              <span className="ml-auto text-[#d8b4fe] text-[12px] font-medium">{pct}%</span>
            )}
          </div>

          {progress.failed > 0 && (
            <div className="flex items-center gap-4 px-5 py-3.5 rounded-2xl bg-red-500/5 border border-red-500/10">
              <AlertTriangle className="w-5 h-5 text-red-400/70 shrink-0" />
              <span className="text-red-400/80 font-medium text-[14px]">
                {progress.failed} {progress.failed === 1 ? "изображение" : "изображений"} не удалось
              </span>
            </div>
          )}

          <div className={`flex items-center gap-4 px-5 py-3.5 rounded-2xl border transition-all duration-500 ${
            (progress.completed + progress.failed) >= progress.total
              ? "bg-white/[0.05] border-white/10"
              : "bg-white/[0.01] border-white/5 opacity-40"
          }`}>
            <div className="w-6 h-6 rounded-full border border-white/20 flex items-center justify-center shrink-0">
              <div className="w-1.5 h-1.5 rounded-full bg-white/20"></div>
            </div>
            <span className="text-white/60 font-medium text-[14px]">Готовим результат</span>
          </div>
        </div>
      </main>

      <footer className="fixed bottom-6 w-full flex flex-col items-center gap-3 px-12">
        <p className="text-[12px] text-white/30 font-light tracking-wide">
          Можете закрыть приложение — результат придёт в Telegram
        </p>
        <button
          onClick={handleCancel}
          className="text-[12px] text-white/20 hover:text-white/50 transition-colors duration-200 underline decoration-white/10 underline-offset-4"
        >
          Отменить и вернуться
        </button>
      </footer>
    </div>
  );
}
