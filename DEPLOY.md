# Deploying

One long-lived Node process on a small VPS, behind a reverse proxy, with a
nightly ingest. No database, no queue, no container required.

## What it needs

| | |
|---|---|
| Memory | **451MB resident**, measured on the running process. A 1GB box is enough; 2GB gives headroom for the ingest. |
| Disk | **~6GB**, measured, and mostly not the app: `data/cache/` holds 5.4GB of downloaded zips and unpacked GTFS (Switzerland's `stop_times.txt` alone is 2.87GB), plus 104MB `network.json`, 239MB `node_modules`, 1.3MB `dist`. Size the box for the cache, not the output. |
| CPU | One core serves fine — a cold search is ~270ms and the process is single-threaded. The ingest wants more, and ~20 minutes. |
| Node | 24.x. `unzip` must be on PATH for the ingester. |

**Not** Cloudflare Workers or Pages (128MB), and not Lambda-shaped: the index
build takes ~6s, so the process has to stay warm. That 6s is why reloads swap
data in place rather than restarting.

## First run

```bash
git clone https://github.com/windcrash64/nightjet-atlas.git
cd nightjet-atlas
npm ci
npm run build                                    # dist/, served by the same process
NODE_OPTIONS=--max-old-space-size=6144 node scripts/ingest.mjs
```

The ingest needs the extra heap for Switzerland and takes ~20 minutes on a
cold cache. It writes `src/data/network.json` **atomically** — to a `.new`
file, then `rename()` over the target — so a running server never sees a
half-written file.

## Running it

```bash
HOST=127.0.0.1 PORT=8080 RELOAD_TOKEN=$(openssl rand -hex 16) node server.mjs
```

`HOST` defaults to `127.0.0.1` deliberately. Set `0.0.0.0` **only** once a
reverse proxy fronts it — the process does no TLS and its rate limiter reads
`req.socket.remoteAddress`, which is the proxy's address once one exists.

As a systemd unit:

```ini
[Unit]
Description=Where next — journey search
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/nightjet
Environment=HOST=127.0.0.1
Environment=PORT=8080
Environment=RELOAD_TOKEN=…
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
# The heap is ~180MB after the typed-array work; 1500MB is generous headroom
# and still catches a runaway.
MemoryMax=1500M

[Install]
WantedBy=multi-user.target
```

`Restart=always` matters. Two one-request remote kills were found and fixed
before the first deploy, and the process now catches `uncaughtException` — but
a supervisor is the difference between a crash and an outage.

## Nightly data

```bash
#!/bin/sh
# /etc/cron.daily/nightjet-ingest — timetables change daily at most.
set -e
cd /srv/nightjet
NODE_OPTIONS=--max-old-space-size=6144 node scripts/ingest.mjs
kill -HUP "$(systemctl show -p MainPID --value nightjet)"
```

`SIGHUP` reloads the network in place: the replacement is built while the old
one keeps serving, and the swap is a single assignment, so no request sees a
partial state. The result cache is cleared with it, because cached journeys
belong to the old timetable.

**A failed reload is not an outage.** If the new file is missing or corrupt the
server logs `reload FAILED, keeping the previous network` and carries on
serving yesterday's data — verified by pointing it at a truncated file: it
returned HTTP 500 for the reload and kept answering searches.

There is also `POST /api/reload` with an `x-reload-token` header, which does
the same thing. It exists because Node cannot deliver signals on Windows
(`kill()` returns `ENOSYS`), so the signal path cannot be tested where this is
developed. Without `RELOAD_TOKEN` set the route returns 404 — it does not
advertise itself — and a wrong token gets 404 too.

## Reverse proxy

```nginx
server {
  listen 443 ssl http2;
  server_name example.com;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  # /api/reload is loopback-only by intent. Do not proxy it.
  location = /api/reload { return 404; }
}
```

Once a proxy is in front, the rate limiter's `req.socket.remoteAddress` becomes
the proxy for every request, so **every visitor shares one bucket**. Switch it
to the rightmost trusted `X-Forwarded-For` entry at that point —
`server.mjs` marks the spot. Until then the header is client-controlled and
trusting it would hand an attacker a fresh identity per request.

## What is already handled

Found and fixed by a pre-deploy audit, so they do not need re-doing:

- Body size capped at 64KB, counted while streaming (a 200MB POST previously
  added 618MB of RSS).
- 20 searches/minute per IP, 4 in flight; a burst leaves static assets at 4ms.
- `departHour` validated and floored, so fractional values cannot mint
  unlimited cache keys.
- Malformed `Host` headers and prototype-chain queries (`?q=constructor`) no
  longer kill the process; both did.
- Static files read once into memory, hashed assets sent `immutable`.
- Path containment asserted explicitly rather than by an unreachable regex.

## Legal

`DATA_SOURCES.md` is not optional reading before you put this on a domain. Two
constraints bind a deployment:

- **SNCF is ODbL**, whose share-alike attaches to a derived *database*.
  Serving journey results is fine; publishing `src/data/network.json` as a
  dataset is not, while SNCF is in it.
- **EU Delegated Regulation 2017/1926 Art. 8(3)** requires the source and
  last-update time to be shown. The footer does this; do not remove it.
