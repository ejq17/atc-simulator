import {
  acceptsRunway, applyRunway, lacksRunway, type Draft, type Element,
} from './draft';

export interface PlacedDraft { draft: Draft; start: number; end: number }

export interface Assembly {
  drafts: PlacedDraft[];
  /** consumed[i] is true when token i belongs to a recognised element. */
  consumed: boolean[];
}

/**
 * Turn raw scan elements into commands:
 *  1. positional "runway N" elements attach to the NEXT runway-taking instruction
 *     that still lacks a runway ("runway 13, cleared for takeoff"), else to the
 *     previous one ("line up and wait, runway 13"). A different runway on an
 *     instruction that already has one is a conflict, never an overwrite.
 *  2. a positional "via A B" attaches to the previous (else next) taxi/cross
 *     instruction that has no route yet.
 *  3. adjacent identical instructions collapse ("go around, go around").
 */
export function assemble(elements: Element[], tokenCount: number, preConsumed: readonly boolean[]): Assembly {
  const consumed = Array.from({ length: tokenCount }, (_, i) => preConsumed[i] === true);
  const mark = (e: Element) => { for (let i = e.start; i < e.end; i++) consumed[i] = true; };
  let drafts: PlacedDraft[] = [];
  for (const e of elements) {
    if (e.body.type === 'cmd') drafts.push({ draft: e.body.draft, start: e.start, end: e.end });
    if (e.body.type !== 'runway' && e.body.type !== 'route') mark(e);
  }
  const taking = (p: PlacedDraft) => acceptsRunway(p.draft);

  for (const e of elements) {
    if (e.body.type !== 'runway') continue;
    const next = drafts.find((p) => p.start >= e.end && taking(p));
    const prev = [...drafts].reverse().find((p) => p.end <= e.start && taking(p));
    const parse = e.body.parse;
    const target = next ?? prev;
    if (!target) continue; // stays unconsumed: reported as unrecognised
    mark(e);
    if (!parse.ok) {
      target.draft.issues.push(parse.reason);
      target.draft.unknownIds++;
      continue;
    }
    const slot = next && lacksRunway(next.draft) ? next : prev && lacksRunway(prev.draft) ? prev : null;
    if (slot) { applyRunway(slot.draft, parse.ref); continue; }
    const existing = target.draft.fields.runwayEnd;
    if (existing && existing !== parse.ref.end) {
      target.draft.conflicts++;
      target.draft.issues.push(`conflicting runways: ${existing} and ${parse.ref.end}`);
    }
  }

  for (const e of elements) {
    if (e.body.type !== 'route') continue;
    const routed = (p: PlacedDraft) => ['TAXI', 'TAXI_TO_PARKING', 'CROSS_RUNWAY'].includes(p.draft.kind);
    const prev = [...drafts].reverse().find((p) => p.end <= e.start && routed(p));
    const next = drafts.find((p) => p.start >= e.end && routed(p));
    const target = prev && !prev.draft.fields.route?.length ? prev : next && !next.draft.fields.route?.length ? next : null;
    if (!target) continue;
    target.draft.fields.route = e.body.ids;
    mark(e);
  }

  // Wind / altimeter spoken with another instruction ("wind 130 at 8, runway 13, cleared for takeoff") is information for that
  // instruction (3-9-1 / 3-10-1), not a command of its own; a transmission of information alone keeps its AIRPORT_INFO command.
  if (drafts.some((p) => p.draft.kind !== 'AIRPORT_INFO')) {
    const carriers = drafts.filter((p) => p.draft.kind !== 'AIRPORT_INFO');
    for (const p of drafts) {
      if (p.draft.kind !== 'AIRPORT_INFO') continue;
      const carrier = carriers.find((c) => c.start >= p.end) ?? [...carriers].reverse().find((c) => c.end <= p.start);
      if (!carrier) continue;
      carrier.draft.fields.info = { ...carrier.draft.fields.info, ...p.draft.fields.info };
      carrier.draft.issues.push(...p.draft.issues);
    }
    drafts = carriers;
  }

  drafts = drafts.filter((p, k) => {
    const before = drafts[k - 1];
    return !(before && before.draft.kind === p.draft.kind
      && JSON.stringify(before.draft.fields) === JSON.stringify(p.draft.fields));
  });
  // "taxi to runway 4 <words the grammar could not read>, hold short of runway 4": the hold short belongs to the taxi instruction (3-7-2), which is
  // read back once. (When the route is understood the taxi rule takes the hold short itself.)
  const merged: PlacedDraft[] = [];
  for (const p of drafts) {
    const prev = merged[merged.length - 1];
    const hold = p.draft.fields.holdShort;
    if (prev && p.draft.kind === 'HOLD_SHORT' && hold?.length && !p.draft.unknownIds && (prev.draft.kind === 'TAXI' || prev.draft.kind === 'TAXI_TO_PARKING') && !prev.draft.fields.segment) {
      prev.draft.fields.holdShort = [...new Set([...(prev.draft.fields.holdShort ?? []), ...hold])];
      prev.draft.issues.push(...p.draft.issues);
      prev.draft.nonstandard += p.draft.nonstandard;
      prev.end = p.end;
      continue;
    }
    // Departure instruction with the takeoff clearance (JO 7110.65 5-8-2: the heading, with its turn direction, is issued with the clearance and
    // flown after takeoff): "fly heading one eight zero, runway one three, cleared for takeoff", "turn left heading two seven zero, cleared for
    // takeoff runway 13" and "cleared for takeoff runway 13, turn right heading zero niner zero" are ONE TAKEOFF command with `departureHeading`
    // (a separate HEADING would be refused on the ground), read back once. "fly runway heading" adds nothing: the takeoff already follows it.
    const hdg = (d: PlacedDraft | undefined) => d && d.draft.kind === 'HEADING' && !d.draft.unknownIds ? d : undefined;
    const before = hdg(prev);
    if (before && p.draft.kind === 'TAKEOFF' && (before.draft.fields.destination === 'RUNWAY_HEADING' || before.draft.fields.headingDeg !== undefined)) {
      merged.pop();
      p.start = Math.min(p.start, before.start);
      p.draft.issues.push(...before.draft.issues);
      p.draft.nonstandard += before.draft.nonstandard;
      if (before.draft.fields.headingDeg !== undefined) {
        p.draft.fields.departureHeading = before.draft.fields.headingDeg;
        if (before.draft.fields.turnDirection) p.draft.fields.turnDirection = before.draft.fields.turnDirection;
      }
    }
    const after = hdg(p);
    if (after && prev && prev.draft.kind === 'TAKEOFF' && prev.draft.fields.departureHeading === undefined
      && (after.draft.fields.destination === 'RUNWAY_HEADING' || after.draft.fields.headingDeg !== undefined)) {
      if (after.draft.fields.headingDeg !== undefined) {
        prev.draft.fields.departureHeading = after.draft.fields.headingDeg;
        if (after.draft.fields.turnDirection) prev.draft.fields.turnDirection = after.draft.fields.turnDirection;
      }
      prev.draft.issues.push(...after.draft.issues);
      prev.draft.nonstandard += after.draft.nonstandard;
      prev.end = p.end;
      continue;
    }
    merged.push(p);
  }
  return { drafts: merged, consumed };
}
