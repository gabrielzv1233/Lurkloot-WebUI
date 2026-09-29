# Lurkloot WebUI

A thin web-host proof of concept for [Lurkloot](https://github.com/jamezrin/lurkloot).

The goal is to keep Lurkloot itself stock. This repository owns only the web-host layer and Docker packaging.

## Current mock

The current container:

- fetches a chosen upstream Lurkloot ref during the Docker build;
- injects the small package in `overlay/` into the upstream pnpm workspace;
- imports the real `@lurkloot/popup-ui` package;
- uses Lurkloot's stock `createDemoPopupAdapter()`;
- serves the resulting web app from nginx.

No Lurkloot source files are patched or copied into this repository.

> This is currently a UI/runtime-boundary mock. It displays the real upstream popup UI with upstream demo data. It does **not** run the headless farming core yet.

The next step is replacing the demo adapter with a web adapter that sends Lurkloot `RuntimeMessage` objects to a Node host backed by the same headless controller/transports as the CLI.

## Build locally

```bash
docker build \
  --build-arg LURKLOOT_REF=develop \
  -t lurkloot-webui .
```

Run it:

```bash
docker run --rm -p 8080:80 lurkloot-webui
```

Open <http://localhost:8080>.

You can also use Compose:

```bash
docker compose up --build
```

## Build a specific upstream version

`LURKLOOT_REF` can be a branch, tag, or commit SHA:

```bash
docker build \
  --build-arg LURKLOOT_REF=b531a6dc5d483068e77f6a1258a57633be40bced \
  -t lurkloot-webui .
```

That keeps the popup UI, shared contracts, locales, and eventually the core/CLI runtime on the same upstream revision.

## Manual GitHub Actions Docker build

Open **Actions → Build Docker image → Run workflow**.

The workflow accepts:

- **Lurkloot ref**: upstream branch, tag, or SHA. Defaults to `develop`.
- **Platforms**: `linux/amd64` or `linux/amd64,linux/arm64`.

A successful run pushes:

```text
ghcr.io/gabrielzv1233/lurkloot-webui:latest
ghcr.io/gabrielzv1233/lurkloot-webui:manual-<run number>
```

The workflow uses the repository `GITHUB_TOKEN` and `packages: write`, so no separate GHCR token is required.

## Intended architecture

```text
stock @lurkloot/popup-ui
          |
          | RuntimeMessage
          v
our Web PopupAdapter
          |
          | HTTP
          v
our Node web host
          |
          v
stock createBackgroundController()
          |
          v
stock @lurkloot/core + headless Twitch transport
```

Only the adapter/server boundary should belong to this repository. Upstream packages should remain unmodified so updating Lurkloot is normally just rebuilding against a newer `LURKLOOT_REF`.
