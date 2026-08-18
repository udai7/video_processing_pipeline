# Production deployment — zorvid.archilect.in

The app (nginx gateway + api + worker + postgres + minio + redis) runs via
`docker compose`. TLS is handled by **Cloudflare in front**; the origin nginx
stays on port 80 behind it.

## 1. Secrets (already set in `.env`)

- `JWT_SECRET` — strong random value (rotate with `openssl rand -hex 48`).
- `POSTGRES_PASSWORD` / `DATABASE_URL` — strong, matching. Changing the password
  requires recreating the postgres volume: `docker compose down -v` (DESTROYS
  data), then `docker compose up -d --build`.
- `MINIO_ROOT_PASSWORD` — strong; same volume caveat for MinIO.
- `SMTP_*` — Gmail app password for OTP email delivery.
- `GOOGLE_CLIENT_ID` + `VITE_GOOGLE_CLIENT_ID` — same OAuth web client ID.
  `VITE_GOOGLE_CLIENT_ID` is baked at build time → rebuild nginx after changes:
  `docker compose up -d --build nginx`.
- `MINIO_PUBLIC_URL` — set to `https://zorvid.archilect.in` in prod so HLS
  segment URLs point at the public domain.

## 2. DNS + Cloudflare (dashboard steps — do these yourself)

1. **DNS:** add an `A` record `zorvid.archilect.in` → the server's public IP,
   **proxied** (orange cloud ON).
2. **SSL/TLS mode:** Full (or Full (strict) if the origin later gets a cert).
3. **Edge certificates:** enable **Always Use HTTPS** and **HSTS**.
4. Origin firewall: only allow inbound 80/443 from Cloudflare IP ranges if you
   want to lock it down.

nginx already recovers the real visitor IP from Cloudflare's `CF-Connecting-IP`
(see `nginx/nginx.conf`), so API rate-limiting keys on the true client IP.

## 3. Google sign-in (Google Cloud Console — do yourself)

In Credentials → your OAuth 2.0 Web client → **Authorized JavaScript origins**
add `https://zorvid.archilect.in`. This flow uses ID tokens, so **no redirect
URI** is needed. The client secret is not used and need not be stored.

## 4. Launch / update

```bash
docker compose up -d --build          # build + start everything
docker compose logs -f api worker     # watch
curl -s https://zorvid.archilect.in/health   # -> {"status":"ok"}    liveness
curl -s https://zorvid.archilect.in/ready    # -> {"status":"ready"} deps reachable
```

Migrations run automatically (one-shot `migrate` service) before the API starts.

`/health` only says the process is up. `/ready` probes Postgres, Redis and
MinIO and returns 503 naming whichever is unreachable — use that one when
something looks wrong. The worker has no public route; its healthcheck runs
inside the compose network and reports whether BullMQ is still consuming.

Redeploys are safe to run mid-transcode: both services handle SIGTERM, and the
worker finishes its in-flight job before exiting (up to the 10m
`stop_grace_period`). Expect a redeploy to take as long as the running job.

### Two deploy paths — deliberate, but be aware

Deployment can be triggered **two different ways**, and both are live:

1. **Coolify** watches the repo and redeploys on push.
2. **The `deploy` job in `.github/workflows/ci.yml`** SSHes into the VPS after
   tests pass on `main` and runs `git reset --hard origin/main` +
   `docker compose up -d --build`.

They target the same host, so a push to `main` can start both at once. If a
deploy behaves oddly — a build that restarts halfway, or containers recreated
twice — this overlap is the first thing to check. Consolidating onto one path
would remove the race; keeping both is a deliberate choice for now.

## 5. Operational limits (env-tunable)

- `MAX_VIDEO_SECONDS_PER_USER=600` — per-user total upload budget (10 min).
- `VIDEO_RETENTION_DAYS=2` — uploads auto-deleted after 2 days (worker reaper).
- `MAX_UPLOAD_BYTES` — per-file size cap; oversized uploads are aborted mid-transfer.
- `LOGIN_LOCK_THRESHOLD=10` / `LOGIN_LOCK_MINUTES=15` — per-account lockout after
  repeated failed logins, on top of the per-IP rate limit.
- `STALLED_JOB_MINUTES=60` — a video with no job progress for this long is
  marked failed rather than sitting in `transcoding` forever.
- `FFMPEG_VIDEO_ENCODER` / `FFMPEG_PRESET` / `FFMPEG_HWACCEL` — unset means
  software x264; set them to use a GPU encoder.
- Auth endpoints are rate-limited (per IP); expired OTP rows are swept hourly.

## 6. Still recommended before heavy traffic

- Postgres + MinIO backups (volumes `pgdata`, `miniodata`).
- Error monitoring / log aggregation.
- Origin TLS + Cloudflare Full (strict) if you want end-to-end encryption.
- Email deliverability (SPF/DKIM) — fine while relaying through Gmail.
