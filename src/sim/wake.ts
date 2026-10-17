/**
 * Wake turbulence separation minima, FAA JO 7110.65 5-5-4 (text and tables fetched 2026-10-17 from
 * https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap5_section_5.html, cells read from the HTML tables).
 * Categories A-I are the RECAT categories of JO 7110.126A Appendix A (see `wakeRecatCategory` in performance.ts).
 *
 *   TBL 5-5-3 "Wake Turbulence Separation for Directly Behind" and TBL 5-5-4 "... for On Approach"; rows = leader, columns = follower.
 *   A leader: B 5, C 6, D 6, E 7, F 7, G 7, H 8, I 8 (both tables)
 *   B leader: B 3, C 4, D 4, E 5, F 5, G 5, H 5, I 5 (directly behind) / I 6 (on approach)
 *   C leader: E 3.5, F 3.5, G 3.5, H 5, I 5 (directly behind) / I 6 (on approach)
 *   D leader: B 3, C 4, D 4, E 5, F 5, G 5, H 5, I 5 (directly behind) / H 6, I 6 (on approach)
 *   E leader: I 4 (both)        F leader: nothing directly behind, I 4 on approach        G, H, I leaders: nothing
 * A blank cell means no wake minimum: only the radar minimum (3 NM terminal) applies. So for the simulator's types: A320 (F) behind
 * A320: none; C172 (I) behind A320 (F): 4 NM on approach, none directly behind; A320 behind C172 and C172 behind C172: none.
 */
export type WakeCategory = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';
const ORDER: WakeCategory[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

/** leader -> follower columns A..I (0 = blank). */
const DIRECTLY_BEHIND: Record<WakeCategory, number[]> = {
  A: [0, 5, 6, 6, 7, 7, 7, 8, 8],
  B: [0, 3, 4, 4, 5, 5, 5, 5, 5],
  C: [0, 0, 0, 0, 3.5, 3.5, 3.5, 5, 5],
  D: [0, 3, 4, 4, 5, 5, 5, 5, 5],
  E: [0, 0, 0, 0, 0, 0, 0, 0, 4],
  F: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  G: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  H: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  I: [0, 0, 0, 0, 0, 0, 0, 0, 0],
};
const ON_APPROACH: Record<WakeCategory, number[]> = {
  A: [0, 5, 6, 6, 7, 7, 7, 8, 8],
  B: [0, 3, 4, 4, 5, 5, 5, 5, 6],
  C: [0, 0, 0, 0, 3.5, 3.5, 3.5, 5, 6],
  D: [0, 3, 4, 4, 5, 5, 5, 6, 6],
  E: [0, 0, 0, 0, 0, 0, 0, 0, 4],
  F: [0, 0, 0, 0, 0, 0, 0, 0, 4],
  G: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  H: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  I: [0, 0, 0, 0, 0, 0, 0, 0, 0],
};

/** Wake minimum in NM for `follower` behind `leader` (0 = no wake minimum; the radar minimum applies). */
export function wakeMinimumNm(leader: WakeCategory, follower: WakeCategory, geometry: 'directly_behind' | 'on_approach'): number {
  return (geometry === 'on_approach' ? ON_APPROACH : DIRECTLY_BEHIND)[leader][ORDER.indexOf(follower)];
}
