# Lurkloot WebUI

A web host for [Lurkloot](https://github.com/jamezrin/lurkloot) that keeps the
farming engine headless while rendering the real upstream popup UI.

Docker checks out a chosen upstream Lurkloot ref, adds this repository's
`overlay/` package to the existing pnpm workspace, and builds the WebUI against
that exact upstream source.

## Current status

The WebUI runs a real Twitch headless runtime:

- stock `@lurkloot/popup-ui`
- stock `createBackgroundController()`
- stock CLI HTTP Twitch transport
- stock CLI Node job scheduler and state persistence
- stock Twitch Android device-code OAuth flow
- extension credential import/export
- popup `RuntimeMessage` calls bridged over HTTP
- persistent settings, scheduler state, credentials, activity, and Web Push state
- capability-aware UI that removes controls the headless host cannot actually use
- Web Push notifications through a service worker

The current transport is Twitch-only. Kick is removed from the WebUI until the
host switches to Lurkloot's impersonation transport.

## Architecture

```text
stock @lurkloot/popup-ui
          |
          | RuntimeMessage
          v
Web PopupAdapter
          |
          | HTTP
          v
Node WebUI host
          |
          v
stock createBackgroundController()
          |
          +-- stock CLI HTTP Twitch transport
          +-- stock CLI Node scheduler
          +-- Web Push notification hub
          +-- /data persistence
```

Upstream source is left unchanged on disk. During the Vite build, a small
compatibility plugin adds semantic `data-setting-id` wrappers and filters
platform/watch-source UI from the host capability manifest. The build validates
the upstream source patterns first and fails instead of silently publishing if a
future Lurkloot UI refactor removes a hook WebUI depends on.

## Run from GHCR

```bash
docker pull ghcr.io/gabrielzv1233/lurkloot-webui:latest
docker run -d --name lurkloot-webui --restart unless-stopped -p 8080:8080 -v lurkloot-webui-data:/data ghcr.io/gabrielzv1233/lurkloot-webui:latest
```

Open the WebUI through your normal HTTPS reverse proxy, or use
`http://localhost:8080` for local development.

## Twitch authentication

Use **Connect Twitch** or the stock popup's **Sign in** action. Both start the
upstream Twitch Android device-code OAuth flow. The resulting credential is saved
under:

```text
/data/auth/credentials.json
```

**Import credentials** accepts the Lurkloot extension's credential export as well
as the CLI credential-store shape. The stock Settings view also exposes
**Export credentials**, with Lurkloot's confirmation step, for moving the session
to another headless installation.

Normal Settings import/export remains settings-only and never contains
credentials.

## Capability-aware UI

The browser reads `GET /api/capabilities` before mounting the stock popup.

The current host declares:

```text
browser tabs:                 false
Twitch web integrity capture: false
supplemental Twitch sources:  false
Twitch HTTP transport:        true
Kick HTTP transport:          false
Twitch live channel-point push observer: false
Web notifications:            true
```

The WebUI therefore removes or normalizes controls for browser farming tabs,
manual-watch pause, in-page injection, Kick page-context recovery, NoPixelV /
Fortnite supplemental sources, Kick, and the live-event channel-point observer.
The normal one-minute Twitch channel-point claim job remains available.

The popup settings registry uses stable semantic IDs. The WebUI build injects
`data-setting-id` wrappers around those existing IDs rather than relying on
Tailwind classes, translated labels, or `:nth-child()` selectors.

## Web Push notifications

Click **Enable notifications** in the WebUI. The browser registers `/sw.js`,
creates a Push API subscription, and stores the subscription under `/data`.
Lurkloot's existing `events.notify({ title, message })` port then sends the same
reward/no-drops notifications to subscribed browsers.

Persistent files:

```text
/data/notifications/
├── vapid.json
└── subscriptions.json
```

The VAPID keypair is generated once and survives container replacement.

For an authentication proxy in front of the WebUI, these paths are safe to
exempt from authentication:

```text
/sw.js
/manifest.webmanifest
/icon-128.png
```

They contain no credentials. Keep all `/api/*` routes authenticated, especially:

```text
/api/notifications/subscribe
/api/notifications/unsubscribe
/api/notifications/test
/api/auth/*
```

The Push service contacts the browser directly, not your reverse proxy, so no
incoming unauthenticated push endpoint is required.

Web Push requires a secure context. HTTPS is the normal deployment path;
`localhost` is accepted by browsers for local development. On iPhone/iPad,
installing the site to the Home Screen is the expected Web Push/PWA path.

## Build locally

```bash
docker build --build-arg LURKLOOT_REF=develop -t lurkloot-webui .
docker run --rm -p 8080:8080 -v lurkloot-webui-data:/data lurkloot-webui
```

Or:

```bash
docker compose up --build
```

## Build a specific upstream version

`LURKLOOT_REF` accepts a branch, tag, or commit SHA:

```bash
docker build --build-arg LURKLOOT_REF=v1.14.1 -t lurkloot-webui .
```

Core, shared contracts, locales, popup UI, and borrowed CLI host pieces all come
from the same upstream revision.

## Manual GitHub Actions build

Open **Actions -> Build Docker image -> Run workflow**.

Inputs:

- **Lurkloot ref**: branch, tag, or SHA. Defaults to `develop`.
- **Platforms**: `linux/amd64` or `linux/amd64,linux/arm64`.

Successful builds push:

```text
ghcr.io/gabrielzv1233/lurkloot-webui:latest
ghcr.io/gabrielzv1233/lurkloot-webui:manual-<run number>
```

The workflow starts the built image and smoke-tests its health, capability,
service-worker, manifest, and notification-key endpoints before exporting the
runnable amd64 tar.

## Persistent data

```text
/data/
├── settings.json
├── state.json
├── activity.jsonl
├── auth/
│   └── credentials.json
└── notifications/
    ├── vapid.json
    └── subscriptions.json
```

Replacing the Docker container does not remove this data when `/data` is backed
by a volume.

## Updating upstream

The running container is immutable. Updating Lurkloot means rebuilding the image
against a newer `LURKLOOT_REF` and replacing the container. Automatic
release-based rebuilding and optional container auto-pull remain a later step.
