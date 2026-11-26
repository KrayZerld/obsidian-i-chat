export interface PasteFileLike {
  name: string;
  type: string;
}

export interface ClipboardPasteInput<TFile extends PasteFileLike = File> {
  files: TFile[];
  plainText: string;
  html: string;
}

export type PasteAction<TFile extends PasteFileLike = File> =
  | { kind: "attachments"; files: TFile[] }
  | { kind: "insert-text"; text: string }
  | { kind: "default" };

interface ExtractedHtmlTable {
  grid: string[][];
  isPureTable: boolean;
}

const HTML_ENTITY_MAP: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z0-9]+);/g, (full, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower in HTML_ENTITY_MAP) {
      return HTML_ENTITY_MAP[lower];
    }
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return full;
  });
}

function normalizeCellLines(rawWithNewlines: string): string {
  const lines = rawWithNewlines
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim());

  while (lines.length > 0 && lines[0] === "") {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.join("<br>");
}

function escapeMarkdownCell(cell: string): string {
  return cell.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim();
}

export function formatMarkdownTable(rawGrid: string[][]): string | null {
  const rows = rawGrid.map((row) => [...row]);
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell.trim() === "")) {
    rows.pop();
  }
  if (rows.length === 0) {
    return null;
  }

  let colCount = 0;
  for (const row of rows) {
    if (row.length > colCount) {
      colCount = row.length;
    }
  }
  if (colCount === 0) {
    return null;
  }

  // Single cell (1x1) should be pasted as plain text rather than a 1x1 Markdown table
  if (rows.length === 1 && colCount === 1) {
    return null;
  }

  const formatRow = (row: string[]): string => {
    const cells: string[] = [];
    for (let c = 0; c < colCount; c++) {
      cells.push(escapeMarkdownCell(row[c] ?? ""));
    }
    return `| ${cells.join(" | ")} |`;
  };

  const lines: string[] = [
    formatRow(rows[0]),
    `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`,
  ];
  for (let r = 1; r < rows.length; r++) {
    lines.push(formatRow(rows[r]));
  }
  return lines.join("\n");
}

function extractCellTextFromDom(cell: Element): string {
  const parts: string[] = [];
  const blockTags = new Set(["P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6"]);

  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      // Text node: collapse HTML source formatting line breaks/tabs into spaces
      const text = (node.nodeValue ?? "").replace(/[\r\n\t]+/g, " ");
      parts.push(text);
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (tag === "STYLE" || tag === "SCRIPT" || tag === "NOSCRIPT") {
      return;
    }
    if (tag === "BR") {
      parts.push("\n");
      return;
    }
    const isBlock = blockTags.has(tag);
    if (isBlock && parts.length > 0 && !parts[parts.length - 1].endsWith("\n")) {
      parts.push("\n");
    }
    for (const child of Array.from(el.childNodes)) {
      walk(child);
    }
    if (isBlock && parts.length > 0 && !parts[parts.length - 1].endsWith("\n")) {
      parts.push("\n");
    }
  };

  walk(cell);
  return normalizeCellLines(parts.join(""));
}

function extractHtmlTableWithDom(html: string): ExtractedHtmlTable | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body) {
    return null;
  }

  const topTables = Array.from(body.querySelectorAll("table")).filter(
    (table) => !table.parentElement?.closest("table")
  );
  if (topTables.length === 0) {
    return null;
  }
  if (topTables.length > 1) {
    return { grid: [], isPureTable: false };
  }

  // Verify there is no meaningful non-table text outside the single table
  const clone = body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("table, style, script, meta, link, title").forEach((el) => el.remove());
  const outsideText = (clone.textContent ?? "").replace(/\u00a0/g, " ").trim();
  if (outsideText.length > 0) {
    return { grid: [], isPureTable: false };
  }

  const table = topTables[0];
  const rowEls = Array.from(table.querySelectorAll("tr")).filter(
    (tr) => tr.closest("table") === table
  );
  if (rowEls.length === 0) {
    return null;
  }

  const grid: string[][] = [];
  const occupied = new Set<string>();

  for (let r = 0; r < rowEls.length; r++) {
    if (!grid[r]) {
      grid[r] = [];
    }
    const cellEls = Array.from(rowEls[r].children).filter(
      (child) => child.tagName === "TD" || child.tagName === "TH"
    );
    let col = 0;
    for (const cell of cellEls) {
      while (occupied.has(`${r}:${col}`)) {
        if (grid[r][col] === undefined) {
          grid[r][col] = "";
        }
        col++;
      }

      const text = extractCellTextFromDom(cell);
      const colSpan = Math.max(1, Number.parseInt(cell.getAttribute("colspan") ?? "1", 10) || 1);
      const rowSpan = Math.max(1, Number.parseInt(cell.getAttribute("rowspan") ?? "1", 10) || 1);

      grid[r][col] = text;
      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) {
          if (dr === 0 && dc === 0) continue;
          const trIdx = r + dr;
          const tcIdx = col + dc;
          occupied.add(`${trIdx}:${tcIdx}`);
          if (!grid[trIdx]) {
            grid[trIdx] = [];
          }
          if (grid[trIdx][tcIdx] === undefined) {
            grid[trIdx][tcIdx] = "";
          }
        }
      }
      col += colSpan;
    }
  }

  return { grid, isPureTable: true };
}

