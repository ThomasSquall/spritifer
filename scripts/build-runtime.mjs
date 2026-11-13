// Builds both game runtimes (vite.runtime.config.ts): player.js for exported games, then player-dev.js for the game page
// served by the editor. The variable is passed here and not on the command line, so it works on every shell (Windows cmd too).
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const vite = path.join('node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
for (const kind of ['export', 'dev']) {
  const r = spawnSync(vite, ['build', '-c', 'vite.runtime.config.ts'], { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, RUNTIME_KIND: kind } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
