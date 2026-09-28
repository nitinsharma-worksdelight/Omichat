import type { Slot } from './types';

/** Slots grouped by their calendar-local day ("YYYY-MM-DD"), in order. */
export function groupSlots(slots: Slot[]): Array<[string, Slot[]]> {
  const map = new Map<string, Slot[]>();
  for (const s of slots) {
    const day = s.local.slice(0, 10);
    const list = map.get(day) ?? [];
    list.push(s);
    map.set(day, list);
  }
  return [...map.entries()];
}
