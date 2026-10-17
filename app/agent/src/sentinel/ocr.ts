/**
 * Optional OCR for scanned PDFs and images (PRD: "OCR of scanned documents").
 * Uses tesseract.js and @napi-rs/canvas, installed as optional dependencies and
 * loaded dynamically. When they are missing (for example in a bundled ZIP
 * runtime) or SENTINEL_OCR=off, OCR reports itself unavailable and documents
 * are flagged unreadable as before — never silently guessed.
 * OCR output is lower trust than a text layer and is labelled as such.
 */
export interface OcrResult {
  text: string;
  confidence: number; // 0..1 mean word confidence
  pages: number;
  engine: string;
}

export const MAX_OCR_PAGES = 10;

let engineProbe: Promise<{ ok: true } | { ok: false; reason: string }> | null = null;
const dyn = (name: string): Promise<any> => import(/* @vite-ignore */ name as string);

export function ocrAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (process.env.SENTINEL_OCR === "off") return Promise.resolve({ ok: false, reason: "OCR is disabled (SENTINEL_OCR=off)." });
  engineProbe ??= (async () => {
    try {
      await dyn("tesseract.js");
      await dyn("@napi-rs/canvas");
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, reason: `OCR engine not installed in this runtime (${e instanceof Error ? e.message.split("\n")[0] : String(e)}).` };
    }
  })();
  return engineProbe;
}

async function recognize(images: (Buffer | Uint8Array)[], langPath?: string): Promise<OcrResult> {
  const T = await dyn("tesseract.js");
  const createWorker = (T.createWorker ?? T.default?.createWorker) as (lang: string, oem?: number, opts?: Record<string, unknown>) => Promise<any>;
  const worker = await createWorker("eng", 1, { ...(langPath ? { cachePath: langPath } : {}) });
  try {
    const parts: string[] = [];
    let confSum = 0;
    let confN = 0;
    for (const [i, img] of images.entries()) {
      const r = await worker.recognize(Buffer.from(img));
      parts.push(`[page ${i + 1}]\n${r.data.text ?? ""}`);
      const words = (r.data.words ?? []) as { confidence: number }[];
      for (const w of words) {
        confSum += w.confidence;
        confN++;
      }
      if (!words.length && typeof r.data.confidence === "number") {
        confSum += r.data.confidence;
        confN++;
      }
    }
    return { text: parts.join("\n"), confidence: confN ? confSum / confN / 100 : 0, pages: images.length, engine: "ocr:tesseract.js@7" };
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

export async function ocrImage(buf: Buffer, langPath?: string): Promise<OcrResult> {
  return recognize([buf], langPath);
}

/** Renders up to MAX_OCR_PAGES pages of a PDF to images and OCRs them. */
export async function ocrPdf(pdf: unknown, totalPages: number, langPath?: string): Promise<OcrResult & { truncated: boolean }> {
  const { renderPageAsImage } = await import("unpdf");
  const n = Math.min(totalPages, MAX_OCR_PAGES);
  const imgs: Uint8Array[] = [];
  for (let p = 1; p <= n; p++) imgs.push(new Uint8Array(await renderPageAsImage(pdf as never, p, { canvasImport: () => dyn("@napi-rs/canvas"), scale: 2 })));
  const r = await recognize(imgs, langPath);
  return { ...r, truncated: totalPages > n };
}
