/** Rebuilds a panel while keeping keyboard focus on the input with the same `data-k` (so Tab / typing survive re-renders). */
export function keepFocus(root: HTMLElement, rebuild: () => void): void {
  const active = document.activeElement as HTMLElement | null;
  const key = active && root.contains(active) ? active.dataset.k : undefined;
  // The panel itself or the column it sits in scrolls: keep that position across the rebuild.
  const scroller = (root.closest('.sprite-dock, .sidebar') as HTMLElement | null) ?? root;
  const scroll = scroller.scrollTop;
  rebuild();
  scroller.scrollTop = scroll;
  if (!key) return;
  const next = root.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`);
  next?.focus();
  if (next instanceof HTMLInputElement && (next.type === 'text' || next.type === 'number')) {
    try {
      next.select();
    } catch {
      /* number inputs may not support selection */
    }
  }
}
