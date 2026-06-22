import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/* Tracks which terminal session is currently focused in the open Terminal
 * panel, so sibling surfaces (notably the rail's Terminals view) can mark that
 * session as selected. The Terminal panel is the single writer; everyone else
 * reads. `null` means no session is focused (panel closed or none selected). */

interface ActiveTerminalValue {
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
}

/* Stable no-op default so consumers rendered outside the provider (e.g. an
 * isolated test) don't crash and don't churn identity between renders. */
const NOOP_VALUE: ActiveTerminalValue = {
  activeSessionId: null,
  setActiveSessionId: () => {},
};

const ActiveTerminalContext = createContext<ActiveTerminalValue>(NOOP_VALUE);

export function ActiveTerminalProvider({ children }: { children: ReactNode }) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const value = useMemo(
    () => ({ activeSessionId, setActiveSessionId }),
    [activeSessionId],
  );
  return (
    <ActiveTerminalContext.Provider value={value}>
      {children}
    </ActiveTerminalContext.Provider>
  );
}

export function useActiveTerminal(): ActiveTerminalValue {
  return useContext(ActiveTerminalContext);
}
