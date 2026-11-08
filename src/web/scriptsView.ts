/**
 * Scripts page: the project's scripts/ folder as a tree (folders, drag & drop to move), a code editor with
 * autocompletion, and a panel showing what a component exposes to the inspector (params, hooks, methods, users).
 */

import { KEYS, SOUNDS } from '../core/game/catalog.js';
import { scriptBaseName, scriptDir, transformModule } from '../core/game/modules.js';
import { GLOBALS } from '../core/game/scriptApi.js';
import type { ComponentInfo } from '../core/game/script.js';
import { createCodeEditor } from './codeEditor.js';
import { addFromLibrary, newComponentScript, paramSpec } from './componentsUi.js';
import { LIBRARY } from '../core/game/library.js';
import { gameApi } from './gameApi.js';
import { state } from './gameState.js';
import { appNav } from './nav.js';
import { openPlay, registerFlusher } from './play.js';
import { type CompleteContext, complete, signatureAt } from './scriptComplete.js';
import { clear, confirmDialog, h, icon, iconButton, linkScriptRefs, modal, promptText, toast } from './dom.js';

const KEYWORDS = /^(async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|false|finally|for|from|function|if|import|in|instanceof|let|new|null|of|return|static|super|switch|this|throw|true|try|typeof|undefined|var|void|while)$/;
const API = new Set([...GLOBALS.map((g) => g.name), 'Behavior', 'behavior', 'ui']);
const HOOKS = /^(awake|onEnable|start|update|lateUpdate|onCollisionEnter|onCollisionStay|onCollisionExit|onInteract|onClick|onMessage|onSceneStart|onSceneEnd|onDraw|onDisable|onDestroy)$/;

/** append() that skips nulls. */
const add = (el: HTMLElement, ...children: (Node | string | null | undefined)[]) => el.append(...children.filter((c): c is Node | string => c !== null && c !== undefined));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Tiny JavaScript highlighter (comments, strings, numbers, keywords, Spritifer API, lifecycle methods). */
export function highlight(code: string): string {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
  let out = '';
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    out += esc(code.slice(last, m.index));
    const [t] = m;
    if (m[1]) out += `<span class="tk-c">${esc(t)}</span>`;
    else if (m[2]) out += `<span class="tk-s">${esc(t)}</span>`;
    else if (m[3]) out += `<span class="tk-n">${t}</span>`;
    else if (KEYWORDS.test(t)) out += `<span class="tk-k">${t}</span>`;
    else if (API.has(t) && code[m.index - 1] !== '.') out += `<span class="tk-a">${t}</span>`;
    else if (HOOKS.test(t) && /^\s*\(/.test(code.slice(m.index + t.length, m.index + t.length + 3))) out += `<span class="tk-h">${t}</span>`;
    else out += esc(t);
    last = m.index + t.length;
  }
  return out + esc(code.slice(last)) + '\n';
}

/** Syntax check in the browser (parse only, nothing runs). */
function syntaxError(code: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(`"use strict";\n${transformModule(code).code}`);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

const COLLAPSED_KEY = 'spritifer.scripts.collapsed';
function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
function saveCollapsed(s: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s]));
  } catch {
    // Storage blocked: folders just reopen.
  }
}

interface TreeFolder {
  path: string;
  folders: Map<string, TreeFolder>;
  files: string[];
}

function buildTree(files: string[], folders: string[]): TreeFolder {
  const root: TreeFolder = { path: '', folders: new Map(), files: [] };
  const folderAt = (path: string): TreeFolder => {
    let cur = root;
    if (!path) return cur;
    let acc = '';
    for (const part of path.split('/')) {
      acc = acc ? `${acc}/${part}` : part;
      let next = cur.folders.get(part);
      if (!next) {
        next = { path: acc, folders: new Map(), files: [] };
        cur.folders.set(part, next);
      }
      cur = next;
    }
    return cur;
  };
  for (const f of folders) folderAt(f);
  for (const f of files) folderAt(scriptDir(f)).files.push(f);
  return root;
}

