import { describe, it, expect } from 'vitest';
import { capRoles } from '../src/staffing-cap.js';

const role = (name: string) => ({ role: name, requiredCapabilities: [], objective: name }) as never;

describe('capRoles', () => {
  const team = [role('researcher'), role('implementer'), role('architecture_reviewer')];

  it('keeps the implementer when a task changes code, even if the router listed it second', () => {
    expect(capRoles(team, 1, true).map((r) => (r as { role: string }).role)).toEqual(['implementer']);
  });

  it('prefers a reviewer over further explorers for the second seat', () => {
    expect(capRoles(team, 2, true).map((r) => (r as { role: string }).role)).toEqual(['implementer', 'architecture_reviewer']);
  });

  it('keeps the router order among the survivors, and does nothing when the team already fits', () => {
    expect(capRoles(team, 3, true)).toBe(team);
    expect(capRoles([role('lead'), role('security_reviewer')], 1, false).map((r) => (r as { role: string }).role)).toEqual(['security_reviewer']);
  });
});
