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
import { useUiApi } from "./api-context";
import { useUnifiedEvents } from "./events-context";
import type { TerminalSessionMetadata } from "./terminal-protocol";

/* Tracks per-worktree terminal sessions that are alive (status=running or
 * status=creating). Backed by the unified events stream so it stays fresh
 * without polling. Consumers can read either a count or the full list. */

type SessionsByPath = ReadonlyMap<string, ReadonlyArray<TerminalSessionMetadata>>;

const EMPTY_LIST: ReadonlyArray<TerminalSessionMetadata> = [];

const TerminalSessionsContext = createContext<SessionsByPath | null>(null);

const TERMINAL_EVENT_TYPES = new Set([
  "terminal.started",
  "terminal.exited",
  "terminal.removed",
  "terminal.updated",
  "agent.activity.changed",
]);

export function TerminalSessionsProvider({ children }: { children: ReactNode }) {
  const api = useUiApi();
  const events = useUnifiedEvents();
  const [sessions, setSessions] = useState<SessionsByPath>(new Map());
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      do {
        pendingRef.current = false;
        try {
          const res = await api.listTerminalLayerSessions();
          const next = new Map<string, TerminalSessionMetadata[]>();
          for (const s of res.sessions) {
            if (s.status === "running" || s.status === "creating") {
              const list = next.get(s.worktreePath);
              if (list) list.push(s);
              else next.set(s.worktreePath, [s]);
            }
          }
          /* Stable order: oldest first by createdAt — matches the rail badge
           * and lets the list build up predictably as terminals spawn. */
          for (const list of next.values()) {
            list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          }
          setSessions(next);
        } catch {
          // 503 (terminal runtime missing) or 403 (public). Treat as empty.
          setSessions(new Map());
        }
      } while (pendingRef.current);
    } finally {
      inFlightRef.current = false;
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsub = events.subscribe((env) => {
      if (TERMINAL_EVENT_TYPES.has(env.type)) void refresh();
    });
    return unsub;
  }, [events, refresh]);

  /* Periodic resync so the badge that surfaces which agent CLI is in the
   * foreground (claude / codex / opencode) stays accurate even when no
   * lifecycle events fire — switching apps inside the same pty does not
   * produce a `terminal.*` event. The interval matches the right-panel's
   * own 2.5s poll cadence. */
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <TerminalSessionsContext.Provider value={sessions}>
      {children}
    </TerminalSessionsContext.Provider>
  );
}

function useSessionsMap(): SessionsByPath {
  const ctx = useContext(TerminalSessionsContext);
  if (!ctx) throw new Error("TerminalSessionsProvider is missing in the tree");
  return ctx;
}

export function useTerminalSessions(
  worktreePath: string,
): ReadonlyArray<TerminalSessionMetadata> {
  const sessions = useSessionsMap();
  return sessions.get(worktreePath) ?? EMPTY_LIST;
}

/* Full per-path session snapshot. The status-first rail's Terminals view reads
 * this once to group every live session project → worktree → session. */
export function useAllTerminalSessions(): SessionsByPath {
  return useSessionsMap();
}

export function useTerminalCount(worktreePath: string): number {
  const sessions = useSessionsMap();
  return sessions.get(worktreePath)?.length ?? 0;
}

export function useProjectTerminalCount(worktreePaths: string[]): number {
  const sessions = useSessionsMap();
  return useMemo(
    () =>
      worktreePaths.reduce(
        (acc, p) => acc + (sessions.get(p)?.length ?? 0),
        0,
      ),
    [sessions, worktreePaths],
  );
}

/* Per-path live terminal counts as a single map. Sidebar consumers read this
 * once per render so terminal-aware grouping helpers can stay pure and the
 * map identity changes only when the underlying sessions snapshot does. */
export function useTerminalCountsMap(): ReadonlyMap<string, number> {
  const sessions = useSessionsMap();
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const [path, list] of sessions) {
      if (list.length > 0) counts.set(path, list.length);
    }
    return counts;
  }, [sessions]);
}
