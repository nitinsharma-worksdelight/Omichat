import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useToast } from '../components/feedback-context';

export interface ActionOptions<TData, TVars> {
  /** Toast shown on success. */
  success?: string | ((data: TData, vars: TVars) => string);
  /** Query keys (prefixes) to refetch on success. */
  invalidate?: QueryKey[];
  onSuccess?: (data: TData, vars: TVars) => void;
  /** Set false when the form shows the error itself. */
  errorToast?: boolean;
}

/** useMutation + invalidation + toasts, the pattern every write in the dashboard follows. */
export function useAction<TVars = void, TData = unknown>(fn: (vars: TVars) => Promise<TData>, opts: ActionOptions<TData, TVars> = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<TData, unknown, TVars>({
    mutationFn: fn,
    onSuccess: async (data, vars) => {
      if (opts.invalidate) await Promise.all(opts.invalidate.map((queryKey) => qc.invalidateQueries({ queryKey })));
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(data, vars) : opts.success);
      opts.onSuccess?.(data, vars);
    },
    onError: (err) => {
      if (opts.errorToast !== false) toast.error(err);
    },
  });
}
