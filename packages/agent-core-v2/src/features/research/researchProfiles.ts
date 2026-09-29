/**
 * `research` domain — bounded scientific worker roles for the ordinary Agent tool.
 *
 * Roles select existing AITP skills and hand evidence back to one coordinator;
 * they do not own a parallel memory, research workflow or continuation loop.
 */

import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { renderSystemPromptResult, TASK_AGENT_ROLE_PREFIX } from '#/app/agentProfileCatalog/profile-shared';

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Skill', 'WebSearch', 'FetchURL', 'ReadMediaFile'];
const COMPUTE_TOOLS = [...READ_TOOLS, 'Bash', 'Write', 'Edit', 'TaskList', 'TaskOutput', 'TaskStop'];
const HANDOFF = `${TASK_AGENT_ROLE_PREFIX}\nWhen research mode is enabled, its shared reminder supplies the selected AITP topic. Otherwise locate the topic from the explicit delegated task using AITP. Load aitp-memory and the indicated existing skill. Resolve only the delegated question within its assigned scope and budget. Return the result, assumptions, source or artifact paths, decisive checks, uncertainty, and what this changes in the originating question. Do not start an independent research branch or a Goal. The coordinator integrates the main research.md. Keep a useful failure and its explanation; a task report is not scientific acceptance.`;

const roles = [
  {
    name: 'research-theory',
    modelRouteFallbacks: ['physicist', 'thinker'],
    description: 'A bounded derivation or competing physical explanation, with assumptions and a checkable limiting case.',
    tools: COMPUTE_TOOLS,
    role: 'Use aitp-research for derivation. Establish conventions and assumptions, derive the claim step by step, seek counterexamples or a limiting case, and distinguish exact results from conjectures. Small numerical checks may discriminate a claim; they do not establish an all-size theorem. Write supporting derivations only in the assigned location.',
  },
  {
    name: 'research-code',
    modelRouteFallbacks: ['coder'],
    description: 'Implement and validate the smallest scientific calculation that can decide the assigned question.',
    tools: COMPUTE_TOOLS,
    role: 'Use aitp-research and its applicable method skill; for LibRPA development use developing-librpa. Connect each code change to an observable and acceptance criterion. Inspect the active numerical path, preserve basis and convention provenance, separate implementation correctness from convergence and physical validity, and start with a cheap discriminating example. Stay inside the assigned files.',
  },
  {
    name: 'research-literature',
    modelRouteFallbacks: ['librarian', 'explore'],
    description: 'Find primary references and verify the precise assumptions, equations and scope of a scientific claim.',
    tools: READ_TOOLS,
    role: 'Use aitp-research and its references/literature.md guidance. Return primary-source locators, the relevant equations and assumptions, a faithful comparison of the competing claims, and gaps that remain unresolved. Distinguish a search result or abstract from inspected source evidence. When a PDF-only source cannot be read with the available tools, identify the inaccessible pages or equations and ask the coordinator to extract its text; do not claim to have verified it. This role does not edit files or run code.',
  },
  {
    name: 'research-review',
    modelRouteFallbacks: ['thinker'],
    description: 'Independently challenge a scientific argument, numerical result or manuscript against the originating question.',
    tools: READ_TOOLS,
    role: 'Use aitp-research; use aitp-writing for a manuscript or retained argument. Check whether the claimed result answers the originating question, whether assumptions and controls support it, and whether a simpler falsifying test exists. Rank concrete objections by consequence and state the smallest evidence needed to resolve them. Do not treat green software tests as proof of physics. This role does not edit files or run code.',
  },
  {
    name: 'research-writing',
    modelRouteFallbacks: ['thinker'],
    description: 'Integrate supported theory and numerical evidence into a coherent research note or requested manuscript.',
    tools: [...READ_TOOLS, 'Write', 'Edit'],
    role: 'Use aitp-writing and its applicable references. Read the complete current argument before a substantive rewrite; preserve conditions, evidence and useful failed routes. Produce a LaTeX manuscript only when requested. Distinguish established conclusions, conjectures and missing evidence. Edit only the assigned document; the coordinator owns the main note; return proposed main-note changes in the handoff.',
  },
] as const;

export const RESEARCH_PROFILES = roles.map((role) => normalizeAgentProfile({
  name: role.name,
  description: role.description,
  whenToUse: role.description,
  tools: role.tools,
  subagents: [],
  modelPreference: 'primary',
  modelRouteFallbacks: role.modelRouteFallbacks,
  renderSystemPrompt: (context) => renderSystemPromptResult(`${HANDOFF}\n\n${role.role}`, context, { skillActive: true }),
}));
