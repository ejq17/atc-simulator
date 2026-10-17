/** Static vocabulary tables. Extend these to teach the parser new words. */

const rec = <T>(o: Record<string, T>): ReadonlyMap<string, T> => new Map(Object.entries(o));

/** Single digit words, including aviation and common STT variants. */
export const DIGIT_WORDS = rec({
  zero: 0, one: 1, won: 1, two: 2, three: 3, tree: 3, four: 4, fower: 4,
  five: 5, fife: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9, niner: 9,
});
export const TEEN_WORDS = rec({
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
});
export const TENS_WORDS = rec({
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
});
export const MULT_WORDS = rec({ hundred: 100, thousand: 1000 });
/** Words that are digits only when sitting between/next to other number words. */
export const HOMOPHONE_DIGITS = rec({ to: 2, too: 2, for: 4, fore: 4 });

/** NATO phonetic alphabet plus common STT spellings. */
export const NATO = rec({
  alpha: 'a', alfa: 'a', bravo: 'b', charlie: 'c', charley: 'c', delta: 'd', echo: 'e',
  foxtrot: 'f', golf: 'g', hotel: 'h', india: 'i', juliet: 'j', juliett: 'j', juliette: 'j',
  kilo: 'k', lima: 'l', mike: 'm', november: 'n', oscar: 'o', papa: 'p', pappa: 'p',
  quebec: 'q', romeo: 'r', sierra: 's', tango: 't', uniform: 'u', victor: 'v',
  whiskey: 'w', whisky: 'w', xray: 'x', yankee: 'y', zulu: 'z',
});

/** Airline telephony (single spoken word) -> ICAO prefix. */
export const AIRLINES = rec({
  spirit: 'NKS', american: 'AAL', delta: 'DAL', united: 'UAL', southwest: 'SWA',
  jetblue: 'JBU', frontier: 'FFT', fedex: 'FDX', ups: 'UPS', allegiant: 'AAY',
  breeze: 'MXY', republic: 'RPA', envoy: 'ENY', skywest: 'SKW', piedmont: 'PDT',
  psa: 'JIA', endeavor: 'EDV', mesa: 'ASH',
});

/** General-aviation callsign prefixes ("Cessna 723EJ"), mapped to type-code regexes. */
export const GA_PREFIXES = rec<RegExp>({
  cessna: /^C\d/, skyhawk: /^C172/, skylane: /^C182/, piper: /^(PA|P28|P32)/,
  cherokee: /^(PA28|P28)/, archer: /^(PA28|P28)/, warrior: /^(PA28|P28)/,
  cirrus: /^(SR2|SF50)/, beech: /^(BE|B\d|BON)/, bonanza: /^(BE|B3|BON|S35)/,
  mooney: /^M20/, diamond: /^DA\d/, baron: /^(BE5|BE6|B55|B58)/, comanche: /^PA24/,
  seneca: /^PA34/, citation: /^C5/, saratoga: /^PA32/,
});

/** Multi-word phrases collapsed to one token. kind 'word' means plain word. */
export interface PhraseTarget { text: string; kind?: 'airline' | 'letter' }
export const PHRASES: readonly { words: readonly string[]; to: PhraseTarget }[] = [
  { words: ['x', 'ray'], to: { text: 'x', kind: 'letter' } },
  { words: ['sun', 'country'], to: { text: 'SCX', kind: 'airline' } },
  { words: ['jet', 'blue'], to: { text: 'JBU', kind: 'airline' } },
  { words: ['fed', 'ex'], to: { text: 'FDX', kind: 'airline' } },
  { words: ['sky', 'west'], to: { text: 'SKW', kind: 'airline' } },
  { words: ['flight', 'level'], to: { text: 'fl' } },
  { words: ['take', 'off'], to: { text: 'takeoff' } },
  { words: ['run', 'way'], to: { text: 'runway' } },
  { words: ['push', 'back'], to: { text: 'pushback' } },
];

/** Single-word STT / spelling corrections (value may expand to several words). */
export const ALIASES = rec<readonly string[]>({
  weight: ['wait'], waite: ['wait'], runaway: ['runway'], rwy: ['runway'], taxy: ['taxi'],
  tousand: ['thousand'], decimal: ['point'], dot: ['point'], knot: ['knots'], kts: ['knots'],
  kt: ['knots'], lineup: ['line', 'up'], takeoffs: ['takeoff'], ramps: ['ramp'],
  centre: ['center'], hedding: ['heading'], goaround: ['go', 'around'],
});

/** Alphanumeric fragments that must not be split letter-by-letter ("250kts", "fl180"). */
export const KEEP_WORDS: ReadonlySet<string> = new Set([
  'fl', 'kts', 'kt', 'knots', 'ft', 'feet', 'mhz', 'nm', 'rwy', 'runway', 'heading', 'taxiway', 'gate',
]);

/** Words after which an airline-looking/phonetic word is a taxiway letter, not a callsign. */
export const TAXIWAY_CONTEXT: ReadonlySet<string> = new Set([
  'via', 'taxiway', 'to', 'and', 'then', 'at', 'of', 'short', 'runway', 'hold', 'cross', 'on',
  'from', 'by', 'along', 'using', 'onto',
]);

export const FACILITIES = rec({
  ground: 'GND', tower: 'TWR', approach: 'APP', departure: 'DEP', clearance: 'CLNC', delivery: 'CLNC',
});

/** Words consumed silently (they carry no instruction but count as understood). */
export const FILLERS: ReadonlySet<string> = new Set([
  'please', 'now', 'immediately', 'expedite', 'and', 'then', 'the', 'a', 'an', 'roger', 'ok', 'okay',
  'thanks', 'thank', 'you', 'good', 'day', 'morning', 'afternoon', 'evening', 'sir', 'atlantic', 'city',
  'ground', 'tower', 'approach', 'departure', 'delivery', 'clearance', 'control', 'hello', 'hi', 'this',
  'is', 'heavy', 'super', 'also', 'next', 'over',
]);

/** Speech disfluencies dropped during normalisation (the raw text still keeps them). */
export const DISFLUENCIES: ReadonlySet<string> = new Set(['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm']);
