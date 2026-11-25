import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../utils/id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fonctionne aussi sans crypto.randomUUID (page en http)', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const a = newId();
    expect(a).toMatch(UUID);
    expect(newId()).not.toBe(a);
  });
});
