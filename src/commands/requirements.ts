import type { Draft } from './draft';

/** Entities each instruction needs before the engine can act on it. Returns issue strings. */
export function missingRequired(d: Draft): string[] {
  const f = d.fields;
  switch (d.kind) {
    case 'TAXI': return f.destination || f.route?.length ? [] : ['missing taxi destination or route'];
    case 'TAXI_TO_PARKING': return f.destination ? [] : ['missing parking destination'];
    case 'HOLD_SHORT': return f.holdShort?.length ? [] : ['missing hold short point (runway or taxiway)'];
    case 'CROSS_RUNWAY': return f.crossRunwayId ? [] : ['missing runway'];
    case 'LINE_UP_AND_WAIT':
    case 'TAKEOFF':
    case 'LAND': return f.runwayEnd ? [] : ['missing runway'];
    case 'CONTACT_FREQUENCY':
      return f.frequencyId || f.frequencyMhz !== undefined || f.destination ? [] : ['missing frequency or facility'];
    case 'HEADING': return f.headingDeg !== undefined || f.destination ? [] : ['missing heading'];
    case 'ALTITUDE': return f.altitudeFt !== undefined ? [] : ['missing altitude'];
    case 'SPEED': return f.speedKt !== undefined || f.destination ? [] : ['missing speed'];
    case 'ENTER_PATTERN': return f.patternLeg || f.destination ? [] : ['missing pattern leg'];
    default: return [];
  }
}
