import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSprite } from '../src/core/sprite.js';
import { createGame, createScene, normalizeObject } from '../src/core/game/types.js';
import { cachedScenePreview, sharedGameBundle } from '../src/server/game.js';
import { Workspace } from '../src/server/store.js';

let dir: string;
let ws: Workspace;

const previewFile = () => path.join(dir, '.spritifer', 'previews', 'level.1.json');
const KEPT = Buffer.from('the kept image');

/** Swaps the kept image for a recognizable one: getting it back proves nothing was redrawn. */
function markKept(): void {
  const entry = JSON.parse(fs.readFileSync(previewFile(), 'utf8'));
  fs.writeFileSync(previewFile(), JSON.stringify({ ...entry, png: KEPT.toString('base64') }));
}
const preview = () => cachedScenePreview(ws, 'level', { scale: 1 });
const expectKept = () => expect(preview().equals(KEPT)).toBe(true);
const expectRedrawn = () => expect(preview().equals(KEPT)).toBe(false);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-preview-'));
  ws = new Workspace(dir);
  for (const name of ['hero', 'unplaced']) ws.save(createSprite({ name, width: 16, height: 16 }), 'test');
  ws.saveGame(createGame({
    title: 'Test',
    startScene: 'level',
    objects: [normalizeObject({ name: 'player', sprite: 'hero' }), normalizeObject({ name: 'chest', sprite: 'unplaced' })],
  }), 'test');
  const scene = createScene({ name: 'level', cols: 10, rows: 8, tileSize: 16 });
  scene.instances.push({ id: 'p', object: 'player', x: 32, y: 32 });
  ws.saveScene(scene, 'test');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('scene previews kept on disk', () => {
  it('reuses the image while nothing changed', () => {
    expect(preview().subarray(1, 4).toString()).toBe('PNG');
    markKept();
    expectKept();
  });

  it('draws again when a sprite in the scene changes', () => {
    preview();
    markKept();
    ws.save(ws.load('hero'), 'test');
    expectRedrawn();
  });

  it('keeps the image when the changed sprite is not in the scene', () => {
    preview();
    markKept();
    ws.save(ws.load('unplaced'), 'test');
    expectKept();
  });

  it('draws again when the scene changes', () => {
    preview();
    markKept();
    ws.saveScene(ws.loadScene('level'), 'test');
    expectRedrawn();
  });

  it('draws again when the game changes', () => {
    preview();
    markKept();
    ws.saveGame(ws.loadGame(), 'test');
    expectRedrawn();
  });

  it('keeps grid and plain images apart', () => {
    preview();
    markKept();
    expect(cachedScenePreview(ws, 'level', { scale: 1, grid: true }).equals(KEPT)).toBe(false);
    expectKept();
  });

  it('stays out of the game\'s version control', () => {
    preview();
    expect(fs.readFileSync(path.join(dir, '.spritifer', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('still answers for a scene that does not exist', () => {
    expect(() => cachedScenePreview(ws, 'nowhere')).toThrow(/not found/);
  });
});

describe('shared game bundle', () => {
  it('is reused until a file of the game changes', () => {
    const first = sharedGameBundle(ws);
    expect(sharedGameBundle(ws)).toBe(first);
    ws.save(ws.load('unplaced'), 'test');
    expect(sharedGameBundle(ws)).not.toBe(first);
  });

  it('notices files written by other processes', () => {
    const first = sharedGameBundle(ws);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'Patrol.js'), '// new script\n');
    expect(sharedGameBundle(ws)).not.toBe(first);
  });

  it('ignores the editor support files next to the scripts', () => {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    const first = sharedGameBundle(ws);
    fs.writeFileSync(path.join(dir, 'scripts', 'spritifer.d.ts'), '// generated\n');
    fs.writeFileSync(path.join(dir, 'scripts', 'jsconfig.json'), '{}\n');
    expect(sharedGameBundle(ws)).toBe(first);
  });

  it('does not mix up two games', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-preview-'));
    try {
      const otherWs = new Workspace(other);
      otherWs.saveGame(createGame({ title: 'Other' }), 'test');
      expect(sharedGameBundle(ws).bundle.game.title).toBe('Test');
      expect(sharedGameBundle(otherWs).bundle.game.title).toBe('Other');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
