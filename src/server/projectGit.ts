/**
 * Git for game projects: each game folder is its own repository, separate from the editor's code.
 * The editor (Git tab) and the MCP tools both go through this module.
 */

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Rebuildable output and local-only snapshots stay out of the game's history. */
export const GAME_GITIGNORE = `# Rebuilt by Export
export/

# Local snapshots of single sprites (save_version / silhouette_check)
.versions/

# Generated for code editors
scripts/spritifer.d.ts
scripts/jsconfig.json

__pycache__/
*.pyc
*.log
.DS_Store
.env*
`;

const MAX_OUTPUT = 128 * 1024 * 1024;
const LOCAL_TIMEOUT = 180_000;
const NETWORK_TIMEOUT = 600_000;
const MAX_DIFF_CHARS = 200_000;
const NOT_ENABLED = 'Version control is not enabled for this project';

export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface GitChange {
  path: string;
  status: GitChangeStatus;
  oldPath?: string;
}

export interface GitCommit {
  sha: string;
  short: string;
  author: string;
  /** Milliseconds since the epoch. */
  time: number;
  subject: string;
}

export interface GitStatus {
  installed: boolean;
  enabled: boolean;
  /** Set when an enclosing repository already tracks this folder (it then can't have its own). */
  parentRepo: string | null;
  branch: string | null;
  head: string | null;
  changes: GitChange[];
  remote: string | null;
  /** True once the current branch has been pushed to the remote. */
  pushed: boolean;
  ahead: number;
  behind: number;
}

/** Never inherits another repository's context, never waits for a password nobody can type, and only speaks safe transports. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'https:ssh:file',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
    LC_ALL: 'C',
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function gitError(err: unknown, stderr: string): Error {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Error('Git is not installed on this computer');
  const detail = stderr.trim().slice(-600);
  return new Error(detail || (err as Error).message);
}

function git(dir: string, args: string[], timeout = LOCAL_TIMEOUT): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...args], { env: gitEnv(), maxBuffer: MAX_OUTPUT, timeout }, (err, stdout, stderr) => {
      if (err) reject(gitError(err, stderr));
      else resolve(stdout);
    });
  });
}

function gitSync(dir: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', dir, ...args], { env: gitEnv(), maxBuffer: MAX_OUTPUT, timeout: LOCAL_TIMEOUT, stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    throw gitError(err, String((err as { stderr?: unknown }).stderr ?? ''));
  }
}

const orNull = (p: Promise<string>): Promise<string | null> => p.then((s) => s.trim() || null, () => null);

/** Checks the folder itself: `git -C` alone would silently act on any repository that encloses it. */
function hasOwnRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

function requireRepo(dir: string): void {
  if (!hasOwnRepo(dir)) throw new Error(NOT_ENABLED);
}

/** Commits can't ask for a passphrase here, and need an author even on a machine with no git identity. */
function commitConfig(hasIdentity: boolean): string[] {
  return ['-c', 'commit.gpgsign=false', ...(hasIdentity ? [] : ['-c', 'user.name=Spritifer', '-c', 'user.email=spritifer@localhost'])];
}

function checkSha(sha: string): void {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`Not a version id: "${sha}"`);
}

function checkRef(ref: string): void {
  if (ref !== 'HEAD' && !/^[0-9a-f]{7,40}\^?$/.test(ref)) throw new Error(`Not a version id: "${ref}"`);
}

function checkFile(file: string): void {
  const parts = file.split('/');
  if (!file || file.startsWith('-') || path.isAbsolute(file) || file.includes('\\') || parts.includes('..') || parts.includes('.git')) throw new Error(`Not a project file: "${file}"`);
}

function checkRemoteUrl(url: string): void {
  if (!/^(https:\/\/|ssh:\/\/|file:\/\/)\S+$/.test(url) && !/^[A-Za-z0-9_][\w.-]*@[\w.-]+:\S+$/.test(url)) {
    throw new Error('Use an https://, ssh:// or git@host:path address');
  }
}

/**
 * Makes the folder a repository holding the game as it is now. Synchronous so a new project is fully set up
 * when it's returned. Refuses a folder an enclosing repository already tracks, like the bundled examples.
 */
