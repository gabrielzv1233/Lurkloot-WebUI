import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import * as webPush from "web-push";

export interface StoredPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

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

function parseSubscription(value: unknown): StoredPushSubscription {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Push subscription must be an object");
  }

  const raw = value as Record<string, unknown>;
  const keys = raw.keys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new Error("Push subscription is missing encryption keys");
  }

  const keyValues = keys as Record<string, unknown>;
  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
  const p256dh = typeof keyValues.p256dh === "string" ? keyValues.p256dh.trim() : "";
  const auth = typeof keyValues.auth === "string" ? keyValues.auth.trim() : "";

  if (!endpoint || !p256dh || !auth) {
    throw new Error("Push subscription is incomplete");
  }

  const url = new URL(endpoint);
  if (url.protocol !== "https:") {
    throw new Error("Push subscription endpoint must use HTTPS");
  }

  return {
    endpoint,
    expirationTime: typeof raw.expirationTime === "number" ? raw.expirationTime : null,
    keys: { p256dh, auth },
  };
}

export class NotificationHub {
  private readonly directory: string;
  private readonly vapidPath: string;
  private readonly subscriptionsPath: string;
  private readonly subscriptions = new Map<string, StoredPushSubscription>();
  private vapid?: VapidKeys;

  constructor(dataDirectory: string) {
    this.directory = join(dataDirectory, "notifications");
    this.vapidPath = join(this.directory, "vapid.json");
    this.subscriptionsPath = join(this.directory, "subscriptions.json");
  }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    this.vapid = await this.loadOrCreateVapid();

    webPush.setVapidDetails(
      "https://github.com/gabrielzv1233/Lurkloot-WebUI",
      this.vapid.publicKey,
      this.vapid.privateKey,
    );

    try {
      const raw = JSON.parse(await readFile(this.subscriptionsPath, "utf8")) as unknown;
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          try {
            const subscription = parseSubscription(entry);
            this.subscriptions.set(subscription.endpoint, subscription);
          } catch {
            // Ignore a malformed stale row instead of breaking all notifications.
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  publicKey(): string {
    if (!this.vapid) throw new Error("Notification hub is not initialized");
    return this.vapid.publicKey;
  }

  async subscribe(value: unknown): Promise<void> {
    const subscription = parseSubscription(value);
    this.subscriptions.set(subscription.endpoint, subscription);
    await this.persistSubscriptions();
  }

  async unsubscribe(endpoint: unknown): Promise<boolean> {
    if (typeof endpoint !== "string" || !endpoint.trim()) {
      throw new Error("Push subscription endpoint is required");
    }

    const removed = this.subscriptions.delete(endpoint.trim());
    if (removed) await this.persistSubscriptions();
    return removed;
  }

  async notify(title: string, body: string, url = "/"): Promise<void> {
    if (this.subscriptions.size === 0) return;

    const payload = JSON.stringify({ title, body, url });
    const expired = new Set<string>();

    const results = await Promise.allSettled(
      [...this.subscriptions.values()].map(async (subscription) => {
        try {
          await webPush.sendNotification(subscription, payload, { TTL: 120 });
        } catch (error) {
          const statusCode = (error as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            expired.add(subscription.endpoint);
            return;
          }
          throw error;
        }
      }),
    );

    if (expired.size > 0) {
      for (const endpoint of expired) this.subscriptions.delete(endpoint);
      await this.persistSubscriptions();
    }

    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("[push] delivery failed:", result.reason);
      }
    }
  }

  async test(): Promise<void> {
    await this.notify(
      "Lurkloot notifications enabled",
      "This browser is subscribed to WebUI notifications.",
      "/",
    );
  }

  private async loadOrCreateVapid(): Promise<VapidKeys> {
    try {
      const parsed = JSON.parse(await readFile(this.vapidPath, "utf8")) as Partial<VapidKeys>;
      if (parsed.publicKey && parsed.privateKey) {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const generated = webPush.generateVAPIDKeys();
    const keys = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
    };
    await writeJsonAtomic(this.vapidPath, keys);
    return keys;
  }

  private async persistSubscriptions(): Promise<void> {
    await writeJsonAtomic(this.subscriptionsPath, [...this.subscriptions.values()]);
  }
}
