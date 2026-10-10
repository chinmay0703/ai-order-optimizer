import { createContext, useContext, type ReactNode } from 'react';
import { api } from '../api';
import { useServedLookup } from './servedLookup';

/* Single source of the distributor-code → Customer Name map for the WHOLE frontend — the exact mirror of
   RegZskuDesc. Served from GET /api/v1/distributor_names (off db_master) and provided via context; every page that
   shows a DB code renders the name beside it via useDistributorName(). NOTHING is stored or changed anywhere.
   Kept fresh by useServedLookup: retried until loaded, reloaded after every run, refetched when a code is unknown. */
type NameMap = Record<string, string>;

const Ctx = createContext<{ map: NameMap; onMiss: () => void }>({ map: {}, onMiss: () => {} });

/** db code → Customer Name ('' when unknown). Tolerates unpadded ids: xlsx-sourced codes lose leading zeros,
 *  so a miss on the raw key retries on the 10-char zero-padded form the backend keys on. */
export function useDistributorName(): (db: string | null | undefined) => string {
  const { map, onMiss } = useContext(Ctx);
  return (dbCode) => {
    if (dbCode == null) return '';
    const raw = String(dbCode).trim();
    const name = map[raw] ?? map[raw.padStart(10, '0')];
    if (name === undefined && raw) onMiss();              // unknown code → throttled refetch (a newer db_master may have it)
    return name ?? '';
  };
}

const fetchNames = () => api.distributorNames().then((r) => (r as { names?: NameMap }).names ?? {});

export function DistributorNameProvider({ children }: { children: ReactNode }) {
  const value = useServedLookup(fetchNames);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
