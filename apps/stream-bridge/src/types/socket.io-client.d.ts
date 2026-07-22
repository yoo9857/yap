/* Minimal ambient types for socket.io-client v2 (no bundled/@types needed).
 * Only the surface the Twip adapter uses. */
declare module "socket.io-client" {
  interface Socket {
    on(event: string, cb: (...args: unknown[]) => void): Socket;
    emit(event: string, ...args: unknown[]): Socket;
    close(): void;
    connected: boolean;
  }
  interface ConnectOpts {
    query?: Record<string, string>;
    transports?: string[];
    path?: string;
    reconnection?: boolean;
    forceNew?: boolean;
    timeout?: number;
  }
  function io(uri: string, opts?: ConnectOpts): Socket;
  export default io;
  export { io };
  export type { Socket };
}
