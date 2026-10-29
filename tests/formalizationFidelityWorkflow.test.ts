import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFormalizationEvidence, formalizationDigest, formalizationReviewInput,
  prepareFormalization, readFormalizationArtifact } from '../src/math/formalization';
import { defaultFormalizationWorkflow } from '../src/math/formalizationWorkflow';
import type { FormalizationPlan } from '../src/math/formalizationPlan';
import type { FormalizationFidelity } from '../src/math/formalizationFidelity';
import { assertFormalizationReferenceResult, type FormalizationReferenceInput,
  type FormalizationReferenceResult } from '../src/math/formalizationReference';
import { assertStructuredSemanticReview, formalizationReviewInstructions,
  type StructuredReviewInput } from '../src/math/formalizationSemanticReview';
import { getStructuredFormalizationReviewOutputSchema } from '../src/math/formalizationRoleContract';
import { canonicalMathJson, mathDigest, readMathText } from '../src/math/mathRuntimeIo';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { readFormalizationState, runFormalization } from '../src/solver/formalization';
import { checkFormalizationFidelity } from '../src/solver/formalizationFidelity';
import { buildFixture, candidateFixture, fixtureStatement, semanticReviewFixture,
  syntheticElaboration } from './helpers/formalizationFixture';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const author = { model: 'preset-author', effort: 'none', profile: '/preset-author', executable: '/no-model' };
const negativeSource = 'theorem addition (n : Nat) : n + 1 = n + 1 := by sorry\n';
function fixture(policy = true, parallel = true, maxRounds = 1) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-workflow-'))); roots.push(parent);
  const { root, manifest } = buildFixture(parent), directory = path.join(parent, 'run');
  const workflow = defaultFormalizationWorkflow(author);
  if (parallel) workflow.reviewScheduling = 'parallel';
  const request = prepareFormalization(directory, {
    problemId: 'synthetic_addition', statement: fixtureStatement, environment: 'standard', execution: 'replay',
    ...author, workflow, buildManifestRef: manifest, maxRounds, maxRunSeconds: 0, maxTurnSeconds: 0,
    maxCompileSeconds: 0, maxTotalTokens: 0, ...(policy ? { fidelityPolicy: 'task-preserving-v1' } : {}),
  });
  return { root, directory, request };
}
function plan(statement: string): FormalizationPlan {
  return { schema: 'theorem-os.formalization-plan.v1', taskKind: 'prove',
    spans: [{ id: 'source', start: 0, end: statement.length, text: statement }],
    objects: [{ id: 'natural-number', spanIds: ['source'], description: 'Every natural number n.', leanType: 'Nat' }],
    assumptions: [], definitions: [], unresolved: [], conclusions: [{ id: 'zero-identity', spanIds: ['source'],
      mathematics: 'For every natural n, n + 0 = n.', targetNames: ['addition'], assumptionIds: [] }] };
}
function fidelity(input: StructuredReviewInput, source = input.observation.snapshot!.source): FormalizationFidelity {
  return { policy: 'task-preserving-v1', targets: input.observation.snapshot!.targets.map(target => ({
    targetName: target.name, originalFragment: input.original, sourceClaim: input.original,
    candidateClaim: 'For every natural n, n + 0 = n.', hypothesisScope: 'Only the natural-number domain is assumed.',
    quantifierOrder: 'The natural number is universally quantified.',
    binderIds: target.context.bindings!.binders.map(binder => binder.id),
    conclusionDependencies: target.context.bindings!.conclusionDependencies,
  })), sourceContract: { source, pairs: input.observation.snapshot!.targets.map(target =>
    ({ candidateTarget: target.name, referenceTarget: target.name })) } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function preset(options: {
  beforeRun?: (role: string, input: any) => Promise<void>;
  beforeClose?: (role: string) => Promise<void>;
  unknownReviewer?: string;
  contractSource?: string;
} = {}) {
  let sequence = 0;
  const seen: { role: string; input: any; instructions: string; schemaText: string; inputText: string }[] = [];
  const closed: string[] = [];
  const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const number = ++sequence, role = path.basename(config.workspace);
    let closePromise: Promise<void> | undefined;
    return { threadId: 'fidelity-thread-' + number, interrupt: async () => {},
      close: () => closePromise ??= (async () => { await options.beforeClose?.(role); closed.push(role); })(),
      run: async (_message, _id, workspace, onStarted) => {
        onStarted('fidelity-turn-' + number); config.onUsage({ totalTokens: 1 });
        const inputText = readMathText(path.join(workspace, 'INPUT.json'));
        const input = JSON.parse(inputText);
        seen.push({ role, input, inputText, instructions: config.instructions,
          schemaText: readMathText(path.join(workspace, 'OUTPUT.schema.json')) });
        await options.beforeRun?.(role, input);
        let output: unknown;
        if (role.startsWith('plan-')) output = plan(input.statement);
        else if (role === 'generate') output = candidateFixture(input.statement);
        else if (role === 'backtranslate') output = { snapshotDigest: input.snapshotDigest,
          mathematics: 'The natural zero identity.', assumptions: [], definitions: [],
          targets: input.targets.map((target: { name: string }) => ({ name: target.name, mathematics: 'For every n, n + 0 = n.' })) };
        else {
          const verdict = role === options.unknownReviewer ? 'unknown' : 'approved';
          const review = semanticReviewFixture(input, verdict);
          if (input.fidelityPolicy) review.fidelity = fidelity(input, options.contractSource);
          output = review;
        }
        fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), JSON.stringify(output));
        return 'completed';
      } };
  };
  return { open, seen, closed };
}
const elaborate: NonNullable<Parameters<typeof runFormalization>[2]>['elaborate'] =
  async (_directory, source, environment, options) => syntheticElaboration(source, environment, options);

