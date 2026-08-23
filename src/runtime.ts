/**
 * Runtime config loader — bridges the pure registry (config.ts) with the
 * persistent VaultDO store. This module is allowed to touch Cloudflare
 * globals; all merge logic stays in applyRuntimeOverrides (pure, tested).
 */

import {
  applyRuntimeOverrides,
  getProviders,
  type RuntimeConfig,
} from './config';
import type { ProviderConfig } from './types';

interface LoaderEnv {
  VAULT?: DurableObjectNamespace;
  [key: string]: unknown;
}

export async function loadRuntimeConfig(
  env: LoaderEnv,
): Promise<RuntimeConfig | undefined> {
  if (!env.VAULT) return undefined;
  try {
    const stub = env.VAULT.get(env.VAULT.idFromName('vault:global'));
    const res = await stub.fetch('https://vault/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'getConfig' }),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { config?: RuntimeConfig };
    if (!data.config || typeof data.config !== 'object') return undefined;
    return data.config;
  } catch {
    return undefined; // vault down → run on static registry
  }
}

/** Static registry + admin overrides. One vault round-trip per call. */
export async function getEffectiveProviders(
  env: LoaderEnv,
): Promise<ProviderConfig[]> {
  const overrides = await loadRuntimeConfig(env);
  return applyRuntimeOverrides(getProviders(env), overrides);
}
