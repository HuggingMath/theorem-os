import type { WebExplanationLanguage, WebRunInput } from '../shared';

type Settings = Pick<WebRunInput, 'autoExplain' | 'explanationLanguage'>;

/** An uncertain older POST must keep omitted fields; new work records the interface language. */
export function automaticExplanationSettings(value: Settings, language: WebExplanationLanguage, unresolved = false): Settings {
  return { autoExplain: unresolved ? value.autoExplain : value.autoExplain ?? true,
    explanationLanguage: unresolved ? value.explanationLanguage : value.explanationLanguage ?? language };
}
