// Code 128 (set B) barcode for invoice numbers on receipts, e.g. "MB-2026-000001".
// Returns bar/space widths in modules, starting with a bar; the caller draws them.

// Patterns 0–105 are six widths (bar, space, …) adding up to 11 modules; 106 is the stop pattern (13 modules).
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

export const CODE128_PATTERNS = PATTERNS;
const START_B = 104;
const STOP = 106;

/** Symbol values for `text`: start B, data, checksum, stop. Throws on characters set B cannot carry. */
export function code128Values(text: string): number[] {
  const data = [...text].map((ch) => {
    const v = ch.charCodeAt(0) - 32;
    if (v < 0 || v > 95) throw new RangeError(`Code 128B cannot encode ${JSON.stringify(ch)}`);
    return v;
  });
  const checksum = data.reduce((sum, v, i) => sum + v * (i + 1), START_B) % 103;
  return [START_B, ...data, checksum, STOP];
}

/** Alternating bar/space widths (in modules) for `text`, bar first, without quiet zones. */
export function code128Widths(text: string): number[] {
  return code128Values(text).flatMap((v) => [...PATTERNS[v]].map(Number));
}
