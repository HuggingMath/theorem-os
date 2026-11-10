import type { ResearchLibraryPack } from './researchAssetTypes';

/** Read-only views of the same pinned release used by the web solver. */
export type InstalledLibraryInfo = {
  id: string;
  revision: string;
  catalogDigest: string;
  environmentDigest: string;
  environment: string;
  toolchain: string;
  moduleCount: number;
  declarationCount: number;
};
export type InstalledLibraryEntry = { name: string; kind: 'lemma' | 'definition'; type: string; description: string };
/** Browser-safe metadata projection of the validated catalog; proof objects stay on the server. */
export type InstalledLibraryModule = {
  file: string;
  sha256: string;
  bytes: number;
  origin: ResearchLibraryPack['modules'][number]['origin'];
  imports: string[];
  declarations: string[];
  entries: InstalledLibraryEntry[];
  name: string;
  area: string;
  import: string;
};
export type InstalledLibraryModuleSummary = Omit<InstalledLibraryModule, 'entries' | 'declarations'> & {
  entryCount: number;
  declarationCount: number;
  preview: InstalledLibraryEntry[];
  matchingInterfaces: { name: string; summary: { zh: string; en: string } }[];
  matchingInterfaceCount: number;
};
/** Generated from one pinned release; contains searchable display text, never theorem proof bodies. */
export type InstalledLibrarySearchIndex = {
  catalogDigest: string;
  modules: Record<string, { sha256: string; entries: Record<string, { summary: { zh: string; en: string }; text: string }> }>;
};
export type InstalledLibraryDirectory = {
  library: InstalledLibraryInfo;
  items: InstalledLibraryModuleSummary[];
  areas: string[];
  total: number;
  offset: number;
  limit: number;
  nextOffset?: number;
};
/** Variables written in the declaration's active source scopes, not an elaborated Lean type. */
export type InstalledLibraryDeclarationContext = {
  documentation: string;
  context: string[];
  line: number;
};
export type InstalledLibraryDefinition = InstalledLibraryDeclarationContext & {
  source: string;
  body: string;
};
export type InstalledLibraryDetail = { library: InstalledLibraryInfo; module: InstalledLibraryModule;
  definitions: Record<string, InstalledLibraryDefinition>;
  contexts: Record<string, InstalledLibraryDeclarationContext> };
export type InstalledLibrarySource = {
  library: InstalledLibraryInfo;
  file: string;
  sourceDigest: string;
  source: string;
};
