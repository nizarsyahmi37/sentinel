/**
 * Document ingestion (FR-04). PDF text via unpdf (no OCR: scanned PDFs are
 * flagged unreadable rather than guessed). Extracted text is untrusted data.
 */
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { extractText, getDocumentProxy } from "unpdf";
import { MAX_OCR_PAGES, ocrAvailable, ocrImage, ocrPdf } from "./ocr.js";
import type { DossierDocument } from "./types.js";
import { DOCUMENT_KINDS } from "./types.js";
import { extractFromText } from "./evidence.js";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(["pdf", "txt", "csv", "json", "md", "png", "jpg", "jpeg"]);
const IMAGE = new Set(["png", "jpg", "jpeg"]);

export class DocumentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ocrCache = process.env.SENTINEL_DATA_DIR ? `${process.env.SENTINEL_DATA_DIR}/_ocr` : `${tmpdir()}/sentinel-ocr`;

export interface UploadInput {
  doc_id: string;
  title?: string;
  kind: (typeof DOCUMENT_KINDS)[number];
  filename: string;
  content_base64?: string;
  text?: string;
}

export async function ingestDocument(u: UploadInput): Promise<{ document: DossierDocument; summary: Record<string, unknown> }> {
  const ext = u.filename.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED.has(ext)) throw new DocumentError("unsupported_type", `File type .${ext} is not allowed (pdf, txt, csv, json, md, png, jpg).`);
  let text = "";
  let pages = 1;
  let readable = true;
  let quality = 0.9;
  let extractor = "plain-text@1";
  let sha256: string | undefined;
  const notes: string[] = [];
  if (u.text !== undefined && ext !== "pdf") {
    text = u.text;
    sha256 = createHash("sha256").update(u.text).digest("hex");
  } else if (u.content_base64) {
    const buf = Buffer.from(u.content_base64, "base64");
    if (buf.length === 0) throw new DocumentError("empty_file", "The file is empty.");
    sha256 = createHash("sha256").update(buf).digest("hex");
    if (buf.length > MAX_UPLOAD_BYTES) throw new DocumentError("too_large", `File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    if (IMAGE.has(ext)) {
      const magic = buf.subarray(0, 4).toString("hex");
      if (!(magic.startsWith("89504e47") || magic.startsWith("ffd8ff"))) throw new DocumentError("bad_image", "File does not look like a PNG or JPEG image.");
      const avail = await ocrAvailable();
      if (!avail.ok) {
        readable = false;
        quality = 0;
        extractor = "image-unread";
        notes.push(`Image cannot be read: ${avail.reason} Supply a text version.`);
      } else {
        extractor = "ocr:tesseract.js@7";
        try {
          const o = await ocrImage(buf, ocrCache);
          text = o.text;
          quality = Math.round(o.confidence * 0.8 * 100) / 100;
          notes.push(`OCR (tesseract.js): mean word confidence ${(o.confidence * 100).toFixed(0)}%. OCR text can misread digits — verify every number against the original.`);
          if (o.confidence < 0.5 || text.replace(/\s/gu, "").length < 20) {
            readable = false;
            notes.push("OCR confidence is too low to trust; document treated as unreadable.");
          }
        } catch (e) {
          readable = false;
          quality = 0;
          notes.push(`OCR failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else if (ext === "pdf") {
      if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new DocumentError("bad_pdf", "File does not look like a PDF.");
      extractor = "unpdf-text@1";
      try {
        const pdf = await getDocumentProxy(new Uint8Array(buf));
        const res = await extractText(pdf, { mergePages: false });
        pages = res.totalPages;
        text = (res.text as string[]).map((t, i) => `[page ${i + 1}]\n${t}`).join("\n");
        const chars = (res.text as string[]).join("").trim().length;
        if (chars < 40) {
          readable = false;
          quality = 0.1;
          const avail = await ocrAvailable();
          if (avail.ok) {
            try {
              const o = await ocrPdf(pdf, pages, ocrCache);
              extractor = "ocr:tesseract.js@7";
              text = o.text;
              quality = Math.round(o.confidence * 0.8 * 100) / 100;
              readable = o.confidence >= 0.5 && text.replace(/\s/gu, "").length >= 20;
              notes.push(`Scanned PDF read with OCR (tesseract.js): ${o.pages} page(s)${o.truncated ? ` of ${pages} (limit ${MAX_OCR_PAGES})` : ""}, mean confidence ${(o.confidence * 100).toFixed(0)}%. OCR text can misread digits — verify every number against the original.`);
              if (!readable) notes.push("OCR confidence is too low to trust; document treated as unreadable.");
            } catch (e) {
              notes.push(`No extractable text and OCR failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          } else {
            notes.push(`No extractable text (likely a scanned PDF). ${avail.reason} Supply a text version.`);
          }
        } else if (chars / pages < 200) {
          quality = 0.4;
          notes.push("Very little text per page; extraction is likely incomplete.");
        }
      } catch (e) {
        readable = false;
        quality = 0;
        notes.push(`PDF could not be parsed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      text = buf.toString("utf8");
    }
  } else {
    throw new DocumentError("no_content", "Provide content_base64 or text.");
  }
  const document: DossierDocument = {
    doc_id: u.doc_id,
    title: u.title ?? u.filename,
    kind: u.kind,
    text: text.slice(0, 400_000),
    extraction_quality: quality,
    readable,
    ...(sha256 ? { sha256 } : {}),
    extractor,
    original_filename: u.filename.slice(0, 200),
  };
  const claims = readable ? extractFromText(document.text ?? "") : [];
  return {
    document,
    summary: { doc_id: u.doc_id, sha256, extractor, pages, readable, extraction_quality: quality, candidate_fields: claims, notes, verified: false, note: "Extracted values are candidates and are NOT independently verified." },
  };
}
