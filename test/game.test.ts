import { describe, expect, it } from 'vitest';
import { compile, checkExpr } from '../src/core/game/expr.js';
import { World, emptyInput, renderWorld, runPlaytest } from '../src/core/game/engine.js';
import { validateGame } from '../src/core/game/catalog.js';
import { type GameBundle, type Instance, type Scene, type SpriteAsset, createGame, createScene, footLineProblem, normalizeObject, normalizeScene as normalizeSceneForTest } from '../src/core/game/types.js';
import { BUILTIN_FONT, PIXEL_OPERATOR, gameFont, measureText, rasterText } from '../src/core/game/font.js';
import { wrapText } from '../src/core/game/script.js';
import { nodeEvaluator } from '../src/server/scripts.js';
import { renderViewport } from '../src/server/game.js';
import type { Bitmap } from '../src/core/sprite.js';

const ctx = (vars: Record<string, number | string | boolean> = {}) => ({
  get: (p: string[]) => vars[p.join('.')],
  call: (n: string, a: (number | string | boolean)[]) => (n === 'max' ? Math.max(...(a as number[])) : 0),
});

const box = (name: string, w = 16, h = 16, tags: SpriteAsset['tags'] = []): SpriteAsset => ({
  name,
  width: w,
  height: h,
  frames: [{ x: 0, y: 0, w, h, duration: 100 }, { x: w, y: 0, w, h, duration: 100 }],
  tags,
  grid: null,
});

/** A 20x12 tile scene (16px tiles) with a solid floor on the bottom row. */
function platformBundle(extra: Partial<Parameters<typeof createGame>[0]> = {}): GameBundle {
  const scene = createScene({ name: 'level1', cols: 20, rows: 12, tileSize: 16, tileset: 'tiles' });
  for (let x = 0; x < 20; x++) scene.layers[0].tiles[11 * 20 + x] = 0;
  scene.instances.push({ id: 'p', object: 'player', x: 32, y: 100 });
  scene.instances.push({ id: 'c1', object: 'coin', x: 96, y: 160 });
  scene.instances.push({ id: 'c2', object: 'coin', x: 128, y: 160 });
  const game = createGame({
    title: 'Test',
    startScene: 'level1',
    variables: { score: 0 },
    objects: [
      normalizeObject({ name: 'player', sprite: 'hero', behaviors: [{ type: 'platformer', speed: 100, jump: 300 }, { type: 'camera' }], events: [
        { trigger: { type: 'collision', with: 'coin' }, conditions: [], actions: [{ type: 'add', target: 'score', value: '10' }, { type: 'destroy', target: 'other' }] },
      ] }),
      normalizeObject({ name: 'coin', sprite: 'coin', properties: { value: 10 } }),
    ],
    ...extra,
  });
  return {
    game,
    scenes: { level1: scene },
    sprites: { hero: box('hero', 16, 16, [{ name: 'idle', from: 0, to: 0, direction: 'forward' }, { name: 'run', from: 0, to: 1, direction: 'forward' }]), coin: box('coin', 8, 8), tiles: { ...box('tiles', 16, 16), grid: { width: 16, height: 16 } } },
  };
}

describe('expressions', () => {
  it('evaluates arithmetic, comparisons, strings and ternaries', async () => {
    expect(compile('1 + 2 * 3')(ctx())).toBe(7);
    expect(compile('(1 + 2) * 3')(ctx())).toBe(9);
    expect(compile('-2 * 3 + 10 % 4')(ctx())).toBe(-4);
    expect(compile('"Score: " + score')(ctx({ score: 42 }))).toBe('Score: 42');
    expect(compile('self.hp <= 0 && !dead')(ctx({ 'self.hp': 0, dead: false }))).toBe(true);
    expect(compile('a > 1 ? "big" : "small"')(ctx({ a: 0 }))).toBe('small');
    expect(compile('max(1, 5, 3)')(ctx())).toBe(5);
    expect(compile('x = 3')(ctx({ x: 3 }))).toBe(true);
    expect(compile('10 / 0')(ctx())).toBe(0);
  });

  it('reports syntax errors', async () => {
    expect(checkExpr('1 +')).toMatch(/end/);
    expect(checkExpr('"open')).toMatch(/Unterminated/);
    expect(checkExpr('score >= 10')).toBeNull();
  });
});

describe('font', () => {
  it('measures and rasterizes text', async () => {
    expect(measureText('AB')).toEqual({ width: 7, height: 5 });
    let n = 0;
    rasterText('I', () => n++);
    expect(n).toBe(9);
  });

  it('draws Pixel Operator with real lowercase and accents', async () => {
    const pixels = (t: string) => { const out: string[] = []; rasterText(t, (x, y) => out.push(`${x},${y}`), PIXEL_OPERATOR); return out.join(' '); };
    expect(pixels('a')).not.toBe(pixels('A'));
    expect(pixels('è')).not.toBe(pixels('e'));
    expect(measureText('H', PIXEL_OPERATOR)).toEqual({ width: 3, height: 5 });
    expect(measureText('a\nb', PIXEL_OPERATOR).height).toBe(12);
  });

  it('picks the game font only when it lands on whole pixels', async () => {
    expect(gameFont({ font: 'pixel-operator', uiScale: 2 })).toBe(PIXEL_OPERATOR);
    expect(gameFont({ font: 'pixel-operator', uiScale: 3 })).toBe(BUILTIN_FONT);
    expect(gameFont({})).toBe(BUILTIN_FONT);
  });

  it('wraps proportional text by width', async () => {
    const lines = wrapText('il il il il il mmmmmm', 30, PIXEL_OPERATOR);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measureText(l, PIXEL_OPERATOR).width).toBeLessThanOrEqual(30);
    expect(wrapText('AB CD EF', 11)).toEqual(['AB', 'CD', 'EF']);
  });
});

