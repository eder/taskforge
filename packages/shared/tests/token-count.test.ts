import { describe, it, expect } from 'vitest';
import { parseTokenCount } from '../src/token-count.js';

describe('parseTokenCount', () => {
  it('reads plain numbers and k/m suffixes', () => {
    expect(parseTokenCount('500000')).toBe(500000);
    expect(parseTokenCount('500k')).toBe(500000);
    expect(parseTokenCount('1.5m')).toBe(1500000);
    expect(parseTokenCount('1,200,000')).toBe(1200000);
    expect(parseTokenCount(250000)).toBe(250000);
  });
  it('rejects anything that is not a positive amount', () => {
    for (const bad of ['', 'abc', '-5', '0', '0k', '12x', '1.2.3']) expect(parseTokenCount(bad)).toBeUndefined();
    expect(parseTokenCount(1.5)).toBeUndefined();
    expect(parseTokenCount(undefined)).toBeUndefined();
  });
});
