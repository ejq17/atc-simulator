import type { Draft } from './draft';

/** A taxi whose hold-short clause has no readable point is incomplete (never executed as a plain taxi). */
const unreadHoldShort = (d: Draft): string[] => (d.holdShortUnparsed ? ['missing hold short point (runway or taxiway)'] : []);

/** Entities each instruction needs before the engine can act on it. Returns issue strings. */
export function missingRequired(d: Draft): string[] {
  const f = d.fields;
  switch (d.kind) {
    case 'TAXI': return [
      ...(f.destination || f.route?.length ? [] : ['missing taxi destination or route']),
      ...unreadHoldShort(d),
    ];
    case 'TAXI_TO_PARKING': return [...(f.destination ? [] : ['missing parking destination']), ...unreadHoldShort(d)];
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
    case 'APPROACH': return [
      ...(f.approachType ? [] : ['missing approach type']),
      ...(f.runwayEnd ? [] : ['missing runway']),
    ];
    case 'HOLD_AT_FIX': return f.hold?.fix ? [] : ['missing holding fix'];
    case 'DIRECT_FIX': return f.fix ? [] : ['missing fix'];
    case 'STAR': return f.starName ? [] : ['missing arrival procedure name'];
    case 'ADVISORY': return f.advisory ? [] : ['missing advisory'];
    case 'RUNWAY_LIGHTS': return f.lightsDirection || f.lightStep !== undefined ? [] : ['missing light intensity (up, down or a step)'];
    case 'IFR_CLEARANCE': return f.ifr?.destination ? [] : ['missing destination airport'];
    case 'TRAFFIC_ADVISORY':
    case 'FOLLOW_TRAFFIC': return f.traffic ? [] : ['missing traffic description'];
    case 'SQUAWK': return f.squawk ? [] : ['missing squawk code'];
    case 'AIRPORT_INFO': return f.info && (f.info.calm || f.info.windDirDeg !== undefined || f.info.altimeterInHg !== undefined) ? [] : ['missing wind or altimeter'];
    default: return [];
  }
}
