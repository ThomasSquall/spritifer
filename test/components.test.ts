import { describe, expect, it } from 'vitest';
import { World, runPlaytest } from '../src/core/game/engine.js';
import { validateGame } from '../src/core/game/catalog.js';
import { resolveImport, transformModule } from '../src/core/game/modules.js';
import { buildTypeDefinitions } from '../src/core/game/scriptApi.js';
import { type GameBundle, type SpriteAsset, createGame, createScene, normalizeObject } from '../src/core/game/types.js';
import { checkScriptSyntax, inspectScripts, nodeEvaluator } from '../src/server/scripts.js';

const box = (name: string, w = 16, h = 16): SpriteAsset => ({ name, width: w, height: h, frames: [{ x: 0, y: 0, w, h, duration: 100 }], tags: [], grid: null });

/** Top-down test world: player at the left, an enemy and a wall object. */
function bundle(scripts: Record<string, string>, enemyBehaviors: object[] = [{ type: 'script', name: 'Enemy' }]): GameBundle {
  const level = createScene({ name: 'level1', cols: 20, rows: 12, tileSize: 16 });
  level.instances.push({ id: 'p', object: 'player', x: 10, y: 10 });
  level.instances.push({ id: 'e1', object: 'enemy', x: 100, y: 10 });
  level.instances.push({ id: 'e2', object: 'enemy', x: 200, y: 10, components: { Enemy: { speed: 99 } } });
  const other = createScene({ name: 'level2', cols: 20, rows: 12, tileSize: 16 });
  const game = createGame({
    startScene: 'level1',
    variables: { score: 0 },
    objects: [
      normalizeObject({ name: 'player', sprite: 'hero', behaviors: [{ type: 'topdown', speed: 80 }] }),
      normalizeObject({ name: 'enemy', sprite: 'hero', properties: { hp: 3 }, behaviors: enemyBehaviors }),
    ],
  });
  return { game, scenes: { level1: level, level2: other }, sprites: { hero: box('hero') }, scripts };
}

const run = (b: GameBundle, seconds: number, extra: Parameters<typeof runPlaytest>[1] = { seconds: 0 }) => runPlaytest(b, { evaluator: nodeEvaluator, ...extra, seconds });

describe('module transform', () => {
  it('rewrites imports and exports and keeps line numbers', () => {
    const src = [
      "import Health from './Health'",
      "import { clamp, FOES as F } from 'utils/math'",
      'import {',
      '  a,',
      '  b',
      "} from '../x'",
      "const s = 'export default nope'",
      '// import nothing from "here"',
      'export const SPEED = 3',
      'export function f() { return `import ${1}` }',
      'export default class Patrol extends Behaviour {}',
    ].join('\n');
    const t = transformModule(src);
    expect(t.imports).toEqual(['./Health', 'utils/math', '../x']);
    expect(t.exports).toEqual(['SPEED', 'f']);
    expect(t.hasDefault).toBe(true);
    const lines = t.code.split('\n');
    expect(lines[0]).toBe('const Health = __import("./Health").default;');
    expect(lines[1]).toBe('const { clamp, FOES: F } = __import("utils/math");');
    expect(lines[6]).toBe("const s = 'export default nope'");
    expect(lines[8]).toBe('const SPEED = 3');
    expect(lines[10]).toBe('class Patrol extends Behaviour {}');
    expect(lines.length).toBe(12); // + the line with the export getters
    expect(lines[11]).toContain('__exports.default = Patrol');
  });

  it('resolves relative and bare paths', () => {
    expect(resolveImport('enemies/Patrol', './Health')).toBe('enemies/Health');
    expect(resolveImport('enemies/Patrol', '../utils/math.js')).toBe('utils/math');
    expect(resolveImport('enemies/Patrol', 'utils/math')).toBe('utils/math');
    expect(() => resolveImport('Patrol', '../../x')).toThrow(/outside/);
  });

  it('syntax-checks module code', () => {
    expect(checkScriptSyntax("import X from './X'\nexport default class A extends Behaviour { update(dt) { } }", 'a.js')).toBeNull();
    expect(checkScriptSyntax('export default class A extends Behaviour { update(dt) { }', 'a.js')).toMatch(/Unexpected|end of input|missing/i);
  });
});

