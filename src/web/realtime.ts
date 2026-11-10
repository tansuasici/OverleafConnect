// A short-lived connection to Overleaf's real-time service: join the project, join one document, apply one update,
// leave. No vscode import, so it is tested with plain mocha and a fake socket.

import WebSocket from 'ws';
import { ackError, DISCONNECT_FRAME, eventFrame, HEARTBEAT_FRAME, parseFrame } from './webModel';

/** The few things this extension needs from a WebSocket. */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: (error?: Error) => void): void;
}

/** Opens a socket to `url` with `headers`; the caller guarantees the URL is on the signed-in server. */
export type SocketFactory = (url: string, headers: Record<string, string>) => Promise<RealtimeSocket>;

/** A failure the real-time service reported, or a connection that ended or stalled. */
export class RealtimeError extends Error {}

const TIMEOUT_MS = 20000;

export class RealtimeConnection {
  private nextId = 1;
  private readonly acks = new Map<number, { resolve: (args: unknown[]) => void; reject: (e: Error) => void }>();
  private joined?: { resolve: (project: unknown) => void; reject: (e: Error) => void };
  private joinedProject?: unknown;
  private readonly waiters: { name: string; match: (args: unknown[]) => boolean; resolve: (args: unknown[]) => void; reject: (e: Error) => void }[] = [];
  /** This connection's id, which Overleaf puts in `meta.source` of the updates it sent. */
  publicId?: string;
  private failure?: Error;
  private closed = false;

  constructor(
    private readonly socket: RealtimeSocket,
    private readonly timeoutMs = TIMEOUT_MS
  ) {
    socket.onMessage((data) => this.receive(data));
    socket.onClose((error) => this.fail(error ? new RealtimeError(`The connection to Overleaf closed: ${error.message}`) : new RealtimeError('The connection to Overleaf closed.')));
  }

  /** The project tree Overleaf sends once it has accepted the connection. */
  project(): Promise<unknown> {
    if (this.joinedProject !== undefined) {
      return Promise.resolve(this.joinedProject);
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return this.withTimeout(new Promise((resolve, reject) => (this.joined = { resolve, reject })), 'joining the project');
  }

  /** Emits `name` and resolves with the acknowledgement's arguments; an error in the first one rejects. */
  async call(name: string, args: unknown[]): Promise<unknown[]> {
    if (this.failure) {
      throw this.failure;
    }
    const id = this.nextId++;
    const answer = new Promise<unknown[]>((resolve, reject) => this.acks.set(id, { resolve, reject }));
    this.socket.send(eventFrame(id, name, args));
    const result = await this.withTimeout(answer, name);
    const error = ackError(result[0]);
    if (error) {
      throw new RealtimeError(error);
    }
    return result.slice(1);
  }

  /** Resolves with the arguments of the next `name` event that `match` accepts. Set it up before causing the event. */
  waitFor(name: string, match: (args: unknown[]) => boolean, what: string): Promise<unknown[]> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    let waiter: (typeof this.waiters)[number] | undefined;
    const event = new Promise<unknown[]>((resolve, reject) => {
      waiter = { name, match, resolve, reject };
      this.waiters.push(waiter);
    });
    return this.withTimeout(event, what).finally(() => {
      const i = this.waiters.indexOf(waiter!);
      if (i >= 0) {
        this.waiters.splice(i, 1);
      }
    });
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        this.socket.send(DISCONNECT_FRAME);
      } catch {
        // Closing anyway.
      }
      this.socket.close();
    }
    this.fail(new RealtimeError('The connection to Overleaf closed.'));
  }

  private receive(data: string): void {
    const frame = parseFrame(data);
    switch (frame.kind) {
      case 'heartbeat':
        this.socket.send(HEARTBEAT_FRAME);
        return;
      case 'event':
        if (frame.name === 'joinProjectResponse') {
          const response = frame.args[0] as { project?: unknown; publicId?: unknown } | undefined;
          this.publicId = typeof response?.publicId === 'string' ? response.publicId : undefined;
          this.joinedProject = response?.project ?? null;
          this.joined?.resolve(this.joinedProject);
          this.joined = undefined;
        } else if (frame.name === 'connectionRejected') {
          this.fail(new RealtimeError(`Overleaf refused the connection: ${ackError(frame.args[0]) ?? 'no reason given'}.`));
        } else if (frame.name === 'otUpdateError') {
          this.fail(new RealtimeError(`Overleaf rejected the change: ${ackError(frame.args[0]) ?? 'no reason given'}.`));
        } else {
          const name = frame.name;
          const args = frame.args;
          this.waiters.filter((w) => w.name === name && w.match(args)).forEach((w) => w.resolve(args));
        }
        return;
      case 'ack': {
        const pending = this.acks.get(frame.id);
        this.acks.delete(frame.id);
        pending?.resolve(frame.args);
        return;
      }
      case 'error':
        this.fail(new RealtimeError(`Overleaf's real-time service answered with an error (${frame.reason || 'unknown'}).`));
        return;
      case 'disconnect':
        this.fail(new RealtimeError('Overleaf closed the connection.'));
        return;
    }
  }

  private fail(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    this.joined?.reject(error);
    this.joined = undefined;
    this.acks.forEach((a) => a.reject(error));
    this.acks.clear();
    this.waiters.splice(0).forEach((w) => w.reject(error));
  }

  private withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RealtimeError(`Overleaf did not answer in time (${what}).`)), this.timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}

/** The default socket: the `ws` package. Messages that arrive before a listener is set are kept for it. */
export const wsSocketFactory: SocketFactory = async (url, headers) => {
  const ws = new WebSocket(url, { headers, followRedirects: false, handshakeTimeout: TIMEOUT_MS });
  const early: string[] = [];
  let deliver: ((data: string) => void) | undefined;
  ws.on('message', (data) => (deliver ? deliver(data.toString()) : early.push(data.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(new RealtimeError(`Could not connect to Overleaf's real-time service: ${e.message}`)));
    ws.once('unexpected-response', (_req, res) => reject(new RealtimeError(`Overleaf's real-time service answered HTTP ${res.statusCode}.`)));
  });
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onMessage: (listener) => {
      deliver = listener;
      early.splice(0).forEach(listener);
    },
    onClose: (listener) => {
      ws.on('close', () => listener());
      ws.on('error', (e) => listener(e));
    },
  };
};
