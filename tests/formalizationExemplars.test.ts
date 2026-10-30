import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formalizationExemplarCorpusSchema, formalizationExemplarInput, prepareFormalizationExemplars,
  selectFormalizationExemplars, type FormalizationExemplarCorpus } from '../src/math/formalizationExemplars';
import { mathDigest } from '../src/math/mathRuntimeIo';

const roots: string[] = [];
afterEach(() => { for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

const corpus: FormalizationExemplarCorpus = { schema: 'theorem-os.formalization-exemplar-corpus.v1', provenance: 'unit fixture',
  items: [
    { id: 'group-order', statement: 'Prove that a group of even order contains an element of order 2.',
      lean: 'theorem a {G : Type*} [Group G] [Fintype G] (h : Even (Fintype.card G)) : ∃ x : G, orderOf x = 2 :=' },
    { id: 'polynomial', statement: 'Prove that $x^3 + 6x + 12$ is irreducible in $\\mathbb{Q}$.',
      lean: 'theorem b : Irreducible (12 + 6 * X + X ^ 3 : Polynomial ℚ) :=' },
    { id: 'center', statement: 'Prove that an element of order 2 that is unique lies in the center of the group.',
      lean: 'theorem c {G : Type*} [Group G] {x : G} (hx : orderOf x = 2) : x ∈ Subgroup.center G :=' },
    { id: 'ideal', statement: 'Let $I, J$ be ideals in a ring $R$. Prove the residue is nilpotent.',
      lean: 'theorem d {R : Type*} [CommRing R] (I J : Ideal R) : True :=' },
  ] };

describe('frozen formalization exemplars', () => {
  it('ranks by statement similarity and breaks ties by corpus order', () => {
    const selected = selectFormalizationExemplars(corpus, 'Prove that a unique element of order 2 lies in the center.', 2);
    expect(selected.items.map(item => item.id)).toEqual(['center', 'group-order']);
    expect(selected.items[0].score).toBeGreaterThan(selected.items[1].score);
    expect(selected.items.every(item => item.score > 0 && item.score <= 1)).toBe(true);
    const tie = selectFormalizationExemplars(corpus, 'Unrelated words only.', 4);
    expect(tie.items.map(item => item.id)).toEqual(['group-order', 'polynomial', 'center', 'ideal']);
    expect(tie.items.every(item => item.score === 0)).toBe(true);
  });

  it('never hands a problem its own pair, whether excluded by id or present verbatim', () => {
    const own = corpus.items[1].statement;
    const selected = selectFormalizationExemplars(corpus, own, 3);
    expect(selected.items.map(item => item.id)).not.toContain('polynomial');
    expect(selected.excludedIds).toEqual(['polynomial']);
    const byId = selectFormalizationExemplars(corpus, 'Prove a group of even order has an element of order 2.', 3, ['group-order']);
    expect(byId.items.map(item => item.id)).not.toContain('group-order');
    expect(byId.excludedIds).toEqual(['group-order']);
  });

  it('rejects unknown exclusions, bad counts and too small corpora instead of silently selecting fewer', () => {
    expect(() => selectFormalizationExemplars(corpus, 'x', 1, ['typo'])).toThrow('formalization_exemplar_exclusion_unknown:typo');
    expect(() => selectFormalizationExemplars(corpus, 'x', 0)).toThrow('formalization_exemplar_count_invalid');
    expect(() => selectFormalizationExemplars(corpus, 'x', 33)).toThrow('formalization_exemplar_count_invalid');
    expect(() => selectFormalizationExemplars(corpus, corpus.items[0].statement, 4)).toThrow('formalization_exemplar_corpus_too_small');
    expect(() => formalizationExemplarCorpusSchema.parse({ ...corpus, items: [corpus.items[0], corpus.items[0]] })).toThrow('unique');
  });

  it('freezes the corpus identity with the selection and exposes only the pairs to roles', () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-exemplars-'))); roots.push(parent);
    const file = path.join(parent, 'corpus.json'), text = JSON.stringify(corpus);
    fs.writeFileSync(file, text);
    const frozen = prepareFormalizationExemplars({ corpusFile: file, count: 2, excludeIds: ['ideal'] }, 'An ideal of a ring and a group.');
    expect(frozen).toMatchObject({ schema: 'theorem-os.formalization-exemplars.v1', algorithm: 'tfidf-cosine-v1',
      corpusSha256: mathDigest(text), corpusSize: 4, provenance: 'unit fixture', excludedIds: ['ideal'] });
    expect(frozen.items).toHaveLength(2);
    expect(formalizationExemplarInput(frozen)).toEqual(frozen.items.map(({ id, statement, lean }) => ({ id, statement, lean })));
  });
});
