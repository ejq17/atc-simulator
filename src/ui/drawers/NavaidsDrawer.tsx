import { NavaidPanel } from '../../charts';
import { Drawer } from './Drawer';

export function NavaidsDrawer({ onClose, icao }: { onClose: () => void; icao: string }) {
  return (
    <Drawer title="Navaids and fixes" onClose={onClose} width="min(760px,96vw)" testId="navaids-drawer">
      <NavaidPanel className="h-full" icao={icao} />
    </Drawer>
  );
}
