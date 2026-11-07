/** Running and inspecting game scripts on the server (playtests, validation, editor dropdowns). */

import vm from 'node:vm';
import { ScriptHost, type ScriptEvaluator, type ScriptInfo } from '../core/game/script.js';
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
  return { behaviors: [...host.behaviors.keys()].sort(), functions: [...host.functions.keys()].sort(), errors: host.errors };
}

/** Syntax check without running anything. */
export function checkScriptSyntax(code: string, filename: string): string | null {
  try {
    new vm.Script(`(function () {"use strict";\n${code}\n})`, { filename, lineOffset: -1 });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export const SCRIPT_TEMPLATE = `// Scripts register behaviors, functions and hooks. See the reference on the right.

// An NPC you can talk to: give an object type the behavior { type: "script", name: "npc" }
// and a "line" property with what it says.
behavior('npc', {
  interact: async (self, player) => {
    self.face(player.x < self.x ? 'left' : 'right')
    await say(self.line || 'Hello!', { speaker: self.name })
  },
})

// A function you can call from an event with the action "Run script function".
func('reward', async (self, other, amount) => {
  vars.score = (vars.score || 0) + (amount || 1)
  sound('coin')
})
`;
