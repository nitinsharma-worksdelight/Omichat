import { useEffect, useState } from 'react';
import { timezoneChoices } from './timezones';

export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function timezones(): string[] {
  try {
    return timezoneChoices(Intl.supportedValuesOf('timeZone'));
  } catch {
    return ['UTC'];
  }
}
