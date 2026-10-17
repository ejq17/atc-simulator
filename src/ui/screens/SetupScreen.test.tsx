// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const fetchLiveMetar = vi.fn((_icao: string) => new Promise<never>(() => undefined));
vi.mock('../../weather/liveWeather', () => ({ fetchLiveMetar: (icao: string) => fetchLiveMetar(icao) }));

import { SetupScreen } from './SetupScreen';

afterEach(() => {
  cleanup();
  fetchLiveMetar.mockClear();
});

describe('<SetupScreen /> airport selector', () => {
  it('defaults to KACY and offers KMHT', () => {
    render(<SetupScreen />);
    const select = screen.getByTestId('airport-select') as HTMLSelectElement;
    expect(select.value).toBe('KACY');
    expect([...select.options].map((o) => o.value)).toEqual(['KACY', 'KMHT']);
    expect(screen.getByText('KACY ATC Simulator')).toBeInTheDocument();
    expect(fetchLiveMetar).toHaveBeenCalledWith('KACY');
  });

  it('switching to KMHT re-labels the screen, fetches the KMHT METAR, lists its frequencies and hides the KACY-only lessons', () => {
    render(<SetupScreen />);
    fireEvent.change(screen.getByTestId('airport-select'), { target: { value: 'KMHT' } });
    expect(screen.getByText('KMHT ATC Simulator')).toBeInTheDocument();
    expect(screen.getByText(/Manchester Boston Regional · KMHT/)).toBeInTheDocument();
    expect(screen.getByText(/at Manchester with real FAA runway/)).toBeInTheDocument();
    expect(fetchLiveMetar).toHaveBeenLastCalledWith('KMHT');
    expect(screen.getByText('Live KMHT METAR')).toBeInTheDocument();
    expect(screen.getAllByText(/121\.3/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Atlantic City/).filter((el) => el.tagName !== 'OPTION')).toEqual([]);
    fireEvent.click(screen.getByTestId('mode-career'));
    expect(screen.getByTestId('no-scenarios')).toHaveTextContent(/written around KACY.*not offered at KMHT/);
    fireEvent.click(screen.getByTestId('mode-training'));
    expect(screen.getByTestId('no-scenarios')).toHaveTextContent(/training lessons are written around KACY/);
  });
});
