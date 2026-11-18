// Personal data is covered on the device before anything can leave it. The
// on-device model points out what is personal; these patterns are a safety
// net that does not depend on the model at all.
//
// Each item is swapped for a numbered label such as [PHONE 1]. The labels and
// the real values stay on this device, so the explanation can show the real
// values again on screen (restore) without them ever being sent.
export type Redaction = { label: string; text: string };
export type Hidden = Redaction & { tag: string };

// Order matters: phone numbers first, so a postal-code shape inside
// 03-1234-5678 is never taken on its own. `keep` lets a match through.
const RULES: { label: string; re: RegExp; keep?: (m: string) => boolean }[] = [
  // phone numbers: 03-1234-5678, 0120-000-111, 03(1234)5678, 09012345678
  { label: 'PHONE', re: /(?<![\d-])0\d{1,4}[-(（]\d{1,4}[-)）]\d{3,4}(?![\d-])|(?<!\d)0[789]0\d{8}(?!\d)/g },
  // マイナンバー (12 digits, often in groups of 4)
  { label: 'MY NUMBER', re: /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g },
  // postal code 〒123-4567
  { label: 'POSTAL CODE', re: /(?<![\d-])〒?\s?\d{3}-\d{4}(?![\d-])/g },
  // e-mail
  { label: 'EMAIL', re: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  // the value after any ...番号 / 記号 / No. label (口座番号, 通知書番号,
  // 被保険者番号, 基礎年金番号 ...); the label itself stays readable
  { label: 'ACCOUNT NO.', re: /(?<=(?:番号|記号|No\.?|NO\.?|№)\s*[:：]?\s*)(?=[\w-]*\d)[\w-]{4,}/g },
  // any other long number: 08-334512, 1234567 (but not dates or amounts)
  {
    label: 'ID NO.',
    re: /(?<![\d,.:/-])\d{2,}(?:-\d{2,}){1,3}(?![\d,.:/-])|(?<![\d,.:/-])\d{7,}(?![\d,.:/-])/g,
    keep: (m) => /^\d{4}-\d{1,2}-\d{1,2}$/.test(m) || m.replace(/\D/g, '').length < 6,
  },
  // a birth date after its label
  {
    label: 'BIRTH DATE',
    re: /(?<=(?:生年月日|誕生日)[ \u3000]*[:：]?[ \u3000]*)(?:(?:令和|平成|昭和|大正)[ \u3000]*(?:元|\d{1,2})[ \u3000]*年[ \u3000]*\d{1,2}[ \u3000]*月[ \u3000]*\d{1,2}[ \u3000]*日|\d{4}[年/.-]\d{1,2}[月/.-]\d{1,2}日?)/g,
  },
  // the addressee: a name before 様 / 殿, or after a name label
  {
    label: 'NAME',
    re: /(?<=^|[\s\u3000])[一-龯々ぁ-んァ-ヶーA-Za-z][一-龯々ぁ-んァ-ヶーA-Za-z・ \u3000]{0,20}?(?=[ \u3000]*(?:様|殿)(?![一-龯々ぁ-ん]))|(?<=(?:氏名|お名前|名前|受給者名|被保険者名|納税者名|世帯主名)[ \u3000]*[:：]?[ \u3000]*)[^\s\d[:：][^\n]{0,20}/gm,
    keep: (m) => /^(皆|お客|各位|みな|利用者|ご利用者|保護者|関係者|納税者|世帯主|被保険者|ご家族の皆)$/.test(m.trim()),
  },
  // addresses: after 住所, from a prefecture, or a town with block numbers
  {
    label: 'ADDRESS',
    re: /(?<=(?:住所|ご住所|現住所)[ \u3000]*[:：]?[ \u3000]*)[^\s[:：][^\n]{3,60}|(?:北海道|東京都|京都府|大阪府|[一-龯]{2,3}県)[一-龯ぁ-んァ-ヶー]{1,10}[市区町村郡][^\n]{0,40}|[一-龯ぁ-んァ-ヶー]{1,8}[市区町村][一-龯ぁ-んァ-ヶー]{1,10}\d+(?:丁目|番地?|号|[-‐－]\d+)[^\n]{0,30}/g,
  },
];

// A numbered label, e.g. [NAME 1] or [ACCOUNT NO. 2].
export const TAG = /\[[A-Z][A-Z .]*? \d+\]/g;
const isTag = (s: string) => new RegExp(`^${TAG.source}$`).test(s);

const toHalfWidth = (s: string): string =>
  s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/－/g, '-');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const squash = (s: string) => s.replace(/\s+/g, '');

// Labels come from a model, so keep them to a small, safe alphabet.
const cleanLabel = (label: string) =>
  label
    .toUpperCase()
    .replace(/[^A-Z .]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'PERSONAL';

// Replace each personal item with a numbered label, e.g. [NAME 1]. Items
// already hidden earlier (`known`) keep their labels, so a follow-up question
// that repeats a phone number gets the same [PHONE 1].
export const redact = (
  transcript: string,
  personal: Redaction[],
  known: Hidden[] = []
): { text: string; removed: Hidden[] } => {
  let text = toHalfWidth(transcript);
  const removed: Hidden[] = [...known];
  const counts = new Map<string, number>();
  for (const k of known) counts.set(k.label, Math.max(counts.get(k.label) ?? 0, Number(/(\d+)\]$/.exec(k.tag)?.[1] ?? 0)));
  const tagFor = (label: string, original: string) => {
    const same = removed.find((r) => r.label === label && squash(r.text) === squash(original));
    if (same) return same.tag;
    const n = (counts.get(label) ?? 0) + 1;
    counts.set(label, n);
    const tag = `[${label} ${n}]`;
    removed.push({ label, text: original, tag });
    return tag;
  };
  // Names before 様 and addresses are also found by pattern on the original
  // text, so a model that lists only "花子" cannot leave the family name behind.
  const spans = RULES.filter((r) => r.label === 'NAME' || r.label === 'ADDRESS').flatMap((r) =>
    [...text.matchAll(new RegExp(r.re.source, r.re.flags))]
      .map((m) => m[0])
      .filter((m) => !r.keep?.(m))
      .map((m) => ({ label: r.label, text: m }))
  );
  // Longest first, so "東京都架空市中央1-2-3" is covered before "東京都".
  // Very short number-only items (a room number "12") would also hide dates,
  // so they need at least four characters; the patterns below still apply.
  const items = [...known, ...personal, ...spans]
    .map((p) => ({ label: cleanLabel(p.label), text: toHalfWidth(String(p.text ?? '').trim()) }))
    .filter((p) => squash(p.text).length >= (/^[\d\s\-.()/]+$/.test(p.text) ? 4 : 2))
    // "■■■" marks a part the reader already blacked out
    .filter((p) => !/^[■□▪▮█*＊xX\s]+$/.test(p.text))
    .sort((a, b) => b.text.length - a.text.length);
  for (const p of items) {
    // tolerate spaces the model dropped or added
    const loose = new RegExp(squash(p.text).split('').map(escapeRe).join('\\s*'), 'g');
    text = text.replace(loose, (m) => (isTag(m) ? m : tagFor(p.label, m)));
  }
  for (const rule of RULES) {
    text = text.replace(rule.re, (m) => (rule.keep?.(m) ? m : tagFor(rule.label, m)));
  }
  return { text, removed };
};

// Put the real values back, for display on this device only.
export const restore = (text: string, removed: Hidden[]): string =>
  text.replace(/\[([A-Z][A-Z .]*?)\s?(\d+)\]/g, (t, label: string, n: string) => {
    const hit = removed.find((r) => r.tag === `[${label.trim()} ${n}]`);
    return hit ? hit.text : t;
  });

// Splits text into plain parts and restored values, so the screen can mark
// which words were hidden from the AI and filled in on this device.
export const restoreParts = (text: string, removed: Hidden[]): { text: string; hidden?: Hidden }[] => {
  const out: { text: string; hidden?: Hidden }[] = [];
  let last = 0;
  for (const m of text.matchAll(/\[([A-Z][A-Z .]*?)\s?(\d+)\]/g)) {
    const hit = removed.find((r) => r.tag === `[${m[1].trim()} ${m[2]}]`);
    if (!hit) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: hit.text, hidden: hit });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
};

// Last check before text goes to the cloud: nothing that looks like a number
// sequence a person could be identified by.
export const looksClean = (text: string): boolean => {
  const bare = toHalfWidth(text).replace(TAG, ' ');
  return !RULES.some((r) => [...bare.matchAll(new RegExp(r.re.source, r.re.flags))].some((m) => !r.keep?.(m[0])));
};

const LABEL_NAMES: Record<string, string> = {
  NAME: 'name',
  ADDRESS: 'address',
  'POSTAL CODE': 'postal code',
  'MY NUMBER': 'My Number',
  'BIRTH DATE': 'birth date',
  PHONE: 'phone number',
  'ACCOUNT NO.': 'account number',
  'ID NO.': 'ID number',
  EMAIL: 'email',
};

export const labelName = (label: string) => LABEL_NAMES[label] ?? label.toLowerCase().replace(/\.$/, '');

// "name, address and My Number"
export const describeHidden = (hidden: Hidden[]): string => {
  const names = [...new Set(hidden.map((h) => labelName(h.label)))];
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
};

// Small models sometimes call an amount, a month or the sending office
// "personal". Covering those would hide what the reader needs, so such items
// are dropped (the patterns above still cover real numbers).
export const plausible = (p: Redaction, transcript: string): boolean => {
  const t = toHalfWidth(String(p.text ?? '')).trim();
  if (!t) return false;
  if (/^[\d,，.\s]+円$/.test(t) || (/\d/.test(t) && /円/.test(t))) return false;
  if (/(役所|役場|機構|事務所|センター|税務署|保健所|課|係)$/.test(t)) return false;
  const looksLikeDate = /(令和|平成|昭和)\s*(元|\d{1,2})\s*年|\d{4}\s*[年/.-]\s*\d{1,2}|\d{1,2}\s*月分/.test(t);
  if (looksLikeDate) {
    const at = toHalfWidth(transcript).indexOf(t);
    const before = at >= 0 ? toHalfWidth(transcript).slice(Math.max(0, at - 24), at) : '';
    if (!/(生年月日|誕生日|生まれ)/.test(before)) return false;
  }
  return true;
};
