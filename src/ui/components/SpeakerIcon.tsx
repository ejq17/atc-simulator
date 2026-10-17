/** Speaker glyph for the Pilot audio switch: waves when on, a cross when muted, animated waves while a transmission is playing. */
export function SpeakerIcon({ on, speaking }: { on: boolean; speaking: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0" data-testid="speaker-icon" data-speaking={speaking ? 'true' : 'false'}>
      <path d="M2 6 H4.6 L8 3 V13 L4.6 10 H2 Z" fill="currentColor" />
      {on ? (
        <>
          <path d="M10 6 Q11.6 8 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" className={speaking ? 'atc-wave atc-wave-1' : ''} />
          <path d="M11.8 4.2 Q14.6 8 11.8 11.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" className={speaking ? 'atc-wave atc-wave-2' : ''} />
        </>
      ) : (
        <path d="M10.2 5.6 L14.4 10.4 M14.4 5.6 L10.2 10.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      )}
    </svg>
  );
}
