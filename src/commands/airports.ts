/** Spoken airport names -> ICAO, for IFR clearance destinations. Multi-word names are matched longest first. */
const NAMES: readonly (readonly [string, string])[] = [
  ['philadelphia', 'KPHL'], ['philly', 'KPHL'],
  ['newark', 'KEWR'], ['newark liberty', 'KEWR'],
  ['new york kennedy', 'KJFK'], ['kennedy', 'KJFK'], ['jfk', 'KJFK'],
  ['laguardia', 'KLGA'], ['la guardia', 'KLGA'],
  ['boston', 'KBOS'], ['logan', 'KBOS'],
  ['washington national', 'KDCA'], ['reagan national', 'KDCA'], ['reagan', 'KDCA'],
  ['dulles', 'KIAD'], ['washington dulles', 'KIAD'],
  ['baltimore', 'KBWI'], ['bwi', 'KBWI'],
  ['teterboro', 'KTEB'],
  ['charlotte', 'KCLT'], ['atlanta', 'KATL'], ['orlando', 'KMCO'],
  ['fort lauderdale', 'KFLL'], ['myrtle beach', 'KMYR'],
  ['atlantic city', 'KACY'],
  ['manchester', 'KMHT'], ['manchester boston', 'KMHT'],
  ['punta gorda', 'KPGD'], ['page field', 'KFMY'], ['venice', 'KVNC'], ['sarasota', 'KSRQ'], ['naples', 'KAPF'], ['immokalee', 'KIMM'], ['lakeland', 'KLAL'],
  ['albany', 'KALB'], ['asheville', 'KAVL'], ['cincinnati', 'KCVG'], ['providence', 'KPVD'], ['minneapolis', 'KMSP'], ['lexington', 'KLEX'], ['kansas city', 'KMCI'],
  ['rochester', 'KROC'], ['syracuse', 'KSYR'], ['grand rapids', 'KGRR'], ['akron canton', 'KCAK'], ['knoxville', 'KTYS'], ['harrisburg', 'KMDT'], ['allentown', 'KABE'], ['pittsburgh', 'KPIT'], ['trenton', 'KTTN'],
  ['nashville', 'KBNA'], ['chicago midway', 'KMDW'], ['midway', 'KMDW'],
  ['chicago ohare', 'KORD'], ['chicago o\'hare', 'KORD'], ['o\'hare', 'KORD'], ['ohare', 'KORD'],
  ['miami', 'KMIA'], ['detroit', 'KDTW'], ['pittsburgh', 'KPIT'], ['dallas fort worth', 'KDFW'], ['dallas', 'KDFW'], ['denver', 'KDEN'], ['st louis', 'KSTL'],
  ['saint louis', 'KSTL'], ['minneapolis', 'KMSP'], ['houston', 'KIAH'], ['san francisco', 'KSFO'], ['seattle', 'KSEA'], ['salt lake city', 'KSLC'],
  ['new castle', 'KILG'], ['trenton', 'KTTN'], ['northeast philadelphia', 'KPNE'], ['wings field', 'KLOM'], ['mount holly', 'KVAY'], ['millville', 'KMIV'],
  ['coatesville', 'KMQS'], ['brandywine', 'KOQN'], ['doylestown', 'KDYL'], ['heritage field', 'KPTW'], ['allentown', 'KABE'],
  ['tampa', 'KTPA'], ['fort myers', 'KRSW'], ['charleston', 'KCHS'], ['raleigh durham', 'KRDU'], ['raleigh', 'KRDU'],
  ['louisville', 'KSDF'], ['memphis', 'KMEM'],
  ['heathrow', 'EGLL'], ['london heathrow', 'EGLL'], ['london', 'EGLL'], ['paris', 'LFPG'], ['paris charles de gaulle', 'LFPG'], ['amsterdam', 'EHAM'], ['frankfurt', 'EDDF'],
  ['dublin', 'EIDW'], ['madrid', 'LEMD'], ['dubai', 'OMDB'],
  ['nashua', 'KASH'], ['concord', 'KCON'], ['portsmouth', 'KPSM'], ['portland', 'KPWM'], ['keene', 'KEEN'], ['laconia', 'KLCI'],
  ['detroit', 'KDTW'], ['miami', 'KMIA'],
  ['norwood', 'KOWD'], ['plymouth', 'KPYM'], ['worcester', 'KORH'], ['hyannis', 'KHYA'], ['provincetown', 'KPVC'],
  ['london heathrow', 'EGLL'], ['heathrow', 'EGLL'], ['frankfurt', 'EDDF'], ['paris', 'LFPG'], ['dublin', 'EIDW'],
  ['bedford', 'KBED'], ['hanscom', 'KBED'], ['lawrence', 'KLWM'], ['beverly', 'KBVY'], ['fitchburg', 'KFIT'],
];

export const AIRPORT_NAMES: readonly { words: readonly string[]; icao: string }[] = NAMES
  .map(([n, icao]) => ({ words: n.split(' '), icao }))
  .sort((a, b) => b.words.length - a.words.length);

/** Three-letter FAA / IATA codes derived from the table (PHL, EWR ...), spoken as letters or typed. */
export const FAA_CODES: ReadonlyMap<string, string> = new Map(
  [...new Set(NAMES.map(([, icao]) => icao))].filter((icao) => icao.startsWith('K')).map((icao) => [icao.slice(1).toLowerCase(), icao]),
);
