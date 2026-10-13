import { SPACE_COLORS } from '../shared/common.js';

// Colours. Follows the Omarchy theme when theme/omarchy.json exists (written by
// tools/omarchy-theme-hook on every theme change), otherwise the system
// light/dark preference.

const FALLBACK = {
  dark: {
    mode: 'dark', background: '#1c1d21', foreground: '#e6e4e0', accent: '#8aa8f0', muted: '#6c6f7d',
    red: '#ef7f8c', orange: '#f0a165', yellow: '#e2c36b', green: '#8fc58a', cyan: '#78c6d8', blue: '#7fa2f0', magenta: '#c49af2',
  },
  light: {
    mode: 'light', background: '#f3f1ee', foreground: '#26262b', accent: '#3d6fd6', muted: '#9a9aa3',
    red: '#d34d5f', orange: '#e07b30', yellow: '#c79b1c', green: '#4b9a5b', cyan: '#2b98b0', blue: '#3d6fd6', magenta: '#9a58c4',
  },
};

const hex = (h) => {
  const m = /^#?([0-9a-f]{6})/i.exec(h || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
export const mix = (a, b, t) => {
  const x = hex(a);
  const y = hex(b);
  if (!x || !y) return a;
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
};
const rgba = (h, alpha) => {
  const c = hex(h) || [128, 128, 128];
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
};
const luminance = (h) => {
  const [r, g, b] = (hex(h) || [0, 0, 0]).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

let omarchy = null;
let omarchyText = '';

// Returns true if the theme file changed.
export async function loadOmarchyTheme() {
  try {
    const res = await fetch(chrome.runtime.getURL('theme/omarchy.json'), { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const text = await res.text();
    if (text === omarchyText) return false;
    omarchyText = text;
    omarchy = JSON.parse(text);
    return true;
  } catch {
    if (!omarchy) return false;
    omarchy = null;
    omarchyText = '';
    return true;
  }
}

export function basePalette() {
  const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  if (!omarchy?.background) return FALLBACK[systemDark ? 'dark' : 'light'];
  const mode = omarchy.mode || (luminance(omarchy.background) < 0.4 ? 'dark' : 'light');
  return { ...FALLBACK[mode], ...omarchy, mode };
}

export function spaceHex(p, color) {
  switch (color) {
    case 'purple': return mix(p.blue, p.magenta, 0.55);
    case 'pink': return mix(p.magenta, p.red, 0.25);
    case 'grey': return mix(p.muted, p.foreground, 0.2);
    default: return p[color] || p.accent;
  }
}

// CSS custom properties for the sidebar tinted with the given space colour.
export function themeVars(color) {
  const p = basePalette();
  const dark = p.mode === 'dark';
  const space = spaceHex(p, color);
  const bg = p.background;
  const fg = p.foreground;
  return {
    '--space': space,
    '--bg-top': mix(bg, space, dark ? 0.2 : 0.24),
    '--bg-bottom': mix(bg, space, dark ? 0.07 : 0.1),
    '--fg': fg,
    '--fg-soft': mix(fg, bg, 0.28),
    '--fg-muted': mix(fg, bg, 0.5),
    '--accent': p.accent,
    '--hover': rgba(fg, dark ? 0.07 : 0.06),
    '--press': rgba(fg, dark ? 0.11 : 0.1),
    '--active': dark ? rgba(mix(fg, space, 0.15), 0.15) : 'rgba(255, 255, 255, 0.82)',
    '--active-shadow': dark ? `0 0 0 1px ${rgba(fg, 0.06)} inset` : '0 1px 2px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.03)',
    '--tile': rgba(fg, dark ? 0.06 : 0.07),
    '--tile-hover': rgba(fg, dark ? 0.1 : 0.11),
    '--line': rgba(fg, dark ? 0.1 : 0.12),
    '--field': rgba(fg, dark ? 0.07 : 0.07),
    '--field-focus': dark ? rgba(fg, 0.11) : 'rgba(255,255,255,.9)',
    '--surface': dark ? mix(bg, fg, 0.06) : '#ffffff',
    '--surface-line': rgba(fg, dark ? 0.12 : 0.1),
    '--drop': space,
    '--on-space': luminance(space) > 0.42 ? '#16161a' : '#ffffff',
    '--danger': p.red,
    '--scheme': dark ? 'dark' : 'light',
    ...Object.fromEntries(SPACE_COLORS.map((c) => [`--dot-${c}`, spaceHex(p, c)])),
  };
}

export function swatch(color) {
  return spaceHex(basePalette(), color);
}
