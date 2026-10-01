/** Retained-window collector from 639ed015's output.ts, without spill I/O. */
export class RetainedCollector {
  private chunks: Buffer[] = []
  private bytes = 0
  private total = 0

  /** @param maxBytes - byte-exact retained window cap. */
  constructor(private readonly maxBytes = 64_000) {}

  /**
   * Exact upstream push retention logic; chunking must not change the window.
   * @param chunk - observed stream bytes.
   */
  push(chunk: Buffer): void {
    this.total += chunk.length
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.bytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.bytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
    }
  }

  /**
   * Exact upstream readFrom logic, including independent slice UTF-8 decoding.
   * @param fromByte - absolute byte offset.
   * @returns retained decoded delta and absolute next offset.
   */
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } {
    const windowStart = this.total - this.bytes
    const buffer = Buffer.concat(this.chunks)
    const lossy = fromByte < windowStart
    const slice = lossy ? buffer : buffer.subarray(fromByte - windowStart)
    return { text: slice.toString('utf8'), nextOffset: this.total, lossy }
  }
}
