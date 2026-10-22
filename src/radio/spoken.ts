/** Spoken-number and phonetic rendering for radio phraseology (US style: "niner", "point"). */
import { wakeCallsignWord } from '../sim/performance';

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
  MXY: 'Moxy', PDT: 'Piedmont', GJS: 'Lindbergh', WIG: 'Wiggins', SCX: 'Sun Country',
  KAP: 'Cair', DLH: 'Lufthansa', AFR: 'Airfrans', EIN: 'Shamrock',
  VIR: 'Virgin', UAE: 'Emirates',
};

const GA_PREFIX: Record<string, string> = {
  C172: 'Cessna', C182: 'Cessna', C152: 'Cessna', C210: 'Cessna', C208: 'Cessna', PA28: 'Piper', SR22: 'Cirrus', BE36: 'Bonanza',
  // AIM 4-2-4: the pilot states the type, model or manufacturer's name before the registration. Business / commuter types added 2026-10-21 (words in GA_PREFIXES, commands/lexicon.ts).
  C402: 'Cessna', C56X: 'Citation', CL35: 'Challenger', GLF5: 'Gulfstream', GLEX: 'Global', BE20: 'King Air', BE9L: 'King Air', PC12: 'Pilatus',
};

/** How a pilot names the aircraft type in a call ("Boeing 737", "Airbus A220", "Embraer 175"); unknown types are read out by their code. */
const TYPE_NAMES: Record<string, string> = {
  C172: 'Cessna', C182: 'Cessna', C152: 'Cessna', C210: 'Cessna', C208: 'Caravan', PA28: 'Piper', SR22: 'Cirrus', BE36: 'Bonanza',
  A320: 'Airbus', A319: 'Airbus', A321: 'Airbus', BCS3: 'Airbus A220', BCS1: 'Airbus A220', B737: 'Boeing 737', B738: 'Boeing 737', B739: 'Boeing 737',
  B38M: 'Boeing 737', B752: 'Boeing 757', B763: 'Boeing 767', E175: 'Embraer 175', E170: 'Embraer 170', E190: 'Embraer 190', CRJ9: 'CRJ-900', CRJ7: 'CRJ-700', CRJ2: 'CRJ-200',
  A20N: 'Airbus', A21N: 'Airbus', A332: 'Airbus A330', A333: 'Airbus A330', A339: 'Airbus A330', A359: 'Airbus A350', A35K: 'Airbus A350', A388: 'Airbus A380', A306: 'Airbus A300',
  B762: 'Boeing 767', B772: 'Boeing 777', B77W: 'Boeing 777', B788: 'Boeing 787', B789: 'Boeing 787', B744: 'Boeing 747', B748: 'Boeing 747', MD11: 'MD-11',
  DH8D: 'Dash 8', BE20: 'King Air', BE9L: 'King Air', PC12: 'Pilatus', C402: 'Cessna', C56X: 'Citation', CL35: 'Challenger', GLF5: 'Gulfstream', GLEX: 'Global Express',
  H65: 'Dolphin', F16: 'Falcon', VEH: 'Vehicle',
};
export function spokenAircraftType(type: string): string {
  return TYPE_NAMES[type.trim().toUpperCase()] ?? digitsSpoken(type);
}

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
/**
 * Telephony of the military and vehicle callsign forms (internal tags are three letters so the airline-shaped matching in the parser works):
 *   CGD#####  "Coast Guard six one three two seven"  JO 7110.65 2-4-20 U.S. military: "the service name ... and the last 5 digits of the serial number"
 *   ANG#####  "Air Guard one three five eight six"   same paragraph (examples "Coast Guard Six One Three Two Seven", "Air Guard One Three Five Eight Six")
 *   APT##     "Airport two one vehicle"              FAA AC 150/5210-20A Appendix B para 4.3 ("this is Airport 21 vehicle at Charlie 6")
 * See docs/FAA-REFERENCES.md "Traffic variety".
 */
export const SERVICE_TELEPHONY: Readonly<Record<string, string>> = { CGD: 'Coast Guard', ANG: 'Air Guard', APT: 'Airport' };

