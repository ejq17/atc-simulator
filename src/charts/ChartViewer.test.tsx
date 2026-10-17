// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const destroy = vi.fn(async () => undefined);
const renderCancel = vi.fn();
const pdfPage = {
  getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
  render: vi.fn(() => ({ promise: new Promise<void>(() => undefined), cancel: renderCancel })),
};
const getDocument = vi.fn((_opts: unknown) => ({
  promise: Promise.resolve({ numPages: 2, getPage: async () => pdfPage, loadingTask: { destroy } }),
  destroy,
}));

vi.mock('pdfjs-dist', () => ({ getDocument: (o: unknown) => getDocument(o), GlobalWorkerOptions: {} }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/worker.mjs' }));

import { ChartViewer } from './ChartViewer';

const pdfBytes = () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), { status: 200, headers: { 'content-type': 'application/pdf' } });

describe('<ChartViewer />', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => pdfBytes()));
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders the chart list, the header with cycle dates and the official PDF link', async () => {
    render(<ChartViewer />);
    const list = screen.getByRole('listbox', { name: 'Charts' });
    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(19);
    expect(screen.getByRole('option', { name: 'ILS OR LOC/DME RWY 31' })).toBeInTheDocument();
    expect(screen.getByText('Approaches - Runway 13')).toBeInTheDocument();

    expect(screen.getByTestId('chart-title')).toHaveTextContent('AIRPORT DIAGRAM');
    expect(screen.getByTestId('chart-cycle')).toHaveTextContent('FAA d-TPP cycle 2610, effective 2026-10-01 to 2026-10-29');
    const link = screen.getByRole('link', { name: /Open official PDF/ });
    expect(link).toHaveAttribute('href', 'https://aeronav.faa.gov/d-tpp/2610/00669AD.PDF');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));

    // proxy first
    await waitFor(() => expect(getDocument).toHaveBeenCalled());
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      `/api/charts/pdf?url=${encodeURIComponent('https://aeronav.faa.gov/d-tpp/2610/00669AD.PDF')}`,
    );
    await waitFor(() => expect(screen.getByTestId('page-indicator')).toHaveTextContent('Page 1 / 2'));
  });

  it('switches charts with ArrowDown and destroys the previous document', async () => {
    render(<ChartViewer />);
    await waitFor(() => expect(screen.getByTestId('page-indicator')).toHaveTextContent('Page 1 / 2'));
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Charts' }), { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByTestId('chart-title')).toHaveTextContent('RNAV (GPS) RWY 04'));
    expect(destroy).toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Charts' }), { key: 'ArrowUp' });
    await waitFor(() => expect(screen.getByTestId('chart-title')).toHaveTextContent('AIRPORT DIAGRAM'));
  });

  it('zoom buttons change the zoom level within 25%-400%', async () => {
    render(<ChartViewer />);
    await waitFor(() => expect(screen.getByTestId('page-indicator')).toHaveTextContent('Page 1 / 2'));
    const zin = screen.getByRole('button', { name: 'Zoom in' });
    for (let i = 0; i < 20; i++) fireEvent.click(zin);
    expect(screen.getByTestId('zoom-level')).toHaveTextContent('400%');
    expect(zin).toBeDisabled();
    const zout = screen.getByRole('button', { name: 'Zoom out' });
    for (let i = 0; i < 30; i++) fireEvent.click(zout);
    expect(screen.getByTestId('zoom-level')).toHaveTextContent('25%');
    expect(zout).toBeDisabled();
  });

  it('shows the proxy-down explanation when neither proxy nor direct fetch works', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    render(<ChartViewer />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Chart could not be loaded');
    expect(alert).toHaveTextContent('npm run server');
    expect(alert).toHaveTextContent('CORS');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('falls back to the direct URL when the proxy fails', async () => {
    const f = vi.fn(async (url: string) => (url.startsWith('/api/charts') ? new Response('bad gateway', { status: 502 }) : pdfBytes()));
    vi.stubGlobal('fetch', f);
    render(<ChartViewer />);
    await waitFor(() => expect(getDocument).toHaveBeenCalled());
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      expect.stringContaining('/api/charts/pdf'),
      'https://aeronav.faa.gov/d-tpp/2610/00669AD.PDF',
    ]);
  });
});
