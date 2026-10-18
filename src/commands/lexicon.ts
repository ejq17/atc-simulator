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
  moxy: 'MXY', brickyard: 'RPA', lindbergh: 'GJS', wiggins: 'WIG', streak: 'JIA',
  airport: 'APT', // AC 150/5210-20A: "Airport 21 vehicle" (only before a number, normalize.ts)
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
// A target `text` with spaces ("hold short") expands to several plain words that share the phrase's raw range.
export const PHRASES: readonly { words: readonly string[]; to: PhraseTarget }[] = [
  { words: ['x', 'ray'], to: { text: 'x', kind: 'letter' } },
  { words: ['sun', 'country'], to: { text: 'SCX', kind: 'airline' } },
  { words: ['jet', 'blue'], to: { text: 'JBU', kind: 'airline' } },
  { words: ['fed', 'ex'], to: { text: 'FDX', kind: 'airline' } },
  { words: ['sky', 'west'], to: { text: 'SKW', kind: 'airline' } },
  // Service callsigns of JO 7110.65 2-4-20 ("Coast Guard Six One Three Two Seven", "Air Guard One Three Five Eight Six")
  { words: ['coast', 'guard'], to: { text: 'CGD', kind: 'airline' } },
  { words: ['air', 'guard'], to: { text: 'ANG', kind: 'airline' } },
  // Formation calls ("flight of two") are part of the callsign, not an instruction or a number (JO 7110.65 2-1-13)
  { words: ['flight', 'of', 'two'], to: { text: '' } },
  { words: ['flight', 'of', 'three'], to: { text: '' } },
  { words: ['flight', 'of', 'four'], to: { text: '' } },
  { words: ['flight', 'level'], to: { text: 'fl' } },
  { words: ['take', 'off'], to: { text: 'takeoff' } },
  { words: ['run', 'way'], to: { text: 'runway' } },
  { words: ['run', 'away'], to: { text: 'runway' } }, // "taxi to run away 3 5"
  { words: ['push', 'back'], to: { text: 'pushback' } },
  // Empty target = the phrase is dropped as a filler ("that was taxi via hotel": a spoken self-correction lead-in)
  { words: ['that', 'was'], to: { text: '' } },
  // Whisper tiny.en renderings heard in real sessions
  { words: ['tax', 'e'], to: { text: 'taxi' } },
  { words: ['park', 'yee'], to: { text: 'parking' } },
  { words: ['park', 'ee'], to: { text: 'parking' } },
  { words: ['be', 'a'], to: { text: 'via' } },
  // Whisper / Web Speech renderings of ground instructions heard in real sessions
  { words: ['hold', 'shore'], to: { text: 'hold short' } },
  { words: ['whole', 'chore'], to: { text: 'hold short' } },
  { words: ['whole', 'shore'], to: { text: 'hold short' } },
  { words: ['hole', 'short'], to: { text: 'hold short' } },
  { words: ['tax', 'it'], to: { text: 'taxi' } },
  { words: ['around', 'way'], to: { text: 'to runway' } },
  // STT renderings of approach names
  { words: ['i', 'l', 's'], to: { text: 'ils' } },
  { words: ['eye', 'el', 'es'], to: { text: 'ils' } },
  { words: ['eye', 'l', 's'], to: { text: 'ils' } },
  { words: ['i', 'el', 'es'], to: { text: 'ils' } },
  { words: ['r', 'n', 'a', 'v'], to: { text: 'rnav' } },
  { words: ['r', 'nav'], to: { text: 'rnav' } },
  { words: ['are', 'nav'], to: { text: 'rnav' } },
  { words: ['ar', 'nav'], to: { text: 'rnav' } },
  { words: ['v', 'o', 'r'], to: { text: 'vor' } },
  { words: ['l', 'o', 'c'], to: { text: 'loc' } },
];

/** Single-word STT / spelling corrections (value may expand to several words). */
export const ALIASES = rec<readonly string[]>({
  weight: ['wait'], waite: ['wait'], runaway: ['runway'], rwy: ['runway'], taxy: ['taxi'],
  tousand: ['thousand'], decimal: ['point'], dot: ['point'], knot: ['knots'], kts: ['knots'],
  kt: ['knots'], lineup: ['line', 'up'], takeoffs: ['takeoff'], ramps: ['ramp'],
  centre: ['center'], localiser: ['localizer'], localizor: ['localizer'], localizers: ['localizer'], hedding: ['heading'], goaround: ['go', 'around'],
  // Whisper tiny.en renderings heard in real sessions
  tackty: ['taxi'], taxie: ['taxi'], taxity: ['taxi'], taxituary: ['taxi', 'to', 'runway'], vietnam: ['via', 'november'],
  taxitu: ['taxi', 'to'], tax: ['taxi'], access: ['taxi'], mic: ['mike'], alima: ['via', 'lima'], holdshore: ['hold', 'short'],
  taxa: ['taxi'], chaxi: ['taxi'], taxee: ['taxi'], vialima: ['via', 'lima'], aravo: ['bravo'], baravo: ['bravo'],
});

