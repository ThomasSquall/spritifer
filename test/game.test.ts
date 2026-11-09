import { describe, expect, it } from 'vitest';
import { compile, checkExpr } from '../src/core/game/expr.js';
import { World, emptyInput, runPlaytest } from '../src/core/game/engine.js';
import { validateGame } from '../src/core/game/catalog.js';
import { type GameBundle, type SpriteAsset, createGame, createScene, normalizeObject } from '../src/core/game/types.js';
import { BUILTIN_FONT, PIXEL_OPERATOR, gameFont, measureText, rasterText } from '../src/core/game/font.js';
import { wrapText } from '../src/core/game/script.js';
import { nodeEvaluator } from '../src/server/scripts.js';

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
