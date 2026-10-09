import { X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx, IconButton } from './ui';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focus the first field on open, keep Tab inside, close on Escape, restore focus on close. */
export function useDialogBehaviour(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first =
      panel?.querySelector<HTMLElement>('[data-autofocus]') ??
      panel?.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])') ??
      panel;
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Only the top-most dialog reacts.
        const dialogs = document.querySelectorAll('[data-dialog-panel]');
        if (dialogs[dialogs.length - 1] === panelRef.current) {
          e.stopPropagation();
          closeRef.current();
        }
      } else if (e.key === 'Tab' && panelRef.current) {
        const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
        if (!items.length) return;
        const firstItem = items[0]!;
        const lastItem = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === firstItem) {
          e.preventDefault();
          lastItem.focus();
        } else if (!e.shiftKey && document.activeElement === lastItem) {
          e.preventDefault();
          firstItem.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open]);

  return panelRef;
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
}

const modalSizes = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl', '2xl': 'max-w-6xl' };

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }: ModalProps) {
  const panelRef = useDialogBehaviour(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-overlay p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        data-dialog-panel
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx('flex max-h-[84vh] w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-modal outline-none', modalSizes[size])}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-heading font-semibold text-fg">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-body-sm text-muted">{description}</p>}
          </div>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/60 px-6 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}

export function Drawer({ open, onClose, title, description, children, footer, width = 'max-w-2xl' }: DrawerProps) {
  const panelRef = useDialogBehaviour(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        data-dialog-panel
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx('flex h-full w-full flex-col border-l border-border bg-surface shadow-modal outline-none', width)}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-heading font-semibold text-fg">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-body-sm text-muted">{description}</p>}
          </div>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/60 px-6 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Gap between the trigger and the menu, and the least room kept from the screen's edges. */
const MENU_GAP = 6;
const SCREEN_MARGIN = 8;

/**
 * Small dropdown anchored to a trigger; closes on outside click and Escape.
 *
 * `portal`: the menu is drawn at page level (fixed, from the trigger's position) instead of inside its parent, so a
 * box that scrolls or clips (a table) can't cut it off. It opens below the trigger, or above when there's no room,
 * and closes when the page scrolls or resizes. Focus moves into it on open and back to the trigger on Escape; tabbing
 * out of it closes it (it sits at the end of the page, not next to its trigger).
 */
export function Popover({
  trigger,
  children,
  align = 'right',
  className,
  label,
  portal = false,
}: {
  trigger: (props: { open: boolean; toggle: () => void; id: string }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
  label?: string;
  portal?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const id = useId();
  const focusTrigger = () => ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && (ref.current?.contains(target) || panelRef.current?.contains(target));
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      if (portal) focusTrigger();
    };
    // A menu drawn at page level would drift away from its row: it closes instead (scrolling inside it is fine).
    const onScroll = (e: Event) => {
      if (!inside(e.target)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    if (portal) {
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onResize);
    }
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, portal]);

  // Placed once it has rendered: its height decides whether it fits below.
  useLayoutEffect(() => {
    if (!open || !portal) {
      setPlace(null);
      return;
    }
    const anchor = ref.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const height = panel.offsetHeight;
    const below = anchor.bottom + MENU_GAP;
    const above = anchor.top - MENU_GAP - height;
    const top = below + height > window.innerHeight - SCREEN_MARGIN && above >= SCREEN_MARGIN ? above : below;
    // `right` is measured from the page's edge without its scrollbar, as fixed positions are.
    const width = document.documentElement.clientWidth;
    setPlace(
      align === 'right' ? { top, right: Math.max(SCREEN_MARGIN, width - anchor.right) } : { top, left: Math.max(SCREEN_MARGIN, anchor.left) },
    );
  }, [open, portal, align]);

  // Into the menu once it's placed and visible (a hidden element can't take focus).
  useEffect(() => {
    if (portal && place) panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [portal, place]);

  const panelClass = cx('z-40 min-w-48 rounded-xl border border-border bg-surface p-1.5 shadow-pop', className);
  const items = children(() => setOpen(false));
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o), id })}
      {open &&
        (portal ? (
          createPortal(
            <div
              ref={panelRef}
              id={id}
              role="menu"
              aria-label={label}
              className={cx('fixed', panelClass)}
              style={place ? { top: place.top, left: place.left, right: place.right } : { top: 0, left: 0, visibility: 'hidden' }}
              onBlur={(e) => {
                // Only when focus moves to something else on the page: a click that focuses nothing (Safari doesn't
                // focus buttons) must not close it before the click lands.
                const to = e.relatedTarget;
                if (to instanceof Node && !panelRef.current?.contains(to) && !ref.current?.contains(to)) setOpen(false);
              }}
            >
              {items}
            </div>,
            document.body,
          )
        ) : (
          <div id={id} role="menu" aria-label={label} className={cx('absolute top-full mt-1.5', align === 'right' ? 'right-0' : 'left-0', panelClass)}>
            {items}
          </div>
        ))}
    </div>
  );
}

export function MenuItem({ children, onClick, icon, danger, disabled }: { children: ReactNode; onClick: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-body-sm transition-colors disabled:opacity-50',
        danger ? 'text-danger-text hover:bg-danger-soft' : 'text-fg hover:bg-surface-2',
      )}
    >
      {icon && <span className="text-muted">{icon}</span>}
      {children}
    </button>
  );
}
