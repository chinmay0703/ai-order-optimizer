import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
// mermaid (~2 MB with its diagram chunks) is NOT bundled: it is fetched from the jsDelivr CDN the first time this
// diagram renders, so the deployed site stays small. Pinned to the exact version the (dev-only) types come from.
type Mermaid = typeof import('mermaid').default;
const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs';
import { C, SERIF } from '../../theme/pdartTokens';
import { EmptyState, ErrorState, PageSkeleton } from '../../shared/LoadState';
import { useOeParams, pct, type OeParams } from '../../shared/OeParams';

/* Interactive pan + zoom render of the allocation pipeline — the CURRENT flow (api/production.py _execute_run →
   services.cfa_runner → services.allocation.run per CFA → secondary-CFA shift → RLM rollup), checked against develop.
   Drag the canvas to pan, mouse-wheel or the +/- buttons to zoom, Fit to frame it. */
const buildDiagram = (P: OeParams) => `flowchart TD
  classDef s3   fill:#FFE8D4,stroke:#C52B09,color:#8A3A0C;
  classDef pg   fill:#F5F7F8,stroke:#2D2D2D,color:#2D2D2D;
  classDef proc fill:#FFFFFF,stroke:#C52B09,color:#2D2D2D,stroke-width:1.4px;
  classDef out  fill:#E9F4EC,stroke:#1B7346,color:#14532D;
  classDef gate fill:#F5F7F8,stroke:#5C616A,color:#2D2D2D;

  RUN{{"0 · RUN · run date = TODAY (IST) · data date = the SOQ date picked<br/>lock the run date · re-read oe_parameters · clear today's outputs + SAP orders"}}:::gate

  subgraph SRC["1 · S3 SOURCES (fetched for the data date)"]
    direction TB
    S3M[("S3 · 13 MASTERS (full loads, in parallel)<br/>db_master · material_master · network_master · truck_master<br/>substitution_master · filler_master (latest load) · transhipment_master<br/>plant_master · lead_time_master · db_tier · region_sku_master<br/>brand_material_master · pdp_master")]:::s3
    S3SOQ[("S3 · soq @data date<br/>demand + gate FLAGS · DB on-hand + in-transit")]:::s3
    S3DRR[("S3 · OE_DAILY_RUN_RATE @data date<br/>DRR = L3M primary cases ÷ 90")]:::s3
    S3CI[("S3 · cfa_inventory @data date<br/>batch level, expiry (FEFO source)")]:::s3
    S3SCR[("S3 · sub_channel_reservation<br/>latest S3 run_date · channel × band %")]:::s3
  end

  RUN --> STG
  RUN --> META[("pipeline_run_meta<br/>run date · SOQ date · CFAs (written at start + end)")]:::pg
  S3M --> STG
  S3SOQ --> STG
  S3DRR --> STG
  STG["1 · STAGE (s3_fetch) · masters in full (latest) · dated feeds by data date, stamped TODAY"]:::proc
  STG --> tMAST[("13 masters in Postgres")]:::pg
  STG --> tDRR[("daily_run_rate @today<br/>exact data date only · missing → warning, DRR 0")]:::pg
  STG --> tSOQ[("soq @today · RAW")]:::pg

  tSOQ --> FILT["2 · DEMAND GATE · stage_filtered_soq()<br/>gate 1: (PDP or below-threshold) AND combined &gt;65%<br/>gate 2: a cluster needs ≥2 distributors"]:::proc
  tMAST -.transhipment_master (gate 2).-> FILT
  FILT --> tFSOQ[("filtered_soq @today<br/>the run universe — everything below reads THIS")]:::pg

  tFSOQ --> SCOPE["scope to the filtered CFAs and DBs"]:::gate
  S3CI --> SCOPE
  S3SOQ -.on-hand + in-transit.-> SCOPE
  SCOPE --> tCI[("cfa_inventory @today")]:::pg
  SCOPE --> tDI[("db_inventory @today<br/>SOH = on-hand + in-transit")]:::pg

  tFSOQ --> SCPM["3 · PRE-FILTER · build_soq_scoped_masters()<br/>slice the sub/filler masters to the demanded CFA × DB"]:::proc
  SCPM --> tSDS[("soq_db_substitution<br/>CFA × DB × exact MRP × brand category")]:::pg
  SCPM --> tSDF[("soq_db_filler<br/>CFA × DB ranked fillers, any MRP")]:::pg
  S3SCR --> SCRL["load_sub_channel_reservation(run date)"]:::proc
  SCRL --> tSCR[("sub_channel_reservation<br/>DATE-WISE: one row-set per run date + source_run_date")]:::pg

  tFSOQ --> AVAIL{{"4 · run_cfas() · every CFA with filtered demand<br/>a pool of worker processes (CFA_PARALLEL_WORKERS) runs the CFAs in parallel · a failing CFA never stops the rest"}}:::gate
  AVAIL --> ENG

  subgraph ENG["5 · services.allocation.run(cfa) — per CFA"]
    direction TB
    CH["5a · Channel segregation<br/>channel_of(Customer Type, Sub-Channel)"]:::proc
    CH --> tDCM[("db_channel_map<br/>Retail · AFH · Hub &amp; Spoke · Non-PACE")]:::out

    RES["5b · Reserve CFA stock<br/>reserved = pool × band % (% for the run date, latest stored if missing)"]:::proc
    tCI -.pool per reg-zsku.-> RES
    tSCR -.channel × band %.-> RES
    tMAST -.MRP · brand category.-> RES
    RES --> tCR[("cfa_reservation<br/>physical · reserved · reservation_pct · brand_category")]:::out

    INTK["5c · Intake<br/>demand · SOH · ${P.NORM_MULTIPLIER}×Norm room (Non-PACE uncapped)<br/>DRR + RF (PDP freq) · tier · subs · fillers · truck caps · clusters"]:::proc
    tDI -.SOH.-> INTK
    tDRR -.DRR.-> INTK
    tMAST -.pdp_master · db_tier · truck · cluster.-> INTK
    tSDS -.substitutes.-> INTK
    tSDF -.fillers.-> INTK

    CH --> CAS
    RES --> CAS
    INTK --> CAS
    CAS["5d · CASCADE · Run 1 Non-PACE → 2 Hub &amp; Spoke → 3 AFH → 4 Retail<br/>leftover stock carries forward"]:::proc

    CAS --> S1["5e-1 · STEP 1 Original · DRR × RF fair share<br/>Floor first · common level λ (bisection) · whole cases"]:::proc
    S1 --> S2["5e-2 · STEP 2 Substitute<br/>exact MRP + brand category · neediest first · ${P.NORM_MULTIPLIER}×Norm / ${pct(P.ADDON_CAP_PCT)}"]:::proc
    S2 --> S3S["5e-3 · STEP 3 Filler + Truck<br/>fill to ${pct(P.TRUCK_FILL_TARGET_PCT)} · ${pct(P.TRUCK_KEEP_PCT)} truck floor · tail trim / lane drop"]:::proc
    S3S --> CTR["5f · Cluster primary trim (after ALL channel runs)<br/>transshipment clusters · ${pct(P.TRUCK_KEEP_PCT)} primary floor"]:::proc
    CTR --> PERS["5g · persist outputs"]:::proc

    PERS --> TPL["5h · Truck plan + SO disposition<br/>Non-PACE ≥65% / cluster → SO · else Original ≥ ${pct(P.SO_CREATION_ORIGINAL_FLOOR_PCT)} and truck ≥ ${pct(P.SO_CREATION_TRUCK_FILL_PCT)} → SO · else RLM"]:::proc
    TPL --> FEFO["5i · FEFO disaggregation<br/>earliest expiry first · split per truck · one OEID per CFA × DB (locked)"]:::proc
    tCI -.batch pool.-> FEFO
    FEFO --> OMAS["5j · order_masters → SO-eligible lines"]:::proc
    OMAS --> BORD["build_orders() · build_order_line_items()"]:::proc
    FEFO --> PTL["5k · RLM PTL · build_rlm_ptl()<br/>one header per RLM truck + line items"]:::proc
  end

  PERS --> oAF[("allocation_final<br/>shipped, after truck + cluster trim")]:::out
  PERS --> oSTP[("alloc_step1/2/3 · or_waterfill_steps<br/>or_sub_eligibility · or_output_filler_calc")]:::out
  PERS --> oTT[("or_output_truck_trim · or_cluster_primary(_trim)<br/>or_filler_sequence · demand_by_run")]:::out
  PERS --> oLG[("or_output_ledger · or_output_shortfall")]:::out
  TPL --> oTP[("truck_plan_by_run<br/>trucks · fill % · so_flag · original_fill_pct")]:::out
  FEFO --> oAOQ[("actual_order_quantity<br/>SKU / batch picks per truck · so_flag")]:::out
  OMAS --> tOM[("order_masters")]:::out
  BORD --> tORD[("de_sap.orders — the SAP hand-off")]:::out
  BORD --> s3LI[("S3 · OE_OUTPUT order_line_items<br/>S3 only · written on QA / prod")]:::s3
  PTL --> oPTL[("rlm_ptl_headers / _line_items")]:::out
  oAOQ -.order ids + source split.-> PTL
  oAF -.line items.-> PTL

  ENG --> SHIFT["6 · Secondary-CFA shift (after ALL CFAs, per CFA, failed CFAs skipped)<br/>build_secondary_cfa_shift_all() · RLM_FOR_SECOND_CFA lanes"]:::proc
  tMAST -.network_master Secondary_CFA.-> SHIFT
  oLG -.secondary CFA leftover.-> SHIFT
  SHIFT --> oRSH[("rlm_cfa_shift_headers / _line_items")]:::out
  SHIFT --> AUD[("pipeline_run_audit + pipeline_run_cfa_stage<br/>SUCCESS / PARTIAL / FAILED")]:::pg

  tOM --> ROLL{{"7 · RLM rollup — 15:31 IST (opt-in cron) or POST /api/v1/rlm/rollup<br/>CFA by CFA"}}:::gate
  META -.CFA list.-> ROLL
  oPTL -.PENDING / APPROVED / REJECTED.-> ROLL
  oRSH -.PENDING / SHIFTED / HELD.-> ROLL
  ROLL --> RTRK["Truck leg · APPROVED ships · PENDING → REJECTED by default<br/>rejected cases removed from allocation_final"]:::proc
  ROLL --> RSHF["Shift leg · SHIFTED → 2nd CFA (removed from this CFA's allocation_final)<br/>PENDING / HELD / no header → primary CFA ships (SEC_CFA_REJECTED) · header → APPROVED"]:::proc
  RTRK --> tOM
  RSHF --> tOM
  RTRK -.PENDING → default.-> oPTL
  RSHF -.PENDING / HELD → APPROVED.-> oRSH
  RTRK -.reconcile.-> oAF
  RTRK -.reconcile.-> oAOQ
  RTRK -.approved → SO_CREATION.-> oTP
  RSHF -.reconcile.-> oAF
  RTRK --> BORD
  RSHF --> BORD
  ROLL -.is_active supersede.-> tORD`;