/**
 * "via a Lima": STT writes the article "a" for the second half of "via". Only a lower-case raw "a" between "via" and a
 * spelled NATO word is dropped (a typed taxiway "via A C" or "via a l" is untouched).
 */
export const VIA_ARTICLE = 'a';

/** Core instruction words an unknown, near-miss word may be corrected to (see `fuzzyCorrect` in normalize.ts). */
export const FUZZY_KEYWORDS: readonly string[] = [
  'taxi', 'runway', 'hold', 'short', 'via', 'contact', 'tower', 'ground', 'cleared', 'cross', 'continue', 'position',
  'parking', 'ramp', 'terminal', 'gate', 'takeoff', 'land', 'line', 'wait',
];

/**
 * Words the grammar or the callsign logic gives a meaning to, plus common English words that sit one letter from a
 * keyword or NATO word ("make"~mike, "like"~line, "late"~gate). Never fuzz-corrected.
 */
export const FUZZ_PROTECTED: ReadonlySet<string> = new Set([
  'able', 'above', 'after', 'again', 'airport', 'along', 'also', 'altitude', 'approach', 'approved', 'apron', 'area',
  'around', 'aviation', 'band', 'base', 'below', 'call', 'cancel', 'cargo', 'center', 'change', 'clear', 'clearance',
  'climb', 'come', 'control', 'course', 'crossing', 'degrees', 'delivery', 'depart', 'departing', 'departure', 'descend',
  'direct', 'down', 'downwind', 'early', 'east', 'enter', 'established', 'execute', 'expect', 'expedite', 'fbo', 'field',
  'filed', 'final', 'follow', 'frequency', 'from', 'further', 'general', 'ground', 'gust', 'gusting', 'gusts', 'hand',
  'hangar', 'heading', 'holding', 'hundred', 'ident', 'immediately', 'initial', 'into', 'join', 'knots', 'landing', 'late',
  'left', 'legs', 'liftoff', 'localizer', 'low', 'maintain', 'make', 'mile', 'miles', 'minute', 'minutes', 'missed',
  'monitor', 'navigation', 'next', 'normal', 'north', 'northeast', 'northwest', 'number', 'option', 'own', 'park', 'passing',
  'pattern', 'please', 'point', 'present', 'proceed', 'published', 'push', 'pushback', 'radar', 'radial', 'reduce', 'repeat',
  'report', 'resume', 'right', 'route', 'runways', 'say', 'shorts', 'slow', 'south', 'southeast', 'southwest', 'speed',
  'squawk', 'standard', 'start', 'straight', 'switch', 'tail', 'tails', 'face', 'facing', 'nose', 'taxiing', 'taxiway', 'taxiways', 'than', 'that', 'then', 'there',
  'thousand', 'time', 'touch', 'traffic', 'turn', 'turns', 'until', 'using', 'vectors', 'visual', 'west', 'when', 'will',
  'wind', 'winds', 'with', 'within', 'your', 'ils', 'rnav', 'vor', 'loc', 'fix', 'flight', 'level', 'ready', 'copy', 'wilco',
  'like', 'fine', 'lane', 'date', 'rate', 'mate', 'wine', 'came', 'same', 'name', 'game', 'gave', 'have', 'take',
  'give', 'just', 'this', 'them', 'they', 'what', 'were', 'been', 'here', 'well', 'very', 'some', 'more', 'most', 'much',
  'such', 'want', 'need', 'know', 'look', 'back', 'last', 'long', 'good', 'over', 'onto', 'told', 'hole',
  'cross', 'gross', 'rump', 'camp', 'tell', 'hello', 'light', 'right', 'night', 'tight', 'sight', 'might',
]);

/** Words Whisper writes for the "November" of an N-number ("Number 678 mike victor", "Remember, 685 golf delta"). */
export const N_PREFIX_WORDS: ReadonlySet<string> = new Set(['number', 'remember', 'novembre', 'nowember']);

/**
 * Words Whisper writes for the "fox" of "foxtrot" ("fox drive", "fucks truck", "foxdrought"). In a taxiway context
 * (see `foxtrotDrift` in normalize.ts) one of these, optionally plus one unknown short word, is the letter F.
 */
export const FOXTROT_WORDS: ReadonlySet<string> = new Set(['fox', 'fucks', 'fux', 'folks', 'fax']);
/** A single unknown word that fuses "fox" with the next syllable ("foxdrought", "fuxdrought", "fuckstrapped"). */
export const FOXTROT_FUSED = /^(?:fox|fux|fucks)[a-z]{3,9}$/;

/** Words Whisper writes for "tower" right after "contact" ("contact our", "contact hour"). Only honoured in that position. */
export const TOWER_MISHEARD: ReadonlySet<string> = new Set(['our', 'hour', 'power', 'towers', 'tar', 'towel']);

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
  'is', 'heavy', 'super', 'also', 'next', 'over', 'vehicle',
]);

/** Speech disfluencies dropped during normalisation (the raw text still keeps them). */
export const DISFLUENCIES: ReadonlySet<string> = new Set(['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm']);
