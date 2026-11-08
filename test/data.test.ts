import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { World, emptyInput, runPlaytest } from '../src/core/game/engine.js';
import { type GameBundle, createGame, createScene, normalizeObject, normalizeTable } from '../src/core/game/types.js';
import { buildTypeDefinitions } from '../src/core/game/scriptApi.js';
import { validateGame } from '../src/core/game/catalog.js';
import { nodeEvaluator } from '../src/server/scripts.js';
import { Workspace } from '../src/server/store.js';
import { createMcpServer } from '../src/server/mcp.js';
import { loadGameBundle } from '../src/server/game.js';

const BOX = { name: 'box', width: 16, height: 16, frames: [{ x: 0, y: 0, w: 16, h: 16, duration: 100 }], tags: [], grid: null };

function town(scripts: Record<string, string> = {}): GameBundle {
  const t = createScene({ name: 'town', cols: 20, rows: 12, tileSize: 16, persistent: true });
  t.instances.push(
    { id: 'p', object: 'player', x: 10, y: 10 },
    { id: 'inn', object: 'house', x: 100, y: 10, name: 'Inn', activeIf: 'inn_lv >= 1' },
    { id: 'inn2', object: 'house', x: 140, y: 10, name: 'Big inn', activeIf: 'inn_lv >= 2' },
    { id: 'well', object: 'house', x: 180, y: 10, name: 'Well' },
  );
  const out = createScene({ name: 'out', cols: 20, rows: 12, tileSize: 16 });
  out.instances.push({ id: 'p2', object: 'player', x: 10, y: 10 });
  const game = createGame({
    startScene: 'town',
    variables: { inn_lv: 0, gold: 50 },
    objects: [
      normalizeObject({ name: 'player', sprite: 'box', behaviors: [{ type: 'topdown', speed: 80 }] }),
      normalizeObject({ name: 'house', sprite: 'box', behaviors: [{ type: 'solid' }] }),
    ],
  });
  const weapons = normalizeTable({
    name: 'weapons',
    columns: [{ name: 'name', type: 'text' }, { name: 'atk', type: 'number' }, { name: 'price', type: 'number' }, { name: 'tier', type: 'number' }, { name: 'classes', type: 'list' }],
    rows: [
      { id: 'stick', name: 'Stick', atk: 0, price: 0, tier: 0, classes: 'warrior, mage' },
      { id: 'bronze', name: 'Bronze Sword', atk: '3', price: 40, tier: 1, classes: ['warrior'] },
      { id: 'axe', name: 'Iron Axe', atk: 6, price: 90, tier: 2 },
    ],
  });
  return { game, scenes: { town: t, out }, sprites: { box: BOX }, scripts, data: { weapons } };
}

const names = (w: World) => w.actors.filter((a) => !a.destroyed).map((a) => a.instName).filter(Boolean).sort();
const steps = async (w: World, n: number) => {
  for (let i = 0; i < n; i++) {
    w.step(emptyInput());
    await w.settle();
  }
};

