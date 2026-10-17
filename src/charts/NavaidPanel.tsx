import { useMemo, useState } from 'react';
import { NAVAIDS, formatLatLon } from './navaidData';

export interface NavaidPanelProps {
  className?: string;
}

const TH = 'px-2 py-1 text-left text-[10px] font-normal uppercase tracking-wider text-atc-muted';
const TD = 'px-2 py-1 align-top text-xs';

function Section({ title, children, footer }: { title: string; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <section className="border border-atc-border bg-atc-panel">
      <h3 className="border-b border-atc-border bg-atc-panel-2 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-atc-cyan">{title}</h3>
      <div className="p-3">{children}</div>
      <p className="border-t border-atc-border px-3 py-1.5 text-[10px] leading-snug text-atc-muted">{footer}</p>
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const restricted = /RESTRICTED/i.test(status);
  const ok = /OPERATIONAL IFR/i.test(status);
  const cls = restricted
    ? 'border-atc-amber text-atc-amber'
    : ok
      ? 'border-atc-green-dim text-atc-green'
      : 'border-atc-red text-atc-red';
  return <span className={`inline-block rounded-sm border px-1.5 text-[10px] uppercase tracking-wider ${cls}`}>{status}</span>;
}

export function NavaidPanel({ className = '' }: NavaidPanelProps) {
  const { vortac, ils, nearby, fixes, provenance, runwaysWithoutIls, unverified } = NAVAIDS;
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const visibleFixes = useMemo(() => {
    const q = query.trim().toUpperCase();
    return fixes.filter((f) => (showAll || f.key) && (!q || f.id.includes(q) || f.roles.some((r) => r.procedure.toUpperCase().includes(q))));
  }, [fixes, showAll, query]);

  const noIls = runwaysWithoutIls.join(' and ');
  const src = `Source: ${provenance.sources[0]}. Retrieved ${provenance.retrieved}, FAA cycle ${provenance.cycle}.`;

  return (
    <div aria-label="Navigation aids reference" className={`flex flex-col gap-3 overflow-y-auto bg-atc-bg p-3 text-atc-text ${className}`}>
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold tracking-wide">KACY navigation aids</h2>
        <span className="text-[10px] text-atc-muted">Reference only - not for navigation</span>
      </div>

      <Section
        title="ACY VORTAC"
        footer={<>{src} Unusable sectors are quoted from the NASR remarks. VORTAC position vs ARP: {vortac.locationNote}</>}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-lg text-atc-green">{vortac.id}</span>
          <span>{vortac.name} {vortac.type}</span>
          <span className="text-atc-cyan">{vortac.freqMhz.toFixed(2)} MHz</span>
          <span>TACAN/DME ch {vortac.channel}</span>
          <StatusBadge status={vortac.status} />
        </div>
        <p className="mt-1 text-[11px] text-atc-muted">
          {formatLatLon(vortac.lat, vortac.lon)} - elev {vortac.elevFt} ft - mag var {vortac.magVar} ({vortac.magVarEpoch}) - hours {vortac.hours}
        </p>
        <div className="mt-2 border-l-2 border-atc-amber bg-atc-panel-2 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-atc-amber">Operational restricted - unusable sectors</div>
          <ul className="mt-1 space-y-1 text-[11px]">
            {vortac.remarks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      </Section>

      <Section
        title="ILS / localizers"
        footer={<>{src} Decision altitudes, RVR and TDZE are read from the d-TPP plates (not in NASR) by transcription - verify against the chart. {NAVAIDS.ilsNote}</>}
      >
        <div className="mb-2 border-l-2 border-atc-red bg-atc-panel-2 px-3 py-1.5 text-xs">
          No ILS or localizer on runway {noIls}. RNAV (GPS) and VOR approaches only.
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse">
            <thead>
              <tr className="border-b border-atc-border">
                <th className={TH}>Rwy</th><th className={TH}>Ident</th><th className={TH}>LOC MHz</th><th className={TH}>Course (mag)</th>
                <th className={TH}>GS</th><th className={TH}>DME</th><th className={TH}>Cat</th><th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {ils.map((s) => (
                <tr key={s.runway} className="border-b border-atc-border/50">
                  <td className={`${TD} text-atc-green`}>{s.runway}</td>
                  <td className={TD}>{s.plateIdent}</td>
                  <td className={`${TD} text-atc-cyan`}>{s.freqMhz.toFixed(1)}</td>
                  <td className={TD}>{s.frontCourseMag}&deg;</td>
                  <td className={TD}>{s.gsAngleDeg.toFixed(2)}&deg; / {s.gsFreqMhz}</td>
                  <td className={TD}>{s.dmeChannel}</td>
                  <td className={TD}>{s.category}</td>
                  <td className={TD}><StatusBadge status={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="mt-2 space-y-1 text-[11px] text-atc-muted">
          {ils.map((s) => (
            <li key={s.runway}>
              <span className="text-atc-text">RWY {s.runway}:</span> {s.minima} Approach lights: {s.approachLighting}. Plate TDZE {s.tdzePlateFt} ft.
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Nearby VOR / VORTAC / VOR-DME"
        footer={<>{src} Distance and bearing are computed here from the NASR coordinates (great circle, true bearing from the ACY VORTAC), not FAA-published.</>}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse">
            <thead>
              <tr className="border-b border-atc-border">
                <th className={TH}>Id</th><th className={TH}>Name</th><th className={TH}>Type</th><th className={TH}>MHz</th>
                <th className={TH}>Chan</th><th className={TH}>From ACY (computed)</th><th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {nearby.map((n) => (
                <tr key={n.id} className="border-b border-atc-border/50">
                  <td className={`${TD} text-atc-green`}>{n.id}</td>
                  <td className={TD}>{n.name}</td>
                  <td className={TD}>{n.type}</td>
                  <td className={`${TD} text-atc-cyan`}>{n.freqMhz}</td>
                  <td className={TD}>{n.channel}</td>
                  <td className={TD}>{n.distanceNmFromAcy.toFixed(0)} NM / {n.bearingTrueFromAcy.toFixed(0)}&deg;T</td>
                  <td className={TD}><StatusBadge status={n.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title={`Approach fixes (${showAll ? fixes.length : fixes.filter((f) => f.key).length} shown of ${fixes.length})`}
        footer={<>{src} Coordinates from NASR FIX data. Fix roles (IAF/IF/FAF/MAHF) were read from the d-TPP plates by a human transcription - spot-check against the chart before relying on them.</>}
      >
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-[#39c5e8]" />
            Show all charted fixes
          </label>
          <input
            type="search"
            aria-label="Filter fixes"
            placeholder="Filter by fix or procedure"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-48 flex-1 rounded-sm border border-atc-border bg-atc-bg px-2 py-1 text-xs text-atc-text placeholder:text-atc-muted focus:border-atc-cyan focus:outline-none"
          />
        </div>
        <div className="max-h-96 overflow-auto">
          <table className="w-full min-w-[34rem] border-collapse">
            <thead className="sticky top-0 bg-atc-panel">
              <tr className="border-b border-atc-border">
                <th className={TH}>Fix</th><th className={TH}>Position</th><th className={TH}>Roles on KACY plates</th>
              </tr>
            </thead>
            <tbody>
              {visibleFixes.map((f) => (
                <tr key={f.id} className="border-b border-atc-border/50">
                  <td className={`${TD} text-atc-green`}>{f.id}</td>
                  <td className={`${TD} whitespace-nowrap text-[11px] text-atc-muted`}>
                    {formatLatLon(f.lat, f.lon)}
                    {f.reference.length > 0 && <div>{f.reference.join(', ')}</div>}
                  </td>
                  <td className={TD}>
                    <ul className="space-y-0.5">
                      {f.roles.map((r) => (
                        <li key={r.procedure}><span className="text-atc-muted">{r.procedure}:</span> {r.role}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
              {visibleFixes.length === 0 && (
                <tr><td colSpan={3} className={`${TD} text-atc-muted`}>No fixes match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Not verified" footer="Listed so nothing here is mistaken for confirmed fact.">
        <ul className="list-disc space-y-1 pl-4 text-[11px] text-atc-muted">
          {unverified.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

export default NavaidPanel;