function parseSpanAttr(attrs: string, name: string): number {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"(\\d+)"|'(\\d+)'|(\\d+))`, "i");
  const match = attrs.match(re);
  if (!match) return 1;
  const val = Number.parseInt(match[1] ?? match[2] ?? match[3] ?? "1", 10);
  return Number.isFinite(val) && val > 0 ? val : 1;
}

function extractCellTextFromRawHtml(innerHtml: string): string {
  const withoutNoise = innerHtml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "");

  // Collapse raw HTML source line breaks before converting <br> and block boundaries
  const collapsedSource = withoutNoise.replace(/[\r\n\t]+/g, " ");
  const withBreaks = collapsedSource
    .replace(/<br\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return normalizeCellLines(decodeHtmlEntities(withBreaks));
}

function extractHtmlTableFallback(html: string): ExtractedHtmlTable | null {
  const cleaned = html
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const tableMatches = [...cleaned.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  if (tableMatches.length === 0) {
    return null;
  }
  if (tableMatches.length > 1) {
    return { grid: [], isPureTable: false };
  }

  const outsideHtml = cleaned.replace(tableMatches[0][0], "");
  const outsideText = decodeHtmlEntities(outsideHtml.replace(/<[^>]+>/g, ""))
    .replace(/\u00a0/g, " ")
    .trim();
  if (outsideText.length > 0) {
    return { grid: [], isPureTable: false };
  }

  const tableInner = tableMatches[0][1];
  const rowMatches = [...tableInner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rowMatches.length === 0) {
    return null;
  }

  const grid: string[][] = [];
  const occupied = new Set<string>();

  for (let r = 0; r < rowMatches.length; r++) {
    if (!grid[r]) {
      grid[r] = [];
    }
    const cellMatches = [...rowMatches[r][1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)];
    let col = 0;
    for (const match of cellMatches) {
      while (occupied.has(`${r}:${col}`)) {
        if (grid[r][col] === undefined) {
          grid[r][col] = "";
        }
        col++;
      }

      const attrs = match[1] ?? "";
      const text = extractCellTextFromRawHtml(match[2] ?? "");
      const colSpan = parseSpanAttr(attrs, "colspan");
      const rowSpan = parseSpanAttr(attrs, "rowspan");

      grid[r][col] = text;
      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) {
          if (dr === 0 && dc === 0) continue;
          const trIdx = r + dr;
          const tcIdx = col + dc;
          occupied.add(`${trIdx}:${tcIdx}`);
          if (!grid[trIdx]) {
            grid[trIdx] = [];
          }
          if (grid[trIdx][tcIdx] === undefined) {
            grid[trIdx][tcIdx] = "";
          }
        }
      }
      col += colSpan;
    }
  }

  return { grid, isPureTable: true };
}

export function extractPureHtmlTable(html: string): ExtractedHtmlTable | null {
  if (!html || !/<table\b/i.test(html)) {
    return null;
  }
  if (typeof DOMParser !== "undefined") {
    return extractHtmlTableWithDom(html);
  }
  return extractHtmlTableFallback(html);
}

/**
 * Fallback TSV parser used only when spreadsheet clipboard data contains an accompanying
 * image preview + tab-separated plain text but no HTML table.
 */
export function convertTsvToMarkdownTable(plainText: string): string | null {
  const normalized = plainText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return null;
  }

  const rows = lines.map((line) => line.split("\t"));
  const colCount = rows[0].length;
  if (colCount < 2) {
    return null;
  }
  // Require uniform column count across rows to avoid misclassifying tab-indented code
  if (!rows.every((row) => row.length === colCount)) {
    return null;
  }

  return formatMarkdownTable(rows);
}

/**
 * Decides how a Composer paste event should be handled:
 * - Real file/screenshot pastes -> add as attachments
 * - Excel / spreadsheet / HTML table pastes (which often include an extra image.png preview) -> insert Markdown table
 * - Rich text pastes with an extra office preview bitmap -> keep plain text instead of attaching image.png
 */
export function resolvePasteAction<TFile extends PasteFileLike>(
  input: ClipboardPasteInput<TFile>
): PasteAction<TFile> {
  const { files, plainText, html } = input;

  // 1. Any non-image file (e.g. PDF, MD, DOCX, XLSX copied from file explorer) is always an attachment
  const hasNonImageFile = files.some((file) => !file.type.toLowerCase().startsWith("image/"));
  if (files.length > 0 && hasNonImageFile) {
    return { kind: "attachments", files };
  }

  // 2. Pure HTML table (Excel, WPS, Google Sheets, single table from web) -> Markdown table
  const extractedTable = extractPureHtmlTable(html);
  if (extractedTable && extractedTable.isPureTable) {
    const markdownTable = formatMarkdownTable(extractedTable.grid);
    if (markdownTable) {
      return { kind: "insert-text", text: markdownTable };
    }
    // Single-cell Excel copy (1x1) often carries an extra image.png preview + trailing newline
    const singleCell = (extractedTable.grid[0]?.[0] ?? "").replace(/<br>/g, "\n").trim();
    if (files.length > 0) {
      return { kind: "insert-text", text: singleCell || plainText.trim() };
    }
    return { kind: "default" };
  }

  // 3. Only image files present: distinguish true image/screenshot paste from Office text+preview paste
  if (files.length > 0) {
    const trimmedPlain = plainText.trim();
    const isSingleFileNameOnly =
      files.length === 1 && trimmedPlain.length > 0 && trimmedPlain === files[0].name;

    if (trimmedPlain.length > 0 && !isSingleFileNameOnly) {
      const tsvTable = convertTsvToMarkdownTable(plainText);
      if (tsvTable) {
        return { kind: "insert-text", text: tsvTable };
      }
      return { kind: "insert-text", text: plainText };
    }
    return { kind: "attachments", files };
  }

  return { kind: "default" };
}
