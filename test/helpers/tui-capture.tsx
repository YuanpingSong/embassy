import { createElement } from "react";
import { renderToString } from "ink";
import { TuiView } from "../../src/gateway/tui-view.js";
import {
  FIXED_TUI_NOW,
  defaultTuiSceneSize,
  isTuiDesignScene,
  tuiDesignFixture,
  tuiDesignScenes,
} from "./tui-design-fixtures.js";

function dimension(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`invalid terminal dimension: ${value}`);
  return parsed;
}

const [sceneArgument = "endpoints", widthArgument, heightArgument] = process.argv.slice(2);
if (!isTuiDesignScene(sceneArgument)) {
  process.stderr.write(`usage: tui-capture <${tuiDesignScenes.join("|")}> [width] [height]\n`);
  process.exitCode = 2;
} else {
  const [defaultWidth, defaultHeight] = defaultTuiSceneSize[sceneArgument];
  try {
    const columns = dimension(widthArgument, defaultWidth);
    const rows = dimension(heightArgument, defaultHeight);
    const realNow = Date.now;
    Date.now = () => FIXED_TUI_NOW;
    let output: string;
    try {
      output = renderToString(createElement(TuiView, {
        model: tuiDesignFixture(sceneArgument),
        columns,
        rows,
        now: FIXED_TUI_NOW,
        color: !("NO_COLOR" in process.env),
      }), { columns });
    } finally {
      Date.now = realNow;
    }
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
