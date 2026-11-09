import { describe, expect, it, vi } from 'vitest';
import { TaskPlanEditor, planEditUnavailableReason } from '../apps/web/client/taskPlanEditor';
import type { WebCommandResult, WebPlanProposal } from '../apps/web/collaboration';

const access = { runId: 'run-a', status: 'running' as const, connected: true, readOnly: false, edit: true };
const proposal: WebPlanProposal = { schema: 'deepscientist.math.plan-edit.v1', id: 'draft-a', baseVersion: 'plan-v1',
  tasks: [{ id: 'goal', kind: 'goal', objective: 'Preserve this local objective', dependsOn: [], revision: 0 }] };

// Exercise the editor's command lifecycle without constructing browser form controls.
// Real dialog controls and CollaborationView polling are covered by the Chromium regression.
function editorWithDraft(reply?: () => Promise<{ receipt: WebCommandResult }>) {
  const text = JSON.stringify(proposal), draft = { text, previewText: text, receipt: { id: proposal.id, status: 'validated' } as WebCommandResult,
    notice: undefined as string | undefined };
  const api = vi.fn(async (_url: string, _init?: RequestInit) => reply ? reply() : { receipt: { id: proposal.id, status: 'validated' } as WebCommandResult });
  const editor = Object.assign(Object.create(TaskPlanEditor.prototype), { disposed: false, runId: access.runId,
    drafts: new Map([[access.runId, draft]]), access: new Map([[access.runId, {}]]), shownRunId: access.runId, dialog: { open: true }, advanced: { value: text },
    renderStatus: vi.fn(), api }) as Pick<TaskPlanEditor, 'updateAccess'> & { submit(apply: boolean): Promise<void> };
  return { editor, draft, api };
}

describe('an open plan editor when run access changes', () => {
  it('permits an editable, connected, running plan and keeps owner grants optional', () => {
    expect(planEditUnavailableReason(access)).toBeUndefined();
    expect(planEditUnavailableReason({ ...access, edit: undefined })).toBeUndefined();
  });

  it.each([
    [{ edit: false }, '编辑权限'],
    [{ readOnly: true }, '仅可查看'],
    [{ connected: false }, '连接中断'],
    [{ status: 'queued' as const }, '尚未开始'],
    [{ status: 'completed' as const }, '已结束'],
    [{ status: 'cancelled' as const }, '已结束'],
    [{ status: 'error' as const }, '已结束'],
    [{ runId: undefined }, '未打开']
  ])('explains the current unavailable operation: %o', (change, reason) => {
    expect(planEditUnavailableReason({ ...access, ...change })).toContain(reason);
  });

  it('does not invalidate a preview during unchanged polling', () => {
    const { editor, draft } = editorWithDraft();
    editor.updateAccess(access); editor.updateAccess({ ...access });
    expect(draft.previewText).toBe(draft.text);
  });

  it('retains the complete draft while preventing both preview and apply after revocation', async () => {
    const { editor, draft, api } = editorWithDraft(), original = draft.text;
    editor.updateAccess({ ...access, edit: false });
    await editor.submit(false); await editor.submit(true);
    expect(api).not.toHaveBeenCalled();
    expect(draft.text).toBe(original);
    expect(draft.previewText).toBeUndefined();
    expect(draft.receipt.status).toBe('validated');
  });

  it.each([{ connected: false }, { status: 'completed' as const }, { readOnly: true }, { runId: undefined }])(
    'also blocks commands when the current run becomes unavailable: %o', async change => {
      const { editor, draft, api } = editorWithDraft();
      editor.updateAccess({ ...access, ...change });
      await editor.submit(false); await editor.submit(true);
      expect(api).not.toHaveBeenCalled();
      expect(draft.text).toBe(JSON.stringify(proposal));
    });

  it('recovers the preserved draft through a fresh preview after authorization is restored', async () => {
    const { editor, draft, api } = editorWithDraft();
    editor.updateAccess({ ...access, edit: false }); editor.updateAccess(access);
    expect(draft.previewText).toBeUndefined();
    expect(draft.notice).toContain('重新预览');
    await editor.submit(false);
    expect(api).toHaveBeenCalledOnce();
    expect(api.mock.calls[0][0]).toMatch(/edits\/preview$/u);
    expect(draft.previewText).toBe(draft.text);
    expect(draft.text).toBe(JSON.stringify(proposal));
  });

  it('does not reuse an in-flight preview from before access was revoked and restored', async () => {
    let resolve!: (value: { receipt: WebCommandResult }) => void;
    const { editor, draft } = editorWithDraft(() => new Promise(done => { resolve = done; }));
    const preview = editor.submit(false);
    editor.updateAccess({ ...access, edit: false }); editor.updateAccess(access);
    resolve({ receipt: { id: proposal.id, status: 'validated' } }); await preview;
    expect(draft.previewText).toBeUndefined();
    expect(draft.text).toBe(JSON.stringify(proposal));
  });

  it('preserves an authorized background preview when returning from another run', async () => {
    let resolve!: (value: { receipt: WebCommandResult }) => void;
    const { editor, draft } = editorWithDraft(() => new Promise(done => { resolve = done; }));
    const preview = editor.submit(false);
    editor.updateAccess({ ...access, runId: 'run-b' });
    resolve({ receipt: { id: proposal.id, status: 'validated' } }); await preview;
    editor.updateAccess(access);
    expect(draft.previewText).toBe(draft.text);
    expect(draft.text).toBe(JSON.stringify(proposal));
  });
});