export function completionContext(path: string, scripts: string[]): CompleteContext {
  const g = state.game;
  const properties = new Set<string>();
  for (const o of g?.objects ?? []) for (const k of Object.keys(o.properties)) properties.add(k);
  return {
    path,
    scripts,
    components: state.scriptInfo.components,
    objects: g?.objects.map((o) => o.name) ?? [],
    scenes: state.scenes.map((s) => s.name),
    sprites: state.sprites.map((s) => s.name),
    dialogues: state.dialogueInfo.nodes,
    sounds: SOUNDS,
    keys: [...Object.keys(g?.actions ?? {}), ...KEYS.filter((k) => k !== 'any')],
    audio: state.audio,
    variables: g?.variables ?? {},
    properties: [...properties],
    tags: [...new Set((g?.objects ?? []).flatMap((o) => o.tags ?? []))].sort(),
    tables: Object.fromEntries(state.tables.map((t) => [t.name, t.columns])),
  };
}

export function renderScripts(root: HTMLElement, selected: string | null, go: (name: string | null) => void, line?: number): { refresh: () => void; destroy: () => void } {
  clear(root);
  const side = h('aside', { class: 'obj-side script-side' });
  const main = h('section', { class: 'script-main' });
  root.append(h('div', { class: 'page script-page' }, appNav('scripts'), h('div', { class: 'obj-layout script-layout' }, side, main)));

  let files: string[] = [];
  let folders: string[] = [];
  let filter = '';
  let warnedOldServer = false;
  const collapsed = loadCollapsed();
  let editor: { name: string; flush: () => Promise<void>; refreshPanel: () => void } | null = null;
  const unregister = registerFlusher(async () => editor?.flush());
  const currentFolder = () => (selected ? (files.includes(selected) ? scriptDir(selected) : folders.includes(selected) ? selected : '') : '');

  const refreshInfo = async () => {
    try {
      state.scriptInfo = await gameApi.scriptInfo();
    } catch {
      // Keep the old info.
    }
  };

  const errorsOf = (name: string) => state.scriptInfo.errors.filter((e) => e.startsWith(`script ${name}:`));
  const componentOf = (name: string): ComponentInfo | undefined => state.scriptInfo.components.find((c) => c.path === name);

  // ---------------------------------------------------------------- actions
  const move = async (from: string, to: string) => {
    if (from === to) return;
    await editor?.flush();
    try {
      await gameApi.renameScript(from, to);
      await refreshInfo();
      if (selected === from) go(to);
      else if (selected?.startsWith(from + '/')) go(to + selected.slice(from.length));
      else void renderTree();
      await state.load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const newComponent = async (folder = currentFolder()) => {
    const n = await newComponentScript(folder);
    if (!n) return;
    const tree = await gameApi.scriptTree();
    const created = tree.files.map((f) => f.name).find((f) => scriptBaseName(f) === n && (!folder || f.startsWith(folder + '/'))) ?? n;
    go(created);
  };
  const newScript = async (folder = currentFolder()) => {
    const n = await promptText('New script (module)', 'Path: folder/name, e.g. utils/math, data/items', folder ? `${folder}/` : '', { caretAtEnd: true });
    if (!n) return;
    try {
      const name = n.replace(/\.js$/, '').replace(/^\/+|\/+$/g, '');
      await gameApi.createScript(name, 'script');
      await refreshInfo();
      go(name);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const newFolder = async (parent = currentFolder()) => {
    const n = await promptText('New folder', 'Folder (e.g. enemies, ui, managers, utils)', parent ? `${parent}/` : '', { caretAtEnd: true });
    if (!n) return;
    try {
      const name = n.replace(/^\/+|\/+$/g, '');
      await gameApi.createScriptFolder(name);
      collapsed.delete(name);
      void renderTree();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const openLibrary = async () => {
    let added: string | null = null;
    await modal('Component library', (close) => {
      const have = new Set(state.scriptInfo.components.map((c) => c.name));
      return h('div', { class: 'lib-list' },
        h('p', { class: 'muted small' }, 'Ready-made components. Adding one copies its file into scripts/ (with the ones it needs): it is a normal script you can read and change. Then attach it in Objects → Components, in the scene inspector or to a scene.'),
        ...LIBRARY.map((c) => h('div', { class: 'lib-card' },
          h('div', { class: 'lib-head' },
            h('span', { class: 'comp-icon' }, '◆'),
            h('strong', {}, c.name),
            h('span', { class: 'muted small' }, `scripts/${c.folder}/`),
            c.requires ? h('span', { class: 'badge muted-badge' }, `+ ${c.requires.join(', ')}`) : null,
            h('span', { class: 'spacer' }),
            have.has(c.name)
              ? h('span', { class: 'muted small' }, 'in the project')
              : h('button', { class: 'small primary', onclick: async () => {
                  if (await addFromLibrary([c.name])) {
                    added = `${c.folder}/${c.name}`;
                    close();
                  }
                } }, icon('plus', 12), 'Add'),
          ),
          h('p', { class: 'small' }, c.summary),
          h('p', { class: 'muted small' }, c.usage),
        )),
      );
    }, { wide: true });
    if (added) {
      const tree = await gameApi.scriptTree().catch(() => null);
      const base = scriptBaseName(added);
      go(tree?.files.map((f) => f.name).find((f) => scriptBaseName(f) === base) ?? added);
    }
  };
  const deleteFolder = async (folder: string) => {
    const inside = files.filter((f) => f.startsWith(folder + '/'));
    if (!(await confirmDialog('Delete folder', inside.length ? `Delete scripts/${folder}/ and the ${inside.length} script(s) in it?` : `Delete the empty folder scripts/${folder}/?`))) return;
    try {
      await gameApi.deleteScriptFolder(folder);
      await refreshInfo();
      if (selected && (selected === folder || selected.startsWith(folder + '/'))) go(null);
      else void renderTree();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const renamePath = async (path: string, isFolder: boolean) => {
    const to = await promptText(isFolder ? 'Rename / move folder' : 'Rename / move script', isFolder ? 'New folder path' : 'New path (folder/Name). Renaming a component also renames its class and every use.', path, { caretAtEnd: true });
    if (!to || to === path) return;
    await move(path, to.replace(/\.js$/, '').replace(/^\/+|\/+$/g, ''));
  };

  // ---------------------------------------------------------------- tree
  const tree = h('div', { class: 'script-tree' });
  const search = h('input', { type: 'text', class: 'hier-search', placeholder: 'Filter scripts…', oninput: () => { filter = search.value.trim().toLowerCase(); void renderTree(false); } });
  side.append(
    h('div', { class: 'script-toolbar' },
      h('button', { class: 'small primary', title: 'New component (a Behaviour class, one per file)', onclick: () => void newComponent() }, icon('plus', 13), 'Component'),
      h('button', { class: 'small', title: 'New plain script (helpers and data to import)', onclick: () => void newScript() }, icon('plus', 13), 'Script'),
      h('button', { class: 'small', title: 'New folder', onclick: () => void newFolder() }, icon('plus', 13), 'Folder'),
      h('button', { class: 'small', title: 'Ready-made components: Health, Damage, Door, Spawner…', onclick: () => void openLibrary() }, icon('copy', 13), 'Library'),
    ),
    search,
    tree,
    h('div', { class: 'reg-box script-reg' }),
  );
  const regBox = side.querySelector('.script-reg') as HTMLElement;

  const dropTarget = (el: HTMLElement, folder: string) => {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('text/x-spritifer-script')) return;
      e.preventDefault();
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop');
      const from = e.dataTransfer?.getData('text/x-spritifer-script');
      if (!from) return;
      e.preventDefault();
      e.stopPropagation();
      const base = scriptBaseName(from);
      const to = folder ? `${folder}/${base}` : base;
      if (to === from || folder === from || folder.startsWith(from + '/')) return;
      void move(from, to);
    });
  };
  const draggable = (el: HTMLElement, path: string) => {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/x-spritifer-script', path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
  };

  const fileRow = (name: string, depth: number) => {
    const comp = componentOf(name);
    const errs = errorsOf(name);
    const row = h('a', {
      class: `tree-row file${name === selected ? ' active' : ''}${errs.length ? ' has-error' : ''}`,
      href: `#/scripts/${encodeURIComponent(name)}`,
      title: errs.length ? errs.join('\n') : comp ? `Component ${comp.name}${comp.params.length ? ` — params: ${comp.params.map((p) => p.name).join(', ')}` : ''}` : `scripts/${name}.js`,
      style: `padding-left: ${8 + depth * 14}px`,
    },
      h('span', { class: `tree-icon ${comp ? 'comp' : 'mod'}` }, errs.length ? '!' : comp ? '◆' : 'JS'),
      h('span', { class: 'tree-name' }, `${scriptBaseName(name)}.js`),
      comp && comp.params.length ? h('span', { class: 'tree-meta muted' }, String(comp.params.length)) : null,
    );
    draggable(row, name);
    return row;
  };

  const folderRow = (f: TreeFolder, depth: number) => {
    const open = !collapsed.has(f.path) || !!filter;
    const row = h('div', { class: `tree-row folder${selected === f.path ? ' active' : ''}`, style: `padding-left: ${4 + depth * 14}px`, onclick: () => {
      if (collapsed.has(f.path)) collapsed.delete(f.path);
      else collapsed.add(f.path);
      saveCollapsed(collapsed);
      void renderTree(false);
    } },
      h('span', { class: `tree-chevron${open ? ' open' : ''}` }, '▸'),
      h('span', { class: 'tree-icon folder-icon' }, '▣'),
      h('span', { class: 'tree-name' }, f.path.split('/').pop()!),
      h('span', { class: 'tree-actions' },
        iconButton('plus', 'New component here', (e) => { e.stopPropagation(); void newComponent(f.path); }, { class: 'icon-btn tiny' }),
        iconButton('pencil', 'Rename / move folder', (e) => { e.stopPropagation(); void renamePath(f.path, true); }, { class: 'icon-btn tiny' }),
        iconButton('trash', 'Delete folder', (e) => { e.stopPropagation(); void deleteFolder(f.path); }, { class: 'icon-btn tiny' }),
      ),
    );
    dropTarget(row, f.path);
    draggable(row, f.path);
    return row;
  };

  const matches = (f: TreeFolder): boolean => !filter || f.files.some((x) => x.toLowerCase().includes(filter)) || [...f.folders.values()].some(matches);

  const renderNode = (f: TreeFolder, depth: number, into: HTMLElement) => {
    for (const [, sub] of [...f.folders].sort(([a], [b]) => a.localeCompare(b))) {
      if (!matches(sub)) continue;
      into.append(folderRow(sub, depth));
      if (!collapsed.has(sub.path) || filter) renderNode(sub, depth + 1, into);
    }
    for (const file of f.files.sort((a, b) => scriptBaseName(a).localeCompare(scriptBaseName(b)))) {
      if (filter && !file.toLowerCase().includes(filter)) continue;
      into.append(fileRow(file, depth));
    }
  };

  const renderTree = async (reload = true) => {
    if (reload) {
      try {
        const t = await gameApi.scriptTree();
        files = t.files.map((f) => f.name);
        folders = t.folders;
      } catch {
        // An editor server started before folders existed: list the files and derive the folders.
        try {
          files = (await gameApi.listScripts()).map((f) => f.name);
          folders = [...new Set(files.filter((f) => f.includes('/')).map((f) => scriptDir(f)))];
          if (!warnedOldServer) {
            warnedOldServer = true;
            toast('The Spritifer server is older than this page: restart it (or the MCP server) to get folders and components.', 'error');
          }
        } catch (err) {
          toast((err as Error).message, 'error');
        }
      }
    }
    clear(tree);
    const rootRow = h('div', { class: 'tree-row root' }, h('span', { class: 'tree-icon folder-icon' }, '▣'), h('span', { class: 'tree-name' }, 'scripts'), h('span', { class: 'tree-meta muted' }, String(files.length)));
    dropTarget(rootRow, '');
    dropTarget(tree, '');
    tree.append(rootRow);
    renderNode(buildTree(files, folders), 1, tree);
    if (!files.length && !folders.length) tree.append(h('p', { class: 'muted small tree-empty' }, 'No scripts yet. Create a component: one class per file, like Unity MonoBehaviours.'));
    // Loading errors not tied to a file in view.
    clear(regBox);
    const info = state.scriptInfo;
    const comps = info.components.filter((c) => c.path);
    const legacy = info.components.filter((c) => c.legacy);
    add(regBox,
      h('div', { class: 'small' }, h('b', {}, 'Components: '), comps.length ? String(comps.length) : '—'),
      legacy.length ? h('div', { class: 'small', title: 'Defined with behavior(name, {...}). They still work; move each to its own file (export default class Name extends Behaviour) to get inspector params and autocompletion.' }, h('b', {}, 'Legacy behaviors: '), legacy.map((c) => `${c.name}${c.definedIn ? ` (${c.definedIn}.js)` : ''}`).join(', ')) : null,
      info.functions.length ? h('div', { class: 'small' }, h('b', {}, 'Functions (func): '), info.functions.join(', ')) : null,
      ...info.errors.map((e) => h('div', { class: 'small problem' }, ...linkScriptRefs(e))),
      h('p', { class: 'muted small reg-help' }, 'Attach components in Objects → Components, per instance in the scene inspector, or to a scene / the whole game. Drag scripts onto folders to move them.'),
    );
  };

  // ---------------------------------------------------------------- editor
  const usedBy = async (name: string): Promise<string[]> => {
    const out: string[] = [];
    const g = state.game;
    for (const o of g?.objects ?? []) if (o.behaviors.some((b) => b.type === 'script' && b.name === name)) out.push(`object ${o.name}`);
    if (g?.components?.some((b) => b.name === name)) out.push('game (global)');
    const scenes = await Promise.all(state.scenes.map((s) => gameApi.getScene(s.name).catch(() => null)));
    for (const s of scenes) {
      if (!s) continue;
      if (s.components?.some((b) => b.name === name)) out.push(`scene ${s.name}`);
      const n = s.instances.filter((i) => i.components && name in i.components).length;
      if (n) out.push(`${n} instance${n > 1 ? 's' : ''} in ${s.name}`);
    }
    return out;
  };

  const panelFor = (name: string, panel: HTMLElement, reference: HTMLElement) => {
    clear(panel);
    const comp = componentOf(name);
    const errs = errorsOf(name);
    if (errs.length) panel.append(h('div', { class: 'comp-errors' }, ...errs.map((e) => h('div', { class: 'small problem' }, ...linkScriptRefs(e.replace(`script ${name}: `, ''))))));
    const legacyHere = state.scriptInfo.components.filter((c) => c.legacy && c.definedIn === name);
    if (legacyHere.length) {
      add(panel,
        h('div', { class: 'comp-section-title' }, 'Legacy behaviors in this file'),
        h('p', { class: 'small' }, `${legacyHere.map((c) => c.name).join(', ')} — defined with behavior(name, {...}). They keep working. To get inspector params, getComponent and autocompletion, move each to its own file as a class:`),
        h('pre', { class: 'script-ref' }, `// scripts/${legacyHere[0].name}.js\nexport default class ${legacyHere[0].name} extends Behaviour {\n  awake() {}          // was create(self, params)\n  update(dt) {}       // was update(self, dt, params)\n  onCollisionEnter(other) {}  // was collide(self, other)\n  onInteract(player) {}       // was interact(self, player)\n  onDestroy() {}      // was destroy(self)\n}  // self → this.self, params → public fields`),
      );
    }
    if (!comp) {
      panel.append(
        h('p', { class: 'muted small' }, 'A plain script (module): export helpers and data, then import them from components:'),
        h('pre', { class: 'script-ref' }, `import { clamp } from '${name}'`),
        h('p', { class: 'muted small' }, 'To make it a component, export a class named like the file:'),
        h('pre', { class: 'script-ref' }, `export default class ${scriptBaseName(name)} extends Behaviour {\n  update(dt) {}\n}`),
      );
    } else {
      add(panel,
        h('div', { class: 'comp-panel-head' }, h('span', { class: 'comp-icon' }, '◆'), h('strong', {}, comp.name), h('span', { class: 'muted small' }, 'component')),
        comp.doc ? h('p', { class: 'small' }, comp.doc) : null,
        h('div', { class: 'comp-section-title' }, 'Inspector params'),
        comp.params.length
          ? h('table', { class: 'comp-params-table' }, ...comp.params.map((p) => {
              const spec = paramSpec(p);
              return h('tr', { title: p.help ?? '' }, h('td', {}, h('code', {}, p.name)), h('td', { class: 'muted' }, p.type + (p.options ? ` (${p.options.join(' | ')})` : '') + (spec.min !== undefined || spec.max !== undefined ? ` ${spec.min ?? ''}…${spec.max ?? ''}` : '')), h('td', {}, h('code', {}, JSON.stringify(p.default))));
            }))
          : h('p', { class: 'muted small' }, 'None yet: public fields (speed = 40) become params. Fields starting with _ stay private.'),
        h('div', { class: 'comp-section-title' }, 'Lifecycle'),
        h('div', { class: 'chips' }, ...(comp.hooks.length ? comp.hooks.map((x) => h('span', { class: 'chip on' }, x)) : [h('span', { class: 'muted small' }, 'none')])),
        comp.methods.length ? h('div', { class: 'comp-section-title' }, 'Methods (getComponent(…).method() or event "Call component method")') : null,
        comp.methods.length ? h('div', { class: 'chips' }, ...comp.methods.map((x) => h('span', { class: 'chip' }, `${x}()`))) : null,
        ...comp.warnings.map((w) => h('p', { class: 'warn-text small' }, w)),
        h('div', { class: 'comp-section-title' }, 'Used by'),
      );
      const used = h('div', { class: 'small muted' }, '…');
      panel.append(used);
      void usedBy(comp.name).then((list) => {
        clear(used);
        if (!list.length) used.append('Not attached yet. Add it in Objects → Components, in the scene inspector, or as a scene / game component.');
        else for (const u of list) used.append(h('div', {}, u));
      });
    }
    panel.append(h('details', { class: 'script-ref-box inline-ref' }, h('summary', {}, 'Script API reference'), reference));
  };

  const renderEditor = async () => {
    clear(main);
    if (!selected || !files.includes(selected)) {
      main.append(h('div', { class: 'empty big' },
        h('h2', {}, 'Scripts'),
        h('p', { class: 'muted' }, 'Components are JavaScript classes, one per file, like Unity MonoBehaviours: public fields become inspector params, and awake / start / update / onCollisionEnter / onInteract / onDraw… run at the right time. Organize them in folders (enemies/, player/, ui/, managers/).'),
        h('pre', { class: 'script-ref sample' }, `// scripts/enemies/Patrol.js\nexport default class Patrol extends Behaviour {\n  speed = 40\n  update(dt) {\n    this.self.x += this.speed * dt\n  }\n  onCollisionEnter(other) {\n    other.getComponent('Health')?.damage(1)\n  }\n}`),
        h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => void newComponent() }, icon('plus', 14), 'New component'), h('button', { onclick: () => void newScript() }, icon('plus', 14), 'New plain script')),
        h('p', { class: 'muted small' }, 'Tip: Ctrl+Space shows completions; the project folder also gets a scripts/spritifer.d.ts so VS Code and JetBrains autocomplete too.'),
      ));
      return;
    }
    let code: string;
    try {
      code = (await gameApi.getScript(selected)).code;
    } catch (err) {
      toast((err as Error).message, 'error');
      return;
    }
    const name = selected;
    const panel = h('div', { class: 'comp-panel' });
    const reference = h('pre', { class: 'script-ref' }, 'Loading…');
    void gameApi.scriptReference().then((r) => (reference.textContent = r.reference)).catch(() => {});
    const ed = createCodeEditor({
      value: code,
      highlight,
      check: (c) => {
        const e = syntaxError(c);
        return e ? `Syntax: ${e}` : null;
      },
      save: async (c) => {
        try {
          await gameApi.saveScript(name, c);
          await refreshInfo();
          void renderTree();
          panelFor(name, panel, reference);
        } catch (err) {
          toast((err as Error).message, 'error');
          throw err;
        }
      },
      complete: (c, pos, explicit) => complete(c, pos, completionContext(name, files), explicit),
      signature: (c, pos) => signatureAt(c, pos, completionContext(name, files)),
    });
    editor = { name, flush: () => ed.flush().catch(() => {}), refreshPanel: () => panelFor(name, panel, reference) };
    panelFor(name, panel, reference);
    const comp = componentOf(name);
    main.append(
      h('header', { class: 'obj-head script-head' },
        h('h2', {}, h('span', { class: 'muted' }, scriptDir(name) ? `${scriptDir(name)}/` : ''), `${scriptBaseName(name)}.js`),
        comp ? h('span', { class: 'badge' }, 'component') : h('span', { class: 'badge muted-badge' }, 'module'),
        ed.status,
        h('span', { class: 'spacer' }),
        h('button', { class: 'small', onclick: () => void renamePath(name, false) }, icon('pencil', 13), 'Rename / move'),
        h('button', { class: 'small danger', onclick: async () => {
          if (!(await confirmDialog('Delete script', `Delete scripts/${name}.js?`))) return;
          try { await gameApi.deleteScript(name); await refreshInfo(); go(null); } catch (err) { toast((err as Error).message, 'error'); }
        } }, icon('trash', 13), 'Delete'),
        h('button', { class: 'primary small', onclick: async () => { await ed.flush().catch(() => {}); void openPlay(); } }, icon('play', 13), 'Play'),
      ),
      ed.errorBox,
      h('div', { class: 'script-body' }, ed.el, panel),
    );
    ed.textarea.focus();
    if (line) requestAnimationFrame(() => ed.gotoLine(line));
  };

  const refresh = () => {
    void renderTree().then(() => editor?.refreshPanel());
  };
  void renderTree().then(() => renderEditor());
  return {
    refresh,
    destroy: () => {
      void editor?.flush();
      unregister();
    },
  };
}
