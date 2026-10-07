import { describe, expect, it } from 'vitest';
import { isRunningInContainer } from '../src/isolation.js';

const never = () => false;

describe('isRunningInContainer', () => {
  it('is false on a plain host', () => {
    expect(isRunningInContainer({}, never)).toBe(false);
  });

  it('trusts the marker set by the official image', () => {
    expect(isRunningInContainer({ TASKFORGE_ISOLATED: '1' }, never)).toBe(true);
  });

  it.each(['/.dockerenv', '/run/.containerenv'])('detects %s', (marker) => {
    expect(isRunningInContainer({}, (p) => p === marker)).toBe(true);
  });

  it('ignores a marker that is not exactly "1"', () => {
    expect(isRunningInContainer({ TASKFORGE_ISOLATED: '0' }, never)).toBe(false);
  });
});
