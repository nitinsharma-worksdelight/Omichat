import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '../lib/api';
import { ConfirmContext, ToastContext, type ConfirmOptions, type ToastApi } from './feedback-context';
import { Modal } from './overlay';
import { Button, cx } from './ui';

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setToasts((t) => [...t.slice(-3), { id, kind, message }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 4000);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      error: (e) => push('error', typeof e === 'string' ? e : errorMessage(e)),
      info: (m) => push('info', m),
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
          <div className="text-sm text-fg-2">{confirmState?.message}</div>
        </Modal>
        <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              role={t.kind === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3 text-[13px] shadow-pop"
            >
              {t.kind === 'success' ? (
                <CircleCheck className="mt-px size-4 shrink-0 text-success" aria-hidden />
              ) : t.kind === 'error' ? (
                <CircleX className="mt-px size-4 shrink-0 text-danger" aria-hidden />
              ) : (
                <Info className="mt-px size-4 shrink-0 text-accent" aria-hidden />
              )}
              <p className={cx('min-w-0 flex-1 break-words', t.kind === 'error' ? 'text-fg' : 'text-fg')}>{t.message}</p>
              <button type="button" className="shrink-0 rounded p-0.5 text-muted hover:text-fg" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}
