import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { androidString, exportAndroid, findAndroidTools } from '../src/server/android.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server/mcp.js';
import { Workspace } from '../src/server/store.js';
import { androidPackage, createGame, createScene, normalizeGame } from '../src/core/game/types.js';

const hasSdk = (() => {
  try {
    findAndroidTools();
    return true;
  } catch {
    return false;
  }
})();

describe('android settings', () => {
  it('derives a valid package from the title', () => {
    expect(androidPackage({ title: 'Le Ceneri di Valdora' })).toBe('com.spritifer.leceneridivaldora');
    expect(androidPackage({ title: '2 Fast' })).toBe('com.spritifer.g2fast');
    expect(androidPackage({ title: 'Già', android: { package: 'it.me.gia' } })).toBe('it.me.gia');
  });

  it('keeps only non-empty settings', () => {
    expect(normalizeGame({ android: { package: ' a.b ', version: '', icon: 3 } }).android).toEqual({ package: 'a.b' });
    expect(normalizeGame({ android: { version: ' ' } }).android).toBeUndefined();
  });

  it('escapes titles for strings.xml', () => {
    expect(androidString(`L'ombra & "x"`)).toBe(`L\\'ombra &amp; \\&quot;x\\&quot;`);
    expect(androidString('@home')).toBe('\\@home');
  });
});

describe('set_game android fields', () => {
  it('stores and clears the settings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-android-mcp-'));
    const ws = new Workspace(dir);
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer(ws).connect(a), client.connect(b)]);
    try {
      await client.callTool({ name: 'set_game', arguments: { android_package: 'it.me.gioco', android_version: '1.2' } });
      expect(ws.loadGame().android).toEqual({ package: 'it.me.gioco', version: '1.2' });
      await client.callTool({ name: 'set_game', arguments: { android_version: '' } });
      expect(ws.loadGame().android).toEqual({ package: 'it.me.gioco' });
      await client.callTool({ name: 'set_game', arguments: { android_package: '' } });
      expect(ws.loadGame().android).toBeUndefined();
      const bad = (await client.callTool({ name: 'set_game', arguments: { android_package: 'nodots' } })) as { isError?: boolean };
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasSdk)('android build', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-android-test-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('builds a signed APK, and later builds keep the same key', async () => {
    const ws = new Workspace(dir);
    ws.saveGame({ ...createGame(), title: `L'ombra & co`, startScene: 'main', android: { package: 'it.test.ombra', version: '2.1' } }, 'test');
    ws.saveScene(createScene({ name: 'main', cols: 4, rows: 4 }), 'test');
    const keysDir = path.join(dir, 'keys');

    const r = await exportAndroid(ws, { keysDir });
    const tools = findAndroidTools();
    const buildTools = path.dirname(tools.d8Jar).replace(/[\\/]lib$/, '');
    const badging = execFileSync(path.join(buildTools, 'aapt'), ['dump', 'badging', r.file], { encoding: 'utf8' });
    expect(badging).toContain("package: name='it.test.ombra'");
    expect(badging).toContain("versionName='2.1'");
    expect(badging).toMatch(/application-label:'L'ombra & co'/);
    expect(badging).toContain("launchable-activity: name='com.spritifer.player.MainActivity'");
    expect(execFileSync(path.join(buildTools, 'aapt'), ['list', r.file], { encoding: 'utf8' })).toMatch(/assets\/index\.html[\s\S]*classes\.dex|classes\.dex[\s\S]*assets\/index\.html/);
    const certOf = () => execFileSync(tools.java, ['-jar', tools.apksignerJar, 'verify', '--print-certs', r.file], { encoding: 'utf8' }).match(/SHA-256 digest: (\w+)/)![1];
    const first = certOf();

    await exportAndroid(ws, { keysDir });
    expect(certOf()).toBe(first);
  }, 120_000);
});
