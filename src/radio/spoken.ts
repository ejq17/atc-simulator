/** Spoken-number and phonetic rendering for radio phraseology (US style: "niner", "point"). */

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'] as const;
const NATO: Record<string, string> = {
  A: 'alpha', B: 'bravo', C: 'charlie', D: 'delta', E: 'echo', F: 'foxtrot', G: 'golf', H: 'hotel', I: 'india',
  J: 'juliet', K: 'kilo', L: 'lima', M: 'mike', N: 'november', O: 'oscar', P: 'papa', Q: 'quebec', R: 'romeo',
  S: 'sierra', T: 'tango', U: 'uniform', V: 'victor', W: 'whiskey', X: 'x-ray', Y: 'yankee', Z: 'zulu',
};
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

export function phonetic(letter: string): string {
  return NATO[letter.toUpperCase()] ?? letter.toLowerCase();
}

/** Each character spoken individually: "13" -> "one three", "A1" -> "alpha one", "." -> "point". */
export function digitsSpoken(s: string): string {
  const out: string[] = [];
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') out.push(DIGITS[Number(ch)]);
    else if (ch === '.') out.push('point');
    else if (/[A-Za-z]/.test(ch)) out.push(phonetic(ch));
  }
  return out.join(' ');
}

/** 0..99 as ordinary number words: 51 -> "fifty one", 15 -> "fifteen". */
export function numberWords(n: number): string {
  if (n < 10) return ONES[n];
  if (n < 20) return TEENS[n - 10];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? `${TENS[t]} ${ONES[o]}` : TENS[t];
}

const RUNWAY_SUFFIX: Record<string, string> = { L: 'left', R: 'right', C: 'center' };

/** "13" -> "one three", "4" -> "four", "13L" -> "one three left"; "13/31" speaks the first end. */
export function spokenRunway(id: string): string {
  let s = id.trim().toUpperCase().replace(/^(RUNWAY|RWY)\s*/, '');
  if (s.includes('/')) s = s.split('/')[0];
  const m = /^(\d{1,2})([LRC])?$/.exec(s);
  if (!m) return digitsSpoken(s);
  const num = String(Number(m[1]));
  return digitsSpoken(num) + (m[2] ? ` ${RUNWAY_SUFFIX[m[2]]}` : '');
}

/** "121.9" -> "one two one point niner". */
export function spokenFrequency(mhz: number | string): string {
  let s = typeof mhz === 'number' ? mhz.toFixed(3) : mhz;
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return digitsSpoken(s);
}

/** Decimal part only: 121.9 -> "point niner". */
export function spokenFrequencyDecimal(mhz: number): string {
  const s = mhz.toFixed(3).replace(/0+$/, '');
  const dec = s.split('.')[1] ?? '0';
  return `point ${digitsSpoken(dec)}`;
}

/** Headings are always three digits: 5 -> "zero zero five", 270 -> "two seven zero". */
export function spokenHeading(deg: number): string {
  let n = Math.round(((deg % 360) + 360) % 360);
  if (n === 0) n = 360;
  return digitsSpoken(String(n).padStart(3, '0'));
}

/** 2500 -> "two thousand five hundred", 10000 -> "one zero thousand", >= 18000 -> flight level. */
export function spokenAltitude(ft: number): string {
  const f = Math.round(ft);
  if (f >= 18000) return `flight level ${digitsSpoken(String(Math.round(f / 100)).padStart(3, '0'))}`;
  if (f < 100) return digitsSpoken(String(Math.max(0, f)));
  const thousands = Math.floor(f / 1000);
  const hundreds = Math.floor((f % 1000) / 100);
  const tail = f % 100;
  const parts: string[] = [];
  if (thousands >= 1) parts.push(`${thousands >= 10 ? digitsSpoken(String(thousands)) : DIGITS[thousands]} thousand`);
  if (hundreds) parts.push(`${DIGITS[hundreds]} hundred`);
  if (tail) parts.push(digitsSpoken(String(tail).padStart(2, '0')));
  return parts.join(' ');
}

export function spokenSpeed(kt: number): string {
  return digitsSpoken(String(Math.round(kt)));
}

/** Taxiway identifier: "A" -> "alpha", "A1" -> "alpha one". */
export function spokenTaxiway(id: string): string {
  return digitsSpoken(id.trim());
}

