import { openPixelLab } from './pixelLabPanel.js';
import { openArtImport } from './artImportPanel.js';
import { PALETTES } from '../core/color.js';
import { bytesToBase64 } from '../core/base64.js';
import { SPRITE_CATEGORIES, isSpriteCategory, type SpriteCategory } from '../core/sprite.js';
import { api, type SpriteSummary } from './api.js';
import { clear, confirmDialog, h, icon, modal, promptText, toast } from './dom.js';

const SIZE_PRESETS = [16, 24, 32, 48, 64, 128, 256];
const CATEGORY_LABELS: Record<SpriteCategory, string> = {
  characters: 'Characters', tileset: 'Tileset', backgrounds: 'Backgrounds', props: 'Props',
  items: 'Items', effects: 'Effects', portraits: 'Portraits', ui: 'UI',
};
let activeFilter = 'all';

function categoryOptions() {
  return SPRITE_CATEGORIES.map((category) => h('option', { value: category }, CATEGORY_LABELS[category]));
}

function categorySelect(emptyLabel: string, category?: SpriteCategory | null): HTMLSelectElement {
  const select = h('select', {}, h('option', { value: '' }, emptyLabel), categoryOptions());
  select.value = category ?? '';
  return select;
}

function selectedCategory(select: HTMLSelectElement): SpriteCategory | undefined {
  return isSpriteCategory(select.value) ? select.value : undefined;
}

