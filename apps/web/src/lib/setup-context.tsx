import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useUiApi } from "./api-context";
import { UiForbiddenError, type SetupStatusResponse } from "./ui-api";

/**
 * Result of the first-run setup probe. The gate is consulted on every layout
 * mount and after the user completes setup actions.
 */
export type SetupGateState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: SetupStatusResponse };

interface SetupContextValue {
  state: SetupGateState;
  refresh: () => Promise<void>;
}

const SetupContext = createContext<SetupContextValue | null>(null);

export function SetupProvider({ children }: { children: ReactNode }) {
  const api = useUiApi();
  const [state, setState] = useState<SetupGateState>({ kind: "loading" });

  const refresh = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const status = await api.getSetupStatus();
      setState({ kind: "ready", status });
    } catch (e) {
      if (e instanceof UiForbiddenError) {
        setState({ kind: "unavailable" });
        return;
      }
      setState({ kind: "error", message: (e as Error).message });
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SetupContextValue>(
    () => ({ state, refresh }),
    [state, refresh],
  );

  return <SetupContext.Provider value={value}>{children}</SetupContext.Provider>;
}

export function useSetupGate(): SetupContextValue {
  const ctx = useContext(SetupContext);
  if (!ctx) throw new Error("SetupProvider is missing in the tree");
  return ctx;
}
