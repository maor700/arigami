// The wire format between the host's launcher and the sandbox sidecar's agent (sidecar-agent.ts): after one JSON
// header line, frames of [type: 1 byte][length: 4 bytes, big endian][payload]. No imports: both sides load it.
export const FRAME = {
  STDIN: 1, // host → agent
  STDIN_END: 2, // host → agent
  SIGNAL: 3, // host → agent, payload = signal name
  STDOUT: 11, // agent → host
  STDERR: 12, // agent → host
  EXIT: 13, // agent → host, payload = {"code":…, "signal":…}
  ERROR: 14, // agent → host, payload = why the engine could not start
} as const;

export function encodeFrame(type: number, payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  push(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
  }
  /** Every complete frame received so far. */
  drain(): { type: number; payload: Buffer }[] {
    const out: { type: number; payload: Buffer }[] = [];
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      out.push({ type: this.buf.readUInt8(0), payload: this.buf.subarray(5, 5 + len) });
      this.buf = this.buf.subarray(5 + len);
    }
    return out;
  }
}
