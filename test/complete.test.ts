import { describe, expect, it } from 'vitest';
import { type CompleteContext, complete, maskCode, signatureAt } from '../src/web/scriptComplete.js';
import { inspectScripts } from '../src/server/scripts.js';

const scripts = {
  'enemies/Health': 'export default class Health extends Behaviour { hp = 3; max = 3; damage(n) { this.hp -= n } heal(n) {} }',
  'enemies/Patrol': '',
  'utils/math': 'export const clamp = (v, a, b) => v',
};
const info = inspectScripts(scripts);
const ctx = (path = 'enemies/Patrol'): CompleteContext => ({
  path,
  scripts: Object.keys(scripts),
  components: info.components,
  objects: ['player', 'slime'],
  scenes: ['town', 'battle'],
  sprites: ['hero'],
  dialogues: ['elder'],
  sounds: ['coin', 'hit'],
  keys: ['left', 'action'],
  variables: { score: 0, hp: 20 },
  properties: ['dialogue', 'gold'],
  tags: ['enemy', 'pickup'],
});

/** Completes at the "|" marker. */
const at = (code: string, path?: string, explicit = false) => {
  const pos = code.indexOf('|');
  const src = code.replace('|', '');
  return complete(src, pos, ctx(path), explicit);
};
const labels = (code: string, path?: string, explicit = false) => at(code, path, explicit)?.items.map((i) => i.label) ?? [];

const CLASS = (body: string) => `export default class Patrol extends Behaviour {\n  speed = 40\n  _dir = 1\n${body}\n}`;

describe('script autocompletion', () => {
  it('completes this. with params, own members and Behaviour API', () => {
    const l = labels(CLASS('  update(dt) {\n    this.|\n  }\n  turn() {}'));
    expect(l).toEqual(expect.arrayContaining(['speed', '_dir', 'update', 'turn', 'self', 'getComponent', 'wait', 'enabled']));
    expect(labels(CLASS('  update(dt) {\n    this.ge|\n  }'))[0]).toBe('getComponent');
  });

  it('completes instance handles and their component members', () => {
    expect(labels(CLASS('  update(dt) {\n    this.self.|\n  }'))).toEqual(expect.arrayContaining(['x', 'moveTo', 'getComponent', 'gold']));
    expect(labels(CLASS("  update(dt) {\n    this.getComponent('Health').|\n  }"))).toEqual(expect.arrayContaining(['hp', 'max', 'damage', 'heal']));
    expect(labels(CLASS("  awake() { this.health = this.getComponent('Health') }\n  update() {\n    this.health.da|\n  }"))[0]).toBe('damage');
    expect(labels(CLASS("  update() {\n    const h = findOne('slime').getComponent('Health')\n    h.|\n  }"))).toContain('heal');
    expect(labels(CLASS('  onCollisionEnter(other) {\n    other.|\n  }'))).toContain('getComponent');
    expect(labels(CLASS("  update() {\n    for (const e of find('slime')) e.fl|\n  }"))).toEqual(['flipX', 'flash']);
    expect(labels("import Health from './Health'\n" + CLASS('  update() {\n    this.getComponent(Health).|\n  }'))).toContain('damage');
  });

  it('completes string arguments: components, objects, scenes, sounds and import paths', () => {
    expect(labels(CLASS("  update() {\n    this.getComponent('|')\n  }"))).toEqual(['Health']);
    expect(labels("goto('|')")).toEqual(['battle', 'town']);
    expect(labels("sound('h|')")).toEqual(['hit']);
    expect(labels("findOne('sl|')")).toEqual(['slime']);
    expect(labels("import { clamp } from '|'")).toEqual(['enemies/Health', 'utils/math']);
    expect(labels("import Health from './|'")).toEqual(['./Health', '../utils/math']);
    expect(labels("static params = {\n  target: '|'")).toContain('object');
    expect(labels("emit('playerHit', 1)\nthis.on('pl|')")).toEqual(['playerHit']);
    expect(labels("findWithTag('|')")).toEqual(['enemy', 'pickup']);
    expect(labels("raycast(0, 0, 1, 1, { tag: 'en|' })")).toEqual(['enemy']);
    expect(labels("raycast(0, 0, 1, 1, { object: '|' })")).toEqual(['player', 'slime']);
    expect(labels('findN|')).toContain('findNearest');
    const r = at("goto('to|wn')");
    expect(r).toMatchObject({ from: 6, to: 10 });
  });

  it('offers lifecycle hooks in a class body and globals elsewhere', () => {
    const l = labels(CLASS('  on|'));
    expect(l).toEqual(expect.arrayContaining(['onCollisionEnter', 'onInteract', 'onDestroy']));
    expect(at(CLASS('  onColEn|'))?.items[0].insert).toContain('onCollisionEnter(other) {');
    expect(labels(CLASS('  up|'))).toContain('update');
    expect(labels(CLASS('  update() {}\n  up|'))).not.toContain('update'); // already defined
    expect(labels('fin|')).toEqual(expect.arrayContaining(['find', 'findOne', 'findComponent', 'finally']));
    expect(labels('vars.|')).toEqual(['hp', 'score']);
    expect(labels('ui.ba|')).toEqual(['bar']);
    expect(labels('// say|')).toEqual([]);
    expect(labels("const s = 'say|'")).toEqual([]);
  });

  it('shows the signature of the call around the caret', () => {
    const src = 'say("hi", { speaker: ';
    expect(signatureAt(src, src.length, ctx())?.ts).toMatch(/^say\(text: string/);
    expect(signatureAt('this.self.moveTo(1, ', 20, ctx())?.ts).toMatch(/^moveTo/);
  });

  it('masks strings and comments but keeps template expressions', () => {
    expect(maskCode("a('x') // c\n`t ${b} t`")).toBe("a(' ')     \n`  ${b}  `");
  });
});
