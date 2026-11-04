import { CATEGORIES } from '../../core';

// Canvas drawings read the theme's colours from the CSS custom properties, so the
// palette lives in one place (tokens.css) and both themes stay in sync.

export interface MapColors {
  bg: string;
  frames: [string, string, string];
  frameLine: string;
  hatchBg: string;
  hatchLine: string;
  ink: string;
  ink2: string;
  muted: string;
  accent: string;
  panel: string;
  categories: string[];
  /** Label colour inside each category fill, and whether it needs a paper plate for WCAG AA. */
  labels: Array<{ color: string; plate: boolean }>;
}

export const categoryVar = (index: number): string => `var(--cat-${CATEGORIES[index].id})`;

function parseHex(value: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two hex colours (1 when either cannot be parsed). */
export function contrastRatio(a: string, b: string): number {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return 1;
  const [hi, lo] = [luminance(pa), luminance(pb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function readMapColors(el: Element = document.documentElement): MapColors {
  const style = getComputedStyle(el);
  const v = (name: string) => style.getPropertyValue(name).trim();
  const labelInk = v('--label-ink') || '#16181c';
  const labelLight = v('--label-light') || '#ffffff';
  const categories = CATEGORIES.map((c) => v(`--cat-${c.id}`));
  const labels = categories.map((fill) => {
    const dark = contrastRatio(labelInk, fill);
    const light = contrastRatio(labelLight, fill);
    const best = Math.max(dark, light);
    return { color: dark >= light ? labelInk : labelLight, plate: best < 4.5 };
  });
  return {
    bg: v('--map-bg'),
    frames: [v('--frame-0'), v('--frame-1'), v('--frame-2')],
    frameLine: v('--frame-line'),
    hatchBg: v('--hatch-bg'),
    hatchLine: v('--hatch-line'),
    ink: v('--ink'),
    ink2: v('--ink-2'),
    muted: v('--muted'),
    accent: v('--accent'),
    panel: v('--panel'),
    categories,
    labels,
  };
}