describe('engine', () => {
  it('lands a platformer on solid tiles', async () => {
    const w = new World(platformBundle());
    for (let i = 0; i < 90; i++) w.step();
    const p = w.actors.find((a) => a.type.name === 'player')!;
    expect(p.onGround).toBe(true);
    expect(p.y).toBe(11 * 16 - 16);
    expect(p.anim).toBe('idle');
  });

  it('runs right, collects coins through collision events and destroys them', async () => {
    const r = await runPlaytest(platformBundle(), { seconds: 2.5, inputs: [{ at: 0.5, key: 'right', duration: 1.6 }] });
    expect(r.final.globals.score).toBe(20);
    expect(r.final.actors.filter((a) => a.object === 'coin')).toHaveLength(0);
    const p = r.final.actors.find((a) => a.object === 'player')!;
    expect(p.x).toBeGreaterThan(140);
  });

  it('jumps when the jump key is pressed and lands again', async () => {
    const r = await runPlaytest(platformBundle(), { seconds: 3, inputs: [{ at: 1, key: 'up', duration: 0.3 }], sampleAt: [1.25, 3] });
    const mid = r.samples[0].actors.find((a) => a.object === 'player')!;
    const end = r.samples[1].actors.find((a) => a.object === 'player')!;
    expect(mid.y).toBeLessThan(140);
    expect(mid.onGround).toBe(false);
    expect(end.onGround).toBe(true);
  });

  it('switches scenes, keeps globals and runs scene timers and messages', async () => {
    const b = platformBundle();
    const s2 = createScene({ name: 'end', cols: 10, rows: 10 });
    s2.events.push({ trigger: { type: 'start' }, conditions: [], actions: [{ type: 'log', value: '"won with " + score' }] });
    b.scenes.end = s2;
    b.scenes.level1.events.push(
      { trigger: { type: 'timer', seconds: 0.5, repeat: false }, conditions: [], actions: [{ type: 'set', target: 'score', value: '5' }, { type: 'emit', message: 'done' }] },
      { trigger: { type: 'message', message: 'done' }, conditions: [{ type: 'expr', expr: 'score == 5' }], actions: [{ type: 'gotoScene', scene: 'end' }] },
    );
    const r = await runPlaytest(b, { seconds: 1 });
    expect(r.final.scene).toBe('end');
    expect(r.logs.some((l) => l.includes('won with 5'))).toBe(true);
  });

  it('spawns bullets that move and die on walls, and patrols turn at walls', async () => {
    const b = platformBundle();
    b.game.objects.push(
      normalizeObject({ name: 'bullet', sprite: 'coin', behaviors: [{ type: 'bullet', speed: 300, angle: 180 }] }),
      normalizeObject({ name: 'enemy', sprite: 'coin', behaviors: [{ type: 'patrol', speed: 60 }] }),
    );
    b.game.objects[0].events.push({ trigger: { type: 'keyPressed', key: 'action' }, conditions: [], actions: [{ type: 'spawn', object: 'bullet', x: '0', y: '4' }] });
    b.scenes.level1.instances.push({ id: 'e', object: 'enemy', x: 250, y: 160 });
    const w = new World(b);
    const input = emptyInput();
    w.step();
    input.down.add('action');
    input.pressed.add('action');
    w.step(input);
    expect(w.actors.filter((a) => a.type.name === 'bullet')).toHaveLength(1);
    for (let i = 0; i < 60; i++) w.step();
    expect(w.actors.filter((a) => a.type.name === 'bullet')).toHaveLength(0);
    // The enemy reached the right edge and turned around.
    for (let i = 0; i < 120; i++) w.step();
    const e = w.actors.find((a) => a.type.name === 'enemy')!;
    expect(e.patrolDir).toBe(-1);
  });

  it('evaluates text objects and instance properties', async () => {
    const b = platformBundle();
    b.game.objects.push(normalizeObject({ name: 'hud', text: '"Score: " + score', hud: true }));
    b.scenes.level1.instances.push({ id: 'h', object: 'hud', x: 4, y: 4 });
    b.game.objects[1].events.push({ trigger: { type: 'created' }, conditions: [], actions: [{ type: 'log', value: 'self.value * 2' }] });
    const w = new World(b);
    w.step();
    expect(w.actors.find((a) => a.type.name === 'hud')!.textOverride).toBe('Score: 0');
    expect(w.logs.filter((l) => l.endsWith(' 20'))).toHaveLength(2);
  });

  it('top-down movement picks directional animations', async () => {
    const b = platformBundle();
    b.game.objects[0].behaviors = [{ type: 'topdown', speed: 80 }];
    b.sprites.hero.tags = [
      { name: 'idle_down', from: 0, to: 0, direction: 'forward' },
      { name: 'walk_right', from: 0, to: 1, direction: 'forward' },
      { name: 'walk_up', from: 0, to: 1, direction: 'forward' },
    ];
    const r = await runPlaytest(b, { seconds: 1, inputs: [{ at: 0, key: 'right', duration: 0.5 }, { at: 0.5, key: 'up', duration: 0.5 }], sampleAt: [0.4] });
    expect(r.samples[0].actors.find((a) => a.object === 'player')!.animation).toBe('walk_right');
    expect(r.final.actors.find((a) => a.object === 'player')!.animation).toBe('walk_up');
  });

  describe('top-down running', () => {
    const walkRun = [
      { name: 'idle_right', from: 0, to: 0, direction: 'forward' as const },
      { name: 'walk_right', from: 0, to: 1, direction: 'forward' as const },
      { name: 'run_right', from: 0, to: 1, direction: 'forward' as const },
    ];
    const player = (r: Awaited<ReturnType<typeof runPlaytest>>) => r.final.actors.find((a) => a.object === 'player')!;
    const hold = (...keys: string[]) => keys.map((key) => ({ at: 0, key, duration: 2 }));
    const play = async (behavior: Record<string, unknown>, tags: SpriteAsset['tags'], keys: string[]) => {
      const b = platformBundle();
      b.game.objects[0].behaviors = [{ type: 'topdown', ...behavior }];
      b.sprites.hero.tags = tags;
      return player(await runPlaytest(b, { seconds: 1, inputs: hold(...keys) }));
    };

    it('runs at runSpeed with the run animation while Shift is held', async () => {
      const walked = await play({ speed: 40, runSpeed: 120 }, walkRun, ['right']);
      const ran = await play({ speed: 40, runSpeed: 120 }, walkRun, ['right', 'shift']);
      expect(walked.animation).toBe('walk_right');
      expect(ran.animation).toBe('run_right');
      expect(ran.x - 32).toBeCloseTo(120, -1);
      expect(walked.x - 32).toBeCloseTo(40, -1);
    });

    it('keeps the walk animation at run speed on sprites without run animations', async () => {
      const ran = await play({ speed: 40, runSpeed: 120 }, walkRun.filter((t) => t.name !== 'run_right'), ['right', 'shift']);
      expect(ran.animation).toBe('walk_right');
      expect(ran.x - 32).toBeCloseTo(120, -1);
    });

    it('ignores Shift without a run speed', async () => {
      const ran = await play({ speed: 40 }, walkRun, ['right', 'shift']);
      expect(ran.animation).toBe('walk_right');
      expect(ran.x - 32).toBeCloseTo(40, -1);
    });
  });

  it('validates references and expressions', async () => {
    const b = platformBundle();
    b.game.objects[0].events.push({ trigger: { type: 'keyPressed', key: 'nope' }, conditions: [{ type: 'expr', expr: '1 +' }], actions: [{ type: 'gotoScene', scene: 'missing' }] });
    const problems = validateGame(b.game, Object.values(b.scenes), new Set(Object.keys(b.sprites)));
    const msgs = problems.map((p) => p.message).join('\n');
    expect(msgs).toMatch(/unknown key "nope"/);
    expect(msgs).toMatch(/end of/);
    expect(msgs).toMatch(/no scene "missing"/);
  });
});

