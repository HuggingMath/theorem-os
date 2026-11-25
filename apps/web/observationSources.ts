import { mathDigest } from '../../src/math/mathRuntimeIo';
import type { WebObservation, WebTaskSource } from './collaboration';

type SourceReference = { sha256: string };
type TaskSourceWithText<Text> = Omit<WebTaskSource, 'source' | 'dependencySources'> & {
  source: Text; dependencySources?: { file: string; source: Text }[];
};
type ObservationWithSource<Text> = Omit<WebObservation, 'sources'> & { sources: TaskSourceWithText<Text>[] };

export type CompactWebTaskSource = TaskSourceWithText<SourceReference>;
export type CompactWebObservation = ObservationWithSource<SourceReference>;
export type WorkerObservationFrame = {
  type: 'observation';
  observation: CompactWebObservation;
  sourceBlobs: Record<string, string>;
};

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

/** Share text hashes across a batch of observations without reading or hashing unchanged text again. */
export function observationCompactor(save: (digest: string, text: string) => void): (observation: WebObservation) => CompactWebObservation {
  const digests = new Map<string, string>();
  return observation => mapSources(observation, (source: string) => {
    let sha256 = digests.get(source);
    if (!sha256) {
      sha256 = mathDigest(source);
      digests.set(source, sha256);
      save(sha256, source);
    }
    return { sha256 };
  });
}

export function compactObservation(observation: WebObservation, save: (digest: string, text: string) => void): CompactWebObservation {
  return observationCompactor(save)(observation);
}

/** Legacy records inline their sources. References must all resolve before handing the observation to a consumer. */
export function hydrateObservation(observation: WebObservation | CompactWebObservation,
  read: (digest: string) => string | undefined): WebObservation {
  return mapSources(observation, (source: string | SourceReference) => {
    if (typeof source === 'string') return source;
    if (typeof source?.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(source.sha256))
      throw new Error('web_observation_source_reference_invalid');
    const text = read(source.sha256);
    if (text === undefined) throw new Error('web_observation_source_blob_missing');
    return text;
  });
}
