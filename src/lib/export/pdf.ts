/**
 * Minimal PDF writer: one page that shows one JPEG image edge to edge.
 *
 * The recipe card is drawn once on a canvas; this wraps the resulting JPEG in
 * the smallest valid PDF around it, so the PDF and PNG exports are identical
 * and no PDF library is needed. JPEG data is stored as-is (PDF's DCTDecode
 * filter is JPEG), so nothing is re-encoded.
 */

export interface ImagePdfOptions {
  /** Page width in PDF points (1/72 inch). Default 595.28, the width of A4. Height follows the image's proportions. */
  pageWidth?: number;
  /** Document title shown by PDF viewers. */
  title?: string;
}

const encoder = new TextEncoder();

/** PDF literal strings are bytes; keep to printable ASCII and escape the three special characters. */
function pdfString(text: string): string {
  const ascii = text.replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
  return `(${ascii})`;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/**
 * Wrap a baseline or progressive JPEG in a single-page PDF.
 *
 * @param jpeg The JPEG file's bytes.
 * @param pixelWidth Image width in pixels.
 * @param pixelHeight Image height in pixels.
 * @throws {RangeError} when the data is not a JPEG or the dimensions are invalid.
 */
export function buildImagePdf(
  jpeg: Uint8Array,
  pixelWidth: number,
  pixelHeight: number,
  options: ImagePdfOptions = {},
): Uint8Array {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new RangeError('The image data is not a JPEG');
  if (!Number.isInteger(pixelWidth) || !Number.isInteger(pixelHeight) || pixelWidth <= 0 || pixelHeight <= 0) {
    throw new RangeError(`Invalid image size ${pixelWidth} x ${pixelHeight}`);
  }
  const pageWidth = options.pageWidth ?? 595.28;
  if (!(pageWidth > 0)) throw new RangeError('pageWidth must be positive');
  const pageHeight = (pageWidth * pixelHeight) / pixelWidth;
  const width = formatNumber(pageWidth);
  const height = formatNumber(pageHeight);

  // Scale the unit square the image is drawn in up to the full page.
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (data: string | Uint8Array) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, body: string, stream?: Uint8Array) => {
    offsets[id] = length;
    push(`${id} 0 obj\n${body}\n`);
    if (stream !== undefined) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };

  // The comment line of high bytes marks the file as binary for transfer tools.
  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
  );
  object(4, `<< /Length ${content.length} >>`, encoder.encode(content));
  object(
    5,
    `<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
    jpeg,
  );
  object(6, `<< /Title ${pdfString(options.title ?? 'Colour recipe')} /Producer ${pdfString('Color Me Worst')} >>`);

  const xrefOffset = length;
  const objectCount = 7; // objects 1-6 plus the mandatory free entry 0
  let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let id = 1; id < objectCount; id++) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${objectCount} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    out.set(chunk, position);
    position += chunk.length;
  }
  return out;
}
