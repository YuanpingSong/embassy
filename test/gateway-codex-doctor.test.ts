import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODEX_DOCTOR_MAX_PROCESSES,
  CODEX_DOCTOR_MAX_SOCKET_HOLDERS,
  diagnoseCodexAttachment,
  type CodexDoctorInspection,
} from "../src/gateway/codex-doctor.js";

const socketPath = "/private/synthetic/app-server.sock";
const daemonExecutablePath = "/private/synthetic/codex-app-server";
const embassyPid = 100;

function diagnose(inspection: CodexDoctorInspection) {
  return diagnoseCodexAttachment({
    socketPath,
    daemonExecutablePath,
    embassyPid,
    inspector: {
      async inspect(request) {
        assert.deepEqual(request, {
          socketPath,
          maximumProcesses: CODEX_DOCTOR_MAX_PROCESSES,
          maximumSocketHolders: CODEX_DOCTOR_MAX_SOCKET_HOLDERS,
        });
        return inspection;
      },
    },
  });
}

const daemon = { pid: 200, parentPid: 1, executablePath: daemonExecutablePath };
const desktop = {
  pid: 300,
  parentPid: 1,
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  bundleIdentifier: "com.openai.codex",
};

test("a running Desktop without an external socket holder is split-brain", async () => {
  const result = await diagnose({
    processes: [daemon, desktop],
    socketHolderPids: [daemon.pid, daemon.pid],
  });
  assert.deepEqual(result, { conditions: ["split_brain"] });
  assert.equal(JSON.stringify(result).includes(String(desktop.pid)), false);
  assert.equal(JSON.stringify(result).includes(desktop.executablePath), false);
});

test("a daemon-only socket without Desktop is orphaned", async () => {
  assert.deepEqual(await diagnose({
    processes: [daemon],
    socketHolderPids: [daemon.pid, daemon.pid],
  }), { conditions: ["orphaned"] });
});

test("a distinct Desktop holder is attached", async () => {
  assert.deepEqual(await diagnose({
    processes: [daemon, desktop],
    socketHolderPids: [daemon.pid, daemon.pid, desktop.pid, desktop.pid],
  }), { conditions: ["attached"] });
});

test("Embassy self and descendants do not count as external holders", async () => {
  assert.deepEqual(await diagnose({
    processes: [
      daemon,
      { pid: embassyPid, parentPid: 1, executablePath: "/synthetic/embassy" },
      { pid: 101, parentPid: embassyPid, executablePath: "/synthetic/helper" },
      { pid: 102, parentPid: 101, executablePath: "/synthetic/helper-child" },
    ],
    socketHolderPids: [daemon.pid, embassyPid, 101, 102],
  }), { conditions: ["orphaned"] });
});

test("roles require exact executable-path and bundle evidence", async () => {
  const lookalikeDesktop = {
    ...desktop,
    executablePath: "/tmp/ChatGPT.app/Contents/MacOS/ChatGPT",
  };
  assert.deepEqual(await diagnose({
    processes: [daemon, lookalikeDesktop],
    socketHolderPids: [daemon.pid],
  }), { conditions: ["orphaned"] });

  assert.deepEqual(await diagnose({
    processes: [
      { ...daemon, executablePath: `${daemonExecutablePath}-old` },
      desktop,
    ],
    socketHolderPids: [daemon.pid],
  }), { conditions: ["unknown"] });

  assert.deepEqual(await diagnose({
    processes: [daemon, { ...desktop, bundleIdentifier: "com.openai.chatgpt" }],
    socketHolderPids: [daemon.pid, desktop.pid],
  }), { conditions: ["unknown"] });
});

test("ambiguous, failed, and oversized inspection degrades locally to unknown", async () => {
  assert.deepEqual(await diagnose({
    processes: [daemon, { pid: 400, parentPid: 1, executablePath: "/usr/bin/other" }],
    socketHolderPids: [daemon.pid, 400],
  }), { conditions: ["unknown"] });

  assert.deepEqual(await diagnose({
    processes: Array.from({ length: CODEX_DOCTOR_MAX_PROCESSES + 1 }, (_, index) => ({
      pid: index + 1,
      executablePath: `/synthetic/${index}`,
    })),
    socketHolderPids: [],
  }), { conditions: ["unknown"] });

  const secret = "RAW_INSPECTOR_OUTPUT_SENTINEL";
  const failed = await diagnoseCodexAttachment({
    socketPath,
    daemonExecutablePath,
    embassyPid,
    inspector: {
      async inspect() {
        throw new Error(secret);
      },
    },
  });
  assert.deepEqual(failed, { conditions: ["unknown"] });
  assert.equal(JSON.stringify(failed).includes(secret), false);
});
