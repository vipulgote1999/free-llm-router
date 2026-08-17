/**
 * Ambient module for the 'cloudflare:workers' runtime import.
 * Script-style file (no imports/exports) so the ambient declaration applies.
 */

declare module 'cloudflare:workers' {
  export class DurableObject<
    R extends DurableObjectState = DurableObjectState,
  > {
    constructor(ctx: DurableObjectState, env: unknown);
    readonly ctx: R;
    readonly env: unknown;
    fetch?(request: Request): Response | Promise<Response>;
    alarm?(): void | Promise<void>;
  }

  export interface DurableObjectState {
    readonly id: DurableObjectId;
    readonly storage: DurableObjectStorage;
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  }

  export interface DurableObjectStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    list<T = unknown>(): Promise<Map<string, T>>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): Promise<void>;
  }
}
