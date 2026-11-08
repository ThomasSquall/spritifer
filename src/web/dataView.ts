/**
 * Data page: the game's database. Tables of typed rows (items, weapons, classes, skills, enemies, quests...)
 * edited like a spreadsheet; scripts read them with db.<table>, expressions and dialogues with db("table", id, "column").
 */

import { DATA_COLUMN_TYPES, type DataColumn, type DataColumnType, type DataRow, type DataTable, type DataValue, normalizeTable } from '../core/game/types.js';
import { gameApi } from './gameApi.js';
import { state } from './gameState.js';
import { appNav } from './nav.js';
import { registerFlusher } from './play.js';
import { clear, confirmDialog, h, icon, modal, promptText, toast } from './dom.js';

const TYPE_HELP: Record<DataColumnType, string> = {
  text: 'Text',
  number: 'Number',
  bool: 'Yes / no',
  list: 'List of texts (comma separated)',
  ref: 'Id of a row in another table',
};

const TEMPLATES: { name: string; label: string; columns: DataColumn[] }[] = [
  { name: 'items', label: 'Items (shop stock)', columns: [{ name: 'name', type: 'text' }, { name: 'price', type: 'number' }, { name: 'heal', type: 'number' }, { name: 'tier', type: 'number', help: 'Shop level that sells it' }, { name: 'desc', type: 'text' }] },
  { name: 'weapons', label: 'Weapons', columns: [{ name: 'name', type: 'text' }, { name: 'atk', type: 'number' }, { name: 'price', type: 'number' }, { name: 'tier', type: 'number' }, { name: 'desc', type: 'text' }] },
  { name: 'enemies', label: 'Enemies', columns: [{ name: 'name', type: 'text' }, { name: 'hp', type: 'number' }, { name: 'atk', type: 'number' }, { name: 'def', type: 'number' }, { name: 'xp', type: 'number' }, { name: 'gold', type: 'number' }, { name: 'sprite', type: 'text' }] },
  { name: 'quests', label: 'Quests', columns: [{ name: 'title', type: 'text' }, { name: 'giver', type: 'text' }, { name: 'goal', type: 'text' }, { name: 'reward', type: 'text' }] },
];

