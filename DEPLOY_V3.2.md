# MyAURA v3.2 — Deploy Runbook

Этот документ описывает шаги, необходимые для развёртывания коммита `ea554d8`
(v3.2 hardening) на production-сервере `myaura.by` (Ubuntu / nginx / PM2).

## 1. Pre-deploy: secrets rotation (ОБЯЗАТЕЛЬНО)

До коммита `ea554d8` в репозиторий был закоммичен файл `setup_ssl.cjs`, содержащий
SSH-пароль пользователя `root` для сервера `91.149.179.76`. Файл удалён, но
он остаётся в истории git. До деплоя ротируй:

1. Сменить root-пароль на сервере (и/или перейти на SSH-ключи + `PasswordAuthentication no`).
2. Проверить `~/.ssh/authorized_keys` на сервере — не должно быть чужих ключей.
3. Ротировать Supabase `service_role` ключ если он мог быть скомпрометирован.

## 2. Supabase migration

Убедиться, что в SQL editor Supabase выполнена миграция referral B-lite:

```sql
-- Содержимое migrations/referral_mvp.sql
-- Идемпотентно, безопасно повторять.
```

Проверка: `SELECT referral_code FROM users LIMIT 1;` должен вернуть `ref_xxxxxxxx`.

## 3. Production .env (на сервере)

Добавить/проверить следующие переменные:

```bash
# --- Security (КРИТИЧНО) ---
INIT_DATA_STRICT="true"

# --- Server runtime ---
NODE_ENV="production"
PORT=3000

# --- Telegram bot ---
ENABLE_TELEGRAM_BOT="true"
TELEGRAM_BOT_TOKEN="..."          # уже есть

# --- Supabase ---
SUPABASE_URL="..."                # уже есть
SUPABASE_SERVICE_ROLE_KEY="..."   # уже есть, недавно синхронизирован

# --- Vertex AI models (v3.2) ---
USE_VERTEX_AI="true"
VERTEX_AI_MODEL_FREE="gemini-3.1-flash-image-preview"
VERTEX_AI_MODEL_PREMIUM="gemini-3-pro-image-preview"
VERTEX_LOCATION="global"

# --- Free flow v2 ---
FREE_MULTI_REF_V2_ENABLED="true"

# --- Frontend build-time (должны присутствовать ДО npm run build) ---
VITE_BOT_USERNAME="myaura_bot"    # подставить реальный username бота
VITE_FREE_MULTI_REF_V2_ENABLED="true"

# --- R2 storage ---
R2_ACCOUNT_ID="..."               # уже есть
R2_ACCESS_KEY_ID="..."            # уже есть
R2_SECRET_ACCESS_KEY="..."        # уже есть
R2_BUCKET_NAME="..."              # уже есть
R2_PUBLIC_BASE_URL="..."          # уже есть
```

## 4. Deploy команды (на Ubuntu-сервере)

```bash
cd /opt/myaura            # или где у тебя лежит проект
git fetch origin
git checkout main
git pull origin main

# Подтянуть helmet (новая зависимость)
npm install --production=false

# Пересобрать фронтенд + бэкенд
npm run build

# Перезапустить PM2
pm2 reload all
# или
pm2 restart myaura-app

# Проверить логи
pm2 logs myaura-app --lines 50
```

Ожидаемые строки в логах после запуска:

```
[KeyPool] Scanning ...
[KeyPool] Found N JSON key(s) in ./keys
Connected to Supabase.
Server running on http://localhost:3000 (NODE_ENV=production)
```

Не должно быть:
- `AUTH PAYLOAD:` — логи PII удалены
- `RAW REQ BODY:` — логи PII удалены
- `409: Conflict: terminated by other getUpdates request` — теперь бот запускается
  только когда `ENABLE_TELEGRAM_BOT != "false"`, и на проде должна быть ровно
  одна инстанс.

## 5. Post-deploy smoke test

Из любого клиента:

```bash
# 1. Health check (должен вернуть {"ok":true,...})
curl -s https://myaura.by/healthz

# 2. Auth без initData в strict mode должен вернуть 401 Missing initData
curl -s -w "\nHTTP %{http_code}\n" \
  -X POST https://myaura.by/api/auth \
  -H "Content-Type: application/json" \
  -d '{"telegramId":99999,"username":"attacker"}'

# 3. Balance без initData — тоже 401
curl -s -w "\nHTTP %{http_code}\n" \
  "https://myaura.by/api/user/balance?telegramId=99999"
```

Если первые 2 теста возвращают `200` — `INIT_DATA_STRICT` НЕ включён на сервере.
Немедленно проверить `.env` и перезапустить PM2.

## 6. Client-side проверка

Открыть `https://t.me/<your_bot>` и запустить Mini App:

- **Home** открывается без ошибок auth (нет красного блока "Auth Error").
- **Free flow** (`/upload`): badge показывает `1 бесплатная генерация доступна`,
  область загрузки принимает до 5 фото, подпись `Лицо крупным планом, 1-5 фото`,
  внизу `v3.2`.
- **Premium flow** (`/premium`): список стилей (business, lifestyle, cinematic,
  editorial, luxury, aura), валидация «10-15 фото», внизу `v3.2 Premium`.
- После завершения free генерации **Result** показывает кнопку
  `Пригласить друга — получить генерацию`.
- Share → открывается Telegram share с `t.me/<bot>?startapp=ref_XXXXXXXX`.
- Новый пользователь заходит по этой ссылке → после его первой completed free
  генерации реферер получает Telegram-уведомление и `+1 free_credit`.

## 7. Rollback (если что-то сломалось)

```bash
git reset --hard 15f0f8d   # предыдущий коммит (VERTEX_AI_MODEL vars)
npm install
npm run build
pm2 reload all
```
