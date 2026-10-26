// Finding account names in free text, the same way for the generator checker and
// the judge. Text is normalised first (NFKC, lowercase, invisible format characters
// removed), then every dotted name (last part has a letter, so "2.5" is not one)
// and every 64-hex implicit account counts as an account token.

const TOKEN = /(?<![a-z0-9_.-])(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)+|[0-9a-f]{64})(?![a-z0-9_-])/g;

export function normalize(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\p{Cf}/gu, "");
}

export function accountTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of normalize(text).matchAll(TOKEN)) {
    const t = m[0];
    const last = t.split(".").at(-1)!;
    if (t.length === 64 && /^[0-9a-f]+$/.test(t)) out.push(t);
    else if (/[a-z]/.test(last)) out.push(t);
  }
  return out;
}

/** Generator text may only use printable ASCII: no homoglyphs, no invisible characters. */
export const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;
