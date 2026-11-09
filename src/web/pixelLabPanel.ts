import {
  PIXELLAB_ACTIONS, PIXELLAB_DETAILS, PIXELLAB_DIRECTIONS, PIXELLAB_IMAGE_MODELS, PIXELLAB_OUTLINES, PIXELLAB_SHADINGS,
  PIXELLAB_TILE_SIZES, PIXELLAB_TILESET_HEIGHTS, PIXELLAB_TILESET_MODES, PIXELLAB_TILESET_VIEWS, PIXELLAB_VIEWS,
  type PixelLabAction, type PixelLabCharacter,
} from '../core/pixellab.js';
import { bytesToBase64 } from '../core/base64.js';
import { compositeFrame, deserializeSprite, type SpriteFile } from '../core/sprite.js';
import { api, apiBase } from './api.js';
import { clear, h, modal } from './dom.js';

const actions = Object.keys(PIXELLAB_ACTIONS) as PixelLabAction[];

export function openPixelLab(openSprite: (name: string) => void): void {
  const base = apiBase();
  let closed = false;
  let playback: number | undefined;

  void modal('AI Generator · PixelLab', (close) => {
    const status = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' }, 'Checking server configuration…');
    const id = h('input', { placeholder: 'Existing PixelLab character ID', spellcheck: false });
    const name = h('input', { placeholder: 'aren', spellcheck: false, maxLength: 64 });
    const description = h('textarea', { rows: 3, maxLength: 2000, placeholder: 'Describe the character or give context for the uploaded art.' });
    const size = h('input', { type: 'number', min: 32, max: 168, value: '64' });
    const view = h('select', {}, h('option', { value: 'low top-down' }, 'Low top-down'), h('option', { value: 'high top-down' }, 'High top-down'));
    const reference = h('input', { type: 'file', accept: 'image/png,.png' });
    const mode = h('select', {}, h('option', { value: 'concept' }, 'Concept art / reference sheet'), h('option', { value: 'sprite' }, 'South-facing transparent sprite'));
    const action = h('select', {}, actions.map((key) => h('option', { value: key }, key)));
    const motion = h('input', { placeholder: 'Optional motion description', maxLength: 500 });
    const selection = h('div', { class: 'form' });
    const preview = h('div', { class: 'form' });
    const create = h('button', { type: 'button' }, 'Generate character');
    const load = h('button', { type: 'button', class: 'ghost' }, 'Load / refresh');
    const animate = h('button', { type: 'button' }, 'Generate action');
    const review = h('button', { type: 'button', class: 'ghost' }, 'Preview selected clips');
    const save = h('button', { type: 'button', class: 'primary' }, 'Import into Spritifer');
    const createFields = h('fieldset', { class: 'form', disabled: true },
      h('legend', {}, 'Create a character'),
      h('label', {}, 'Sprite name', name),
      h('label', {}, 'Description', description),
      h('div', { class: 'row2' }, h('label', {}, 'Size (px)', size), h('label', {}, 'View', view)),
      h('label', {}, 'Optional PNG reference', reference),
      h('label', {}, 'Reference type', mode),
      h('p', { class: 'muted small' }, 'Generation uses PixelLab credits. Each action generates a separate clip per facing.'),
      create,
    );
    const existing = h('fieldset', { class: 'form', disabled: true },
      h('legend', {}, 'Reuse a PixelLab character'),
      h('label', {}, 'Character ID', id), load,
    );
    const edit = h('fieldset', { class: 'form', style: 'display: none' },
      h('legend', {}, 'Animations and import'),
      h('div', { class: 'row2' }, h('label', {}, 'Action', action), h('label', {}, 'Motion', motion)),
      animate, selection, review,
    );
    const choice = (empty: string, options: readonly string[]) => h('select', {},
      h('option', { value: '' }, empty), options.map((value) => h('option', { value }, value)));
    const imageName = h('input', { placeholder: 'crystal_lamp', spellcheck: false, maxLength: 64 });
    const imagePrompt = h('textarea', { rows: 2, maxLength: 2000, placeholder: 'Describe the prop, tile, icon or backdrop.' });
    const imageWidth = h('input', { type: 'number', min: 16, max: 768, value: '64' });
    const imageHeight = h('input', { type: 'number', min: 16, max: 768, value: '64' });
    const imageModel = h('select', {}, PIXELLAB_IMAGE_MODELS.map((value) => h('option', { value }, value)));
    const imageTransparent = h('input', { type: 'checkbox', checked: true });
    const imageView = choice('Auto', PIXELLAB_VIEWS);
    const imageDirection = choice('Auto', PIXELLAB_DIRECTIONS);
    const imageOutline = choice('Auto', PIXELLAB_OUTLINES);
    const imageShading = choice('Auto', PIXELLAB_SHADINGS);
    const imageDetail = choice('Auto', PIXELLAB_DETAILS);
    const imageSeed = h('input', { type: 'number', min: 0, placeholder: 'Random' });
    const styleSprite = choice('None', []);
    const styleStrength = h('input', { type: 'number', min: 0, max: 100, value: '50' });
    const paletteSprite = choice('None', []);
    const generate = h('button', { type: 'button' }, 'Generate image');
    const imageFields = h('fieldset', { class: 'form', disabled: true },
      h('legend', {}, 'Generate an image'),
      h('label', {}, 'Sprite name', imageName),
      h('label', {}, 'Description', imagePrompt),
      h('div', { class: 'row2' }, h('label', {}, 'Width (px)', imageWidth), h('label', {}, 'Height (px)', imageHeight)),
      h('div', { class: 'row2' }, h('label', {}, 'Model', imageModel), h('label', {}, 'View', imageView)),
      h('div', { class: 'row2' }, h('label', {}, 'Direction', imageDirection), h('label', {}, 'Outline', imageOutline)),
      h('div', { class: 'row2' }, h('label', {}, 'Shading', imageShading), h('label', {}, 'Detail', imageDetail)),
      h('div', { class: 'row2' }, h('label', {}, 'Style sprite (bitforge)', styleSprite), h('label', {}, 'Style strength', styleStrength)),
      h('div', { class: 'row2' }, h('label', {}, 'Palette sprite', paletteSprite), h('label', {}, 'Seed', imageSeed)),
      h('label', { style: 'flex-direction: row; align-items: center; gap: 6px' }, imageTransparent, 'Transparent background'),
      h('p', { class: 'muted small' }, 'Generation uses PixelLab credits. The result is saved as a new sprite and opened.'),
      generate,
    );
    const tilesetName = h('input', { placeholder: 'grass_cobble', spellcheck: false, maxLength: 64 });
    const tilesetLower = h('textarea', { rows: 2, maxLength: 2000, placeholder: 'Base terrain, e.g. soft green meadow grass' });
    const tilesetUpper = h('textarea', { rows: 2, maxLength: 2000, placeholder: 'Terrain laid over it, e.g. worn cobblestone street' });
    const tilesetSize = h('select', {}, PIXELLAB_TILE_SIZES.map((value) => h('option', { value: String(value) }, `${value} px`)));
    tilesetSize.value = '32';
    const tilesetMode = h('select', {}, PIXELLAB_TILESET_MODES.map((value) => h('option', { value }, value)));
    const tilesetView = choice('Default', PIXELLAB_TILESET_VIEWS);
    const tilesetHeight = h('select', {}, PIXELLAB_TILESET_HEIGHTS.map((value) => h('option', { value: String(value) }, value ? `Raised ${value}` : 'Flat')));
    const tilesetRagged = h('input', { type: 'number', min: 0, max: 1, step: 0.1, placeholder: 'Default' });
    const tilesetAmplitude = h('input', { type: 'number', min: 0, max: 0.3, step: 0.05, placeholder: 'Default' });
    const tilesetShading = choice('Auto', PIXELLAB_SHADINGS);
    const tilesetDetail = choice('Auto', PIXELLAB_DETAILS);
    const tilesetPalette = choice('None', []);
    const tilesetSeed = h('input', { type: 'number', min: 0, placeholder: 'Random' });
    const tilesetReference = choice('None', []);
    const tilesetLowerTile = h('input', { type: 'number', min: 0, placeholder: 'No lower reference' });
    const tilesetUpperTile = h('input', { type: 'number', min: 0, placeholder: 'No upper reference' });
    const tilesetId = h('input', { placeholder: 'Existing PixelLab tileset ID', spellcheck: false });
    const generateTileset = h('button', { type: 'button' }, 'Generate tileset');
    const importTileset = h('button', { type: 'button', class: 'ghost' }, 'Import by ID');
    const tilesetFields = h('fieldset', { class: 'form', disabled: true },
      h('legend', {}, 'Generate a tileset'),
      h('label', {}, 'Sprite name', tilesetName),
      h('label', {}, 'Lower terrain', tilesetLower),
      h('label', {}, 'Upper terrain', tilesetUpper),
      h('div', { class: 'row2' }, h('label', {}, 'Tile size', tilesetSize), h('label', {}, 'Mode', tilesetMode)),
      h('div', { class: 'row2' }, h('label', {}, 'View (pro)', tilesetView), h('label', {}, 'Height', tilesetHeight)),
      h('div', { class: 'row2' }, h('label', {}, 'Raggedness (pro)', tilesetRagged), h('label', {}, 'Border wander', tilesetAmplitude)),
      h('div', { class: 'row2' }, h('label', {}, 'Shading', tilesetShading), h('label', {}, 'Detail', tilesetDetail)),
      h('div', { class: 'row2' }, h('label', {}, 'Palette sprite (pro)', tilesetPalette), h('label', {}, 'Seed', tilesetSeed)),
      h('label', {}, 'Terrain reference tileset (pro)', tilesetReference),
      h('div', { class: 'row2' }, h('label', {}, 'Lower terrain tile', tilesetLowerTile), h('label', {}, 'Upper terrain tile', tilesetUpperTile)),
      h('p', { class: 'muted small' }, 'Pro mode costs about 15 generations. The 16 tiles are saved as a new 4×4 sprite.'),
      generateTileset,
      h('label', {}, 'Tileset ID', tilesetId),
      importTileset,
    );
    let configured = false;
    let busy = false;
    let current: PixelLabCharacter | undefined;
    let previewFile: SpriteFile | undefined;
    const groups = new Map<PixelLabAction, HTMLSelectElement>();
    const storageKey = `spritifer:pixellab:${base}`;

    const remember = (characterId: string) => {
      id.value = characterId;
      try { localStorage.setItem(storageKey, characterId); } catch { /* Browser storage can be unavailable. */ }
    };
    const sync = () => {
      createFields.disabled = existing.disabled = imageFields.disabled = tilesetFields.disabled = !configured || busy;
      edit.style.display = current?.status === 'completed' ? '' : 'none';
      edit.disabled = busy;
      save.disabled = busy || !previewFile;
    };
    const resetPreview = () => {
      clearTimeout(playback);
      previewFile = undefined;
      clear(preview);
    };
    const run = async (work: () => Promise<void>) => {
      busy = true;
      sync();
      try { await work(); }
      catch (err) { status.textContent = err instanceof Error ? err.message : String(err); }
      finally { busy = false; sync(); }
    };
    const wait = async (jobs: string[]): Promise<number> => {
      const pending = new Set(jobs);
      let failed = 0;
      for (let attempt = 0; attempt < 90 && pending.size && !closed; attempt++) {
        status.textContent = `PixelLab processing · ${pending.size} pending${failed ? ` · ${failed} failed` : ''}`;
        await new Promise((resolve) => setTimeout(resolve, 5000));
        if (closed) break;
        await Promise.all([...pending].map(async (jobId) => {
          const { status: state } = await api.pixelLab.job(base, jobId);
          if (state === 'completed' || state === 'failed' || state === 'cancelled') {
            pending.delete(jobId);
            if (state !== 'completed') failed++;
          }
        }));
      }
      if (!closed && pending.size) throw new Error('Jobs are still running. Load / refresh later to retrieve them.');
      return failed;
    };
    const refresh = async (characterId: string) => {
      const prior = current?.id === characterId ? new Map([...groups].map(([key, select]) => [key, select.value])) : new Map();
      current = undefined;
      resetPreview();
      sync();
      status.textContent = 'Loading PixelLab character…';
      const info = await api.pixelLab.character(base, characterId);
      remember(info.id);
      current = info;
      if (!name.value) name.value = info.name;
      clear(selection);
      groups.clear();
      const completed = info.animations.filter((group) => group.complete);
      if (info.status === 'completed') {
        for (const key of actions) {
          const matching = completed.filter((group) => group.name.toLowerCase() === key);
          const select = h('select', {},
            h('option', { value: '' }, key === 'idle' ? 'Use still rotations' : 'Skip'),
            completed.map((group) => h('option', { value: group.id }, `${group.name} · ${group.id.slice(0, 8)}`)),
          );
          const previous = prior.get(key);
          select.value = previous && completed.some((group) => group.id === previous) ? previous : matching.at(-1)?.id ?? '';
          select.addEventListener('change', resetPreview);
          groups.set(key, select);
          selection.append(h('label', {}, key, select));
        }
      }
      const unfinished = info.animations.filter((group) => !group.complete).length;
      status.textContent = `${info.name} · ${info.directions} directions · ${info.status}${unfinished ? ` · ${unfinished} incomplete animation groups` : ''}`;
      sync();
    };

    generate.addEventListener('click', () => void run(async () => {
      status.textContent = 'Generating image with PixelLab…';
      const result = await api.pixelLab.image(base, {
        name: imageName.value.trim(), description: imagePrompt.value.trim(),
        width: imageWidth.valueAsNumber, height: imageHeight.valueAsNumber,
        model: imageModel.value, transparent: imageTransparent.checked,
        view: imageView.value || undefined, direction: imageDirection.value || undefined,
        outline: imageOutline.value || undefined, shading: imageShading.value || undefined, detail: imageDetail.value || undefined,
        seed: Number.isNaN(imageSeed.valueAsNumber) ? undefined : imageSeed.valueAsNumber,
        style_sprite: styleSprite.value || undefined,
        style_strength: styleSprite.value ? styleStrength.valueAsNumber : undefined,
        palette_sprite: paletteSprite.value || undefined,
      });
      if (!closed) {
        close();
        openSprite(result.name);
      }
    }));
    const optionalNumber = (input: HTMLInputElement) => Number.isNaN(input.valueAsNumber) ? undefined : input.valueAsNumber;
    const saveTileset = async (tileset: string, sprite: string) => {
      status.textContent = 'Importing tileset…';
      const result = await api.pixelLab.importTileset(base, { id: tileset, name: sprite });
      if (!closed) {
        close();
        openSprite(result.name);
      }
    };
    generateTileset.addEventListener('click', () => void run(async () => {
      status.textContent = 'Submitting tileset to PixelLab…';
      const terrainReference = (input: HTMLInputElement) => tilesetReference.value && !Number.isNaN(input.valueAsNumber)
        ? { sprite: tilesetReference.value, tile: input.valueAsNumber } : undefined;
      const result = await api.pixelLab.tileset(base, {
        lower_reference: terrainReference(tilesetLowerTile), upper_reference: terrainReference(tilesetUpperTile),
        name: tilesetName.value.trim(), lower_description: tilesetLower.value.trim(), upper_description: tilesetUpper.value.trim(),
        tile_size: Number(tilesetSize.value), mode: tilesetMode.value, view: tilesetView.value || undefined,
        transition_size: Number(tilesetHeight.value), raggedness: optionalNumber(tilesetRagged), boundary_amplitude: optionalNumber(tilesetAmplitude),
        shading: tilesetShading.value || undefined, detail: tilesetDetail.value || undefined,
        palette_sprite: tilesetPalette.value || undefined, seed: optionalNumber(tilesetSeed),
      });
      // Shown before waiting: a paid tileset stays recoverable if this window is closed.
      tilesetId.value = result.tileset_id;
      const failed = await wait([result.background_job_id]);
      if (closed) return;
      if (failed) throw new Error('PixelLab could not generate the tileset.');
      await saveTileset(result.tileset_id, result.name);
    }));
    importTileset.addEventListener('click', () => void run(() => saveTileset(tilesetId.value.trim(), tilesetName.value.trim())));
    create.addEventListener('click', () => void run(async () => {
      resetPreview();
      const file = reference.files?.[0];
      if (file && file.size > 12 * 1024 * 1024) throw new Error('Choose a PNG under 12 MB');
      status.textContent = 'Submitting character to PixelLab…';
      const result = await api.pixelLab.create(base, {
        name: name.value.trim(), description: description.value.trim(), size: size.valueAsNumber, view: view.value,
        reference: file ? { mode: mode.value, png: bytesToBase64(new Uint8Array(await file.arrayBuffer())) } : undefined,
      });
      remember(result.character_id);
      current = undefined;
      sync();
      const failed = await wait([result.background_job_id]);
      if (closed) return;
      await refresh(result.character_id);
      if (failed) status.textContent = 'PixelLab could not generate the character.';
    }));
    load.addEventListener('click', () => void run(() => refresh(id.value.trim())));
    animate.addEventListener('click', () => void run(async () => {
      if (!current) return;
      resetPreview();
      const characterId = current.id;
      status.textContent = 'Submitting animation to PixelLab…';
      const result = await api.pixelLab.animate(base, { id: characterId, action: action.value, description: motion.value.trim() || undefined });
      const failed = await wait(result.background_job_ids);
      if (closed) return;
      await refresh(characterId);
      const select = groups.get(action.value as PixelLabAction);
      if (select && [...select.options].some((option) => option.value === result.animation_group_id)) {
        select.value = result.animation_group_id!;
      }
      if (failed) status.textContent = `${failed} directions failed. Only complete animation groups can be imported.`;
    }));
    name.addEventListener('input', resetPreview);
    review.addEventListener('click', () => void run(async () => {
      if (!current) return;
      resetPreview();
      status.textContent = 'Downloading and validating frames…';
      const file = await api.pixelLab.preview(base, {
        id: current.id,
        name: name.value.trim(),
        animations: [...groups].flatMap(([action, select]) => select.value ? [{ action, groupId: select.value }] : []),
      });
      if (closed) return;
      const sprite = deserializeSprite(file);
      previewFile = file;
      const clip = h('select', { 'aria-label': 'Preview clip' },
        sprite.tags.map((tag, index) => h('option', { value: String(index) }, tag.name)));
      const canvas = h('canvas', { width: sprite.width, height: sprite.height, class: 'checker',
        style: 'width: min(100%, 240px); image-rendering: pixelated; align-self: center' });
      const ctx = canvas.getContext('2d')!;
      const play = () => {
        clearTimeout(playback);
        const { from, to } = sprite.tags[Number(clip.value)];
        let index = from;
        const tick = () => {
          const { data } = compositeFrame(sprite, index);
          ctx.putImageData(new ImageData(new Uint8ClampedArray(data), sprite.width, sprite.height), 0, 0);
          if (from === to) return;
          const duration = sprite.frames[index].duration;
          index = index === to ? from : index + 1;
          playback = window.setTimeout(tick, duration);
        };
        tick();
      };
      clip.addEventListener('change', play);
      preview.append(h('label', {}, 'Preview clip', clip), canvas, save);
      play();
      status.textContent = `${sprite.width} × ${sprite.height} · ${sprite.frames.length} frames · ${sprite.tags.length} clips`;
    }));
    save.addEventListener('click', () => void run(async () => {
      if (!previewFile) return;
      const result = await api.pixelLab.import(base, previewFile);
      if (!closed) {
        close();
        openSprite(result.name);
      }
    }));
    void run(async () => {
      configured = (await api.pixelLab.config(base)).configured;
      if (!configured) {
        status.textContent = 'Set PIXELLAB_API_KEY in the server environment and restart Spritifer.';
        return;
      }
      for (const { name: sprite } of await api.list()) {
        styleSprite.append(h('option', { value: sprite }, sprite));
        paletteSprite.append(h('option', { value: sprite }, sprite));
        tilesetPalette.append(h('option', { value: sprite }, sprite));
        tilesetReference.append(h('option', { value: sprite }, sprite));
      }
      try { id.value = localStorage.getItem(storageKey) ?? ''; } catch { /* Browser storage can be unavailable. */ }
      status.textContent = 'Create a character or load an existing PixelLab ID.';
      void api.pixelLab.balance(base).then((b) => {
        if (!closed) status.textContent = `${status.textContent} · Credits: $${b.credits.usd.toFixed(2)}, ${b.subscription.generations}/${b.subscription.total} generations.`;
      }).catch(() => { /* The credits are only informative. */ });
      if (id.value) await refresh(id.value);
    });

    return h('div', { class: 'form' }, status, imageFields, tilesetFields, existing, createFields, edit, preview);
  }, { wide: true }).then(() => {
    closed = true;
    clearTimeout(playback);
  });
}
