import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { createServices } from '#/_base/di/test';
import {
  IAgentSkillVisibilityService,
  SkillVisibilityContribution,
} from '#/agent/skillVisibility/skillVisibility';
import { AgentSkillVisibilityService } from '#/agent/skillVisibility/skillVisibilityService';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { SkillDefinition } from '#/app/skillCatalog/types';

function makeSkill(name: string, pluginId?: string): SkillDefinition {
  return {
    name,
    description: `Skill ${name}`,
    path: `/skills/${name}/SKILL.md`,
    dir: `/skills/${name}`,
    content: '',
    metadata: {},
    source: 'project',
    plugin: pluginId !== undefined ? { id: pluginId } : undefined,
  };
}


describe('AgentSkillVisibilityService', () => {
  let disposables: DisposableStore;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(() => disposables.dispose());

  it('allows all skills when no filters are registered', () => {
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IAgentSkillVisibilityService, AgentSkillVisibilityService);
      },
    });
    const svc = ix.get(IAgentSkillVisibilityService);
    const skill = makeSkill('test');
    expect(svc.isSkillVisible(skill)).toBe(true);
    expect(svc.isSkillVisibleInFrozenListing(skill)).toBe(true);
    expect(svc.hiddenReason(skill)).toBeUndefined();
  });

  it('hides a skill when a filter rejects it', () => {
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IAgentSkillVisibilityService, AgentSkillVisibilityService);
      },
    });

    class FilterProvider extends Service {
      declare readonly _serviceBrand: undefined;
      constructor() {
        super();
        this.provide(SkillVisibilityContribution, {
          id: 'test-filter',
          isVisible: (skill: SkillDefinition, _accessor: ServicesAccessor) => skill.name !== 'hidden',
          describeHidden: (skill: SkillDefinition, _accessor: ServicesAccessor) =>
            skill.name === 'hidden' ? 'blocked by test-filter' : undefined,
        });
      }
    }
    disposables.add(ix.createInstance(FilterProvider));

    const svc = ix.get(IAgentSkillVisibilityService);
    expect(svc.isSkillVisible(makeSkill('visible'))).toBe(true);
    expect(svc.isSkillVisible(makeSkill('hidden'))).toBe(false);
    expect(svc.hiddenReason(makeSkill('hidden'))).toBe('blocked by test-filter');
  });


  it('uses a frozen-listing callback without changing current visibility', () => {
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IAgentSkillVisibilityService, AgentSkillVisibilityService);
      },
    });

    class FrozenListingFilterProvider extends Service {
      declare readonly _serviceBrand: undefined;
      constructor() {
        super();
        this.provide(SkillVisibilityContribution, {
          id: 'frozen-listing-filter',
          isVisible: (skill: SkillDefinition, _accessor: ServicesAccessor) => skill.name !== 'hidden',
          isVisibleInFrozenListing: (skill: SkillDefinition, _accessor: ServicesAccessor) => skill.name !== 'frozen-hidden',
          describeHidden: () => undefined,
        });
      }
    }
    disposables.add(ix.createInstance(FrozenListingFilterProvider));

    const svc = ix.get(IAgentSkillVisibilityService);
    expect(svc.isSkillVisible(makeSkill('hidden'))).toBe(false);
    expect(svc.isSkillVisibleInFrozenListing(makeSkill('hidden'))).toBe(true);
    expect(svc.isSkillVisible(makeSkill('frozen-hidden'))).toBe(true);
    expect(svc.isSkillVisibleInFrozenListing(makeSkill('frozen-hidden'))).toBe(false);
  });

  it('filterVisible returns only visible skills', () => {
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IAgentSkillVisibilityService, AgentSkillVisibilityService);
      },
    });

    class FilterProvider extends Service {
      declare readonly _serviceBrand: undefined;
      constructor() {
        super();
        this.provide(SkillVisibilityContribution, {
          id: 'test-filter',
          isVisible: (skill: SkillDefinition, _accessor: ServicesAccessor) => !skill.name.startsWith('blocked'),
          describeHidden: (skill: SkillDefinition, _accessor: ServicesAccessor) =>
            skill.name.startsWith('blocked') ? 'blocked' : undefined,
        });
      }
    }
    disposables.add(ix.createInstance(FilterProvider));

    const svc = ix.get(IAgentSkillVisibilityService);
    const skills = [makeSkill('ok1'), makeSkill('blocked1'), makeSkill('ok2'), makeSkill('blocked2')];
    const visible = svc.filterVisible(skills);
    expect(visible.map((s) => s.name)).toEqual(['ok1', 'ok2']);
  });
});
