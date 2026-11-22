import type { WebRun } from '../shared';
import { headingLine, leanOutline } from './leanOutline';

export type ChatArtifactKind = 'roadmap' | 'original' | 'source' | 'live' | 'result' | 'plan';
export type ChatArtifactTarget = { taskId?: string; messageId?: string };

/** Artifact links resolve task identities from the recorded plan, never from a display name. */
export function chatArtifactTask(run: WebRun | undefined, taskId?: string) {
  return taskId ? run?.observation?.inspection.tasks.find(task => task.id === taskId) : undefined;
}

export function chatArtifactLine(run: WebRun, taskId: string, source: string) {
  const theorem = chatArtifactTask(run, taskId)?.theorem;
  return theorem ? headingLine(leanOutline(source), theorem) : undefined;
}

type Origin = { key: string; kind: ChatArtifactKind; top: number; left: number; messageId?: string; offset?: number; focus?: HTMLElement };

/** A temporary artifact view returns to the same message even after the chat column changes width. */
export class ChatArtifactNavigation {
  private origin?: Origin;
  constructor(private readonly thread: HTMLElement) {}

  clear() { this.origin = undefined; }

  remember(key: string, kind: ChatArtifactKind, target?: ChatArtifactTarget) {
    const focus = document.activeElement instanceof HTMLElement && this.thread.contains(document.activeElement)
      ? document.activeElement : undefined;
    // A link inside an open artifact must not replace the return point in the conversation.
    if (!this.thread.clientHeight || (this.origin?.key === key && !focus && !target?.messageId)) return;
    const messages = [...this.thread.querySelectorAll<HTMLElement>('[data-message-id]')];
    const top = this.thread.getBoundingClientRect().top;
    const message = (target?.messageId && messages.find(node => node.dataset.messageId === target.messageId))
      || focus?.closest<HTMLElement>('[data-message-id]')
      || messages.find(node => node.getBoundingClientRect().bottom > top);
    this.origin = { key, kind, top: this.thread.scrollTop, left: this.thread.scrollLeft, focus,
      ...(message ? { messageId: message.dataset.messageId, offset: message.getBoundingClientRect().top - top } : {}) };
  }

  restore(key: string): boolean {
    const origin = this.origin;
    this.origin = undefined;
    if (!origin || origin.key !== key) return false;
    const message = [...this.thread.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find(node => node.dataset.messageId === origin.messageId);
    this.thread.scrollTop = message && origin.offset !== undefined
      ? this.thread.scrollTop + message.getBoundingClientRect().top - this.thread.getBoundingClientRect().top - origin.offset
      : origin.top;
    this.thread.scrollLeft = origin.left;
    const focus = origin.focus?.isConnected && this.thread.contains(origin.focus) ? origin.focus
      : message?.querySelector<HTMLElement>(`[data-research-artifact="${origin.kind}"]`) ?? message;
    if (focus) {
      if (!focus.matches('button,a,input,textarea,select,[tabindex]')) focus.tabIndex = -1;
      focus.focus({ preventScroll: true });
    }
    return true;
  }
}
