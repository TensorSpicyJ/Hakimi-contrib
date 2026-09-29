import { beforeEach, describe, expect, it } from 'vitest';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import {
  IBootstrapService,
  bootstrap,
  bootstrapSeed,
  resolveBootstrapOptions,
} from '#/app/bootstrap/bootstrap';
import { BootstrapService } from '#/app/bootstrap/bootstrapService';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubClientIdentity } from './stubs';

describe('BootstrapService (scoped)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IBootstrapService,
      BootstrapService,
      ScopeActivation.OnScopeCreated,
      'bootstrap',
    );
  });

  it('resolves homeDir/configPath from the seeded context token', () => {
    const host = createScopedTestHost(
      bootstrapSeed({ homeDir: '/tmp/kimi-home', clientIdentity: stubClientIdentity }),
    );
    const svc = host.app.accessor.get(IBootstrapService);
    expect(svc.homeDir).toBe('/tmp/kimi-home');
    expect(svc.configPath).toBe('/tmp/kimi-home/config.toml');
    expect(svc.scope('sessions')).toBe('sessions');
    host.dispose();
  });

  it('exposes the seeded client identity', () => {
    const host = createScopedTestHost(
      bootstrapSeed({ homeDir: '/tmp/kimi-home', clientIdentity: stubClientIdentity }),
    );
    const svc = host.app.accessor.get(IBootstrapService);
    expect(svc.clientIdentity).toEqual(stubClientIdentity);
    host.dispose();
  });

  it('getEnv reads from the seeded env bag', () => {
    const host = createScopedTestHost(
      bootstrapSeed({ env: { FOO: 'bar' }, clientIdentity: stubClientIdentity }),
    );
    const svc = host.app.accessor.get(IBootstrapService);
    expect(svc.getEnv('FOO')).toBe('bar');
    expect(svc.getEnv('MISSING')).toBeUndefined();
    host.dispose();
  });
});

describe('resolveBootstrapOptions', () => {
  it.each([
    { homeDir: '/explicit', env: { HAKIMI_HOME: '/hakimi', KIMI_CODE_HOME: '/legacy' }, expected: '/explicit' },
    { homeDir: undefined, env: { HAKIMI_HOME: '/hakimi', KIMI_CODE_HOME: '/legacy' }, expected: '/hakimi' },
    { homeDir: undefined, env: { KIMI_CODE_HOME: '/legacy' }, expected: '/legacy' },
    { homeDir: undefined, env: {}, expected: '/users/example/.hakimi' },
  ])('resolves config under $expected for the selected home', ({ homeDir, env, expected }) => {
    expect(
      resolveBootstrapOptions({
        homeDir,
        osHomeDir: '/users/example',
        env,
        clientIdentity: stubClientIdentity,
      }),
    ).toMatchObject({ homeDir: expected, configPath: `${expected}/config.toml` });
  });

  it('passes through an explicit clientIdentity', () => {
    expect(
      resolveBootstrapOptions({ env: {}, clientIdentity: stubClientIdentity }).clientIdentity,
    ).toEqual(stubClientIdentity);
  });
});

describe('bootstrap() storage seeding', () => {
  it('seeds IFileSystemStorageService as a FileStorageService instance', () => {
    const { app } = bootstrap({ homeDir: '/tmp/kimi-home', clientIdentity: stubClientIdentity });
    try {
      const storage = app.accessor.get(IFileSystemStorageService);
      expect(storage).toBeInstanceOf(FileStorageService);
    } finally {
      app.dispose();
    }
  });
});
