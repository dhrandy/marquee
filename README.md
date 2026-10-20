# Marquee

![Beta](https://img.shields.io/badge/status-beta-b49aff) ![License](https://img.shields.io/badge/license-proprietary-blue)

A self-hosted media dashboard with recent titles, a release calendar, personal Jellyfin shelves and Seerr discovery. Sign in with your Jellyfin account. Your recent titles follow your Jellyfin library permissions.

<img src="docs/images/dashboard-redacted.png" alt="Marquee dashboard with recent titles, release agenda, Seerr search, top ten and Requests; requester names removed" width="100%">

<details>
<summary>Mobile demo</summary>
<p align="center"><img src="docs/images/mobile.png" alt="Marquee mobile demo with readable calendar list" width="300"></p>
</details>

## Beta

Marquee runs from source on the official Node image; there is no published image yet. The stack below downloads the current beta when it starts, so restart or recreate it to update. A running app does not update itself.

## Contents

- [Features](#features)
- [Run with Docker Compose](#run-with-docker-compose)
- [Connection settings](#connection-settings)
- [Optional shelves and extras](#optional-shelves-and-extras)
- [API tokens](#api-tokens)
- [Reverse proxy](#reverse-proxy)
- [Privacy and permissions](#privacy-and-permissions)
- [Third-party artwork](#third-party-artwork)
- [Rights](#rights)

## Features

- Discover and On Jellyfin pages with hideable, collapsible shelves, reordered per page in Settings.
- Recently added movies and TV seasons with added dates, episode details and watched status from your Jellyfin account.
- Continue watching and Next up cover the last 180 days of activity and refresh every minute by default.
- What to watch next: random unwatched picks from your server, with animation and movies/TV filter buttons.
- Favorites (two-way Jellyfin hearts) and a separate Watchlist (stars, saved per viewer, server titles only).
- Recommendations from your five latest watched movies/shows, last five years only, never titles already on your server.
- Top unwatched movies: up to 10 unwatched library movies rated 7 or higher, newest release first.
- Seerr search, popular movies/shows and requests using your linked Seerr permissions and quotas. The Requests list can show everyone's requests to every account, or just yours.
- Shared Sonarr/Radarr release calendar with month, week, day, agenda (default) and list views, Sunday-first, with release filters, cinema/home releases and a status legend.
- Search also matches TV networks: pick a network button to browse its newest series premieres.
- Detail popouts with cast, ratings, certifications, TV network and overview. Play/Resume opens Jellyfin, a YouTube button opens a trailer search, and any title in your library shows a Play in Jellyfin button. Seerr requester names show as Requested by when available.
- Small, Standard or Large posters per device. Shelf arrows on desktop; phones and tablets swipe.
- Optional weather and five-day forecast (free Open-Meteo, no key), colorblind-friendly status colors, and display-settings sync across browsers.
- Shelves refresh automatically in an open, visible tab and pause while you interact. Unchanged results leave cards and posters untouched.
- Library counts at the bottom of On Jellyfin: Movies, TV Shows and Episodes, with Kids counts split out using the kids libraries you pick in Settings.
- Optional push notifications and an In theaters shelf (see below).
- Settings shows your Jellyfin server version and connection tests; Jellyfin administrators can change the shared display name.
- Installable home-screen app (PWA). Demo mode uses fictional titles and needs no external credentials.

Most shelves are on by default and hideable in Settings; empty shelves stay out of the page. Personal shelves and weather start off. Display choices stay on the current device unless you enable sync. The watched badge is read-only and never changes viewing history.

## Run with Docker Compose

Use Docker Engine with the Compose plugin, or a stack manager such as CasaOS, Dockhand or Synology Container Manager. No image build is needed.

The recommended stack downloads the app for you, so you do not need the source folder. Settings come from a `.env` file beside your compose file, or your stack manager's Environment settings.

1. Copy the complete example below into your stack editor, or save `compose.casaos.yaml` as your stack file.
2. Create a `.env` from the [Environment values](#environment-values) example below, beside your compose file, or add the same variables in your stack manager's Environment settings. Fill in your own service URLs and API keys and keep them private.
3. Set your timezone. Leave `DEMO_MODE` off for your real media.
4. Keep `COOKIE_SECURE` true for HTTPS. Use false only on a trusted plain-HTTP home network.
5. Set `MARQUEE_PORT` to your host port (usually `8739`). Keep `target: 8739` in the compose.
6. Start the stack. Open it through your HTTPS reverse proxy. Direct HTTP works only when `COOKIE_SECURE=false` on a trusted home network.

Startup downloads Marquee from GitHub and installs its runtime packages automatically, so your server needs internet access to GitHub and npm during startup. If a download fails, startup stops rather than running an incomplete app.

**Updates:** restart or recreate the stack to download the latest beta. Compose changes require replacing the stack definition and recreating it; restarting alone does not apply a new compose. Keep your settings folder and environment values.

**Saved settings:** keep the settings folder when updating. It holds account settings, the display name and the generated session secret. Leaving `SESSION_SECRET` blank uses that saved secret; changing it signs everyone out. Sessions last 90 days and survive restarts while the folder and secret are unchanged.

**Container name:** the container is named `marquee`. For a second Marquee instance on the same Docker host, give it a different `container_name`, host port and settings folder.

**Platform notes:**

- CasaOS: use Custom Install and paste the full stack below. The default settings path fits CasaOS.
- Dockhand: create/edit the stack, paste the compose, and add the environment values in its Environment tab instead of a `.env` file.
- Synology Container Manager: use a Project and its compose editor. Change the settings source to your shared-folder path, for example `/volume1/docker/marquee/settings`.
- Plain Docker: save this as `compose.yaml` beside your `.env` and deploy with your Docker Compose interface. The source downloads automatically; no clone or permission commands are needed.

```yaml
name: marquee
services:
  marquee:
    container_name: marquee
    image: node:22-alpine
    working_dir: /app
    # Root only prepares the settings folder; the app runs as node.
    user: "0:0"
    init: true
    # Downloads current main on restart; requires HTTPS access to GitHub and npm.
    command:
      - sh
      - -c
      - |
          set -eu

          # 1. Prepare saved settings, then switch to the non-root app user.
          chown -R 1000:1000 /home/node
          exec su node -s /bin/sh -c '
          set -eu

          # 2. Download Marquee from GitHub.
          wget -O /app/source.tar.gz \
            https://codeload.github.com/dhrandy/marquee/tar.gz/refs/heads/main

          # 3. Unpack the app and remove the download.
          tar -xzf /app/source.tar.gz -C /app --strip-components=1
          rm /app/source.tar.gz

          # 4. Leave tests and development files out of the running copy.
          rm -rf /app/tests /app/docs /app/.github \
            /app/playwright.config.js /app/README.md \
            /app/compose.yaml /app/compose.casaos.yaml \
            /app/.env.example /app/.gitignore

          # 5. Install only the packages the app needs to run.
          npm ci --omit=dev --ignore-scripts --no-audit --no-fund

          # 6. Start Marquee.
          exec node src/server.js
          '
    # Change published for your host port; keep target 8739.
    ports:
      - target: 8739
        published: "${MARQUEE_PORT}"
        protocol: tcp
    # Values come from your .env file or stack Environment settings.
    environment:
      TZ: ${TZ}
      DEMO_MODE: ${DEMO_MODE}
      # false only for a trusted plain-HTTP LAN; keep true behind HTTPS.
      COOKIE_SECURE: ${COOKIE_SECURE}
      SESSION_SECRET: ${SESSION_SECRET}
      TRUSTED_PROXIES: ${TRUSTED_PROXIES}
      TRUST_PROXY: ${TRUST_PROXY}
      JELLYFIN_URL: ${JELLYFIN_URL}
      SONARR_URL: ${SONARR_URL}
      SONARR_API_KEY: ${SONARR_API_KEY}
      RADARR_URL: ${RADARR_URL}
      RADARR_API_KEY: ${RADARR_API_KEY}
      SEERR_URL: ${SEERR_URL}
      SEERR_API_KEY: ${SEERR_API_KEY}
      TMDB_API_KEY: ${TMDB_API_KEY}
      MAINTAINERR_URL: ${MAINTAINERR_URL}
      MAINTAINERR_API_KEY: ${MAINTAINERR_API_KEY}
      # Browser-facing Jellyfin URL; blank falls back to JELLYFIN_URL.
      JELLYFIN_WEB_URL: ${JELLYFIN_WEB_URL}
    volumes:
      - type: bind
        # Persistent settings: keep this folder when updating.
        source: /DATA/AppData/marquee/settings
        target: /home/node
    tmpfs:
      - /app:uid=1000,gid=1000,mode=0700
      - /home/node/.npm:uid=1000,gid=1000,mode=0700
    read_only: true
    cap_drop:
      - ALL
    # Only needed for folder ownership and the startup user switch.
    cap_add:
      - CHOWN
      - DAC_OVERRIDE
      - SETUID
      - SETGID
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped
    healthcheck:
      test:
        - CMD
        - su
        - node
        - -s
        - /bin/sh
        - -c
        - node -e "fetch('http://127.0.0.1:8739/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      start_period: 60s
```

<details>
<summary>Local-checkout compose (only if you already keep the source folder on your server)</summary>

This option mounts your downloaded source read-only and uses the `marquee-settings` named volume for saved settings and sign-ins. Keep that volume when updating. Startup needs access to npm. Updates come from the source you downloaded, not GitHub.

```yaml
services:
  marquee:
    container_name: marquee
    image: node:22-alpine
    working_dir: /app
    user: node
    init: true
    command:
      - sh
      - -c
      - |
          set -e

          # Copy the app from your downloaded source folder.
          cp /source/package*.json /app/
          cp -R /source/src /source/public /app/

          # Install only the packages the app needs to run.
          npm ci --omit=dev --ignore-scripts --no-audit --no-fund

          # Start Marquee.
          exec node src/server.js
    ports:
      - "${MARQUEE_PORT}:8739"
    environment:
      TZ: ${TZ}
      DEMO_MODE: ${DEMO_MODE}
      COOKIE_SECURE: ${COOKIE_SECURE}
      SESSION_SECRET: ${SESSION_SECRET}
      TRUSTED_PROXIES: ${TRUSTED_PROXIES}
      TRUST_PROXY: ${TRUST_PROXY}
      JELLYFIN_URL: ${JELLYFIN_URL}
      SONARR_URL: ${SONARR_URL}
      SONARR_API_KEY: ${SONARR_API_KEY}
      RADARR_URL: ${RADARR_URL}
      RADARR_API_KEY: ${RADARR_API_KEY}
      SEERR_URL: ${SEERR_URL}
      SEERR_API_KEY: ${SEERR_API_KEY}
      TMDB_API_KEY: ${TMDB_API_KEY}
      MAINTAINERR_URL: ${MAINTAINERR_URL}
      MAINTAINERR_API_KEY: ${MAINTAINERR_API_KEY}
      JELLYFIN_WEB_URL: ${JELLYFIN_WEB_URL}
    volumes:
      - ./:/source:ro
      - marquee-settings:/home/node
    tmpfs:
      - /app:uid=1000,gid=1000,mode=0700
      - /home/node/.npm:uid=1000,gid=1000,mode=0700
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:8739/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 30s
      timeout: 5s
      start_period: 60s

volumes:
  marquee-settings:
```

If the stack's directory differs from your checkout, change `./:/source:ro` to the checkout location.

</details>

### Environment values

Copy these into `.env` beside your compose, or into the stack manager's Environment settings. Replace service URLs and API keys with your own. Service names such as `jellyfin` work only on a shared Docker network; otherwise use a reachable LAN address. Leave optional Maintainerr values blank if unused. These are examples, not working credentials.

```dotenv
# Marquee settings. Copy to .env and fill in your own values. Keep .env private.

# Port on the host that Marquee listens on (container port stays 8739).
MARQUEE_PORT=8739
# Your timezone, for example America/New_York. List: en.wikipedia.org/wiki/List_of_tz_database_time_zones
TZ=Etc/UTC
# Demo mode shows fake titles with no login. For trying the app only - never for a real deployment.
DEMO_MODE=false
# true when Marquee sits behind an HTTPS reverse proxy (recommended). false only for a local HTTP demo.
COOKIE_SECURE=true
# Optional. Empty = generated once and kept in the data volume. Set 32+ random characters to pin it.
SESSION_SECRET=
# Comma-separated trusted reverse-proxy IPs/narrow CIDRs as seen by the container.
# Empty ignores X-Forwarded-For. Do not use a wildcard, true, or a hop count.
# Proxy must overwrite forwarded client headers; backend must not be publicly reachable.
TRUSTED_PROXIES=
# Simpler alternative: 1 trusts exactly one proxy hop (default off).
# ONLY if backend access is restricted to your proxy, including LAN/container callers.
# Current compose publishes on host interfaces; configure firewall/bind isolation yourself.
# Direct backend callers can spoof client IPs with this mode. Strict allowlist wins if set.
TRUST_PROXY=0

# Internal vs external URLs: the container talks to your services over your
# Docker/LAN network (internal). Deep links people tap on their phones use the
# public reverse-proxy address (external). Set both when they differ.

# Jellyfin internal URL: how this container reaches Jellyfin (Docker service name or LAN address).
JELLYFIN_URL=http://jellyfin:8096
# Jellyfin external URL: the address browsers open when you tap a poster. Falls back to JELLYFIN_URL.
JELLYFIN_WEB_URL=https://jellyfin.example.com

# Sonarr: base URL + API key (Settings > General in Sonarr).
SONARR_URL=http://sonarr:8989
SONARR_API_KEY=replace-with-your-sonarr-api-key
# Radarr: base URL + API key (Settings > General in Radarr).
RADARR_URL=http://radarr:7878
RADARR_API_KEY=replace-with-your-radarr-api-key

# Seerr (Jellyseerr or Overseerr): base URL + API key (Settings > General).
SEERR_URL=http://seerr:5055
SEERR_API_KEY=replace-with-your-seerr-api-key

# Optional In theaters shelf: your own TMDB API key (server-side only).
TMDB_API_KEY=

# Weather is set per viewer in Settings: city picker and F/C units.
# Open-Meteo weather and city search are free for non-commercial use. No API key or account needed.
# Dashboard display name is set by a Jellyfin administrator in Settings (default Marquee).

# Optional read-only Leaving soon shelf. Internal URL, including BASE_PATH if used.
# Maintainerr has no built-in API authentication; do not expose it publicly.
MAINTAINERR_URL=http://maintainerr:6246
# Optional compatibility header. Maintainerr does not validate this as protection.
MAINTAINERR_API_KEY=
```

Dockhand users can put these variables in the stack's Environment tab instead of a `.env` file.

## Connection settings

- `JELLYFIN_URL`: server base URL, including a path prefix if configured. No Jellyfin API key; each user enters their own username/password on the sign-in screen.
- `SONARR_URL`/`SONARR_API_KEY`, `RADARR_URL`/`RADARR_API_KEY`, `SEERR_URL`/`SEERR_API_KEY` (Jellyseerr or Overseerr): base URLs and API keys from each app's Settings > General.
- Internal/external URL split: the `*_URL` values are how the container reaches each service (Docker network or LAN). `JELLYFIN_WEB_URL` is the public address browsers open when someone taps a poster; it defaults to `JELLYFIN_URL`. Set both when containers use an internal address phones cannot open.
- Weather: each viewer picks a city, F/C units and enables the widget in Settings; saved on the server per viewer, not in `.env`.
- Display name: Jellyfin administrators see a name field in Settings (default Marquee), stored in the settings volume. It changes the dashboard header and browser tab; installed PWA icons/name remain Marquee.
- `TZ`: server timezone. Calendar air times and poster dates use the viewer's browser timezone.

The app server must be able to reach all configured services; requests go through the server, so no browser CORS settings are needed. Service URLs may include a URL-base path; trailing slashes are optional, and a missing scheme defaults to HTTP. HTTPS certificates must be trusted, and API redirects are not followed. Connection tests and calendar warnings distinguish HTTP errors, redirects, timeouts and invalid API responses.

## Optional shelves and extras

### Weather

Uses free Open-Meteo weather and city search: no key, no account, free for non-commercial use. City searches share the typed city name with Open-Meteo; forecasts share the selected city's coordinates, cached 15 minutes. See [Open-Meteo documentation](https://open-meteo.com/en/docs) for service terms and use limits.

### Maintainerr Leaving soon (optional)

Set `MAINTAINERR_URL` to its internal container/LAN base URL (include its `BASE_PATH`, if set) and enable Leaving soon in Settings, where a connection test is available. The read-only shelf shows up to 24 accessible Jellyfin titles from active Maintainerr delete-file collections; dates mean eligible for deletion, not guaranteed deletion. Marquee never changes Maintainerr settings, triggers actions or deletes files. Needs a Maintainerr version with `/api/collections/overlay-data`.

`MAINTAINERR_API_KEY` is only an optional `X-Api-Key` header: Maintainerr does not validate inbound keys, so do not publish its port publicly assuming a key protects it.

### In theaters

Discover can show TMDB Now Playing (US), up to 25 movies released in roughly the last four months. Setup:

1. Get your own TMDB developer API key.
2. Add `TMDB_API_KEY` to your `.env` file or stack manager Environment settings. Compose keeps the `${TMDB_API_KEY}` placeholder; never paste your key into the compose file or repository.
3. Recreate the stack so the new environment setting applies.

Without a key the shelf shows a short setup message and the rest of Discover still works. The list is fetched once a day on the server and shared across viewers; the key stays on the server. A theater listing or request does not mean the movie is ready to watch on Jellyfin.

### Push notifications

Per device and off by default. In Settings, choose your own-request alert and add shows with separate **Airs today** (one summary around 9am) and **New episode available** (fires when playable on Jellyfin) switches. Click **Enable on this device**, grant browser permission, and use **Send test** to check delivery. iPhone/iPad need iOS 16.4 or later and Marquee added to the Home Screen. HTTPS and a browser with Web Push are required.

The server checks every five minutes and needs outbound HTTPS to the browser push service (Google, Mozilla or Apple). Delivery is best-effort, not an alarm. Keep the settings folder: it holds the generated Web Push keys and encrypted device subscriptions. The optional `PUSH_CONTACT` environment setting supplies the VAPID contact URL or mailto address. Alerts are encrypted in transit, but show titles can appear on your lock screen.

## API tokens

Optional. A Jellyfin admin turns on **Settings > API access > Allow API tokens**. Each user can then make their own tokens there (name, read-only or read and request, and their Jellyfin password once). A token acts as the user who made it: it reads what that user sees and, if allowed, requests titles through Seerr as that user, so Seerr permissions and quotas still apply.

- Send `Authorization: Bearer <token>`. The token is shown once; only a hash is stored. Deleting `session-secret` from the settings folder ends every token.
- Tokens cannot open Settings, notifications, sign-in or token routes. Revoking a token ends its Jellyfin login.
- Reads cover what that user sees in Marquee: continue watching, next up, watch history, libraries and library browsing, favorites and watchlist, recently added, calendar, recommendations, leaving soon, weather and Seerr search/requests. Browsing a library is limited to its first 10,000 items. The full endpoint list is at `/api/docs` when signed in.
- Limits: 120 requests per minute and 10 writes per minute per token.
- Keep tokens in your assistant's secret store, never in chat or a file you share.

## Reverse proxy

- Use HTTPS for Jellyfin sign-in. Forward to port 8739, preserve the original Host header, and do not cache `/api/` responses. Keep the HTTP backend off the public internet.
- Keep `COOKIE_SECURE=true` behind HTTPS. Set it false only for a trusted plain-HTTP home network.
- Leave proxy trust off unless you need forwarded client IPs. Then prefer `TRUSTED_PROXIES` with the proxy's specific IPs or narrow CIDRs as seen by the container; never trust all addresses or a shared gateway reachable by untrusted clients.
- `TRUST_PROXY=1` is an alternative only when every direct path to the backend is blocked, including LAN and container callers, and the proxy overwrites forwarded headers. Otherwise a caller can fake its client IP and bypass login throttling.
- The compose publishes the backend on host interfaces; it does not enforce proxy-only access. Keep trust off until your firewall, binding or network rules restrict access to the proxy.

## Privacy and permissions

- Jellyfin shelves follow the signed-in viewer's library permissions. **The Sonarr/Radarr calendar is shared among all signed-in viewers** and may show titles they cannot access in Jellyfin. Deploy only for viewers you trust with that calendar.
- Seerr search and requests use the imported account matched by Jellyfin user ID. Ask a Seerr admin to import your user if no match exists. Requests use that account's permissions and quotas; showing everyone's requests needs View Requests or Manage Requests permission. Server API keys never reach the browser.
- Passwords are sent to Jellyfin and are not stored or logged. Jellyfin access tokens are encrypted inside the HttpOnly session cookie, never exposed to page scripts. Cookies are HttpOnly, SameSite Strict, secure by default, and expire 90 days after sign-in. Sign-out removes the local session and ends the Jellyfin token upstream; normal restarts keep sign-ins valid.
- Media APIs and artwork require sign-in. The app rate-limits login and API traffic, rejects cross-origin writes, and blocks search-engine indexing. These protections do not replace HTTPS or restricting backend access.
- Demo mode must not be enabled for private live deployments: it allows anyone to open the sample dashboard without Jellyfin credentials.

## Third-party artwork

The Jellyfin shortcut uses the unmodified [official Jellyfin icon](https://raw.githubusercontent.com/jellyfin/jellyfin-ux/master/logos/SVG/jellyfin-icon--color-on-dark.svg) by the Jellyfin contributors, licensed under [CC BY-SA 4.0](public/licenses/jellyfin-CC-BY-SA-4.0.txt). It identifies the Jellyfin link, not Marquee. Marquee is an independent project.

Country flags use the [flag-icons](https://github.com/lipis/flag-icons) package (MIT, [notice](public/licenses/flag-icons-MIT.txt)).

## Rights

Copyright (c) 2026 dhrandy. All rights reserved. Marquee is proprietary; no open-source license is granted. Third-party asset notices apply only to those assets.
