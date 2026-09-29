/**
 * Vitest setup — hermetic experimental flags.
 *
 * The kap-server suites pin flag-off engine behavior: several scenarios
 * assert wire semantics that an experimental flag deliberately changes
 * (e.g. the minidb session read model makes externally written sessions
 * eventually consistent). A developer shell exporting a `KIMI_CODE_*` var
 * (an experimental flag, or `KIMI_CODE_LEGACY_FLAG=1` selecting the v1
 * engine) must not flip the whole suite — scrub the env here, then pin the
 * defaults-ON flags OFF below; a test that wants a flag re-enables its env
 * var explicitly.
 */

for (const key of Object.keys(process.env)) {
  if (key.startsWith('KIMI_CODE_')) {
    delete process.env[key];
  }
}

// Stage-4 note: default the `search_worker` flag OFF for server-booting
// suites. Every startServer would otherwise lazily spawn a real search
// worker thread, and in dev/test the entry loads its TypeScript closure via
// Node's type stripping — CPU-heavy enough that the accumulated background
// load pushed unrelated heavy tests (e.g. prompts image compression) past
// the 5s default timeout under full-suite parallelism. Suites that exercise
// the search surface pin their host explicitly: searchService.test.ts
// injects flag stubs per service, and searchRoute.test.ts re-enables the
// env var for its end-to-end worker coverage.
process.env['KIMI_CODE_EXPERIMENTAL_SEARCH_WORKER'] = 'false';

// Stage-6 note: default the `persistence_minidb_readmodel` flag OFF for
// server-booting suites. The flag defaults ON in production, but several
// suites assert wire semantics the read model deliberately changes
// (externally written sessions become eventually consistent). The dedicated
// read-model describe in sessions.test.ts re-enables the env var per test —
// the env source outranks the `[experimental]` config section.
process.env['KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL'] = 'false';