/**
 * The spoken callsign, with "heavy" / "super" after it for a Category A-D aircraft (JO 7110.126A Appendix B, amended JO 7110.65 2-4-14: "the word heavy must
 * be used as part of the identification in all communications with or about heavy aircraft"; the 2-4-14 NOTE: "most airlines will use the word super or heavy
 * following the company prefix and flight number", example "United Fifty-Eight Heavy"). Needs the type; the service and vehicle forms never take it.
 */
export function spokenCallsign(callsign: string, type?: string): string {
  const base = baseSpokenCallsign(callsign, type);
  const word = type ? wakeCallsignWord(type.trim().toUpperCase()) : undefined;
  return word && !/^(CGD|ANG|APT)\d/i.test(callsign.trim()) ? `${base} ${word}` : base;
}

function baseSpokenCallsign(callsign: string, type?: string): string {
  const cs = callsign.trim().toUpperCase();
  const svc = /^(CGD|ANG)(\d{5})$/.exec(cs);
  if (svc) return `${SERVICE_TELEPHONY[svc[1]]} ${digitsSpoken(svc[2])}`;
  const veh = /^APT(\d{1,3})$/.exec(cs);
  if (veh) return `${SERVICE_TELEPHONY.APT} ${digitsSpoken(veh[1])} vehicle`;
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
  KWWD: 'Wildwood', KVAY: 'Mount Holly', KACY: 'Atlantic City', KMHT: 'Manchester', KPNE: 'Northeast Philadelphia', KABE: 'Allentown',
  KASH: 'Nashua', KCON: 'Concord', KLCI: 'Laconia', KPSM: 'Portsmouth', KLWM: 'Lawrence', KBVY: 'Beverly', KEEN: 'Keene', KBED: 'Bedford',
  KPWM: 'Portland', KFIT: 'Fitchburg', KBNA: 'Nashville', KMDW: 'Chicago Midway', KRSW: 'Fort Myers', KCHS: 'Charleston', KSDF: 'Louisville',
  KMEM: 'Memphis', KMYR: 'Myrtle Beach', KPGD: 'Punta Gorda', KFMY: 'Page Field', KVNC: 'Venice', KSRQ: 'Sarasota', KAPF: 'Naples', KIMM: 'Immokalee', KLAL: 'Lakeland', KALB: 'Albany', KAVL: 'Asheville', KCVG: 'Cincinnati', KPVD: 'Providence', KMSP: 'Minneapolis', KLEX: 'Lexington', KMCI: 'Kansas City', KROC: 'Rochester', KSYR: 'Syracuse', KGRR: 'Grand Rapids', KCAK: 'Akron Canton', KTYS: 'Knoxville', KMDT: 'Harrisburg',
  KOWD: 'Norwood', KPYM: 'Plymouth', KORH: 'Worcester', KHYA: 'Hyannis', KPVC: 'Provincetown', EGLL: 'London Heathrow', EDDF: 'Frankfurt', LFPG: 'Paris', EIDW: 'Dublin',
  KDFW: 'Dallas Fort Worth', KDEN: 'Denver', KSTL: 'St. Louis', KIAH: 'Houston', KSFO: 'San Francisco', KSEA: 'Seattle',
  KSLC: 'Salt Lake City', KLOM: 'Wings Field', KMQS: 'Coatesville', KOQN: 'Brandywine', KDYL: 'Doylestown', KPTW: 'Heritage Field',
  EHAM: 'Amsterdam', LEMD: 'Madrid', OMDB: 'Dubai',
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

/** How a pilot names another aircraft in a readback: "Cessna" for a GA registration with a type word, else the whole spoken callsign ("Spirit four fifty one"). */
export function spokenTrafficLabel(a: { callsign: string; spokenCallsign: string }): string {
  const first = gaPrefixWords(a.spokenCallsign);
  return /^N\d/i.test(a.callsign) && first.toLowerCase() !== 'november' && first !== '' && first !== a.spokenCallsign ? first : a.spokenCallsign;
}

/** The type words in front of a registration's digits in a spoken GA callsign: "Cessna seven two three echo juliet" -> "Cessna", "King Air four five ..." -> "King Air". */
export function gaPrefixWords(spoken: string): string {
  const words = spoken.split(' ');
  const i = words.findIndex((w) => (ONES as readonly string[]).includes(w) || w === 'niner');
  return i > 0 ? words.slice(0, i).join(' ') : words[0] ?? '';
}
