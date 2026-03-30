import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Sparkles, ArrowRight, Send, Wand2, Download, MoreVertical, Image as ImageIcon, Camera, User, Crown } from "lucide-react";

export default function Result() {
  const { id } = useParams();
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/status/${id}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.status === "completed") {
          setResultUrl(data.resultUrl);
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });
  }, [id]);

  if (loading) return <div className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center font-sans">Загрузка...</div>;

  return (
    <div className="bg-[#0a0a0a] text-white font-sans min-h-screen flex flex-col overflow-x-hidden selection:bg-purple-500/30">
      <header className="fixed top-0 w-full z-50 bg-black/40 backdrop-blur-xl flex items-center justify-between px-6 h-16 border-b border-white/5">
        <div className="flex items-center gap-2">
          <Sparkles className="text-[#d8b4fe] w-5 h-5" />
          <span className="font-medium tracking-wide text-lg text-white">MyAURA</span>
        </div>
        <button className="text-white/60 hover:text-white transition-colors active:scale-95 duration-200">
          <MoreVertical className="w-6 h-6" />
        </button>
      </header>

      <main className="flex-grow pt-24 pb-32 px-6 flex flex-col items-center max-w-lg mx-auto w-full">
        <div className="w-full mb-8 text-center">
          <h1 className="text-3xl font-light tracking-tight mb-2">
            Ваш образ готов
          </h1>
          <p className="text-white/60 text-[15px] font-light leading-relaxed">
            Вот ваш бесплатный preview
          </p>
        </div>

        <div className="relative w-full aspect-[4/5] mb-10">
          <div className="absolute -inset-4 bg-[#c084fc]/10 blur-[60px] rounded-full opacity-50 pointer-events-none"></div>
          <div className="relative w-full h-full bg-white/[0.02] border border-white/10 rounded-2xl overflow-hidden shadow-[0_20px_40px_rgba(192,132,252,0.05)]">
            {resultUrl ? (
              <img src={resultUrl} alt="Result" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-white/50">Ошибка загрузки</div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent pointer-events-none"></div>
            
            <div className="absolute top-4 right-4 backdrop-blur-md bg-black/40 px-3 py-1.5 rounded-full border border-white/10 flex items-center gap-1.5">
              <Sparkles className="text-[#d8b4fe] w-3 h-3" />
              <span className="text-[10px] font-medium uppercase tracking-widest text-white/90">Preview</span>
            </div>
          </div>
        </div>

        <div className="w-full space-y-5 flex flex-col items-center">
          <Link to="/premium" className="w-full h-14 bg-gradient-to-r from-[#c084fc] to-[#a855f7] rounded-2xl text-white font-medium text-[15px] flex items-center justify-center gap-2 shadow-[0_0_30px_rgba(168,85,247,0.3)] hover:shadow-[0_0_40px_rgba(168,85,247,0.4)] transition-all active:scale-[0.98]">
            <Crown className="w-4 h-4 text-white/90" />
            <span>Создать Premium HD</span>
            <ArrowRight className="w-4 h-4 text-white/70 ml-1" />
          </Link>
          
          <div className="flex items-center gap-2">
            <Send className="text-white/40 w-4 h-4" />
            <p className="text-[12px] font-light text-white/50">
              Результат также отправлен в Telegram
            </p>
          </div>
        </div>

        <div className="w-full mt-10 grid grid-cols-2 gap-3">
          <Link to="/upload" className="bg-white/[0.03] border border-white/5 p-4 rounded-2xl flex flex-col items-center justify-center gap-2 hover:bg-white/[0.05] transition-colors cursor-pointer group">
            <Wand2 className="text-[#d8b4fe] w-5 h-5" />
            <span className="text-[12px] font-medium text-white/70 group-hover:text-white transition-colors">Изменить стиль</span>
          </Link>
          <a href={resultUrl || "#"} download="myaura-result.jpg" className="bg-white/[0.03] border border-white/5 p-4 rounded-2xl flex flex-col items-center justify-center gap-2 hover:bg-white/[0.05] transition-colors cursor-pointer group">
            <Download className="text-[#d8b4fe] w-5 h-5" />
            <span className="text-[12px] font-medium text-white/70 group-hover:text-white transition-colors">Сохранить</span>
          </a>
        </div>
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
    </div>
  );
}