/** Free text (parking names etc.): digits are spoken individually, "GA" expanded. */
export function spokenText(text: string): string {
  return text
    .replace(/\bGA\b/g, 'general aviation')
    .replace(/\d+/g, (d) => ` ${digitsSpoken(d)} `)
    .replace(/\s+/g, ' ')
    .trim();
}

const AIRLINES: Record<string, string> = {
  NKS: 'Spirit', AAL: 'American', DAL: 'Delta', UAL: 'United', SWA: 'Southwest', JBU: 'JetBlue', FFT: 'Frontier',
  ASA: 'Alaska', AAY: 'Allegiant', SKW: 'SkyWest', ENY: 'Envoy', RPA: 'Brickyard', FDX: 'FedEx', UPS: 'U P S',
  EJA: 'Executive Jet', LXJ: 'Flexjet', EDV: 'Endeavor', JIA: 'Blue Streak', BAW: 'Speedbird', ACA: 'Air Canada',
};

const GA_PREFIX: Record<string, string> = { C172: 'Cessna', C182: 'Cessna', C152: 'Cessna', C210: 'Cessna', PA28: 'Piper', SR22: 'Cirrus', BE36: 'Bonanza' };

/** Airline flight number in group form: 451 -> "four fifty one", 1234 -> "twelve thirty four", 100 -> "one hundred". */
export function flightNumberSpoken(num: string): string {
  // 7110.65 2-4-20: a flight number with a leading zero is spoken digit by digit ("Delta Zero One Zero")
  if (num.length > 1 && num.startsWith('0')) return digitsSpoken(num);
  const n = Number(num);
  if (num.length <= 2) return n < 10 && num.length === 1 ? ONES[n] : num.startsWith('0') ? digitsSpoken(num) : numberWords(n);
  const tail = num.slice(-2);
  const head = num.slice(0, -2);
  const headWords = head.length === 1 ? ONES[Number(head)] : numberWords(Number(head));
  if (tail === '00') return `${headWords} hundred`;
  if (tail.startsWith('0')) return `${headWords} ${digitsSpoken(tail)}`;
  return `${headWords} ${numberWords(Number(tail))}`;
}

/** "N723EJ" (C172) -> "Cessna seven two three echo juliet"; "NKS451" -> "Spirit four fifty one". */
export function spokenCallsign(callsign: string, type?: string): string {
  const cs = callsign.trim().toUpperCase();
  const air = /^([A-Z]{3})(\d{1,4})([A-Z]?)$/.exec(cs);
  if (air && AIRLINES[air[1]]) {
    return `${AIRLINES[air[1]]} ${flightNumberSpoken(air[2])}${air[3] ? ` ${phonetic(air[3])}` : ''}`;
  }
  const n = /^N(\d{1,5}[A-Z]{0,2})$/.exec(cs);
  if (n) {
    const prefix = type && GA_PREFIX[type] ? GA_PREFIX[type] : 'November';
    return `${prefix} ${digitsSpoken(n[1])}`;
  }
  return digitsSpoken(cs);
}

const AIRPORT_CITIES: Record<string, string> = {
  KPHL: 'Philadelphia', KJFK: 'Kennedy', KLGA: 'LaGuardia', KEWR: 'Newark', KBOS: 'Boston', KDCA: 'Reagan National', KIAD: 'Dulles',
  KBWI: 'Baltimore', KORD: 'Chicago O\'Hare', KATL: 'Atlanta', KCLT: 'Charlotte', KMIA: 'Miami', KMCO: 'Orlando', KFLL: 'Fort Lauderdale',
  KPIT: 'Pittsburgh', KDTW: 'Detroit', KRDU: 'Raleigh Durham', KTPA: 'Tampa', KILG: 'Wilmington', KTTN: 'Trenton', KMIV: 'Millville',
  KWWD: 'Wildwood', KVAY: 'Mount Holly', KACY: 'Atlantic City', KPNE: 'Northeast Philadelphia', KABE: 'Allentown',
};

/** Spoken name of an airport for clearances: "KPHL" -> "Philadelphia"; unknown ids are spelled in phonetics. */
export function spokenAirportName(icao: string): string {
  const up = icao.trim().toUpperCase();
  return AIRPORT_CITIES[up] ?? AIRPORT_CITIES[`K${up}`] ?? digitsSpoken(up);
}

/** "CEDAR LAKE" -> "Cedar Lake" (navaid names in clearances). */
export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
