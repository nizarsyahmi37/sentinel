/**
 * OIDC bearer-token sign-in (PRD Phase 2 "SSO"). Verifies RS256 JWTs issued by
 * the configured identity provider against its JWKS and maps claims to a
 * tenant, user and role. No passwords are handled by Sentinel.
 *   SENTINEL_OIDC_ISSUER, SENTINEL_OIDC_AUDIENCE, [SENTINEL_OIDC_JWKS_URL],
 *   [SENTINEL_OIDC_TENANT_CLAIM=tenant] [SENTINEL_OIDC_ROLE_CLAIM=role] [SENTINEL_OIDC_DEFAULT_TENANT]
 */
import { createPublicKey, createVerify } from "node:crypto";
import { ROLES, type Principal, type Role } from "./auth.js";
import type { FetchLike } from "./sources.js";
import { defaultFetch } from "./sources.js";

export interface OidcConfig {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  tenantClaim: string;
  roleClaim: string;
  defaultTenant: string | null;
  clockSkewSec: number;
}

export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  if (!env.SENTINEL_OIDC_ISSUER || !env.SENTINEL_OIDC_AUDIENCE) return null;
  return {
    issuer: env.SENTINEL_OIDC_ISSUER.replace(/\/$/u, ""), audience: env.SENTINEL_OIDC_AUDIENCE, jwksUrl: env.SENTINEL_OIDC_JWKS_URL,
    tenantClaim: env.SENTINEL_OIDC_TENANT_CLAIM ?? "tenant", roleClaim: env.SENTINEL_OIDC_ROLE_CLAIM ?? "role",
    defaultTenant: env.SENTINEL_OIDC_DEFAULT_TENANT ?? null, clockSkewSec: 60,
  };
}

const b64 = (s: string) => Buffer.from(s.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
const ID = /[^A-Za-z0-9_-]/gu;
export const looksLikeJwt = (t: string) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(t);

export class OidcError extends Error {}

export class OidcVerifier {
  private jwks: { at: number; keys: Record<string, unknown>[] } | null = null;
  constructor(
    readonly cfg: OidcConfig,
    private fetchImpl: FetchLike = defaultFetch,
    private nowMs: () => number = () => Date.now(),
  ) {}

  private async getKeys(force = false): Promise<Record<string, unknown>[]> {
    if (!force && this.jwks && this.nowMs() - this.jwks.at < 600_000) return this.jwks.keys;
    let url = this.cfg.jwksUrl;
    if (!url) {
      const d = await this.fetchImpl(`${this.cfg.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
      if (!d.ok) throw new OidcError(`OIDC discovery failed (HTTP ${d.status})`);
      url = ((await d.json()) as { jwks_uri?: string }).jwks_uri;
      if (!url) throw new OidcError("OIDC discovery has no jwks_uri");
    }
    const r = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new OidcError(`JWKS fetch failed (HTTP ${r.status})`);
    const keys = ((await r.json()) as { keys?: Record<string, unknown>[] }).keys ?? [];
    this.jwks = { at: this.nowMs(), keys };
    return keys;
  }

  async verify(token: string): Promise<Principal> {
    const [h, p, sig] = token.split(".") as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(b64(h).toString("utf8"));
      claims = JSON.parse(b64(p).toString("utf8"));
    } catch {
      throw new OidcError("malformed token");
    }
    if (header.alg !== "RS256") throw new OidcError("only RS256 tokens are accepted");
    let keys = await this.getKeys();
    let jwk = keys.find((k) => k.kid === header.kid && (k.use === undefined || k.use === "sig"));
    if (!jwk) {
      keys = await this.getKeys(true); // key rotation
      jwk = keys.find((k) => k.kid === header.kid);
    }
    if (!jwk) throw new OidcError("signing key not found");
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey({ key: jwk as never, format: "jwk" }), b64(sig));
    if (!ok) throw new OidcError("bad signature");
    const now = this.nowMs() / 1000;
    const skew = this.cfg.clockSkewSec;
    if (claims.iss !== this.cfg.issuer && claims.iss !== `${this.cfg.issuer}/`) throw new OidcError("wrong issuer");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.cfg.audience)) throw new OidcError("wrong audience");
    if (typeof claims.exp !== "number" || claims.exp + skew < now) throw new OidcError("token expired");
    if (typeof claims.nbf === "number" && claims.nbf - skew > now) throw new OidcError("token not yet valid");
    const sub = String(claims.preferred_username ?? claims.sub ?? "").replace(ID, "_").slice(0, 40);
    if (!sub) throw new OidcError("token has no subject");
    const rawTenant = claims[this.cfg.tenantClaim];
    const tenant = (typeof rawTenant === "string" ? rawTenant : this.cfg.defaultTenant ?? "").replace(ID, "_").slice(0, 40);
    if (!tenant) throw new OidcError("token has no tenant claim and no default tenant is configured");
    const rawRoles = claims[this.cfg.roleClaim];
    const roles = (Array.isArray(rawRoles) ? rawRoles : [rawRoles]).filter((r): r is Role => ROLES.includes(r as Role));
    const role: Role = roles.includes("admin") ? "admin" : roles.includes("analyst") ? "analyst" : "viewer";
    return { tenant, role, user: sub };
  }
}
