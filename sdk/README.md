# Sentinel SDK

Zero-dependency TypeScript client for the Sentinel `/api/v1` API (`sentinel-client.ts`).
The machine-readable contract is served at `GET /api/v1/openapi.json`.

```ts
import { SentinelClient, verifyWebhook } from "./sentinel-client";
const s = new SentinelClient({ baseUrl: "http://localhost:9000/api/v1", apiKey: process.env.SENTINEL_KEY });
await s.saveAsset({ underlying: "NVDA" });
const run = await s.assess("tok-nvda");
console.log(run.report.assessment.status, run.report.hashes.calculation_hash);
```
Webhooks: `verifyWebhook(secret, headers, rawBody)` checks the HMAC signature and timestamp.
Marketplace listings need accounts on those marketplaces and are not included.
