import { useState, useEffect, Suspense, type ReactNode } from 'react';
import PageFallback from './PageFallback';

/**
 * Keeps a page MOUNTED once it has first been shown, and thereafter only toggles its VISIBILITY when you navigate
 * away and back — so the page's local state (search box, sort, pagination, open rows, sub-tabs) SURVIVES navigation
 * and is NOT rebuilt each time you return. It resets only on a full browser refresh (the whole tree is recreated).
 *
 * `display: contents` while active keeps this wrapper transparent to layout — the page renders exactly as if it were
 * a direct child of the content area (heights / sticky headers behave identically). `display: none` while hidden
 * fully removes it from layout and freezes it (its effects don't fire again until it — or its props — change).
 *
 * Pages are still LAZY: nothing mounts until the first time it becomes active, so unvisited pages cost nothing.
 * They are also CODE-SPLIT — App.tsx passes each page as a React.lazy() component, so its JS chunk only downloads
 * the first time it becomes active. The <Suspense> here shows a small loader while that first chunk arrives; it's
 * per-page (this wrapper renders nothing until `active`), so opening a new page never blanks the pages already open.
 */
export default function KeepAlive({ active, children }: { active: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(active);
  useEffect(() => { if (active) setMounted(true); }, [active]);   // latch: once shown, stay mounted
  if (!mounted) return null;
  return (
    <div style={{ display: active ? 'contents' : 'none' }}>
      <Suspense fallback={active ? <PageFallback /> : null}>{children}</Suspense>
    </div>
  );
}
