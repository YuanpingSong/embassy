/** Replays the ANSI subset emitted by Ink and returns the last alternate-screen contents. */
export function tuiScreen(bytes: string): string {
  let lines: string[][] = [[]];
  let row = 0;
  let column = 0;
  let saved = { row: 0, column: 0 };
  const ensure = (index: number) => { while (lines.length <= index) lines.push([]); };
  const home = () => { row = 0; column = 0; ensure(0); };
  const clear = () => { lines = [[]]; home(); };
  const count = (parameters: string, fallback = 1) => {
    const parsed = Number(parameters.split(";")[0] || fallback);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  for (let index = 0; index < bytes.length;) {
    const codePoint = bytes.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    if (character !== "\u001b") {
      if (character === "\n") { row++; column = 0; ensure(row); }
      else if (character === "\r") column = 0;
      else if (character === "\b") column = Math.max(0, column - 1);
      else if (character >= " ") { ensure(row); lines[row]![column++] = character; }
      index += character.length;
      continue;
    }

    const osc = /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/u.exec(bytes.slice(index));
    if (osc) { index += osc[0].length; continue; }
    const csi = /^\u001b\[([?0-9;]*)([A-Za-z~])/u.exec(bytes.slice(index));
    if (!csi) { index++; continue; }
    const [sequence, parameters = "", command] = csi;
    index += sequence.length;
    if (command === "H" || command === "f") {
      const [nextRow = "1", nextColumn = "1"] = parameters.split(";");
      row = Math.max(0, Number(nextRow || 1) - 1);
      column = Math.max(0, Number(nextColumn || 1) - 1);
      ensure(row);
    } else if (command === "A") row = Math.max(0, row - count(parameters));
    else if (command === "B") { row += count(parameters); ensure(row); }
    else if (command === "C") column += count(parameters);
    else if (command === "D") column = Math.max(0, column - count(parameters));
    else if (command === "E") { row += count(parameters); column = 0; ensure(row); }
    else if (command === "F") { row = Math.max(0, row - count(parameters)); column = 0; }
    else if (command === "G") column = Math.max(0, count(parameters) - 1);
    else if (command === "s") saved = { row, column };
    else if (command === "u") { row = saved.row; column = saved.column; ensure(row); }
    else if (command === "J") {
      const mode = parameters || "0";
      ensure(row);
      if (mode === "2" || mode === "3") clear();
      else if (mode === "0") { lines[row]!.splice(column); lines.splice(row + 1); }
      else if (mode === "1") { for (let line = 0; line < row; line++) lines[line] = []; lines[row]!.splice(0, column + 1); }
    } else if (command === "K") {
      ensure(row);
      const mode = parameters || "0";
      if (mode === "2") lines[row] = [];
      else if (mode === "1") for (let cell = 0; cell <= column; cell++) lines[row]![cell] = " ";
      else lines[row]!.splice(column);
    } else if (command === "h" && parameters === "?1049") clear();
    // SGR, cursor visibility and alternate-screen leave do not change captured text.
  }
  return lines.map((line) => line.map((cell) => cell ?? " ").join("").replace(/\s+$/u, ""))
    .join("\n").replace(/\n+$/u, "");
}