describe('engine behaviors combine', () => {
  it('lets a floating (sine) instance fall with its velocity', async () => {
    const b = platformBundle();
    b.game.objects.push(normalizeObject({ name: 'drop', sprite: 'coin', behaviors: [{ type: 'sine', amplitude: 2, period: 1 }] }));
    const w = new World(b);
    w.step();
    const d = w.spawn('drop', 50, 0, 0, 60)!;
    for (let i = 0; i < 60; i++) w.step();
    expect(d.y).toBeGreaterThan(55);
    expect(d.y).toBeLessThan(65);
  });
});

describe('leaving the scene', () => {
  it('fires only when an instance moves from inside to outside', async () => {
    const b = platformBundle();
    b.game.objects.push(normalizeObject({ name: 'drop', sprite: 'coin', events: [{ trigger: { type: 'leftScene' }, conditions: [], actions: [{ type: 'log', value: '"gone"' }, { type: 'destroy', target: 'self' }] }] }));
    const w = new World(b);
    w.step();
    const d = w.spawn('drop', 50, -20, 0, 100)!;
    for (let i = 0; i < 30; i++) w.step();
    expect(d.destroyed).toBe(false);
    for (let i = 0; i < 150; i++) w.step();
    expect(d.destroyed).toBe(true);
    expect(w.logs.filter((l) => l.endsWith('gone'))).toHaveLength(1);
  });
});

describe('scripts', () => {
  const rpg = () => {
    const b = platformBundle();
    b.game.objects[0].behaviors = [{ type: 'topdown', speed: 80 }];
    b.game.objects.push(normalizeObject({ name: 'npc', sprite: 'coin', properties: { line: 'Hi there' }, behaviors: [{ type: 'script', name: 'npc' }] }));
    b.game.variables.gold = 0;
    b.scenes.level1.instances = [{ id: 'p', object: 'player', x: 40, y: 160 }, { id: 'n', object: 'npc', x: 58, y: 164 }];
    return b;
  };

  it('runs NPC dialogs with choices on interact, waits and functions from events', async () => {
    const b = rpg();
    b.scripts = {
      npcs: `behavior('npc', {
        interact: async (self, player) => {
          await say(self.line, { speaker: self.name })
          const c = await choose(['Buy', 'Leave'], { text: 'Want a potion?' })
          if (c === 0) { vars.gold -= 5; log('bought') } else log('left')
          await wait(0.5)
          log('done at ' + Math.round(game.clock))
        },
      })
      func('pay', (self, other, amount) => { vars.gold += amount })`,
    };
    b.scenes.level1.events.push({ trigger: { type: 'start' }, conditions: [], actions: [{ type: 'call', function: 'pay', arg: '10' }] });
    const r = await runPlaytest(b, { seconds: 4, inputs: [{ at: 0.5, key: 'right', duration: 0.05 }, { at: 1, key: 'action' }], choices: [0] });
    expect(r.logs.some((l) => l.includes('dialog: npc: Hi there'))).toBe(true);
    expect(r.logs.some((l) => l.includes('choice: Buy'))).toBe(true);
    expect(r.logs.some((l) => l.endsWith('bought'))).toBe(true);
    expect(r.logs.some((l) => l.includes('done at'))).toBe(true);
    expect(r.final.globals.gold).toBe(5);
  });

  it('pauses gameplay while a dialog is open and resumes after confirming', async () => {
    const b = rpg();
    b.scripts = { s: `onStart(async () => { await say('Welcome!'); vars.gold = 1 })` };
    const w = new World(b, {});
    w.step();
    await w.settle();
    expect(w.scripts.dialog?.text).toBe('Welcome!');
    const p = w.actors.find((a) => a.type.name === 'player')!;
    const x0 = p.x;
    const hold = { ...emptyInput(), down: new Set(['right']) };
    for (let i = 0; i < 30; i++) { w.step(hold); await w.settle(); }
    expect(p.x).toBe(x0);
    // First press reveals the whole text, the second closes it.
    for (let k = 0; k < 2; k++) {
      w.step({ ...emptyInput(), pressed: new Set(['action']), down: new Set(['action']) });
      await w.settle();
      w.step();
      await w.settle();
    }
    expect(w.scripts.dialog).toBeNull();
    expect(w.globals.gold).toBe(1);
  });

  it('reports script errors and unknown script behaviors', async () => {
    const b = rpg();
    b.scripts = { bad: `behavior('npc', { update(self) { self.nope() } })\nfunc('x', () => {})\nthrow new Error('boom')` };
    const r = await runPlaytest(b, { seconds: 0.2 });
    expect(r.logs.some((l) => l.includes('ERROR script bad: boom'))).toBe(true);
    expect(r.logs.some((l) => l.includes('ERROR script npc.update'))).toBe(true);
  });

  it('lets scripts move instances, draw UI and use handles', async () => {
    const b = rpg();
    b.scripts = { s: `onSceneStart('level1', async () => {
        const n = findOne('npc')
        n.hp = 3
        await n.moveTo(n.x + 20, n.y, 80)
        log('arrived ' + Math.round(n.x) + ' hp ' + n.hp)
      })
      onDraw((ui) => ui.bar(2, 2, 20, 4, vars.gold, 10))` };
    const r = await runPlaytest(b, { seconds: 1 });
    expect(r.logs.some((l) => l.endsWith('arrived 78 hp 3'))).toBe(true);
  });
});

