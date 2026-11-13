import type { WebContinuation, WebCoordination, WebEffort, WebEnvironment } from '../shared';
import { webLimits } from '../shared';
import { researchModulePlanDraftSchema, type ResearchModulePlan } from '../../../src/solver/modules/policy';
import { t } from '../i18n';
import type { ClassicOrigin } from './classicPreparation';
import type { ResearchLibraryProposalOrigin } from '../researchLibraryProposalOrigin';
import { webTaskEnvironment } from '../environment';

export const taskDraftSchema = 'theorem-os.web-draft.v1';
export const taskDraftStorageKey = 'theorem-os.web-draft.v1';

export type TaskDraft = {
  providerId: string;
  model: string;
  source: string;
  task: string;
  maxTurns: string;
  maxRunSeconds: string;
  /** In units of 10,000 tokens. Empty means no token cap. Older drafts omit it. */
  maxTotalTokens?: string;
  workers: string;
  effort: WebEffort;
  environment: WebEnvironment;
  coordination: WebCoordination;
  /** 先审计划: hold the Agents until the plan is approved. Only `true` is stored; it applies to cooperative runs of 2+ Agents. */
  planApproval?: true;
  templateId: string;
  modulePlan?: ResearchModulePlan;
  knowledgeDigest?: string | null;
  /** A version of one of this account's runs to start from; archives never carry one, it names a run of their owner. */
  continueFrom?: WebContinuation;
  formalization?: { id: string; evidenceSha256: string };
  problemBudget?: { runId: string; projectId?: string };
  /** Recipient-owned reading reference, never the author's private run or the share capability. */
  sharedProofOrigin?: { readingId: string; title: string; digest: string };
  classicOrigin?: ClassicOrigin;
  libraryProposalOrigin?: ResearchLibraryProposalOrigin;
};

/** Editable originals use the shared environment; pending requests and saved evidence keep their exact identity. */
export function editableTaskDraft(draft: TaskDraft, unresolved = false, fixedEnvironment?: WebEnvironment): TaskDraft {
  const environment = fixedEnvironment ?? webTaskEnvironment;
  return unresolved || draft.formalization || draft.continueFrom || draft.problemBudget || draft.sharedProofOrigin
    || draft.classicOrigin || draft.libraryProposalOrigin || draft.environment === environment
    ? draft : { ...draft, environment };
}

const archiveSchemas = ['theorem-os.web-export.v1', 'theorem-os.web-archive.v1'];
const maximumFileBytes = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const editableNumber = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d*)?|\.)?$/;

function invalid(): never { throw new Error(t('任务草稿格式无效')); }

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function own(record: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(record, key)) invalid();
  return record[key];
}

function text(record: Record<string, unknown>, key: string, maximum: number): string {
  const value = own(record, key);
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) invalid();
  return value;
}

function utf8Text(record: Record<string, unknown>, key: string, maximum: number): string {
  const value = text(record, key, maximum);
  if (encoder.encode(value).byteLength > maximum) invalid();
  return value;
}

function budget(record: Record<string, unknown>, key: string): string {
  const value = text(record, key, 24);
  if (!editableNumber.test(value)) invalid();
  return value;
}

function enumeration<T extends string>(record: Record<string, unknown>, key: string, choices: readonly T[]): T {
  const value = own(record, key);
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid();
  return value as T;
}

/** An optional switch that is stored only when on. */
function flag<K extends string>(record: Record<string, unknown>, key: K): Partial<Record<K, true>> {
  if (!Object.hasOwn(record, key)) return {};
  const value = record[key];
  if (typeof value !== 'boolean') invalid();
  return value ? { [key]: true } as Record<K, true> : {};
}

