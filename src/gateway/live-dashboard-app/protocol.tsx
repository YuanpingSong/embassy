// Session exchange + SSE-over-fetch + connection FSM.
//
// Port of the proven vanilla client (live-dashboard-assets.ts client()) with
// byte-for-byte request/parse semantics: capability exchange from the URL
// fragment, POST-based SSE (EventSource cannot send POST or the
// X-Embassy-Request header), CRLF normalization, double-newline block split,
// 1 MiB buffer cap, and the six-state connection FSM. Spec additions (§1.6,
// deviation R6): a 35 s heartbeat watchdog while connected, bounded
// auto-reconnect (5 s delay, max 3 attempts, only from "disconnected"), and
// streamRevision gap detection that raises a missed-frames notice and fires
// one recovery snapshot read.
namespace Embassy {
  const HEARTBEAT_WATCHDOG_MS = 35_000;
  const AUTO_RECONNECT_DELAY_MS = 5_000;
  const MAX_AUTO_RECONNECT_ATTEMPTS = 3;
  const MAX_STREAM_BUFFER_LENGTH = 1_048_576;

  export type ProtocolNoticeKind = "missedFrames" | "reset";

  export type ProtocolOptions = Readonly<{
    onEvent: (event: LiveDashboardStreamEvent) => void;
    onConnectionState: (state: ConnectionState) => void;
    onNotice?: (kind: ProtocolNoticeKind) => void;
  }>;

  export type Protocol = Readonly<{
    start: () => void;
    pause: () => void;
    reconnect: () => void;
    readNow: () => void;
  }>;

  type ApiFetchOptions = Readonly<{
    headers?: Readonly<Record<string, string>>;
    body?: string;
    signal?: AbortSignal;
  }>;

  type FrameSource = "stream" | "snapshot";

