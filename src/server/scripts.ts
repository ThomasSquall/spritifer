/** Running and inspecting game scripts on the server (playtests, validation, editor dropdowns). */

import vm from 'node:vm';
import { ScriptHost, type ScriptEvaluator, type ScriptInfo } from '../core/game/script.js';
import { scriptBaseName, transformModule } from '../core/game/modules.js';
import { COMPONENT_TEMPLATE, PLAIN_SCRIPT_TEMPLATE, buildTypeDefinitions } from '../core/game/scriptApi.js';
import { SOUNDS } from '../core/game/catalog.js';
import { buildDialogueBook } from '../core/game/dialogue.js';
import type { Value } from '../core/game/types.js';
import type { Workspace } from './store.js';
import { LIBRARY_MAP } from '../core/game/library.js';
import type { World } from '../core/game/engine.js';

/**
 * Evaluates a script in its own V8 context, so scripts don't see Node globals (process, require...).
 * Not a security boundary: scripts are the project's own code. Top-level code gets a 1s time limit.
 */
export const nodeEvaluator: ScriptEvaluator = (code, api, filename) => {
  const names = Object.keys(api);
  const context = vm.createContext({ __args: names.map((n) => api[n]) });
  vm.runInContext(`(function (${names.join(', ')}) {"use strict";\n${code}\n}).apply(undefined, __args)`, context, { filename, timeout: 1000, lineOffset: -1 });
};

/** What the scripts register (behavior and function names) and the errors loading them. */
export function inspectScripts(scripts: Record<string, string>): ScriptInfo {
  const logs: string[] = [];
  // A stand-in world: registration only needs logging; game state is empty.
  const fake = { log: (m: string) => logs.push(m), globals: {}, sceneVars: {}, actors: [], opts: {} } as unknown as World;
  const host = new ScriptHost(fake);
  host.load(scripts, nodeEvaluator);
  return { behaviors: [...host.components.keys()].sort(), functions: [...host.functions.keys()].sort(), errors: host.errors, components: host.componentInfo() };
}

/** Syntax check without running anything. */
export function checkScriptSyntax(code: string, filename: string): string | null {
  try {
    new vm.Script(`(function () {"use strict";\n${transformModule(code).code}\n})`, { filename, lineOffset: -1 });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export { COMPONENT_TEMPLATE, PLAIN_SCRIPT_TEMPLATE } from '../core/game/scriptApi.js';

/** Starting code for a new script: a component class named after the file, or a plain module. */
export function scriptTemplate(name: string, kind: 'component' | 'script' = 'component'): string {
  return kind === 'component' ? COMPONENT_TEMPLATE(scriptBaseName(name)) : PLAIN_SCRIPT_TEMPLATE;
}

/** @deprecated kept for callers that create a script without saying which kind. */
export const SCRIPT_TEMPLATE = PLAIN_SCRIPT_TEMPLATE;

const JSCONFIG = `${JSON.stringify({
  compilerOptions: { allowJs: true, checkJs: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', paths: { '*': ['./*'] }, lib: ['ES2022'], noEmit: true },
  include: ['**/*.js', 'spritifer.d.ts'],
}, null, 2)}\n`;

/**
 * Writes scripts/jsconfig.json and scripts/spritifer.d.ts so VS Code / JetBrains autocomplete the game API,
 * getComponent('Name') return types and the project's objects, scenes and variables. Only when there are scripts.
 */
export function refreshScriptTypes(ws: Workspace, info?: ScriptInfo): boolean {
  try {
    if (!ws.listScripts().length) return false;
    const i = info ?? inspectScripts(ws.loadScripts());
    const game = ws.loadGame();
    const properties: Record<string, Value> = {};
    for (const o of game.objects) Object.assign(properties, o.properties);
    const dialogues = [...buildDialogueBook(ws.loadDialogues()).nodes.keys()].sort();
    const dts = buildTypeDefinitions({
      components: i.components.filter((c) => c.path).map((c) => ({ name: c.name, path: c.path })),
      objects: game.objects.map((o) => o.name),
      scenes: ws.listScenes().map((s) => s.name),
      sounds: SOUNDS,
      dialogues,
      variables: game.variables,
      properties,
      tags: [...new Set(game.objects.flatMap((o) => o.tags ?? []))].sort(),
      audio: ws.listAudio().map((a) => a.name),
      vfx: ws.listVfx().map((g) => g.name),
      tables: Object.fromEntries(Object.values(ws.loadTables()).map((t) => [t.name, { description: t.description, columns: t.columns }])),
    });
    const a = ws.writeScriptSupportFile('jsconfig.json', JSCONFIG);
    const b = ws.writeScriptSupportFile('spritifer.d.ts', dts);
    return a || b;
  } catch {
    return false;
  }
}

export const DIALOGUE_TEMPLATE = `# Dialogues: one file can hold many. Give an NPC object type the behavior "Talks (dialogue)",
# then set each placed instance's "dialogue" property (and its Name) in the scene inspector.

=== villager
self: Nice weather today!
* Ask about the village
  self: It's small, but we like it here.
* Say goodbye
  self: See you around!
`;

/**
 * Copies ready-made components (and the ones they need, e.g. Damage → Health) into scripts/<folder>/.
 * Components that already exist (same name, any folder) are left alone. Returns the created paths.
 */
export function addLibraryComponents(ws: Workspace, names: string[]): { created: string[]; existing: string[] } {
  const have = new Set(ws.listScripts().map((s) => scriptBaseName(s.name)));
  const created: string[] = [];
  const existing: string[] = [];
  const add = (name: string) => {
    const c = LIBRARY_MAP.get(name);
    if (!c) throw new Error(`No library component "${name}". Available: ${[...LIBRARY_MAP.keys()].join(', ')}`);
    for (const r of c.requires ?? []) add(r);
    if (have.has(name)) {
      if (!existing.includes(name) && !created.some((p) => scriptBaseName(p) === name)) existing.push(name);
      return;
    }
    const path = `${c.folder}/${c.name}`;
    ws.writeScript(path, c.code);
    have.add(name);
    created.push(path);
  };
  for (const n of names) add(n);
  if (created.length) refreshScriptTypes(ws);
  return { created, existing };
}
