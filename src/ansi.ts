/**
 * ANSI escape sequence handling for container logs.
 *
 * Programs write colour codes into their output whether or not anything is watching: a
 * container's logs contain the raw `ESC[32m`-style byte sequences. Docker stores them as
 * they came, so the renderer has to interpret them — showing them verbatim means the user
 * sees `[0m[32mok[0m` noise and loses the pass/fail colouring that made the output useful.
 *
 * This module is pure text handling (no DOM): it turns one raw log line into styled runs.
 */

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

const ESC = "\u001b";

/** xterm's 16 base colours, then the 6×6×6 cube and the 24-step grey ramp for 256-colour output. */
const BASE_COLORS = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];

const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

/**
 * SGR (`ESC[…m`) carries the styling we keep; every other escape is structure we can only
 * drop — cursor moves, line erases and OSC titles have no meaning in a scrollback pane.
 * The alternatives are ordered so SGR is matched before the generic CSI form.
 */
const ESCAPE = new RegExp(
  `${ESC}\\[([0-9;]*)m` + // SGR: the only sequence that sets style
    `|${ESC}\\[[0-9;?]*[ -/]*[@-~]` + // any other CSI (erase/cursor moves)
    `|${ESC}\\][\\s\\S]*?(?:\\u0007|${ESC}\\\\)` + // OSC (window titles)
    `|${ESC}.`, // a lone two-character escape
  "g",
);

function color256(index: number): string {
  if (index < 16) return BASE_COLORS[index];
  if (index < 232) {
    const offset = index - 16;
    const red = CUBE_STEPS[Math.floor(offset / 36) % 6];
    const green = CUBE_STEPS[Math.floor(offset / 6) % 6];
    const blue = CUBE_STEPS[offset % 6];
    return `rgb(${red}, ${green}, ${blue})`;
  }
  const level = 8 + (index - 232) * 10;
  return `rgb(${level}, ${level}, ${level})`;
}

function clampByte(value: number | undefined): number | null {
  if (value === undefined || !Number.isInteger(value)) return null;
  return Math.min(255, Math.max(0, value));
}

function applySgr(current: AnsiStyle, params: string): AnsiStyle {
  // `ESC[m` is a plain reset.
  if (params.length === 0) return {};

  const codes = params.split(";").map((part) => (part === "" ? 0 : Number(part)));
  const style: AnsiStyle = { ...current };

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) {
      for (const key of Object.keys(style) as (keyof AnsiStyle)[]) delete style[key];
    } else if (code === 1) {
      style.bold = true;
      delete style.dim;
    } else if (code === 2) {
      style.dim = true;
      delete style.bold;
    } else if (code === 3) {
      style.italic = true;
    } else if (code === 4) {
      style.underline = true;
    } else if (code === 22) {
      delete style.bold;
      delete style.dim;
    } else if (code === 23) {
      delete style.italic;
    } else if (code === 24) {
      delete style.underline;
    } else if (code === 39) {
      delete style.fg;
    } else if (code === 49) {
      delete style.bg;
    } else if (code >= 30 && code <= 37) {
      style.fg = BASE_COLORS[code - 30];
    } else if (code >= 90 && code <= 97) {
      style.fg = BASE_COLORS[code - 90 + 8];
    } else if (code >= 40 && code <= 47) {
      style.bg = BASE_COLORS[code - 40];
    } else if (code >= 100 && code <= 107) {
      style.bg = BASE_COLORS[code - 100 + 8];
    } else if (code === 38 || code === 48) {
      const target = code === 38 ? "fg" : "bg";
      const mode = codes[index + 1];
      if (mode === 5) {
        const level = codes[index + 2];
        if (Number.isInteger(level) && level >= 0 && level < 256) {
          style[target] = color256(level);
          index += 2;
        } else {
          index += 1;
        }
      } else if (mode === 2) {
        const channels = [clampByte(codes[index + 2]), clampByte(codes[index + 3]), clampByte(codes[index + 4])];
        if (channels.every((channel) => channel !== null)) {
          style[target] = `rgb(${channels.join(", ")})`;
          index += 4;
        } else {
          index += 1;
        }
      } else {
        index += 1;
      }
    }
  }

  return style;
}

function sameStyle(left: AnsiStyle, right: AnsiStyle): boolean {
  return (
    left.fg === right.fg &&
    left.bg === right.bg &&
    left.bold === right.bold &&
    left.dim === right.dim &&
    left.italic === right.italic &&
    left.underline === right.underline
  );
}

/**
 * What a terminal would leave on screen after a carriage return. Progress output repaints
 * one line over and over ("10%\r30%\r100%"), and a trailing `\r` on its own (as in CRLF
 * output) overwrites nothing — so the last non-empty segment is the visible one.
 */
function visibleText(raw: string): string {
  if (!raw.includes("\r")) return raw;
  const segments = raw.split("\r");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].length > 0) return segments[index];
  }
  return "";
}

export function isStyled(style: AnsiStyle): boolean {
  return Object.keys(style).length > 0;
}

/** Split one raw log line into styled runs, ready to be rendered as spans. */
export function parseAnsi(raw: string): AnsiSpan[] {
  const line = visibleText(raw);
  if (line.length === 0) return [];
  if (!line.includes(ESC)) return [{ text: line, style: {} }];

  const spans: AnsiSpan[] = [];
  let style: AnsiStyle = {};
  let cursor = 0;

  const push = (text: string): void => {
    if (text.length === 0) return;
    const previous = spans[spans.length - 1];
    // Merge runs sharing a style: a chatty line should not become hundreds of nodes.
    if (previous && sameStyle(previous.style, style)) {
      previous.text += text;
      return;
    }
    spans.push({ text, style: { ...style } });
  };

  ESCAPE.lastIndex = 0;
  for (let match = ESCAPE.exec(line); match !== null; match = ESCAPE.exec(line)) {
    push(line.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (match[1] !== undefined) style = applySgr(style, match[1]);
  }
  push(line.slice(cursor));

  return spans;
}
