import { useEffect } from 'react';
import { useSimStore } from './ui/store/simStore';
import { SetupScreen } from './ui/screens/SetupScreen';
import { SimScreen } from './ui/screens/SimScreen';
import { DebriefScreen } from './ui/screens/DebriefScreen';
import './ui/ui.css';

/**
 * Keep the app exactly as tall as the VISIBLE area. dvh covers the browser toolbar on phones; the visual viewport also shrinks when the
 * on-screen keyboard opens (iOS keeps the layout viewport unchanged), so the typed-command box stays above the keyboard.
 */
function useVisibleHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const apply = () => {
      if (vv) root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
      if (window.scrollY !== 0) window.scrollTo(0, 0); // iOS scrolls the page to reveal a focused input; the app is a fixed-height shell
    };
    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('orientationchange', apply);
    return () => {
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('orientationchange', apply);
      root.style.removeProperty('--app-h');
    };
  }, []);
}

/** setup -> sim -> debrief. All state lives in the sim store; this component only routes. */
export default function App() {
  const screen = useSimStore((s) => s.screen);
  useVisibleHeight();
  return (
    <div className="atc-root w-full overflow-hidden bg-atc-bg text-atc-text" style={{ height: 'var(--app-h, 100dvh)' }}>
      {screen === 'setup' && <SetupScreen />}
      {screen === 'sim' && <SimScreen />}
      {screen === 'debrief' && <DebriefScreen />}
    </div>
  );
}
