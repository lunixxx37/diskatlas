import { CATEGORIES, formatBytes, formatCount, formatPercent, type CategoryStat, type ScanTree } from '../../core';
import { h } from '../dom';
import { displayName } from '../format';
import { plural, t } from '../i18n';
import { tooltip, tooltipBody } from '../tooltip';
import type { AnalysisCache } from './analysis-cache';
import { categoryVar } from './colors';

const FIRST_EXTENSIONS = 30;
const MAX_EXTENSIONS = 2000;

const categoryIndex = (id: string) => CATEGORIES.findIndex((c) => c.id === id);

/**
 * "File types": a part-to-whole bar of the categories (with 2px surface gaps) and the
 * same numbers as a table, then every extension. Colour follows the category, never
 * its rank, so the bar and the map always agree.
 */
export class FileTypesPanel {
  readonly el: HTMLElement;
  private folder = -1;

  constructor(
    private readonly tree: ScanTree,
    private readonly cache: AnalysisCache,
  ) {
    this.el = h('div', { class: 'panel panel--types' });
  }

  update(folder: number): void {
    if (folder === this.folder) return;
    this.folder = folder;
    const { tree } = this;
    const categories = this.cache.categories(folder);
    const extensions = this.cache.extensions(folder);
    const total = categories.reduce((s, c) => s + c.size, 0);
    const files = categories.reduce((s, c) => s + c.count, 0);

    if (files === 0) {
      this.el.replaceChildren(h('p', { class: 'panel__empty', text: t.panels.noFiles }));
      return;
    }

    const intro = h(
      'header',
      { class: 'panel__intro' },
      h(
        'div',
        null,
        h('h3', { class: 'panel__title' }, t.types.title, h('span', { class: 'panel__where', text: displayName(tree, folder) })),
        h('p', { class: 'panel__lede', text: t.types.lede(plural(files, t.files), formatBytes(total)) }),
      ),
    );

    this.el.replaceChildren(intro, this.categorySection(categories, total), this.extensionSection(extensions, total));
  }

  private categorySection(stats: CategoryStat[], total: number): HTMLElement {
    const bar = h('div', { class: 'propbar', role: 'presentation' });
    for (const s of stats) {
      if (s.size <= 0) continue;
      const k = categoryIndex(s.id);
      const seg = h('span', { class: 'propbar__seg', style: { 'flex-grow': ((s.size / total) * 1000).toFixed(3), '--cat': categoryVar(k) } });
      seg.addEventListener('pointermove', (event) =>
        tooltip.show(
          `type:${s.id}`,
          () =>
            tooltipBody({
              value: formatBytes(s.size),
              share: formatPercent(total > 0 ? s.size / total : 0),
              title: t.categories[s.id],
              meta: plural(s.count, t.files),
              key: categoryVar(k),
            }),
          event.clientX,
          event.clientY,
        ),
      );
      seg.addEventListener('pointerleave', () => tooltip.hide());
      bar.append(seg);
    }
    const rows = stats.map((s) => {
      const k = categoryIndex(s.id);
      const share = total > 0 ? s.size / total : 0;
      return h(
        'tr',
        null,
        h('th', { scope: 'row', class: 'c-label' }, h('span', { class: 'swatch', style: { '--cat': categoryVar(k) } }), t.categories[s.id]),
        h('td', { class: 'c-num num', text: formatBytes(s.size) }),
        h('td', { class: 'c-num c-count num', text: formatCount(s.count) }),
        h(
          'td',
          { class: 'c-share' },
          h('span', { class: 'share share--cat', style: { '--cat': categoryVar(k) } }, h('span', { class: 'share__fill', style: { width: `${Math.max(1.5, share * 100)}%` } })),
          h('span', { class: 'share__pct num', text: formatPercent(share) }),
        ),
      );
    });
    return h(
      'section',
      { class: 'panel__section', 'aria-labelledby': 'types-cat' },
      h('h4', { class: 'label', id: 'types-cat', text: t.types.categories }),
      bar,
      h(
        'table',
        { class: 'datatable datatable--cats' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'col', class: 'c-label', text: t.types.colCategory }),
            h('th', { scope: 'col', class: 'c-num', text: t.types.colSize }),
            h('th', { scope: 'col', class: 'c-num c-count', text: t.types.colFiles }),
            h('th', { scope: 'col', class: 'c-share', text: t.types.colShare }),
          ),
        ),
        h('tbody', null, ...rows),
      ),
    );
  }

  private extensionSection(stats: ReturnType<AnalysisCache['extensions']>, total: number): HTMLElement {
    const body = h('tbody');
    const renderRows = (limit: number) => {
      body.replaceChildren(
        ...stats.slice(0, limit).map((s) => {
          const k = categoryIndex(s.category);
          const share = total > 0 ? s.size / total : 0;
          return h(
            'tr',
            null,
            h('th', { scope: 'row', class: 'c-ext mono', text: s.ext ? `.${s.ext}` : t.types.noExt }),
            h('td', { class: 'c-cat' }, h('span', { class: 'swatch', style: { '--cat': categoryVar(k) } }), t.categories[CATEGORIES[k].id]),
            h('td', { class: 'c-num c-count num', text: formatCount(s.count) }),
            h('td', { class: 'c-num num', text: formatBytes(s.size) }),
            h('td', { class: 'c-share' }, h('span', { class: 'share' }, h('span', { class: 'share__fill', style: { width: `${Math.max(1.5, share * 100)}%` } })), h('span', { class: 'share__pct num', text: formatPercent(share) })),
          );
        }),
      );
    };
    renderRows(FIRST_EXTENSIONS);
    const section = h(
      'section',
      { class: 'panel__section', 'aria-labelledby': 'types-ext' },
      h('h4', { class: 'label', id: 'types-ext', text: t.types.extensions(formatCount(stats.length)) }),
      h(
        'table',
        { class: 'datatable datatable--ext' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'col', class: 'c-ext', text: t.types.colExt }),
            h('th', { scope: 'col', class: 'c-cat', text: t.types.colCategory }),
            h('th', { scope: 'col', class: 'c-num c-count', text: t.types.colCount }),
            h('th', { scope: 'col', class: 'c-num', text: t.types.colSize }),
            h('th', { scope: 'col', class: 'c-share', text: t.types.colShare }),
          ),
        ),
        body,
      ),
    );
    if (stats.length > FIRST_EXTENSIONS) {
      const shown = Math.min(stats.length, MAX_EXTENSIONS);
      const more = h('button', { class: 'btn btn--secondary btn--sm panel__more', type: 'button', text: t.types.showAll(formatCount(shown)) });
      more.addEventListener('click', () => {
        renderRows(shown);
        more.remove();
        if (stats.length > MAX_EXTENSIONS) section.append(h('p', { class: 'panel__note', text: plural(stats.length - MAX_EXTENSIONS, t.types.omitted) }));
      });
      section.append(more);
    }
    return section;
  }
}
