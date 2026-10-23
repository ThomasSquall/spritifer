import './styles.css';
import { deserializeSprite } from '../core/sprite.js';
import { api, connectLive, type ChangeEvent } from './api.js';
import { Editor } from './editor.js';
import { mountEditor } from './editorView.js';
import { renderGallery } from './gallery.js';
import { toast } from './dom.js';

const root = document.getElementById('app')!;

let live = false;
let current: { editor: Editor; view: ReturnType<typeof mountEditor> } | null = null;
let refreshGallery: (() => void) | null = null;

async function route(): Promise<void> {
  const m = /^#\/edit\/(.+)$/.exec(location.hash);
  if (current) {
    await current.editor.flush();
    current.view.destroy();
    current = null;
  }
  refreshGallery = null;
  if (m) {
    const name = decodeURIComponent(m[1]);
    try {
      const editor = new Editor(deserializeSprite(await api.get(name)));
      const view = mountEditor(root, editor, { onBack: () => (location.hash = '#/'), liveStatus: () => live });
      current = { editor, view };
    } catch (err) {
      toast((err as Error).message, 'error');
      location.hash = '#/';
    }
    return;
  }
  document.title = 'Spritifer';
  refreshGallery = renderGallery(root, (name) => (location.hash = `#/edit/${encodeURIComponent(name)}`));
}

let galleryTimer = 0;
async function onRemoteChange(e: ChangeEvent): Promise<void> {
  if (refreshGallery) {
    clearTimeout(galleryTimer);
    galleryTimer = window.setTimeout(() => refreshGallery?.(), 150);
    return;
  }
  if (!current || e.name !== current.editor.sprite.name) return;
  if (e.rev === null) {
    toast(`"${e.name}" was deleted`, 'error');
    location.hash = '#/';
    return;
  }
  if (e.rev === current.editor.lastRev) return;
  try {
    const file = await api.get(e.name);
    if (!current || file.rev === current.editor.lastRev) return;
    current.editor.applyRemote(file);
    current.view.flashRemote(file.updatedBy);
  } catch (err) {
    console.error(err);
  }
}

connectLive(
  (e) => void onRemoteChange(e),
  (on) => {
    live = on;
    current?.view.setLive(on);
  },
);

window.addEventListener('hashchange', () => void route());
void route();