describe('dialog speed and skipping', () => {
  const bundle = (script: string) => {
    const b = platformBundle();
    b.scripts = { ...(b.scripts ?? {}), main: script };
    return b;
  };

  it('closes lines by itself while skipping, and still waits on a choice', async () => {
    const r = await runPlaytest(
      bundle(`onStart(async () => { setDialogSkip(true); await say('one'); await say('two'); vars.c = await choose(['a', 'b']); vars.done = 1 })`),
      { seconds: 1, autoDialog: false, evaluator: nodeEvaluator },
    );
    expect(r.logs.some((l) => l.includes('dialog: two'))).toBe(true);
    expect(r.final.globals.done).toBeUndefined();
  });
});

describe('effects during dialogs', () => {
  it('ends screen shake and blinking even while a dialog pauses the scene', async () => {
    const b = platformBundle();
    b.scripts = { s: `onStart(async () => { shake(3, 0.2); findOne('player').flash(0.3); await say('Hello') })` };
    const w = new World(b);
    for (let i = 0; i < 60; i++) { w.step(); await w.settle(); }
    expect(w.scripts.dialog).not.toBeNull();
    expect(w.clock).toBeGreaterThan(w.shake.until);
    expect(w.actors.find((a) => a.type.name === 'player')!.flashUntil).toBeLessThan(w.clock);
  });
});

import { parseDialogues } from '../src/core/game/dialogue.js';

describe('dialogues', () => {
  const town = () => {
    const b = platformBundle();
    b.game.objects[0].behaviors = [{ type: 'topdown', speed: 80 }];
    b.game.objects.push(normalizeObject({ name: 'villager', sprite: 'coin', behaviors: [{ type: 'solid' }, { type: 'dialogue' }] }));
    b.game.variables = { gold: 12, potions: 0, metElder: false };
    b.scenes.level1.instances = [
      { id: 'p', object: 'player', x: 40, y: 160 },
      { id: 'e', object: 'villager', name: 'Elder', x: 52, y: 164, props: { dialogue: 'elder' } },
      { id: 'k', object: 'villager', name: 'Kid', x: 200, y: 164, props: { dialogue: 'kid' } },
    ];
    b.dialogues = {
      village: `# villagers
=== elder
if !metElder
  self: Welcome, traveler.
  self: Need a potion? You have {gold} gold.
  * Buy one [if gold >= 10]
    ~ gold -= 10
    ~ potions += 1
    ! sound coin
    self: Here you go.
  * No thanks
    self: Suit yourself.
  ~ metElder = true
else
  self: Hello again.
  -> goodbye

=== kid
Kid: I am {self.name}! Catch me!
~ self.caught = true

=== goodbye
Narrator text without a speaker.
`,
    };
    return b;
  };
  const talk = (w: World, x: number) => {
    const p = w.actors.find((a) => a.type.name === 'player')!;
    p.x = x;
    p.facing = 'right';
  };

  it('parses with line-numbered errors', () => {
    const r = parseDialogues('=== a\nhello\n* yes [if 1 +]\n  ok\nelse\n! nope\n~ broken\nloose', 'f');
    const msgs = r.errors.map((e) => `${e.line}: ${e.message}`).join('\n');
    expect(msgs).toMatch(/3: .*end/);
    expect(msgs).toMatch(/5: else without an if/);
    expect(msgs).toMatch(/6: unknown command "nope"/);
    expect(msgs).toMatch(/7: write variables as/);
    expect(parseDialogues('hi\n=== x\nok', 'f').errors[0].message).toMatch(/outside a dialogue/);
  });

  it('lets one NPC object type be different characters with their own dialogues', async () => {
    const b = town();
    const w = new World(b, { autoDialog: { choices: [0], delay: 0.2 } });
    const step = async (n: number, press = false) => {
      for (let i = 0; i < n; i++) {
        w.step(press && i === 0 ? { ...emptyInput(), down: new Set(['action']), pressed: new Set(['action']) } : emptyInput());
        await w.settle();
      }
    };
    await step(2);
    talk(w, 52 - 16 - 3 + 2);
    await step(1, true);
    await step(120);
    expect(w.logs.some((l) => l.includes('dialog: Elder: Welcome, traveler.'))).toBe(true);
    expect(w.logs.some((l) => l.includes('dialog: Elder: Need a potion? You have 12 gold. [Buy one / No thanks]'))).toBe(true);
    expect(w.globals).toMatchObject({ gold: 2, potions: 1, metElder: true });
    // Second time: other branch and a jump to another dialogue (narration, no speaker).
    await step(1, true);
    await step(80);
    expect(w.logs.some((l) => l.includes('dialog: Elder: Hello again.'))).toBe(true);
    expect(w.logs.some((l) => l.endsWith('dialog: Narrator text without a speaker.'))).toBe(true);
    // The other villager says its own lines and remembers in its own properties.
    talk(w, 200 - 16 - 3 + 2);
    await step(1, true);
    await step(60);
    expect(w.logs.some((l) => l.includes('dialog: Kid: I am Kid! Catch me!'))).toBe(true);
    expect(w.actors.find((a) => a.instName === 'Kid')!.vars.caught).toBe(true);
    expect(w.actors.find((a) => a.instName === 'Elder')!.vars.caught).toBeUndefined();
  });

  it('starts dialogues from events and hides choices whose condition is false', async () => {
    const b = town();
    b.game.variables.gold = 3;
    b.scenes.level1.events.push({ trigger: { type: 'start' }, conditions: [], actions: [{ type: 'dialogue', dialogue: 'elder' }] });
    const r = await runPlaytest(b, { seconds: 2 });
    expect(r.logs.some((l) => l.includes('[No thanks]'))).toBe(true);
    expect(r.final.globals.potions).toBe(0);
  });

  it('remembers instances of persistent scenes until the scene restarts', async () => {
    const b = town();
    b.scenes.level1.persistent = true;
    b.scenes.other = createScene({ name: 'other', cols: 5, rows: 5 });
    const w = new World(b);
    w.step();
    const kid = w.actors.find((a) => a.instName === 'Kid')!;
    kid.vars.caught = true;
    kid.x = 123;
    w.destroy(w.actors.find((a) => a.instName === 'Elder')!);
    w.gotoScene('other');
    w.step();
    w.gotoScene('level1');
    w.step();
    expect(w.actors.find((a) => a.instName === 'Elder')).toBeUndefined();
    expect(w.actors.find((a) => a.instName === 'Kid')).toMatchObject({ x: 123, vars: { caught: true } });
    w.restartScene();
    w.step();
    expect(w.actors.find((a) => a.instName === 'Elder')).toBeDefined();
  });

  it('uses per-instance sprite overrides', () => {
    const b = town();
    b.scenes.level1.instances[2].sprite = 'hero';
    const w = new World(b);
    expect(w.actors.find((a) => a.instName === 'Kid')!.asset!.name).toBe('hero');
    expect(w.actors.find((a) => a.instName === 'Elder')!.asset!.name).toBe('coin');
  });
});

