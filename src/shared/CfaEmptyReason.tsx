import { useEffect, useState } from 'react';
import { api } from '../api';
import { EmptyState } from './LoadState';

/* ---------------------------------------------------------------------------
   CfaEmptyReason — the HONEST empty-state for a CFA-scoped page that came back
   with no engine output. Instead of the misleading "run the engine first", it
   reads the per-CFA demand funnel from /last_run_summary (which lists EVERY CFA
   that had SOQ demand — INCLUDING ones fully dropped at the gate, 0 filtered
   SOQ) and explains WHY this CFA is empty:
     • had SOQ demand but 0 passed the demand gate → every distributor dropped,
       nothing was input to AIDEN, so the engine produced no output for it;
     • not in the run at all                       → the pipeline hasn't run.
   `noun` names what's missing on the host page (stock reservation / allocation
   / channel map …). Drop it into any CFA-scoped page's empty branch.
--------------------------------------------------------------------------- */
type Funnel = { soq_dbs?: number; filtered_dbs?: number; so_dbs?: number; dropped_dbs?: number };

export default function CfaEmptyReason({ cfa, date, noun = 'engine output' }: { cfa?: string; date?: string; noun?: string }) {
  const [fun, setFun] = useState<Funnel | null | undefined>(undefined);   // undefined = loading, null = no summary row

  useEffect(() => {
    let alive = true; setFun(undefined);
    api.lastRunSummary(date)
      .then((r) => {
        if (!alive) return;
        const s = (r as { summary?: Record<string, Funnel> })?.summary ?? {};
        const raw = String(cfa ?? '').trim();
        const key = raw.replace(/^0+/, '') || '0';               // /last_run_summary keys CFAs unpadded (e.g. "5710")
        setFun(s[key] ?? s[raw] ?? null);
      })
      .catch(() => { if (alive) setFun(null); });
    return () => { alive = false; };
  }, [cfa, date]);

  if (fun === undefined) return <EmptyState title="Loading…" hint={<>Checking why CFA {cfa} has no {noun} for {date}…</>} />;

  const soq = fun?.soq_dbs ?? 0;
  const filt = fun?.filtered_dbs ?? 0;

  // ALL-DROPPED — had SOQ demand, but nothing survived the demand gate → nothing input to AIDEN, no engine output.
  if (fun && soq > 0 && filt === 0) {
    return (
      <EmptyState
        title={`CFA ${cfa} — every distributor dropped at the demand gate`}
        hint={<>
          <b>{soq.toLocaleString()}</b> distributor{soq === 1 ? '' : 's'} came in the SOQ for <b>{date}</b>, but <b>0</b> passed
          the demand gate (PDP / below-threshold / ≥2-distributor cluster). So <b>nothing was input to AIDEN</b> for this CFA and
          the engine produced no {noun}. This is not a run error — re-running won’t change it while this CFA has no qualifying demand.
        </>}
      />
    );
  }
  // in the run universe (some demand passed the gate) but this specific page produced no rows for the CFA
  if (fun && filt > 0) {
    return (
      <EmptyState
        title={`No ${noun} for CFA ${cfa}`}
        hint={<>This CFA passed <b>{filt.toLocaleString()}</b> distributor{filt === 1 ? '' : 's'} through the demand gate, but has no {noun} for <b>{date}</b>.</>}
      />
    );
  }
  // not in the run at all — the pipeline hasn't produced a summary row for this CFA on this date
  return (
    <EmptyState
      title="No run for this date"
      hint={<>CFA {cfa} isn’t in the run for <b>{date}</b>. Run the pipeline for this date, then reopen this page.</>}
    />
  );
}
