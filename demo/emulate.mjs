import {createInterface} from "node:readline";
import xterm from "@xterm/headless";

const {Terminal} = xterm;

const COLUMNS = Number(process.argv[2] ?? 90);
const ROWS = Number(process.argv[3] ?? 24);
if (!Number.isInteger(COLUMNS) || COLUMNS < 24 || COLUMNS > 160 ||
    !Number.isInteger(ROWS) || ROWS < 8 || ROWS > 60) throw new Error("INVALID_DIMENSIONS");
const MAX_DATA_BYTES = 1024 * 1024;
const ansi16 = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightblack", "brightred", "brightgreen", "brightyellow",
  "brightblue", "brightmagenta", "brightcyan", "brightwhite",
];

const terminal = new Terminal({cols: COLUMNS, rows: ROWS, allowProposedApi: true});
let cursorVisible = true;
terminal.parser.registerCsiHandler({prefix: "?", final: "h"}, (params) => {
  if (params.includes(25)) cursorVisible = true;
  return false;
});
terminal.parser.registerCsiHandler({prefix: "?", final: "l"}, (params) => {
  if (params.includes(25)) cursorVisible = false;
  return false;
});

const emit = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

terminal.onData((data) => {
  emit({response: Buffer.from(data, "utf8").toString("base64")});
});

const paletteColor = (index) => {
  if (index < ansi16.length) return ansi16[index];
  if (index >= 16 && index <= 231) {
    const offset = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = levels[Math.floor(offset / 36)];
    const green = levels[Math.floor(offset / 6) % 6];
    const blue = levels[offset % 6];
    return [red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  const gray = 8 + (index - 232) * 10;
  return [gray, gray, gray].map((value) => value.toString(16).padStart(2, "0")).join("");
};

const cellColor = (cell, foreground) => {
  const isDefault = foreground ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return undefined;
  const color = foreground ? cell.getFgColor() : cell.getBgColor();
  const isRgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
  if (isRgb) return color.toString(16).padStart(6, "0");
  const isPalette = foreground ? cell.isFgPalette() : cell.isBgPalette();
  return isPalette ? paletteColor(color) : undefined;
};

const cellStyle = (cell) => {
  const style = {};
  const fg = cellColor(cell, true);
  const bg = cellColor(cell, false);
  if (fg) style.fg = fg;
  if (bg) style.bg = bg;
  if (cell.isBold()) style.bold = true;
  if (cell.isDim()) style.dim = true;
  if (cell.isInverse()) style.inverse = true;
  if (cell.isUnderline()) style.underline = true;
  return style;
};

const sameStyle = (left, right) =>
  left.fg === right.fg && left.bg === right.bg &&
  left.bold === right.bold && left.dim === right.dim &&
  left.inverse === right.inverse && left.underline === right.underline;

const snapshot = () => {
  const buffer = terminal.buffer.active;
  const rows = [];
  for (let rowIndex = 0; rowIndex < ROWS; rowIndex += 1) {
    const line = buffer.getLine(buffer.viewportY + rowIndex);
    const runs = [];
    if (line) {
      for (let column = 0; column < COLUMNS; column += 1) {
        const cell = line.getCell(column);
        if (!cell || cell.getWidth() === 0) continue;
        const style = cellStyle(cell);
        const text = cell.isInvisible() ? " " : (cell.getChars() || " ");
        const previous = runs.at(-1);
        if (previous && sameStyle(previous, style)) previous.text += text;
        else runs.push({...style, text});
      }
      const tail = runs.at(-1);
      if (tail && !tail.fg && !tail.bg && !tail.bold && !tail.dim && !tail.inverse && !tail.underline) {
        tail.text = tail.text.replace(/ +$/u, "");
        if (!tail.text) runs.pop();
      }
    }
    rows.push(runs);
  }
  const cursorRow = buffer.baseY + buffer.cursorY - buffer.viewportY;
  return {
    rows,
    cursor: {
      row: Math.max(0, Math.min(ROWS - 1, cursorRow)),
      column: Math.max(0, Math.min(COLUMNS - 1, buffer.cursorX)),
      visible: cursorVisible && cursorRow >= 0 && cursorRow < ROWS,
    },
  };
};

const write = (data) => new Promise((resolve) => terminal.write(data, resolve));

const handle = async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    emit({error: "INVALID_JSON"});
    return;
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    emit({error: "INVALID_REQUEST"});
    return;
  }
  if (Object.hasOwn(request, "data")) {
    if (typeof request.data !== "string") {
      emit({error: "INVALID_DATA"});
      return;
    }
    const data = Buffer.from(request.data, "base64");
    if (data.length > MAX_DATA_BYTES) {
      emit({error: "DATA_TOO_LARGE"});
      return;
    }
    await write(data);
    emit({ok: true});
    return;
  }
  if (request.snapshot === true && Object.keys(request).length === 1) {
    emit(snapshot());
    return;
  }
  emit({error: "INVALID_REQUEST"});
};

const input = createInterface({input: process.stdin, crlfDelay: Infinity, terminal: false});
let queue = Promise.resolve();
input.on("line", (line) => {
  if (!line) return;
  queue = queue.then(() => handle(line)).catch(() => emit({error: "EMULATION_FAILED"}));
});
input.on("close", () => {
  queue.finally(() => terminal.dispose());
});
