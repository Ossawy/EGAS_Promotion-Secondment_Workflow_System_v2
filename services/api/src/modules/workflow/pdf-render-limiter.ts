import { AppError } from '../../shared/errors.ts'

/** Bounded async render gate; timeout releases capacity even when a renderer hangs. */
export class PdfRenderLimiter {
  private running = 0
  private readonly waiting: Array<() => void> = []
  constructor(private readonly maxConcurrent: number, private readonly maxQueued: number, private readonly timeoutMs: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent && this.waiting.length >= this.maxQueued) {
      throw new AppError(503, 'PDF rendering capacity is temporarily unavailable', 'PDF_RENDER_BUSY')
    }
    if (this.running >= this.maxConcurrent) await new Promise<void>(resolve => this.waiting.push(resolve))
    this.running++
    try {
      return await Promise.race([
        work(),
        new Promise<T>((_, reject) => setTimeout(() => reject(new AppError(503, 'PDF rendering timed out', 'PDF_RENDER_TIMEOUT')), this.timeoutMs))
      ])
    } finally {
      this.running--
      this.waiting.shift()?.()
    }
  }
}