let mermaidP: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  if (!mermaidP) {
    mermaidP = (import(/* @vite-ignore */ MERMAID_URL) as Promise<{ default: Mermaid }>).then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false, securityLevel: 'loose', theme: 'base',
        themeVariables: { fontFamily: "'Helvetica Neue',Helvetica,Arial,sans-serif", fontSize: '13px', lineColor: '#5C616A' },
        flowchart: { htmlLabels: false, curve: 'basis', nodeSpacing: 45, rankSpacing: 55 },
      });
      return mermaid;
    });
    mermaidP.catch(() => { mermaidP = null; });   // offline / CDN hiccup → the Retry button can try again
  }
  return mermaidP;
}

const clampK = (k: number) => Math.min(4, Math.max(0.12, k));

export default function PipelineFlow() {
  const P = useOeParams();
  const diagram = buildDiagram(P);
  const [svg, setSvg] = useState('');
  const [dim, setDim] = useState({ w: 0, h: 0 });
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);    // NEVER infer "still rendering" from svg==='' — a render that
  const [nonce, setNonce] = useState(0);           // resolves with an EMPTY svg would then say "Rendering…" forever
  const [tf, setTf] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setErr(''); setLoading(true);
    loadMermaid().then((mermaid) => mermaid.render('atom-pipeline-svg', diagram))
      .then(({ svg }) => {
        if (!alive) return;
        // mermaid sizes the svg ONLY via `style="max-width:…"`. Overriding that leaves the svg at the tiny
        // ~300px CSS default, so pin an explicit natural width/height from its viewBox and let our own
        // transform do the scaling. Then `fit` frames the whole thing, centered.
        const m = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/.exec(svg);
        const w = m ? Math.ceil(parseFloat(m[1])) : 1400;
        const h = m ? Math.ceil(parseFloat(m[2])) : 1200;
        const out = svg
          .replace(/max-width:\s*[\d.]+px/gi, 'max-width:none')
          .replace(/<svg /i, `<svg width="${w}" height="${h}" `);
        setDim({ w, h });
        setSvg(out);
      })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });   // finally: settles on success, on an EMPTY svg AND on failure
    return () => { alive = false; };
  }, [diagram, nonce]);

  const fit = useCallback(() => {
    const wrap = wrapRef.current; if (!wrap || !dim.w || !dim.h) return;
    const cw = wrap.clientWidth, ch = wrap.clientHeight;
    const k = clampK(Math.min(cw / dim.w, ch / dim.h) * 0.96);
    setTf({ k, x: (cw - dim.w * k) / 2, y: (ch - dim.h * k) / 2 });   // whole diagram, centered on BOTH axes
  }, [dim]);

  // auto-fit (centered full view) as soon as the diagram's real size is known
  useEffect(() => { if (dim.w) { const t = setTimeout(fit, 40); return () => clearTimeout(t); } }, [dim, fit]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect(); if (!rect) return;
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    setTf((t) => {
      const k = clampK(t.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      const s = k / t.k;
      return { k, x: cx - (cx - t.x) * s, y: cy - (cy - t.y) * s };
    });
  }, []);

  const onDown = (e: React.MouseEvent) => { drag.current = { sx: e.clientX, sy: e.clientY, ox: tf.x, oy: tf.y }; };
  const onMove = (e: React.MouseEvent) => {
    const d = drag.current; if (!d) return;
    setTf((t) => ({ ...t, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
  };
  const onUp = () => { drag.current = null; };
  const zoom = (f: number) => setTf((t) => ({ ...t, k: clampK(t.k * f) }));

  const downloadPng = useCallback(() => {
    const svgEl = wrapRef.current?.querySelector('svg');
    if (!svgEl || !dim.w) return;
    // native-SVG-text (htmlLabels:false) serialises + rasterises cleanly — no foreignObject to drop.
    const clone = svgEl.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('width', String(dim.w));
    clone.setAttribute('height', String(dim.h));
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    const img = new Image();
    img.onload = () => {
      const scale = 2;                                   // 2× for a crisp export
      const cv = document.createElement('canvas');
      cv.width = dim.w * scale; cv.height = dim.h * scale;
      const ctx = cv.getContext('2d'); if (!ctx) return;
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      cv.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'ai-order-optimizer-pipeline.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      }, 'image/png');
    };
    img.src = src;
  }, [dim]);

  const BtnCss = {
    cursor: 'pointer', width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 16, fontWeight: 800, lineHeight: 1, color: C.navy, bgcolor: '#fff', userSelect: 'none' as const,
    border: `1px solid ${C.rule}`, borderRadius: 1, '&:hover': { bgcolor: C.navyP, borderColor: C.navy },
  };

  return (
    <Box>
      <Typography sx={{ fontFamily: SERIF, fontWeight: 700, color: C.navy, fontSize: 20, mb: 0.25 }}>
        Pipeline flowchart — run → S3 → demand gate → per-CFA engine → orders → RLM
      </Typography>
      <Typography sx={{ fontSize: 12.5, color: C.muted, mb: 1.25 }}>
        Drag to pan · scroll to zoom · use the controls to zoom / fit. Every box names its code function; every cylinder is a real table.
      </Typography>

      <Box sx={{ position: 'relative', border: `1px solid ${C.rule}`, borderRadius: 1.5, bgcolor: '#FAF9F8', overflow: 'hidden', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.02)' }}>
        {/* controls */}
        <Box sx={{ position: 'absolute', top: 10, right: 10, zIndex: 5, display: 'flex', flexDirection: 'column', gap: 0.6 }}>
          <Box sx={BtnCss} title="Zoom in" onClick={() => zoom(1.2)}>+</Box>
          <Box sx={BtnCss} title="Zoom out" onClick={() => zoom(1 / 1.2)}>−</Box>
          <Box sx={{ ...BtnCss, fontSize: 11, fontWeight: 700 }} title="Fit to frame" onClick={fit}>FIT</Box>
          <Box sx={{ ...BtnCss, fontSize: 10, fontWeight: 800 }} title="Download as PNG" onClick={downloadPng}>PNG</Box>
        </Box>
        {/* canvas */}
        <Box
          ref={wrapRef}
          onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
          sx={{ height: '72vh', minHeight: 460, cursor: drag.current ? 'grabbing' : 'grab', position: 'relative',
            '& svg': { maxWidth: 'none !important', height: 'auto', display: 'block' } }}
        >
          {err ? (
            <Box sx={{ p: 3 }}><ErrorState error={err} onRetry={() => setNonce((n) => n + 1)} /></Box>
          ) : loading ? (
            <Box sx={{ p: 3 }}><PageSkeleton kpis={0} rows={7} /></Box>
          ) : !svg ? (
            <Box sx={{ p: 3 }}><EmptyState title="No diagram to show"
              hint="The flowchart rendered nothing at all. Reload the page to draw it again — the diagram is built from the live OE parameters." /></Box>
          ) : (
            <Box
              sx={{ position: 'absolute', top: 0, left: 0, transformOrigin: '0 0', willChange: 'transform' }}
              style={{ transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.k})` }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
        </Box>
        {/* zoom readout */}
        <Box sx={{ position: 'absolute', bottom: 8, left: 10, zIndex: 5, fontSize: 11, fontWeight: 700, color: C.muted,
          bgcolor: 'rgba(255,255,255,0.85)', px: 0.9, py: 0.3, borderRadius: 1, border: `1px solid ${C.rule}` }}>
          {Math.round(tf.k * 100)}%
        </Box>
      </Box>
    </Box>
  );
}
