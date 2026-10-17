import { createHash } from "node:crypto";

/** Methodology identifier recorded on every calculation and report. */
export const METHODOLOGY_VERSION = "sentinel_v1";

/** Round to a fixed precision so identical inputs give byte-identical output. */
export function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/** Deterministic JSON: object keys sorted, `undefined` dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function hashOf(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function shortId(prefix: string, value: unknown): string {
  return `${prefix}_${hashOf(value).slice(0, 12)}`;
}

export function pct(value: number, digits = 2): string {
  return `${round(value * 100, digits)}%`;
}
