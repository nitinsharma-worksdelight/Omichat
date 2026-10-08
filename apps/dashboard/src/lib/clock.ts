/**
 * The server's clock as seen from this browser. Times on screen come from the server, so "5 minutes ago" is only right
 * when this browser's clock agrees with it; a computer a minute behind would show "in 1m" for something just created.
 * Every API response carries the server's time (`x-server-time`): the offset is worked out from the response that
 * took the shortest round trip, since that one tells it most precisely. No browser APIs here, so tests can use it.
 */

interface Sample {
  offset: number;
  roundTrip: number;
  at: number;
}

let best: Sample | null = null;
/** A measurement is kept this long, then the next response replaces it (clocks drift). */
const KEEP_MS = 10 * 60_000;

/**
 * One response: the server's time in it, and this browser's time just before the request went out and just after the
 * response arrived. The server stamped it somewhere between, so the middle is the best guess.
 */
export function noteServerTime(serverMs: number, sentAt: number, receivedAt: number): void {
  if (!Number.isFinite(serverMs) || receivedAt < sentAt) return;
  const sample: Sample = { offset: serverMs - (sentAt + receivedAt) / 2, roundTrip: receivedAt - sentAt, at: receivedAt };
  if (!best || sample.roundTrip <= best.roundTrip || sample.at - best.at > KEEP_MS) best = sample;
}

/** Milliseconds to add to this browser's clock to get the server's. */
export function clockOffset(): number {
  return best?.offset ?? 0;
}

/** The current time on the server's clock. */
export function serverNow(): number {
  return Date.now() + clockOffset();
}

/** Forgets what was measured (tests). */
export function resetClock(): void {
  best = null;
}
