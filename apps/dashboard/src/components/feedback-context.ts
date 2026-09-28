import { createContext, useContext, type ReactNode } from 'react';

/**
 * Context objects live apart from the provider so editing UI components during development
 * (hot reload) doesn't recreate them and orphan the mounted provider.
 */

export interface ToastApi {
  success: (message: string) => void;
  error: (errorOrMessage: unknown) => void;
  info: (message: string) => void;
}

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

export const ToastContext = createContext<ToastApi | null>(null);
export const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside FeedbackProvider');
  return ctx;
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm outside FeedbackProvider');
  return ctx;
}
