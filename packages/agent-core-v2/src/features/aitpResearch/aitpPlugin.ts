/**
 * `aitpResearch` domain — official AITP plugin identity.
 *
 * Research Mode gates Skill visibility, catalog availability, and the dynamic
 * listing on this one id. It is the manifest `name` of the official plugin
 * (`aitp`), which the managed-plugin registry also uses as the plugin id. A
 * plugin registered under any other id — including the retired
 * `aitp-research-protocol` — is not the official plugin and is treated as an
 * ordinary plugin whose Skills stay visible.
 */
export const AITP_PLUGIN_ID = 'aitp';
