import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLI_CAPABILITIES,
  KICK_ALARM_NAME,
  TWITCH_ALARM_NAME,
  WATCH_ALARM_NAME,
  createBackgroundController,
} from "@lurkloot/core/controller";
import type {
  ActivityHistoryRecord,
  EngineEvent,
} from "@lurkloot/shared/events";
import type {
  ActivityPage,
  ActivityQuery,
  CoreRuntimeMessage,
  DiagnosticsExport,
  RuntimeMessage,
  RuntimeSnapshot,
} from "@lurkloot/shared/messages";
import type {
  ExtensionSettings,
  Platform,
  SchedulerState,
} from "@lurkloot/shared/models";
import {
  applySettingsPatch,
  mergeSettings,
} from "@lurkloot/shared/settings";

import {
  credentialAvailabilityOf,
  describeCredentialHealth,
  loadCredentials,
  saveCredentials,
} from "../../cli/src/authStore";
import {
  pollForToken,
  requestDeviceCode,
} from "../../cli/src/auth/twitchDeviceFlow";
import { createNodeJobScheduler } from "../../cli/src/runtime/jobs";
import { loadState, saveState } from "../../cli/src/storage";
import { createHttpTransport } from "../../cli/src/transport/http";
import { TWITCH_ANDROID_CLIENT_ID } from "../../cli/src/twitch";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = resolve(process.env.DATA_DIR ?? "/data");
const SETTINGS_PATH = join(DATA_DIR, "settings.json");
const STATE_PATH = join(DATA_DIR, "state.json");
const AUTH_DIR = join(DATA_DIR, "auth");
const ACTIVITY_PATH = join(DATA_DIR, "activity.jsonl");

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(MODULE_DIR, "../dist");

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function loadSettings(): Promise<ExtensionSettings> {
  try {
    const raw = JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as Partial<ExtensionSettings>;
    return mergeSettings(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const settings = mergeSettings(undefined);
    await writeJsonAtomic(SETTINGS_PATH, settings);
    return settings;
  }
}

async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await writeJsonAtomic(SETTINGS_PATH, mergeSettings(settings));
}

class ActivityStore {
  private records: ActivityHistoryRecord[] = [];

  async load(): Promise<void> {
    try {
      const contents = await readFile(ACTIVITY_PATH, "utf8");
      this.records = contents
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as ActivityHistoryRecord];
          } catch {
            return [];
          }
        })
        .slice(-3000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async report(events: readonly EngineEvent[]): Promise<void> {
    if (events.length === 0) return;
    await mkdir(DATA_DIR, { recursive: true });

    const records = events.map((event): ActivityHistoryRecord => ({
      ...event,
      id: randomUUID(),
      at: event.emittedAt ?? new Date().toISOString(),
    }));

    this.records.push(...records);
    if (this.records.length > 3000) {
      this.records.splice(0, this.records.length - 3000);
    }

    await appendFile(
      ACTIVITY_PATH,
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8",
    );
  }

  query(query: ActivityQuery): ActivityPage {
    const needle = query.query?.trim().toLowerCase();
    const filtered = this.records
      .filter((record) => record.category === query.category)
      .filter((record) => !query.platform || record.platform === query.platform)
      .filter((record) => !needle || JSON.stringify(record).toLowerCase().includes(needle))
      .reverse();

    const offset = Math.max(0, Number.parseInt(query.cursor ?? "0", 10) || 0);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const events = filtered.slice(offset, offset + limit);
    const nextOffset = offset + events.length;

    return {
      events,
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : undefined,
    };
  }

  diagnostics(platform: Platform): DiagnosticsExport {
    return {
      events: this.records.filter(
        (record) => record.category === "diagnostic" && (!record.platform || record.platform === platform),
      ),
    };
  }

  async clear(): Promise<void> {
    this.records = [];
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(ACTIVITY_PATH, "", "utf8");
  }
}

type WebController = ReturnType<typeof createBackgroundController<ExtensionSettings>>;

class RuntimeManager {
  private controller?: WebController;
  private transport?: Awaited<ReturnType<typeof createHttpTransport>>;
  private jobs?: ReturnType<typeof createNodeJobScheduler>;
  private restartPromise?: Promise<void>;

  constructor(private readonly activity: ActivityStore) {}

  async start(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    const credentials = loadCredentials(AUTH_DIR);
    const transport = createHttpTransport(credentials, { twitch: true, kick: false });

    let dispatchJob: (name: string) => void = () => undefined;
    const jobs = createNodeJobScheduler((name) => dispatchJob(name));

    const controller = createBackgroundController<ExtensionSettings>({
      capabilities: CLI_CAPABILITIES,
      storage: {
        loadSettings,
        saveSettings,
        applySettingsPatch,
        loadState: () => loadState(STATE_PATH),
        saveState: (state: SchedulerState) => saveState(STATE_PATH, state),
      },
      events: {
        report: (events) => this.activity.report(events),
        notify: async ({ title, message }) => {
          console.info(`[notify] ${title}: ${message}`);
        },
      },
      jobs,
      adapters: {
        createAdapter: (platform, emit, settings) =>
          transport.createAdapter(platform, emit, settings),
        createAdapters: (emit, settings) =>
          transport.createAdapters(emit, settings),
      },
      credentials: {
        checkAvailability: async (platform) =>
          credentialAvailabilityOf(describeCredentialHealth(AUTH_DIR)[platform]),
      },
      twitch: {},
    });

    dispatchJob = (name) => {
      if (name === TWITCH_ALARM_NAME) {
        void controller.tickAndHandOff(["twitch"], "alarm");
        return;
      }
      if (name === KICK_ALARM_NAME) {
        void controller.tickAndHandOff(["kick"], "alarm");
        return;
      }
      void controller.runJob(name);
    };

    this.transport = transport;
    this.jobs = jobs;
    this.controller = controller;

    await controller.reconcileStartup();
    void controller.runJob(WATCH_ALARM_NAME);
    void controller.tickAndHandOff(["twitch"], "alarm");
  }