function continuation(value: unknown): WebContinuation {
  const record = object(value);
  if (Object.keys(record).some(key => !['runId', 'taskId', 'commit', 'label', 'taskVersion', 'sourceDigest', 'environmentDigest', 'file'].includes(key))) invalid();
  const result = { runId: text(record, 'runId', 36), taskId: text(record, 'taskId', 200), commit: text(record, 'commit', 128),
    label: text(record, 'label', 200) };
  if (!/^[a-f0-9-]{36}$/u.test(result.runId) || !result.taskId || !/^[A-Za-z0-9]{1,128}$/u.test(result.commit)
    || !result.label.trim() || /\p{Cc}/u.test(result.label)) invalid();
  const taskVersion = Object.hasOwn(record, 'taskVersion') ? text(record, 'taskVersion', 200) : undefined;
  const sourceDigest = Object.hasOwn(record, 'sourceDigest') ? text(record, 'sourceDigest', 64) : undefined;
  const environmentDigest = Object.hasOwn(record, 'environmentDigest') ? text(record, 'environmentDigest', 64) : undefined;
  const sourceFile = Object.hasOwn(record, 'file') ? text(record, 'file', 500) : undefined;
  if (sourceDigest !== undefined && !/^[a-f0-9]{64}$/u.test(sourceDigest) || environmentDigest !== undefined && !/^[a-f0-9]{64}$/u.test(environmentDigest)
    || taskVersion !== undefined && !/^[A-Za-z0-9_.:-]{1,200}$/u.test(taskVersion) || sourceFile !== undefined && (!sourceFile || /[\p{Cc}]/u.test(sourceFile))) invalid();
  return { ...result, ...(taskVersion ? { taskVersion } : {}), ...(sourceDigest ? { sourceDigest } : {}),
    ...(environmentDigest ? { environmentDigest } : {}), ...(sourceFile ? { file: sourceFile } : {}) };
}

function validatedDraft(value: unknown): TaskDraft {
  const draft = object(value);
  let formalization: TaskDraft['formalization'];
  let problemBudget: TaskDraft['problemBudget'];
  let sharedProofOrigin: TaskDraft['sharedProofOrigin'];
  let classicOrigin: TaskDraft['classicOrigin'];
  let libraryProposalOrigin: TaskDraft['libraryProposalOrigin'];
  if (Object.hasOwn(draft, 'libraryProposalOrigin')) {
    const origin = object(draft.libraryProposalOrigin), projectId = text(origin, 'projectId', 128), feedbackId = text(origin, 'feedbackId', 128), trialDigest = text(origin, 'trialDigest', 64);
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(projectId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(feedbackId) || !/^[a-f0-9]{64}$/u.test(trialDigest)) invalid();
    libraryProposalOrigin = { projectId, feedbackId, trialDigest };
  }
  if (Object.hasOwn(draft, 'classicOrigin')) {
    const origin = object(draft.classicOrigin), id = text(origin, 'id', 128), title = text(origin, 'title', 500), sourceSha256 = text(origin, 'sourceSha256', 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id) || !title.trim() || /\p{Cc}/u.test(title) || !/^[a-f0-9]{64}$/u.test(sourceSha256)) invalid();
    classicOrigin = { id, title, sourceSha256 };
  }
  if (Object.hasOwn(draft, 'sharedProofOrigin')) {
    const origin = object(draft.sharedProofOrigin), readingId = text(origin, 'readingId', 128), title = text(origin, 'title', 500), digest = text(origin, 'digest', 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(readingId) || !title.trim() || /\p{Cc}/u.test(title) || !/^[a-f0-9]{64}$/u.test(digest)) invalid();
    sharedProofOrigin = { readingId, title, digest };
  }
  if (Object.hasOwn(draft, 'problemBudget')) {
    const ref = object(draft.problemBudget), runId = text(ref, 'runId', 36);
    const projectId = Object.hasOwn(ref, 'projectId') ? text(ref, 'projectId', 128) : undefined;
    if (!/^[a-f0-9-]{1,36}$/u.test(runId) || projectId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(projectId)) invalid();
    problemBudget = { runId, ...(projectId ? { projectId } : {}) };
  }
  if (Object.hasOwn(draft, 'formalization')) {
    const ref = object(draft.formalization);
    const id = text(ref, 'id', 36), evidenceSha256 = text(ref, 'evidenceSha256', 64);
    if (!/^[a-f0-9-]{36}$/u.test(id) || !/^[a-f0-9]{64}$/u.test(evidenceSha256)) invalid();
    formalization = { id, evidenceSha256 };
  }
  return {
    providerId: text(draft, 'providerId', 64), model: text(draft, 'model', 128),
    source: utf8Text(draft, 'source', webLimits.maxSourceBytes), task: utf8Text(draft, 'task', webLimits.maxTaskBytes),
    maxTurns: budget(draft, 'maxTurns'), maxRunSeconds: budget(draft, 'maxRunSeconds'), workers: budget(draft, 'workers'),
    ...(Object.hasOwn(draft, 'maxTotalTokens') ? { maxTotalTokens: budget(draft, 'maxTotalTokens') } : {}),
    effort: enumeration(draft, 'effort', ['low', 'medium', 'high', 'xhigh', 'max']),
    environment: enumeration(draft, 'environment', ['standard', 'mathlib']),
    coordination: enumeration(draft, 'coordination', ['cooperative', 'independent']),
    ...flag(draft, 'planApproval'),
    templateId: text(draft, 'templateId', 64),
    ...(Object.hasOwn(draft, 'knowledgeDigest') ? { knowledgeDigest: draft.knowledgeDigest === null ? null : text(draft, 'knowledgeDigest', 256) } : {}),
    ...(Object.hasOwn(draft, 'modulePlan') ? { modulePlan: researchModulePlanDraftSchema.parse(draft.modulePlan) as ResearchModulePlan } : {}),
    ...(Object.hasOwn(draft, 'continueFrom') ? { continueFrom: continuation(draft.continueFrom) } : {}),
    ...(formalization ? { formalization } : {}),
    ...(problemBudget ? { problemBudget } : {}),
    ...(sharedProofOrigin ? { sharedProofOrigin } : {}),
    ...(classicOrigin ? { classicOrigin } : {}),
    ...(libraryProposalOrigin ? { libraryProposalOrigin } : {}),
  };
}

