import { ChartViewer } from '../../charts';
import { Drawer } from './Drawer';

export function ChartsDrawer({ onClose }: { onClose: () => void }) {
  return (
    <Drawer title="FAA charts · KACY" onClose={onClose} side="center" width="min(1280px,96vw)" testId="charts-drawer">
      <div className="h-full min-h-[480px]">
        <ChartViewer />
      </div>
    </Drawer>
  );
}