export function enableGit(dir: string): void {
  if (hasOwnRepo(dir)) return;
  const parent = trackingParent(dir);
  if (parent) throw new Error(`This folder is already versioned by the repository at ${parent}`);
  gitSync(dir, ['init', '-q', '-b', 'main']);
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, GAME_GITIGNORE);
  gitSync(dir, ['add', '-A']);
  const identity = gitIdentitySync(dir);
  gitSync(dir, [...commitConfig(identity), 'commit', '-q', '--allow-empty', '-m', 'Start tracking this game']);
}

function gitIdentitySync(dir: string): boolean {
  try {
    return !!gitSync(dir, ['config', 'user.name']).trim() && !!gitSync(dir, ['config', 'user.email']).trim();
  } catch {
    return false;
  }
}

async function gitIdentity(dir: string): Promise<boolean> {
  const [name, email] = await Promise.all([orNull(git(dir, ['config', 'user.name'])), orNull(git(dir, ['config', 'user.email']))]);
  return !!name && !!email;
}

function trackingParent(dir: string): string | null {
  try {
    const top = gitSync(dir, ['rev-parse', '--show-toplevel']).trim();
    return top && gitSync(dir, ['ls-files', '--', '.']).trim() ? top : null;
  } catch {
    return null;
  }
}

