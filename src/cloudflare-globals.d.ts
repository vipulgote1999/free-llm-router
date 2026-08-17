/**
 * Global Cloudflare runtime types used across src/ and test/.
 * Module-style file (needs export {} for `declare global`).
 */

declare global {
  interface DurableObjectId {
    toString(): string;
  }

  interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectStub;
    idFromString(id: string): DurableObjectStub;
    newUniqueId(): DurableObjectStub;
    get(id: DurableObjectId | DurableObjectStub): DurableObjectStub;
  }

  interface DurableObjectStub {
    fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
  }

  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException?(): void;
  }

  interface Ai {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  }

  type DurableObjectState =
    import('cloudflare:workers').DurableObjectState;
}

export {};
