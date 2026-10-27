# SNEG на Railway

Рабочий сервис развёрнут 27 октября 2026 года в отдельном проекте **SNEG**.

- [Проект Railway](https://railway.com/project/5b5a5ac4-d38a-48d9-b09f-c12109fe6988).
- [Кабинет](https://sneg-production.up.railway.app) — вход через Telegram.
- [Бот](https://t.me/sneg_ugc_bot).
- [Анкета кандидата](https://t.me/sneg_ugc_bot?start=c_sneg-october).
- Источник: `keshanovi4/ugc_creator`, ветка `main`.

## Единственная рабочая база

Сервис `sneg` использует SQLite `/app/data/ugc.sqlite` на постоянном диске `sneg-volume`. Перенесены SN-0001, SN-0002, история, очередь и зашифрованные подключения Threads/Gemini. Локальный обработчик остановлен, webhook и меню Telegram направлены на Railway. Компьютер владельца больше не нужен для работы бота.

Старый локальный файл остаётся резервной копией. Не запускайте параллельно локальный обработчик и не переключайте webhook обратно: появятся две независимые базы. Локальный контроллер проверяет webhook и отказывается перехватывать бота, подключённого к другому серверу.

## Настройки сервиса

| Настройка | Значение |
| --- | --- |
| Root Directory | `/sneg-ugc` |
| Builder / Dockerfile | `Dockerfile.railway` |
| Start Command | Docker CMD: `node server/index.mjs` |
| Healthcheck | `/healthz`, таймаут 180 секунд |
| Replicas | `1` |
| Serverless / App Sleeping | выключено |
| Restart Policy | On Failure, до 10 повторов |
| Volume Mount Path | `/app/data` |
| Публичный порт | `3000` |
| Регион текущего размещения | `us-west2` |

Entrypoint подготавливает права только каталога данных и передаёт управление пользователю `node` с UID 1000. Работа сервера и владение базой под UID 1000 проверены в контейнере. `RAILWAY_RUN_UID=0` не нужен. Дополнительный Postgres или второй сервис не используются.

Подключён GitHub: изменения `main` автоматически развёртываются. При обновлении сервиса с Volume возможен короткий перерыв. Не увеличивайте число реплик SQLite-сервиса.

## Variables

```dotenv
NODE_ENV=production
DEMO_MODE=false
PILOT_MODE=false
TRUST_RAILWAY_PROXY=true
HOST=0.0.0.0
PORT=3000
PUBLIC_URL=https://sneg-production.up.railway.app
DATABASE_PATH=/app/data/ugc.sqlite
BACKUP_DIRECTORY=/app/data/backups
BOT_USERNAME=sneg_ugc_bot
BUSINESS_TIMEZONE=Asia/Almaty
WORKER_INTERVAL_MS=2000
AI_MIN_INTERVAL_MS=5000
AI_DAILY_LIMIT=400
```

`CANONICAL_URL` у действующего сервиса пустой. Непустое значение превращает сервер в перенаправление без базы и обработчика. Не задавайте здесь старый локальный адрес.

В Railway Variables также сохранены приватные `BOT_TOKEN`, `ADMIN_IDS`, `SESSION_SECRET`, `TELEGRAM_WEBHOOK_SECRET` и `INTEGRATION_SECRET`. Значения отсутствуют в репозитории. Ключ шифрования интеграций сохранён при переносе; его изменение потребует повторного подключения Threads и Gemini. Менеджеров добавляют в «Настройки» → «Команда». `MANAGER_IDS` поддерживается для совместимости; отзыв в команде перекрывает его.

Подключение Gemini и длительный доступ Threads хранятся зашифрованно в базе. `AI_PROVIDER=rules` — резервное значение окружения, сохранённое подключение Gemini имеет приоритет. `PILOT_MODE=false`; production игнорирует старый обход готовности. Компания — SNEG, внешний URL необязателен. В форме показано объяснение использования ответов для отбора и связи в Telegram. Перед открытием новых наборов владелец проверяет бриф и условия.

## Telegram и Threads

Webhook: `https://sneg-production.up.railway.app/telegram/webhook`. При переносе ожидающие сообщения не удалялись. Меню, подборка и сохранённые кнопки менеджера обновлены на Railway.

Для осознанного повторного переключения после проверки HTTPS:

```sh
node scripts/setup-telegram.mjs --replace-webhook
```

Callback приложения Meta: `https://sneg-production.up.railway.app/auth/threads/callback`. Подключённый профиль — `@ugc_pilot_lab_2026`; профиль бренда подключается отдельно владельцем. Проверка размещения не создаёт новых публикаций.

## Копии и восстановление

В контейнере можно создать согласованную копию работающей WAL-базы:

```sh
node scripts/backup.mjs
```

Каталог `/app/data/backups` сохраняется при redeploy. Копия после переноса проверена: `integrity_check=ok`, обе заявки присутствуют. Финальная копия также сохранена на компьютере владельца вне GitHub.

Приложение само создаёт проверенную копию каждые 24 часа и оставляет последние 14. Владелец может создать и скачать её в «Настройки» → «Состояние и копии». Ручная команда выше дополнительное расписание не создаёт. Снимки Railway Volume и их расписание требуют Pro; API текущего workspace отклонил их включение. Копии на том же диске не заменяют внешний архив. Тариф автоматически не меняется.

Для восстановления сначала остановите обработчик. Загрузите проверенную копию под новым именем на Volume, задайте новый `DATABASE_PATH`, проверьте прежний `INTEGRATION_SECRET` и запустите один экземпляр. Не перезаписывайте открытую SQLite-базу или её WAL/SHM-файлы.

## Проверка после обновления

1. `/healthz` возвращает 200 и `{"ok":true}`; `forwarding:true` у рабочего сервиса быть не должно.
2. `/api/session` без входа возвращает 401.
3. Менеджер видит очередь и поиск; кандидат — свою анкету, чужая карточка возвращает 403.
4. После redeploy сохранены заявки, история и подключения.
5. Telegram `getWebhookInfo` указывает Railway, без ожидающих обновлений и ошибок доставки.

Подробные фактические проверки — в [отчёте QA](../UGC-QA-2026-10-27.md).

Официальная документация: [CLI](https://docs.railway.com/cli), [Volumes](https://docs.railway.com/volumes/reference), [домены](https://docs.railway.com/networking/domains/working-with-domains).
