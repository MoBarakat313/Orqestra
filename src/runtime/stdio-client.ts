import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export class ProtocolError extends Error {
  override name = 'ProtocolError';
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

export interface ClientOptions {
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  maxTotalBytes?: number;
  shutdownMs?: number;
  cwd?: string;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (request: ServerRequest) => Promise<unknown> | unknown;
  onFailure?: (error: Error) => void;
}

/** Bounded JSONL transport. Does not implement tools, authentication, or turns. */
export class StdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly exited: Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly maxMessageBytes: number;
  private readonly maxTotalBytes: number;
  private readonly shutdownMs: number;
  private readonly onNotification: ClientOptions['onNotification'];
  private readonly onServerRequest: ClientOptions['onServerRequest'];
  private readonly onFailure: ClientOptions['onFailure'];
  private readonly serverRequestIds = new Set<string>();
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;
  private nextId = 1;
  private buffer = '';
  private totalBytes = 0;

  constructor(command: string, args: string[], options: ClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
    this.maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 8 * 1024 * 1024;
    this.shutdownMs = options.shutdownMs ?? 300;
    this.onNotification = options.onNotification;
    this.onServerRequest = options.onServerRequest;
    this.onFailure = options.onFailure;
    for (const value of [this.requestTimeoutMs, this.maxMessageBytes, this.maxTotalBytes, this.shutdownMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new ProtocolError('Transport limits must be positive integers');
    }
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(options.cwd ? { cwd: options.cwd } : {}) });
    this.exited = new Promise(resolve => { this.child.once('close', () => resolve()); });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
    // Drain stderr, but never retain or expose account information or backend logs.
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.fail(new ProtocolError('Could not start the Codex App Server process')));
    this.child.stdin.on('error', () => this.fail(new ProtocolError('Codex App Server input stream closed')));
    this.child.stdout.on('error', () => this.fail(new ProtocolError('Codex App Server output stream failed')));
    this.child.once('close', (code, signal) => {
      this.fail(new ProtocolError(`Codex App Server exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`));
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new ProtocolError(`Codex request ${method} timed out`)), this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string): void {
    if (this.failure) throw this.failure;
    this.send({ method });
  }

  private send(message: unknown): void {
    try {
      this.child.stdin.write(JSON.stringify(message) + '\n', error => {
        if (error) this.fail(new ProtocolError('Could not write to Codex App Server'));
      });
    } catch {
      this.fail(new ProtocolError('Could not serialize or send a protocol message'));
    }
  }

  private receive(chunk: string): void {
    if (this.failure) return;
    this.totalBytes += Buffer.byteLength(chunk);
    if (this.totalBytes > this.maxTotalBytes) { this.fail(new ProtocolError('Codex output exceeded the session byte limit')); return; }
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.maxMessageBytes) { this.fail(new ProtocolError('Codex message exceeded the byte limit')); return; }
      if (line.trim()) this.acceptLine(line);
      if (this.failure) return;
    }
    if (Buffer.byteLength(this.buffer) > this.maxMessageBytes) this.fail(new ProtocolError('Codex message exceeded the byte limit'));
  }

  private acceptLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch { this.fail(new ProtocolError('Codex emitted malformed JSONL')); return; }
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        const id = message.id;
        if ((typeof id !== 'string' && typeof id !== 'number') || (typeof id === 'string' && !id)) {
          this.fail(new ProtocolError('Codex server request lacks a valid request ID'));
          return;
        }
        const key = `${typeof id}:${String(id)}`;
        if (this.serverRequestIds.has(key)) { this.fail(new ProtocolError('Codex repeated a server request ID')); return; }
        this.serverRequestIds.add(key);
        if (this.serverRequestIds.size > 1000) { this.fail(new ProtocolError('Codex exceeded the server request limit')); return; }
        if (!this.onServerRequest) {
          this.send({ id, error: { code: -32601, message: 'Orqestra client does not support this server request' } });
          this.fail(new ProtocolError('Codex requested an action unsupported by this client'));
          return;
        }
        void Promise.resolve(this.onServerRequest({ id, method: message.method, params: message.params }))
          .then(result => this.send({ id, result }))
          .catch(() => {
            this.send({ id, error: { code: -32000, message: 'Orqestra rejected the server request' } });
            this.fail(new ProtocolError('Orqestra could not resolve a Codex server request'));
          });
      } else {
        try { this.onNotification?.(message.method, message.params); }
        catch { this.fail(new ProtocolError('Orqestra notification handler failed')); }
      }
      return;
    }
    if (typeof message.id !== 'number') { this.fail(new ProtocolError('Codex response lacks a numeric request ID')); return; }
    const pending = this.pending.get(message.id);
    if (!pending) { this.fail(new ProtocolError('Codex response has an unknown or duplicate request ID')); return; }
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (hasResult === hasError) { this.fail(new ProtocolError('Codex response must contain exactly one result or error')); return; }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (hasError) {
      const error = message.error as { code?: unknown } | null;
      const code = error && typeof error.code === 'number' ? error.code : 'unknown';
      pending.reject(new ProtocolError(`Codex request ${pending.method} failed (RPC code ${code}); backend details were omitted`));
    } else pending.resolve(message.result);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    try { this.onFailure?.(error); } catch { /* The transport error remains authoritative. */ }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  /** Close pending work and bound graceful termination; idempotent. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.fail(new ProtocolError('Codex discovery connection closed'));
    this.closing = this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.child.stdin.end();
    await Promise.race([this.exited, delay(this.shutdownMs)]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      await Promise.race([this.exited, delay(this.shutdownMs)]);
    }
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    await Promise.race([this.exited, delay(this.shutdownMs)]);
  }
}
