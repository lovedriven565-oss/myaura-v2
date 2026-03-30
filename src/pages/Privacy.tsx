import { Link } from "react-router-dom";
import { ArrowLeft, Shield } from "lucide-react";

export default function Privacy() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans pb-32 selection:bg-purple-500/30">
      <header className="fixed top-0 w-full z-50 bg-black/40 backdrop-blur-xl flex items-center px-6 h-16 border-b border-white/5">
        <Link to="/" className="text-white/60 hover:text-white transition-colors">
          <ArrowLeft className="w-6 h-6" />
        </Link>
        <span className="ml-4 font-medium text-lg tracking-wide">Политика конфиденциальности</span>
      </header>
      
      <main className="pt-24 px-6 max-w-2xl mx-auto space-y-10">
        <div className="flex items-center gap-4 mb-10">
          <Shield className="w-10 h-10 text-[#d8b4fe]" />
          <h1 className="text-3xl font-light tracking-tight">Privacy-First Подход</h1>
        </div>

        <section className="space-y-3">
          <h2 className="text-[18px] font-medium text-[#e9d5ff]">1. Временное хранение фото (Cloudflare R2)</h2>
          <p className="text-white/60 text-[15px] leading-relaxed font-light">
            Мы не храним ваши фотографии постоянно на наших серверах. Все загруженные изображения надежно сохраняются в изолированном S3-совместимом хранилище (Cloudflare R2) и автоматически удаляются:
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Оригиналы для бесплатных генераций — через <strong>24 часа</strong>.</li>
              <li>Исходные фото для Premium-пакетов — через <strong>72 часа</strong>.</li>
              <li>Сгенерированные результаты — через <strong>7 дней</strong>.</li>
            </ul>
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-[18px] font-medium text-[#e9d5ff]">2. Безопасная архитектура (Европа)</h2>
          <p className="text-white/60 text-[15px] leading-relaxed font-light">
            Наш бэкенд и базы данных физически расположены в Европе, обеспечивая соответствие строгим стандартам защиты данных (GDPR). Метаданные заказов (без самих фотографий) хранятся в защищенной базе данных Supabase (PostgreSQL) в течение <strong>12 месяцев</strong> для истории ваших заказов и аналитики сервиса.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-[18px] font-medium text-[#e9d5ff]">3. Передача данных ИИ (Vertex AI)</h2>
          <p className="text-white/60 text-[15px] leading-relaxed font-light">
            Для создания образов мы используем передовые модели ИИ (Google Vertex AI). Взаимодействие с ИИ происходит <strong>исключительно через наш защищенный бэкенд</strong>. Клиентское приложение никогда не отправляет ваши фото напрямую в Google. Ваши фотографии передаются провайдеру ИИ только для генерации результата и <strong>не используются</strong> для обучения публичных моделей.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-[18px] font-medium text-[#e9d5ff]">4. Отсутствие скрытых профилей</h2>
          <p className="text-white/60 text-[15px] leading-relaxed font-light">
            Мы не создаем скрытые профили пользователей и не продаем биометрические данные третьим лицам. На VPS-серверах приложения нет постоянного хранилища фотографий — вся работа с файлами происходит в оперативной памяти или через защищенное S3-хранилище.
          </p>
        </section>
      </main>
    </div>
  );
}
