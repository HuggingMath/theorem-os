import { useEffect, useRef, useState } from 'preact/hooks';
import type { ResearchDraftKind, ResearchDraftSubmission } from '../researchPersonalTypes';
import type { ResearchDraft, ResearchDraftScope } from './researchDraftStore';
import { useResearchDrafts } from './researchDrafts';

/** Inputs save on edit so closing a drawer or unmounting a task does not lose text. */
export function useResearchInputDraft<T extends { text: string }>(owner: string, projectId: string | undefined, kind: ResearchDraftKind,
  scope: Omit<ResearchDraftScope, 'owner' | 'projectId' | 'kind'>, initial: T) {
  const drafts = useResearchDrafts<T>(owner, projectId ?? '', kind);
  const [value, setValue] = useState<T>(() => drafts.read(scope)?.value ?? initial), current = useRef(value);
  current.current = value;
  useEffect(() => { const saved = drafts.read(scope); if (saved) drafts.restore(saved); }, []);
  const update = (next: T) => { current.current = next; setValue(next); drafts.save(scope, next, next.text.slice(0, 80)); };
  return { value, update, drafts,
    restore(item: ResearchDraft<T>) { current.current = item.value; setValue(item.value); drafts.restore(item); },
    async complete(submitted: ResearchDraft<T> | undefined, submission: Omit<ResearchDraftSubmission, 'href'>, submittedValue: T) {
      if (submitted) await drafts.complete(submitted, submission);
      if (JSON.stringify(current.current) === JSON.stringify(submittedValue)) {
        const empty = { ...current.current, text: '' }; current.current = empty; setValue(empty);
      }
    },
  };
}