function archiveBudget(run: Record<string, unknown>, key: string, divisor = 1): string {
  const value = own(run, key);
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
  return String(value / divisor);
}

export function encodeTaskDraft(draft: TaskDraft): string {
  try { return JSON.stringify({ schema: taskDraftSchema, draft: validatedDraft(draft) }); }
  catch { return invalid(); }
}

export function decodeTaskDraft(value: unknown): TaskDraft {
  try {
    const envelope = object(value), schema = own(envelope, 'schema');
    if (schema === taskDraftSchema) return validatedDraft(own(envelope, 'draft'));
    if (typeof schema !== 'string' || !archiveSchemas.includes(schema)) return invalid();
    const run = object(own(envelope, 'run'));
    return validatedDraft({
      providerId: own(run, 'providerId'), model: own(run, 'model'), source: own(run, 'source'), task: own(run, 'task'),
      maxTurns: archiveBudget(run, 'maxTurns'), maxRunSeconds: archiveBudget(run, 'maxRunSeconds'), workers: archiveBudget(run, 'workers'),
      ...(Object.hasOwn(run, 'maxTotalTokens') ? { maxTotalTokens: archiveBudget(run, 'maxTotalTokens', 10_000) } : {}),
      effort: own(run, 'effort'), environment: own(run, 'environment'), coordination: own(run, 'coordination'), templateId: '',
      ...(Object.hasOwn(run, 'planApproval') ? { planApproval: run.planApproval } : {}),
      ...(Object.hasOwn(run, 'knowledgeDigest') ? { knowledgeDigest: run.knowledgeDigest } : {}),
      ...(Object.hasOwn(run, 'modulePlan') ? { modulePlan: run.modulePlan } : {}),
    });
  } catch { return invalid(); }
}

export async function readTaskDraftFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<TaskDraft> {
  let name: string, size: number;
  try { name = file.name; size = file.size; }
  catch { throw new Error(t('无法读取任务文件')); }
  if (typeof name !== 'string' || !/\.json$/i.test(name)) throw new Error(t('请选择 .json 任务文件'));
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumFileBytes) throw new Error(t('任务文件超过 16 MiB 上限或大小无效'));
  let buffer: ArrayBuffer;
  try { buffer = await file.arrayBuffer(); }
  catch { throw new Error(t('无法读取任务文件')); }
  if (!(buffer instanceof ArrayBuffer)) throw new Error(t('无法读取任务文件'));
  if (buffer.byteLength > maximumFileBytes) throw new Error(t('任务文件超过 16 MiB 上限'));
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error(t('任务文件需使用 UTF-8 编码')); }
  if (content.includes('\0')) throw new Error(t('任务文件包含无效字符'));
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { throw new Error(t('任务文件不是有效 JSON')); }
  return decodeTaskDraft(value);
}
