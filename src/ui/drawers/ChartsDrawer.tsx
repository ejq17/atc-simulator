import { ChartViewer } from '../../charts';
import { useSimStore } from '../store/simStore';
import { Drawer } from './Drawer';

export function ChartsPanel() {
  const icao = useSimStore((s) => s.session?.engine.getState().airport.icao ?? 'KACY');
  return (
    <div className="h-full min-h-[300px] flex-1">
      <ChartViewer icao={icao} />
    </div>
  );
}

export function ChartsDrawer({ onClose, icao }: { onClose: () => void; icao: string }) {
  return (
    <Drawer title={`FAA charts · ${icao}`} onClose={onClose} side="center" width="min(1280px,96vw)" testId="charts-drawer" panel="charts">
      <div className="h-full min-h-[480px]">
        <ChartViewer icao={icao} />
      </div>
    </Drawer>
  );
}
