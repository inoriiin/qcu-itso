import { readFileSync, writeFileSync } from 'node:fs';

// Brand targets
const BLUE = { r: 0x00, g: 0x23, b: 0x66 };   // #002366
const ORANGE = { r: 0xfd, g: 0x72, b: 0x01 }; // #FD7201

function hexToHsl(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0, hue = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return { h: hue, s, l };
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1/3);
  }
  const to = v => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

const blueH = hexToHsl('#002366').h;
const orangeH = hexToHsl('#FD7201').h;

const files = process.argv.slice(2);
for (const file of files) {
  let css = readFileSync(file, 'utf8');
  const seen = new Map();
  css = css.replace(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g, (m) => {
    const orig = m.toLowerCase();
    if (seen.has(orig)) return seen.get(orig);
    const { h, s, l } = hexToHsl(orig);
    let out = orig;
    // Blue family: saturated blues (exclude purples ~250-290 and cyans/teals)
    if (s > 0.25 && h >= 205 && h <= 245 && l < 0.85) {
      out = hslToHex(blueH, Math.min(1, s * 1.05), l);
    }
    // Orange/amber family
    else if (s > 0.3 && h >= 15 && h <= 48 && l < 0.8) {
      out = hslToHex(orangeH, Math.min(1, s), l);
    }
    seen.set(orig, out);
    return out;
  });
  writeFileSync(file, css);
  console.log('updated', file);
}
