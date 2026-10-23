#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Workspace } from './store.js';
import { startEditorServer } from './http.js';
import { createMcpServer } from './mcp.js';

const DEFAULT_PORT = 7420;

const HELP = `Spritifer — pixel art & animation editor with an MCP server

Usage:
  spritifer serve [--workspace DIR] [--port N] [--host H]   Run the web editor
  spritifer mcp   [--workspace DIR] [--port N] [--no-editor] MCP server on stdio (also starts the editor if the port is free)
  spritifer init  [--workspace DIR]                          Register the MCP server in ./.mcp.json for Claude Code

Options:
  --workspace DIR  Folder holding *.sprite.json files (default: $SPRITIFER_WORKSPACE or ./sprites)
  --port N         Editor port (default: $SPRITIFER_PORT or ${DEFAULT_PORT})
`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { cmd: positional[0], flags };
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  const workspaceDir = String(flags.workspace ?? process.env.SPRITIFER_WORKSPACE ?? './sprites');
  const port = Number(flags.port ?? process.env.SPRITIFER_PORT ?? DEFAULT_PORT);
  const host = String(flags.host ?? '127.0.0.1');

  switch (cmd) {
    case 'serve': {
      const ws = new Workspace(workspaceDir);
      const editor = await startEditorServer(ws, port, host);
      console.log(`Spritifer editor: ${editor.url}\nWorkspace: ${ws.dir}`);
      break;
    }
    case 'mcp': {
      const ws = new Workspace(workspaceDir);
      let editorUrl: string | undefined;
      if (!flags['no-editor'] && process.env.SPRITIFER_NO_EDITOR !== '1') {
        try {
          editorUrl = (await startEditorServer(ws, port, host)).url;
          console.error(`[spritifer] editor at ${editorUrl} (workspace ${ws.dir})`);
        } catch (err) {
          // Most likely another Spritifer instance owns the port; it shares the same files.
          editorUrl = `http://localhost:${port}`;
          console.error(`[spritifer] editor not started (${(err as Error).message}); assuming one is already running at ${editorUrl}`);
        }
      }
      const server = createMcpServer(ws, { editorUrl: () => editorUrl });
      await server.connect(new StdioServerTransport());
      // The editor's HTTP server would otherwise keep the process alive after the client disconnects.
      process.stdin.on('close', () => process.exit(0));
      break;
    }
    case 'init': {
      const cli = fileURLToPath(import.meta.url);
      const file = path.resolve('.mcp.json');
      const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      config.mcpServers ??= {};
      config.mcpServers.spritifer = {
        command: 'node',
        args: [cli, 'mcp', '--workspace', String(flags.workspace ?? './sprites')],
      };
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
      console.log(`Registered "spritifer" in ${file}. Restart Claude Code in this folder to load it.`);
      break;
    }
    default:
      console.log(HELP);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