  export function createProtocol(options: ProtocolOptions): Protocol {
    // Same base derivation as the vanilla client: the app is served from
    // <instancePath>/bootstrap and all API routes are siblings.
    const base = location.pathname.endsWith("/bootstrap")
      ? location.pathname.slice(0, -10)
      : location.pathname.endsWith("/")
        ? location.pathname.slice(0, -1)
        : location.pathname;
    const api = (name: string): string => base + "/" + name;

    let connectionState: ConnectionState = "connecting";
    let controller: AbortController | undefined;
    let watchdogTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let reconnectAttempts = 0;
    let lastStreamRevision: number | undefined;
    let gapRecoveryInFlight = false;

    function apiFetch(name: string, fetchOptions: ApiFetchOptions = {}): Promise<Response> {
      const init: RequestInit = {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-Embassy-Request": "1", ...(fetchOptions.headers ?? {}) },
      };
      if (fetchOptions.body !== undefined) {
        init.body = fetchOptions.body;
      }
      if (fetchOptions.signal !== undefined) {
        init.signal = fetchOptions.signal;
      }
      return fetch(api(name), init);
    }

    function notify(kind: ProtocolNoticeKind): void {
      options.onNotice?.(kind);
    }

    function setConnectionState(next: ConnectionState): void {
      connectionState = next;
      if (next === "connected") {
        reconnectAttempts = 0;
      }
      options.onConnectionState(next);
      if (next === "disconnected") {
        scheduleAutoReconnect();
      }
    }

    function clearWatchdog(): void {
      if (watchdogTimer !== undefined) {
        window.clearTimeout(watchdogTimer);
        watchdogTimer = undefined;
      }
    }

    // Re-armed on every received chunk (data and heartbeat comments alike).
    // Fires only while "connected": a silent connection is no longer live, so
    // it is torn down and the FSM moves to "disconnected" (which schedules a
    // bounded auto-reconnect).
    function armWatchdog(current: AbortController): void {
      clearWatchdog();
      watchdogTimer = window.setTimeout(() => {
        watchdogTimer = undefined;
        if (connectionState !== "connected" || controller !== current) {
          return;
        }
        current.abort();
        setConnectionState("disconnected");
      }, HEARTBEAT_WATCHDOG_MS);
    }

    function clearReconnectTimer(): void {
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
    }

    // Bounded: at most MAX_AUTO_RECONNECT_ATTEMPTS automatic retries, only
    // ever from "disconnected" (never from "paused"/"stopped"), re-checked at
    // fire time. The counter resets on a successful connection or a manual
    // reconnect; once exhausted, recovery is manual only.
    function scheduleAutoReconnect(): void {
      if (reconnectTimer !== undefined || reconnectAttempts >= MAX_AUTO_RECONNECT_ATTEMPTS) {
        return;
      }
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        if (connectionState !== "disconnected") {
          return;
        }
        reconnectAttempts += 1;
        void connect();
      }, AUTO_RECONNECT_DELAY_MS);
    }

    // Deliver a frame (identical shape from the stream and /snapshot). A
    // streamRevision jumping past last+1 means frames were dropped: raise the
    // missed-frames notice and fire one recovery readNow — only for
    // stream-sourced gaps (a snapshot response already is the freshest state)
    // and never while a recovery read is in flight.
    function ingest(event: LiveDashboardStreamEvent, source: FrameSource): void {
      const previous = lastStreamRevision;
      const gap = previous !== undefined && event.streamRevision > previous + 1;
      lastStreamRevision = event.streamRevision;
      options.onEvent(event);
      if (event.reset) {
        notify("reset");
      }
      if (gap) {
        notify("missedFrames");
        if (source === "stream" && !gapRecoveryInFlight) {
          gapRecoveryInFlight = true;
          void fetchSnapshotNow().finally(() => {
            gapRecoveryInFlight = false;
          });
        }
      }
    }

    async function exchangeCapability(): Promise<void> {
      const capability = location.hash.slice(1);
      if (!capability) {
        return;
      }
      history.replaceState(null, "", location.pathname);
      const response = await apiFetch("session", {
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: capability,
      });
      if (!response.ok) {
        throw new Error("session");
      }
    }

    function consumeSseBlock(block: string): void {
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        }
        if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
        }
      }
      // Comment lines (heartbeats) match neither prefix and fall through.
      if (event === "snapshot" && data.length > 0) {
        const parsed = JSON.parse(data.join("\n")) as LiveDashboardStreamEvent;
        setConnectionState("connected");
        ingest(parsed, "stream");
      } else if (event === "observer_unavailable") {
        setConnectionState("unavailable");
      } else if (event === "shutdown") {
        setConnectionState("stopped");
      }
    }

    async function connect(): Promise<void> {
      if (controller) {
        controller.abort();
      }
      const current = new AbortController();
      controller = current;
      setConnectionState("connecting");
      try {
        const response = await apiFetch("stream", { signal: current.signal });
        if (!response.ok || !response.body) {
          throw new Error("stream");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        armWatchdog(current);
        while (true) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          armWatchdog(current);
          buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
          if (buffer.length > MAX_STREAM_BUFFER_LENGTH) {
            throw new Error("frame");
          }
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            consumeSseBlock(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
          }
        }
        if (!current.signal.aborted && connectionState !== "stopped") {
          setConnectionState("disconnected");
        }
      } catch {
        if (!current.signal.aborted) {
          setConnectionState("disconnected");
        }
      } finally {
        clearWatchdog();
      }
    }

    async function fetchSnapshotNow(): Promise<void> {
      try {
        const response = await apiFetch("snapshot");
        if (response.ok) {
          const event = (await response.json()) as LiveDashboardStreamEvent;
          ingest(event, "snapshot");
        } else {
          setConnectionState(connectionState === "connected" ? "unavailable" : "disconnected");
        }
      } catch {
        setConnectionState(connectionState === "connected" ? "unavailable" : "disconnected");
      }
    }

    async function start(): Promise<void> {
      try {
        await exchangeCapability();
      } catch {
        // The vanilla client rendered a fatal notice here; the FSM has no
        // fatal state, so surface it as "disconnected" (bounded auto-retries
        // apply, then manual only).
        setConnectionState("disconnected");
        return;
      }
      await connect();
    }

    return {
      start: (): void => {
        void start();
      },
      pause: (): void => {
        clearReconnectTimer();
        if (controller) {
          controller.abort();
        }
        setConnectionState("paused");
      },
      reconnect: (): void => {
        clearReconnectTimer();
        reconnectAttempts = 0;
        void connect();
      },
      readNow: (): void => {
        void fetchSnapshotNow();
      },
    };
  }
}
