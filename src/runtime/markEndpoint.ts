/**
 * Where a game page sends its F8 "mark here" reports: only a page served by the editor's server says so, with
 * window.SPRITIFER_DEV = { marks: "marks" } (relative to the page). An exported game has no such flag, whatever its
 * address, and F8 does nothing there (the code is not even in its runtime).
 */
export function markEndpoint(dev: { marks?: unknown } | undefined, href: string): string | null {
  if (!dev || typeof dev.marks !== 'string' || !dev.marks) return null;
  try {
    const u = new URL(dev.marks, href);
    const page = new URL(href);
    // the reports go back to the server that served the page, never elsewhere
    return u.origin === page.origin && (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch {
    return null;
  }
}

/** The player for an F8 mark: the instance the camera follows, otherwise the first one moved by the keys. */
export function playerOf(world: { cameraHeld: { destroyed: boolean } | null; actors: readonly { destroyed: boolean; type: { behaviors: readonly { type: string }[] } }[] }) {
  const held = world.cameraHeld && !world.cameraHeld.destroyed ? world.cameraHeld : null;
  return held ?? world.actors.find((a) => !a.destroyed && a.type.behaviors.some((b) => b.type === 'topdown' || b.type === 'platformer')) ?? null;
}
