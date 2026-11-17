import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentWorkerProject, writeWorkerProject } from '../src/solver/workerProject';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-project-')));
  roots.push(root);
  const project = path.join(root, 'generated/problem');
  fs.mkdirSync(project, { recursive: true });
  return { root, project };
}

describe('shared worker project location', () => {
  it.each(['generated/problem', '', '.'])('resolves a skill/team project without cooperative metadata (%s)', relative => {
    const { root, project } = fixture();
    writeWorkerProject(root, relative);
    expect(currentWorkerProject(root)).toBe(relative === 'generated/problem' ? project : root);
    expect(fs.existsSync(path.join(root, 'COOPERATION.json'))).toBe(false);
  });

  it('retains the legacy cooperative lookup when no common location is present', () => {
    const { root, project } = fixture();
    fs.writeFileSync(path.join(root, 'COOPERATION.json'), JSON.stringify({ researchDelivery: { projectRelative: 'generated/problem' } }));
    expect(currentWorkerProject(root)).toBe(project);
  });

  it('refreshes the common location without reading stale cooperative context', () => {
    const { root, project } = fixture();
    fs.writeFileSync(path.join(root, 'COOPERATION.json'), 'stale context');
    writeWorkerProject(root, 'generated/problem');
    expect(currentWorkerProject(root)).toBe(project);
    writeWorkerProject(root, '');
    expect(currentWorkerProject(root)).toBe(root);
  });

  it.each(['../outside', '/outside'])('rejects an out-of-worktree project (%s)', relative => {
    const { root } = fixture();
    expect(() => writeWorkerProject(root, relative)).toThrow(/math_worker_project_(?:outside_worktree|missing)/u);
    expect(fs.existsSync(path.join(root, '.scratch/worker-project.json'))).toBe(false);
  });

  it('refuses a tampered common location instead of falling back to cooperative context', () => {
    const { root } = fixture();
    writeWorkerProject(root, 'generated/problem');
    fs.writeFileSync(path.join(root, 'COOPERATION.json'), JSON.stringify({ researchDelivery: { projectRelative: 'generated/problem' } }));
    const metadata = path.join(root, '.scratch/worker-project.json');
    fs.chmodSync(metadata, 0o600);
    fs.writeFileSync(metadata, JSON.stringify({ schema: 'theorem-os.worker-project.v1', projectRelative: '../outside' }));
    expect(() => currentWorkerProject(root)).toThrow('math_worker_project_outside_worktree');
    fs.writeFileSync(metadata, JSON.stringify({ schema: 'unknown', projectRelative: 'generated/problem' }));
    expect(() => currentWorkerProject(root)).toThrow('math_worker_project_invalid');
  });

  it('rejects linked project and metadata paths', () => {
    const { root, project } = fixture();
    fs.symlinkSync(project, path.join(root, 'linked-project'));
    expect(() => writeWorkerProject(root, 'linked-project')).toThrow('math_path_invalid');
    fs.symlinkSync(project, path.join(root, '.scratch'));
    expect(() => writeWorkerProject(root, 'generated/problem')).toThrow('math_path_invalid');
    expect(() => currentWorkerProject(root)).toThrow('math_path_invalid');
    expect(fs.readdirSync(project)).toEqual([]);
  });
});
