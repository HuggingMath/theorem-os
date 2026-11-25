import { webPaperLimits } from './shared';
import type { WebPaperCompileInput, WebPaperCompileOutput, WebRunner } from './runner';

export class WebPaperPdfError extends Error {
  constructor(readonly code: string, readonly detail?: string, readonly file?: string, readonly line?: number) { super(code); }
}

/** Keeps PDF compilation bounded across all accounts in one web process. */
export class WebPaperPdf {
  private readonly active = new Set<AbortController>();

  constructor(private readonly runner: Pick<WebRunner, 'compilePaper'>) {}

  async compile(input: WebPaperCompileInput): Promise<WebPaperCompileOutput> {
    if (!this.runner.compilePaper) throw new WebPaperPdfError('paper_pdf_runtime_unavailable');
    if (Buffer.byteLength(input.template) + Buffer.byteLength(input.main) > webPaperLimits.maxSourceBytes)
      throw new WebPaperPdfError('paper_pdf_source_too_large');
    if (this.active.size >= webPaperLimits.maxConcurrent) throw new WebPaperPdfError('paper_pdf_busy');
    const controller = new AbortController();
    this.active.add(controller);
    try {
      const result = await this.runner.compilePaper(input, controller.signal);
      if (!Buffer.isBuffer(result.pdf) || result.pdf.length === 0 || result.pdf.length > webPaperLimits.maxPdfBytes ||
          result.pdf.subarray(0, 5).toString() !== '%PDF-') throw new WebPaperPdfError('paper_pdf_missing_output');
      return result;
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code
        : error instanceof Error && /^paper_pdf_[a-z_]+$/u.test(error.message) ? error.message : undefined;
      if (code) {
        const diagnostic = error as Error & { detail?: string; file?: string; line?: number };
        throw new WebPaperPdfError(code, diagnostic.detail, diagnostic.file, diagnostic.line);
      }
      throw error;
    }
    finally { this.active.delete(controller); }
  }

  close(): void {
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
}
