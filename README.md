# AIDEN — AI Order Optimizer (demo)

A React + MUI front end for an order-allocation engine: it takes distributor demand (SOQ), allocates CFA stock in
three steps (original fair share → substitutes → fillers), applies truck-fill rules, and produces the final order,
SAP hand-off and validation reports.

**This build runs entirely in the browser on sample data — there is no backend.** Every `/api/*` request is answered
locally by `src/mock/` from one synthetic dataset: 1 CFA, 10 distributors, 40 reg-zskus and two cascade runs, so the
numbers agree from page to page.

**Live demo:** https://chinmay0703.github.io/ai-order-optimizer/

## Sign in

| Username | Password | Access |
|---|---|---|
| `admin` | `admin` | everything, incl. User Management |
| `planner` | `planner` | can start runs |
| `viewer` | `viewer` | read-only |

User and parameter edits are saved in your browser (localStorage) only.

## Run locally

```bash
npm install
npm run dev        # http://localhost:5199
npm run build      # static site in dist/
```

## Deploy

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to `main`.
One-time setup: **Settings → Pages → Source: GitHub Actions**.

## Where things live

- `src/features/` — the pages (engine steps, reservations, outputs, reports, run, admin)
- `src/mock/dataset.ts` — the sample universe and the simplified allocation every page reads
- `src/mock/handlers/` — the API routes, grouped by page area
- `src/mock/install.ts` — wires the routes into `fetch`, `EventSource` (live run progress) and Excel downloads
