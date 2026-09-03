// =============================================================================
// Port Listen Fallback — prefer a fixed port, fall back to OS-assigned on EADDRINUSE
// The root cause of "already started": a second instance hard-crashes when the
// first already bound a fixed port. With this helper every listener survives a
// collision by silently moving to a free port, and the caller learns the real
// port via onPort.
// =============================================================================

import type { Server } from "node:http";

export interface ListenFallbackOptions {
  name: string;
  host?: string; // default: all interfaces (like the plain listen() calls being replaced)
  onPort?: (actualPort: number) => void;
}

/** Read the actual bound port from a listening server. */
export function actualPort(server: Server, fallback: number): number {
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : fallback;
}

/**
 * Start `server` on `preferredPort`. If that port is taken (EADDRINUSE — e.g. a
 * second Ouroboros instance), bind to an OS-assigned free port instead.
 * `opts.onPort(actualPort)` is invoked once the server is listening with the
 * REAL port. The error handler is removed on success so later runtime errors
 * still surface.
 */
export function listenFallback(
  server: Server,
  preferredPort: number,
  opts: ListenFallbackOptions,
): void {
  const { name, host, onPort } = opts;
  const start = (port: number, cb: () => void) => {
    if (host) server.listen(port, host, cb);
    else server.listen(port, cb);
  };
  const onError = (err: NodeJS.ErrnoException) => {
    if (err && err.code === "EADDRINUSE") {
      server.removeListener("error", onError);
      start(0, () => {
        const p = actualPort(server, preferredPort);
        process.stderr.write(`[${name}] port ${preferredPort} busy — using :${p}\n`);
        onPort?.(p);
      });
    } else {
      // Non-contention error — fail loudly so the operator sees it.
      throw err;
    }
  };
  server.on("error", onError);
  start(preferredPort, () => {
    server.removeListener("error", onError);
    onPort?.(actualPort(server, preferredPort));
  });
}
