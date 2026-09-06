import { runTui } from "../../src/gateway/tui.js";
import { tuiDesignFixture } from "./tui-design-fixtures.js";

// Synthetic operator session: real Ink, stdin and terminal; no broker/provider I/O.
const local = tuiDesignFixture("endpoints").snapshot!;
const remote = tuiDesignFixture("remote-selected").snapshot!;
const call = async (snapshot: typeof local, method: string) => {
  if (method === "list_snapshot") return snapshot;
  if (method === "check" || method === "refresh_discovery") await new Promise((done) => setTimeout(done, 200));
  if (method === "check") return { status: "ok", scope: "broker-loopback" };
  if (method === "retire_route") return { cancelled: 2, ambiguous: 1, unconfirmed: 0 };
  if (method === "delivery_status") return { found: true, state: "delivered", terminal: true, safeErrorCode: "DELIVERED" };
  return { routes: snapshot.routes };
};
await runTui({ input: process.stdin, output: process.stdout, host: "m5dev",
  call: (command) => call(local, command.method), renderStatus: () => "plain synthetic status\n",
  remote: { hosts: ["this-mac"], call: (_host, command) => call(remote, command.method), close: () => {} } });
