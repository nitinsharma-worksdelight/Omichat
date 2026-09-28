import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, get, onUnauthorized, session } from '../lib/api';
import { navigate } from '../lib/router';
import type { Me, Role } from '../lib/types';

interface AuthContextValue {
  token: string | null;
  me: Me | undefined;
  meLoading: boolean;
  meError: unknown;
  refetchMe: () => void;
  role: Role | undefined;
  signIn: (token: string, orgId?: string | null) => void;
  signOut: () => void;
  switchOrg: (orgId: string) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(() => session.getToken());

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => get<Me>('/v1/me'),
    enabled: Boolean(token),
    retry: false,
    staleTime: 60_000,
  });

  useEffect(
    () =>
      onUnauthorized(() => {
        setToken(null);
        qc.clear();
        navigate('/login', { replace: true });
      }),
    [qc],
  );

  // A remembered org the user no longer belongs to → fall back to their default org.
  const { error: meError, refetch } = meQuery;
  useEffect(() => {
    if (meError instanceof ApiError && meError.status === 403 && session.getOrgId()) {
      session.setOrgId(null);
      void refetch();
    }
  }, [meError, refetch]);

  const signIn = useCallback(
    (newToken: string, orgId?: string | null) => {
      session.setToken(newToken);
      if (orgId !== undefined) session.setOrgId(orgId);
      qc.clear();
      setToken(newToken);
      navigate('/', { replace: true });
    },
    [qc],
  );

  const signOut = useCallback(() => {
    session.clear();
    qc.clear();
    setToken(null);
    navigate('/login', { replace: true });
  }, [qc]);

  const switchOrg = useCallback(
    (orgId: string) => {
      session.setOrgId(orgId);
      navigate('/');
      void qc.resetQueries();
    },
    [qc],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      me: meQuery.data,
      meLoading: meQuery.isLoading,
      meError: meQuery.error,
      refetchMe: () => void meQuery.refetch(),
      role: meQuery.data?.role,
      signIn,
      signOut,
      switchOrg,
    }),
    [token, meQuery, signIn, signOut, switchOrg],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
