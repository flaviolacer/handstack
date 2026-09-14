import { describe, expect, it } from 'vitest';
import { repositoryName } from '../src/index.js';

describe('persistence contracts', () => {
  it('accepts stable adapter-neutral repository names', () => {
    expect(repositoryName('chat-message')).toBe('chat-message');
    expect(() => repositoryName('Mongo.Collection')).toThrow(TypeError);
  });
});
