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
          <h2 className="text-[18px] font-medium text-[#e9d5ff]">3. Как работает AI-генерация и чего ожидать</h2>
          <p className="text-white/60 text-[15px] leading-relaxed font-light">
            MyAURA использует нейросети для создания стилизованных портретов на основе ваших фотографий. Мы стараемся сохранять узнаваемость лица, общее сходство и соответствие выбранному стилю — и в большинстве случаев результат именно такой.
          </p>
          <p className="text-white/60 text-[15px] leading-relaxed font-light">
            При этом AI-генерация — это творческий процесс, а не точное копирование. Итоговое изображение может немного отличаться от ожиданий: это зависит от качества исходных фото, угла съёмки, освещения и особенностей конкретной модели. Чем лучше исходные фотографии — тем точнее и красивее результат.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-[18px] font-medium text-[#e9d5ff]">4. Оплата и возвраты (Premium)</h2>
          <p className="text-white/60 text-[15px] leading-relaxed font-light">
            Оплата за Premium-пакеты проводится через Telegram Stars до начала генерации. После успешного платежа кредиты начисляются на ваш аккаунт и используются при запуске.
          </p>
          <p className="text-white/60 text-[15px] leading-relaxed font-light">
            Мы честно разделяем две ситуации:
          </p>
          <p className="text-white/60 text-[15px] leading-relaxed font-light pl-4 border-l border-white/10">
            <span className="text-white/80">Результат просто не понравился</span> — это субъективно, и автоматический возврат в таком случае не предусмотрен. Генерация была выполнена, изображение получено.
          </p>
          <p className="text-white/60 text-[15px] leading-relaxed font-light pl-4 border-l border-white/10">
            <span className="text-white/80">Произошёл технический сбой</span> — если генерация не завершилась или результат не был доставлен по нашей вине, мы предоставим повторную генерацию или рассмотрим возврат через поддержку.
          </p>
          <p className="text-white/60 text-[15px] leading-relaxed font-light pl-4 border-l border-white/10">
            <span className="text-white/80">Явный дефект результата</span> — если лицо заметно потеряло узнаваемость, генерация явно не соответствует выбранному стилю или содержит выраженные визуальные артефакты, сервис может предоставить 1 бесплатную повторную генерацию. Решение принимается поддержкой индивидуально.
          </p>
          <p className="text-white/60 text-[15px] leading-relaxed font-light">
            По всем вопросам — напишите в поддержку через Telegram.
          </p>
        </section>
      </main>
    </div>
  );
}
