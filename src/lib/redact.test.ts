import { describe, expect, it } from 'vitest';
import { looksClean, redact, restore, restoreParts } from './redact';

const LETTER = `令和8年度 市民税・県民税 納税通知書
〒000-0012
東京都架空市桜町1丁目2番3号 さくら荘201
見本 花子 様
個人番号 1234 5678 9012
通知書番号 08-334512
納期限 令和8年12月28日
納付額 18,600円
架空市役所 市民税課 電話 0120-000-111`;

const PERSONAL = [
  { label: 'NAME', text: '見本 花子' },
  { label: 'ADDRESS', text: '東京都架空市桜町1丁目2番3号 さくら荘201' },
];

describe('redact', () => {
  it('swaps personal items and number patterns for numbered labels', () => {
    const { text, removed } = redact(LETTER, PERSONAL);
    expect(text).toContain('[NAME 1] 様');
    expect(text).toContain('[ADDRESS 1]');
    expect(text).toContain('[MY NUMBER 1]');
    expect(text).toContain('[POSTAL CODE 1]');
    expect(text).toContain('[ACCOUNT NO. 1]');
    expect(text).toContain('電話 [PHONE 1]');
    expect(text).not.toMatch(/見本 花子|1234 5678 9012|0120-000-111|08-334512/);
    // facts the explanation needs stay readable
    expect(text).toContain('令和8年12月28日');
    expect(text).toContain('18,600円');
    expect(removed.map((r) => r.tag)).toEqual(expect.arrayContaining(['[NAME 1]', '[PHONE 1]']));
    expect(looksClean(text)).toBe(true);
  });

  it('tolerates spaces the model added or dropped', () => {
    const { text } = redact('見本　花子 様', [{ label: 'name', text: '見本花子' }]);
    expect(text).toBe('[NAME 1] 様');
  });

  it('gives the same value the same label, and different values new numbers', () => {
    const { text } = redact('電話 03-1234-5678 / 03-1234-5678 / 090-1111-2222', []);
    expect(text).toBe('電話 [PHONE 1] / [PHONE 1] / [PHONE 2]');
  });

  it('keeps labels from the letter for follow-up questions', () => {
    const letter = redact(LETTER, PERSONAL);
    const q = redact('Can I call 0120-000-111 or 080-2222-3333?', [], letter.removed);
    expect(q.text).toBe('Can I call [PHONE 1] or [PHONE 2]?');
  });

  it('does not hide dates because of a very short number-only item', () => {
    const { text } = redact('令和8年12月28日 さくら荘12', [{ label: 'ADDRESS', text: '12' }]);
    expect(text).toContain('令和8年12月28日');
  });

  it('cleans labels that come from the model', () => {
    const { text } = redact('山田 太郎', [{ label: 'Full name!', text: '山田 太郎' }]);
    expect(text).toBe('[FULL NAME 1]');
  });

  it('converts full-width digits before matching', () => {
    const { text } = redact('個人番号 １２３４ ５６７８ ９０１２', []);
    expect(text).toBe('個人番号 [MY NUMBER 1]');
  });
});

describe('restore', () => {
  const { removed } = redact(LETTER, PERSONAL);

  it('fills real values back in for the screen', () => {
    expect(restore('Call [PHONE 1] (weekdays).', removed)).toBe('Call 0120-000-111 (weekdays).');
    expect(restore('Dear [NAME1]', removed)).toBe('Dear 見本 花子');
    expect(restore('Unknown [PHONE 9] stays', removed)).toBe('Unknown [PHONE 9] stays');
  });

  it('marks which parts were filled in', () => {
    const parts = restoreParts('Call [PHONE 1] now', removed);
    expect(parts.map((p) => p.text)).toEqual(['Call ', '0120-000-111', ' now']);
    expect(parts[1]?.hidden?.label).toBe('PHONE');
  });
});

