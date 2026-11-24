import { mathDigest } from '../../src/math/mathRuntimeIo';
import type { WebObservation, WebTaskSource } from './collaboration';

type SourceReference = { sha256: string };
type ObservationWithSource<Text> = Omit<WebObservation, 'sources'> & {
  sources: (Omit<WebTaskSource, 'source' | 'dependencySources'> & {
    source: Text; dependencySources?: { file: string; source: Text }[];
  })[];
};

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

export function compactObservation(observation: WebObservation, save: (digest: string, text: string) => void): CompactWebObservation {
  const digests = new Map<string, string>();
  return mapSources(observation, (source: string) => {
    let sha256 = digests.get(source);
    if (!sha256) {
      sha256 = mathDigest(source);
      digests.set(source, sha256);
      save(sha256, source);
    }
    return { sha256 };
  });
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