export function renderData(root: HTMLElement, selected: string | null, go: (name: string | null) => void): { refresh: () => void; destroy: () => void } {
  clear(root);
  const list = h('div', { class: 'obj-list' });
  const main = h('section', { class: 'script-main data-main' });
  root.append(h('div', { class: 'page script-page' }, appNav('data'), h('div', { class: 'obj-layout script-layout' }, h('aside', { class: 'obj-side' }, list), main)));

  let table: DataTable | null = null;
  let dirty = false;
  let saveTimer = 0;
  let filter = '';
  const status = h('span', { class: 'save-label muted small' }, '');

  const save = async () => {
    clearTimeout(saveTimer);
    if (!dirty || !table) return;
    dirty = false;
    status.textContent = 'Saving…';
    try {
      const r = await gameApi.saveTable(table);
      table.rev = r.rev;
      status.textContent = 'Saved';
      state.tables = await gameApi.listTables();
      void renderList();
    } catch (err) {
      dirty = true;
      status.textContent = 'Not saved';
      toast(`Could not save the table: ${(err as Error).message}`, 'error');
    }
  };
  const changed = () => {
    dirty = true;
    status.textContent = 'Unsaved';
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void save(), 500);
  };
  const unregister = registerFlusher(save);

  const renderList = async () => {
    let tables = state.tables;
    try {
      tables = state.tables = await gameApi.listTables();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    clear(list);
    list.append(h('div', { class: 'side-title' }, `Tables (${tables.length})`));
    for (const t of tables) {
      list.append(h('a', { class: `obj-item script-item${t.name === selected ? ' active' : ''}`, href: `#/data/${encodeURIComponent(t.name)}`, title: t.description ?? '' },
        h('span', {}, t.name), h('span', { class: 'muted small' }, ` ${t.rows}`)));
    }
    list.append(h('button', { class: 'tpl-btn', onclick: () => void newTable(tables.map((t) => t.name)) }, icon('plus', 13), h('span', {}, 'New table'), h('span', { class: 'muted small' }, 'Items, weapons, classes, enemies…')));
  };

  const newTable = async (existing: string[]) => {
    let picked: { name: string; columns?: DataColumn[] } | null = null;
    await modal('New data table', (close) => {
      const name = h('input', { type: 'text', placeholder: 'e.g. weapons', spellcheck: false });
      const start = (columns?: DataColumn[], n?: string) => {
        const v = (n ?? name.value).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v)) return toast('Use letters, digits and "_" for the name', 'error');
        if (existing.includes(v)) return toast(`Table "${v}" already exists`, 'error');
        picked = { name: v, columns };
        close();
      };
      return h('div', { class: 'form' },
        h('label', {}, 'Name (scripts use db.<name>)', name),
        h('div', { class: 'actions' }, h('button', { onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: () => start() }, 'Create empty')),
        h('p', { class: 'muted small' }, 'Or start from a template:'),
        h('div', { class: 'tpl-grid' }, ...TEMPLATES.map((t) => h('button', { class: 'small', onclick: () => start(t.columns, name.value.trim() || t.name) }, t.label))),
      );
    });
    const p = picked as { name: string; columns?: DataColumn[] } | null;
    if (!p) return;
    try {
      await gameApi.createTable(p.name, p.columns);
      go(p.name);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const grid = h('div', { class: 'data-grid-wrap' });

  /** One cell editor, typed by column. */
  const cellInput = (col: DataColumn, row: DataRow): HTMLElement => {
    const v = row[col.name];
    const set = (val: DataValue | undefined) => {
      if (val === undefined || val === '') delete row[col.name];
      else row[col.name] = val;
      changed();
    };
    if (col.type === 'bool') {
      return h('input', { type: 'checkbox', checked: v === true, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) });
    }
    if (col.type === 'number') {
      return h('input', { type: 'number', class: 'data-cell num', value: v === undefined ? '' : String(v), step: 'any', oninput: (e: Event) => {
        const s = (e.target as HTMLInputElement).value;
        set(s === '' ? undefined : Number(s));
      } });
    }
    if (col.type === 'ref' && col.table) {
      const sel = h('select', { class: 'data-cell', onchange: (e: Event) => set((e.target as HTMLSelectElement).value || undefined) }, h('option', { value: '' }, '—'));
      void gameApi.getTable(col.table).then((t) => {
        for (const r of t.rows) sel.append(h('option', { value: r.id, selected: r.id === v }, r.id + (typeof r.name === 'string' ? ` · ${r.name}` : '')));
        if (typeof v === 'string' && v && !t.rows.some((r) => r.id === v)) sel.append(h('option', { value: v, selected: true }, `${v} (missing)`));
      }).catch(() => sel.append(h('option', { value: String(v ?? ''), selected: true }, String(v ?? ''))));
      return sel;
    }
    const text = Array.isArray(v) ? v.join(', ') : v === undefined ? '' : String(v);
    const long = col.name === 'desc' || col.name === 'description' || text.length > 28;
    return h('input', { type: 'text', class: `data-cell${long ? ' long' : ''}`, value: text, spellcheck: false, placeholder: col.type === 'list' ? 'a, b, c' : '', oninput: (e: Event) => {
      const s = (e.target as HTMLInputElement).value;
      set(col.type === 'list' ? s.split(',').map((x) => x.trim()).filter(Boolean) : s);
    } });
  };

  const editColumn = async (col: DataColumn | null) => {
    if (!table) return;
    const t = table;
    await modal(col ? `Column "${col.name}"` : 'New column', (close) => {
      const name = h('input', { type: 'text', value: col?.name ?? '', spellcheck: false, disabled: col?.name === 'id' });
      const type = h('select', {}, ...DATA_COLUMN_TYPES.map((x) => h('option', { value: x, selected: (col?.type ?? 'text') === x }, `${x} — ${TYPE_HELP[x]}`)));
      const ref = h('select', {}, h('option', { value: '' }, '—'), ...state.tables.map((x) => h('option', { value: x.name, selected: col?.table === x.name }, x.name)));
      const help = h('input', { type: 'text', value: col?.help ?? '', placeholder: 'What this column means (tooltip, autocompletion)' });
      const refLabel = h('label', {}, 'Table (for ref columns)', ref);
      const sync = () => (refLabel.style.display = type.value === 'ref' ? '' : 'none');
      type.addEventListener('change', sync);
      sync();
      const apply = () => {
        const n = name.value.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(n)) return toast('Use letters, digits and "_" for the column name', 'error');
        if ((!col || col.name !== n) && t.columns.some((c) => c.name === n)) return toast(`Column "${n}" already exists`, 'error');
        const next: DataColumn = { name: n, type: (col?.name === 'id' ? 'text' : type.value) as DataColumnType, ...(type.value === 'ref' && ref.value ? { table: ref.value } : {}), ...(help.value.trim() ? { help: help.value.trim() } : {}) };
        if (col) {
          if (col.name !== n) for (const r of t.rows) if (col.name in r) {
            r[n] = r[col.name];
            delete r[col.name];
          }
          t.columns = t.columns.map((c) => (c === col ? next : c));
        } else t.columns.push(next);
        // Re-type the values (e.g. text → number).
        Object.assign(t, normalizeTable(t, t.name), { rev: t.rev });
        changed();
        close();
        renderGrid();
      };
      return h('div', { class: 'form' },
        h('label', {}, 'Name', name),
        col?.name === 'id' ? h('p', { class: 'muted small' }, 'Every row has a unique text id: scripts find rows by it.') : h('label', {}, 'Type', type),
        refLabel,
        h('label', {}, 'Help', help),
        h('div', { class: 'actions' },
          col && col.name !== 'id' ? h('button', { class: 'danger', onclick: async () => {
            close();
            if (!(await confirmDialog('Delete column', `Delete column "${col.name}" and its values in every row?`))) return;
            t.columns = t.columns.filter((c) => c !== col);
            for (const r of t.rows) delete r[col.name];
            changed();
            renderGrid();
          } }, 'Delete column') : null,
          h('span', { class: 'spacer' }),
          h('button', { onclick: close }, 'Cancel'),
          h('button', { class: 'primary', onclick: apply }, col ? 'Apply' : 'Add column'),
        ),
      );
    });
  };

  const uniqueId = (base: string) => {
    const ids = new Set(table?.rows.map((r) => r.id));
    let i = 1;
    let id = base;
    while (ids.has(id)) id = `${base}${++i}`;
    return id;
  };

  const renderGrid = () => {
    clear(grid);
    if (!table) return;
    const t = table;
    const head = h('tr', {},
      h('th', { class: 'data-rownum' }, '#'),
      ...t.columns.map((c) => h('th', { title: `${c.type}${c.table ? ' → ' + c.table : ''}${c.help ? '\n' + c.help : ''}` },
        h('button', { class: 'ghost small data-colhead', onclick: () => void editColumn(c) }, c.name, h('span', { class: 'muted small' }, ` ${c.type === 'ref' ? '→' + (c.table ?? '?') : c.type}`)))),
      h('th', {}, h('button', { class: 'icon-btn tiny', title: 'Add a column', onclick: () => void editColumn(null) }, icon('plus', 12))),
    );
    const q = filter.toLowerCase();
    const rows = t.rows.map((r, i) => ({ r, i })).filter(({ r }) => !q || JSON.stringify(r).toLowerCase().includes(q));
    const body = rows.map(({ r, i }) =>
      h('tr', {},
        h('td', { class: 'data-rownum muted small' }, String(i + 1)),
        ...t.columns.map((c) => {
          if (c.name !== 'id') return h('td', {}, cellInput(c, r));
          const idIn = h('input', { type: 'text', class: 'data-cell id', value: r.id, spellcheck: false, onchange: (e: Event) => {
            const el = e.target as HTMLInputElement;
            const v = el.value.trim();
            if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(v) || t.rows.some((x) => x !== r && x.id === v)) {
              toast(v ? `Id "${v}" is not valid or already used` : 'The id cannot be empty', 'error');
              el.value = r.id;
              return;
            }
            r.id = v;
            changed();
          } });
          return h('td', {}, idIn);
        }),
        h('td', { class: 'data-actions' },
          h('button', { class: 'icon-btn tiny', title: 'Move up', disabled: i === 0, onclick: () => { t.rows.splice(i - 1, 0, t.rows.splice(i, 1)[0]); changed(); renderGrid(); } }, icon('up', 11)),
          h('button', { class: 'icon-btn tiny', title: 'Duplicate', onclick: () => { t.rows.splice(i + 1, 0, { ...structuredClone(r), id: uniqueId(r.id) }); changed(); renderGrid(); } }, icon('copy', 11)),
          h('button', { class: 'icon-btn tiny', title: 'Delete row', onclick: () => { t.rows.splice(i, 1); changed(); renderGrid(); } }, icon('trash', 11)),
        ),
      ),
    );
    grid.append(h('table', { class: 'data-grid' }, h('thead', {}, head), h('tbody', {}, ...body)));
    if (!t.rows.length) grid.append(h('p', { class: 'muted small data-empty' }, 'No rows yet: add one with “+ Row”.'));
  };

  const renderEditor = async () => {
    clear(main);
    if (!selected) {
      main.append(h('div', { class: 'empty big' },
        h('h2', {}, 'Data'),
        h('p', { class: 'muted' }, 'The game’s database: items and their prices, weapons by shop level, classes and skills, enemy stats, quest rewards. Edit them here like a spreadsheet instead of changing code.'),
        h('pre', { class: 'dialogue-sample' }, `// scripts\nconst sword = db.get('weapons', 'bronze')\nfor (const w of db.where('weapons', { tier: 2 })) ...\n\n# dialogues, events, Active if\n* Buy ({db("weapons", "bronze", "price")} gold) [if gold >= db("weapons", "bronze", "price")]`),
      ));
      return;
    }
    try {
      table = await gameApi.getTable(selected);
    } catch (err) {
      toast((err as Error).message, 'error');
      return;
    }
    dirty = false;
    const t = table;
    const desc = h('input', { type: 'text', class: 'data-desc', value: t.description ?? '', placeholder: 'What is this table for?', oninput: (e: Event) => {
      t.description = (e.target as HTMLInputElement).value;
      changed();
    } });
    const search = h('input', { type: 'search', placeholder: 'Filter rows…', value: filter, oninput: (e: Event) => {
      filter = (e.target as HTMLInputElement).value;
      renderGrid();
    } });
    main.append(
      h('header', { class: 'obj-head script-head' },
        h('h2', {}, t.name),
        status,
        h('span', { class: 'spacer' }),
        search,
        h('button', { class: 'small primary', onclick: () => {
          t.rows.push({ id: uniqueId(t.name.replace(/s$/, '') || 'row') } as DataRow);
          changed();
          renderGrid();
          grid.querySelector<HTMLInputElement>('tbody tr:last-child input')?.focus();
        } }, icon('plus', 13), 'Row'),
        h('button', { class: 'small', onclick: () => void editColumn(null) }, icon('plus', 13), 'Column'),
        h('button', { class: 'small', onclick: async () => {
          const to = await promptText('Rename table', 'New name (scripts use db.<name>)', t.name);
          if (!to || to === t.name) return;
          await save();
          try { await gameApi.renameTable(t.name, to); go(to); } catch (err) { toast((err as Error).message, 'error'); }
        } }, icon('pencil', 13), 'Rename'),
        h('button', { class: 'small danger', onclick: async () => {
          if (!(await confirmDialog('Delete table', `Delete data/${t.name}.json and its ${t.rows.length} rows?`))) return;
          try { await gameApi.deleteTable(t.name); go(null); } catch (err) { toast((err as Error).message, 'error'); }
        } }, icon('trash', 13), 'Delete'),
      ),
      h('div', { class: 'data-info' }, desc,
        h('code', { class: 'small muted', title: 'How to read this table' }, `db.${t.name} · db.get('${t.name}', id) · db("${t.name}", id, "column")`)),
      grid,
    );
    renderGrid();
  };

  void renderList();
  void renderEditor();
  return {
    refresh: () => {
      void renderList();
      // Reload the open table when someone else (Claude) changed it and we have no pending edits.
      if (selected && !dirty && !main.contains(document.activeElement)) void renderEditor();
    },
    destroy: () => {
      void save();
      unregister();
    },
  };
}
