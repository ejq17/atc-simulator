import { ChartViewer } from '../../charts';
import { Drawer } from './Drawer';

export function ChartsDrawer({ onClose, icao }: { onClose: () => void; icao: string }) {
  return (
    <Drawer title={`FAA charts · ${icao}`} onClose={onClose} side="center" width="min(1280px,96vw)" testId="charts-drawer">
      <div className="h-full min-h-[480px]">
        <ChartViewer icao={icao} />
      </div>
    </Drawer>
  );
}
