import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';

/* Single source of the engine's DB-backed thresholds (oe_parameters) for the WHOLE frontend.
   No page may hardcode 1.2 / 0.35 / 0.65 / 0.90 / 0.50 etc. — read them from useOeParams() so a change on the
   OE Parameters page is reflected everywhere instead of silently mismatching. Falls back to the coded defaults
   until the fetch resolves (and if the API is unreachable). NOTE: these are the CURRENT config values; the
   engine-computed numbers on a page reflect the value used at that run — they align after a re-run. */
export interface OeParams {
  DEFAULT_TIER: number;
  ADDON_CAP_PCT: number;
  NORM_MULTIPLIER: number;
  TRUCK_KEEP_PCT: number;
  TRUCK_FILL_TARGET_PCT: number;
  SO_CREATION_ORIGINAL_FLOOR_PCT: number;
  SO_CREATION_TRUCK_FILL_PCT: number;
}

export const OE_DEFAULTS: OeParams = {
  DEFAULT_TIER: 4,
  ADDON_CAP_PCT: 0.35, NORM_MULTIPLIER: 1.2, TRUCK_KEEP_PCT: 0.65,
  TRUCK_FILL_TARGET_PCT: 0.9, SO_CREATION_ORIGINAL_FLOOR_PCT: 0.5, SO_CREATION_TRUCK_FILL_PCT: 0.9,
};

// convenience: a fraction (0.65) → whole-percent string ("65%") for labels
export const pct = (v: number) => `${Math.round(v * 100)}%`;

const Ctx = createContext<OeParams>(OE_DEFAULTS);
export const useOeParams = () => useContext(Ctx);

// `nonce` lets the app force a re-fetch (e.g. bump it after a pipeline run) so the labels reflect any param edit
// without a full browser refresh. It re-fetches on mount and whenever nonce changes.
export function OeParamsProvider({ children, nonce = 0 }: { children: ReactNode; nonce?: number }) {
  const [p, setP] = useState<OeParams>(OE_DEFAULTS);
  useEffect(() => {
    api.oeParameters().then((r) => {
      const rows = (r as { parameters?: { key: string; value: number }[] }).parameters ?? [];
      const next = { ...OE_DEFAULTS };
      for (const row of rows) if (row.key in next) (next as unknown as Record<string, number>)[row.key] = row.value;
      setP(next);
    }).catch(() => { /* keep defaults if the API is unreachable */ });
  }, [nonce]);
  return <Ctx.Provider value={p}>{children}</Ctx.Provider>;
}
