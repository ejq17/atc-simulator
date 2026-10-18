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
  ['nashville', 'KBNA'], ['chicago midway', 'KMDW'], ['midway', 'KMDW'],
  ['chicago ohare', 'KORD'], ['chicago o\'hare', 'KORD'], ['o\'hare', 'KORD'], ['ohare', 'KORD'],
  ['tampa', 'KTPA'], ['fort myers', 'KRSW'], ['charleston', 'KCHS'], ['raleigh durham', 'KRDU'], ['raleigh', 'KRDU'],
  ['louisville', 'KSDF'], ['memphis', 'KMEM'],
  ['nashua', 'KASH'], ['concord', 'KCON'], ['portsmouth', 'KPSM'], ['portland', 'KPWM'], ['keene', 'KEEN'], ['laconia', 'KLCI'],
  ['bedford', 'KBED'], ['hanscom', 'KBED'], ['lawrence', 'KLWM'], ['beverly', 'KBVY'], ['fitchburg', 'KFIT'],
];

export const AIRPORT_NAMES: readonly { words: readonly string[]; icao: string }[] = NAMES
  .map(([n, icao]) => ({ words: n.split(' '), icao }))
  .sort((a, b) => b.words.length - a.words.length);

/** Three-letter FAA / IATA codes derived from the table (PHL, EWR ...), spoken as letters or typed. */
export const FAA_CODES: ReadonlyMap<string, string> = new Map(
  [...new Set(NAMES.map(([, icao]) => icao))].map((icao) => [icao.slice(1).toLowerCase(), icao]),
);
