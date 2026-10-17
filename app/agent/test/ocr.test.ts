import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { ingestDocument } from "../src/sentinel/documents.js";
import { ocrAvailable } from "../src/sentinel/ocr.js";

function page(): { png: Buffer; jpg: Buffer } {
  const c = createCanvas(1000, 300);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, 1000, 300); g.fillStyle = "#000"; g.font = "36px sans-serif";
  g.fillText("Total tokens outstanding: 5,000", 40, 100); g.fillText("Shares held in custody: 1,000", 40, 180);
  return { png: c.toBuffer("image/png"), jpg: c.toBuffer("image/jpeg") };
}

/** Minimal single-page PDF whose only content is a JPEG image (a "scanned" document: no text layer). */
function scannedPdf(jpg: Buffer, w = 1000, h = 300): Buffer {
  const objs: Buffer[] = [];
  const add = (b: string | Buffer) => objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b));
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`), jpg, Buffer.from("\nendstream")]));
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  let out = Buffer.from("%PDF-1.4\n");
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from("\nendobj\n")]);
  });
  const xref = out.length;
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([out, Buffer.from(tail)]);
}

describe("OCR for scanned documents", async () => {
  const avail = await ocrAvailable();
  const skip = avail.ok ? false : `OCR engine not installed: ${(avail as { reason: string }).reason}`;
  const live = (r: Awaited<ReturnType<typeof ingestDocument>>) => {
    if (!r.summary.readable && /OCR failed/u.test(String(r.summary.notes))) return false; // e.g. language data could not be downloaded offline
    return true;
  };

  it("reads a PNG scan, extracts the figures as unverified candidates, labels the extractor and hash", { skip, timeout: 120_000 }, async (t) => {
    const { png } = page();
    const r = await ingestDocument({ doc_id: "scan1", kind: "reserve_report", filename: "scan.png", content_base64: png.toString("base64") });
    if (!live(r)) return t.skip("OCR language data unavailable (offline)");
    assert.equal(r.summary.readable, true);
    assert.equal(r.document.extractor, "ocr:tesseract.js@7");
    assert.ok(r.document.sha256 && r.document.sha256.length === 64);
    assert.ok((r.summary.candidate_fields as { field: string; value: number }[]).some((c) => c.field === "token_supply" && c.value === 5000));
    assert.equal(r.summary.verified, false);
    assert.match(String(r.summary.notes), /misread digits/u);
    assert.ok(r.document.extraction_quality! < 0.9, "OCR is trusted less than a text layer");
  });

  it("reads a scanned PDF (no text layer) page by page", { skip, timeout: 120_000 }, async (t) => {
    const { jpg } = page();
    const r = await ingestDocument({ doc_id: "scan2", kind: "custody_attestation", filename: "scan.pdf", content_base64: scannedPdf(jpg).toString("base64") });
    if (!live(r)) return t.skip("OCR language data unavailable (offline)");
    assert.equal(r.summary.readable, true);
    assert.equal(r.document.extractor, "ocr:tesseract.js@7");
    assert.ok((r.summary.candidate_fields as { field: string; value: number }[]).some((c) => c.field === "shares_in_custody" && c.value === 1000));
  });

  it("a blank image is unreadable, not guessed; non-images are refused", { skip, timeout: 120_000 }, async (t) => {
    const c = createCanvas(400, 200); const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 400, 200);
    const r = await ingestDocument({ doc_id: "blank", kind: "other", filename: "blank.png", content_base64: c.toBuffer("image/png").toString("base64") });
    if (!live(r)) return t.skip("OCR language data unavailable (offline)");
    assert.equal(r.summary.readable, false);
    assert.deepEqual(r.summary.candidate_fields, []);
    await assert.rejects(ingestDocument({ doc_id: "x", kind: "other", filename: "x.png", content_base64: Buffer.from("not an image").toString("base64") }), /does not look like a PNG or JPEG/u);
  });

  it("OCR can be switched off and the document is then flagged unreadable with the reason", async () => {
    process.env.SENTINEL_OCR = "off";
    try {
      const { png } = page();
      // the probe is memoised per process, so use a fresh module instance
      const mod = await import(`../src/sentinel/documents.js?off=${Date.now()}`);
      const r = await mod.ingestDocument({ doc_id: "s", kind: "other", filename: "s.png", content_base64: png.toString("base64") });
      assert.equal(r.summary.readable, false);
      assert.match(String(r.summary.notes), /OCR is disabled/u);
    } finally { delete process.env.SENTINEL_OCR; }
  });
});
