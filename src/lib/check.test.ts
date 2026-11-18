import { describe, expect, it, vi } from 'vitest';

// check() lives with the model code; the Firebase parts are not needed here.
vi.mock('./firebase', () => ({ ai: () => ({}), settings: () => ({ cloudModel: 'x', fallbackModel: 'y', glossary: [] }) }));

const { check } = await import('./ai');
const { findDates, daysUntil } = await import('./wareki');
const { icsFor } = await import('./ics');

const REDACTED = `令和8年度 市民税・県民税 納税通知書
納期限
令和8年12月28日
納付額 18,600円
架空市役所 市民税課 電話 [PHONE 1]`;

const base = {
  kind: 'Resident tax bill',
  issuerJa: '架空市役所 市民税課',
  issuer: 'City Hall',
  summary: 's',
  actions: ['a'],
  deadlineJa: '令和8年12月28日',
  amountJa: '18,600円',
  payment: '',
  contact: '',
  terms: [],
};

describe('findDates', () => {
  it('reads Japanese era dates, short forms and western dates', () => {
    expect(findDates('納期限 令和8年12月28日')[0]?.iso).toBe('2026-12-28');
    expect(findDates('令和元年5月1日')[0]?.iso).toBe('2019-05-01');
    expect(findDates('平成31年4月30日')[0]?.iso).toBe('2019-04-30');
    expect(findDates('期限 R8.11.30')[0]?.iso).toBe('2026-11-30');
    expect(findDates('２０２６年１２月１日')[0]?.iso).toBe('2026-12-01');
    expect(findDates('電話 0120-000-111')).toEqual([]);
  });
  it('counts days to a deadline', () => {
    expect(daysUntil('2026-12-28', new Date(2026, 10, 18))).toBe(40);
  });
});

describe('check', () => {
  it('accepts facts that are printed in the letter', () => {
    const c = check(base, REDACTED);
    expect(c.deadlineIso).toBe('2026-12-28');
    expect(c.amountYen).toBe(18600);
    expect(c.issuerVerified).toBe(true);
    expect(c.warnings).toEqual([]);
  });

  it('prefers facts printed next to their labels over the model', () => {
    const c = check({ ...base, issuerJa: '空欄', amountJa: '20,000円', deadlineJa: '令和8年12月30日' }, REDACTED);
    expect(c.issuerJa).toBe('架空市役所 市民税課');
    expect(c.issuerVerified).toBe(true);
    expect(c.amountYen).toBe(18600);
    expect(c.deadlineIso).toBe('2026-12-28');
    expect(c.warnings).toEqual([]);
  });

  it('flags facts it cannot find in the letter', () => {
    const letter = 'お知らせ\n令和8年12月1日に説明会があります。\n費用は500円です。';
    const c = check({ ...base, issuerJa: '東京都庁', amountJa: '20,000円', deadlineJa: '令和8年12月30日' }, letter);
    expect(c.issuerVerified).toBe(false);
    expect(c.amountYen).toBeNull();
    expect(c.deadlineIso).toBeNull();
    expect(c.warnings).toEqual(['sender', 'deadline', 'amount']);
  });

  it('accepts an unlabelled amount only as a whole number in the letter', () => {
    const letter = '会費 3,000円をお持ちください。';
    expect(check({ ...base, issuerJa: '', deadlineJa: '', amountJa: '3,000円' }, letter).amountYen).toBe(3000);
    expect(check({ ...base, issuerJa: '', deadlineJa: '', amountJa: '300円' }, letter).warnings).toEqual(['amount']);
  });
});

describe('icsFor', () => {
  it('escapes text and folds long lines', () => {
    const ics = icsFor('Tax; bill, due', '2026-12-28', `Pay at a bank\\n${'納付'.repeat(40)}`);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261228');
    expect(ics).toContain('SUMMARY:Tax\\; bill\\, due');
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
});

describe('plain', () => {
  it('drops Markdown from chat answers', async () => {
    const { plain } = await import('./ai');
    expect(plain('Call **0120-000-111**.\n* Weekdays\n- 8:30–17:15\n## Note')).toBe('Call 0120-000-111.\n• Weekdays\n• 8:30–17:15\nNote');
  });
});

describe('writtenIn', () => {
  it('notices an explanation in the wrong language', async () => {
    const { writtenIn } = await import('./ai');
    expect(writtenIn('This is your resident tax bill (納税通知書).', 'ne')).toBe(false);
    expect(writtenIn('यो तपाईंको आवासीय कर बिल हो (納税通知書)।', 'ne')).toBe(true);
    expect(writtenIn('Đây là thông báo nộp thuế cư trú.', 'vi')).toBe(true);
    expect(writtenIn('This is a tax bill.', 'vi')).toBe(false);
    expect(writtenIn('这是您的居民税缴费通知。', 'zh')).toBe(true);
    expect(writtenIn('これは住民税の納税通知書です。', 'zh')).toBe(false);
    expect(writtenIn('이것은 주민세 납부 통지서입니다.', 'ko')).toBe(true);
    expect(writtenIn('Anything goes for Latin-script languages.', 'es')).toBe(true);
  });
});

describe('withDates', () => {
  it('writes the Western date next to era dates, once', async () => {
    const { withDates } = await import('./wareki');
    const once = withDates('納期限 令和9年1月5日\n発行 令和元年5月1日');
    expect(once).toBe('納期限 令和9年1月5日（2027-01-05）\n発行 令和元年5月1日（2019-05-01）');
    expect(withDates(once)).toBe(once);
  });
  it('keeps the checks working on annotated text', () => {
    const c = check(base, '納期限 令和8年12月28日（2026-12-28）\n納付額 18,600円\n架空市役所 市民税課');
    expect(c.deadlineIso).toBe('2026-12-28');
    expect(c.amountYen).toBe(18600);
  });
});