function parseStatus(out: string): GitChange[] {
  const parts = out.split('\0');
  const changes: GitChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const [x, y] = [entry[0], entry[1]];
    const change: GitChange = { path: entry.slice(3), status: 'modified' };
    if (x === 'R' || x === 'C') {
      change.oldPath = parts[++i];
      change.status = 'renamed';
    } else if (x === '?' || x === 'A') change.status = 'added';
    else if (x === 'D' || y === 'D') change.status = 'deleted';
    changes.push(change);
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export async function gitStatus(dir: string): Promise<GitStatus> {
  const base: GitStatus = { installed: true, enabled: false, parentRepo: null, branch: null, head: null, changes: [], remote: null, pushed: false, ahead: 0, behind: 0 };
  try {
    await git(dir, ['--version']);
  } catch {
    return { ...base, installed: false };
  }
  if (!hasOwnRepo(dir)) return { ...base, parentRepo: trackingParent(dir) };
  const [branch, head, porcelain, remote, upstream] = await Promise.all([
    orNull(git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'])),
    orNull(git(dir, ['rev-parse', '--verify', '-q', 'HEAD'])),
    git(dir, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']),
    orNull(git(dir, ['remote', 'get-url', 'origin'])),
    orNull(git(dir, ['rev-parse', '--abbrev-ref', '@{u}'])),
  ]);
  let [behind, ahead] = [0, 0];
  if (upstream) {
    const counts = await orNull(git(dir, ['rev-list', '--left-right', '--count', '@{u}...HEAD']));
    if (counts) [behind, ahead] = counts.split(/\s+/).map(Number);
  }
  return { ...base, enabled: true, branch, head, changes: parseStatus(porcelain), remote, pushed: !!upstream, ahead, behind };
}

/** Commits everything in the project. Returns the new version id. */
export async function gitCommit(dir: string, message: string): Promise<string> {
  requireRepo(dir);
  const text = message.trim();
  if (!text) throw new Error('Write a message describing this version');
  await git(dir, ['add', '-A']);
  if (!(await git(dir, ['diff', '--cached', '--name-only'])).trim()) throw new Error('Nothing to commit: the game has not changed since the last version');
  await git(dir, [...commitConfig(await gitIdentity(dir)), 'commit', '-q', '-m', text]);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

export async function gitLog(dir: string, opts: { limit?: number; skip?: number } = {}): Promise<GitCommit[]> {
  requireRepo(dir);
  if (!(await orNull(git(dir, ['rev-parse', '--verify', '-q', 'HEAD'])))) return [];
  const out = await git(dir, ['log', `--max-count=${opts.limit ?? 30}`, `--skip=${opts.skip ?? 0}`, '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e']);
  return out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((row) => {
    const [sha, short, author, at, subject] = row.split('\x1f');
    return { sha, short, author, time: Number(at) * 1000, subject };
  });
}

/** The files a version changed. */
export async function gitCommitFiles(dir: string, sha: string): Promise<GitChange[]> {
  requireRepo(dir);
  checkSha(sha);
  const parts = (await git(dir, ['diff-tree', '--root', '-r', '-M', '--no-commit-id', '--name-status', '-z', sha])).split('\0');
  const files: GitChange[] = [];
  for (let i = 0; i + 1 < parts.length; i++) {
    const code = parts[i][0];
    if (code === 'R' || code === 'C') {
      files.push({ oldPath: parts[i + 1], path: parts[i + 2], status: code === 'R' ? 'renamed' : 'added' });
      i += 2;
    } else {
      files.push({ path: parts[i + 1], status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified' });
      i += 1;
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Text diff of one file: in a version, or between the last version and the files on disk when `sha` is omitted. */
export async function gitDiff(dir: string, file: string, sha?: string): Promise<{ text: string; truncated: boolean }> {
  requireRepo(dir);
  checkFile(file);
  if (sha) checkSha(sha);
  const out = sha
    ? await git(dir, ['diff-tree', '--root', '-p', '--no-color', '--no-commit-id', sha, '--', file])
    : await git(dir, ['diff', '--no-color', 'HEAD', '--', file]);
  return { text: out.slice(0, MAX_DIFF_CHARS), truncated: out.length > MAX_DIFF_CHARS };
}

/** A file's content at a version ("HEAD", an id, or an id followed by ^ for the version before it). */
export async function gitFileAt(dir: string, ref: string, file: string): Promise<string> {
  requireRepo(dir);
  checkRef(ref);
  checkFile(file);
  return git(dir, ['show', `${ref}:${file}`]);
}

export interface GitRestoreResult {
  /** The new version recording the restore, or null if the files already matched. */
  commit: string | null;
  /** The automatic version holding uncommitted work from before the restore. */
  snapshot: string | null;
}

/**
 * Brings the whole game, or one file, back to a version. History only ever grows: uncommitted work is committed
 * first and the restore is a new version, so a restore can itself be restored away.
 */
export async function gitRestore(dir: string, sha: string, file?: string): Promise<GitRestoreResult> {
  requireRepo(dir);
  checkSha(sha);
  if (file) checkFile(file);
  const [short, subject] = (await git(dir, ['log', '-1', '--format=%h%x1f%s', `${sha}^{commit}`])).trim().split('\x1f');
  const identity = commitConfig(await gitIdentity(dir));
  const commitStaged = async (message: string): Promise<string | null> => {
    if (!(await git(dir, ['diff', '--cached', '--name-only'])).trim()) return null;
    await git(dir, [...identity, 'commit', '-q', '-m', message]);
    return (await git(dir, ['rev-parse', 'HEAD'])).trim();
  };

  await git(dir, ['add', '-A']);
  const snapshot = await commitStaged(`Auto-save before restoring ${short}`);
  if (file) {
    await git(dir, ['restore', `--source=${sha}`, '--staged', '--worktree', '--', file]);
    return { snapshot, commit: await commitStaged(`Restore ${file} from ${short}`) };
  }
  await git(dir, ['read-tree', '-u', '--reset', sha]);
  return { snapshot, commit: await commitStaged(`Restore version ${short}: ${subject}`) };
}

/** Sets the "origin" address; an empty address disconnects it. */
export async function gitSetRemote(dir: string, url: string): Promise<void> {
  requireRepo(dir);
  const target = url.trim();
  const current = await orNull(git(dir, ['remote', 'get-url', 'origin']));
  if (!target) {
    if (current) await git(dir, ['remote', 'remove', 'origin']);
    return;
  }
  checkRemoteUrl(target);
  await git(dir, ['remote', current ? 'set-url' : 'add', 'origin', target]);
}

async function requireRemote(dir: string): Promise<string> {
  requireRepo(dir);
  if (!(await orNull(git(dir, ['remote', 'get-url', 'origin'])))) throw new Error('Connect a remote repository first');
  const branch = await orNull(git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']));
  if (!branch) throw new Error('Not on a branch');
  return branch;
}

export async function gitPush(dir: string): Promise<void> {
  const branch = await requireRemote(dir);
  await git(dir, ['push', '-q', '-u', 'origin', branch], NETWORK_TIMEOUT);
}

/** Fast-forward only: it never merges or rewrites anything on its own. */
export async function gitPull(dir: string): Promise<void> {
  const branch = await requireRemote(dir);
  await git(dir, ['pull', '-q', '--ff-only', 'origin', branch], NETWORK_TIMEOUT);
}
