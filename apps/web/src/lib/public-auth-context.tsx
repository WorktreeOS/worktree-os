import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createUiApi, UiUnauthorizedError, type UiApi } from "./ui-api";
import {
  applyUnauthorized,
  readyFromSession,
  type PublicAuthState,
} from "./public-auth-state";

interface PublicAuthContextValue {
  state: PublicAuthState;
  /** Try the configured secret. Resolves on success; throws on bad secret. */
  login: (secret: string) => Promise<void>;
  /** Clear the cookie and return to the login state. */
  logout: () => Promise<void>;
  /** Mark current session as unauthorized (e.g. after a 401 from a stream). */
  markUnauthorized: () => void;
  /** Re-read the auth session from the daemon. */
  refresh: () => Promise<void>;
}

const PublicAuthContext = createContext<PublicAuthContextValue | null>(null);

export function PublicAuthProvider({
  children,
  baseUrl = "",
}: {
  children: ReactNode;
  baseUrl?: string;
}) {
  const [state, setState] = useState<PublicAuthState>({ kind: "loading" });
  const stateRef = useRef(state);
  stateRef.current = state;

  const markUnauthorized = useCallback(() => {
    setState((prev) => applyUnauthorized(prev));
  }, []);

  // Plain client used for the auth queries and the unauthorized hook. The
  // gated children will be served by a separate `UiApiProvider` that points
  // at the same `baseUrl` but also forwards 401 events here.
  const authApi = useMemo<UiApi>(
    () => createUiApi(baseUrl, { onUnauthorized: markUnauthorized }),
    [baseUrl, markUnauthorized],
  );

  const refresh = useCallback(async () => {
    try {
      const session = await authApi.getAuthSession();
      setState(readyFromSession(session));
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    }
  }, [authApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (secret: string) => {
      try {
        await authApi.login(secret);
      } catch (e) {
        if (e instanceof UiUnauthorizedError) throw e;
        throw e;
      }
      await refresh();
    },
    [authApi, refresh],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setState((prev) =>
        prev.kind === "ready"
          ? { kind: "ready", authenticated: false, requiresAuth: prev.requiresAuth }
          : prev,
      );
    }
  }, [authApi]);

  const value = useMemo<PublicAuthContextValue>(
    () => ({ state, login, logout, markUnauthorized, refresh }),
    [state, login, logout, markUnauthorized, refresh],
  );

  return (
    <PublicAuthContext.Provider value={value}>
      {children}
    </PublicAuthContext.Provider>
  );
}

export function usePublicAuth(): PublicAuthContextValue {
  const ctx = useContext(PublicAuthContext);
  if (!ctx) throw new Error("PublicAuthProvider is missing in the tree");
  return ctx;
}
