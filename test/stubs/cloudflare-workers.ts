/** Minimal runtime stub for `cloudflare:workers` under Vitest. Typecheck uses the ambient declaration. */
export class DurableObject {
  protected readonly ctx: unknown;
  protected readonly env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
