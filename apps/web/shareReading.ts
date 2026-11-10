import { createHash } from 'node:crypto';
import type { WebExplanationSection, WebFormalizationReport, WebRun } from './shared';
import type { WebShareReading, WebShareReadingInput, WebShareReadingTask } from './shareReadingTypes';
export type { WebShareReading, WebShareReadingInput, WebShareReadingTask } from './shareReadingTypes';

/** Only mathematical reading material is public. Observations, logs and model configuration stay private. */
export function shareReading(run: WebRun, review?: WebFormalizationReport, input: WebShareReadingInput = {}): WebShareReading {
  const observation = run.observation, inspection = observation?.inspection;
  const conditions = [...new Set([...(inspection?.problem.assumptions ?? []), ...(review?.backtranslation.assumptions ?? [])])];
  const tasks = (inspection?.tasks ?? []).map((task): WebShareReadingTask => {
    const proof = task.proof.commit && task.proof.sourceDigest ? {
      commit: task.proof.commit, sourceDigest: task.proof.sourceDigest,
      receiptIds: (task.proof.receiptIds ?? []).filter(id => observation?.checks.some(check => check.id === id && check.taskId === task.id
        && check.taskVersion === task.version && check.commit === task.proof.commit && check.sourceDigest === task.proof.sourceDigest)),
    } : undefined;
    const source = proof && observation?.sources.find(source => source.taskId === task.id && source.taskVersion === task.version
      && source.commit === proof.commit && source.sourceDigest === proof.sourceDigest
      && !source.file.startsWith('/') && !source.file.split(/[\\/]/u).includes('..')
      && createHash('sha256').update(source.source).digest('hex') === source.sourceDigest);
    return { id: task.id, version: task.version, title: task.objective || task.theorem || task.id, kind: task.kind, status: task.proof.status,
      ...(task.informalStatement ? { statement: task.informalStatement } : {}), ...(task.type ? { leanStatement: task.type } : {}),
      ...(task.informalProof ? { reasoning: task.informalProof } : {}), ...(task.finding ? { finding: task.finding } : {}),
      premises: [...task.premises], dependencies: [...task.plannedDependencies],
      conditions: (task.proof.conditions ?? []).map(condition => ({ taskId: condition.taskId, version: condition.taskDigest })),
      ...(proof ? { proof } : {}), ...(source ? { source: { file: source.file, code: source.source, commit: source.commit,
        sha256: source.sourceDigest, environmentDigest: source.environmentDigest } } : {}),
    };
  });
  const ids = new Set(tasks.map(task => task.id));
  const routes = (observation?.plan?.proofRoutes ?? []).filter(route => ids.has(route.targetTaskId) && ids.has(route.closingTaskId)
    && route.prerequisiteTaskIds.every(id => ids.has(id))).map(route => ({ id: route.id, targetTaskId: route.targetTaskId,
      prerequisiteTaskIds: [...route.prerequisiteTaskIds], closingTaskId: route.closingTaskId }));
  const proofSha256 = createHash('sha256').update(run.result?.proof ?? '').digest('hex');
  // Callers supply only documents reverified against this accepted proof by WebExplanations.read.
  const explanations = (input.explanations ?? []).map(document => ({ target: document.target, language: document.language,
    overview: document.overview, axioms: [...document.axioms], proofSha256,
    metrics: { declarations: document.metrics.declarations, steps: document.metrics.steps, citations: document.metrics.citations,
      excerptCoverage: document.metrics.excerptCoverage, proofLines: document.metrics.proofLines,
      explainedLines: document.metrics.explainedLines, ambiguousExcerpts: document.metrics.ambiguousExcerpts },
    sections: document.sections.map((section): WebExplanationSection => ({ name: section.name, kind: section.kind, target: section.target,
      title: section.title, statement: section.statement, lines: { ...section.lines }, signature: { ...section.signature },
      unexplained: [...section.unexplained], statementReviews: [...section.statementReviews],
      steps: section.steps.map(step => ({ text: step.text, lines: step.lines.map(range => ({ start: range.start, end: range.end })),
        uses: step.uses.map(use => ({ name: use.name, place: use.place, spans: use.spans.map(span => ({ line: span.line, start: span.start, end: span.end })) })),
        reviews: [...step.reviews], ...(step.goals ? { goals: { before: [...step.goals.before], beforeCount: step.goals.beforeCount,
          after: [...step.goals.after], afterCount: step.goals.afterCount, lines: { start: step.goals.lines.start, end: step.goals.lines.end } } } : {}),
      })),
    })),
  }));
  return { conditions, tasks, routes, explanations };
}
