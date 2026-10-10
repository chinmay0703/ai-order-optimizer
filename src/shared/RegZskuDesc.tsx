import { createContext, useContext, type ReactNode } from 'react';
import { api } from '../api';
import { useServedLookup } from './servedLookup';

/* Single source of the reg-zsku → old_material_description map for the WHOLE frontend.
   Served from GET /api/v1/reg_zsku_descriptions (region_sku_master, one description per reg-zsku) and provided via
   context; every page that shows a reg-zsku renders its description via useRegZskuDesc(). NOTHING is stored/changed.
   Kept fresh by useServedLookup: retried until loaded, reloaded after every run, refetched when a reg-zsku is unknown. */
type DescMap = Record<string, string>;

const Ctx = createContext<{ map: DescMap; onMiss: () => void }>({ map: {}, onMiss: () => {} });

/** Returns a lookup fn: descOf(regZsku) -> old_material_description ('' when unknown/missing). */
export function useRegZskuDesc(): (rz: string | null | undefined) => string {
  const { map, onMiss } = useContext(Ctx);
  return (rz) => {
    if (rz == null) return '';
    const key = String(rz).trim();
    const d = map[key];
    if (d === undefined && key) onMiss();                 // unknown reg-zsku → throttled refetch
    return d ?? '';
  };
}

const fetchDescs = () => api.regZskuDescriptions().then((r) => (r as { descriptions?: DescMap }).descriptions ?? {});

export function RegZskuDescProvider({ children }: { children: ReactNode }) {
  const value = useServedLookup(fetchDescs);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
