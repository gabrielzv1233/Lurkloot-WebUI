import { StrictMode, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Popup,
  openHttpsLink,
  type PopupAdapter,
} from "@lurkloot/popup-ui";
import { COMPATIBILITY_REGISTRY, resolveCompatibility } from "@lurkloot/core";
import { loadCatalog } from "@lurkloot/locales";
import {
  normalizeBrowserLocale,
  translateFromCatalogs,
  type MessageCatalog,
} from "@lurkloot/shared/i18n";
import type { RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { SupportedLocale } from "@lurkloot/shared/models";
import "@lurkloot/popup-ui/fonts.css";
import "@lurkloot/popup-ui/styles.css";
import "./web.css";

declare const __LURKLOOT_REF__: string;

type TwitchLoginState =
  | { status: "starting" }
  | {
      status: "pending";
      sessionId: string;
      userCode: string;
      verificationUri: string;
      expiresAt: number;
    }
  | { status: "error"; message: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => undefined) as T | { error?: string } | undefined;
  if (!response.ok) {
    throw new Error(
      body && typeof body === "object" && "error" in body && body.error
        ? body.error
        : `HTTP ${response.status}`,
    );
  }
  return body as T;
}

function storageKey(key: string): string {
  return `lurkloot-webui:${key}`;
}

function createWebPopupAdapter(
  locale: SupportedLocale,
  catalog: MessageCatalog | undefined,
  fallbackCatalog: MessageCatalog,
  beginTwitchLogin: () => void,
): PopupAdapter {
  const download = (filename: string, contents: string, mimeType = "text/plain") => {
    const url = URL.createObjectURL(new Blob([contents], { type: mimeType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return {
    version: `web/${__LURKLOOT_REF__}`,
    send: <T,>(message: RuntimeMessage) =>
      api<T>("/api/message", {
        method: "POST",
        body: JSON.stringify(message),
      }),
    getStorage: async (keys?: string | string[]) => {
      const read = (key: string): unknown => {
        const raw = localStorage.getItem(storageKey(key));
        if (raw == null) return undefined;
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      };
      if (typeof keys === "string") return { [keys]: read(keys) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, read(key)]));
      const values: Record<string, unknown> = {};
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key?.startsWith("lurkloot-webui:")) continue;
        const plainKey = key.slice("lurkloot-webui:".length);
        values[plainKey] = read(plainKey);
      }
      return values;
    },
    setStorage: async (values) => {
      for (const [key, value] of Object.entries(values)) {
        localStorage.setItem(storageKey(key), JSON.stringify(value));
      }
    },
    getMessage: (key, substitutions) =>
      translateFromCatalogs(key, substitutions, catalog, fallbackCatalog),
    getUiLanguage: () => locale,
    openLink: (url) => {
      try {
        const parsed = new URL(url);
        if (
          (parsed.hostname === "twitch.tv" || parsed.hostname === "www.twitch.tv")
          && parsed.pathname === "/login"
        ) {
          beginTwitchLogin();
          return;
        }
      } catch {
        return;
      }
      openHttpsLink(url, (safeUrl) => window.open(safeUrl, "_blank", "noopener,noreferrer"));
    },
    exportSettings: (payload) =>
      download("lurkloot-settings.json", JSON.stringify(payload, null, 2), "application/json"),
    importSettings: () => new Promise<unknown | null>((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        file.text().then((text) => resolve(JSON.parse(text)), reject);
      };
      input.click();
    }),
    writeClipboard: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    downloadFile: download,
    resetExtension: () => api<RuntimeSnapshot>("/api/reset", { method: "POST" }),
    compatibilityRegistry: COMPATIBILITY_REGISTRY,
    resolveCompatibility: (settings) =>
      resolveCompatibility(settings, { host: "cli", twitchIdentity: "android" }),
  };
}

function App({
  locale,
  catalog,
  fallbackCatalog,
}: {
  locale: SupportedLocale;
  catalog: MessageCatalog | undefined;
  fallbackCatalog: MessageCatalog;
}) {
  const [login, setLogin] = useState<TwitchLoginState | null>(null);
  const activeSession = useRef<string | null>(null);

  const beginTwitchLogin = async () => {
    if (login?.status === "starting" || login?.status === "pending") return;
    setLogin({ status: "starting" });
    try {
      const next = await api<{
        sessionId: string;
        userCode: string;
        verificationUri: string;
        expiresAt: number;
      }>("/api/auth/twitch/start", { method: "POST" });
      activeSession.current = next.sessionId;
      setLogin({ status: "pending", ...next });
      void pollLogin(next.sessionId);
    } catch (error) {
      setLogin({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const pollLogin = async (sessionId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (activeSession.current !== sessionId) return;
    try {
      const result = await api<{ status: "pending" | "authorized" | "error"; message?: string }>(
        `/api/auth/twitch/status?session=${encodeURIComponent(sessionId)}`,
      );
      if (activeSession.current !== sessionId) return;
      if (result.status === "authorized") {
        activeSession.current = null;
        window.location.reload();
        return;
      }
      if (result.status === "error") {
        activeSession.current = null;
        setLogin({ status: "error", message: result.message ?? "Twitch authorization failed" });
        return;
      }
      void pollLogin(sessionId);
    } catch (error) {
      activeSession.current = null;
      setLogin({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const adapter = useMemo(
    () => createWebPopupAdapter(locale, catalog, fallbackCatalog, () => void beginTwitchLogin()),
    [locale, catalog, fallbackCatalog, login],
  );

  const closeLogin = () => {
    activeSession.current = null;
    setLogin(null);
  };

  return (
    <main className="popup-stage">
      <Popup adapter={adapter} />

      {login && (
        <div className="login-backdrop" role="presentation">
          <section className="login-dialog" role="dialog" aria-modal="true" aria-label="Twitch sign in">
            <h2>Sign in to Twitch</h2>

            {login.status === "starting" && <p>Requesting a Twitch device code…</p>}

            {login.status === "pending" && (
              <>
                <p>Open Twitch&apos;s activation page and enter this code:</p>
                <button
                  className="device-code"
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(login.userCode)}
                  title="Copy code"
                >
                  {login.userCode}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => window.open(login.verificationUri, "_blank", "noopener,noreferrer")}
                >
                  Open Twitch authorization
                </button>
                <p className="login-hint">
                  This dialog will close automatically after Twitch authorizes the container.
                </p>
              </>
            )}

            {login.status === "error" && <p className="login-error">{login.message}</p>}

            <button className="secondary-button" type="button" onClick={closeLogin}>
              {login.status === "error" ? "Close" : "Cancel"}
            </button>
          </section>
        </div>
      )}
    </main>
  );
}

async function bootstrap() {
  const locale = normalizeBrowserLocale(navigator.language);
  const fallbackCatalog = await loadCatalog("en");
  if (!fallbackCatalog) throw new Error("Failed to load English Lurkloot locale");
  const catalog = locale === "en" ? fallbackCatalog : await loadCatalog(locale);

  const root = document.getElementById("root");
  if (!root) throw new Error("Missing #root");

  createRoot(root).render(
    <StrictMode>
      <App locale={locale} catalog={catalog} fallbackCatalog={fallbackCatalog} />
    </StrictMode>,
  );
}

void bootstrap();
