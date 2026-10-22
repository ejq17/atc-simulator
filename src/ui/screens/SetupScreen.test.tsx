// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const fetchLiveMetar = vi.fn((_icao: string) => new Promise<never>(() => undefined));
vi.mock('../../weather/liveWeather', () => ({ fetchLiveMetar: (icao: string) => fetchLiveMetar(icao) }));

import { SetupScreen } from './SetupScreen';
import { useSimStore } from '../store/simStore';
import type { StartOptions } from '../store/simStore';

afterEach(() => {
  cleanup();
  useSimStore.setState({ startOptions: undefined });
  fetchLiveMetar.mockClear();
});

describe('<SetupScreen /> airport selector', () => {
  it('defaults to KACY and offers KMHT and KPGD', () => {
    render(<SetupScreen />);
    const select = screen.getByTestId('airport-select') as HTMLSelectElement;
    expect(select.value).toBe('KACY');
    expect([...select.options].map((o) => o.value)).toEqual(['KACY', 'KMHT', 'KPGD']);
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

describe('<SetupScreen /> KPGD', () => {
  it('switching to KPGD re-labels the screen, fetches the KPGD METAR and lists the Punta Gorda tower frequency', () => {
    render(<SetupScreen />);
    fireEvent.change(screen.getByTestId('airport-select'), { target: { value: 'KPGD' } });
    expect(screen.getByText('KPGD ATC Simulator')).toBeInTheDocument();
    expect(fetchLiveMetar).toHaveBeenLastCalledWith('KPGD');
    expect(screen.getByText('Live KPGD METAR')).toBeInTheDocument();
    expect(screen.getAllByText(/121\.0/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Atlantic City/).filter((el) => el.tagName !== 'OPTION')).toEqual([]);
  });
});

describe('<SetupScreen /> closure options', () => {
  it('offers to close a runway or a taxiway for the session; the recommended runway skips the closed one and the airport changes the lists', () => {
    render(<SetupScreen />);
    const rwy = screen.getByTestId('close-runway') as HTMLSelectElement;
    const twy = screen.getByTestId('close-taxiway') as HTMLSelectElement;
    expect([...rwy.options].map((o) => o.value)).toEqual(['none', '4/22', '13/31']);
    expect([...twy.options].map((o) => o.value)).toEqual(expect.arrayContaining(['none', 'A', 'B', 'C']));
    expect(screen.getByTestId('airport-events')).toBeChecked();
    fireEvent.change(rwy, { target: { value: '13/31' } });
    const landing = screen.getByLabelText('Landing runway') as HTMLSelectElement;
    expect(landing.value).toBe('auto');
    expect(landing.options[0].textContent).toMatch(/Auto · (4|22)$/);
    expect([...landing.options].filter((o) => o.disabled).map((o) => o.value).sort()).toEqual(['13', '31']);
    fireEvent.change(screen.getByTestId('airport-select'), { target: { value: 'KMHT' } });
    expect((screen.getByTestId('close-runway') as HTMLSelectElement).value).toBe('none');
    expect([...(screen.getByTestId('close-runway') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['none', '6/24', '17/35']);
  });
});

describe('<SetupScreen /> special traffic', () => {
  const KINDS = ['helicopter', 'military', 'transition', 'training', 'vehicles'] as const;
  /** Replace the store's startSession (before the screen renders, it reads it then); `pressStart` clicks Start and returns the options passed. */
  const mockStart = () => {
    const start = vi.fn((_o: StartOptions) => Promise.resolve(true));
    useSimStore.setState({ startSession: start });
    return () => {
      fireEvent.click(screen.getByTestId('start-session'));
      expect(start).toHaveBeenCalledTimes(1);
      return start.mock.calls[0][0];
    };
  };

  it('KACY offers all five kinds, checked by default, with their labels and hints', () => {
    render(<SetupScreen />);
    for (const k of KINDS) expect(screen.getByTestId(`special-${k}`)).toBeChecked();
    const group = screen.getByTestId('special-traffic');
    expect(group).toHaveAttribute('role', 'group');
    expect(group).toHaveTextContent('Special traffic');
    expect(group).toHaveTextContent('Coast Guard helicopters');
    expect(group).toHaveTextContent('Air National Guard fighters');
    expect(screen.getByLabelText(/Airport vehicles/)).toBe(screen.getByTestId('special-vehicles'));
  });

  it('KMHT offers only VFR transitions and vehicles, and switching airports resets to the defaults of the new airport', () => {
    render(<SetupScreen />);
    fireEvent.click(screen.getByTestId('special-training'));
    expect(screen.getByTestId('special-training')).not.toBeChecked();
    fireEvent.change(screen.getByTestId('airport-select'), { target: { value: 'KMHT' } });
    expect(screen.getByTestId('special-transition')).toBeChecked();
    expect(screen.getByTestId('special-vehicles')).toBeChecked();
    for (const k of ['helicopter', 'military', 'training']) expect(screen.queryByTestId(`special-${k}`)).toBeNull();
    fireEvent.change(screen.getByTestId('airport-select'), { target: { value: 'KACY' } });
    expect(screen.getByTestId('special-training')).toBeChecked();
  });

  it('passes the checkboxes as freePlay.specialTraffic when the session starts', () => {
    let pressStart = mockStart();
    render(<SetupScreen />);
    expect(pressStart().freePlay.specialTraffic).toEqual({ helicopter: true, military: true, transition: true, training: true, vehicles: true });
    cleanup();
    pressStart = mockStart();
    render(<SetupScreen />);
    fireEvent.click(screen.getByTestId('special-military'));
    fireEvent.click(screen.getByTestId('special-vehicles'));
    expect(screen.getByTestId('special-military')).not.toBeChecked();
    expect(pressStart().freePlay.specialTraffic).toEqual({ helicopter: true, military: false, transition: true, training: true, vehicles: false });
  });

  it('at KMHT only the offered kinds can be on', () => {
    const pressStart = mockStart();
    render(<SetupScreen />);
    fireEvent.change(screen.getByTestId('airport-select'), { target: { value: 'KMHT' } });
    fireEvent.click(screen.getByTestId('special-transition'));
    expect(pressStart().freePlay.specialTraffic).toEqual({ helicopter: false, military: false, transition: false, training: false, vehicles: true });
  });

  it('starts from the previous setup when the screen is opened again', () => {
    useSimStore.setState({
      startOptions: {
        icao: 'KACY', mode: 'free_play', freePlay: { specialTraffic: { helicopter: false, military: true, transition: false, training: true, vehicles: false } },
        weather: { kind: 'preset', id: 'clear' }, controller: 'TWR', ai: true, realTime: true, runways: 'auto',
      } as StartOptions,
    });
    render(<SetupScreen />);
    expect(screen.getByTestId('special-helicopter')).not.toBeChecked();
    expect(screen.getByTestId('special-military')).toBeChecked();
    expect(screen.getByTestId('special-training')).toBeChecked();
    expect(screen.getByTestId('special-vehicles')).not.toBeChecked();
  });
});
