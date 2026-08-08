import { createHash } from "node:crypto";

import {
  buildDashboardViewModel,
  type DashboardViewModel,
} from "./dashboard-model.js";
import { LIVE_DASHBOARD_LIMITS } from "./live-dashboard-protocol.js";
import type { GatewayPublicSnapshot } from "./types.js";

export type LiveDashboardSnapshotRevision = string | number;

export type LiveDashboardObservation = Readonly<{
  snapshotRevision: LiveDashboardSnapshotRevision;
  snapshot: GatewayPublicSnapshot;
}>;

export type LiveDashboardObserver = Readonly<{
  observe(): Promise<LiveDashboardObservation>;
}>;

export type LiveDashboardClock = Readonly<{
  now(): number;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}>;

export const defaultLiveDashboardClock: LiveDashboardClock = {
  now: Date.now,
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export type LiveDashboardStreamWriter = Readonly<{
  write(chunk: string): boolean;
  onDrain(callback: () => void): void;
  onClose(callback: () => void): void;
  end(): void;
}>;

export type LiveDashboardStreamEvent = Readonly<{
  streamRevision: number;
  snapshotRevision: LiveDashboardSnapshotRevision;
  reset: boolean;
  model: DashboardViewModel;
}>;

type StreamState = {
  writer: LiveDashboardStreamWriter;
  blockedAt?: number;
  queued?: string;
  lastEmissionAt: number;
  closed: boolean;
};

type LatestSnapshot = Readonly<{
  event: LiveDashboardStreamEvent;
  fingerprint: string;
}>;

export type LiveDashboardStreamHub = Readonly<{
  add(writer: LiveDashboardStreamWriter):
    | Readonly<{ ok: true; close(): void }>
    | Readonly<{ ok: false; safeCode: "LIVE_STREAM_LIMIT" }>;
  latest(): LiveDashboardStreamEvent | undefined;
  pollNow(): Promise<void>;
  refresh(): Promise<LiveDashboardStreamEvent | undefined>;
  shutdown(): void;
  streamCount(): number;
}>;

function normalizeRevision(
  revision: LiveDashboardSnapshotRevision,
): LiveDashboardSnapshotRevision {
  if (
    typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision >= 0
  ) {
    return revision;
  }
  if (
    typeof revision === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(revision)
  ) {
    return revision;
  }
  throw new Error("LIVE_DASHBOARD_REVISION_INVALID");
}

function fingerprint(model: DashboardViewModel): string {
  // Queue ages and generatedAt advance even when the broker's public semantics
  // have not changed. Excluding only those derived clock fields mirrors the
  // gateway's process-local snapshot revision contract while retaining a
  // second, independently normalized restart/reset signal.
  const semanticModel = {
    ...model,
    generatedAt: undefined,
    exchange: {
      ...model.exchange,
      oldestQueueAgeMs: undefined,
    },
    transit: {
      ...model.transit,
      oldestQueueAgeMs: undefined,
    },
    routes: model.routes.map((route) => ({
      ...route,
      queueAgeMs: undefined,
    })),
  };
  return createHash("sha256")
    .update(JSON.stringify(semanticModel))
    .digest("hex");
}

function isRevisionReset(
  previous: LiveDashboardSnapshotRevision,
  next: LiveDashboardSnapshotRevision,
  fingerprintChanged: boolean,
): boolean {
  if (previous === next) return fingerprintChanged;
  return (
    typeof previous === "number" &&
    typeof next === "number" &&
    next < previous
  );
}

function snapshotFrame(event: LiveDashboardStreamEvent): string {
  return `id: ${event.streamRevision}\nevent: snapshot\ndata: ${JSON.stringify(event)}\n\n`;
}

function unavailableFrame(): string {
  return "event: observer_unavailable\ndata: {\"safeCode\":\"LIVE_OBSERVER_UNAVAILABLE\"}\n\n";
}

export function createLiveDashboardStreamHub(
  options: Readonly<{
    observer: LiveDashboardObserver;
    clock?: LiveDashboardClock;
  }>,
): LiveDashboardStreamHub {
  const clock = options.clock ?? defaultLiveDashboardClock;
  const streams = new Set<StreamState>();
  let interval: unknown | undefined;
  let pollInFlight: Promise<LiveDashboardStreamEvent | undefined> | undefined;
  let latest: LatestSnapshot | undefined;
  let previousSourceRevision: LiveDashboardSnapshotRevision | undefined;
  let streamRevision = 0;
  let observerUnavailable = false;
  let stopped = false;

  const closeStream = (stream: StreamState): void => {
    if (stream.closed) return;
    stream.closed = true;
    streams.delete(stream);
    delete stream.queued;
    try {
      stream.writer.end();
    } catch {
      // Closing a disconnected browser is best effort.
    }
    if (streams.size === 0 && interval !== undefined) {
      clock.clearInterval(interval);
      interval = undefined;
    }
  };

  const flush = (stream: StreamState, frame: string): void => {
    if (stream.closed) return;
    const now = clock.now();
    if (stream.blockedAt !== undefined) {
      if (
        now - stream.blockedAt >=
        LIVE_DASHBOARD_LIMITS.backpressureTimeoutMs
      ) {
        closeStream(stream);
        return;
      }
      stream.queued = frame;
      return;
    }
    try {
      const accepted = stream.writer.write(frame);
      stream.lastEmissionAt = now;
      if (!accepted) stream.blockedAt = now;
    } catch {
      closeStream(stream);
    }
  };

  const broadcast = (frame: string): void => {
    for (const stream of [...streams]) flush(stream, frame);
  };

  const tickMaintenance = (): void => {
    const now = clock.now();
    for (const stream of [...streams]) {
      if (
        stream.blockedAt !== undefined &&
        now - stream.blockedAt >=
          LIVE_DASHBOARD_LIMITS.backpressureTimeoutMs
      ) {
        closeStream(stream);
        continue;
      }
      if (
        stream.blockedAt === undefined &&
        now - stream.lastEmissionAt >=
          LIVE_DASHBOARD_LIMITS.heartbeatIntervalMs
      ) {
        flush(stream, `: heartbeat ${now}\n\n`);
      }
    }
  };

  const performPoll = async (
    allowWithoutStreams: boolean,
  ): Promise<LiveDashboardStreamEvent | undefined> => {
    if (stopped || (!allowWithoutStreams && streams.size === 0)) return undefined;
    try {
      const observed = await options.observer.observe();
      if (stopped) return undefined;
      const nextRevision = normalizeRevision(observed.snapshotRevision);
      const model = buildDashboardViewModel(observed.snapshot);
      const nextFingerprint = fingerprint(model);
      const changed = latest?.fingerprint !== nextFingerprint;
      const reset =
        observerUnavailable ||
        (previousSourceRevision !== undefined &&
          isRevisionReset(previousSourceRevision, nextRevision, changed));
      const shouldPublish = latest === undefined || changed || reset;
      previousSourceRevision = nextRevision;
      observerUnavailable = false;
      if (shouldPublish) {
        streamRevision += 1;
        const event: LiveDashboardStreamEvent = {
          streamRevision,
          snapshotRevision: nextRevision,
          reset,
          model,
        };
        latest = { event, fingerprint: nextFingerprint };
        broadcast(snapshotFrame(event));
      }
      return latest?.event;
    } catch {
      if (!observerUnavailable) {
        observerUnavailable = true;
        broadcast(unavailableFrame());
      }
      return undefined;
    }
  };

  const requestPoll = (
    allowWithoutStreams: boolean,
  ): Promise<LiveDashboardStreamEvent | undefined> => {
    if (pollInFlight !== undefined) return pollInFlight;
    pollInFlight = performPoll(allowWithoutStreams).finally(() => {
      pollInFlight = undefined;
    });
    return pollInFlight;
  };

  const pollNow = async (): Promise<void> => {
    if (stopped || streams.size === 0) return;
    await requestPoll(false);
  };

  const startPolling = (): void => {
    if (interval !== undefined || stopped || streams.size === 0) return;
    interval = clock.setInterval(() => {
      tickMaintenance();
      void pollNow();
    }, LIVE_DASHBOARD_LIMITS.pollIntervalMs);
    void pollNow();
  };

  return {
    add: (writer) => {
      if (stopped || streams.size >= LIVE_DASHBOARD_LIMITS.maximumStreams) {
        return { ok: false, safeCode: "LIVE_STREAM_LIMIT" };
      }
      const stream: StreamState = {
        writer,
        lastEmissionAt: clock.now(),
        closed: false,
      };
      streams.add(stream);
      writer.onDrain(() => {
        if (stream.closed || stream.blockedAt === undefined) return;
        delete stream.blockedAt;
        const queued = stream.queued;
        delete stream.queued;
        if (queued !== undefined) flush(stream, queued);
      });
      writer.onClose(() => closeStream(stream));
      if (latest !== undefined) flush(stream, snapshotFrame(latest.event));
      startPolling();
      return { ok: true, close: () => closeStream(stream) };
    },
    latest: () => latest?.event,
    pollNow,
    refresh: async () => await requestPoll(true),
    shutdown: () => {
      if (stopped) return;
      stopped = true;
      if (interval !== undefined) {
        clock.clearInterval(interval);
        interval = undefined;
      }
      broadcast("event: shutdown\ndata: {\"safeCode\":\"LIVE_DASHBOARD_SHUTDOWN\"}\n\n");
      for (const stream of [...streams]) closeStream(stream);
    },
    streamCount: () => streams.size,
  };
}
