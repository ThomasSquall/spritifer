/** Projects page: every game you have, create new ones from templates, open existing folders. */

import { currentProjectId } from './api.js';
import { type ProjectInfo, gameApi } from './gameApi.js';
import { appNav } from './nav.js';
import { clear, confirmDialog, h, icon, toast } from './dom.js';

/** Opens a project in this tab (each tab can show a different project). */
export function openProject(id: string, hash = '#/scenes'): void {
  location.href = `/?project=${encodeURIComponent(id)}${hash}`;
}

export function renderProjects(root: HTMLElement): () => void {
  clear(root);
  const grid = h('div', { class: 'gallery-grid projects-grid' });
  const side = h('aside', { class: 'gallery-side' });
  root.append(h('div', { class: 'page' }, appNav(null), h('div', { class: 'gallery' },
    h('div', { class: 'gallery-body' },
      h('section', { class: 'gallery-main' }, h('h2', {}, 'Projects'), grid),
      side,
    ),
  )));

  const thumb = (p: ProjectInfo) => {
    const base = `/api/p/${encodeURIComponent(p.id)}`;
    if (p.firstScene) return h('img', { src: `${base}/scenes/${encodeURIComponent(p.firstScene)}/preview.png?scale=1&t=${p.updatedAt}`, alt: '' });
    if (p.firstSprite) return h('img', { class: 'pixel', src: `${base}/sprites/${encodeURIComponent(p.firstSprite.name)}/preview.png?scale=4&r=${p.firstSprite.rev}`, alt: '' });
    return h('span', { class: 'muted' }, 'Empty project');
  };

  const refresh = async () => {
    let data: Awaited<ReturnType<typeof gameApi.projects>>;
    try {
      data = await gameApi.projects();
    } catch (err) {
      toast((err as Error).message, 'error');
      return;
    }
    const current = currentProjectId() ?? data.defaultId;
    clear(grid);
    for (const p of data.projects.sort((a, b) => b.updatedAt - a.updatedAt)) {
      const isCurrent = p.id === current;
      grid.append(h('article', { class: `sprite-card project-card${isCurrent ? ' current' : ''}`, onclick: () => openProject(p.id) },
        h('div', { class: 'thumb' }, thumb(p)),
        h('div', { class: 'meta' },
          h('strong', {}, p.name, isCurrent ? h('span', { class: 'badge' }, 'open') : null, p.isDefault ? h('span', { class: 'badge muted-badge', title: 'Opened by the server at start (--workspace)' }, 'default') : null),
          h('span', { class: 'muted' }, `${p.sprites} sprite${p.sprites === 1 ? '' : 's'} · ${p.scenes} scene${p.scenes === 1 ? '' : 's'} · ${p.scripts} script${p.scripts === 1 ? '' : 's'}`),
          h('code', { class: 'path', title: p.dir }, p.dir),
        ),
        p.isDefault || p.dir.startsWith(data.root + '/') ? null : h('div', { class: 'card-actions' },
          h('button', { class: 'icon-btn', title: 'Remove from the list (files stay on disk)', onclick: async (e: Event) => {
            e.stopPropagation();
            if (!(await confirmDialog('Remove from list', `Remove "${p.name}" from the projects list? The folder ${p.dir} is not deleted.`, 'Remove'))) return;
            try { await gameApi.forgetProject(p.id); void refresh(); } catch (err) { toast((err as Error).message, 'error'); }
          } }, icon('close', 14)),
        ),
      ));
    }

    clear(side);
    const nameIn = h('input', { type: 'text', placeholder: 'My RPG', required: true });
    let template = 'empty';
    const tplList = h('div', { class: 'tpl-list' });
    const renderTpls = () => {
      clear(tplList);
      for (const t of data.templates) {
        tplList.append(h('button', { type: 'button', class: `tpl-card${t.id === template ? ' on' : ''}`, onclick: () => { template = t.id; renderTpls(); } },
          h('strong', {}, t.label), h('span', { class: 'muted small' }, t.description)));
      }
    };
    renderTpls();
    const pathIn = h('input', { type: 'text', placeholder: '/path/to/game/folder', spellcheck: false });
    side.append(
      h('form', { class: 'form panel-card', onsubmit: async (e: Event) => {
        e.preventDefault();
        try {
          const p = await gameApi.createProject(nameIn.value, template);
          openProject(p.id, template === 'empty' ? '#/' : '#/scenes');
        } catch (err) { toast((err as Error).message, 'error'); }
      } },
        h('h3', {}, 'New project'),
        h('label', {}, 'Name', nameIn),
        h('div', { class: 'muted small' }, 'Start from'),
        tplList,
        h('p', { class: 'muted small' }, 'Created in ', h('code', {}, data.root)),
        h('button', { class: 'primary', type: 'submit' }, 'Create project'),
      ),
      h('form', { class: 'form panel-card', onsubmit: async (e: Event) => {
        e.preventDefault();
        try {
          const p = await gameApi.openProject(pathIn.value.trim());
          openProject(p.id);
        } catch (err) { toast((err as Error).message, 'error'); }
      } },
        h('h3', {}, 'Open a folder'),
        h('p', { class: 'muted small' }, 'Any folder works: an existing Spritifer workspace, or an empty folder to start a game in.'),
        h('label', {}, 'Folder path', pathIn),
        h('button', { type: 'submit' }, 'Open'),
      ),
      h('div', { class: 'panel-card help' },
        h('h3', {}, 'With Claude'),
        h('p', { class: 'muted' }, 'Claude can do the same through MCP: list_projects, open_project and create_project. Each browser tab can show a different project.'),
      ),
    );
  };
  void refresh();
  return () => void refresh();
}
