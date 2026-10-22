/**
 * Release 1.3 — OWNED BY P4 pdf-everywhere. Spelling any text with fewer characters: the folds behind the PDF text
 * (exportFormat.ts toPdfText: WinAnsi, what the standard PDF fonts can draw) and behind file names (asciiFold, used by
 * client/src/lib/csv.ts for every export's file name). A module of its own so the app's main chunk, which names every
 * CSV file, carries these tables without the rest of the PDF helpers (they stay in the export chunks). Re-exported by
 * exportFormat.ts; unit-tested in exportFormat.test.ts.
 */

/** Characters with no WinAnsi glyph and no accent to strip: the nearest plain spelling. */
export const PDF_FOLDS: Readonly<Record<string, string>> = {
  '−': '-', // minus sign
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '―': '—',
  '→': '->',
  '←': '<-',
  '↑': '^',
  '↓': 'v',
  '⇒': '=>',
  '≥': '>=',
  '≤': '<=',
  '≠': '!=',
  '≈': '~',
  '✓': 'Yes',
  '✔': 'Yes',
  '✗': 'No',
  '✕': 'x',
  '′': "'",
  '″': '"',
  'Ł': 'L',
  'ł': 'l',
  'Đ': 'D',
  'đ': 'd',
  'Ħ': 'H',
  'ħ': 'h',
  'ı': 'i',
  'Ŀ': 'L',
  'ŀ': 'l',
  'ſ': 's',
};

/** Unusual spaces (en, em, thin, narrow no-break, ideographic…): printed as a plain space. */
export const SPACE_LIKE = /[\u2000-\u200a\u202f\u205f\u3000]/g;
/** Zero-width characters, the word joiner, the byte-order mark and the soft hyphen: dropped. */
export const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;
/** Combining accents (what NFKD splits off a letter). */
export const COMBINING = /[\u0300-\u036f]/g;

/**
 * Other alphabets in Latin letters (a plain, deterministic spelling close to BGN/PCGN), so a name such as "Иван
 * Петров" or "Γιώργος" prints as "Ivan Petrov" / "Giorgos" on a PDF and in a file name instead of "?????".
 * Cyrillic covers Russian, Ukrainian, Belarusian, Bulgarian, Serbian and Macedonian letters; Greek the modern
 * alphabet (accents are stripped first, "ου" reads "ou").
 */
export const TRANSLIT: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  const add = (letters: string, latin: string) => {
    const spellings = latin.split(' ');
    [...letters].forEach((ch, i) => {
      const l = spellings[i] === '-' ? '' : spellings[i] ?? '';
      map[ch] = l;
      const upper = ch.toUpperCase();
      if (upper !== ch && !(upper in map)) map[upper] = l.charAt(0).toUpperCase() + l.slice(1);
    });
  };
  add('абвгдеёжзийклмнопрстуфхцчшщъыьэюяєіїґўђјљњћџѓќѕ', 'a b v g d e yo zh z i y k l m n o p r s t u f kh ts ch sh shch - y - e yu ya ye i yi g u dj j lj nj c dz gj kj dz');
  add('αβγδεζηθικλμνξοπρστυφχψως', 'a v g d e z i th i k l m n x o p r s t y f ch ps o s');
  return map;
})();
/** Greek "ου" (with or without an accent) is the sound "ou". */
const GREEK_OU = /([οΟ])([υύΥΎ])/g;
export const greekOu = (text: string) => text.replace(GREEK_OU, (_m, o: string, u: string) => (o === 'Ο' ? 'O' : 'o') + (u === 'Υ' || u === 'Ύ' ? 'U' : 'u'));

/** The letter without its accents when every part of it passes `ok`; null otherwise. */
export function bareLetter(ch: string, ok: (code: number) => boolean): string | null {
  const bare = ch.normalize('NFKD').replace(COMBINING, '');
  return bare && bare !== ch && [...bare].every((c) => ok(c.codePointAt(0) ?? 0)) ? bare : null;
}

/** Letters and marks with no plain-ASCII spelling of their own (file names). */
const ASCII_FOLDS: Readonly<Record<string, string>> = {
  ß: 'ss', Æ: 'AE', æ: 'ae', Ø: 'O', ø: 'o', Œ: 'OE', œ: 'oe', Þ: 'Th', þ: 'th', Ð: 'D', ð: 'd',
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '–': '-', '—': '-', '―': '-', '…': '...',
};

function asciiChar(ch: string): string {
  const code = ch.codePointAt(0)!;
  if (code === 0x0a || (code >= 0x20 && code < 0x7f)) return ch;
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return '';
  const fold = ASCII_FOLDS[ch] ?? PDF_FOLDS[ch] ?? TRANSLIT[ch];
  if (fold !== undefined) return [...fold].map(asciiChar).join('');
  const bare = bareLetter(ch, (c) => c < 0x80);
  if (bare) return bare;
  const translit = TRANSLIT[ch.normalize('NFKD').replace(COMBINING, '')];
  return translit !== undefined ? translit : '?';
}

/**
 * Plain ASCII spelling of a text, for file names (lib/csv.ts slugify): accents stripped, "Ł" → "L", "ß" → "ss",
 * curly quotes and dashes as ' " -, Cyrillic and Greek in Latin letters, anything else "?".
 */
export function asciiFold(text: string): string {
  const flat = greekOu(String(text ?? '').normalize('NFC')).replace(/\t/g, ' ').replace(SPACE_LIKE, ' ').replace(ZERO_WIDTH, '').replace(/\u00a0/g, ' ');
  let out = '';
  for (const ch of flat) out += asciiChar(ch);
  return out;
}
