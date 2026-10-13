// GS1 barcode parsing for pharmacy packs (GS1 DataMatrix / GS1-128).
//
// Scanners deliver the same data in a few shapes:
//   1. Raw element string with FNC1 sent as ASCII 29 (GS):  "0106281086001234172708311" + "0GL554" …
//   2. With a symbology identifier prefix:                   "]d2010628…"  (DataMatrix), "]C1…" (GS1-128), "]Q3…" (QR)
//   3. Human-readable with parentheses:                      "(01)06281086001234(17)270831(10)GL554"
//   4. A plain EAN-13 / UPC / internal code with no AIs at all.

export interface Gs1Data {
  gtin?: string; // AI 01, 14 digits
  expiry?: string; // AI 17 as YYYY-MM-DD
  batch?: string; // AI 10
  serial?: string; // AI 21
  productionDate?: string; // AI 11 as YYYY-MM-DD
  raw: string;
}

export type ScanResult =
  | { kind: "gs1"; data: Gs1Data }
  | { kind: "plain"; code: string };

const GS = "\u001d";

// Fixed-length AIs we care about; everything else in the table is variable length (ended by GS or end of data).
const FIXED: Record<string, number> = { "00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6 };
const VARIABLE_MAX: Record<string, number> = { "10": 20, "21": 20, "22": 20, "30": 8, "240": 30, "241": 30, "710": 20, "711": 20, "712": 20, "713": 20, "714": 20 };

/** Converts GS1 YYMMDD to ISO date. DD = 00 means "last day of that month" (common on medicine packs). */
export function gs1DateToIso(yymmdd: string): string | undefined {
  if (!/^\d{6}$/.test(yymmdd)) return undefined;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  let dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12) return undefined;
  const year = 2000 + yy;
  const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  if (dd === 0) dd = lastDay;
  if (dd > lastDay) return undefined;
  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function stripSymbologyId(s: string): string {
  return /^\][A-Za-z]\d/.test(s) ? s.slice(3) : s;
}

function assign(out: Gs1Data, ai: string, value: string): void {
  switch (ai) {
    case "01":
    case "02":
      out.gtin = value;
      break;
    case "17":
      out.expiry = gs1DateToIso(value);
      break;
    case "11":
      out.productionDate = gs1DateToIso(value);
      break;
    case "10":
      out.batch = value;
      break;
    case "21":
      out.serial = value;
      break;
    default:
      break;
  }
}

function parseParenthesised(s: string): Gs1Data | null {
  const re = /\((\d{2,4})\)([^(]*)/g;
  const out: Gs1Data = { raw: s };
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = re.exec(s)) !== null) {
    found = true;
    assign(out, m[1], m[2].trim());
  }
  return found ? out : null;
}

function matchAi(s: string, i: number): string | null {
  for (const len of [2, 3]) {
    const ai = s.slice(i, i + len);
    if (ai in FIXED || ai in VARIABLE_MAX) return ai;
  }
  return null;
}

function parseElementString(s: string): Gs1Data | null {
  const out: Gs1Data = { raw: s };
  let i = 0;
  let count = 0;
  while (i < s.length) {
    if (s[i] === GS) {
      i++;
      continue;
    }
    const ai = matchAi(s, i);
    if (!ai) return count > 0 ? out : null;
    i += ai.length;
    if (ai in FIXED) {
      const value = s.slice(i, i + FIXED[ai]);
      if (value.length !== FIXED[ai] || !/^\d+$/.test(value)) return null;
      assign(out, ai, value);
      i += FIXED[ai];
    } else {
      const end = s.indexOf(GS, i);
      const stop = end === -1 ? Math.min(s.length, i + VARIABLE_MAX[ai]) : Math.min(end, i + VARIABLE_MAX[ai]);
      assign(out, ai, s.slice(i, stop));
      i = stop;
    }
    count++;
  }
  return count > 0 ? out : null;
}

/**
 * Parses one scan. Returns structured GS1 data when the input carries Application Identifiers,
 * otherwise the cleaned plain code for a direct barcode lookup.
 */
export function parseScan(input: string): ScanResult {
  const s = stripSymbologyId(input.trim());
  if (s.startsWith("(")) {
    const p = parseParenthesised(s);
    if (p && p.gtin) return { kind: "gs1", data: p };
  }
  // A GS1 element string for a medicine pack starts with AI 01 followed by 14 digits.
  if (/^01\d{14}/.test(s) && s.length > 16) {
    const p = parseElementString(s);
    if (p && p.gtin) return { kind: "gs1", data: p };
  }
  return { kind: "plain", code: s.replace(/\s+/g, "") };
}

/** Lookup keys to try for a GTIN-14: itself and the GTIN-13 / EAN-13 form without the leading zero. */
export function gtinLookupKeys(code: string): string[] {
  const keys = [code];
  if (code.length === 14 && code.startsWith("0")) keys.push(code.slice(1));
  if (code.length === 13) keys.push("0" + code);
  return keys;
}

/** True when the text looks like something a scanner produced rather than a typed search. */
export function looksLikeScan(input: string): boolean {
  const s = stripSymbologyId(input.trim());
  return /^\d{8,14}$/.test(s) || /^01\d{14}/.test(s) || /^\(01\)\d{14}/.test(s) || s.includes(GS);
}