describe('instance hitbox', () => {
  const scene = (wall: { hitbox?: { x: number; y: number; w: number; h: number }; flipX?: boolean } = {}) => {
    const b = platformBundle();
    b.game.objects[0].behaviors = [{ type: 'topdown', speed: 80 }];
    b.game.objects.push(normalizeObject({ name: 'cutout', sprite: 'wall', behaviors: [{ type: 'solid' }] }));
    b.sprites.wall = box('wall', 64, 64);
    b.scenes.level1.ySort = true;
    b.scenes.level1.instances = [
      { id: 'p', object: 'player', x: 8, y: 40 },
      { id: 'w', object: 'cutout', x: 40, y: 0, ...wall },
    ];
    return b;
  };
  /** Order in which the frame draws the two sprites. */
  const order = (w: World): string[] => {
    const seen: string[] = [];
    const r = { clear() {}, rect() {}, text() {}, image(s: string) { if (s === 'hero' || s === 'wall') seen.push(s); } };
    renderWorld(w, r as unknown as Parameters<typeof renderWorld>[1]);
    return seen;
  };

  it('collides with its own box, not the type\'s (the whole sprite)', () => {
    const w = new World(scene({ hitbox: { x: 0, y: 48, w: 64, h: 16 } }));
    const p = w.actors.find((a) => a.type.name === 'player')!;
    const wall = w.actors.find((a) => a.type.name === 'cutout')!;
    expect(wall.box()).toEqual({ x: 40, y: 48, w: 64, h: 16 });
    // Feet above the base (box 20..36): walks across the picture, behind it in depth.
    p.y = 20;
    const input = emptyInput();
    input.down.add('right');
    for (let i = 0; i < 60; i++) w.step(input);
    expect(p.x).toBeGreaterThan(60);
    // Feet on the base's row: stopped at its left edge.
    const v = new World(scene({ hitbox: { x: 0, y: 48, w: 64, h: 16 } }));
    const q = v.actors.find((a) => a.type.name === 'player')!;
    for (let i = 0; i < 60; i++) v.step(input);
    expect(q.x + 16).toBeLessThanOrEqual(40.5);
  });

  it('sorts by its own box and mirrors it with the sprite', () => {
    const w = new World(scene({ hitbox: { x: 0, y: 60, w: 10, h: 4 } }));
    // Player feet (y 40 + 16) are above the wall's base (64): the wall is drawn after, in front.
    expect(order(w)).toEqual(['hero', 'wall']);
    // A base high up the picture (bottom at 24, the sprite ends at 64): now the player's feet are below it, so the wall
    // is drawn first, behind. With the type's box (the whole sprite) it would still be in front.
    const high = new World(scene({ hitbox: { x: 0, y: 20, w: 10, h: 4 } }));
    expect(order(high)).toEqual(['wall', 'hero']);
    expect(order(new World(scene({})))).toEqual(['hero', 'wall']);
    const flipped = new World(scene({ hitbox: { x: 0, y: 60, w: 10, h: 4 }, flipX: true }));
    expect(flipped.actors.find((a) => a.type.name === 'cutout')!.box()).toEqual({ x: 40 + 54, y: 60, w: 10, h: 4 });
  });

  it('stands in 2D-HD on the bottom of its own box', () => {
    const w = new World(scene({ hitbox: { x: 0, y: 40, w: 64, h: 10 } }));
    let foot: number | null = null;
    let last: { kind: string; y?: number } = { kind: '' };
    const r = { clear() {}, rect() {}, text() {}, mark(m: { kind: string; y?: number }) { last = m; }, image(s: string) { if (s === 'wall' && last.kind === 'stand') foot = last.y ?? null; } };
    renderWorld(w, r as unknown as Parameters<typeof renderWorld>[1]);
    const cam = w.camera;
    expect(foot).toBe((50 - cam.y) * (cam.zoom ?? 1));
  });

  it('falls back to the type\'s box when it has none', () => {
    const w = new World(scene());
    expect(w.actors.find((a) => a.type.name === 'cutout')!.box()).toEqual({ x: 40, y: 0, w: 64, h: 64 });
  });
});