const ENEMY = `
import { clamp } from 'utils/math'
/** Walks right and hurts the player. */
export default class Enemy extends Behaviour {
  speed = 10
  damage = 1
  mode = 'walk'
  _t = 0
  static params = { mode: ['walk', 'fly'], speed: { min: 0, max: 100, help: 'px/s' }, target: 'object' }
  awake() { this.health = this.getComponent('Health'); log('awake ' + this.self.name + ' ' + this.speed + ' ' + (this.health ? 'h' : '-')) }
  onEnable() { log('enable') }
  start() { log('start ' + this.target) }
  update(dt) { this._t += dt; this.self.x += clamp(this.speed, 0, 50) * dt }
  lateUpdate() { if (this._t > 0 && !this._late) { this._late = true; log('late') } }
  hit(n) { this.health.damage(n) }
}`;

const HEALTH = `
export default class Health extends Behaviour {
  hp = 3
  max = this.hp
  damage(n) { this.hp -= n; if (this.hp <= 0) this.destroy() }
  onDestroy() { vars.score += 1; log('died ' + this.self.name) }
}`;

describe('components', () => {
  const scripts = { 'utils/math': 'export const clamp = (v, a, b) => Math.max(a, Math.min(b, v))', 'enemies/Enemy': ENEMY, 'enemies/Health': HEALTH };

  it('reads params from fields and static params, hooks and methods', () => {
    const info = inspectScripts(scripts);
    expect(info.errors).toEqual([]);
    const enemy = info.components.find((c) => c.name === 'Enemy')!;
    expect(enemy.path).toBe('enemies/Enemy');
    expect(enemy.doc).toBe('Walks right and hurts the player.');
    expect(enemy.params.map((p) => [p.name, p.type, p.default])).toEqual([['speed', 'number', 10], ['damage', 'number', 1], ['mode', 'choice', 'walk'], ['target', 'object', '']]);
    expect(enemy.params[0]).toMatchObject({ min: 0, max: 100, help: 'px/s' });
    expect(enemy.hooks).toEqual(['awake', 'onEnable', 'start', 'update', 'lateUpdate']);
    expect(enemy.methods).toEqual(['hit']);
    expect(enemy.fields).toContain('_t');
    expect(info.behaviors).toEqual(['Enemy', 'Health']);
  });

  it('runs the lifecycle with type params and instance overrides', async () => {
    const b = bundle(scripts, [{ type: 'script', name: 'Enemy', speed: 20, target: 'player' }, { type: 'script', name: 'Health' }]);
    const r = await run(b, 1);
    const logs = r.logs.map((l) => l.replace(/^\[[\d.]+s\] /, ''));
    expect(logs).toContain('awake enemy 20 h');
    expect(logs).toContain('awake enemy 99 h');
    const i = (s: string) => logs.indexOf(s);
    expect(i('awake enemy 20 h')).toBeLessThan(i('enable'));
    expect(i('enable')).toBeLessThan(i('start player'));
    expect(i('start player')).toBeLessThan(i('late'));
    const [e1, e2] = r.final.actors.filter((a) => a.object === 'enemy');
    expect(e1.x).toBeCloseTo(120, 0);
    expect(e2.x).toBeCloseTo(250, 0); // speed 99 clamped to 50
  });

  it('calls other components (getComponent, findComponent, sendMessage) and destroys', async () => {
    const b = bundle({ ...scripts, Boss: `export default class Boss extends Behaviour {
      async start() {
        await this.wait(0.2)
        const e = findOne('enemy')
        e.getComponent('Enemy').hit(1)
        e.sendMessage('hit', 1)
        log('hp ' + e.getComponent('Health').hp + ' of ' + e.getComponent('Health').max)
        findComponents('Health').forEach((h) => h.damage(5))
        log('left ' + findComponents('Enemy').length + ' ' + (findComponent('Boss') === this))
      }
    }` }, [{ type: 'script', name: 'Enemy' }, { type: 'script', name: 'Health' }]);
    b.scenes.level1.components = [{ type: 'script', name: 'Boss' }];
    const r = await run(b, 1);
    expect(r.logs.some((l) => l.endsWith('hp 1 of 3'))).toBe(true);
    expect(r.logs.some((l) => l.endsWith('left 0 true'))).toBe(true);
    expect(r.final.globals.score).toBe(2);
    expect(r.final.actors.filter((a) => a.object === 'enemy')).toHaveLength(0);
  });

  it('fires collision enter/stay/exit and stops coroutines of destroyed components', async () => {
    const b = bundle({
      Touch: `export default class Touch extends Behaviour {
        _stay = 0
        onCollisionEnter(o) { log('enter ' + o.object) }
        onCollisionStay(o) { this._stay++ }
        onCollisionExit(o) { log('exit ' + o.object + ' ' + (this._stay > 3)) }
      }`,
      Slow: `export default class Slow extends Behaviour {
        async start() { await this.wait(0.5); log('should not happen') }
      }`,
    }, [{ type: 'script', name: 'Touch' }, { type: 'script', name: 'Slow' }]);
    b.scenes.level1.instances = [{ id: 'p', object: 'player', x: 60, y: 10 }, { id: 'e', object: 'enemy', x: 100, y: 10 }];
    b.game.objects[0].events.push({ trigger: { type: 'collision', with: 'enemy' }, conditions: [], actions: [] });
    b.game.objects[1].events.push({ trigger: { type: 'timer', seconds: 0.3, repeat: false }, conditions: [], actions: [{ type: 'destroy', target: 'self' }] });
    const r = await run(b, 1, { seconds: 0, inputs: [{ at: 0, key: 'right', duration: 0.5 }] });
    expect(r.logs.some((l) => l.endsWith('enter player'))).toBe(true);
    expect(r.logs.some((l) => l.includes('should not happen'))).toBe(false);
  });

  it('runs scene and global components; global ones survive scene changes', async () => {
    const b = bundle({
      GameManager: `export default class GameManager extends Behaviour {
        scenes = 0
        awake() { GameManager.instance = this }
        onSceneStart(name) { this.scenes++; log('scene ' + name + ' #' + this.scenes) }
        onSceneEnd(name) { log('end ' + name) }
        async start() { await this.wait(0.6); log('global wait survived ' + scene.name) }
        onDraw(ui) { ui.text('S' + this.scenes, 0, 0) }
      }`,
      Level: `import GameManager from './GameManager'
      export default class Level extends Behaviour {
        next = 'level2'
        static params = { next: 'scene' }
        start() { log('level start, manager ' + (GameManager.instance === findComponent(GameManager))) }
        update() { if (game.time > 0.3) goto(this.next) }
      }`,
    }, []);
    b.game.components = [{ type: 'script', name: 'GameManager' }];
    b.scenes.level1.components = [{ type: 'script', name: 'Level' }];
    const r = await run(b, 1);
    const tail = (s: string) => r.logs.some((l) => l.endsWith(s));
    expect(tail('scene level1 #1')).toBe(true);
    expect(tail('level start, manager true')).toBe(true);
    expect(tail('end level1')).toBe(true);
    expect(tail('scene level2 #2')).toBe(true);
    expect(tail('global wait survived level2')).toBe(true);
  });

  it('adds and removes components at runtime and toggles enabled', async () => {
    const b = bundle({
      Spin: `export default class Spin extends Behaviour {
        speed = 1
        onEnable() { log('on') }
        onDisable() { log('off') }
        update() { this.self.angle += this.speed }
        onDestroy() { log('removed') }
      }`,
      Adder: `export default class Adder extends Behaviour {
        async start() {
          const s = this.self.addComponent('Spin', { speed: 5 })
          await this.wait(0.1)
          s.enabled = false
          await this.wait(0.1)
          s.enabled = true
          this.self.removeComponent('Spin')
          log('angle ' + this.self.angle + ' ' + this.self.getComponents().length)
        }
      }`,
    }, [{ type: 'script', name: 'Adder' }]);
    b.scenes.level1.instances = [{ id: 'e', object: 'enemy', x: 100, y: 10 }];
    const w = new World(b, { evaluator: nodeEvaluator });
    for (let i = 0; i < 40; i++) {
      w.step();
      await w.settle();
    }
    const logs = w.logs.map((l) => l.replace(/^\[[\d.]+s\] /, ''));
    expect(logs.filter((l) => ['on', 'off', 'removed'].includes(l))).toEqual(['on', 'off', 'on', 'off', 'removed']);
    const angle = Number(logs.find((l) => l.startsWith('angle'))!.split(' ')[1]);
    expect(angle).toBeGreaterThan(20);
    expect(logs.find((l) => l.startsWith('angle'))!.endsWith(' 1')).toBe(true);
  });

  it('calls component methods from events', async () => {
    const b = bundle({ Bank: `export default class Bank extends Behaviour { gold = 0; deposit(n) { this.gold += n; vars.score = this.gold } }` }, [{ type: 'script', name: 'Bank' }]);
    b.scenes.level1.instances = [{ id: 'e', object: 'enemy', x: 100, y: 10 }];
    b.game.objects[1].events.push({ trigger: { type: 'timer', seconds: 0.1, repeat: true }, conditions: [], actions: [{ type: 'callMethod', target: 'self', component: 'Bank', method: 'deposit', arg: '5' }] });
    const r = await run(b, 0.55);
    expect(r.final.globals.score).toBe(25);
  });

  it('remembers component fields in persistent scenes', async () => {
    const b = bundle({ Chest: `export default class Chest extends Behaviour {
      _opened = false
      start() { log('opened ' + this._opened); this._opened = true }
    }`, Back: `export default class Back extends Behaviour { update() { if (game.time > 0.2) goto(scene.name === 'level1' ? 'level2' : 'level1') } }` }, [{ type: 'script', name: 'Chest' }]);
    b.scenes.level1.persistent = true;
    b.scenes.level1.instances = [{ id: 'e', object: 'enemy', x: 100, y: 10 }];
    b.game.components = [{ type: 'script', name: 'Back' }];
    const r = await run(b, 0.7);
    expect(r.logs.filter((l) => l.includes('opened')).map((l) => l.split('] ')[1])).toEqual(['opened false', 'opened true']);
  });

  it('keeps legacy behavior() registrations working', async () => {
    const b = bundle({ old: `behavior('Enemy', { create(self, p) { log('created ' + p.speed) }, update(self, dt) { self.x += 1 } })` }, [{ type: 'script', name: 'Enemy', speed: 7 }]);
    const r = await run(b, 0.2);
    expect(r.logs.some((l) => l.endsWith('created 7'))).toBe(true);
    expect(r.final.actors.find((a) => a.object === 'enemy')!.x).toBeGreaterThan(105);
  });

  it('reports missing components, unknown params and import errors', () => {
    const b = bundle(scripts, [{ type: 'script', name: 'Enemy', speeed: 3 }, { type: 'script', name: 'Nope' }]);
    b.scenes.level1.instances[1].components = { Enemy: { mode: 'swim' } };
    b.scenes.level1.components = [{ type: 'script', name: 'Enemy', target: 'ghost' }];
    const info = inspectScripts({ ...scripts, broken: "import X from './missing'" });
    const problems = validateGame(b.game, Object.values(b.scenes), new Set(['hero']), info).map((p) => `${p.where}: ${p.message}`);
    expect(problems.some((p) => p.includes('has no param "speeed"'))).toBe(true);
    expect(problems.some((p) => p.includes('no component "Nope"'))).toBe(true);
    expect(problems.some((p) => p.includes('"swim" is not one of walk, fly'))).toBe(true);
    expect(problems.some((p) => p.includes('no object type "ghost"'))).toBe(true);
    expect(problems.some((p) => p.includes('Cannot find script "missing"'))).toBe(true);
  });

  it('rejects duplicate component names and classes not extending Behaviour', () => {
    const info = inspectScripts({ 'a/Enemy': 'export default class Enemy extends Behaviour {}', 'b/Enemy': 'export default class Enemy extends Behaviour {}', Plain: 'export default class Plain {}' });
    expect(info.errors.some((e) => e.includes('already used by scripts/a/Enemy.js'))).toBe(true);
    expect(info.errors.some((e) => e.includes("doesn't extend Behaviour"))).toBe(true);
  });

  it('generates TypeScript declarations for IDEs', () => {
    const d = buildTypeDefinitions({ components: [{ name: 'Enemy', path: 'enemies/Enemy' }], objects: ['player'], scenes: ['level1'], sounds: ['coin'], dialogues: [], variables: { score: 0 }, properties: { hp: 3 } });
    expect(d).toContain('"Enemy": import("./enemies/Enemy.js").default;');
    expect(d).toContain('declare class Behaviour');
    expect(d).toContain('getComponent<K extends keyof ComponentMap>(type: K): ComponentMap[K] | null;');
    expect(d).toContain('score: number;');
    expect(d).toContain('declare function say(');
  });
});

import { Workspace } from '../src/server/store.js';
import { loadGameBundle } from '../src/server/game.js';
import { fileURLToPath } from 'node:url';

describe('village example', () => {
  const ws = new Workspace(fileURLToPath(new URL('../examples/village/', import.meta.url)));

  it('loads its component scripts from folders without problems', () => {
    const { problems, scriptInfo } = loadGameBundle(ws);
    expect(problems).toEqual([]);
    expect(scriptInfo.components.map((c) => c.path)).toEqual(['battle/Battle', 'enemies/Monster', 'ui/TownHud']);
  });

  it('plays a battle driven by the Battle scene component', async () => {
    const { bundle } = loadGameBundle(ws);
    const r = await runPlaytest(bundle, { seconds: 30, scene: 'battle', choices: Array(20).fill(0), evaluator: nodeEvaluator });
    expect(r.logs.some((l) => l.includes('A wild Slime appears!'))).toBe(true);
    expect(r.logs.some((l) => l.includes('Victory!') || l.includes('You fainted'))).toBe(true);
    expect(r.logs.some((l) => l.includes('ERROR'))).toBe(false);
    expect(r.final.scene).toBe('town');
  });
});