describe('looksClean', () => {
  it('blocks text that still has identifying numbers', () => {
    expect(looksClean('個人番号 1234 5678 9012')).toBe(false);
    expect(looksClean('電話 0120-000-111')).toBe(false);
    expect(looksClean('mail me at a@b.jp')).toBe(false);
    expect(looksClean('〒123-4567')).toBe(false);
  });
  it('lets labels and ordinary numbers through', () => {
    expect(looksClean('[MY NUMBER 1] 納付額 18,600円 令和8年12月28日 [PHONE 2]')).toBe(true);
  });
});

describe('phone shapes', () => {
  it('covers common Japanese phone formats whole', () => {
    expect(redact('TEL 03(1234)5678', []).text).toBe('TEL [PHONE 1]');
    expect(redact('携帯 09012345678', []).text).toBe('携帯 [PHONE 1]');
    expect(redact('〒100-0001 東京都', []).text).toBe('[POSTAL CODE 1] 東京都');
  });
});

describe('covered parts', () => {
  it('ignores ■■■ that a model lists as personal data', () => {
    const { text } = redact('個人番号 ■■■\n期別 第3期', [{ label: 'MY NUMBER', text: '■■■' }]);
    expect(text).toBe('個人番号 ■■■\n期別 第3期');
  });
});

describe('numbers the model missed', () => {
  it('covers values after any 番号 label and other long numbers, but not dates or amounts', () => {
    const { text } = redact('通知番号\n08-334512\n被保険者番号 ABC1234\n整理 1234567\n2026-12-28 納付額 18,600円 8:30', []);
    expect(text).toBe('通知番号\n[ACCOUNT NO. 1]\n被保険者番号 [ACCOUNT NO. 2]\n整理 [ID NO. 1]\n2026-12-28 納付額 18,600円 8:30');
    expect(looksClean(text)).toBe(true);
    expect(looksClean('通知番号 08-334512')).toBe(false);
    expect(looksClean('2026-12-28 18,600円')).toBe(true);
  });
});

describe('names and addresses the model missed', () => {
  it('covers the name before 様 and addresses, but not 皆様 or the office', () => {
    const t = '〒000-0012\n東京都架空市桜町1丁目2番3号 さくら荘201\n見本 花子 様\n皆様、ご協力ください。\n架空市役所 市民税課\n架空市桜町2-5 市民センター\n氏名：山田 太郎';
    const { text } = redact(t, []);
    expect(text).toBe(
      '[POSTAL CODE 1]\n[ADDRESS 1]\n[NAME 1] 様\n皆様、ご協力ください。\n架空市役所 市民税課\n[ADDRESS 2]\n氏名：[NAME 2]'
    );
  });
  it('leaves ordinary sentences alone', () => {
    const t = '納期限を過ぎると延滞金がかかることがあります。\n様式第3号\n各種様々な手続き';
    expect(redact(t, []).text).toBe(t);
  });
});

describe('partial names from the model', () => {
  it('covers the whole name even if the model listed only the given name', () => {
    const { text } = redact('見本 花子 様\n通知', [{ label: 'NAME', text: '花子 様' }]);
    expect(text).toBe('[NAME 1] 様\n通知');
  });
});

describe('plausible', () => {
  const letter = '基礎年金番号 1234-567890\n未納の月 令和8年7月分～令和8年9月分\n督促金額 52,530円\n生年月日 平成5年4月1日\n架空年金事務所';
  it('drops amounts, months and the sending office that a model called personal', async () => {
    const { plausible } = await import('./redact');
    expect(plausible({ label: 'ACCOUNT NO.', text: '52,530円' }, letter)).toBe(false);
    expect(plausible({ label: 'BIRTH DATE', text: '令和8年7月分～令和8年9月分' }, letter)).toBe(false);
    expect(plausible({ label: 'NAME', text: '架空年金事務所' }, letter)).toBe(false);
    expect(plausible({ label: 'BIRTH DATE', text: '平成5年4月1日' }, letter)).toBe(true);
    expect(plausible({ label: 'NAME', text: '見本 太郎' }, letter)).toBe(true);
  });
  it('covers a birth date after its label by pattern', () => {
    expect(redact('生年月日 平成5年4月1日', []).text).toBe('生年月日 [BIRTH DATE 1]');
  });
});
