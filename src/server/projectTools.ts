/** What the find-usages, world map and test features need from a project, for the editor and the MCP server alike. */

import type { Problem } from '../core/game/catalog.js';
import { type GameTest, type TestOutcome, runGameTest } from '../core/game/gameTests.js';
import type { SizeOf } from '../core/game/sceneOps.js';
import { resolveObjectTypes } from '../core/game/variants.js';
import type { ProjectSources } from '../core/game/usages.js';
import { type WorldMap, buildWorldMap, checkMaps } from '../core/game/worldMap.js';
import { type LoadedGame, loadGameBundle } from './game.js';
import { inspectScripts, nodeEvaluator } from './scripts.js';
import type { Workspace } from './store.js';

export function loadSources(ws: Workspace): ProjectSources {
  const scripts = ws.loadScripts();
  return {
    game: ws.loadGame(),
    scenes: ws.listScenes().map((s) => ws.loadScene(s.name)),
    scripts,
    dialogues: ws.loadDialogues(),
    tables: ws.loadTables(),
    vfx: ws.loadAllVfx(),
    components: inspectScripts(scripts).components,
  };
}

const spriteSizes = (ws: Workspace) => new Map(ws.list().map((s) => [s.name, { w: s.width, h: s.height }]));

/** Size of what a placed instance shows, for code that needs where its base is. */
export function instanceSizes(ws: Workspace, tile: number): SizeOf {
  const sizes = spriteSizes(ws);
  const { types } = resolveObjectTypes(ws.loadGame().objects);
  return (item) => sizes.get(item.sprite ?? types.get(item.object)?.sprite ?? '') ?? { w: tile, h: tile };
}

export function mapReport(ws: Workspace): { world: WorldMap; problems: Problem[]; minimaps: Record<string, string> } {
  const sources = loadSources(ws);
  const world = buildWorldMap(sources);
  const sizes = spriteSizes(ws);
  // One character per tile, row by row: "1" = solid. Enough for a small drawing of each map.
  const minimaps = Object.fromEntries(sources.scenes.map((s) => {
    const solid = new Array<string>(s.cols * s.rows).fill('0');
    for (const l of s.layers) if (l.solid) l.tiles.forEach((t, k) => { if (t >= 0) solid[k] = '1'; });
    return [s.name, solid.join('')];
  }));
  return { world, problems: checkMaps(sources, world, (sprite) => sizes.get(sprite ?? '')), minimaps };
}

export interface TestRun {
  outcomes: TestOutcome[];
  /** The world of each failed test, for a screenshot. */
  failed: { name: string; world: Awaited<ReturnType<typeof runGameTest>>['result']['world'] }[];
  loaded: LoadedGame;
}

export async function runTests(ws: Workspace, names?: string[]): Promise<TestRun> {
  const tests: GameTest[] = (names?.length ? names : ws.listTests().map((t) => t.name)).map((n) => ws.loadTest(n));
  const loaded = loadGameBundle(ws);
  const outcomes: TestOutcome[] = [];
  const failed: TestRun['failed'] = [];
  for (const test of tests) {
    const { result, ...outcome } = await runGameTest(loaded.bundle, test, nodeEvaluator);
    outcomes.push(outcome);
    if (!outcome.passed) failed.push({ name: test.name, world: result.world });
  }
  return { outcomes, failed, loaded };
}

export function formatTestRun(outcomes: TestOutcome[]): string {
  if (!outcomes.length) return 'No tests yet. Record one in Play, or use write_test.';
  const passed = outcomes.filter((o) => o.passed).length;
  const lines = [`${passed} of ${outcomes.length} test(s) passed.`];
  for (const o of outcomes) {
    lines.push(`${o.passed ? 'PASS' : 'FAIL'} ${o.name} (${o.seconds.toFixed(1)}s, ended in ${o.finalScene})`);
    for (const f of o.failures) lines.push(`  - ${f}`);
    if (!o.passed && o.logs.length) lines.push('  last log lines:', ...o.logs.slice(-8).map((l) => `    ${l}`));
  }
  return lines.join('\n');
}
