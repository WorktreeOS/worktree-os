import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useUiApi } from "./api-context";
import type { UnifiedEventEnvelope } from "./unified-events";

export type UnifiedEventListener = (env: UnifiedEventEnvelope) => void;

interface EventsContextValue {
  /** Subscribe to every unified event. Returns an unsubscribe callback. */
  subscribe(listener: UnifiedEventListener): () => void;
}

const EventsContext = createContext<EventsContextValue | null>(null);

const RECONNECT_DELAY_MS = 1500;

export function EventsProvider({
  children,
  reconnectDelayMs = RECONNECT_DELAY_MS,
}: {
  children: ReactNode;
  reconnectDelayMs?: number;
}) {
  const api = useUiApi();
  const listenersRef = useRef(new Set<UnifiedEventListener>());

  useEffect(() => {
    let abort = new AbortController();
    let stopped = false;
    let lastEventId: number | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      while (!stopped) {
        try {
          for await (const env of api.streamUnifiedEvents({
            signal: abort.signal,
            lastEventId,
          })) {
            lastEventId = env.id;
            for (const listener of listenersRef.current) {
              try {
                listener(env);
              } catch {
                /* swallow listener errors */
              }
            }
          }
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
        }
        if (stopped) return;
        await new Promise<void>((resolve) => {
          retryTimer = setTimeout(resolve, reconnectDelayMs);
        });
        abort = new AbortController();
      }
    };
    void run();
    return () => {
      stopped = true;
      abort.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [api, reconnectDelayMs]);

  const value = useMemo<EventsContextValue>(
    () => ({
      subscribe(listener) {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
      },
    }),
    [],
  );

  return (
    <EventsContext.Provider value={value}>{children}</EventsContext.Provider>
  );
}

export function useUnifiedEvents(): EventsContextValue {
  const ctx = useContext(EventsContext);
  if (!ctx) throw new Error("EventsProvider is missing in the tree");
  return ctx;
}
