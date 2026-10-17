// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NavaidPanel } from './NavaidPanel';

afterEach(cleanup);

describe('<NavaidPanel />', () => {
  it('shows the restricted VORTAC, both ILS idents, and the no-ILS note for 04/22', () => {
    render(<NavaidPanel />);
    expect(screen.getAllByText('OPERATIONAL RESTRICTED').length).toBeGreaterThan(0);
    expect(screen.getByText(/117\.15 MHz/)).toBeInTheDocument();
    expect(screen.getByText(/VOR UNUSBL/)).toBeInTheDocument();
    expect(screen.getByText('I-PVO')).toBeInTheDocument();
    expect(screen.getByText('I-ACY')).toBeInTheDocument();
    expect(screen.getByText(/No ILS or localizer on runway 04 and 22/)).toBeInTheDocument();
    for (const id of ['VCN', 'SIE', 'CYN']) expect(screen.getAllByText(id).length).toBeGreaterThan(0);
  });

  it('lists the five key fixes by default and all 36 on request, with provenance footers', () => {
    render(<NavaidPanel />);
    const fixTable = () => screen.getAllByRole('table')[2];
    expect(within(fixTable()).getAllByRole('row')).toHaveLength(1 + 5);
    fireEvent.click(screen.getByLabelText('Show all charted fixes'));
    expect(within(fixTable()).getAllByRole('row')).toHaveLength(1 + 36);
    expect(screen.getAllByText(/Retrieved 2026-10-16/).length).toBeGreaterThanOrEqual(4);
  });
});
