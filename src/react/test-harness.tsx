import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AuthContext } from "../settings/auth-mode.js";
import { BBClientProvider } from "./provider.js";

/** A representative OAuth AuthContext for hook tests. */
export const fakeAuth: AuthContext = {
  baseUrl: "https://test.local",
  token: "test-token",
  orgId: "org-1",
  mode: "oauth",
  userId: "user-1",
};

/** A QueryClient with retries off so failure paths resolve immediately in tests. */
export function makeTestClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

/** Wrapper for `renderHook`, mounting the hook inside <BBClientProvider>. */
export function makeWrapper(client: QueryClient = makeTestClient(), auth: AuthContext = fakeAuth) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <BBClientProvider auth={auth} queryClient={client}>
        {children}
      </BBClientProvider>
    );
  };
}
