# Випуск нової версії розширення (для maintainer)

Єдиний канал дистрибуції — **Chrome Web Store**. Off-store канал (zip через бота,
запис релізу в прод-БД, привілейований applier) **ретайрнуто** в #267.

## Реліз у стор (#266)

```bash
npm run release:store                 # package:store → upload → submit for review
npm run release:store -- --dry-run    # лише креденшели + preflight, нічого не мутує
```

Спершу підніми версію в `extension/package.json`: preflight відмовиться перезаливати
версію, яку чернетка в сторі вже несе.

Store-збірка пишеться в **окремий** файл `warsaw-beer-overlay-<version>-store.zip` — вона
не той самий артефакт, що dev-zip (без `key`, вужчі дозволи), і не має його затирати.

### Одноразовий OAuth-сетап

1. Проєкт у Google Cloud → увімкнути **Chrome Web Store API**.
2. OAuth consent screen → **External**, далі **Publish app**, щоб статус став
   **In production**. У режимі *Testing* Google видає refresh-токени з життям 7 днів —
   автоматизація тихо помре між релізами.
3. Credentials → OAuth client ID → тип **Desktop app** → client id/secret у `.env` як
   `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET`.
4. `npm run cws:auth` → відкрий URL (він же у `./tmp/cws-auth-url.txt`), дай доступ, тоді
   перенеси рядок `CWS_REFRESH_TOKEN=…` з `./tmp/cws-env.txt` у `.env`. Якщо браузер не
   дістає до `http://127.0.0.1:8976` (напр. він на іншій машині), візьми значення `code=`
   з адресного рядка: `npm run cws:auth -- --code <значення>`.
5. `npm run cws:auth -- --verify` має надрукувати рядок `OK — item …`.

Пізніший `invalid_grant` означає або відкликаний доступ, або consent screen, що з'їхав
назад у *Testing* — повтори крок 4.

## Дебажна збірка (лише для мейнтейнера)

`cd extension && npm run build` — хук `postbuild` кладе
`extension/warsaw-beer-overlay-<version>.zip`. Скачай цей один архів із сервера,
розпакуй локально й постав через chrome://extensions → Load unpacked.
Секція в `CHANGELOG.md` більше не потрібна, тож неопубліковані версії теж збираються.
