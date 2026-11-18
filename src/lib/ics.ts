// A calendar file for the deadline, built locally (RFC 5545).
const esc = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/[;,]/g, (c) => `\\${c}`)
    .replace(/\r?\n/g, '\\n');

// Lines longer than 75 bytes are folded; never split inside a character.
const fold = (line: string): string => {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + n > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
};

export const icsFor = (title: string, isoDate: string, note: string): string => {
  const d = isoDate.replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fumi//Letters//EN',
    'BEGIN:VEVENT',
    `UID:${d}-${Math.random().toString(36).slice(2)}@fumi`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${d}`,
    `SUMMARY:${esc(title)}`,
    `DESCRIPTION:${esc(note)}`,
    'BEGIN:VALARM',
    'TRIGGER:-P3D',
    'ACTION:DISPLAY',
    `DESCRIPTION:${esc(title)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .map(fold)
    .join('\r\n');
};