describe('hd lift', () => {
  const marks = (lift?: number): { kind: string; h?: number }[] => {
    const b = platformBundle();
    b.game.objects.push(normalizeObject({ name: 'crest', sprite: 'wall' }));
    b.sprites.wall = box('wall', 32, 32);
    b.scenes.level1.instances = [{ id: 'c', object: 'crest', x: 40, y: 0, hdPose: 'flat', ...(lift ? { hdLift: lift } : {}) }];
    const w = new World(b);
    const seen: { kind: string; h?: number }[] = [];
    let last: { kind: string; h?: number } = { kind: '' };
    const r = { clear() {}, rect() {}, text() {}, mark(m: { kind: string; h?: number }) { last = m; }, image(s: string) { if (s === 'wall') seen.push(last); } };
    renderWorld(w, r as unknown as Parameters<typeof renderWorld>[1]);
    return seen;
  };

  it('lies a lifted flat instance on top of a wall, H pixels up', () => {
    expect(marks(28)).toEqual([{ kind: 'top', h: 28, z: 0 }]);
  });

  it('keeps flat instances without it on the ground', () => {
    expect(marks()).toEqual([{ kind: 'ground' }]);
  });
});

describe('foot line', () => {
  const world = () => {
    const b = platformBundle();
    b.game.objects[0].behaviors = [{ type: 'topdown', speed: 80 }];
    b.game.objects.push(normalizeObject({ name: 'face', sprite: 'wall' }));
    b.sprites.wall = box('wall', 64, 32);
    b.scenes.level1.ySort = true;
    // A wall front running from y 32 (left) to y 64 (right): its right end is closer to the camera.
    b.scenes.level1.instances = [
      { id: 'p', object: 'player', x: 60, y: 30 },
      { id: 'f', object: 'face', x: 40, y: 20, footLine: [[0, 12], [64, 44]] },
    ];
    return new World(b);
  };
  type M = { kind: string; foot?: number; run?: { x0: number; f0: number; x1: number; f1: number } };
  const frame = (w: World) => {
    const seen: { s: string; m: M; sx: number }[] = [];
    let last: M = { kind: '' };
    const r = { clear() {}, rect() {}, text() {}, mark(m: M) { last = m; }, image(s: string, sx: number) { seen.push({ s, m: last, sx }); } };
    renderWorld(w, r as unknown as Parameters<typeof renderWorld>[1]);
    return seen;
  };

  it('draws in strips sorted by the ground under each: the hero is between them', () => {
    const seen = frame(world()).filter((e) => e.s === 'wall' || e.s === 'hero');
    const hero = seen.findIndex((e) => e.s === 'hero');
    // Feet at y 46: strips whose ground is above 46 are drawn before the hero, the others after.
    expect(hero).toBeGreaterThan(0);
    expect(hero).toBeLessThan(seen.length - 1);
    const strips = seen.filter((e) => e.s === 'wall');
    expect(strips.length).toBe(16);
  });

  it('stands facing the camera in 2D-HD, each column on its own foot, continuous from strip to strip', () => {
    const strips = frame(world()).filter((e) => e.s === 'wall');
    for (const e of strips) expect(e.m.kind).toBe('stand');
    for (let k = 1; k < strips.length; k++) {
      expect(strips[k]!.m.run!.x0).toBeCloseTo(strips[k - 1]!.m.run!.x1);
      expect(strips[k]!.m.run!.f0).toBeCloseTo(strips[k - 1]!.m.run!.f1);
    }
  });

  it("is an upright surface along the line with hdPose 'wall', continuous from strip to strip", () => {
    const w = world();
    w.actors.find((a) => a.sceneId === 'f')!.hdPose = 'wall';
    const strips = frame(w).filter((e) => e.s === 'wall');
    for (const e of strips) expect(e.m.kind).toBe('wall');
    for (let k = 1; k < strips.length; k++) {
      expect(strips[k]!.m.run!.x0).toBeCloseTo(strips[k - 1]!.m.run!.x1);
      expect(strips[k]!.m.run!.f0).toBeCloseTo(strips[k - 1]!.m.run!.f1);
    }
  });

  it('draws a level foot line exactly like the same picture standing on that foot, in 2D and in 2D-HD', () => {
    const sheet: Bitmap = { width: 128, height: 32, data: new Uint8ClampedArray(128 * 32 * 4) };
    for (let y = 0; y < 32; y++) for (let x = 0; x < 128; x++) sheet.data.set([(x * 37) % 256, (y * 53) % 256, ((x + y) * 19) % 256, x % 9 === 0 && y % 5 === 0 ? 0 : 255], (y * 128 + x) * 4);
    const sheets = new Map([['wall', sheet]]);
    const make = (extra: Partial<Instance>) => {
      const b = platformBundle();
      b.game.objects[0].behaviors = [{ type: 'topdown', speed: 80 }, { type: 'camera' }];
      b.game.objects.push(normalizeObject({ name: 'face', sprite: 'wall' }));
      b.sprites.wall = box('wall', 64, 32);
      b.scenes.level1.ySort = true;
      b.scenes.level1.instances = [{ id: 'p', object: 'player', x: 150, y: 40 }, { id: 'f', object: 'face', x: 60, y: 120, hitbox: { x: 0, y: 24, w: 64, h: 8 }, ...extra }];
      return new World(b);
    };
    for (const hd of [false, true]) {
      const plain = renderViewport(make({}), sheets, 1, hd);
      const level = renderViewport(make({ footLine: [[0, 32], [64, 32]] }), sheets, 1, hd);
      expect(level.equals(plain)).toBe(true);
    }
    // the 2D-HD picture really is another one, and a sloping line really moves the columns
    expect(renderViewport(make({}), sheets, 1, true).equals(renderViewport(make({}), sheets, 1, false))).toBe(false);
    expect(renderViewport(make({ footLine: [[0, 20], [64, 40]] }), sheets, 1, true).equals(renderViewport(make({}), sheets, 1, true))).toBe(false);
  });

  it('refuses a foot line whose x goes back or repeats', () => {
    expect(footLineProblem([[0, 1], [10, 1], [20, 9]])).toBeNull();
    expect(footLineProblem([[0, 1], [10, 1], [5, 9]])).toMatch(/goes back/);
    expect(footLineProblem([[0, 1], [10, 1], [10, 9], [20, 9]])).toMatch(/same x/);
  });

});

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
describe('index of solid instances', () => {
  // Fast solids listed BEFORE the player move first in each step: a grid that kept them where the step began would let
  // the player into them (room-3001 #286.C). Every frame is compared, not only the last one.
  const run = (seed: number, indexed: boolean) => {
    const b = platformBundle();
    b.game.objects[0].behaviors = [{ type: 'topdown', speed: 90 }];
    b.game.objects.push(normalizeObject({ name: 'block', sprite: 'coin', behaviors: [{ type: 'solid' }] }));
    for (const sp of [90, 200, 400]) b.game.objects.push(normalizeObject({ name: `mover${sp}`, sprite: 'coin', behaviors: [{ type: 'solid' }, { type: 'patrol', speed: sp }] }));
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const inst: Instance[] = [];
    for (let k = 0; k < 24; k++) inst.push({ id: `m${k}`, object: `mover${[90, 200, 400][k % 3]}`, x: 90 + Math.floor(rnd() * 120), y: 60 + Math.floor(rnd() * 60) });
    inst.push({ id: 'p', object: 'player', x: 150, y: 90 });
    for (let k = 0; k < 120; k++) inst.push({ id: `b${k}`, object: 'block', x: Math.floor(rnd() * 300), y: Math.floor(rnd() * 170), hitbox: { x: 0, y: 0, w: 4 + Math.floor(rnd() * 30), h: 4 + Math.floor(rnd() * 20) } });
    b.scenes.level1.instances = inst;
    const w = new World(b, { seed });
    w.solidIndexMin = 1;
    if (!indexed) (w as unknown as { solidsNear: () => unknown[] }).solidsNear = function (this: World) { return this.actors.filter((a) => !!a.behavior('solid')); };
    const input = emptyInput();
    const keys = ['left', 'right', 'up', 'down'];
    const frames: number[][][] = [];
    for (let f = 0; f < 400; f++) {
      if (f % 25 === 0) { input.down.clear(); input.down.add(keys[Math.floor(rnd() * 4)]!); }
      w.step(input);
      frames.push(w.actors.map((a) => [a.x, a.y]));
    }
    return frames;
  };

  it('moves everything exactly as a scan of every instance would, frame by frame, with fast solids moving first', () => {
    for (const seed of SEEDS) expect(run(seed, true)).toEqual(run(seed, false));
  }, 20000);

  it('sees a still solid that a script moves before the behaviors, in the same frame', async () => {
    const run = async (indexed: boolean) => {
      const b = platformBundle();
      b.game.objects[0].behaviors = [{ type: 'topdown', speed: 120 }];
      b.game.objects.push(normalizeObject({ name: 'block', sprite: 'coin', behaviors: [{ type: 'solid' }] }));
      b.game.objects.push(normalizeObject({ name: 'gate', sprite: 'coin', behaviors: [{ type: 'solid' }] }));
      const inst: Instance[] = [{ id: 'g', object: 'gate', x: 400, y: 0, hitbox: { x: 0, y: 0, w: 8, h: 192 } }, { id: 'p', object: 'player', x: 40, y: 90 }];
      for (let k = 0; k < 300; k++) inst.push({ id: `b${k}`, object: 'block', x: 1000 + (k % 30) * 20, y: 300 + Math.floor(k / 30) * 20 });
      b.scenes.level1.instances = inst;
      // every frame, before the behaviors, the gate jumps right in front of the player
      b.scripts = { 'g.js': "onUpdate(() => { const p = findOne('player'); const g = findOne('gate'); if (p && g) g.x = p.x + 17 })" };
      const w = new World(b, { evaluator: nodeEvaluator });
      w.solidIndexMin = 1;
      if (!indexed) (w as unknown as { solidsNear: () => unknown[] }).solidsNear = function (this: World) { return this.actors.filter((a) => !!a.behavior('solid')); };
      const input = emptyInput();
      input.down.add('right');
      const xs: number[] = [];
      for (let f = 0; f < 30; f++) {
        w.step(input);
        await w.settle();
        xs.push(w.actors.find((a) => a.sceneId === 'p')!.x);
      }
      return xs;
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it('uses the plain scan below the threshold, so ordinary games are unchanged', () => {
    const b = platformBundle();
    b.game.objects.push(normalizeObject({ name: 'block', sprite: 'coin', behaviors: [{ type: 'solid' }] }));
    b.scenes.level1.instances.push({ id: 'b0', object: 'block', x: 0, y: 0 });
    const w = new World(b);
    w.step(emptyInput());
    expect((w as unknown as { solidIdx: unknown }).solidIdx).toBeNull();
  });
});

describe('touching pairs', () => {
  it('gives listeners the same contacts, in the same order, as pairing everything', () => {
    const b = platformBundle();
    b.game.objects[0].behaviors = [{ type: 'topdown', speed: 90 }];
    b.game.objects[0].events.push({ trigger: { type: 'overlapping', with: 'any' }, conditions: [], actions: [{ type: 'add', target: 'score', value: '1' }] });
    b.game.objects.push(normalizeObject({ name: 'deco', sprite: 'coin' }));
    b.scenes.level1.instances = [{ id: 'p', object: 'player', x: 40, y: 150 }];
    for (let k = 0; k < 60; k++) b.scenes.level1.instances.push({ id: `d${k}`, object: 'deco', x: 20 + (k * 37) % 260, y: 140 + (k * 13) % 40, hitbox: { x: 0, y: 0, w: 6 + (k % 9) * 4, h: 8 } });
    const w = new World(b);
    const input = emptyInput();
    input.down.add('right');
    // Every frame against brute force: every deco overlapping the player, in instance order.
    let touchedFrames = 0;
    for (let f = 0; f < 120; f++) {
      w.step(input);
      const p = w.actors.find((a) => a.type.name === 'player')!;
      const pb = p.box();
      const expected = w.actors.filter((a) => a !== p && !a.destroyed && a.box().x < pb.x + pb.w && pb.x < a.box().x + a.box().w && a.box().y < pb.y + pb.h && pb.y < a.box().y + a.box().h).map((a) => a.sceneId);
      expect([...p.touching].map((a) => a.sceneId)).toEqual(expected);
      if (expected.length) touchedFrames++;
    }
    expect(touchedFrames).toBeGreaterThan(10);
    expect(w.globals.score).toBeGreaterThan(0);
  });
});

describe('touching pairs: cost and result with many listeners or a very wide box', () => {
  const world = (n: number, listeners: number) => {
    const b = platformBundle();
    b.game.objects.push(normalizeObject({ name: 'ear', sprite: 'coin', events: [{ trigger: { type: 'overlapping', with: 'any' }, conditions: [], actions: [] }] }));
    b.game.objects.push(normalizeObject({ name: 'rock', sprite: 'coin' }));
    const inst: Instance[] = [{ id: 'big', object: 'rock', x: 0, y: 0, hitbox: { x: 0, y: 0, w: 4000, h: 4000 } }];
    for (let k = 0; k < n; k++) inst.push({ id: `a${k}`, object: k < listeners ? 'ear' : 'rock', x: (k * 37) % 3900, y: (k * 53) % 3900, hitbox: { x: 0, y: 0, w: 10, h: 10 } });
    b.scenes.level1.instances = inst;
    return new World(b);
  };
  const brute = (live: World['actors']) => {
    const out = new Map<unknown, string[]>();
    const listens = (a: World['actors'][number]) => a.type.events.length > 0;
    for (let i = 0; i < live.length; i++) for (let j = 0; j < live.length; j++) {
      if (i === j) continue;
      const a = live[i]!, c = live[j]!;
      if (!listens(a) && !listens(c)) continue;
      const p = a.box(), q = c.box();
      if (p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h) {
        if (!out.has(a)) out.set(a, []);
        out.get(a)!.push(c.sceneId!);
      }
    }
    return out;
  };

  it('finds the same pairs as checking everything, with many listeners and with few', async () => {
    const { touchingPairs } = await import('../src/core/game/engine.js');
    for (const listeners of [300, 20]) {
      const w = world(300, listeners);
      const got = touchingPairs(w.actors);
      const want = brute(w.actors);
      expect(new Map([...got].map(([a, s]) => [a, [...s].map((o) => o.sceneId)]))).toEqual(want);
    }
  });

  it('stays close to one sweep when every instance listens and one box is as wide as the scene', async () => {
    const { touchingPairs } = await import('../src/core/game/engine.js');
    const w = world(3000, 3000);
    const stats = { checks: 0 };
    touchingPairs(w.actors, stats);
    expect(stats.checks).toBeLessThan(3000 * 40);
  });
});

describe('foot line strips: mirroring, sprite offset, blinking, zoom', () => {
  const sheet: Bitmap = { width: 128, height: 32, data: new Uint8ClampedArray(128 * 32 * 4) };
  for (let y = 0; y < 32; y++) for (let x = 0; x < 128; x++) sheet.data.set([(x * 37) % 256, (y * 53) % 256, ((x + y) * 19) % 256, x % 9 === 0 && y % 5 === 0 ? 0 : 255], (y * 128 + x) * 4);
  const sheets = new Map([['wall', sheet]]);
  const make = (extra: Partial<Instance>, offset?: { x: number; y: number }) => {
    const b = platformBundle();
    b.game.objects[0].behaviors = [{ type: 'topdown', speed: 80 }, { type: 'camera' }];
    b.game.objects.push(normalizeObject({ name: 'face', sprite: 'wall', ...(offset ? { spriteOffset: offset } : {}) }));
    b.sprites.wall = box('wall', 64, 32);
    b.scenes.level1.ySort = true;
    b.scenes.level1.instances = [{ id: 'p', object: 'player', x: 150, y: 40 }, { id: 'f', object: 'face', x: 60, y: 120, hitbox: { x: 0, y: 24, w: 64, h: 8 }, ...extra }];
    return new World(b);
  };

  it('draws a level foot line exactly like the picture, also mirrored and with a sprite offset, in 2D and in 2D-HD', () => {
    for (const hd of [false, true]) {
      for (const [extra, off] of [[{ flipX: true }, undefined], [{}, { x: -6, y: 3 }], [{ flipX: true }, { x: 5, y: -2 }]] as const) {
        const plain = renderViewport(make({ ...extra }, off), sheets, 1, hd);
        const level = renderViewport(make({ ...extra, footLine: [[0, 32], [64, 32]] }, off), sheets, 1, hd);
        expect(level.equals(plain)).toBe(true);
      }
    }
  });

  it('blinks like any picture and is drawn whole at a zoom that is not a whole number', () => {
    const count = (w: World) => {
      let n = 0;
      const r = { clear() {}, rect() {}, text() {}, image(s: string) { if (s === 'wall') n++; } };
      renderWorld(w, r as unknown as Parameters<typeof renderWorld>[1]);
      return n;
    };
    const w = make({ footLine: [[0, 20], [64, 40]] });
    expect(count(w)).toBeGreaterThan(1);
    const f = w.actors.find((a) => a.sceneId === 'f')!;
    f.flashUntil = w.clock + 10;
    expect(count(w)).toBe(0); // clock 0: a blink frame
    f.flashUntil = 0;
    w.camera.zoom = 1.5;
    expect(count(w)).toBe(1);
  });
});

describe('foot line points', () => {
  it('8. a scene keeps foot line points left to right as given, the first of each x, without sorting them', () => {
    const sc = (fl: [number, number][]) => normalizeSceneForTest({ name: 's', instances: [{ id: 'f', object: 'o', x: 0, y: 0, footLine: fl }] } as unknown as Scene).instances[0]!.footLine;
    expect(sc([[0, 1], [10, 1], [10, 9], [20, 9]])).toEqual([[0, 1], [10, 1], [20, 9]]);
    expect(sc([[0, 1], [20, 9], [10, 5], [30, 2]])).toEqual([[0, 1], [20, 9], [30, 2]]);
    expect(sc([[0, 1], [5, 2]])).toEqual([[0, 1], [5, 2]]);
  });
});
