# Бриф для Codex на прод-сервері: як бот поводився на фестивалі (лише читання)

Як користуватися: після останньої сесії фесту віддай цей файл Codex на хості. Підстав `<FEST_ID>`
(і `<SINCE>` — дату першої сесії, `YYYY-MM-DD`). Звіт піде в issue, по одному на кожну знайдену
поломку. Основа — розбір WFP22 (19.10.2026), який знайшов #883–#886 і закрив питання #880.

## Жорсткі обмеження

- **Лише читання.** SQL — через `sudo -u warsaw-beer-bot sqlite3 -readonly /var/lib/warsaw-beer-bot/bot.db`.
  Жодних рестартів і змін у `/opt`, `/etc`.
- **Не викликати Untappd і MCP.** Секретів не друкувати (`.env`, OAuth-файл не відкривати).
- **Особових даних у звіт не писати**: ні імен користувачів Untappd, ні Telegram id. Лише лічильники й час.
- Три блокування поспіль — зупинись і напиши, що заблоковано.
- Бот — systemd-юніт `warsaw-beer-bot`. Якщо лог не там, знайди його і напиши, де шукав.

## 1. Фест

```sql
SELECT session_no, start_at, end_at FROM fest_sessions WHERE fest_id = <FEST_ID> ORDER BY 1;
SELECT t.id, COUNT(m.telegram_id) FROM fest_teams t LEFT JOIN fest_team_members m ON m.team_id = t.id
 WHERE t.fest_id = <FEST_ID> GROUP BY 1;
```

## 2. Алерти в групу

```sql
-- повідомлень і пив за сесію (кожен sent_at — одне повідомлення команді)
SELECT session_no, COUNT(DISTINCT team_id || '/' || sent_at) AS messages, COUNT(*) AS beers,
       MIN(sent_at), MAX(sent_at)
  FROM fest_alerts_sent GROUP BY 1 ORDER BY 1;
-- те саме пиво під різними beer_id в одній сесії (має бути 0)
SELECT a.team_id, a.session_no, lower(b.brewery), lower(b.name), COUNT(*)
  FROM fest_alerts_sent a JOIN beers b ON b.id = a.beer_id GROUP BY 1,2,3,4 HAVING COUNT(*) > 1;
-- пив, оголошених більш ніж в одній сесії
SELECT COUNT(*) FROM (SELECT team_id, beer_id FROM fest_alerts_sent GROUP BY 1,2 HAVING COUNT(DISTINCT session_no) > 1);
-- затримка: від першого чекіну, що його довів, до надсилання (хв), середнє й максимум за сесію
SELECT a.session_no,
       ROUND(AVG((julianday(a.sent_at) - julianday(v.checkin_at)) * 1440), 1),
       ROUND(MAX((julianday(a.sent_at) - julianday(v.checkin_at)) * 1440), 1),
       SUM((julianday(a.sent_at) - julianday(v.checkin_at)) * 1440 > 15)
  FROM fest_alerts_sent a JOIN venue_checkins v ON v.checkin_id = a.checkin_id GROUP BY 1;
```

## 3. Очі: хто що бачив і з яким запізненням

```sql
-- чекінів за оком і днем; запізнення спостереження (хв): середнє і максимум
SELECT first_eye, substr(checkin_at, 1, 10) AS day, COUNT(*),
       ROUND(AVG((julianday(observed_at) - julianday(checkin_at)) * 1440), 1),
       ROUND(MAX((julianday(observed_at) - julianday(checkin_at)) * 1440), 1)
  FROM venue_checkins WHERE checkin_at >= '<SINCE>' GROUP BY 1, 2 ORDER BY 2, 1;
-- останнє спостереження кожної локації кожним оком
SELECT venue_id, first_eye, MAX(observed_at) FROM venue_checkins WHERE checkin_at >= '<SINCE>' GROUP BY 1, 2;
-- стан MCP (час і числа, не секрети)
SELECT key, value FROM job_state WHERE key LIKE 'fest_mcp_%' OR key LIKE 'fest_%feed_min_id' ORDER BY key;
```

## 4. Журнал

```
journalctl -u warsaw-beer-bot --since "<SINCE>" --no-pager -o short-iso > /tmp/fest-journal.txt
grep -cE "fest alert not delivered|fest alert failed" /tmp/fest-journal.txt
grep -E "bad_shape" /tmp/fest-journal.txt | sed -E 's/^[^ ]+ //' | cut -c1-120 | sort | uniq -c | sort -rn | head
grep -c "more new check-ins than 4 pages" /tmp/fest-journal.txt
grep -E "Request timed out|database is locked|payload too large|untappd block|fest cron" /tmp/fest-journal.txt | cut -c1-160 | tail -40
grep -E "bot launched|Started|Stopped" /tmp/fest-journal.txt | cut -c1-120
grep -c "query is too old" /tmp/fest-journal.txt
rm /tmp/fest-journal.txt
```

Перезапуски порівняй із часами сесій, а `Stopped`/`Started` перевір на перекриття двох процесів.

## 5. Черга й друк

```sql
SELECT substr(q.added_at, 1, 10), COUNT(*) FROM fest_queue q JOIN fest_teams t ON t.id = q.team_id
 WHERE t.fest_id = <FEST_ID> GROUP BY 1;
SELECT COUNT(*) FROM fest_glass_removed r JOIN fest_teams t ON t.id = r.team_id WHERE t.fest_id = <FEST_ID>;
SELECT j.status, COUNT(*), MIN(q.added_at), MAX(q.added_at), SUM(j.attempts > 1)
  FROM fest_print_jobs j JOIN fest_queue q ON q.id = j.queue_id GROUP BY 1;
SELECT kind, COUNT(*) FROM fest_presence GROUP BY 1;
SELECT COUNT(*) FROM fest_glass_marks;
-- узяті пива, яких ніколи не було в алертах
SELECT COUNT(DISTINCT q.beer_id) FROM fest_queue q
 WHERE NOT EXISTS (SELECT 1 FROM fest_alerts_sent a WHERE a.team_id = q.team_id AND a.beer_id = q.beer_id);
```

Щодо друку: `queued` у кінці фесту — не обов'язково поломка. На WFP22 станція друку поїхала з
власником поза локацію (17.10), і це було свідомо. Запиши числа, а висновок лиши людині.

## 6. Щоденний статус

Знайди в журналі або в історії повідомлень адміну, що щоденний статус показував для підсистеми
`fest` у кожен день фесту. Порівняй із поломками з п. 3–4: на WFP22 він був 🟢 усі дні (#885).
Після #885 статус бачить тишу кожного ока на головній локації та сповіщення, заглушені в сесії
(`SELECT key, value FROM job_state WHERE key LIKE 'fest_notice_at:%'`): поломка з п. 3–4, якої
статус не назвав, — окрема знахідка.

## Звіт

Сирий вивід кожного пункту (обрізаний до розумного), а наприкінці — список поломок, які видно з
даних. Для кожної: що, коли (UTC), скільки, і чи **доведено** механізм, чи це лише гіпотеза.
Дані, з яких висновок не випливає, так і познач.