/** Home screen: the sprites in the workspace, plus "new" and "import" forms. */
export function renderGallery(root: HTMLElement, open: (name: string) => void): () => void {
  clear(root);
  const list = h('div', { class: 'gallery-grid' });
  const wsInfo = h('code', {}, '…');
  const filter = h('select', { 'aria-label': 'Filter sprites by category' },
    h('option', { value: 'all' }, 'All categories'),
    categoryOptions(),
    h('option', { value: 'untagged' }, 'Untagged'),
  );
  filter.value = activeFilter;
  const count = h('span', { class: 'muted small', role: 'status' });
  let sprites: SpriteSummary[] = [];
  let refreshId = 0;

  const showSprites = () => {
    const visible = sprites.filter((sprite) => activeFilter === 'all' || (sprite.category ?? 'untagged') === activeFilter);
    count.textContent = `${visible.length} of ${sprites.length} sprites`;
    clear(list);
    if (!visible.length) {
      const message = sprites.length ? 'No sprites in this category.' : 'No sprites yet.';
      list.append(h('div', { class: 'empty' }, h('p', {}, message)));
    }
    for (const s of visible) list.append(card(s));
  };

  filter.addEventListener('change', () => {
    activeFilter = filter.value;
    showSprites();
  });

  const refresh = async () => {
    const id = ++refreshId;
    try {
      const loaded = await api.list();
      if (id !== refreshId) return;
      sprites = loaded;
      showSprites();
    } catch (err) {
      toast(String(err), 'error');
    }
  };

  const editCategory = (sprite: SpriteSummary) => modal(`Category for ${sprite.name}`, (close) => {
    const select = categorySelect('Untagged', sprite.category);
    const save = h('button', { class: 'primary', type: 'submit' }, 'Save');
    return h('form', { class: 'form', onsubmit: async (event: Event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        await api.setCategory(sprite.name, selectedCategory(select) ?? null);
        close();
        await refresh();
      } catch (err) {
        toast(String(err), 'error');
      } finally {
        save.disabled = false;
      }
    } },
      h('label', {}, 'Category', select),
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: close }, 'Cancel'), save),
    );
  });

  const card = (s: SpriteSummary) => {
    const scale = Math.max(1, Math.min(8, Math.floor(160 / Math.max(s.width, s.height))));
    return h('article', { class: 'sprite-card', onclick: () => open(s.name) },
      h('div', { class: 'thumb checker' }, h('img', { src: api.previewUrl(s.name, s.rev, scale), alt: s.name, draggable: false })),
      h('div', { class: 'meta' },
        h('strong', {}, s.name),
        h('span', { class: 'muted' }, `${s.width}×${s.height} · ${s.frames} frame${s.frames === 1 ? '' : 's'}`),
        h('button', {
          class: 'chip sprite-category',
          'aria-label': `Change category for ${s.name}`,
          onclick: (event: Event) => { event.stopPropagation(); void editCategory(s); },
        }, icon('tag', 14), s.category ? CATEGORY_LABELS[s.category] : 'Add category'),
      ),
      h('div', { class: 'card-actions' },
        h('button', { class: 'icon-btn', title: 'Duplicate', onclick: async (e: Event) => {
          e.stopPropagation();
          const to = await promptText('Duplicate sprite', 'New name', `${s.name}_copy`);
          if (!to) return;
          try { await api.duplicate(s.name, to); refresh(); } catch (err) { toast(String(err), 'error'); }
        } }, icon('copy')),
        h('button', { class: 'icon-btn', title: 'Delete', onclick: async (e: Event) => {
          e.stopPropagation();
          if (!(await confirmDialog('Delete sprite', `Delete "${s.name}" permanently?`))) return;
          try { await api.remove(s.name); refresh(); } catch (err) { toast(String(err), 'error'); }
        } }, icon('trash')),
      ),
    );
  };

  // New sprite form.
  const nameIn = h('input', { type: 'text', value: '', placeholder: 'hero', required: true, pattern: '[A-Za-z0-9][A-Za-z0-9_\\-]*', spellcheck: false });
  const wIn = h('input', { type: 'number', value: '32', min: '1', max: '2048' });
  const hIn = h('input', { type: 'number', value: '32', min: '1', max: '2048' });
  const palSel = h('select', {}, ...Object.keys(PALETTES).map((p) => h('option', { value: p, selected: p === 'endesga32' }, `${p} (${PALETTES[p].length})`)));
  const tileIn = h('input', { type: 'number', value: '', min: '1', placeholder: 'none' });
  const categoryIn = categorySelect('Automatic');
  const presets = h('div', { class: 'chips' }, ...SIZE_PRESETS.map((n) => h('button', { type: 'button', class: 'chip', onclick: () => { wIn.value = hIn.value = String(n); } }, `${n}`)));

  const createForm = h('form', {
    class: 'form panel-card',
    onsubmit: async (e: Event) => {
      e.preventDefault();
      const tile = Number(tileIn.value);
      try {
        const r = await api.create({ name: nameIn.value.trim(), width: Number(wIn.value), height: Number(hIn.value), palette: palSel.value, grid: tile > 0 ? { width: tile, height: tile } : null, category: selectedCategory(categoryIn) });
        open(r.name);
      } catch (err) {
        toast(String((err as Error).message), 'error');
      }
    },
  },
    h('h3', {}, 'New sprite'),
    h('label', {}, 'Name', nameIn),
    h('div', { class: 'row2' }, h('label', {}, 'Width', wIn), h('label', {}, 'Height', hIn)),
    presets,
    h('div', { class: 'row2' }, h('label', {}, 'Palette', palSel), h('label', {}, 'Tile grid', tileIn)),
    h('label', {}, 'Category', categoryIn),
    h('button', { class: 'primary', type: 'submit' }, 'Create'),
  );

  // Import form.
  const fileIn = h('input', { type: 'file', accept: 'image/png' });
  const impName = h('input', { type: 'text', placeholder: 'name', spellcheck: false });
  const impCategory = categorySelect('Untagged');
  const fwIn = h('input', { type: 'number', min: '1', placeholder: 'whole image' });
  const fhIn = h('input', { type: 'number', min: '1', placeholder: 'whole image' });
  fileIn.addEventListener('change', () => {
    const f = fileIn.files?.[0];
    if (f && !impName.value) impName.value = f.name.replace(/\.png$/i, '').replace(/[^A-Za-z0-9_-]/g, '_');
  });
  const importForm = h('form', {
    class: 'form panel-card',
    onsubmit: async (e: Event) => {
      e.preventDefault();
      const f = fileIn.files?.[0];
      if (!f) return toast('Choose a PNG file', 'error');
      try {
        const png = bytesToBase64(new Uint8Array(await f.arrayBuffer()));
        const r = await api.importPng({ name: impName.value.trim(), png, frameWidth: Number(fwIn.value) || undefined, frameHeight: Number(fhIn.value) || undefined, category: selectedCategory(impCategory) });
        open(r.name);
      } catch (err) {
        toast(String((err as Error).message), 'error');
      }
    },
  },
    h('h3', {}, 'Import PNG / spritesheet'),
    h('label', {}, 'File', fileIn),
    h('label', {}, 'Name', impName),
    h('label', {}, 'Category', impCategory),
    h('div', { class: 'row2' }, h('label', {}, 'Frame width', fwIn), h('label', {}, 'Frame height', fhIn)),
    h('button', { type: 'submit' }, 'Import'),
    h('button', { type: 'button', class: 'ghost', onclick: () => openPixelLab(open) }, 'AI Generator…'),
    h('button', { type: 'button', class: 'ghost', title: 'Sheets made by ChatGPT and other image generators: cut them, clean them and turn them into real pixel art', onclick: () => openArtImport(open) }, 'Import AI art…'),
  );

  const mcpSnippet = h('pre', { class: 'snippet' });
  api.workspace().then((w) => {
    wsInfo.textContent = w.dir;
    mcpSnippet.textContent = `claude mcp add spritifer -- node <spritifer>/dist/server/cli.js mcp --workspace ${w.dir}`;
  }).catch(() => {});

  root.append(
    h('div', { class: 'gallery' },
      h('header', { class: 'gallery-head' },
        h('div', { class: 'brand' }, h('span', { class: 'logo' }), h('h1', {}, 'Spritifer')),
        h('p', { class: 'muted' }, 'Make 2D games: draw sprites and tilesets, build scenes, add events, play and export for the web — by yourself or with Claude.'),
      ),
      h('div', { class: 'gallery-body' },
        h('section', { class: 'gallery-main' },
          h('h2', {}, 'Sprites'),
          h('div', { class: 'gallery-filter' }, filter, count),
          list,
        ),
        h('aside', { class: 'gallery-side' },
          createForm,
          importForm,
          h('div', { class: 'panel-card help' },
            h('h3', {}, 'Let Claude draw'),
            h('p', { class: 'muted' }, 'Register the MCP server in your game project, then ask Claude Code e.g. “draw a 32×32 knight with an idle and walk animation”. Changes appear here live.'),
            mcpSnippet,
            h('p', { class: 'muted small' }, 'Workspace: ', wsInfo),
          ),
        ),
      ),
    ),
  );
  refresh();
  return refresh;
}
