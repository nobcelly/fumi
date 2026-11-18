// Japanese era dates (和暦) in official letters, converted deterministically so
// the app never has to trust a model with arithmetic.
const ERAS: { name: string; start: number }[] = [
  { name: '令和', start: 2019 },
  { name: '平成', start: 1989 },
  { name: '昭和', start: 1926 },
];

const toHalfWidth = (s: string): string =>
  s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

const pad = (n: number) => String(n).padStart(2, '0');

export type FoundDate = { iso: string; source: string };

// Every date written in the text, in the order it appears: 令和8年11月30日,
// R8.11.30, 2026年11月30日, 2026/11/30. "元年" counts as year 1.
export const findDates = (raw: string): FoundDate[] => {
  const text = toHalfWidth(raw);
  const out: FoundDate[] = [];
  const push = (y: number, m: number, d: number, source: string, at: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    out.push({ iso: `${y}-${pad(m)}-${pad(d)}`, source, at } as FoundDate & { at: number });
  };
  const era = /(令和|平成|昭和)\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  for (const m of text.matchAll(era)) {
    const base = ERAS.find((e) => e.name === m[1])!.start;
    const y = m[2] === '元' ? 1 : Number(m[2]);
    push(base + y - 1, Number(m[3]), Number(m[4]), m[0], m.index ?? 0);
  }
  const short = /\bR\s*(\d{1,2})[./](\d{1,2})[./](\d{1,2})\b/g;
  for (const m of text.matchAll(short)) push(2018 + Number(m[1]), Number(m[2]), Number(m[3]), m[0], m.index ?? 0);
  const western = /(\d{4})\s*(?:年|[./-])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*日?/g;
  for (const m of text.matchAll(western)) push(Number(m[1]), Number(m[2]), Number(m[3]), m[0], m.index ?? 0);
  return (out as (FoundDate & { at: number })[]).sort((a, b) => a.at - b.at).map(({ iso, source }) => ({ iso, source }));
};

export const daysUntil = (iso: string, now = new Date()): number => {
  const [y, m, d] = iso.split('-').map(Number);
  const target = Date.UTC(y!, m! - 1, d!);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
};

// Adds the Western date after each Japanese era date, so that no model has to
// convert eras itself: 令和9年1月5日 → 令和9年1月5日（2027-01-05）.
export const withDates = (text: string): string =>
  text.replace(/(令和|平成|昭和)\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?![（(]\d{4})/g, (m) => {
    const d = findDates(m)[0];
    return d ? `${m}（${d.iso}）` : m;
  });
