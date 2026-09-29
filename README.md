# Lurkloot WebUI

A thin web host for [Lurkloot](https://github.com/jamezrin/lurkloot).

The project keeps Lurkloot's core and popup UI stock. Docker checks out a chosen
upstream Lurkloot ref, adds this repository's `overlay/` package to the existing
pnpm workspace, and builds the WebUI against that exact upstream source.

## Current status

The WebUI now runs a real headless Twitch runtime:

- stock `@lurkloot/popup-ui`
- stock `createBackgroundController()`
- stock CLI HTTP Twitch transport
- stock CLI Node job scheduler and state persistence
- stock Twitch Android device-code OAuth flow
- popup `RuntimeMessage` calls bridged over HTTP
- persistent settings, scheduler state, credentials, and activity under `/data`

The current host is Twitch-first. Kick remains visible because the UI is stock,
but the runtime currently uses the lightweight CLI HTTP transport, which is the
supported headless path for Twitch. Kick support can be added later with the
CLI impersonation transport.

## Architecture

```text
stock @lurkloot/popup-ui
          |
          | RuntimeMessage
          v
Web PopupAdapter
          |
          | POST /api/message
          v
Node WebUI host
          |
          v
stock createBackgroundController()
          |
          +-- stock CLI HTTP Twitch transport
          +-- stock CLI Node scheduler
          +-- /data settings/state/auth/activity
```

No upstream Lurkloot source file is patched.

## Run from GHCR

```bash
docker pull ghcr.io/gabrielzv1233/lurkloot-webui:latest

docker run -d \
  --name lurkloot-webui \
  --restart unless-stopped \
  -p 8080:8080 \
  -v lurkloot-webui-data:/data \
  ghcr.io/gabrielzv1233/lurkloot-webui:latest
```

Open <http://localhost:8080>.

When Twitch authentication is missing, use the popup's normal **Sign in** action.
The WebUI intercepts that action and displays Twitch's device code. Authorization
is saved into `/data/auth/credentials.json`, then the headless runtime restarts
against the authenticated stock CLI transport.

## Build locally

```bash
docker build \
  --build-arg LURKLOOT_REF=develop \
  -t lurkloot-webui .

docker run --rm \
  -p 8080:8080 \
  -v lurkloot-webui-data:/data \
  lurkloot-webui
```

Or:

```bash
docker compose up --build
```

## Build a specific upstream version

`LURKLOOT_REF` accepts a branch, tag, or commit SHA:

```bash
docker build \
  --build-arg LURKLOOT_REF=v1.14.1 \
  -t lurkloot-webui .
```

Core, shared contracts, locales, popup UI, and the borrowed CLI host pieces all
come from the same upstream revision.

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

The workflow also uploads a runnable `linux/amd64` Docker image tar.

## Persistent data

```text
/data/
├── settings.json
├── state.json
├── activity.jsonl
└── auth/
    └── credentials.json
```

Replacing the Docker container does not remove this data when `/data` is backed
by a volume.

## Updating upstream

The running container is immutable. Updating Lurkloot means rebuilding the image
against a newer `LURKLOOT_REF` and replacing the container. Automatic
release-based rebuilding and optional container auto-pull are intentionally
being left for a later step.