// These are exact current-protocol receipts from two real sandboxed Lean 4.33
// standard-library comparisons, generated without models on 2026-10-25. The
// compilation/session adapter above is synthetic; no model-accuracy claim is made.
// Raw fixture SHA256: 173ded80d1b9743ebc049ed5b0812fc5ddc16c43e5ec274f22041c02d02a7f8e.
const savedReceipts = 'H4sIAAAAAAACA+08227byJK/wugABzZG1rDJJps0NrPIJM5OFplxEGfPi2Vk+hpzIpEaknLiSQzs02If920/aP/kfMlWN+8U5dhHdhzMoQHbIlldVV23rmaX6tMkilfrfHL4acJpLCJBc3mSrFMuJ4eT/FwmqVxaVIgoj5LY2outQ+sXmu/Dv9j6zrKtx/D/8LHFLq0sSdPLeTyZTlKpZCpjvjMiGV9EaRIvZQwMTrIcGKSpgAcrGqXZ5PC0xfQbmr6TGqyi0WZk8+HVGWBZp6skM/zR7P2BioRcRPnlwQWaXMHTJAPQC6lFk/FzuaTNRJJsppJ0SRfRH1SjO6gpzS4wEKbr/DxJAZcheRHBlC4PFpLGB6s04TLLAGYpAUYAAIc5RTE1pDnMXWarJBYa2cGFB4Aw73wNs51I+MQWUXYutQyAJf5eD0+Wq4XMzT3Anqi/yTRSEVwfKrrIJCAA3uM84ke/r6MLutCYny5otGyBLBOY+4v4Innfumks41n0DugCnSC0PeVRm3HpIhYExA9sX7quYyNbOI6wKXcF8h0cCNtxbewyGvqe74SMu0i6RLPctbCTc+p4PqB2ke9RV1Fi01CgwLEVcqgTYIbskAYhpiEhNqLU9qRA1HGQLwUPEWa+Q3yK5KbN3SXqrVbYetCSkk9cFCjihiGjnlQOsqnvBpwLZnPMbM+XDCMe2IoHBPmuo1xMMQk925ZKOYB2ES2jPNNml4OOknX+M1zYoCP68VVh98g3Vz9JmuZMUg2MbP1zdReu0dLTm+R1Baf5Meb1TPIFTY3Zw6g3hUMcnzztWO5sCIVt6NLMDBRSRbEhSBcH4HlgoGD/H6L8/CBZGd+TBzTL1stVydSgG1y1Z5I8rYjektkhFPfBrA46KlrIQj/6E0CYsJAnyYKf00iPzeXHvLwPc7iQ6ff6Iz68wDPXndkmMma1fdsOF77LPYxIEAQeC0Lp+6FyXeYGYOsKC0GoJNLjlHsuYeCvLnijH4hAMYeBBBtO6HupP87yZLloGInpUkJ4nlfB722SvQXG2EIu55N5DAxmOqRrCHuGgEG4OY9PTzXXbxcROzubxzWOkzVbRpkeoMHaMxG+pxzsEBog13cxE+CQDuLcA4+RPvfBcwIvUFxJhGzuKs8XLguE67gSYRd7/ZkcQNCLFMh/9luWtOT6aT4pWZ5PDucTVLA8nYPn8PcU3PhZlJonM43l++puBwSen57BtZ6WgR0SDTzXGDro5pOr7qw5RErkEcSUcD1Hhhx53AN9KhcU5LpUhoRhSlxJkMcQ4RA2CCjWAYulYRjK9qxrR6uNeKZ10NVkBnOQVuMJFegcfEENL9Cv0mSl1+Z6odb6lbEYxNKeHLAtGKMCsNpOwBxfhMz1Icqx0MVCQVhUMDmsCCEhUb4Dq4oknic584m0XTo4uX9LFuLL86rBd5pXC0vH6UIVKi6cEHlBoCgTyhWcwyLiiyAEFQllY8k8hGGNUaBV2yMYex52acAxRc6w0mAdpymkCnFvdtFylaS59RJuzuPyYlPVm4+0oOZxJvO3iQlLVmfJsIoVow/wWvJncpWfWx5yOs9Wq5laLxa/aFFbebqW/adxkps4a5nsYR6n6/gtXwrD9+xoQdkMZgg+CcqLVP5Gpkt982dLJPPYsiCDscBziqTL6ElHjMNitCa6X10YVHr4rMFRPPi4SrU6C4QFyihWifX3//qfAgIWuqdJnOUv9F3juzVglgA5SI7WUqPQw2bm6l+tz1Z+niYfjtI0SSGArVIpIg4CL6HXMb2gEXCxkDqiVfj4AjJL0ZD+WeYUIsCSCfpGwgrAk1WFQa1j62NmsURcWo9/aIEv3z9PUrpYPP8bTbMKpCEB1kKXmWZ3z4zhyWIhef5SXsjFq+LZp6uSkf1ZAQ2h/WWU5Q2ShYY2SEqAP6LVC/HR+vzDbElXhre9t1Mr2q9ZM/gLdCVhrR5g9iTSiaiVParD4fHJ+lN0NZ/sN/Rg2V0vck2vYGwWxTqjyiOQaJvzcnIFe8XwdQxyy6y9rkyjzLhxgXcflN9VV27SGyvKLLBPi1Z6aZlapbVIlUhm5zT7GURuff7cuqOVAKhl3MUPaoQ7BZF1nK1X2gelqJCmMl+ncYmmsnNGM9hoxNLaa1v8YWPF19r6j5Aq9M08oxcbxqbvneQmMmiwPC1Nx2rBKGNftUG+lmLNo/hdxxNL8+RJzBfrYqX/oSZem3vztMvFh/NYtZ42o6L2bdCiccxjZf366xsILoWkS+kV0WbbwCer1bF6ojdbMPbod8s1Yxt4M6JvM8+kAtAWHrpaPY8f6X9P0nePek/Mre0cgRStjxAztJjagilEk1+Cp/foxxCi3+j7H3t87g1ITyPY70jouY6w1zA0hKr0E4PM+utfNx8XIjHcNrPfv4ZKebMM90YQehu7uCzMEbLqLIcoUEd3sOB1uUSA4UtIA9uUBu3fsKb/bAnxLUlBLv4y4XShM/5n1q9VWm5VlLQZ1zc7FqyZKyJxVyQ952jzqpFdNiG77w2p5Bbs59/BRI08O1Pbg2ABAdd6kqb0svNgrSNT9UC7+ZAc9jbGteRR/Cxpzs+NJmfnkoofYZyl5dOG+WyV8zuy3sLwJWw9dJTK4erxD23Awrwjbd6nh5fZLIv+kGc9gqXFaf5Po7PSVUBceRR3zfIW8ar5aUWuG/h0OZe9bR53mWkW9zeCRM+q9fBShVos7WUK1TiMKmerdXbe3NJCmEFm9Ahkpv1lv0+EG+1oMVurdQqLwAbEhvu0ZNFee1gEuW1qseg3WPa1WQ7kIpW2y3W3r9tyTTVMgzFYkbgmNpQ4tNXvD1hAh7eWsySaxR6nIlKgkKzLZS18LdauRxmfaXRSOfVfTs9KhwBxrRZFXlYaaRGYWsJtJ1YvTSZWJFbgyEUes3wPa8kvTZTQRPc3F83u6L+cVvBnRRQZiHfZPxLw9o6L1HqviXz/97+tIR3Hb/mIpg0u+4GmhYe14+4mF+1RDHa3g8NaTJcYqmGlwkz2vFdSndaISuG1LL6Ej5NYtrL+CzmU7w/JrMzQb5gq/Ucc5f1UqQjIjxsMdRzcXDNahA34j8aM9e5hBptKWqZ0rUT61Y1S8mJBH0jIzRjYquo1zNqb5edL8+mT2atM2ySmBsm0lMfVfiVM8ALwUhnXdve2msvbO7O8+uLfYa9amKEJZG2lguloXiAX7i11eoweAZ5bGwCN0tcG1hjeXnaefPjCVs9gUWmy7Ki298JTk5nXrzXbm7Pey8/tgHoaxau8Agb2EAetN3p90OJ9YQHa2gwcFPuDPnTDbmmSALCBsGJ0K0iN5cdqVwFgrZxsA9UX4NqvOheXR7+v6WILZBHUX7XixDbKbZvsvnrdMiRPaZyZE5bCjCt/1Xqf0TStzGcj8NXSKGJY+4XCfLL5umrWKB0c0YSdNrZaZtdiq1+4XINtQ9e9JXa1Mp5Vg0F4gFCZXzZxtmcIw+NrsP74TSvR4+uNKG/eIvXoDcOnzXuxAn7IarbsuWoNbSDRm5ZNRs0uvMeN2cE8GiJablcaP6x4PsjT6CKiiyblkIuslV0VSXNv5cuG2O3l0p9N4OtlVg22fkT+MsIWys5MdPDpTvlA6jn3U73OYvxKn4I0K3J5Cf4FNrKRDZZL8fx2pzqNtQ9Ors3ILckNnsu0yDVEGsKdmfazy+sDUX8TbQ3FISO6LlR7hRhYHRryjS7N1MVBl6MDWKLLo4mtZ0ttpDdQdV/HX1XDX1e/g8tRX6U3UlWjKIhIW4PM/JangvOJiThm32a2QRfyoOD5oBVxvqj4bdtHvV6JKC33V1U6fQJRL363311Al++P2W/Wv3y2TkE3hUTmk2kBkCcmtyru7k+19gpx9CGKu/tn1nffVbLbA3GVAn68IeBCaJpi/2C2j1mzDniNsE7P9jsvUvuTOK1pz/vn3X20vcfV3DqZ4OYkO4/3p4PkYEneTkzn+j1SA/Cdh8NkqrVvK6l6ceyS2zZuc1Ftkx0w+z6CAZCC9IYn9kduAHRIXxemNyexHbZgphfCNYLerS1abeKfHtO41q1jZ29ymyHvpvi3hMv9wkfq7dbj6mPxZqrZXrU2iXqzVe9S2/6kI4IpdupLet6qfaoZOShQzS6wnqaenyk/GdCS5gcYnelqJZiTeb1jTlzM+HWugh8vc3mi39v8UB5N2gPHLc2KUE6CJetYWPIjl1JUcdyQXiTvzDHf8hEI9Kej49dHPx+fvH199Pzo9dEvT4/g06vj128OPxV4rlojQerSnFG+ONYfdaB8cTx7fjL7kEJIfh4tdAwvigM2BPGbiZQlc91D49BljvC556lAcoeGmCOXh65PKA6k/vEw9ZhETCiHwBhHYZdIXRbEhSSOZ0rW5EUkqmocXTPyolx1AL9iDPmujQSSdiCEwISHiGDASJTnYUaEHVJfSub4XGLJgB+OsesQjzo08H3Nq6mdqmuZfIUd6kiGiOdSSqjkjGCFcEiIwAIJhjhCth9KQj1XBvDUVb6NpUv1M0G2lEgR5BCiQik4MBIg4TiIIOUHTgCfMLOJBLZc4iFXIk9yLjhzYHKuIxVzAqEZXYDlZ6ZokTKzxa5r1m5SeQdplorerauyoNNPE1HxtnM5zXRLWY8+8a+p7FzqMh0u2WkTideLxSaYqSzo8LJzAcr0mqKbrQx1amsOdJFTCoadlaPA0EVE38VJlkf8SZpHivK8KmpbQSJgiiV00ePkUGd402Y6ASc4tAPKCMFIEY8zMCkXaSOVEhTohQIsyxEBRxIsDrshfHQpCbnHKPb8+7PZFc3P65k30zug1fy+35X3qtDprt1Ya/FLcicKggoPPc9FnAQChIVR4EBEQz7ggkATwAOwMUm4wDYVIULUI9jxhe0LAH1Iue/K+0PK3bepjglBWVeKmYMhjIBQEA88EehFx4YYBjJULuEq4BJWFuqpEIIbyDJ8SLnvyvu9yf3s3oQiP0b500RIU9Cbyt/XgFmK52VN6PZiMOBooAbdrDGNaLODYl2cXaB7WcwLjM/rAtbG+Xet85t+qYSxs2TtXH43vaaosENp55xt+sUyP21sus5bHOtvYZRZzF2ndleQGHWW0btcL5u62jIZm1fzmDfpmCmBHUzITKFsL8zNyzhXP3ipa+LhLi52BvBgw0ENhV1d1DBTOelce+ncaNAg32KcZswSZtKuDK42UYfza/wVHNUMLhzr6Rp2e3HezL3twQbTrj7cIma8WDMLahMt+e3oyYbClwUGTtYhu6tHbyFbe/UmxV09e9tEu9491+6t37EJSHANZKECc118R8Xcla7+cgh2Qkj6QYcYZskU5kEY+oqFZqsgMZLYx6FWBKc49MIQMQILIQs8r8KarPMOFbi+aypVrGo5eTtaGUK7xisQWzcO30F2+c8XpVrWPwaoMUCNAeoeA9QdbMP+CdOovi2OYWoMU99UmPo0nxe+ow+x5voW/NG/U/0HFEHru9edMcyLn/JwpLzQJlN+3Dwwq2AKCy6vNo8CrwcrzzQroOpDXaVUXg8MbJ19VaObSfSPb/v4b3c81meiPG3uI73lWXsfa3nK3cfaPqEub10NiEMf2PaH/v2//7P5MuHUOvrd2vvpiRCzc/hjxZa9b21yMXSoOqjCzcPb68Fuq+nBU8i70/TwQeW3q+nu0fxdaPraM+yKQLm6l5f9g+o6TJzp2FfNrlgO+yxefzRbzbcOXDIWr5KsVvaEJ4v1sghwxACUJjc5DIyQTIDWJTl1tNsaqCsSUXYCY+K8O9HJeylXz9eLxWsav5P9ZxAFawKnNE7iy2Wyzs5qnKstPNuDPGfyQpqUqUKpv9RZSrcURzychjoOwZRDfiSQo5M44QgXVhYhKVeIwT4UCw8HSrq+xyBLDAn2Q6yEF9hI0rBMD75aGnqmXyRrVb+pE8jyEN4kJQPFGE1SuFFasvGoqos5bBdIT7fVSRx+GirvObx1ycS0qTo6vH2d1bSpajrsVSFdTTcKdw5v5uEa62BRTCWygYKbjUfbpDlcFXJraW4pELlXafbKmm4hzevrfBqv6RfwlBFxeGswWJpyNal8pO4Lw5FiQngeC1xwKyckPnGp9B2sPN8VPrOZj5UTeL7jBZwSL/BtwUXog3tixbg3ubqaTmL5juo6vhffQgslZD0u/39TbZQqGX07bZR6X+J4iFZKzHUF9hiWsILAZtAmBJYT5CMsA8I5sl0hHEUx7FWUZ7NQUlhZbIcTT8CeRaiHaaXkM+wgm2HkM3CXADaNtg/bXBz6IeyxXAV7ZNcTkrsAbjMvRLAUwkOHwO4LllI0tlJqtVKqWwv1v59wnaVe0+3oH8M3NiQaGxKNDYm+yYZE9XJ+06ZEgXCwJwPEPOEEKJDS0zxDQgNrC4Ro6SnbxyhUsMy43KeYUhpgTITDIbCKLXMbmxKNTYnGpkRjU6KxKdHYlGhsSjQ2JRqbEo1NicamRGNTorEp0diUaGxKNDYlGpsSjU2JxqZEY1OisSnR2JRobEo0NiUamxKNTYnGpkRjU6KxKdHYlOh+mhJh4jiuAwCu6zHqSOLCKMldz/ERkECIUyd0AikIkkQiW3iSSqxIiH3KvJCPTYnGpkRfuykRET7yFbDOVRiokIsAc8Yl+AGIlsCVxMS3iY8cAfMmSmJPcdfXXzwTnhOoB22OsyPvW5q07OzGN2mOg32OlI1tQUmAXdsGUQWECs/2lQwkDRyuFIEABZwE1LdBbpz7gvnCly588B5S7rvy/pByt2XIbMAulIK4YftgCRxLriDW20HoY0ypSxRWsC4wrFBIfL0IBNzGrqeY4A8p9115vze5/xmbEt3BYv6tNCXaufxubEp0l+vl2JToa32Zflcf/ma/TL+rR49fpv9z9/y4g+xybEo0BqgxQI0B6n4C1B1sw8amRGOYGsPU2JSo0/6l27fk2+hKtKWZzEahzQ3bxfRr6h64OVBX4t9Gd6CvLfGdmvSg/f712LLnz9SyBwcsYMxxXYoJZDvUCxhszgiDLZpkXEnMvZBym2EcYAirACdsAc8VAEIgVt98y56Kofvp2dNqD7NZmthtALNRbXwfLXWq2d5PT51dZ3vrljcD0efBG+AoHIIJIw9RWzHf9kLkQDpCWciw4yKH647wjm3rM9hQIO5hHymb2BKHvh0yD0+urq7+H1n8Rc09kAAA';
function receiptFixture() {
  const bytes = gunzipSync(Buffer.from(savedReceipts, 'base64'));
  expect(mathDigest(bytes)).toBe('173ded80d1b9743ebc049ed5b0812fc5ddc16c43e5ec274f22041c02d02a7f8e');
  return JSON.parse(bytes.toString('utf8')) as { input: FormalizationReferenceInput; positive: FormalizationReferenceResult;
    negativeInput: FormalizationReferenceInput; negative: FormalizationReferenceResult };
}
function comparisonAdapter(negative = false) {
  const saved = receiptFixture(), calls: FormalizationReferenceInput[] = [];
  const input = negative ? saved.negativeInput : saved.input, receipt = negative ? saved.negative : saved.positive;
  assertFormalizationReferenceResult(input, receipt);
  const compare: NonNullable<Parameters<typeof runFormalization>[2]>['compareReference'] = async (_directory, current) => {
    // Exact input equality is required. No saved response is adapted to a new input.
    expect(current).toEqual(input); calls.push(current);
    return structuredClone(receipt);
  };
  return { compare, calls };
}

