import { describe, expect, it } from 'vitest';
import {
  buildSearchIndex,
  loadArticles,
  searchDocumentation,
  validateDocumentation,
  validateGovernance,
} from '../src/index.js';

describe('canonical documentation', () => {
  it('keeps English and Portuguese articles valid and in parity', () => {
    const english = loadArticles('en');
    const portuguese = loadArticles('pt-BR');
    expect(english.map(({ metadata }) => metadata.id)).toEqual(
      portuguese.map(({ metadata }) => metadata.id),
    );
    expect(validateDocumentation()).toEqual({
      articleCount: english.length + portuguese.length,
      errors: [],
    });
  });

  it('loads stable article IDs from the canonical source', () => {
    expect(loadArticles('en').map(({ metadata }) => metadata.id)).toContain(
      'getting-started/overview',
    );
  });

  it('traces implemented requirements to existing code, tests, and localized docs', () => {
    const result = validateGovernance();
    expect(result.errors).toEqual([]);
    expect(result.requirementCount).toBeGreaterThanOrEqual(47);
    expect(result.contextualHelpTargetCount).toBe(33);
  });

  it('builds a local search index and finds localized content deterministically', () => {
    expect(buildSearchIndex('en')).toHaveLength(loadArticles('en').length);
    expect(searchDocumentation('pt-BR', 'ajuda offline')[0]?.id).toBe('user/help-center');
  });
});
