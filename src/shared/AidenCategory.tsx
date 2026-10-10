import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';

/* Single source of the reg-zsku → AIDEN brand category map for the WHOLE frontend.
   Fetched ONCE from GET /api/v1/reg_zsku_aiden_categories (aiden_brand_material_master ⋈ region_sku_master, one
   category per reg-zsku) and provided via context. Any page that shows a reg-zsku can render the category via
   useAidenCategory(). Purely a served lookup — nothing stored/changed. Blank until the fetch resolves / if unreachable. */
type CatMap = Record<string, string>;

const Ctx = createContext<CatMap>({});

/** Returns a lookup fn: aidenOf(regZsku) -> AIDEN category ('' when unknown/missing). */
export function useAidenCategory(): (rz: string | null | undefined) => string {
  const map = useContext(Ctx);
  return (rz) => (rz == null ? '' : (map[String(rz).trim()] ?? ''));
}

export function AidenCategoryProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<CatMap>({});
  useEffect(() => {
    api.regZskuAidenCategories()
      .then((r) => setMap((r as { aiden_categories?: CatMap }).aiden_categories ?? {}))
      .catch(() => { /* keep empty map if the API is unreachable — column just renders blank */ });
  }, []);
  return <Ctx.Provider value={map}>{children}</Ctx.Provider>;
}
