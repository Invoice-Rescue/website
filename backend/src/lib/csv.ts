/** Minimal CSV parser — comma-separated, double-quote escaping, header row required.
 * No dependency: the file is small enough that a library would cost more than it saves. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = splitCsvRows(text).filter((r) => !(r.length === 1 && r[0] === ""));
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

function splitCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") endField();
    else if (c === "\n") endRow();
    else if (c === "\r") continue;
    else field += c;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}
