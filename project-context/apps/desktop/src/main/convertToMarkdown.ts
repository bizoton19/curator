import { extname } from "path";
import { PDFExtract } from "pdf.js-extract";
import mammoth from "mammoth";
import { OfficeParser } from "officeparser";

const EXTENSIONS_NEED_CONVERSION = new Set([
  ".docx",
  ".pdf",
  ".pptx",
  ".xlsx"
]);

export function needsConversion(ext: string): boolean {
  return EXTENSIONS_NEED_CONVERSION.has(ext.toLowerCase());
}

export async function convertToMarkdown(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (!EXTENSIONS_NEED_CONVERSION.has(ext)) {
    throw new Error(`File type ${ext} does not require conversion`);
  }

  switch (ext) {
    case ".pdf":
      return convertPdfToMarkdown(filePath);
    case ".docx":
      return convertDocxToMarkdown(filePath);
    case ".pptx":
      return convertPptxToMarkdown(filePath);
    case ".xlsx":
      return convertXlsxToMarkdown(filePath);
    default:
      throw new Error(`Unsupported conversion for ${ext}`);
  }
}

async function convertPdfToMarkdown(filePath: string): Promise<string> {
  const extractor = new PDFExtract();
  const result = await extractor.extract(filePath, {
    normalizeWhitespace: true
  });
  const text = result.pages
    .map((page) => {
      const lines = groupPdfItemsIntoLines(page.content);
      return lines.join("\n");
    })
    .filter((pageText) => pageText.trim())
    .join("\n\n");
  const formatted = formatPdfAsMarkdown(text);
  if (!formatted.trim()) {
    return [
      "# Preview unavailable",
      "",
      "This PDF appears to be scanned or image-based. There is no extractable text to display.",
      "",
      "You can still keep the file in context for AI analysis, but it will not be searchable without OCR."
    ].join("\n");
  }
  return formatted;
}

function formatPdfAsMarkdown(text: string): string {
  if (!text.trim()) return "";
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim()) {
      current.push(line.trim());
    } else if (current.length) {
      blocks.push(current.join(" "));
      current = [];
    }
  }
  if (current.length) blocks.push(current.join(" "));
  return blocks.join("\n\n");
}

function groupPdfItemsIntoLines(
  content: Array<{ x: number; y: number; str: string }>
): string[] {
  const sorted = [...content].sort((a, b) => {
    const yDiff = Math.abs(a.y - b.y);
    if (yDiff > 2) {
      return b.y - a.y;
    }
    return a.x - b.x;
  });
  const lines: Array<{ y: number; text: string[] }> = [];

  for (const item of sorted) {
    const value = item.str.trim();
    if (!value) continue;

    const existing = lines.find((line) => Math.abs(line.y - item.y) <= 2);
    if (existing) {
      existing.text.push(value);
      continue;
    }

    lines.push({ y: item.y, text: [value] });
  }

  return lines.map((line) => line.text.join(" "));
}

async function convertDocxToMarkdown(filePath: string): Promise<string> {
  const api = mammoth as unknown as {
    convertToMarkdown: (opts: { path: string }) => Promise<{ value: string }>;
  };
  const result = await api.convertToMarkdown({ path: filePath });
  return result.value || "";
}

async function convertPptxToMarkdown(filePath: string): Promise<string> {
  const ast = await OfficeParser.parseOffice(filePath, {
    extractAttachments: false,
    ocr: false,
    ignoreNotes: false
  });
  const text = (ast as { toText?: () => string }).toText?.() ?? "";
  return formatPptxAsMarkdown(text);
}

async function convertXlsxToMarkdown(filePath: string): Promise<string> {
  const ast = await OfficeParser.parseOffice(filePath, {
    extractAttachments: false,
    ocr: false,
    ignoreNotes: false
  });
  const text = (ast as { toText?: () => string }).toText?.() ?? "";
  return formatXlsxAsCsv(text);
}

function formatXlsxAsCsv(text: string): string {
  if (!text.trim()) return "";
  return text.trim();
}

function formatPptxAsMarkdown(text: string): string {
  if (!text.trim()) return "";
  return text
    .split(/\r?\n\r?\n+/)
    .map((block, i) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      return `## Slide ${i + 1}\n\n${trimmed}`;
    })
    .filter(Boolean)
    .join("\n\n");
}
