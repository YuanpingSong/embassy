import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODEX_SOCKET_HOLDER_MAX_ANCESTRY_DEPTH,
  CODEX_SOCKET_HOLDER_MAX_HOLDERS,
  managedCodexSocketHeldOutsideEmbassy,
  type CodexSocketHolderInspector,
} from "../src/gateway/codex-socket-holder.js";

const socketPath = "/private/synthetic/app-server.sock";
const embassyPid = 100;
type Process = Readonly<{ pid: number; parentPid?: number }>;
type Evidence = Readonly<{ processes: readonly Process[]; socketHolderPids: readonly number[] }>;

/** Serves one holder list and per-pid parent lookups, the way lsof and `ps -o ppid= -p` do. */
function inspector(evidence: Evidence | Error, parentFault?: Error): CodexSocketHolderInspector & { parentLookups: number } {
  const table = new Map<number, Process>();
  if (!(evidence instanceof Error)) for (const process of evidence.processes) table.set(process.pid, process);
  const self = {
    parentLookups: 0,
    socketHolders: async (path: string, maximumHolders: number) => {
      assert.equal(path, socketPath); assert.equal(maximumHolders, CODEX_SOCKET_HOLDER_MAX_HOLDERS);
      if (evidence instanceof Error) throw evidence;
      return evidence.socketHolderPids;
    },
    parentOf: async (pid: number) => {
      self.parentLookups += 1;
      if (parentFault !== undefined) throw parentFault;
      return table.get(pid)?.parentPid;
    },
  };
  return self;
}
const held = (evidence: Evidence | Error, parentFault?: Error) =>
  managedCodexSocketHeldOutsideEmbassy({ socketPath, embassyPid, inspector: inspector(evidence, parentFault) });
const chain = (top: number, length: number, root = 1): Process[] =>
  Array.from({ length }, (_, index) => ({ pid: top - index, parentPid: index + 1 === length ? root : top - index - 1 }));

test("only a holder whose ancestry never meets Embassy counts; everything else is silent", async () => {
  const embassy = { pid: embassyPid, parentPid: 1 };
  const cases: readonly [string, Evidence | Error, boolean][] = [
    ["foreign holder", { processes: [{ pid: 400, parentPid: 1 }], socketHolderPids: [400] }, true],
    ["foreign holder beside Embassy descendants", { processes: [embassy, { pid: 101, parentPid: embassyPid }, { pid: 400, parentPid: 1 }],
      socketHolderPids: [embassyPid, 101, 400] }, true],
    ["holder parented straight to launchd's parent", { processes: [{ pid: 400, parentPid: 0 }], socketHolderPids: [400] }, true],
    ["launchd itself holds the socket", { processes: [], socketHolderPids: [1] }, true],
    ["no holder", { processes: [], socketHolderPids: [] }, false],
    ["Embassy itself", { processes: [embassy], socketHolderPids: [embassyPid] }, false],
    ["Embassy grandchild", { processes: [embassy, { pid: 101, parentPid: embassyPid }, { pid: 102, parentPid: 101 }],
      socketHolderPids: [102] }, false],
    ["holder vanished before its parent was read", { processes: [], socketHolderPids: [400] }, false],
    ["parent cycle never loops", { processes: [{ pid: 400, parentPid: 401 }, { pid: 401, parentPid: 400 }], socketHolderPids: [400] }, true],
    ["malformed holder pid", { processes: [{ pid: 0, parentPid: 1 }], socketHolderPids: [0] }, false],
    ["malformed parent pid", { processes: [{ pid: 400, parentPid: -1 }], socketHolderPids: [400] }, false],
    ["oversized holder evidence", { processes: [{ pid: 400, parentPid: 1 }], socketHolderPids: Array.from({ length: CODEX_SOCKET_HOLDER_MAX_HOLDERS + 1 }, () => 400) }, false],
    ["failed inspection", new Error("RAW_INSPECTOR_OUTPUT_SENTINEL"), false],
    // Host size is irrelevant by construction: only the holder's own chain is read.
    ["a 5000-process host with a short foreign chain", { processes: [...chain(5000, 4999, 1), { pid: 1 }], socketHolderPids: [2] }, true],
    ["an ancestry deeper than the walk bound", { processes: chain(9000, CODEX_SOCKET_HOLDER_MAX_ANCESTRY_DEPTH + 1), socketHolderPids: [9000] }, false],
    ["Embassy just inside the walk bound", { processes: [...chain(9000, CODEX_SOCKET_HOLDER_MAX_ANCESTRY_DEPTH - 1, embassyPid), embassy],
      socketHolderPids: [9000] }, false],
  ];
  for (const [label, evidence, expected] of cases) assert.equal(await held(evidence), expected, label);
  assert.equal(await held({ processes: [{ pid: 400, parentPid: 1 }], socketHolderPids: [400] }, new Error("ps unavailable")), false, "parent lookup failure");
  const big = inspector({ processes: [...chain(5000, 4999, 1), { pid: 1 }], socketHolderPids: [2] });
  assert.equal(await managedCodexSocketHeldOutsideEmbassy({ socketPath, embassyPid, inspector: big }), true);
  assert.equal(big.parentLookups, 1, "one ps call per ancestry step, never a table scan");
  assert.equal(await managedCodexSocketHeldOutsideEmbassy({ socketPath: "", embassyPid,
    inspector: { socketHolders: async () => assert.fail("an empty socket path is never inspected"), parentOf: async () => undefined } }), false);
});
