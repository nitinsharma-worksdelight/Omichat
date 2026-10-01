import { Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { cx } from './ui';

type Theme = 'light' | 'dark';

const KEY = 'omni:theme';
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)');

/** The theme someone picked in this browser, or null to follow the device. */
function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function resolvedTheme(): Theme {
  return storedTheme() ?? (systemDark().matches ? 'dark' : 'light');
}

/** The tokens in index.css switch on `data-theme`; `color-scheme` keeps native controls (date pickers, scrollbars) in step. */
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
}

// index.html sets the theme before the first paint; this covers a page that loads without that script.
if (!document.documentElement.dataset.theme) applyTheme(resolvedTheme());

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  const list = systemDark();
  // With no choice stored, follow the device when its setting changes.
  const onSystemChange = () => {
    if (storedTheme()) return;
    applyTheme(resolvedTheme());
    listener();
  };
  list.addEventListener('change', onSystemChange);
  return () => {
    listeners.delete(listener);
    list.removeEventListener('change', onSystemChange);
  };
}

const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, currentTheme);
  const setTheme = (next: Theme) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Storage blocked: the choice lasts for this visit.
    }
    applyTheme(next);
    listeners.forEach((listener) => listener());
  };
  return [theme, setTheme];
}

/** The "Dark mode" switch in the main menu: a full row with a switch, or an icon when the menu is collapsed. */
export function ThemeToggle({ compact }: { compact: boolean }) {
  const [theme, setTheme] = useTheme();
  const dark = theme === 'dark';
  const toggle = () => setTheme(dark ? 'light' : 'dark');
  if (compact) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={dark}
        aria-label="Dark mode"
        title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        onClick={toggle}
        className="mx-auto flex size-10 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
      >
        {dark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
      </button>
    );
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      onClick={toggle}
      className="flex h-8.5 w-full items-center gap-2.5 rounded-lg px-2.5 text-body-sm font-medium text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
    >
      {dark ? <Moon className="size-4 shrink-0" aria-hidden /> : <Sun className="size-4 shrink-0" aria-hidden />}
      <span className="flex-1 text-left">Dark mode</span>
      <span aria-hidden className={cx('relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors', dark ? 'bg-accent' : 'bg-faint')}>
        <span className={cx('inline-block size-3 rounded-full shadow-sm transition-transform', dark ? 'translate-x-3.5 bg-accent-fg' : 'translate-x-0.5 bg-white')} />
      </span>
    </button>
  );
}
