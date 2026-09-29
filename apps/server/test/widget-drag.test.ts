import { describe, expect, it } from 'vitest';
import { clamp, EDGE_MARGIN, fromSaved, isDrag, parseSaved, placement, toSaved } from '../../widget/src/drag';

/**
 * The draggable chat bubble's rules. They live in the widget without any DOM access, so they're tested here with
 * the rest of the suite.
 */

const bubble = { width: 56, height: 56 };
const desktop = { width: 1280, height: 800 };
const phone = { width: 390, height: 844 };
const PANEL_WIDTH = 380;

describe('dragging the chat bubble', () => {
  it('a tap or a small wobble stays a click; a real move is a drag', () => {
    expect(isDrag(3, 4, 'mouse')).toBe(false);
    expect(isDrag(6, 0, 'mouse')).toBe(true);
    // Fingers wobble more than a mouse.
    expect(isDrag(6, 6, 'touch')).toBe(false);
    expect(isDrag(0, 10, 'touch')).toBe(true);
  });

  it('can go anywhere on screen, all four corners included, but never off it', () => {
    const maxX = desktop.width - bubble.width - EDGE_MARGIN;
    const maxY = desktop.height - bubble.height - EDGE_MARGIN;
    expect(clamp({ x: -50, y: -50 }, bubble, desktop)).toEqual({ x: EDGE_MARGIN, y: EDGE_MARGIN });
    expect(clamp({ x: 5000, y: -5 }, bubble, desktop)).toEqual({ x: maxX, y: EDGE_MARGIN });
    expect(clamp({ x: -1, y: 5000 }, bubble, desktop)).toEqual({ x: EDGE_MARGIN, y: maxY });
    expect(clamp({ x: 5000, y: 5000 }, bubble, desktop)).toEqual({ x: maxX, y: maxY });
    expect(clamp({ x: 600, y: 300 }, bubble, desktop)).toEqual({ x: 600, y: 300 });
  });

  it('keeps its place relative to the screen: a corner stays a corner after resizing or rotating', () => {
    const corner = clamp({ x: 5000, y: 5000 }, bubble, desktop);
    const saved = toSaved(corner, bubble, desktop, 'right');
    expect(saved).toEqual({ fx: 1, fy: 1, base: 'right' });
    expect(fromSaved(saved, bubble, phone)).toEqual({ x: phone.width - bubble.width - EDGE_MARGIN, y: phone.height - bubble.height - EDGE_MARGIN });

    const middleTop = { x: EDGE_MARGIN + (desktop.width - bubble.width - 2 * EDGE_MARGIN) / 2, y: EDGE_MARGIN };
    expect(toSaved(middleTop, bubble, desktop, 'left')).toEqual({ fx: 0.5, fy: 0, base: 'left' });
  });

  it('ignores a saved spot that is corrupt, out of range, or from another starting side', () => {
    const saved = JSON.stringify({ fx: 0.25, fy: 0.75, base: 'right' });
    expect(parseSaved(saved, 'right')).toEqual({ fx: 0.25, fy: 0.75, base: 'right' });
    // The business changed the bubble's starting side since.
    expect(parseSaved(saved, 'left')).toBeNull();
    expect(parseSaved('{not json', 'right')).toBeNull();
    expect(parseSaved(JSON.stringify({ fx: 2, fy: 0.5, base: 'right' }), 'right')).toBeNull();
    expect(parseSaved(JSON.stringify({ fx: '0.5', fy: 0.5, base: 'right' }), 'right')).toBeNull();
    expect(parseSaved(null, 'right')).toBeNull();
  });

  it('opens the chat where there is room: below a bubble in the top half, and always on screen', () => {
    const topLeft = placement({ x: EDGE_MARGIN, y: EDGE_MARGIN }, bubble, desktop);
    expect(topLeft).toMatchObject({ below: true, panelX: 0 });

    const bottomRight = clamp({ x: 5000, y: 5000 }, bubble, desktop);
    const fromCorner = placement(bottomRight, bubble, desktop);
    expect(fromCorner.below).toBe(false);
    expect(bottomRight.x + fromCorner.panelX + PANEL_WIDTH).toBe(desktop.width - EDGE_MARGIN);

    // Near the middle of a small window: shifted to stay on screen, and only as tall as the room above.
    const small = { width: 600, height: 500 };
    const middle = { x: 250, y: 300 };
    const fromMiddle = placement(middle, bubble, small);
    expect(fromMiddle.below).toBe(false);
    expect(middle.x + fromMiddle.panelX).toBeGreaterThanOrEqual(EDGE_MARGIN);
    expect(middle.x + fromMiddle.panelX + PANEL_WIDTH).toBeLessThanOrEqual(small.width - EDGE_MARGIN);
    expect(fromMiddle.height).toBe(middle.y - 16 - EDGE_MARGIN);
  });
});