describe('data tables', () => {
  it('normalizes columns, types values and keeps ids unique', () => {
    const t = normalizeTable({ rows: [{ id: 'a', n: 1, ok: true }, { id: 'a', n: '2' }, { n: 3, tags: ['x'] }] }, 'things');
    expect(t.columns.map((c) => `${c.name}:${c.type}`)).toEqual(['id:text', 'n:number', 'ok:bool', 'tags:list']);
    expect(t.rows.map((r) => r.id)).toEqual(['a', 'a_', 'row3']);
    expect(t.rows[1].n).toBe(2);
  });

  it('db() in expressions and db in scripts read the tables, read-only', async () => {
    const b = town({
      shop: `func('cheapest', () => db.where('weapons', (r) => r.price > 0).sort((a, b) => a.price - b.price)[0].id)
        onStart(() => {
          log('bronze ' + db.get('weapons', 'bronze').atk + ' ' + db('weapons', 'bronze').classes.join('|'))
          log('tier2 ' + db.where('weapons', { tier: 2 }).map((r) => r.id).join(','))
          log('warriors ' + db.where('weapons', { classes: 'warrior' }).length)
          log('tables ' + db.tables.join(','))
          try { db.weapons[0].atk = 99 } catch (e) { log('frozen') }
        })`,
    });
    b.game.objects.push(normalizeObject({ name: 'label', text: '"ATK " + db("weapons", "axe", "atk") + " " + fn("cheapest") + " " + db("weapons") + " " + db("weapons", "nope")', hud: true }));
    b.scenes.town.instances.push({ id: 'l', object: 'label', x: 0, y: 0 });
    const r = await runPlaytest(b, { seconds: 0.2, evaluator: nodeEvaluator });
    const logs = r.logs.join('\n');
    expect(logs).toContain('bronze 3 warrior');
    expect(logs).toContain('tier2 axe');
    expect(logs).toContain('warriors 2');
    expect(logs).toContain('tables weapons');
    expect(logs).toContain('frozen');
    expect(r.world.actors.find((a) => a.type.name === 'label')?.textOverride).toBe('ATK 6 bronze 3 false');
  });

  it('generates typed rows in spritifer.d.ts', () => {
    const dts = buildTypeDefinitions({ components: [], objects: [], scenes: [], sounds: [], dialogues: [], variables: {}, properties: {}, tables: { weapons: { description: 'All weapons', columns: [{ name: 'id', type: 'text' }, { name: 'atk', type: 'number' }, { name: 'classes', type: 'list' }] } } });
    expect(dts).toContain('interface WeaponsRow');
    expect(dts).toContain('readonly atk: number;');
    expect(dts).toContain('readonly classes: readonly string[];');
    expect(dts).toContain('readonly weapons: readonly WeaponsRow[];');
    expect(dts).toContain('declare const db: Db;');
  });

  it('validation reports bad activeIf, unknown tables and broken refs', () => {
    const b = town();
    b.scenes.town.instances.push({ id: 'x', object: 'house', x: 0, y: 0, activeIf: 'gold >' }, { id: 'y', object: 'house', x: 0, y: 0, activeIf: 'db("armor", "a", "def") > 0' });
    const classes = normalizeTable({ name: 'classes', columns: [{ name: 'weapon', type: 'ref', table: 'weapons' }], rows: [{ id: 'mage', weapon: 'staff' }] });
    const problems = validateGame(b.game, Object.values(b.scenes), new Set(['box']), undefined, undefined, undefined, { ...b.data, classes });
    const text = problems.map((p) => `${p.where}: ${p.message}`).join('\n');
    expect(text).toMatch(/activeIf/);
    expect(text).toContain('no data table "armor"');
    expect(text).toContain('no row "staff" in table weapons');
  });
});

describe('conditional instances (activeIf)', () => {
  it('appear and disappear with their condition while the scene runs', async () => {
    const w = new World(town(), { evaluator: nodeEvaluator });
    await steps(w, 2);
    expect(names(w)).toEqual(['Well']);
    w.globals.inn_lv = 1;
    await steps(w, 12);
    expect(names(w)).toEqual(['Inn', 'Well']);
    w.globals.inn_lv = 2;
    await steps(w, 12);
    expect(names(w)).toEqual(['Big inn', 'Inn', 'Well']);
    // Going back down removes them without "destroying" them.
    w.globals.inn_lv = 0;
    await steps(w, 12);
    expect(names(w)).toEqual(['Well']);
  });

  it('a persistent scene does not remember dormant instances as destroyed (and saves neither)', async () => {
    const w = new World(town(), { evaluator: nodeEvaluator });
    await steps(w, 2);
    w.saveGame('s');
    w.gotoScene('out');
    await steps(w, 2);
    w.globals.inn_lv = 1;
    w.gotoScene('town');
    await steps(w, 2);
    expect(names(w)).toEqual(['Inn', 'Well']);
    // The save was made while the inn didn't exist: loading it with the inn unlocked shows it.
    w.loadGame('s');
    await steps(w, 2);
    w.globals.inn_lv = 1;
    await steps(w, 12);
    expect(names(w)).toEqual(['Inn', 'Well']);
  });

  it('refreshInstances() applies a change immediately; playtest vars start at a later stage', async () => {
    const b = town({ s: `onStart(() => { vars.inn_lv = 2; refreshInstances(); log('now ' + find('house').map((h) => h.name).sort().join(',')) })` });
    const r = await runPlaytest(b, { seconds: 0.1, evaluator: nodeEvaluator });
    expect(r.logs.join('\n')).toContain('now Big inn,Inn,Well');
    const r2 = await runPlaytest(town(), { seconds: 0.1, vars: { inn_lv: 1 }, playerAt: [200, 100] });
    expect(r2.final.actors.filter((a) => a.object === 'house').length).toBe(2);
    expect(r2.final.actors.find((a) => a.object === 'player')).toMatchObject({ x: 200, y: 100 });
  });
});

