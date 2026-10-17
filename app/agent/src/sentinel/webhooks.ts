/**
 * Webhook alerts (PRD Phase 4). Outbound-only, signed, https-only, with SSRF
 * protection: private, loopback and link-local destinations are refused after
 * DNS resolution, and redirects are not followed.
 */
import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Store } from "./store.js";

export const WEBHOOK_EVENTS = ["analysis.completed", "analysis.failed", "monitor.triggered"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookRecord {
  webhook_id: string;
  url: string;
  events: WebhookEvent[];
  secret: string;
  created_at: string;
  created_by: string;
  active: boolean;
  last_delivery?: { at: string; ok: boolean; status: number | null; error: string | null };
}

export type Resolver = (host: string) => Promise<string[]>;
export const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::1" || x === "::") return true;
    if (x.startsWith("::ffff:")) return isPrivateAddress(x.slice(7));
    return /^f[cd]/u.test(x) || /^fe[89ab]/u.test(x) || x.startsWith("ff");
  }
  return true; // not an IP: treat as unsafe
}

export async function assertSafeWebhookUrl(raw: string, resolve: Resolver = defaultResolver): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("url is not valid");
  }
  if (u.protocol !== "https:") throw new Error("webhook url must use https");
  if (u.username || u.password) throw new Error("credentials in the url are not allowed");
  const host = u.hostname.replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw new Error("internal hostnames are not allowed");
  const addrs = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (!addrs.length) throw new Error("hostname did not resolve");
  if (addrs.some(isPrivateAddress)) throw new Error("destination resolves to a private or loopback address");
  return u;
}

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString("hex")}`;

export function signPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

type PostFn = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "manual"; signal: AbortSignal }) => Promise<{ status: number }>;
export interface WebhookEnv {
  store: Store;
  now: () => Date;
  webhookPost?: PostFn;
  resolveHost?: Resolver;
}

export async function dispatchWebhooks(env: WebhookEnv, tenant: string, event: WebhookEvent, data: Record<string, unknown>): Promise<number> {
  const hooks = env.store.listWebhooks(tenant).filter((h) => h.active && h.events.includes(event));
  const post: PostFn = env.webhookPost ?? ((url, init) => fetch(url, init as RequestInit));
  let delivered = 0;
  await Promise.all(
    hooks.map(async (h) => {
      const at = env.now().toISOString();
      let status: number | null = null;
      let error: string | null = null;
      try {
        const u = await assertSafeWebhookUrl(h.url, env.resolveHost); // re-check at send time (DNS can change)
        const body = JSON.stringify({ id: `evt_${randomBytes(8).toString("hex")}`, event, created_at: at, tenant, data });
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const r = await post(u.toString(), { method: "POST", headers: { "content-type": "application/json", "user-agent": "Sentinel-Webhook/1", "x-sentinel-event": event, "x-sentinel-timestamp": at, "x-sentinel-signature": signPayload(h.secret, at, body) }, body, redirect: "manual", signal: AbortSignal.timeout(5000) });
            status = r.status;
            if (r.status >= 200 && r.status < 300) {
              error = null;
              break;
            }
            error = `HTTP ${r.status}`;
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
          if (attempt < 3) await new Promise((res) => setTimeout(res, env.webhookPost ? 0 : 500 * attempt));
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const ok = error === null;
      if (ok) delivered++;
      env.store.putWebhook(tenant, { ...h, last_delivery: { at, ok, status, error } });
      env.store.audit(tenant, { event: "webhook_delivery", detail: { webhook_id: h.webhook_id, event_type: event, ok, status, error } }, env.now());
    }),
  );
  return delivered;
}
