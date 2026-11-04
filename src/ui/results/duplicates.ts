import {
  DEFAULT_DUPLICATE_OPTIONS,
  PATH_SEP,
  findDuplicates,
  formatBytes,
  formatDate,
  type DuplicateGroup,
  type DuplicateOptions,
  type DuplicateResult,
  type ScanTree,
} from '../../core';
import { cleanupKey, entryButtons, type EntryActions } from '../cleanup';
import { h, uniqueId } from '../dom';
import { displayName, folderBelow, splitPath } from '../format';
import { plural, t } from '../i18n';
import { icon } from '../icons';
import { AnalysisCache } from './analysis-cache';
import { categoryVar } from './colors';

const MIN_SIZES: ReadonlyArray<[bytes: number, label: string]> = [
  [1024 ** 2, '1 MB'],
  [10 * 1024 ** 2, '10 MB'],
  [100 * 1024 ** 2, '100 MB'],
  [1024 ** 3, '1 GB'],
];
/** Groups drawn at first, and per "show more". */
const PAGE = 40;

export interface DuplicatesPanelOptions {
  tree: ScanTree;
  cache: AnalysisCache;
  /** Show in Explorer / Move to Recycle Bin (helper scans); null otherwise. */
  actions: EntryActions | null;
  /** Select a file in the folder tree. */
  onSelect: (entry: number) => void;
  /** The options in use before the view was rebuilt. */
  settings?: DuplicateOptions;
}

/**
 * "Possible duplicates": files below the current folder with the same name and size (or
 * the same size only). The search runs in slices, is cached per folder and options, and
 * stops when the folder or the options change.
 */
export class DuplicatesPanel {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly systemNote: HTMLElement;
  private readonly ids = uniqueId('dupes');
  private settingsValue: DuplicateOptions;
  private folder = -1;
  private search: AbortController | null = null;
  private shown = PAGE;

  constructor(private readonly options: DuplicatesPanelOptions) {
    this.settingsValue = { ...(options.settings ?? DEFAULT_DUPLICATE_OPTIONS) };
    this.title = h('h3', { class: 'panel__title' });
    this.body = h('div', { class: 'dupes__body', 'aria-live': 'polite' });
    this.systemNote = h('p', { class: 'panel__note dupes__system' }, icon('info'), h('span', { text: t.dupes.systemNote }));

    const sizeId = `${this.ids}-min`;
    const select = h('select', { class: 'select', id: sizeId });
    for (const [bytes, label] of MIN_SIZES) {
      const option = h('option', { value: String(bytes), text: label });
      option.selected = bytes === this.settingsValue.minSize;
      select.append(option);
    }
    select.addEventListener('change', () => this.change({ minSize: Number(select.value) }));
    const check = (label: string, checked: boolean, onChange: (on: boolean) => void) => {
      const input = h('input', { type: 'checkbox' });
      input.checked = checked;
      input.addEventListener('change', () => onChange(input.checked));
      return h('label', { class: 'check' }, input, h('span', { text: label }));
    };

    this.el = h(
      'div',
      { class: 'panel panel--dupes' },
      h('header', { class: 'panel__intro' }, h('div', null, this.title, h('p', { class: 'panel__lede', text: t.dupes.note }))),
      h(
        'div',
        { class: 'dupes__controls' },
        h('label', { class: 'dupes__min', for: sizeId }, h('span', { class: 'label', text: t.dupes.minSize }), select),
        check(t.dupes.sizeOnly, this.settingsValue.sizeOnly, (on) => this.change({ sizeOnly: on })),
        check(t.dupes.includeSystem, this.settingsValue.includeSystem, (on) => this.change({ includeSystem: on })),
      ),
      this.systemNote,
      this.body,
    );
    this.body.addEventListener('click', (event) => {
      const target = (event.target as Element).closest<HTMLElement>('[data-select]');
      if (target) options.onSelect(Number(target.dataset.select));
    });
    // Delete / Shift+Delete on a copy: the clean-up dialog for it.
    this.body.addEventListener('keydown', (event) => {
      const target = (event.target as Element).closest<HTMLElement>('[data-select]');
      if (target) cleanupKey(options.actions, event, Number(target.dataset.select), target);
    });
  }

  /** The options in use, to keep across a rebuilt view. */
  get settings(): DuplicateOptions {
    return { ...this.settingsValue };
  }

  update(folder: number): void {
    if (folder === this.folder) return;
    this.folder = folder;
    this.shown = PAGE;
    this.run();
  }