describe('spawn options', () => {
  it('spawns with another sprite, a name and props visible in awake()', async () => {
    const b = town({
      Probe: `export default class Probe extends Behaviour { awake() { log('awake ' + this.self.name + ' ' + this.self.role) } }`,
      s: `onStart(() => { const h = spawn('house', 50, 50, { role: 'cook' }, { sprite: 'tent', name: 'Bram' }); log('spawned ' + h.name) })`,
    });
    b.sprites.tent = { ...BOX, name: 'tent', width: 20 };
    b.game.objects.find((o) => o.name === 'house')!.behaviors.push({ type: 'script', name: 'Probe' });
    const r = await runPlaytest(b, { seconds: 0.1, evaluator: nodeEvaluator });
    const logs = r.logs.join('\n');
    expect(logs).toContain('awake Bram cook');
    expect(logs).toContain('spawned Bram');
    expect(r.world.actors.find((a) => a.instName === 'Bram')?.asset?.width).toBe(20);
  });
});

describe('MCP data tools and active_if', () => {
  let dir: string;
  let client: Client;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
    const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(text);
    return text;
  };
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-data-'));
    const server = createMcpServer(new Workspace(dir));
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterEach(async () => {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes, updates, reads and deletes tables; places conditional instances; playtests with vars', async () => {
    await call('write_data', { table: 'items', description: 'Shop stock', columns: [{ name: 'name' }, { name: 'price', type: 'number' }, { name: 'tier', type: 'number' }], rows: [{ id: 'potion', name: 'Potion', price: 15, tier: 1 }] });
    await call('update_data', { table: 'items', upsert: [{ id: 'ether', name: 'Ether', price: 25, tier: 2 }, { id: 'potion', price: 12 }], add_columns: [{ name: 'heal', type: 'number' }] });
    const read = await call('read_data', { table: 'items' });
    expect(read).toContain('"id":"potion","name":"Potion","price":12');
    expect(read).toContain('heal:number');
    expect(await call('list_data')).toContain('items: 2 rows');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'items.json'), 'utf8')).rows).toHaveLength(2);

    await call('create_sprite', { name: 'box', width: 16, height: 16 });
    await call('set_game', { variables: { shop_lv: 0 } });
    await call('set_object', { name: 'player', sprite: 'box', behaviors: [{ type: 'topdown' }] });
    await call('set_object', { name: 'stall', sprite: 'box', text: 'db("items", "ether", "name")' });
    await call('create_scene', { name: 'town', cols: 10, rows: 8 });
    await call('place_instances', { scene: 'town', instances: [{ object: 'player', x: 0, y: 0 }, { object: 'stall', x: 40, y: 0, name: 'Ether stall', active_if: 'shop_lv >= 2' }] });
    await expect(call('update_instances', { scene: 'town', object: 'stall', active_if: 'shop_lv >' })).rejects.toThrow(/active_if/);
    expect(await call('get_scene', { scene: 'town' })).toContain('active if (shop_lv >= 2)');
    expect(await call('validate_game')).toContain('No problems');
    const before = await call('playtest', { seconds: 0.2 });
    expect(before).not.toContain('Ether stall');
    const after = await call('playtest', { seconds: 0.2, vars: { shop_lv: 2 } });
    expect(after).toContain('"Ether stall" stall');
    const preview = await call('preview_scene', { scene: 'town' });
    expect(preview).toContain('Hidden (active_if false with the initial variables): Ether stall (shop_lv >= 2)');
    expect(await call('preview_scene', { scene: 'town', vars: { shop_lv: 2 } })).not.toContain('Hidden');
    // Sprites named only in data tables are part of the game.
    await call('create_sprite', { name: 'potion_icon', width: 8, height: 8 });
    await call('update_data', { table: 'items', add_columns: [{ name: 'icon' }], upsert: [{ id: 'potion', icon: 'potion_icon' }] });
    expect(Object.keys(loadGameBundle(new Workspace(dir)).bundle.sprites)).toContain('potion_icon');
    await call('delete_data', { table: 'items' });
    expect(await call('list_data')).toContain('No data tables');
  });
});
