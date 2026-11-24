#!/usr/bin/env node
// Generates src/dark.css from index.css + enhancements.css.
// Re-run via `npm run gen:dark` (also runs automatically on predev/prebuild).
// Hand-rolled parser tuned for this project's minified stylesheets.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = ["src/index.css", "src/enhancements.css"].map(f => join(root, f));
const outFile = join(root, "src/dark.css");

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function hexToHsla(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = 60 * (((g - b) / d) % 6);
    else if (max === g) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - g) / d + 4);
  }
  if (hue < 0) hue += 360;
  return { h: hue, s, l, a };
}

function hslaToHex({ h, s, l, a }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  const seg = ((h % 360) + 360) % 360;
  if (seg < 60) [r, g, b] = [c, x, 0];
  else if (seg < 120) [r, g, b] = [x, c, 0];
  else if (seg < 180) [r, g, b] = [0, c, x];
  else if (seg < 240) [r, g, b] = [0, x, c];
  else if (seg < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = v => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}${a < 1 ? Math.round(a * 255).toString(16).padStart(2, "0") : ""}`;
}

function parseColor(tok) {
  if (tok.startsWith("#")) return hexToHsla(tok);
  const m = tok.match(/^(rgba?|hsla?)\((.*)\)$/i);
  if (m) {
    const parts = m[2].trim().split(/[\s,/]+/).filter(Boolean);
    if (m[1].toLowerCase().startsWith("hsl")) {
      return { h: parseFloat(parts[0]), s: parseFloat(parts[1]) / 100, l: parseFloat(parts[2]) / 100, a: parts[3] !== undefined ? parseFloat(parts[3]) : 1 };
    }
    const [r, g, b] = parts.slice(0, 3).map(v => v.includes("%") ? parseFloat(v) / 100 : parseFloat(v) / 255);
    const base = hexToHsla(`#${[r, g, b].map(v => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0")).join("")}`);
    return { ...base, a: parts[3] !== undefined ? parseFloat(parts[3]) : 1 };
  }
  if (tok.toLowerCase() === "white") return { h: 0, s: 0, l: 1, a: 1 };
  if (tok.toLowerCase() === "black") return { h: 0, s: 0, l: 0, a: 1 };
  return null;
}

// ---- mapping (hue-preserving) ----
const SURFACE = { h: 222, s: 0.33 };
const mapBg = c => {
  if (c.l <= 0.80) return null;
  if (c.s < 0.15) return { h: SURFACE.h, s: SURFACE.s, l: 0.12 + (1 - c.l) * 0.6, a: c.a };
  return { h: c.h, s: Math.min(c.s, 0.45), l: 0.14 + (1 - c.l) * 0.5, a: c.a };
};
const mapFg = c => {
  if (c.l < 0.45) return { h: c.h, s: c.s < 0.15 ? Math.min(c.s * 0.6, 0.15) : Math.min(c.s, 0.6), l: 0.92 - c.l * 0.5, a: c.a };
  if (c.l < 0.55 && c.s > 0.4) return { h: c.h, s: c.s, l: 0.68, a: c.a };
  return null;
};
const mapBorder = c => {
  if (c.l <= 0.75) return null;
  return c.s < 0.15 ? { h: 220, s: 0.2, l: 0.24, a: c.a } : { h: c.h, s: Math.min(c.s, 0.4), l: 0.24, a: c.a };
};

const groupOf = prop => {
  const p = prop.toLowerCase();
  if (p === "box-shadow" || p === "text-shadow") return null;
  if (p.startsWith("border") || p.startsWith("outline")) return mapBorder;
  if (p.startsWith("background")) return mapBg;
  if (p === "color" || p === "fill" || p === "stroke") return mapFg;
  return null;
};

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\bwhite\b|\bblack\b/g;

function mapDecl(prop, value) {
  const map = groupOf(prop);
  if (!map) return null;
  let changed = false;
  const out = value.replace(COLOR_RE, tok => {
    const c = parseColor(tok);
    if (!c) return tok;
    const next = map(c);
    if (!next) return tok;
    changed = true;
    return hslaToHex(next);
  });
  return changed ? out : null;
}

function parseRules(css, atStack = []) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    const head = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < css.length && depth) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    const body = css.slice(open + 1, j - 1);
    if (head.startsWith("@")) out.push(...parseRules(body, [...atStack, head]));
    else out.push({ sel: head, decls: body, at: atStack });
    i = j;
  }
  return out;
}

const chunks = [];
for (const src of sources) {
  const rules = parseRules(readFileSync(src, "utf8"));
  for (const rule of rules) {
    const mapped = [];
    for (const decl of rule.decls.split(";")) {
      const idx = decl.indexOf(":");
      if (idx === -1) continue;
      const prop = decl.slice(0, idx).trim();
      const value = decl.slice(idx + 1).trim();
      if (!prop || !value) continue;
      const next = mapDecl(prop, value);
      if (next) mapped.push(`${prop}:${next}`);
    }
    if (mapped.length) {
      const sels = rule.sel.split(",").map(s => `html[data-theme="dark"] ${s.trim()}`).join(",");
      chunks.push({ at: rule.at, css: `${sels}{${mapped.join(";")}}` });
    }
  }
}

// Re-wrap rules inside their @media blocks
let body = "";
let openAt = [];
const flush = () => { while (openAt.length) { body += "}"; openAt.pop(); } };
for (const c of chunks) {
  const key = c.at.join("|");
  if (key !== openAt.join("|")) { flush(); for (const a of c.at) { body += `${a}{`; openAt.push(a); } }
  body += c.css;
}
flush();

const header = `/* GENERATED by scripts/gen-dark.mjs — do not edit by hand.
   Manual dark-mode tweaks belong in src/dark-manual.css. */
html[data-theme="dark"]{color-scheme:dark}
html[data-theme="dark"],html[data-theme="dark"] body{background:#0d1526;color:#e8edf6}
`;
writeFileSync(outFile, header + body);
console.log(`dark.css written: ${chunks.length} rules from ${sources.length} files`);
