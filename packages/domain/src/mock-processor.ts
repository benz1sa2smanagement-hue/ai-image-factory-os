/**
 * Deterministic MOCK processor for queue integration tests.
 * No AI provider, no network, no credentials.
 */

export type MockOutcome = 'MOCK_SUCCESS' | 'MOCK_RETRYABLE_ERROR' | 'MOCK_PERMANENT_ERROR';

export interface MockProcessorInput {
  jobId: string;
  jobType: string;
  attempt: number;
  /** Force outcome for tests; default MOCK_SUCCESS */
  mockOutcome?: MockOutcome | string;
}

export interface MockProcessorResult {
  ok: boolean;
  code: string;
  detail?: string;
  retryable: boolean;
}

export function runMockProcessor(input: MockProcessorInput): MockProcessorResult {
  const outcome = (input.mockOutcome as MockOutcome) ?? 'MOCK_SUCCESS';

  switch (outcome) {
    case 'MOCK_SUCCESS':
      return {
        ok: true,
        code: 'MOCK_SUCCESS',
        detail: `jobId=${input.jobId};attempt=${input.attempt}`,
        retryable: false,
      };
    case 'MOCK_RETRYABLE_ERROR':
      return {
        ok: false,
        code: 'MOCK_RETRYABLE_ERROR',
        detail: 'simulated transient failure',
        retryable: true,
      };
    case 'MOCK_PERMANENT_ERROR':
      return {
        ok: false,
        code: 'QC_REJECTED',
        detail: 'simulated permanent failure',
        retryable: false,
      };
    default:
      return {
        ok: true,
        code: 'MOCK_SUCCESS',
        detail: `unknown_outcome_defaulted;jobId=${input.jobId}`,
        retryable: false,
      };
  }
}
