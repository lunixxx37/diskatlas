import { h } from './dom';
import { t, type Messages } from './i18n';
import { icon } from './icons';

// The start page's comparison: what DiskAtlas does in the browser alone, and what the
// DiskAtlas Helper adds on Windows. A real table (caption, column and row headers); on
// phones each row stacks, and ARIA roles keep the table semantics through that.

type RowKey = keyof Messages['helper']['compare']['rows'];
/** 'yes' and 'no' get a mark (an icon and the word, never colour alone); 'text' only its note. */
type Mark = 'yes' | 'no' | 'text';

/** Checked against the code: the helper's extra columns, flags, actions and its folder dialog. */
export const COMPARE_ROWS: ReadonlyArray<{ key: RowKey; browser: Mark; helper: Mark }> = [
  { key: 'own', browser: 'yes', helper: 'yes' },
  { key: 'drives', browser: 'no', helper: 'yes' },
  { key: 'dialog', browser: 'text', helper: 'text' },
  { key: 'views', browser: 'yes', helper: 'yes' },
  { key: 'onDisk', browser: 'no', helper: 'yes' },
  { key: 'marks', browser: 'no', helper: 'yes' },
  { key: 'admin', browser: 'no', helper: 'yes' },
  { key: 'explorer', browser: 'no', helper: 'yes' },
  { key: 'cleanup', browser: 'no', helper: 'yes' },
  { key: 'install', browser: 'text', helper: 'text' },
];

function cell(mark: Mark, note: string, column: string): HTMLElement {
  const parts: Array<Node | string> = [];
  if (mark !== 'text') {
    parts.push(h('span', { class: `cmp__mark cmp__mark--${mark}` }, icon(mark === 'yes' ? 'check' : 'minus'), h('span', { text: mark === 'yes' ? t.helper.compare.yes : t.helper.compare.no })));
  }
  if (note) parts.push(h('span', { class: mark === 'text' ? 'cmp__text' : 'cmp__note', text: note }));
  // data-label: the column's name, shown in front of the cell when the rows stack on phones.
  return h('td', { class: 'cmp__cell', role: 'cell', 'data-label': column }, h('span', { class: 'cmp__value' }, ...parts));
}

export function helperComparison(): HTMLElement {
  const c = t.helper.compare;
  const head = (label: string, sub: string, kind: string) =>
    h('th', { class: `cmp__col cmp__col--${kind}`, scope: 'col', role: 'columnheader' }, h('span', { class: 'cmp__col-name', text: label }), h('span', { class: 'cmp__col-sub', text: sub }));
  return h(
    'div',
    { class: 'cmp' },
    h(
      'table',
      { class: 'cmp__table', role: 'table' },
      h('caption', { class: 'cmp__caption', text: c.caption }),
      h(
        'thead',
        { role: 'rowgroup' },
        h(
          'tr',
          { role: 'row' },
          h('th', { class: 'cmp__col cmp__col--what', scope: 'col', role: 'columnheader' }, h('span', { class: 'sr-only', text: c.feature })),
          head(c.browser, c.browserSub, 'browser'),
          head(c.helper, c.helperSub, 'helper'),
        ),
      ),
      h(
        'tbody',
        { role: 'rowgroup' },
        ...COMPARE_ROWS.map(({ key, browser, helper }) => {
          const row = c.rows[key];
          return h(
            'tr',
            { class: 'cmp__row', role: 'row' },
            h('th', { class: 'cmp__what', scope: 'row', role: 'rowheader', text: row.what }),
            cell(browser, row.browser, c.browser),
            cell(helper, row.helper, c.helper),
          );
        }),
      ),
    ),
    h('p', { class: 'cmp__foot', text: c.footnote }),
  );
}
