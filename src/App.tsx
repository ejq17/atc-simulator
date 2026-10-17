import { useSimStore } from './ui/store/simStore';
import { SetupScreen } from './ui/screens/SetupScreen';
import { SimScreen } from './ui/screens/SimScreen';
import { DebriefScreen } from './ui/screens/DebriefScreen';
import './ui/ui.css';

/** setup -> sim -> debrief. All state lives in the sim store; this component only routes. */
export default function App() {
  const screen = useSimStore((s) => s.screen);
  return (
    <div className="h-full w-full bg-atc-bg text-atc-text">
      {screen === 'setup' && <SetupScreen />}
      {screen === 'sim' && <SimScreen />}
      {screen === 'debrief' && <DebriefScreen />}
    </div>
  );
}
