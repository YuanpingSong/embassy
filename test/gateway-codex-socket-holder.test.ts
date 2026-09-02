import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODEX_SOCKET_HOLDER_MAX_HOLDERS,
  CODEX_SOCKET_HOLDER_MAX_PROCESSES,
  managedCodexSocketHeldOutsideEmbassy,
  type CodexSocketHolderInspection,
} from "../src/gateway/codex-socket-holder.js";

const socketPath = "/private/synthetic/app-server.sock";
const embassyPid = 100;

function held(inspection: CodexSocketHolderInspection | Error): Promise<boolean> {
  return managedCodexSocketHeldOutsideEmbassy({ socketPath, embassyPid, inspector: { inspect: async (request) => {
    assert.deepEqual(request, { socketPath, maximumProcesses: CODEX_SOCKET_HOLDER_MAX_PROCESSES,
      maximumSocketHolders: CODEX_SOCKET_HOLDER_MAX_HOLDERS });
    if (inspection instanceof Error) throw inspection;
    return inspection;
  } } });
}

test("only a bounded non-Embassy socket holder counts; everything else is silent", async () => {
  const embassy = { pid: embassyPid, parentPid: 1 };
  const cases: readonly [string, CodexSocketHolderInspection | Error, boolean][] = [
    ["foreign holder", { processes: [{ pid: 400, parentPid: 1 }], socketHolderPids: [400] }, true],
    ["foreign holder beside Embassy descendants", { processes: [embassy, { pid: 101, parentPid: embassyPid }, { pid: 400, parentPid: 1 }],
      socketHolderPids: [embassyPid, 101, 400] }, true],
    ["no holder", { processes: [], socketHolderPids: [] }, false],
    ["Embassy itself", { processes: [embassy], socketHolderPids: [embassyPid] }, false],
    ["Embassy grandchild", { processes: [embassy, { pid: 101, parentPid: embassyPid }, { pid: 102, parentPid: 101 }],
      socketHolderPids: [102] }, false],
    ["holder without process evidence", { processes: [], socketHolderPids: [400] }, false],
    ["parent cycle never loops", { processes: [{ pid: 400, parentPid: 401 }, { pid: 401, parentPid: 400 }], socketHolderPids: [400] }, true],
    ["malformed pid", { processes: [{ pid: 0, parentPid: 1 }], socketHolderPids: [0] }, false],
    ["duplicate pid", { processes: [{ pid: 400 }, { pid: 400 }], socketHolderPids: [400] }, false],
    ["oversized process evidence", { processes: Array.from({ length: CODEX_SOCKET_HOLDER_MAX_PROCESSES + 1 }, (_, index) => ({ pid: index + 1 })),
      socketHolderPids: [1] }, false],
    ["oversized holder evidence", { processes: [{ pid: 400 }], socketHolderPids: Array.from({ length: CODEX_SOCKET_HOLDER_MAX_HOLDERS + 1 }, () => 400) }, false],
    ["failed inspection", new Error("RAW_INSPECTOR_OUTPUT_SENTINEL"), false],
  ];
  for (const [label, inspection, expected] of cases) assert.equal(await held(inspection), expected, label);
  assert.equal(await managedCodexSocketHeldOutsideEmbassy({ socketPath: "", embassyPid,
    inspector: { inspect: async () => assert.fail("an empty socket path is never inspected") } }), false);
});
