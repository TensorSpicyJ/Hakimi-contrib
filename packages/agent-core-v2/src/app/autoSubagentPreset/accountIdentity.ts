/**
 * `autoSubagentPreset` domain — private effective-account identity and safe query attribution.
 *
 * Resolves model credential precedence from the actual model/provider registries.
 * Identity tokens are process-keyed HMACs: neither credentials nor reversible
 * concatenations leave this helper. Tokens are only for in-memory joins; public
 * evidence uses a configured canonical query-provider name, never these tokens.
 * Equivalent configured aliases also form the caller-verified local-ledger group;
 * this group describes current provider names, not an official account bill.
 */

import { createHmac, randomBytes } from 'node:crypto';
import {
  isManagedKimiCode, officialDeepSeekBalanceUrl, officialCodexUsageUrl, officialKimiCodeUsageUrl,
  OPENAI_CODEX_PROVIDER_NAME, OPENAI_CODEX_OAUTH_KEY, OPENAI_CODEX_ISSUER,
  resolveKimiCodeRuntimeAuth,
} from '@moonshot-ai/kimi-code-oauth';
import type { Model } from '#/kosong/model/catalog';
import type { IModelService } from '#/kosong/model/model';
import type { IProviderService, OAuthRef, ProviderConfig } from '#/kosong/provider/provider';
import { effectiveModelConfig, nonEmpty, resolveModelAuthMaterial } from '#/kosong/model/modelAuth';
import { explainProviderEndpoint } from '#/kosong/provider/providerDefinition';

export interface EffectiveAccount {
  readonly key: string;
  readonly queryProvider?: string;
  readonly providerAliases: readonly string[];
  readonly deepseek: boolean;
}

export function stableSnapshot(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).toSorted(([left], [right]) => left.localeCompare(right)));
  });
}

export class AccountIdentity {
  private readonly secret = randomBytes(32);

  fingerprint(value: unknown): string {
    return createHmac('sha256', this.secret).update(stableSnapshot(value)).digest('hex');
  }

  resolve(alias: string, model: Model, models: IModelService, providers: IProviderService): EffectiveAccount | undefined {
    const record = models.get(model.id ?? alias);
    if (record === undefined) return undefined;
    const providerId = record.providerId ?? record.provider ?? providers.getDefaultProvider();
    const provider = providerId === undefined ? undefined : providers.get(providerId);
    if (providerId !== undefined && (provider === undefined || providerId !== model.providerName)) return undefined;
    const effective = effectiveModelConfig(record, provider?.type ?? record.protocol);
    let key: string | undefined;
    try {
      const auth = resolveModelAuthMaterial({ modelId: model.id ?? alias, model: effective, provider, providerName: model.providerName });
      const oauth = auth.oauth === undefined ? undefined : this.runtimeOAuth(model.providerName, auth.oauth, provider);
      key = this.accountKey(model.baseUrl, auth.apiKey, oauth, provider?.customHeaders);
    } catch { return undefined; }
    if (key === undefined) return undefined;
    const deepseek = officialDeepSeekBalanceUrl(model.baseUrl) !== undefined;
    const ownQuery = providerId === undefined ? undefined : this.queryKey(providerId, provider);
    if (ownQuery !== key) return { key, deepseek, providerAliases: [] };
    const providerAliases = Object.keys(providers.list()).toSorted().filter((name) => this.queryKey(name, providers.get(name)) === key);
    return { key, deepseek, providerAliases, queryProvider: providerAliases[0] ?? providerId };
  }

  queryKey(name: string, provider: ProviderConfig | undefined): string | undefined {
    if (provider === undefined) return undefined;
    const endpoint = provider.type === undefined ? {} : explainProviderEndpoint(provider.type, provider.env ?? {});
    let baseUrl = nonEmpty(provider.baseUrl) ?? nonEmpty(endpoint.baseUrl);
    let apiKey: string | undefined;
    let oauth: OAuthRef | undefined;
    if (isManagedKimiCode(name)) {
      const runtime = resolveKimiCodeRuntimeAuth({ configuredBaseUrl: baseUrl, configuredOAuthRef: provider.oauth });
      baseUrl = runtime.baseUrl;
      oauth = runtime.oauthRef;
    } else if (name === OPENAI_CODEX_PROVIDER_NAME) {
      if (officialCodexUsageUrl(baseUrl) === undefined) return undefined;
      oauth = this.runtimeOAuth(name, provider.oauth, provider);
    } else {
      apiKey = nonEmpty(provider.apiKey) ?? nonEmpty(endpoint.apiKey);
    }
    return this.accountKey(baseUrl, apiKey, oauth);
  }

  private runtimeOAuth(name: string, reference: OAuthRef | undefined, provider: ProviderConfig | undefined): OAuthRef | undefined {
    if (isManagedKimiCode(name)) return resolveKimiCodeRuntimeAuth({ configuredBaseUrl: provider?.baseUrl, configuredOAuthRef: reference ?? provider?.oauth }).oauthRef;
    if (name === OPENAI_CODEX_PROVIDER_NAME) {
      const ref = reference ?? provider?.oauth;
      return {
        storage: ref?.storage === 'keyring' ? 'keyring' : 'file',
        key: ref?.key ?? OPENAI_CODEX_OAUTH_KEY,
        oauthHost: ref?.oauthHost ?? OPENAI_CODEX_ISSUER,
      };
    }
    return reference;
  }

  private accountKey(baseUrl: string | undefined, apiKey?: string, oauth?: OAuthRef, customHeaders?: Record<string, string>): string | undefined {
    if (apiKey === undefined && oauth === undefined) return undefined;
    if (customHeaders !== undefined && Object.keys(customHeaders).length > 0) return undefined;
    const endpoint = canonicalAccountEndpoint(baseUrl);
    if (endpoint === undefined) return undefined;
    return this.fingerprint({ endpoint, apiKey, oauth });
  }
}

function canonicalAccountEndpoint(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  if (officialDeepSeekBalanceUrl(baseUrl) !== undefined) return 'https://api.deepseek.com';
  if (officialCodexUsageUrl(baseUrl) !== undefined) return 'https://chatgpt.com/backend-api/codex';
  const kimiUsage = officialKimiCodeUsageUrl(baseUrl);
  if (kimiUsage !== undefined) return kimiUsage;
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href.replace(/\/+$/, '');
  } catch { return undefined; }
}