  destroy(): void {
    this.search?.abort();
  }

  private change(patch: Partial<DuplicateOptions>): void {
    this.settingsValue = { ...this.settingsValue, ...patch };
    this.shown = PAGE;
    this.run();
  }

  private run(): void {
    const { tree, cache } = this.options;
    const folder = this.folder;
    this.title.replaceChildren(t.dupes.title, h('span', { class: 'panel__where', text: displayName(tree, folder) }));
    this.systemNote.hidden = this.settingsValue.includeSystem;
    this.search?.abort();
    this.search = null;
    const key = AnalysisCache.duplicateKey(tree, folder, this.settingsValue);
    const cached = cache.duplicates(key);
    if (cached) {
      this.render(cached);
      return;
    }
    const search = new AbortController();
    this.search = search;
    this.body.replaceChildren(h('p', { class: 'dupes__searching' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), t.dupes.searching));
    findDuplicates(tree, folder, this.settingsValue, search.signal).then(
      (result) => {
        cache.storeDuplicates(key, result);
        if (this.search === search) {
          this.search = null;
          this.render(result);
        }
      },
      (error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
      },
    );
  }

  private render(result: DuplicateResult): void {
    const minLabel = MIN_SIZES.find(([bytes]) => bytes === this.settingsValue.minSize)?.[1] ?? formatBytes(this.settingsValue.minSize);
    if (result.groups.length === 0) {
      this.body.replaceChildren(h('p', { class: 'panel__empty', text: t.dupes.none(minLabel) }));
      return;
    }
    const list = h('ol', { class: `dupes${this.options.actions ? '' : ' dupes--plain'}` }, ...result.groups.slice(0, this.shown).map((g) => this.group(g)));
    const items: HTMLElement[] = [
      h('p', { class: 'dupes__summary', text: t.dupes.summary(plural(result.groups.length, t.dupes.groups), formatBytes(result.reclaimable)) }),
      list,
    ];
    const rest = result.groups.length - this.shown;
    if (rest > 0) {
      const more = h('button', { class: 'btn btn--secondary btn--sm panel__more', type: 'button', text: t.dupes.more(String(Math.min(rest, PAGE))) });
      more.addEventListener('click', () => {
        this.shown += PAGE;
        this.render(result);
        (this.body.querySelectorAll<HTMLElement>('.dupe')[this.shown - PAGE]?.querySelector('[data-select]') as HTMLElement | null)?.focus();
      });
      items.push(more);
    }
    this.body.replaceChildren(...items);
  }

  private group(g: DuplicateGroup): HTMLElement {
    const { tree, actions } = this.options;
    const newestKnown = g.members.length > 1 && tree.mtime(g.members[0]) > tree.mtime(g.members[1]);
    return h(
      'li',
      { class: 'dupe' },
      h(
        'div',
        { class: 'dupe__head' },
        h('span', { class: 'swatch', style: { '--cat': categoryVar(tree.categoryIndex(g.members[0])) } }),
        h('span', { class: 'dupe__name' }, h('strong', { text: g.name }), g.sameName ? null : h('span', { class: 'dupe__hint', text: ` (${t.dupes.differentNames})` })),
        h('span', { class: 'dupe__meta num', text: t.dupes.groupMeta(plural(g.members.length, t.dupes.copies), formatBytes(g.size), formatBytes(g.reclaimable)) }),
      ),
      h(
        'ul',
        { class: 'dupe__members' },
        ...g.members.map((m, k) => {
          const where = folderBelow(tree, m, this.folder);
          const shownPath = g.sameName ? where : [where, displayName(tree, m)].filter(Boolean).join(PATH_SEP);
          const [head, tail] = splitPath(shownPath);
          const name = displayName(tree, m);
          return h(
            'li',
            { class: 'dupe__member' },
            h(
              'button',
              { class: 'dupe__where mtrunc mono', type: 'button', 'data-select': String(m), title: t.dupes.select(name) },
              shownPath ? h('span', { class: 'mtrunc__head', text: head }) : null,
              h('span', { class: 'mtrunc__tail', text: shownPath ? tail : t.top.rightHere }),
            ),
            h('span', { class: 'dupe__date num', text: formatDate(tree.mtime(m)) }),
            k === 0 && newestKnown ? h('span', { class: 'dupe__newest', text: t.dupes.newest }) : h('span', { class: 'dupe__newest dupe__newest--none', 'aria-hidden': 'true' }),
            entryButtons(actions, tree, m),
          );
        }),
      ),
    );
  }
}
