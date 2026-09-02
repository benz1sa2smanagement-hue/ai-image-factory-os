import { describe, it, expect } from 'vitest';
import { canTransition, assertTransition } from './state-machine.js';
import { assertZeroCost, canStartNewWork } from './policy.js';

describe('state machine', () => {
  it('allows PLANNED → QUEUED', () => {
    expect(canTransition('PLANNED', 'QUEUED')).toBe(true);
  });
  it('blocks PLANNED → UPLOADED', () => {
    expect(canTransition('PLANNED', 'UPLOADED')).toBe(false);
  });
  it('throws on illegal transition', () => {
    expect(() => assertTransition('QC', 'UPLOADED')).toThrow(/Illegal/);
  });
  it('allows QC → PASSED and REJECTED', () => {
    expect(canTransition('QC', 'PASSED')).toBe(true);
    expect(canTransition('QC', 'REJECTED')).toBe(true);
  });
});

describe('zero-cost policy', () => {
  it('blocks paid cost', () => {
    const d = assertZeroCost({ allowPaidApi: false, estimatedCost: 0.01, freeAvailable: true });
    expect(d.allowed).toBe(false);
  });
  it('allows free zero-cost', () => {
    const d = assertZeroCost({ allowPaidApi: false, estimatedCost: 0, freeAvailable: true });
    expect(d.allowed).toBe(true);
  });
  it('factory stop blocks new work', () => {
    expect(canStartNewWork('STOPPED')).toBe(false);
    expect(canStartNewWork('RUNNING')).toBe(true);
  });
});
