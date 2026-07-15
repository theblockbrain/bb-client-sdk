import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isBBApiError } from "../api/index.js";
import type { AuthContext } from "../settings/auth-mode.js";

/**
 * Retry policy for React Query, keyed off `BBApiError` (not ky's `HTTPError`,
 * which is what the in-house frontends key off today).
 *
 * - 401 → never retry: that path is owned by the auth-refresh flow.
 * - other 4xx → never retry: client errors are not transient.
 * - 5xx / network → retry up to 3×.
 */
export function bbShouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isBBApiError(error)) {
    if (error.statusCode === 401) return false;
    if (error.statusCode >= 400 && error.statusCode < 500) return false;
  }
  return failureCount < 3;
}

export interface CreateBBQueryClientOptions {
  /** Invoked on any 401/403 so the host can refresh the token or route to login. */
  onAuthError?: (error: unknown) => void;
}

/**
 * A QueryClient pre-wired with the BlockBrain defaults: the BBApiError-aware
 * retry predicate, a 5-min staleTime / 10-min gcTime, and cache-level error
 * hooks that surface auth failures to the host.
 */
export function createBBQueryClient(opts: CreateBBQueryClientOptions = {}): QueryClient {
  const onError = (error: unknown) => {
    if (isBBApiError(error) && (error.statusCode === 401 || error.statusCode === 403)) {
      opts.onAuthError?.(error);
    }
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: 5 * 60_000,
        gcTime: 10 * 60_000, // v5 name (was cacheTime)
        retry: bbShouldRetryQuery,
        refetchOnWindowFocus: false,
        throwOnError: false,
      },
      mutations: { retry: 0 }, // POST/PATCH/DELETE are non-idempotent — never auto-retry
    },
  });
}

interface BBContextValue {
  /**
   * Returns the freshest AuthContext. queryFns close over this rather than over
   * a captured `auth`, so a token refresh is picked up transparently WITHOUT
   * the rotating token being part of any query key.
   */
  getAuthContext: () => AuthContext;
  /** Home org — the cache-scope root. Reactive: changing it re-scopes every key. */
  orgId: string;
}

const BBContext = createContext<BBContextValue | null>(null);

export interface BBClientProviderProps {
  auth: AuthContext;
  /** Supply your own client for SSR (per-request) or tests. Omit to create one. */
  queryClient?: QueryClient;
  onAuthError?: (error: unknown) => void;
  children: ReactNode;
}

export function BBClientProvider({
  auth,
  queryClient,
  onAuthError,
  children,
}: BBClientProviderProps) {
  const [client] = useState(() => queryClient ?? createBBQueryClient({ onAuthError }));

  // Freshest ctx in a ref — queryFns read getAuthContext(), never a captured `auth`.
  const authRef = useRef(auth);
  authRef.current = auth;
  const getAuthContext = useCallback(() => authRef.current, []);

  // Drop the previous tenant's cache on a hard org switch.
  const prevOrg = useRef(auth.orgId);
  useEffect(() => {
    if (prevOrg.current !== auth.orgId) {
      client.removeQueries({ queryKey: ["bb", prevOrg.current] });
      prevOrg.current = auth.orgId;
    }
  }, [auth.orgId, client]);

  const value = useMemo<BBContextValue>(
    () => ({ getAuthContext, orgId: auth.orgId }),
    [getAuthContext, auth.orgId],
  );

  return (
    <QueryClientProvider client={client}>
      <BBContext.Provider value={value}>{children}</BBContext.Provider>
    </QueryClientProvider>
  );
}

export function useBBContext(): BBContextValue {
  const ctx = useContext(BBContext);
  if (!ctx) throw new Error("useBBContext must be used inside <BBClientProvider>.");
  return ctx;
}
