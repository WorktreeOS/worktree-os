import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createUiApi, type UiApi } from "./ui-api";

const UiApiContext = createContext<UiApi | null>(null);

export function UiApiProvider({
  children,
  baseUrl = "",
  onUnauthorized,
}: {
  children: ReactNode;
  baseUrl?: string;
  /**
   * Called when any non-auth API request returns `401`. The
   * `PublicAuthProvider` uses this to drop back to the login state when the
   * cookie expires or the secret is rotated.
   */
  onUnauthorized?: () => void;
}) {
  const api = useMemo(
    () => createUiApi(baseUrl, onUnauthorized ? { onUnauthorized } : {}),
    [baseUrl, onUnauthorized],
  );
  return <UiApiContext.Provider value={api}>{children}</UiApiContext.Provider>;
}

export function useUiApi(): UiApi {
  const api = useContext(UiApiContext);
  if (!api) throw new Error("UiApiProvider is missing in the tree");
  return api;
}
