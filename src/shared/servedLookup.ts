import { useCallback, useEffect, useRef, useState } from 'react';

/* A served code → text lookup (distributor names, reg-zsku descriptions) that STAYS correct, shared by the providers in
   DistributorName.tsx and RegZskuDesc.tsx. Previously each fetched ONCE at app load, so a single miss stuck until a full
   page reload: the backend restarting at that moment, the map being read while a run was re-staging its master (masters
   are refreshed by DELETE + insert), or a code that first appeared in a newer run. Now the map:
     • RETRIES until it loads a non-empty map (backend down / mid-staging);
     • RELOADS after every pipeline run (the RUN_DONE window event, fired by the app when a run completes);
     • REFETCHES (throttled) when a code is looked up that the map does not have yet. */
export const RUN_DONE_EVENT = 'aoo:run-done';   // window event: a pipeline run finished → served masters may have changed

const RETRY_MS = 5000;          // retry interval while the map is still empty / the fetch failed
const MAX_RETRIES = 12;         // ~1 minute of retries, then wait for the next run / miss
const MISS_REFETCH_MS = 30000;  // at most one "unknown code" refetch per 30 s

export function useServedLookup(fetchMap: () => Promise<Record<string, string>>) {
  const [map, setMap] = useState<Record<string, string>>({});
  const lastMissFetch = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    try {
      const m = await fetchMap();
      if (m && Object.keys(m).length) { setMap(m); return true; }
      return false;
    } catch {
      return false;                                         // keep the last good map; the caller retries
    } finally {
      inFlight.current = false;
    }
  }, [fetchMap]);

  // initial load + retry until a non-empty map arrives
  useEffect(() => {
    let alive = true; let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      if (!alive) return;
      const ok = await load();
      if (!ok && alive && ++tries < MAX_RETRIES) timer = setTimeout(attempt, RETRY_MS);
    };
    attempt();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [load]);

  // reload after every pipeline run (masters are re-staged by the run)
  useEffect(() => {
    const onRun = () => { void load(); };
    window.addEventListener(RUN_DONE_EVENT, onRun);
    return () => window.removeEventListener(RUN_DONE_EVENT, onRun);
  }, [load]);

  // a looked-up code the map does not know → one throttled refetch (a newer master may have it)
  const onMiss = useCallback(() => {
    const now = Date.now();
    if (now - lastMissFetch.current < MISS_REFETCH_MS) return;
    lastMissFetch.current = now;
    void load();
  }, [load]);

  return { map, onMiss };
}
