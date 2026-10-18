import { NavaidPanel } from '../../charts';
import { useSimStore } from '../store/simStore';
import { Drawer } from './Drawer';

export function NavaidsPanel() {
  const icao = useSimStore((s) => s.session?.engine.getState().airport.icao ?? 'KACY');
  return <NavaidPanel className="h-full flex-1" icao={icao} />;
}

export function NavaidsDrawer({ onClose, icao }: { onClose: () => void; icao: string }) {
  return (
    <Drawer title="Navaids and fixes" onClose={onClose} width="min(760px,96vw)" testId="navaids-drawer" panel="navaids">
      <NavaidPanel className="h-full" icao={icao} />
    </Drawer>
  );
}
