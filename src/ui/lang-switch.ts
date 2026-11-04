import { h, setText, uniqueId } from './dom';
import { LANGS, lang, t, type Lang } from './i18n';

/** Each language under its own name, so it can be found whatever the current language is. */
const NAMES: Record<Lang, { code: string; name: string }> = {
  en: { code: 'EN', name: 'English' },
  de: { code: 'DE', name: 'Deutsch' },
};

/**
 * EN / DE: a native radio group like the theme switch (Tab to reach it, arrow keys to
 * change). The short code is what you see; screen readers hear the language's name,
 * spoken in that language.
 */
export class LangSwitch {
  readonly el: HTMLFieldSetElement;
  private readonly legend: HTMLLegendElement;
  private readonly inputs: HTMLInputElement[] = [];

  constructor(onChange: (language: Lang) => void) {
    const name = uniqueId('lang');
    this.legend = h('legend', { class: 'sr-only' });
    this.el = h('fieldset', { class: 'seg-switch lang-switch' }, this.legend);
    for (const code of LANGS) {
      const input = h('input', { type: 'radio', name, value: code });
      input.addEventListener('change', () => {
        if (input.checked) onChange(code);
      });
      this.inputs.push(input);
      this.el.append(
        h(
          'label',
          { lang: code, title: NAMES[code].name },
          input,
          h('span', { class: 'lang-switch__code', 'aria-hidden': 'true', text: NAMES[code].code }),
          h('span', { class: 'sr-only', text: NAMES[code].name }),
        ),
      );
    }
    this.relabel();
  }

  /** Writes the legend in the active language and checks the active language. */
  relabel(): void {
    setText(this.legend, t.language.legend);
    for (const input of this.inputs) input.checked = input.value === lang();
  }
}
