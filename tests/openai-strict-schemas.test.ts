import { describe, it, expect } from 'vitest';
import { ROUTING_DECISION_JSON_SCHEMA, describeHttpFailure } from '@taskforge/router';
import { SEMANTIC_PLAN_JSON_SCHEMA } from '@taskforge/planner';

/**
 * OpenAI Structured Outputs with `strict: true` rejects (HTTP 400) any object
 * schema that does not list every property in `required` and set
 * `additionalProperties: false`. A violation silently disables the model
 * (TaskForge falls back to the static router/planner), so check it offline.
 */
function strictViolations(node: unknown, at = 'root'): string[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as Record<string, any>;
  const problems: string[] = [];
  const types = Array.isArray(n.type) ? n.type : [n.type];
  if (types.includes('object')) {
    const props = Object.keys(n.properties ?? {});
    const required: string[] = n.required ?? [];
    if (n.additionalProperties !== false) problems.push(`${at}: additionalProperties must be false`);
    for (const key of props) if (!required.includes(key)) problems.push(`${at}.${key}: missing from required`);
    for (const key of required) if (!props.includes(key)) problems.push(`${at}.${key}: required but undefined`);
  }
  for (const [key, value] of Object.entries(n.properties ?? {})) problems.push(...strictViolations(value, `${at}.${key}`));
  if (n.items) problems.push(...strictViolations(n.items, `${at}[]`));
  for (const k of ['anyOf', 'oneOf', 'allOf']) {
    (n[k] ?? []).forEach((child: unknown, i: number) => problems.push(...strictViolations(child, `${at}.${k}[${i}]`)));
  }
  return problems;
}

describe('OpenAI strict structured-output schemas', () => {
  it('routing decision schema is valid for strict mode', () => {
    expect(strictViolations(ROUTING_DECISION_JSON_SCHEMA)).toEqual([]);
  });

  it('semantic plan schema is valid for strict mode', () => {
    expect(strictViolations(SEMANTIC_PLAN_JSON_SCHEMA)).toEqual([]);
  });

  it('the checker itself catches an optional property', () => {
    const bad = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'], additionalProperties: false };
    expect(strictViolations(bad)).toEqual(['root.b: missing from required']);
  });
});

describe('describeHttpFailure', () => {
  it('surfaces the provider message and masks keys', () => {
    const body = JSON.stringify({ error: { message: "Invalid schema: 'preferredAgent' is missing. key sk-abcdef123456 leaked" } });
    const text = describeHttpFailure(400, body);
    expect(text).toContain('HTTP 400: Invalid schema');
    expect(text).not.toContain('sk-abcdef123456');
    expect(text).toContain('sk-***');
  });

  it('falls back to the bare status when there is no body', () => {
    expect(describeHttpFailure(500, '')).toBe('HTTP 500');
  });
});
