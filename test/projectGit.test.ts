import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { enableGit, gitCommit, gitCommitFiles, gitDiff, gitFileAt, gitLog, gitPull, gitPush, gitRestore, gitSetRemote, gitStatus } from '../src/server/projectGit.js';
import { ProjectRegistry } from '../src/server/projects.js';
import { Workspace } from '../src/server/store.js';
import { createMcpServer } from '../src/server/mcp.js';
import { startEditorServer } from '../src/server/http.js';

let tmp: string;
let game: string;
const write = (name: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(game, name)), { recursive: true });
  fs.writeFileSync(path.join(game, name), text);
};
const read = (name: string) => fs.readFileSync(path.join(game, name), 'utf8');
const shell = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-git-'));
  game = path.join(tmp, 'game');
  fs.mkdirSync(game);
  write('game.json', '{"title":"one"}\n');
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('project git', () => {
  it('starts with the game as first version and leaves generated files out', async () => {
    write('export/web/index.html', 'x');
    write('.versions/a/1.json', '{}');
    write('scripts/spritifer.d.ts', 'x');
    write('scripts/hero.js', 'x');
    enableGit(game);
    const s = await gitStatus(game);
    expect(s).toMatchObject({ enabled: true, branch: 'main', changes: [] });
    const tracked = shell(game, 'ls-files').trim().split('\n');
    expect(tracked).toEqual(['.gitignore', 'game.json', 'scripts/hero.js']);
    expect(await gitLog(game)).toHaveLength(1);
  });

  it('reports, commits and describes changes', async () => {
    enableGit(game);
    write('game.json', '{"title":"two"}\n');
    write('scene é.scene.json', '{}\n');
    const changes = (await gitStatus(game)).changes;
    expect(changes).toEqual([{ path: 'game.json', status: 'modified' }, { path: 'scene é.scene.json', status: 'added' }]);
    expect((await gitDiff(game, 'game.json')).text).toContain('+{"title":"two"}');

    const sha = await gitCommit(game, 'Second');
    expect((await gitStatus(game)).changes).toEqual([]);
    expect((await gitLog(game))[0]).toMatchObject({ sha, subject: 'Second' });
    expect((await gitCommitFiles(game, sha)).map((f) => f.status)).toEqual(['modified', 'added']);
    expect(await gitFileAt(game, `${sha}^`, 'game.json')).toContain('one');
    await expect(gitCommit(game, 'Again')).rejects.toThrow(/Nothing to commit/);
    write('game.json', '{"title":"three"}\n');
    await expect(gitCommit(game, '   ')).rejects.toThrow(/message/);
  });

  it('restores without losing anything', async () => {
    write('old.sprite.json', 'old');
    enableGit(game);
    const first = (await gitLog(game))[0].sha;
    fs.rmSync(path.join(game, 'old.sprite.json'));
    write('new.sprite.json', 'new');
    write('game.json', '{"title":"two"}\n');
    await gitCommit(game, 'Second');
    write('game.json', '{"title":"unsaved"}\n');

    const r = await gitRestore(game, first);
    expect(r.snapshot).toBeTruthy();
    expect(r.commit).toBeTruthy();
    expect(read('game.json')).toContain('one');
    expect(read('old.sprite.json')).toBe('old');
    expect(fs.existsSync(path.join(game, 'new.sprite.json'))).toBe(false);
    expect((await gitStatus(game)).changes).toEqual([]);
    expect(await gitFileAt(game, r.snapshot!, 'game.json')).toContain('unsaved');
    expect((await gitLog(game)).map((c) => c.subject)).toEqual([expect.stringContaining('Restore version'), expect.stringContaining('Auto-save'), 'Second', 'Start tracking this game']);
    expect(await gitRestore(game, first)).toEqual({ commit: null, snapshot: null });
  });

  it('restores a single file', async () => {
    write('a.txt', 'a1');
    write('b.txt', 'b1');
    enableGit(game);
    const first = (await gitLog(game))[0].sha;
    write('a.txt', 'a2');
    write('b.txt', 'b2');
    await gitCommit(game, 'Second');
    await gitRestore(game, first, 'a.txt');
    expect(read('a.txt')).toBe('a1');
    expect(read('b.txt')).toBe('b2');
  });

  it('never touches an enclosing repository', async () => {
    shell(tmp, 'init', '-q');
    await expect(gitCommit(game, 'x')).rejects.toThrow(/not enabled/);
    shell(tmp, 'add', 'game/game.json');
    expect((await gitStatus(game)).parentRepo).toBe(fs.realpathSync(tmp));
    expect(() => enableGit(game)).toThrow(/already versioned/);
    expect(fs.existsSync(path.join(game, '.git'))).toBe(false);
  });

  it('rejects ids, paths and addresses that could smuggle options', async () => {
    enableGit(game);
    await expect(gitCommitFiles(game, '--output=/tmp/x')).rejects.toThrow(/version id/);
    await expect(gitDiff(game, '../secret')).rejects.toThrow(/project file/);
    await expect(gitDiff(game, '--output=x')).rejects.toThrow(/project file/);
    await expect(gitFileAt(game, 'HEAD:../x', 'game.json')).rejects.toThrow(/version id/);
    await expect(gitSetRemote(game, 'ext::sh -c touch${IFS}/tmp/pwn')).rejects.toThrow(/address/);
    await expect(gitSetRemote(game, '-oProxyCommand=x@y:z')).rejects.toThrow(/address/);
    await gitSetRemote(game, 'git@github.com:me/game.git');
    expect((await gitStatus(game)).remote).toBe('git@github.com:me/game.git');
    await gitSetRemote(game, '');
    expect((await gitStatus(game)).remote).toBeNull();
  });

  it('pushes and pulls, fast-forward only', async () => {
    enableGit(game);
    const bare = path.join(tmp, 'remote.git');
    shell(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
    await expect(gitPush(game)).rejects.toThrow(/remote/);
    await gitSetRemote(game, `file://${bare}`);
    expect((await gitStatus(game)).pushed).toBe(false);
    await gitPush(game);
    expect((await gitStatus(game))).toMatchObject({ pushed: true, ahead: 0, behind: 0 });
    write('game.json', '{"title":"two"}\n');
    await gitCommit(game, 'Second');
    expect((await gitStatus(game)).ahead).toBe(1);
    await gitPush(game);

    const clone = path.join(tmp, 'clone');
    shell(tmp, 'clone', '-q', bare, clone);
    shell(clone, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '--allow-empty', '-m', 'From elsewhere');
    shell(clone, 'push', '-q');
    await gitPull(game);
    expect((await gitLog(game))[0].subject).toBe('From elsewhere');
  });

  it('gives new projects a repository', () => {
    const ws = new Workspace(path.join(tmp, 'default'));
    const registry = new ProjectRegistry({ root: path.join(tmp, 'root'), defaultDir: ws.dir });
    const p = registry.create('Fresh', 'rpg');
    expect(fs.existsSync(path.join(p.dir, '.git'))).toBe(true);
    expect(shell(p.dir, 'status', '--porcelain')).toBe('');
  });

  it('is reachable from the local editor only', async () => {
    const ws = new Workspace(game);
    enableGit(game);
    const srv = await startEditorServer(ws, 0, '127.0.0.1', { registry: new ProjectRegistry({ root: path.join(tmp, 'root'), defaultDir: game }) });
    const addr = srv.server.address();
    const base = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
    try {
      expect((await (await fetch(`${base}/api/git`)).json()) as object).toMatchObject({ enabled: true });
      const denied = await fetch(`${base}/api/git/commit`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"message":"x"}' });
      expect(denied.status).toBe(403);
    } finally {
      await srv.close();
    }
  });

  it('works through MCP', async () => {
    const ws = new Workspace(game);
    const server = createMcpServer(ws, { registry: new ProjectRegistry({ root: path.join(tmp, 'root'), defaultDir: game }) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
      return { error: r.isError, text: r.content.map((c) => c.text).join('') };
    };
    expect((await call('git_status')).text).toContain('not enabled');
    expect((await call('git_enable')).error).toBeFalsy();
    write('game.json', '{"title":"two"}\n');
    expect((await call('git_status')).text).toContain('M game.json');
    expect((await call('git_commit', { message: 'Second' })).text).toContain('Saved version');
    expect((await call('git_log')).text).toContain('Second');
    await client.close();
  });
});
