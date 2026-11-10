import type { DirectFormalizationEvidence } from '../../src/math/formalization';
import type { WorkerFormalizationInput } from './formalizationTypes';

/** Server-only input; compiled evidence does not enter the browser's type dependency graph. */
export type WorkerFormalizationAuditInput = Pick<WorkerFormalizationInput,
  'id' | 'original' | 'environment' | 'model' | 'effort' | 'apiKey' | 'provider' | 'maxRunSeconds' | 'maxTotalTokens'> & {
  operation: 'audit'; evidence: DirectFormalizationEvidence;
};
