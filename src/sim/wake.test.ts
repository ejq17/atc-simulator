/** Wake turbulence minima, JO 7110.65 5-5-4 TBL 5-5-3 (directly behind) / TBL 5-5-4 (on approach), JO 7110.126A categories. */
import { describe, expect, it } from 'vitest';
import { wakeMinimumNm } from './wake';
import { wakeRecatCategory } from './performance';

describe('wake categories (JO 7110.126A Appendix A)', () => {
  it('A320 = F, C172 = I', () => {
    expect(wakeRecatCategory('A320')).toBe('F');
    expect(wakeRecatCategory('C172')).toBe('I');
  });
});

describe('7110.65 5-5-4 tables as read from faa.gov', () => {
  it('F leader: I follower 4 NM on approach, nothing directly behind', () => {
    expect(wakeMinimumNm('F', 'I', 'on_approach')).toBe(4);
    expect(wakeMinimumNm('F', 'I', 'directly_behind')).toBe(0);
  });
  it('F->F, I->F and I->I have no wake minimum (the 3 NM radar minimum applies)', () => {
    for (const g of ['on_approach', 'directly_behind'] as const) {
      expect(wakeMinimumNm('F', 'F', g)).toBe(0);
      expect(wakeMinimumNm('I', 'F', g)).toBe(0);
      expect(wakeMinimumNm('I', 'I', g)).toBe(0);
    }
  });
  it('spot checks: B757 (E) behind-I 4 NM; heavy B->I 5 directly behind / 6 on approach; A->I 8', () => {
    expect(wakeMinimumNm('E', 'I', 'directly_behind')).toBe(4);
    expect(wakeMinimumNm('B', 'I', 'directly_behind')).toBe(5);
    expect(wakeMinimumNm('B', 'I', 'on_approach')).toBe(6);
    expect(wakeMinimumNm('A', 'I', 'on_approach')).toBe(8);
    expect(wakeMinimumNm('C', 'E', 'on_approach')).toBe(3.5);
  });
});
