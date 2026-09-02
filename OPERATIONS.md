# Running the backend

Operational notes for the hardening added in the crash-safety + caching pass.
Everything here is optional to configure — the defaults are what the clinic
box should want.

---

## 1. Backups — do this first

Nothing else in this document protects your data. A crashed process restarts
in a second; a dead disk without a backup ends the practice's records.

```bash
npm run backup
```

Writes to `backend/backups/`:

| File | What |
|---|---|
| `db-<stamp>.sql.gz` | `pg_dump` of the whole database, gzipped |
| `uploads-<stamp>.tar.gz` | the `uploads/` directory |

Requires `pg_dump` on `PATH` (PostgreSQL client tools). Exits non-zero on
failure, so a scheduler can alert you rather than silently producing nothing.

**Schedule it.** Windows Task Scheduler, nightly:

```
Program:   node
Arguments: scripts\backup.js
Start in:  D:\Life\For Doc\code\backend
```

Or on Linux, `crontab -e`:

```
15 2 * * *  cd /path/to/backend && /usr/bin/node scripts/backup.js >> logs/backup.log 2>&1
```

**Then copy them off the machine.** These land on the same disk as the
database — that covers a bad migration or a mistaken delete, not disk failure,
theft or ransomware. The clinic Drive folder this app already syncs to is a
reasonable second home.

**Verify a restore once.** An untested backup is a guess:

```bash
createdb restore_test
gunzip -c backups/db-<stamp>.sql.gz | psql restore_test
psql restore_test -c "SELECT count(*) FROM patients;"
dropdb restore_test
```

| Env | Default | |
|---|---|---|
| `BACKUP_DIR` | `backend/backups` | where dumps go |
| `BACKUP_KEEP_DAYS` | `14` | older dumps are pruned |

---

## 2. New environment variables

All optional. Defaults suit a single clinic box.

| Env | Default | What it does |
|---|---|---|
| `TRUST_PROXY` | off | Set to `1` **only if** nginx/Caddy sits in front. Without it every request looks like `127.0.0.1` and the rate limiter treats the whole clinic as one caller. With it set while *not* behind a proxy, anyone can forge their IP. |
| `RATE_LIMIT_MAX` | `600` | API requests per IP per minute |
| `RATE_LIMIT_LOGIN_MAX` | `20` | sign-in attempts per IP per 15 min |
| `RATE_LIMIT_DISABLED` | off | `1` turns rate limiting off entirely |
| `REQUEST_TIMEOUT_MS` | `60000` | answer 504 rather than hold a socket forever. Multipart uploads are exempt — cutting a 60 MB upload short would corrupt it. |

---

## 3. Checking it is working

```bash
curl http://16.171.10.44:4000/api/health
```

```json
{
  "ok": true,
  "uptime_s": 3600,
  "memory_mb": { "rss": 145.9, "heap": 59.5 },
  "cache": { "entries": 12, "live": 9, "max": 500 }
}
```

- **`cache.live` above 0** after browsing an admin Drive screen means the
  folder cache is doing its job. All zeros forever means every request is
  still paying the full 1.5–4 s round-trip to Google.
- **`memory_mb.rss` approaching 400** is the number to watch: PM2 restarts the
  process at `max_memory_restart: '400M'`.

---

## 4. What happens now when things break

| Situation | Before | Now |
|---|---|---|
| Google refresh token expires | **whole backend died**, every user dropped | `409 drive_reauth_required` with instructions to reconnect |
| Drive rate-limits the account | generic `500` | `503 drive_rate_limited`, "retry in a moment" |
| Base folder deleted in Drive | generic `500` | `404 drive_not_found`, "re-pick the base folder" |
| A rejected promise anywhere | process exits, PM2 restarts | logged, that one request fails, everyone else unaffected |
| A genuinely uncaught throw | abrupt exit | drains in-flight requests, then exits for PM2 to restart |
| PM2 restart / deploy | in-flight saves cut off | `SIGINT`/`SIGTERM` drains first (8 s grace) |
| Request hangs on Drive | held forever | `504` after 60 s |

---

## 5. Still worth doing

Not done in this pass, in rough priority order:

1. **Serve static files from nginx/Caddy.** Node currently serves the Flutter
   web bundle and `/uploads` ([server.js](server.js)). Moving that off Node
   frees the event loop for API work and is the second-largest win after the
   Drive cache.
2. **Prune old uploads.** `uploads/` only grows. A full disk stops Postgres
   writing, which stops everything.
3. **`multer.memoryStorage()` in [routes/drive.js](routes/drive.js)** holds a
   25 MB upload in RAM. A few concurrent uploads can reach the 400 MB restart
   ceiling; disk storage would not.