describe('frozen fidelity policy and parallel formalization workflow', () => {
  it('requires fidelity only for opted-in inputs and preserves legacy input, output, schema and instructions', () => {
    const f = fixture(false, false), candidate = candidateFixture();
    const snapshot = syntheticElaboration(candidate.source, 'standard', { detailedContext: true,
      semanticContext: true, structureContext: true }).snapshot;
    const translation = { snapshotDigest: formalizationDigest(snapshot), mathematics: fixtureStatement,
      assumptions: [], definitions: [], targets: [{ name: 'addition', mathematics: fixtureStatement }] };
    const legacy = formalizationReviewInput(f.request, candidate, snapshot, translation);
    const oldInputText = canonicalMathJson(legacy), oldReview = semanticReviewFixture(legacy);
    const oldOutputText = canonicalMathJson(oldReview), oldSchema = getStructuredFormalizationReviewOutputSchema(legacy);
    expect(canonicalMathJson(assertStructuredSemanticReview(legacy, oldReview))).toBe(oldOutputText);
    expect(canonicalMathJson(legacy)).toBe(oldInputText);
    expect(legacy).not.toHaveProperty('fidelityPolicy'); expect(oldReview).not.toHaveProperty('fidelity');
    expect(oldSchema.required).not.toContain('fidelity');
    // Normalize only input-bound identity constants to freeze the old schema bytes.
    oldSchema.properties!.caseId = { const: 'case_' + 'a'.repeat(64) };
    oldSchema.properties!.inputDigest = { const: 'b'.repeat(64) };
    expect(mathDigest(canonicalMathJson(oldSchema))).toBe('84772942f1c05965472bd77c882a13a795146b1b2b6175407d7cc540c1a374f9');
    expect(mathDigest(formalizationReviewInstructions('review', true, true)))
      .toBe('668e8a831b5502519b1f768b7f7740b10dffee08b85df72cfbdb2163731bf600');
    const current: StructuredReviewInput = { ...legacy, fidelityPolicy: 'task-preserving-v1' };
    const newReview = semanticReviewFixture(current);
    expect(() => assertStructuredSemanticReview(current, newReview)).toThrow();
    newReview.fidelity = fidelity(current);
    expect(assertStructuredSemanticReview(current, newReview)).toEqual(newReview);
    expect(getStructuredFormalizationReviewOutputSchema(current).required).toContain('fidelity');
    const unsolicited = { ...oldReview, fidelity: fidelity(current) };
    expect(() => assertStructuredSemanticReview(legacy, unsolicited)).toThrow();
  });

  it('starts both reviewers before release and assembles reverse completions in configured order', async () => {
    const f = fixture(), first = deferred(), second = deferred(), adapter = comparisonAdapter();
    const agent = preset({ beforeRun: async role => {
      if (role === 'compare-reviewer-1') await first.promise;
      if (role === 'compare-reviewer-2') await second.promise;
    } });
    let settled = false;
    const running = runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      compareReference: adapter.compare }).finally(() => { settled = true; });
    try {
      await expect.poll(() => agent.seen.filter(item => item.role.startsWith('compare-')).length).toBe(2);
      expect(agent.closed.filter(role => role.startsWith('compare-'))).toEqual([]);
      second.resolve();
      await expect.poll(() => agent.closed.includes('compare-reviewer-2')).toBe(true);
      expect(settled).toBe(false);
      first.resolve();
      expect(await running).toMatchObject({ status: 'approved', modelInvoked: false, firstCandidateApproved: true });
      const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
      expect(evidence.workflow!.reviews.map(item => item.reviewerId)).toEqual(['reviewer-1', 'reviewer-2']);
      expect(evidence.sessions.filter(item => item.role === 'compare').map(item => item.reviewerId))
        .toEqual(['reviewer-1', 'reviewer-2']);
      expect(agent.closed.filter(role => role.startsWith('compare-'))).toEqual(['compare-reviewer-2', 'compare-reviewer-1']);
      expect(adapter.calls).toHaveLength(2);
      const reviews = agent.seen.filter(item => item.role.startsWith('compare-'));
      expect(reviews.every(item => item.input.fidelityPolicy === 'task-preserving-v1')).toBe(true);
      expect(reviews.every(item => JSON.parse(item.schemaText).required.includes('fidelity'))).toBe(true);
      expect(reviews.every(item => !('reviews' in item.input) && !('verdict' in item.input))).toBe(true);
      expect(new Set(evidence.sessions.map(item => item.threadId)).size).toBe(5);
      expect(agent.closed).toHaveLength(5);
      expect(agent.seen.every(item => item.instructions.includes('Mathlib is unavailable and /opt/lean-packages is not mounted.'))).toBe(true);
      expect(agent.seen.every(item => !item.instructions.includes('pinned Mathlib and dependencies are in /opt/lean-packages'))).toBe(true);
      expect(agent.seen.find(item => item.role.startsWith('plan-'))!.instructions).toContain('Inspect declaration types only when necessary');
      expect(agent.seen.find(item => item.role === 'generate')!.instructions).toContain('changing comments or notes does not require another check.');
      expect(() => assertFormalizationEvidence(evidence)).not.toThrow();
    } finally { first.resolve(); second.resolve(); await running; }
  });

  it('joins a still-closing reviewer after the other fails before ending the round', async () => {
    const f = fixture(), releaseFailure = deferred(), releaseClose = deferred(), closeStarted = deferred();
    const agent = preset({ unknownReviewer: 'compare-reviewer-2', beforeRun: async role => {
      if (role === 'compare-reviewer-1') { await releaseFailure.promise; throw new Error('disposable_reviewer_failure'); }
    }, beforeClose: async role => {
      if (role === 'compare-reviewer-2') { closeStarted.resolve(); await releaseClose.promise; }
    } });
    let settled = false;
    const running = runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      compareReference: async () => { throw new Error('Unresolved review must not run correspondence.'); } })
      .finally(() => { settled = true; });
    try {
      await expect.poll(() => agent.seen.filter(item => item.role.startsWith('compare-')).length).toBe(2);
      await closeStarted.promise;
      releaseFailure.resolve();
      await expect.poll(() => agent.closed.includes('compare-reviewer-1')).toBe(true);
      expect(settled).toBe(false); expect(agent.closed).not.toContain('compare-reviewer-2');
      releaseClose.resolve();
      expect(await running).toMatchObject({ status: 'exhausted', error: 'disposable_reviewer_failure' });
      expect(agent.closed).toHaveLength(5);
      expect(agent.closed).toContain('compare-reviewer-2');
      expect(readFormalizationState(f.directory).activeSince).toBeUndefined();
      expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
    } finally { releaseFailure.resolve(); releaseClose.resolve(); await running; }
  });

  it('keeps approved model reviews unresolved when complete correspondence is not established', async () => {
    const f = fixture(true, true, 2), agent = preset({ contractSource: negativeSource }), adapter = comparisonAdapter(true);
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      compareReference: adapter.compare });
    expect(result).toMatchObject({ status: 'exhausted', candidatesTried: 2, firstCandidateApproved: false });
    expect(result.error).toContain('formalization_fidelity_not_established');
    expect(result.error).toContain('not proof of inequivalence');
    expect(adapter.calls).toHaveLength(4);
    const state = readFormalizationState(f.directory);
    expect(state.rejectedCandidates ?? []).toEqual([]);
    const rounds = fs.readdirSync(f.directory).filter(name => name.startsWith('round-'));
    expect(rounds).toHaveLength(2);
    for (const round of rounds) {
      const saved = JSON.parse(readMathText(path.join(f.directory, round, 'reviews.json')));
      expect(saved.decision.verdict).toBe('approved');
      expect(saved.reviews.map((item: any) => item.review.verdict)).toEqual(['approved', 'approved']);
      expect(saved.reviews.every((item: any) => item.correspondence.status === 'not-established')).toBe(true);
      expect(saved.reviews.every((item: any) => Object.values(item.review.checks).every(value => value === 'faithful'))).toBe(true);
    }
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
    expect(fs.existsSync(path.join(f.directory, 'workspace'))).toBe(false);
    expect(agent.closed).toHaveLength(10);
  });

  it('revalidates persisted correspondence against generated sources despite recomputed local digests', async () => {
    const f = fixture(), agent = preset(), adapter = comparisonAdapter();
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      compareReference: adapter.compare })).toMatchObject({ status: 'approved' });
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    const modified = structuredClone(evidence), correspondence = modified.workflow!.reviews[0]!.correspondence!;
    const query = correspondence.files.find(file => file.file === 'ReferenceComparison.lean')!;
    query.text += '\n-- changed query\n'; query.sha256 = mathDigest(query.text);
    expect(() => assertFormalizationEvidence(modified)).toThrow('formalization_reference_evidence_invalid');

    const changedClaim = structuredClone(evidence), sourceReview = changedClaim.workflow!.reviews[0]!.review;
    if (!('fidelity' in sourceReview) || !sourceReview.fidelity) throw new Error('Missing fixture fidelity.');
    sourceReview.fidelity.sourceContract!.source = negativeSource;
    changedClaim.review = sourceReview;
    changedClaim.sessions[3]!.outputDigest = formalizationDigest(sourceReview);
    expect(() => assertFormalizationEvidence(changedClaim)).toThrow('formalization_reference_evidence_invalid');

    const round = fs.readdirSync(f.directory).find(name => name.startsWith('round-'))!;
    const directory = path.join(f.directory, round, 'fidelity-reviewer-1'), file = path.join(directory, 'comparison.json');
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, canonicalMathJson(correspondence)); fs.chmodSync(file, 0o400);
    const reviewedInput = agent.seen.find(item => item.role === 'compare-reviewer-1')!.input;
    const review = evidence.workflow!.reviews[0]!.review;
    if (!('schema' in review)) throw new Error('Missing structured review.');
    await expect(checkFormalizationFidelity(directory, reviewedInput, review, { env: {}, timeoutMs: 0,
      restoreOnly: true, compareReference: async () => { throw new Error('Must validate saved evidence without recomparing.'); } }))
      .rejects.toThrow('formalization_reference_evidence_invalid');
  });
});