  async stop(): Promise<void> {
    const controller = this.controller;
    const jobs = this.jobs;
    const transport = this.transport;

    this.controller = undefined;
    this.jobs = undefined;
    this.transport = undefined;

    jobs?.dispose();
    controller?.shutdown();
    await transport?.dispose();
  }

  async restart(): Promise<void> {
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = (async () => {
      await this.stop();
      await this.start();
    })();
    try {
      await this.restartPromise;
    } finally {
      this.restartPromise = undefined;
    }
  }

  async ready(): Promise<WebController> {
    if (this.restartPromise) await this.restartPromise;
    if (!this.controller) await this.start();
    return this.controller!;
  }

  async snapshot(): Promise<RuntimeSnapshot<ExtensionSettings>> {
    const controller = await this.ready();
    return controller.handleMessage({ type: "getSnapshot" }) as Promise<RuntimeSnapshot<ExtensionSettings>>;
  }

  async handle(message: CoreRuntimeMessage) {
    const controller = await this.ready();
    return controller.handleMessage(message);
  }

  async reset(): Promise<RuntimeSnapshot<ExtensionSettings>> {
    await this.stop();
    await Promise.all([
      rm(SETTINGS_PATH, { force: true }),
      rm(STATE_PATH, { force: true }),
      this.activity.clear(),
    ]);
    await this.start();
    return this.snapshot();
  }
}

type AuthSession = {
  status: "pending" | "authorized" | "error";
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  message?: string;
};

const activity = new ActivityStore();
await activity.load();

const runtime = new RuntimeManager(activity);
await runtime.start();

const authSessions = new Map<string, AuthSession>();

async function startTwitchAuth(): Promise<{
  sessionId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}> {
  const code = await requestDeviceCode();
  const sessionId = randomUUID();
  const expiresAt = Date.now() + code.expires_in * 1000;

  authSessions.set(sessionId, {
    status: "pending",
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    expiresAt,
  });

  void (async () => {
    try {
      const accessToken = await pollForToken(
        code.device_code,
        code.interval,
        code.expires_in,
      );
      saveCredentials(AUTH_DIR, {
        twitch: {
          authToken: accessToken,
          clientId: TWITCH_ANDROID_CLIENT_ID,
        },
      });
      await runtime.restart();
      const current = authSessions.get(sessionId);
      if (current) authSessions.set(sessionId, { ...current, status: "authorized" });
    } catch (error) {
      const current = authSessions.get(sessionId);
      if (current) {
        authSessions.set(sessionId, {
          ...current,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  })();

  return {
    sessionId,
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    expiresAt,
  };
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1_000_000) throw new Error("Request body too large");
    chunks.push(buffer);
  }

  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleRuntimeMessage(message: RuntimeMessage): Promise<unknown> {
  switch (message.type) {
    case "getActivity":
      return activity.query(message);
    case "exportDiagnostics":
      return activity.diagnostics(message.platform);
    case "clearActivity":
      await activity.clear();
      return null;
    case "resetExtension":
      return runtime.reset();
    case "setTwitchExtensionEnabled":
      return runtime.snapshot();
    case "exportCliCredentials":
      throw new Error("Credentials already belong to the headless WebUI runtime");
    case "getTabId":
      return null;
    default:
      return runtime.handle(message as CoreRuntimeMessage);
  }
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const relative = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  let path = resolve(PUBLIC_DIR, relative);

  if (!path.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(path);
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(path)] ?? "application/octet-stream",
      "cache-control": path.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    });
    response.end(body);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  path = join(PUBLIC_DIR, "index.html");
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
  });
  response.end(await readFile(path));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/message") {
      const message = await readJson(request) as RuntimeMessage;
      if (!message || typeof message !== "object" || !("type" in message)) {
        json(response, 400, { error: "Invalid runtime message" });
        return;
      }
      json(response, 200, await handleRuntimeMessage(message));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/twitch/start") {
      json(response, 200, await startTwitchAuth());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/auth/twitch/status") {
      const sessionId = url.searchParams.get("session");
      const session = sessionId ? authSessions.get(sessionId) : undefined;
      if (!session) {
        json(response, 404, { error: "Unknown Twitch authorization session" });
        return;
      }
      json(response, 200, {
        status: session.status,
        message: session.message,
      });
      if (session.status !== "pending") authSessions.delete(sessionId!);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/reset") {
      json(response, 200, await runtime.reset());
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(url.pathname, response);
      return;
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    json(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

const shutdown = async () => {
  server.close();
  await runtime.stop();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Lurkloot WebUI listening on http://0.0.0.0:${PORT}`);
});
