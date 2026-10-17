/**
 * Accounts and role-based access (PRD Phase 2). Credentials are API keys;
 * each key maps to a tenant (the account), a user label and a role.
 *   SENTINEL_API_KEYS="secretA;tenant=acme;role=analyst;user=alice,secretB;tenant=acme;role=viewer;user=bob"
 * A bare key (legacy) is an admin of its own private tenant.
 */
import { createHash } from "node:crypto";

export const ROLES = ["viewer", "analyst", "admin"] as const;
export type Role = (typeof ROLES)[number];
export interface Principal {
  tenant: string;
  role: Role;
  user: string;
}

const RANK: Record<Role, number> = { viewer: 0, analyst: 1, admin: 2 };
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const ID = /^[A-Za-z0-9_-]{1,40}$/u;

export function parseApiKeys(entries: string[]): { keys: Map<string, Principal>; errors: string[] } {
  const keys = new Map<string, Principal>();
  const errors: string[] = [];
  for (const raw of entries.map((e) => e.trim()).filter(Boolean)) {
    const [secret, ...opts] = raw.split(";").map((x) => x.trim());
    if (!secret) continue;
    const o: Record<string, string> = {};
    for (const kv of opts) {
      const i = kv.indexOf("=");
      if (i > 0) o[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
    const h = sha256(secret);
    const role = (o.role ?? "admin") as Role;
    if (!ROLES.includes(role)) {
      errors.push(`unknown role "${o.role}" (use ${ROLES.join(", ")}); key ignored`);
      continue;
    }
    if ((o.tenant && !ID.test(o.tenant)) || (o.user && !ID.test(o.user))) {
      errors.push("tenant/user must match [A-Za-z0-9_-]{1,40}; key ignored");
      continue;
    }
    keys.set(h, { tenant: o.tenant ?? `t_${h.slice(0, 12)}`, role, user: o.user ?? `key_${h.slice(0, 6)}` });
  }
  return { keys, errors };
}

/** Minimum role needed for a request. Paths are relative to /api/v1. */
export function requiredRole(method: string, path: string): Role {
  const m = method.toUpperCase();
  if (path.startsWith("/billing") || path.startsWith("/export") || path.startsWith("/webhooks")) return "admin";
  if (path.startsWith("/agent/hire") && m !== "GET") return "admin";
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return "viewer";
  if (m === "DELETE") return "admin";
  return "analyst";
}

export const canDo = (role: Role, need: Role) => RANK[role] >= RANK[need];
