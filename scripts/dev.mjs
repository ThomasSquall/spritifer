#!/usr/bin/env node
// npm run dev: the editor server, rebuilt and restarted whenever the code changes.
// Arguments go to `spritifer serve`, e.g. npm run dev -- --workspace ../my-game --port 7421

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (name) => path.join(root, 'node_modules', '.bin', name);
const serveArgs = process.argv.slice(2);
const portFlag = serveArgs.indexOf('--port');
const port = Number(portFlag >= 0 ? serveArgs[portFlag + 1] : process.env.SPRITIFER_PORT ?? 7420);
const children = new Set();
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

/** Starts a long-running command; onLine sees its output one line at a time. */
function run(label, command, args, onLine, env = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.setEncoding('utf8').on('data', (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) if (line.trim()) onLine(line, label);
    });
  }
  child.on('exit', (code) => {
    children.delete(child);
    if (!stopping) {
      console.error(`[${label}] stopped unexpectedly (exit ${code})`);
      stop(1);
    }
  });
}

const show = (line, label) => console.log(`[${label}] ${line}`);

function portInUse() {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

if (await portInUse()) {
  console.error(`Port ${port} is already in use, probably by another Spritifer server. Stop it, or pass --port.`);
  process.exit(1);
}

function startServer() {
  run('server', process.execPath, ['--watch', '--watch-preserve-output', 'dist/server/cli.js', 'serve', ...serveArgs], show);
}

/** Vite prints every output file; only errors and the end of each build are worth a line. */
function bundle(label, args, reminder, env = {}) {
  run(label, bin('vite'), ['build', '--watch', ...args], (line) => {
    if (/built in/.test(line)) console.log(`[${label}] rebuilt, ${reminder}`);
    else if (/error/i.test(line)) console.error(`[${label}] ${line}`);
  }, { SPRITIFER_DEV: '1', ...env });
}

bundle('web', [], 'reload the editor page');
bundle('runtime', ['-c', 'vite.runtime.config.ts'], 'export again to update exported games');
bundle('runtime-dev', ['-c', 'vite.runtime.config.ts'], 'press Play or reload the game', { RUNTIME_KIND: 'dev' });

// The server starts after the first compile, so that compile doesn't restart it straight away.
let serverStarted = false;
run('tsc', bin('tsc'), ['-p', 'tsconfig.server.json', '--watch', '--preserveWatchOutput'], (line, label) => {
  if (/Found \d+ errors?\. Watching/.test(line)) {
    if (!/Found 0 errors/.test(line)) show(line, label);
    if (!serverStarted) {
      serverStarted = true;
      startServer();
    }
  } else if (!/Starting compilation|File change detected/.test(line)) show(line, label);
});
