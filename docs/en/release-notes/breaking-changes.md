# Breaking changes

## Unreleased

### Retire legacy AITP Research Mode

**Affected:** The legacy AITP adapter, Research Mode, `/research`, research REST/SDK/klient APIs, model tools, Research Board, Research Manager, events, and theory-physics plugin are removed.

**Migration:** Install AITP independently as a Skill-only plugin and use it through Hakimi's ordinary plugin discovery, system prompt, and `Skill` tool path. Hakimi no longer provides an AITP CLI, ledger adapter, session hook, automatic writes, special plugin handling, or custom AITP tools. Use the plugin's own Skill instructions; where an archive is needed, use <https://github.com/bhjia-phys/AITP-Research-Protocol/releases/download/v1.1.0/aitp-1.1.0.zip>.
