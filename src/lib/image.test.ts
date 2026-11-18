import { describe, expect, it } from 'vitest';
import { appendNew, findCut, joinPieces } from './image';

describe('joining pieces', () => {
  it('drops the lines both halves read', () => {
    expect(joinPieces('a 1\n納期限\n令和9年1月5日', '納期限\n令和9年1月5日\n納付額 9,870円')).toBe('a 1\n納期限\n令和9年1月5日\n納付額 9,870円');
  });
  it('keeps everything when the halves do not overlap', () => {
    expect(joinPieces('上の行', '下の行')).toBe('上の行\n下の行');
  });
  it('adds only new lines from a second look at the bottom', () => {
    const first = '・届出が必要です。\n架空区長印';
    const second = '・届出が必要です。\n架空区 長印\n架空区役所 保険年金課 国保係\n電話 0120-000-222';
    expect(appendNew(first, second)).toBe('・届出が必要です。\n架空区長印\n架空区役所 保険年金課 国保係\n電話 0120-000-222');
  });
});

describe('findCut', () => {
  it('cuts through the emptiest band in the middle of the page', () => {
    const rows = Array.from({ length: 100 }, (_, y) => (y >= 55 && y <= 58 ? 0 : 100));
    expect(findCut(rows)).toBeCloseTo(0.56, 1);
  });
});
