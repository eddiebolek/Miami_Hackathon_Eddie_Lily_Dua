// Excel (.xlsx/.xls) -> the same CSV text a CSV upload gives. Code reads every cell; nothing is guessed.
// SheetJS loads only when an Excel file is picked.
const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';

export const isExcel = file => /\.xlsx?$/i.test(file?.name || '');

export async function excelToCsv(file) {
  const X = await import(XLSX_URL);
  return sheetToCsv(X, X.read(await file.arrayBuffer(), {cellNF: true, dense: false}));
}

// First sheet only. Numbers use the stored value (at Excel's own 15 digits), never the on-screen rounding:
// a cell shown as $1,235 that holds 1234.56 becomes 1234.56. Date cells become YYYY-MM. Percent cells keep their %.
export function sheetToCsv(X, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return '';
  const date1904 = Boolean(wb.Workbook?.WBProps?.date1904);
  for (const [k, c] of Object.entries(ws)) {
    if (k[0] === '!' || c.t !== 'n') continue;
    if (c.z && X.SSF.is_date(c.z)) { const d = X.SSF.parse_date_code(c.v, {date1904}); c.w = `${d.y}-${String(d.m).padStart(2, '0')}`; }
    else { const pct = String(c.z || '').includes('%'); c.w = String(+(pct ? c.v * 100 : c.v).toPrecision(15)) + (pct ? '%' : ''); }
  }
  let rows = X.utils.sheet_to_json(ws, {header: 1, raw: false, defval: '', blankrows: false}).map(r => r.map(v => String(v).trim()));
  // Skip title lines above the header row: the header is the first row with 3 or more filled cells.
  const start = rows.findIndex(r => r.filter(Boolean).length >= 3);
  rows = start < 0 ? rows : rows.slice(start);
  // Drop columns that are empty from top to bottom (spacer columns).
  const width = Math.max(0, ...rows.map(r => r.length));
  const keep = [...Array(width).keys()].filter(i => rows.some(r => r[i]));
  const cell = v => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return rows.map(r => keep.map(i => cell(r[i] ?? '')).join(',')).join('\n') + '\n';
}
