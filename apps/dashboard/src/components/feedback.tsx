import { Bell, CircleCheck, CircleX, Info, X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '../lib/api';
import { ConfirmContext, ToastContext, type ConfirmOptions, type ToastApi } from './feedback-context';
import { Modal } from './overlay';
import { Button, cx } from './ui';

type ToastKind = 'success' | 'error' | 'info' | 'notice';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, message: string, extra: Partial<ToastItem> = {}) => {
      const id = nextId.current++;
      setToasts((t) => [...t.slice(-3), { id, kind, message, ...extra }]);
      setTimeout(() => dismiss(id), kind === 'error' || kind === 'notice' ? 7000 : 4000);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      error: (e) => push('error', typeof e === 'string' ? e : errorMessage(e)),
      info: (m) => push('info', m),
      notify: (n) => push('notice', n.title, { body: n.body, actionLabel: n.actionLabel, onAction: n.onAction }),
    }),
    [push],
  );

  const [confirmState, setConfirmState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve })), []);
  const settle = (value: boolean) => {
    confirmState?.resolve(value);
    setConfirmState(null);
  };

  return (
    <ToastContext.Provider value={api}>
      <ConfirmContext.Provider value={confirm}>
        {children}
        <Modal
          open={Boolean(confirmState)}
          onClose={() => settle(false)}
          title={confirmState?.title ?? ''}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => settle(false)}>
                Cancel
              </Button>
              <Button variant={confirmState?.danger ? 'danger' : 'primary'} onClick={() => settle(true)} data-autofocus>
                {confirmState?.confirmLabel ?? 'Confirm'}
              </Button>
            </>
          }
        >
          <div className="text-body text-fg-2">{confirmState?.message}</div>
        </Modal>
        <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              role={t.kind === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-body-sm shadow-pop"
            >
              {t.kind === 'success' ? (
                <CircleCheck className="mt-px size-4 shrink-0 text-success" aria-hidden />
              ) : t.kind === 'error' ? (
                <CircleX className="mt-px size-4 shrink-0 text-danger" aria-hidden />
              ) : t.kind === 'notice' ? (
                <Bell className="mt-px size-4 shrink-0 text-accent" aria-hidden />
              ) : (
                <Info className="mt-px size-4 shrink-0 text-accent" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className={cx('break-words text-fg', t.kind === 'notice' && 'font-medium')}>{t.message}</p>
                {t.body && <p className="mt-0.5 line-clamp-2 text-caption whitespace-pre-line text-muted">{t.body}</p>}
                {t.actionLabel && t.onAction && (
                  <button
                    type="button"
                    className="mt-1.5 text-caption font-medium text-accent-text hover:underline"
                    onClick={() => {
                      t.onAction?.();
                      dismiss(t.id);
                    }}
                  >
                    {t.actionLabel}
                  </button>
                )}
              </div>
              <button type="button" className="shrink-0 rounded-md p-0.5 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}
