import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';

/* Single source of the reg-zsku → brand category map for the WHOLE frontend.
   Fetched ONCE from GET /api/v1/reg_zsku_brand_categories (brand_material_master ⋈ region_sku_master, one
   category per reg-zsku) and provided via context. Any page that shows a reg-zsku can render the category via
   useBrandCategory(). Purely a served lookup — nothing stored/changed. Blank until the fetch resolves / if unreachable. */
type CatMap = Record<string, string>;

const Ctx = createContext<CatMap>({});

/** Returns a lookup fn: categoryOf(regZsku) -> brand category ('' when unknown/missing). */
export function useBrandCategory(): (rz: string | null | undefined) => string {
  const map = useContext(Ctx);
  return (rz) => (rz == null ? '' : (map[String(rz).trim()] ?? ''));
}

export function BrandCategoryProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<CatMap>({});
  useEffect(() => {
    api.regZskuBrandCategories()
      .then((r) => setMap((r as { brand_categories?: CatMap }).brand_categories ?? {}))
      .catch(() => { /* keep empty map if the API is unreachable — column just renders blank */ });
  }, []);
  return <Ctx.Provider value={map}>{children}</Ctx.Provider>;
}
