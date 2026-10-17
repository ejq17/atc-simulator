import { cmdHit, fillerHit, makeDraft, type Rule } from './draft';
import { parseRunway, parseTaxiways } from './entities';
import { FACILITIES, FILLERS } from './lexicon';
import { intAt, isOneOf, seq, skipWords, txt } from './match';

const COMM_MIN_MHZ = 108;
const COMM_MAX_MHZ = 137;

/** "contact ground point niner", "monitor tower 120.3", "change to my frequency" */
export const ruleContact: Rule = (t, i) => {
  let j = seq(t, i, 'contact|monitor|call');
  const strong = j >= 0 && txt(t, i) !== 'call';
  if (j < 0) j = seq(t, i, 'switch|change|go to');
  if (j < 0) return null;
  j = skipWords(t, j, ['atlantic', 'city', 'the', 'on', 'frequency']);
  const d = makeDraft('CONTACT_FREQUENCY');
  const mine = seq(t, j, 'my frequency');
  if (mine >= 0) {
    d.fields.destination = 'MY_FREQUENCY';
    return cmdHit(mine, d);
  }
  const facility = FACILITIES.get(txt(t, j));
  let gotObject = false;
  if (facility) { d.fields.frequencyId = facility; gotObject = true; j++; }
  j = skipWords(t, j, ['on', 'frequency', 'the', 'delivery']);
  const tok = txt(t, j);
  if (/^\d{3}\.\d{1,3}$/.test(tok)) {
    const mhz = Number(tok);
    if (mhz >= COMM_MIN_MHZ && mhz <= COMM_MAX_MHZ) d.fields.frequencyMhz = mhz;
    else d.issues.push(`frequency ${tok} outside the VHF comm band`);
    gotObject = true;
    j++;
  } else if (/^\.\d{1,3}$/.test(tok)) {
    gotObject = true;
    j++; // partial frequency ("point niner"): decimal part only, left undefined on purpose
  }
  if (!strong && !gotObject) return null;
  return cmdHit(j, d);
};

export const ruleSayAgain: Rule = (t, i) => {
  let j = seq(t, i, 'say that? again');
  if (j < 0) j = seq(t, i, 'repeat');
  if (j < 0) j = seq(t, i, 'come again');
  if (j < 0) return null;
  return cmdHit(skipWords(t, j, ['please', 'callsign']), makeDraft('SAY_AGAIN'));
};

/** "wind calm", "wind two one zero at eight [gusts 15]" -> information only */
export const ruleWind: Rule = (t, i) => {
  if (!isOneOf(t, i, ['wind', 'winds'])) return null;
  if (seq(t, i + 1, 'calm') >= 0) return fillerHit(i + 2);
  if (intAt(t, i + 1) === null) return null;
  let j = i + 2;
  const at = seq(t, j, 'at');
  if (at >= 0 && intAt(t, at) !== null) {
    j = at + 1;
    const g = seq(t, j, 'gust|gusts|gusting');
    if (g >= 0 && intAt(t, g) !== null) j = g + 1;
  }
  return fillerHit(j);
};

const UNSUPPORTED = new Set(['squawk', 'ident']);

/** Instructions that exist in ATC but are not simulated: flagged, never guessed. */
export const ruleUnsupported: Rule = (t, i) => {
  const w = txt(t, i);
  const flag = (what: string, end: number) => {
    const d = makeDraft('UNKNOWN');
    d.issues.push(`unsupported instruction: ${what}`);
    return cmdHit(end, d);
  };
  if (UNSUPPORTED.has(w)) return flag(w, intAt(t, i + 1) !== null ? i + 2 : i + 1);
  if (w === 'cleared' || w === 'clear') {
    for (let k = i + 1; k <= i + 4; k++) if (txt(t, k) === 'approach') return flag('approach clearance', k + 1);
  }
  return null;
};

/** A bare "runway N" that no instruction claimed yet; the assembler attaches it. */
export const ruleRunwayRef: Rule = (t, i) => {
  const r = parseRunway(t, i);
  return r ? { end: r.next, body: { type: 'runway', parse: r } } : null;
};

/** A bare "via alpha bravo" that no taxi instruction claimed; the assembler attaches it. */
export const ruleRoute: Rule = (t, i) => {
  if (!isOneOf(t, i, ['via', 'taxiway', 'taxiways'])) return null;
  const tw = parseTaxiways(t, i);
  return tw.ids.length ? { end: tw.next, body: { type: 'route', ids: tw.ids } } : null;
};

export const ruleFiller: Rule = (t, i) => (FILLERS.has(txt(t, i)) ? fillerHit(i + 1) : null);
