/**
 * Where a draggable chat bubble may go, how its spot is remembered, and where its chat window opens. Pure functions
 * of sizes and points (no DOM), so they can be tested on their own.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The corner side the business chose for the bubble: where it starts. */
export type Side = 'right' | 'left';

/** The bubble stays this far inside the window's edges. */
export const EDGE_MARGIN = 8;
/** Between the bubble and its chat window (the window sits 72px from the root: the 56px bubble plus this). */
const GAP = 16;
const PANEL = { width: 380, maxHeight: 640, minHeight: 200 };

/** A press becomes a drag only after moving this far, so clicks and taps (a finger wobbles more) still open the chat. */
export function isDrag(dx: number, dy: number, pointerType: string): boolean {
  const threshold = pointerType === 'touch' ? 10 : 6;
  return dx * dx + dy * dy >= threshold * threshold;
}

/** The bubble's top-left corner, kept fully on screen. */
export function clamp(p: Point, bubble: Size, viewport: Size): Point {
  const maxX = Math.max(EDGE_MARGIN, viewport.width - bubble.width - EDGE_MARGIN);
  const maxY = Math.max(EDGE_MARGIN, viewport.height - bubble.height - EDGE_MARGIN);
  return { x: Math.min(Math.max(p.x, EDGE_MARGIN), maxX), y: Math.min(Math.max(p.y, EDGE_MARGIN), maxY) };
}

/**
 * A remembered spot: where the bubble sits within the room it can move in, from 0 (the left or top edge) to 1 (the
 * right or bottom edge), so a corner stays a corner on another screen size. `base` is the starting side it was saved
 * against: when the business changes that, the spot no longer applies.
 */
export interface SavedPosition {
  fx: number;
  fy: number;
  base: Side;
}

const room = (bubble: Size, viewport: Size) => ({
  x: Math.max(0, viewport.width - bubble.width - 2 * EDGE_MARGIN),
  y: Math.max(0, viewport.height - bubble.height - 2 * EDGE_MARGIN),
});
const fraction = (offset: number, space: number) => (space > 0 ? Math.round(Math.min(1, Math.max(0, offset / space)) * 10_000) / 10_000 : 0);

export function toSaved(p: Point, bubble: Size, viewport: Size, base: Side): SavedPosition {
  const r = room(bubble, viewport);
  return { fx: fraction(p.x - EDGE_MARGIN, r.x), fy: fraction(p.y - EDGE_MARGIN, r.y), base };
}

export function fromSaved(saved: SavedPosition, bubble: Size, viewport: Size): Point {
  const r = room(bubble, viewport);
  return clamp({ x: EDGE_MARGIN + saved.fx * r.x, y: EDGE_MARGIN + saved.fy * r.y }, bubble, viewport);
}

/** What was stored, if it's a spot saved against this starting side; anything else (corrupt, out of range) is ignored. */
export function parseSaved(raw: string | null, base: Side): SavedPosition | null {
  try {
    const v = JSON.parse(raw ?? 'null') as Partial<SavedPosition> | null;
    const unit = (n: unknown): n is number => typeof n === 'number' && n >= 0 && n <= 1;
    return v && unit(v.fx) && unit(v.fy) && v.base === base ? { fx: v.fx, fy: v.fy, base } : null;
  } catch {
    return null;
  }
}

/** Where the chat window opens beside a moved bubble. */
export interface Placement {
  /** Below the bubble when it's in the top half of the screen, else above. */
  below: boolean;
  /** The window's left edge relative to the bubble's, chosen to keep the window on screen. */
  panelX: number;
  /** As tall as the room on that side allows, up to the usual height. */
  height: number;
}

export function placement(p: Point, bubble: Size, viewport: Size): Placement {
  const below = p.y + bubble.height / 2 < viewport.height / 2;
  const space = below ? viewport.height - (p.y + bubble.height) - GAP - EDGE_MARGIN : p.y - GAP - EDGE_MARGIN;
  // Lined up with the bubble's outer edge, on the side with more room, then kept on screen.
  const preferred = p.x + bubble.width / 2 < viewport.width / 2 ? p.x : p.x + bubble.width - PANEL.width;
  const left = Math.max(EDGE_MARGIN, Math.min(preferred, viewport.width - PANEL.width - EDGE_MARGIN));
  return { below, panelX: left - p.x, height: Math.min(PANEL.maxHeight, Math.max(PANEL.minHeight, space)) };
}
