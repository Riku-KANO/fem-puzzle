import { describe, expect, it } from 'vitest';
import { elementCount } from '@stress-carve/protocol';

describe('web workspace wiring', () => {
  it('resolves the protocol package', () => {
    expect(elementCount([24, 8, 4])).toBe(768);
  });
});
