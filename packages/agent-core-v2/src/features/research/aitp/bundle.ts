/** `research` domain — bundled unmodified AITP skills and their readable resources. */
import { registerBuiltinResource } from '#/app/skillCatalog/builtin/resources';
import { registerBuiltinSkill } from '#/app/skillCatalog/builtin/registry';
import { parseSkillText } from '#/app/skillCatalog/parser';
import resource0 from './skills/aitp-distill/SKILL.md?raw';
import resource1 from './skills/aitp-human-brainstorming/SKILL.md?raw';
import resource2 from './skills/aitp-human-learning/SKILL.md?raw';
import resource3 from './skills/aitp-memory/SKILL.md?raw';
import resource4 from './skills/aitp-memory/references/local-assets.md?raw';
import resource5 from './skills/aitp-memory/references/numerical-assets.md?raw';
import resource6 from './skills/aitp-memory/references/shared-knowledge.md?raw';
import resource7 from './skills/aitp-memory/references/starting-a-topic.md?raw';
import resource8 from './skills/aitp-research/SKILL.md?raw';
import resource9 from './skills/aitp-research/methods/librpa/developing-librpa/SKILL.md?raw';
import resource10 from './skills/aitp-research/methods/librpa/developing-librpa/references/agent-development-patterns.md?raw';
import resource11 from './skills/aitp-research/methods/librpa/developing-librpa/references/architecture.md?raw';
import resource12 from './skills/aitp-research/methods/librpa/developing-librpa/references/qsgw-cleanup.md?raw';
import resource13 from './skills/aitp-research/references/literature.md?raw';
import resource14 from './skills/aitp-research/references/method-library.md?raw';
import resource15 from './skills/aitp-research/references/slurm.md?raw';
import resource16 from './skills/aitp-writing/SKILL.md?raw';
import resource17 from './skills/aitp-writing/assets/JHEP.bst?raw';
import resource18 from './skills/aitp-writing/assets/jheppub-note-template.tex?raw';
import resource19 from './skills/aitp-writing/assets/jheppub.sty?raw';
import resource20 from './skills/aitp-writing/assets/research-computational.md?raw';
import resource21 from './skills/aitp-writing/assets/research-letter.md?raw';
import resource22 from './skills/aitp-writing/assets/research-theory.md?raw';
import resource23 from './skills/aitp-writing/references/citations.md?raw';
import resource24 from './skills/aitp-writing/references/computational-and-mixed.md?raw';
import resource25 from './skills/aitp-writing/references/formal-theory.md?raw';
import resource26 from './skills/aitp-writing/references/journal-templates.md?raw';
import resource27 from './skills/aitp-writing/references/learning.md?raw';
import resource28 from './skills/aitp-writing/references/manuscripts.md?raw';
import resource29 from './skills/aitp-writing/references/research-note.md?raw';
import resource30 from './skills/aitp-writing/references/supporting-notes.md?raw';
import resource31 from './skills/aitp-writing/references/witten-2011-2026-corpus.md?raw';
import resource32 from './skills/aitp-writing/references/witten-corpus-analysis.md?raw';
export const AITP_RESOURCES: Readonly<Record<string, string>> = {
  'builtin://aitp/skills/aitp-distill/SKILL.md': resource0,
  'builtin://aitp/skills/aitp-human-brainstorming/SKILL.md': resource1,
  'builtin://aitp/skills/aitp-human-learning/SKILL.md': resource2,
  'builtin://aitp/skills/aitp-memory/SKILL.md': resource3,
  'builtin://aitp/skills/aitp-memory/references/local-assets.md': resource4,
  'builtin://aitp/skills/aitp-memory/references/numerical-assets.md': resource5,
  'builtin://aitp/skills/aitp-memory/references/shared-knowledge.md': resource6,
  'builtin://aitp/skills/aitp-memory/references/starting-a-topic.md': resource7,
  'builtin://aitp/skills/aitp-research/SKILL.md': resource8,
  'builtin://aitp/skills/aitp-research/methods/librpa/developing-librpa/SKILL.md': resource9,
  'builtin://aitp/skills/aitp-research/methods/librpa/developing-librpa/references/agent-development-patterns.md': resource10,
  'builtin://aitp/skills/aitp-research/methods/librpa/developing-librpa/references/architecture.md': resource11,
  'builtin://aitp/skills/aitp-research/methods/librpa/developing-librpa/references/qsgw-cleanup.md': resource12,
  'builtin://aitp/skills/aitp-research/references/literature.md': resource13,
  'builtin://aitp/skills/aitp-research/references/method-library.md': resource14,
  'builtin://aitp/skills/aitp-research/references/slurm.md': resource15,
  'builtin://aitp/skills/aitp-writing/SKILL.md': resource16,
  'builtin://aitp/skills/aitp-writing/assets/JHEP.bst': resource17,
  'builtin://aitp/skills/aitp-writing/assets/jheppub-note-template.tex': resource18,
  'builtin://aitp/skills/aitp-writing/assets/jheppub.sty': resource19,
  'builtin://aitp/skills/aitp-writing/assets/research-computational.md': resource20,
  'builtin://aitp/skills/aitp-writing/assets/research-letter.md': resource21,
  'builtin://aitp/skills/aitp-writing/assets/research-theory.md': resource22,
  'builtin://aitp/skills/aitp-writing/references/citations.md': resource23,
  'builtin://aitp/skills/aitp-writing/references/computational-and-mixed.md': resource24,
  'builtin://aitp/skills/aitp-writing/references/formal-theory.md': resource25,
  'builtin://aitp/skills/aitp-writing/references/journal-templates.md': resource26,
  'builtin://aitp/skills/aitp-writing/references/learning.md': resource27,
  'builtin://aitp/skills/aitp-writing/references/manuscripts.md': resource28,
  'builtin://aitp/skills/aitp-writing/references/research-note.md': resource29,
  'builtin://aitp/skills/aitp-writing/references/supporting-notes.md': resource30,
  'builtin://aitp/skills/aitp-writing/references/witten-2011-2026-corpus.md': resource31,
  'builtin://aitp/skills/aitp-writing/references/witten-corpus-analysis.md': resource32,
};

for (const [path, content] of Object.entries(AITP_RESOURCES)) {
  registerBuiltinResource(path, content);
  if (!path.endsWith('/SKILL.md')) continue;
  const dir = path.slice(0, -'/SKILL.md'.length);
  const parsed = parseSkillText({ skillMdPath: path, skillDirName: dir.split('/').at(-1)!, source: 'builtin', text: content });
  registerBuiltinSkill({ ...parsed, path, dir });
}
