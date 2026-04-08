import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Sparkles, Check, AlertTriangle } from "lucide-react";

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

  useEffect(() => {
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/status/${id}`);
        const data = await res.json();

        if (data.progress) {
          setProgress(data.progress);
        }
        setStatus(data.status);
        setEtaText(data.etaText ?? null);

        if (data.status === "completed" || data.status === "partial") {
          clearInterval(poll);
          setTimeout(() => navigate(`/result/${id}`), 800);
        } else if (data.status === "failed") {
          clearInterval(poll);
          alert("Ошибка генерации: " + (data.error || "Неизвестная ошибка"));
          navigate("/");
        }
      } catch (err) {
        console.error("Polling error", err);
      }
    }, 2000);

    return () => clearInterval(poll);
  }, [id, navigate]);

  const pct = progress.total > 0
    ? Math.round(((progress.completed + progress.failed) / progress.total) * 100)
    : 0;
  const isMulti = progress.total > 1;

  return (
    <div className="bg-[#0a0a0a] text-white font-sans min-h-screen flex flex-col items-center justify-center p-6 overflow-hidden relative selection:bg-purple-500/30">
      <header className="fixed top-0 w-full z-50 flex justify-between items-center px-6 py-8 bg-gradient-to-b from-black/80 to-transparent">
        <div className="text-[#d8b4fe] font-medium tracking-wide text-xl">MyAURA</div>
      </header>

      <main className="relative flex flex-col items-center justify-center w-full max-w-md mx-auto z-10">
        <div className="absolute -top-40 -left-20 w-80 h-80 blur-[120px] bg-[#c084fc]/20 rounded-full pointer-events-none"></div>
        <div className="absolute -bottom-40 -right-20 w-96 h-96 blur-[120px] bg-[#a855f7]/10 rounded-full pointer-events-none"></div>

        <div className="relative w-64 h-64 mb-16 flex items-center justify-center">
          <div className="absolute inset-0 border border-white/5 rounded-full animate-pulse scale-110"></div>
          <div className="absolute inset-4 border-2 border-transparent border-t-[#c084fc] border-r-[#c084fc]/20 rounded-full animate-[spin_3s_linear_infinite]"></div>
          
          <div className="relative w-48 h-48 rounded-full bg-white/[0.02] border border-white/5 flex flex-col items-center justify-center shadow-[0_0_50px_rgba(192,132,252,0.1)] overflow-hidden backdrop-blur-sm">
            <div className="absolute inset-0 bg-gradient-to-tr from-[#c084fc]/10 to-transparent"></div>
            <Sparkles className="text-[#d8b4fe] w-10 h-10 mb-3" />
            <div className="text-[11px] uppercase tracking-[0.2em] text-white/50 font-medium">
              {status === "processing" ? "Обработка" : "Готово"}
            </div>
          </div>
        </div>

        <div className="text-center space-y-4 px-4">
          <h1 className="text-3xl font-light tracking-tight text-white leading-tight">
            {isMulti ? "Генерируем портреты..." : "Создаем ваш образ..."}
          </h1>
          {isMulti ? (
            <>
              <p className="text-white/60 text-[15px] font-light leading-relaxed max-w-[280px] mx-auto">
                Готово {progress.completed} из {progress.total}
                {progress.failed > 0 && (
                  <span className="text-red-400/80"> ({progress.failed} с ошибкой)</span>
                )}
              </p>
              <p className="text-[#c084fc]/80 text-[14px] font-light">
                Осталось примерно {etaText ?? "несколько минут"}
              </p>
              <p className="text-white/35 text-[12px] font-light max-w-[260px] mx-auto leading-relaxed">
                Фото приходят постепенно — первые результаты могут появиться раньше
              </p>
            </>
          ) : (
            <p className="text-white/60 text-[15px] font-light leading-relaxed max-w-[280px] mx-auto">
              Магия ИИ подбирает идеальный стиль на основе ваших черт.
            </p>
          )}
        </div>

        <div className="mt-16 w-full space-y-4">
          <div className="flex items-center gap-4 px-6 py-4 rounded-2xl bg-white/[0.05] border border-white/10 transition-all duration-500">
            <div className="relative flex-shrink-0">
              <div className="w-6 h-6 rounded-full bg-[#c084fc] flex items-center justify-center">
                <Check className="text-white w-4 h-4" />
              </div>
            </div>
            <span className="text-white/90 font-medium text-[15px]">Анализируем фото</span>
          </div>

          <div className={`flex items-center gap-4 px-6 py-4 rounded-2xl border transition-all duration-500 ${
            progress.completed > 0 ? "bg-white/[0.05] border-white/10" : "bg-white/[0.03] border-white/5"
          }`}>
            <div className="relative flex-shrink-0">
              {progress.completed > 0 && (progress.completed + progress.failed) >= progress.total ? (
                <div className="w-6 h-6 rounded-full bg-[#c084fc] flex items-center justify-center">
                  <Check className="text-white w-4 h-4" />
                </div>
              ) : (
                <div className="w-6 h-6 rounded-full border-2 border-white/10 border-t-[#c084fc] animate-spin"></div>
              )}
            </div>
            <span className="text-white/90 font-medium text-[15px]">
              {isMulti ? "Генерация изображений" : "Подбираем стиль"}
            </span>
            <span className="ml-auto text-[#d8b4fe] text-[12px] font-medium">{pct}%</span>
          </div>

          {progress.failed > 0 && (
            <div className="flex items-center gap-4 px-6 py-4 rounded-2xl bg-red-500/5 border border-red-500/10 transition-all duration-500">
              <div className="relative flex-shrink-0">
                <AlertTriangle className="w-5 h-5 text-red-400/70" />
              </div>
              <span className="text-red-400/80 font-medium text-[14px]">
                {progress.failed} {progress.failed === 1 ? "изображение" : "изображений"} не удалось
              </span>
            </div>
          )}

          <div className={`flex items-center gap-4 px-6 py-4 rounded-2xl border transition-all duration-500 ${
            (progress.completed + progress.failed) >= progress.total
              ? "bg-white/[0.05] border-white/10"
              : "bg-white/[0.01] border-white/5 opacity-50"
          }`}>
            <div className="relative flex-shrink-0">
              <div className="w-6 h-6 rounded-full border border-white/20 flex items-center justify-center">
                <div className="w-1.5 h-1.5 rounded-full bg-white/20"></div>
              </div>
            </div>
            <span className="text-white/60 font-medium text-[15px]">Готовим результат</span>
          </div>
        </div>
      </main>

      <footer className="fixed bottom-12 w-full text-center px-12 opacity-50">
        <p className="text-[12px] text-white/60 font-light tracking-wide">
          Пожалуйста, не закрывайте приложение
        </p>
      </footer>
    </div>
  );
}
