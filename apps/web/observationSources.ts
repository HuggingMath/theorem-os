import { mathDigest } from '../../src/math/mathRuntimeIo';
import type { WebNativeTeam, WebObservation, WebTaskSource, WebTeamProof } from './collaboration';

type SourceReference = { sha256: string };
type TaskSourceWithText<Text> = Omit<WebTaskSource, 'source' | 'dependencySources'> & {
  source: Text; dependencySources?: { file: string; source: Text }[];
};
type ObservationWithSource<Text> = Omit<WebObservation, 'sources'> & { sources: TaskSourceWithText<Text>[] };

export type CompactWebTaskSource = TaskSourceWithText<SourceReference>;
export type CompactWebObservation = ObservationWithSource<SourceReference>;
type TeamProofWithSource<Text> = Omit<WebTeamProof, 'sources' | 'declarations'> & {
  sources: { file: string; source: Text }[];
  declarations: (Omit<WebTeamProof['declarations'][number], 'checkedSource'> & { checkedSource?: Text })[];
};
type NativeTeamWithSource<Text> = Omit<WebNativeTeam, 'tasks' | 'deliveries' | 'adoptions'> & {
  tasks: (Omit<WebNativeTeam['tasks'][number], 'rejection'> & { rejection?: TeamProofWithSource<Text> })[];
  deliveries: (Omit<WebNativeTeam['deliveries'][number], 'proof'> & { proof?: TeamProofWithSource<Text> })[];
  adoptions: (Omit<WebNativeTeam['adoptions'][number], 'proof'> & { proof?: TeamProofWithSource<Text> })[];
};
/** Older v2 archives kept native team source inline. */
export type ArchivedWebObservation = Omit<CompactWebObservation, 'inspection'> & {
  inspection: Omit<WebObservation['inspection'], 'nativeTeam'> & { nativeTeam?: NativeTeamWithSource<string | SourceReference> };
};
export type WorkerObservationFrame = {
  type: 'observation';
  observation: CompactWebObservation;
  sourceBlobs: Record<string, string>;
};

export const maxWorkerObservationBytes = 15 * 1024 * 1024;

/** A standalone frame includes every referenced blob, unlike a frame on an open stream. */
export function standaloneObservationFrame(observation: WebObservation): WorkerObservationFrame {
  const sourceBlobs: Record<string, string> = {};
  const compact = compactObservation(observation, (digest, source) => { sourceBlobs[digest] = source; });
  return { type: 'observation', observation: compact, sourceBlobs };
}

function mapSources<From, To>(observation: ObservationWithSource<From>, map: (source: From) => To): ObservationWithSource<To> {
  return {
    ...observation,
    sources: observation.sources.map(({ source, dependencySources, ...metadata }) => ({
      ...metadata, source: map(source),
      ...(dependencySources === undefined ? {} : {
        dependencySources: dependencySources.map(dependency => ({ ...dependency, source: map(dependency.source) })),
      }),
    })),
  };
}

function sourceCompactor(save: (digest: string, text: string) => void) {
  const digests = new Map<string, string>();
  return (source: string): SourceReference => {
    let sha256 = digests.get(source);
    if (!sha256) {
      sha256 = mathDigest(source);
      digests.set(source, sha256);
      save(sha256, source);
    }
    return { sha256 };
  };
}

export function compactObservation(observation: WebObservation, save: (digest: string, text: string) => void): CompactWebObservation {
  return mapSources(observation, sourceCompactor(save));
}

function sourceHydrator(read: (digest: string) => string | undefined) {
  return (source: string | SourceReference): string => {
    if (typeof source === 'string') return source;
    if (typeof source?.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(source.sha256))
      throw new Error('web_observation_source_reference_invalid');
    const text = read(source.sha256);
    if (text === undefined) throw new Error('web_observation_source_blob_missing');
    return text;
  };
}

/** Legacy records inline their sources. References must all resolve before handing the observation to a consumer. */
export function hydrateObservation(observation: WebObservation | CompactWebObservation,
  read: (digest: string) => string | undefined): WebObservation {
  return mapSources(observation, sourceHydrator(read));
}

function mapTeamSources<From, To>(team: NativeTeamWithSource<From>, map: (source: From) => To): NativeTeamWithSource<To> {
  const mapProof = ({ sources, declarations, ...proof }: TeamProofWithSource<From>): TeamProofWithSource<To> => ({
    ...proof,
    sources: sources.map(({ source, ...file }) => ({ ...file, source: map(source) })),
    declarations: declarations.map(({ checkedSource, ...declaration }) => ({
      ...declaration, ...(checkedSource === undefined ? {} : { checkedSource: map(checkedSource) }),
    })),
  });
  return {
    ...team,
    tasks: team.tasks.map(({ rejection, ...task }) => ({ ...task, ...(rejection ? { rejection: mapProof(rejection) } : {}) })),
    deliveries: team.deliveries.map(({ proof, ...delivery }) => ({ ...delivery, ...(proof ? { proof: mapProof(proof) } : {}) })),
    adoptions: team.adoptions.map(({ proof, ...adoption }) => ({ ...adoption, ...(proof ? { proof: mapProof(proof) } : {}) })),
  };
}

/** Share source references across archive frames, including native team proof evidence. */
export function archiveObservationCompactor(save: (digest: string, text: string) => void) {
  const reference = sourceCompactor(save);
  return (observation: WebObservation): ArchivedWebObservation => {
    const { nativeTeam, ...inspection } = observation.inspection;
    return { ...mapSources(observation, reference),
      inspection: { ...inspection, ...(nativeTeam ? { nativeTeam: mapTeamSources(nativeTeam, reference) } : {}) } };
  };
}

export function hydrateArchiveObservation(observation: ArchivedWebObservation, read: (digest: string) => string | undefined): WebObservation {
  const resolve = sourceHydrator(read);
  const { nativeTeam, ...inspection } = observation.inspection;
  return { ...mapSources({ ...observation, inspection }, resolve),
    inspection: { ...inspection, ...(nativeTeam ? { nativeTeam: mapTeamSources(nativeTeam, resolve) } : {}) } };
}
