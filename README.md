# Pulseboard

![Node](https://img.shields.io/badge/Node-18+-339933)
![License](https://img.shields.io/badge/License-MIT-green)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED)

**Self-hosted HTTP uptime monitoring** with a statistics dashboard. Lightweight, no database — JSON on disk.

## Run in 30 seconds

**Option A — local (recommended for trying it out)**

```bash
git clone https://github.com/mamyan2001-gif/pulseboard.git
cd pulseboard
npm run setup
npm run dev
```

Opens **http://127.0.0.1:5175** (API on `:5060`). Press `Ctrl+C` to stop both.

Skip the browser: `npm run dev -- --no-open`

**Option B — single port (built UI + API)**

```bash
cd pulseboard
npm run setup
npm start
```

Builds the UI if needed, serves everything on **http://127.0.0.1:5060**, and opens the browser.

**Option C — Docker**

```bash
git clone https://github.com/mamyan2001-gif/pulseboard.git
cd pulseboard
docker compose up --build
# → http://localhost:5060
```

## What you can do

- **Profiles** — named workspaces of monitors (create, rename, switch, delete)
- Add and **edit** monitors (name, URL, interval, timeout, expected status)
- Scheme optional on URLs — `https://` is filled in
- Click a URL to copy it
- See live Up / Down / Pending status and latency
- Open **Statistics** for the active profile’s uptime table
- Optional down/up alert webhook

First visit with an empty list? Use **Add example.com** to create a sample monitor. Existing data is migrated into a **Main** profile automatically.

## Configuration (optional)

Copy `.env.example` → `.env` (loaded automatically):

| Env var | Default | Meaning |
|---------|---------|---------|
| `PORT` | `5060` | API / production UI port |
| `HOST` | `127.0.0.1` (Docker: `0.0.0.0`) | Listen address |
| `PUBLIC_BASE_URL` | (empty) | Public base URL (reported in health) |
| `ALERT_WEBHOOK` | (empty) | Optional URL for down/up alert POSTs |
| `CORS_ORIGIN` | (off) | Comma-separated origins if UI is on another host |

Production on all interfaces:

```bash
HOST=0.0.0.0 PORT=5060 PUBLIC_BASE_URL=https://status.example.com npm start -- --no-open
```

## Scripts

| Command | What it does |
|---------|----------------|
| `npm run setup` | Install server + client dependencies |
| `npm run dev` | API + Vite UI together (opens browser) |
| `npm start` | Build UI if needed, serve on `:5060` (opens browser) |
| `npm run build` | Build UI only |
| `npm run docker` | `docker compose up --build` |

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/profiles` | List profiles + `activeProfileId` |
| POST | `/api/profiles` | Create profile (`name`) |
| PATCH | `/api/profiles/:id` | Rename profile (`name`) |
| DELETE | `/api/profiles/:id` | Delete profile (not the last one) |
| POST | `/api/profiles/:id/activate` | Switch active profile |
| GET | `/api/status` | Overall status + monitors for active profile |
| GET | `/api/monitors` | List monitors in active profile |
| POST | `/api/monitors` | Create monitor (`name`, `url`, `intervalSec` 30–3600, `timeoutMs`, `expectedStatus` default 200) |
| PATCH | `/api/monitors/:id` | Update monitor fields |
| DELETE | `/api/monitors/:id` | Delete monitor |

URLs without a scheme are stored as `https://…`. Only the **active** profile is checked and shown.

### Alert webhook payload

When `ALERT_WEBHOOK` is set, Pulseboard POSTs:

```json
{
  "monitor": { "id": "…", "name": "API", "url": "https://…" },
  "status": "down",
  "message": "Expected status 200, got 503"
}
```

`status` is `"down"` on incident open and `"up"` on recovery.

## Project layout

```
Pulseboard/
├── client/          React + Vite UI
├── server/          Express API + checker
├── scripts/         One-command dev / start
├── data/            JSON store (gitignored)
├── .env.example     Optional config template
└── docker-compose.yml
```

## Security notes

- Default bind is loopback (`127.0.0.1`); Docker sets `HOST=0.0.0.0`
- Create endpoints are rate-limited in-process
- Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `x-powered-by` disabled
- Monitor IDs are nanoid-validated; store uses atomic JSON writes
- Run behind HTTPS in production; add reverse-proxy auth if exposed publicly
- Personal/team tool — not a full SaaS monitoring platform

## License

[MIT](LICENSE)
