import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { Sparkles, ArrowRight, Send, Wand2, Download, X, Image as ImageIcon, Camera, User, Crown } from "lucide-react";

interface StatusData {
  status: string;
  resultUrl: string | null;
  resultUrls: string[];
  progress: { completed: number; failed: number; total: number };
  error: string | null;
}

export default function Result() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fullscreenUrl, setFullscreenUrl] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/status/${id}`)
      .then((res) => res.json())
      .then((d: StatusData) => {
        if (d.status === "processing") {
          navigate(`/processing/${id}`, { replace: true });
          return;
        }
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });
  }, [id, navigate]);

  if (loading) return <div className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center font-sans">Загрузка...</div>;

  const urls = data?.resultUrls?.length ? data.resultUrls : (data?.resultUrl ? [data.resultUrl] : []);
  const isMulti = urls.length > 1;
  const isPremium = (data?.progress?.total || 1) > 1;

  return (
    <div className="bg-[#0a0a0a] text-white font-sans min-h-screen flex flex-col overflow-x-hidden selection:bg-purple-500/30">
      <header className="fixed top-0 w-full z-50 bg-black/40 backdrop-blur-xl flex items-center justify-between px-6 h-16 border-b border-white/5">
        <div className="flex items-center gap-2">
          <Sparkles className="text-[#d8b4fe] w-5 h-5" />
          <span className="font-medium tracking-wide text-lg text-white">MyAURA</span>
        </div>
        <Link to="/" className="text-white/60 hover:text-white transition-colors active:scale-95 duration-200">
          <X className="w-6 h-6" />
        </Link>
      </header>

      <main className="flex-grow pt-24 pb-32 px-6 flex flex-col items-center max-w-lg mx-auto w-full">
        <div className="w-full mb-8 text-center">
          <h1 className="text-3xl font-light tracking-tight mb-2">
            {isPremium ? "Ваши портреты готовы" : "Ваш образ готов"}
          </h1>
          <p className="text-white/60 text-[15px] font-light leading-relaxed">
            {isPremium
              ? `${data?.progress?.completed || urls.length} из ${data?.progress?.total || urls.length} изображений`
              : "Вот ваш бесплатный preview"}
          </p>
          {data?.status === "partial" && (
            <p className="text-yellow-400/70 text-[13px] mt-1">Часть изображений не удалось сгенерировать</p>
          )}
        </div>

        {/* Single image view */}
        {!isMulti && urls.length === 1 && (
          <div className="relative w-full mb-10" style={{ maxHeight: "80vh" }}>
            <div className="absolute -inset-4 bg-[#c084fc]/10 blur-[60px] rounded-full opacity-50 pointer-events-none"></div>
            <div
              className="relative w-full bg-white/[0.02] border border-white/10 rounded-2xl overflow-hidden shadow-[0_20px_40px_rgba(192,132,252,0.05)] cursor-pointer"
              onClick={() => setFullscreenUrl(urls[0])}
            >
              <img src={urls[0]} alt="Result" className="w-full object-contain bg-black/50" style={{ maxHeight: "80vh" }} />
              <div className="absolute top-4 right-4 backdrop-blur-md bg-black/40 px-3 py-1.5 rounded-full border border-white/10 flex items-center gap-1.5">
                <Sparkles className="text-[#d8b4fe] w-3 h-3" />
                <span className="text-[10px] font-medium uppercase tracking-widest text-white/90">Preview</span>
              </div>
            </div>
          </div>
        )}

        {/* Multi image grid */}
        {isMulti && (
          <div className="w-full grid grid-cols-2 gap-3 mb-10">
            {urls.map((url, i) => (
              <div
                key={i}
                className="relative bg-white/[0.02] border border-white/10 rounded-xl overflow-hidden cursor-pointer hover:border-white/20 transition-colors"
                onClick={() => setFullscreenUrl(url)}
              >
                <img src={url} alt={`Result ${i + 1}`} className="w-full aspect-[4/5] object-cover" />
                <div className="absolute bottom-2 right-2 backdrop-blur-md bg-black/50 px-2 py-1 rounded-full border border-white/10">
                  <span className="text-[10px] font-medium text-white/80">{i + 1}/{urls.length}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* No results */}
        {urls.length === 0 && (
          <div className="w-full aspect-[4/5] mb-10 bg-white/[0.02] border border-white/10 rounded-2xl flex items-center justify-center">
            <div className="text-center text-white/50">
              <p className="text-[15px] mb-2">Результаты недоступны</p>
              {data?.error && <p className="text-[13px] text-red-400/70">{data.error}</p>}
            </div>
          </div>
        )}

        <div className="w-full space-y-5 flex flex-col items-center">
          {!isPremium && (
            <Link to="/premium" className="w-full h-14 bg-gradient-to-r from-[#c084fc] to-[#a855f7] rounded-2xl text-white font-medium text-[15px] flex items-center justify-center gap-2 shadow-[0_0_30px_rgba(168,85,247,0.3)] hover:shadow-[0_0_40px_rgba(168,85,247,0.4)] transition-all active:scale-[0.98]">
              <Crown className="w-4 h-4 text-white/90" />
              <span>Создать Premium HD</span>
              <ArrowRight className="w-4 h-4 text-white/70 ml-1" />
            </Link>
          )}
          
          <div className="flex items-center gap-2">
            <Send className="text-[#d8b4fc] w-4 h-4" />
            <p className="text-[12px] font-light text-[#d8b4fc]/90">
              ✅ Фото также отправлено в ваш Telegram-чат!
            </p>
          </div>
        </div>

        <Link to="/upload" className="w-full mt-10 bg-white/[0.03] border border-white/5 p-4 rounded-2xl flex flex-col items-center justify-center gap-2 hover:bg-white/[0.05] transition-colors cursor-pointer group">
          <Wand2 className="text-[#d8b4fe] w-5 h-5" />
          <span className="text-[12px] font-medium text-white/70 group-hover:text-white transition-colors">Изменить стиль</span>
        </Link>
      </main>

      <nav className="fixed bottom-0 left-0 w-full flex justify-around items-center px-6 pb-8 pt-4 bg-black/80 backdrop-blur-xl border-t border-white/5 z-50">
        <Link to="/" className="flex flex-col items-center justify-center text-white/40 hover:text-white transition-colors active:scale-95 duration-200">
          <ImageIcon className="w-6 h-6" />
        </Link>
        <Link to="/upload" className="flex flex-col items-center justify-center text-white/40 hover:text-white transition-colors active:scale-95 duration-200">
          <Camera className="w-6 h-6" />
        </Link>
        <div className="flex flex-col items-center justify-center bg-white/10 text-white rounded-full w-12 h-12 border border-white/10 active:scale-95 duration-200">
          <Wand2 className="w-5 h-5" />
        </div>
        <div className="flex flex-col items-center justify-center text-white/40 hover:text-white transition-colors active:scale-95 duration-200">
          <User className="w-6 h-6" />
        </div>
      </nav>

      {/* Fullscreen preview overlay */}
      {fullscreenUrl && (
        <div
          className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center p-4"
          onClick={() => setFullscreenUrl(null)}
        >
          <button
            className="absolute top-6 right-6 z-[110] w-10 h-10 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border border-white/20 hover:bg-white/20 transition-colors"
            onClick={(e) => { e.stopPropagation(); setFullscreenUrl(null); }}
          >
            <X className="w-5 h-5 text-white" />
          </button>
          <img
            src={fullscreenUrl}
            alt="Fullscreen"
            className="object-contain rounded-lg"
            style={{ maxHeight: "80vh", maxWidth: "100%" }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
