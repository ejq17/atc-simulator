/**
 * FAA JO 7110.65 references used by training, debrief and objectives.
 *
 * Every entry below was confirmed on 2026-10-16 by fetching the FAA web edition of the order
 * (https://www.faa.gov/air_traffic/publications/atpubs/atc_html/, edition shown on the site: JO 7110.65BB) and
 * reading the paragraph heading on the page named in `url`. Text is paraphrased, never quoted. Only paragraphs
 * listed here may be cited elsewhere in src/game.
 *
 * IFR additions (4-2-1, 4-3-2, 4-8-1, 5-9-1, 5-9-2, 5-9-4) were confirmed the same way on 2026-10-16 (chapter 4 sections 2, 3 and 8, chapter 5
 * section 9, fetched with a browser User-Agent; headings read from the page, edition JO 7110.65BB).
 */
export interface FaaReference {
  /** Paragraph number, e.g. "3-9-10". */
  para: string;
  /** Paragraph title exactly as printed on the FAA page (case normalised). */
  title: string;
  /** Page that contains the paragraph (anchor #para works on the FAA site). */
  url: string;
}

const BASE = 'https://www.faa.gov/air_traffic/publications/atpubs/atc_html/';

function ref(para: string, title: string, page: string): FaaReference {
  return { para, title, url: `${BASE}${page}.html#${para}` };
}

export const REFERENCES = {
  '2-4-3': ref('2-4-3', 'Pilot Acknowledgment/Read Back', 'chap2_section_4'),
  '2-4-20': ref('2-4-20', 'Aircraft Identification', 'chap2_section_4'),
  '3-1-3': ref('3-1-3', 'Use of Active Runways', 'chap3_section_1'),
  '3-1-12': ref('3-1-12', 'Visually Scanning Runways', 'chap3_section_1'),
  '4-2-1': ref('4-2-1', 'Clearance Items', 'chap4_section_2'),
  '4-3-2': ref('4-3-2', 'Departure Clearances', 'chap4_section_3'),
  '4-8-1': ref('4-8-1', 'Approach Clearance', 'chap4_section_8'),
  '5-9-1': ref('5-9-1', 'Vectors to Final Approach Course', 'chap5_section_9'),
  '5-9-2': ref('5-9-2', 'Final Approach Course Interception', 'chap5_section_9'),
  '5-9-4': ref('5-9-4', 'Arrival Instructions', 'chap5_section_9'),
  '3-7-1': ref('3-7-1', 'Ground Traffic Movement', 'chap3_section_7'),
  '3-7-2': ref('3-7-2', 'Taxi and Ground Movement Operations', 'chap3_section_7'),
  '3-8-1': ref('3-8-1', 'Sequence/Spacing Application', 'chap3_section_8'),
  '3-9-4': ref('3-9-4', 'Line Up and Wait (LUAW)', 'chap3_section_9'),
  '3-9-6': ref('3-9-6', 'Same Runway Separation', 'chap3_section_9'),
  '3-9-8': ref('3-9-8', 'Intersecting Runway/Intersecting Flight Path Operations', 'chap3_section_9'),
  '3-9-10': ref('3-9-10', 'Takeoff Clearance', 'chap3_section_9'),
  '3-10-3': ref('3-10-3', 'Same Runway Separation', 'chap3_section_10'),
  '3-10-5': ref('3-10-5', 'Landing Clearance', 'chap3_section_10'),
  '3-10-8': ref('3-10-8', 'Withholding Landing Clearance', 'chap3_section_10'),
  '3-10-9': ref('3-10-9', 'Runway Exiting', 'chap3_section_10'),
  '10-1-1': ref('10-1-1', 'Emergency Determinations', 'chap10_section_1'),
} as const satisfies Record<string, FaaReference>;

export type ReferenceId = keyof typeof REFERENCES;

/** "FAA JO 7110.65 3-9-10 Takeoff Clearance" - the string stored in `TrainingStepSpec.reference`. */
export function refText(id: ReferenceId): string {
  const r = REFERENCES[id];
  return `FAA JO 7110.65 ${r.para} ${r.title}`;
}

/** Several references joined, e.g. refText2('3-9-10', '3-10-3'). */
export function refTexts(...ids: ReferenceId[]): string {
  return ids.map((i) => `${REFERENCES[i].para} ${REFERENCES[i].title}`).join('; ').replace(/^/, 'FAA JO 7110.65 ');
}

/** The simulator's published disclaimer. Show it on the title screen, in training mode and in debriefs. */
export const TRAINING_DISCLAIMER =
  'This simulator is entertainment and learning software. It is NOT air traffic control training, it is not approved by the FAA or any authority, ' +
  'and its simplified aircraft behaviour, hold-line positions and procedures must never be used for real-world operations or as a substitute for ' +
  'certified ATC training. FAA JO 7110.65 paragraph references point you to the real procedures; the order itself governs.';

/** Notice that the airport diagram itself carries, used to justify hold-short readback training. */
export const KACY_READBACK_NOTE =
  'The KACY airport diagram requires readback of all runway holding instructions.';
