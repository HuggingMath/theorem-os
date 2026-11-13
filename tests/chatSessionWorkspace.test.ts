import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSession } from '../apps/web/client/chatSession';
import { setDetailLevel } from '../apps/web/client/detailLevel';
import { renderChatThread } from '../apps/web/client/ui/ChatWorkspace';
import type { SolveProcess } from '../apps/web/client/solveProcess';

vi.mock('../apps/web/client/ui/ChatWorkspace', () => ({
  renderChatThread: vi.fn(), renderChatComposer: vi.fn(), renderChatHistory: vi.fn(), renderChatOriginal: vi.fn(),
}));

beforeEach(() => {
  vi.stubGlobal('document', { body: { dataset: {} } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  setDetailLevel('simple');
  vi.clearAllMocks();
});
afterEach(() => { setDetailLevel('simple'); vi.unstubAllGlobals(); });

// Exercise the session's draw and selection lifecycle; browser suites cover the actual panels and lazy chunks.
function fixture(state: 'formalizing' | 'proving' = 'proving', wide = true) {
  const process = { key: 'task-a', active: true, state } as SolveProcess;
  const onArtifact = vi.fn(), capture = vi.fn();
  const session = Object.assign(Object.create(ChatSession.prototype), {
    conversation: { messages: [] }, currentId: 'chat-a', draft: '', references: [],
    formalizations: [], summaries: [], unsavedDrafts: new Set(), liveShown: new Set(), liveSelected: new Map(),
    submissionIdentity: { unresolved: false }, guidanceFeedback: { runId: '', records: [] },
    options: { session: () => undefined, runs: () => [], keyRequired: () => false, onArtifact },
    answers: { sync: vi.fn() }, reading: { rendered: vi.fn(), capture },
    refreshGuidanceFeedback: vi.fn(), solve: () => ({ process, wide }),
    draftQuoteBlocks: () => [], activeModel: () => 'fixture', activeProviderId: () => 'fixture', providers: () => [],
    restoreDraftPosition: vi.fn(), drawHistory: vi.fn(), drawOriginal: vi.fn(), drawLive: vi.fn(),
  }) as { draw(): void; openCheck(process: SolveProcess, id: string): void; liveSelected: Map<string, string> };
  return { session, process, onArtifact, capture };
}

const settle = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe('conversation workspace opening', () => {
  it.each(['formalizing', 'proving'] as const)('keeps a wide simple conversation alone while %s', async state => {
    const f = fixture(state);
    f.session.draw(); await settle();
    expect(f.onArtifact).not.toHaveBeenCalled();
  });

  it('keeps explicit source and roadmap actions and a selected check available in simple reading', async () => {
    const f = fixture();
    f.session.draw();
    const props = vi.mocked(renderChatThread).mock.calls.at(-1)![1];
    props.onArtifact('source'); props.onArtifact('roadmap', { taskId: 'lemma-a' });
    f.session.openCheck(f.process, 'check-a'); await settle();
    expect(f.onArtifact.mock.calls).toEqual([['source', undefined, undefined], ['roadmap', { taskId: 'lemma-a' }, undefined], ['live']]);
    expect(f.session.liveSelected.get(f.process.key)).toBe('check-a');
    expect(f.capture).toHaveBeenCalledTimes(3);
  });

  it('preserves the detailed preference and does not reopen a workspace after it was closed', async () => {
    setDetailLevel('full');
    const f = fixture();
    f.session.draw(); await settle();
    expect(f.onArtifact).toHaveBeenCalledWith('live', undefined, true);
    f.onArtifact.mockClear();
    f.session.draw(); await settle();
    expect(f.onArtifact).not.toHaveBeenCalled();
  });

  it.each([{ chatArtifact: 'source', outputOpen: 'true' }, { chatArtifact: 'original', outputOpen: 'true' }])(
    'preserves a panel the reader already opened: %o', async panel => {
      setDetailLevel('full'); Object.assign(document.body.dataset, panel);
      const f = fixture();
      f.session.draw(); await settle();
      expect(f.onArtifact).not.toHaveBeenCalled();
    });

  it('keeps detailed phone reading in the conversation until an explicit request', async () => {
    setDetailLevel('full'); const f = fixture('proving', false);
    f.session.draw(); await settle();
    expect(f.onArtifact).not.toHaveBeenCalled();
  });

  it('respects a switch back to simple before the queued workspace opens', async () => {
    setDetailLevel('full'); const f = fixture();
    f.session.draw(); setDetailLevel('simple'); await settle();
    expect(f.onArtifact).not.toHaveBeenCalled();
  });
});
