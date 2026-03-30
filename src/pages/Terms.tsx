import { Link } from "react-router-dom";
import { ArrowLeft, FileText } from "lucide-react";

export default function Terms() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans pb-32 selection:bg-purple-500/30">
      <header className="fixed top-0 w-full z-50 bg-black/40 backdrop-blur-xl flex items-center px-6 h-16 border-b border-white/5">
        <Link to="/" className="text-white/60 hover:text-white transition-colors">
          <ArrowLeft className="w-6 h-6" />
        </Link>
        <span className="ml-4 font-medium text-lg tracking-wide">Условия использования</span>
      </header>
      
      <main className="pt-24 px-6 max-w-2xl mx-auto space-y-10">
        <div className="flex items-center gap-4 mb-10">
          <FileText className="w-10 h-10 text-[#d8b4fe]" />
          <h1 className="text-3xl font-light tracking-tight">Условия Сервиса</h1>
        </div>

        <section className="space-y-3">
          <h2 className="text-[18px] font-medium text-[#e9d5ff]">1. Принятие условий</h2>
          <p className="text-white/60 text-[15px] leading-relaxed font-light">
            Используя сервис MyAURA, вы соглашаетесь с настоящими Условиями использования. Вы подтверждаете, что вам исполнилось 18 лет, или вы используете сервис с согласия родителей или законных опекунов.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-[18px] font-medium text-[#e9d5ff]">2. Загрузка контента</h2>
          <p className="text-white/60 text-[15px] leading-relaxed font-light">
            Вы гарантируете, что обладаете всеми правами на загружаемые фотографии. Запрещается загружать фотографии других людей без их явного согласия, а также материалы, нарушающие закон, содержащие насилие, порнографию или разжигающие ненависть. Мы оставляем за собой право удалять контент, нарушающий данные правила.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-[18px] font-medium text-[#e9d5ff]">3. Использование ИИ и результаты</h2>
          <p className="text-white/60 text-[15px] leading-relaxed font-light">
            Результаты генерации создаются с помощью передовых моделей искусственного интеллекта (Vertex AI). Мы не гарантируем 100% сходство или идеальное качество в каждом случае, так как результат зависит от качества исходных фотографий и особенностей работы алгоритмов нейросетей.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-[18px] font-medium text-[#e9d5ff]">4. Оплата и возвраты (Premium)</h2>
          <p className="text-white/60 text-[15px] leading-relaxed font-light">
            Оплата за Premium-пакеты взимается перед началом обработки (например, через Telegram Stars). В случае технического сбоя на нашей стороне, из-за которого результат не был получен, мы предоставляем возможность повторной генерации или возврат средств по запросу в поддержку. Возврат средств за успешно сгенерированные изображения надлежащего качества не предусмотрен.
          </p>
        </section>
      </main>
    </div>
  );
}
