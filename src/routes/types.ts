// Path: src/routes/types.ts
// Shared types for the trust plugin's agent-side HTTP routes.
//
// These are structural (duck-typed) interfaces rather than direct imports of
// the concrete classes, so route handlers stay easy to unit-test with plain
// fakes (see test/routes.integration.test.ts) without needing to construct a
// real TrustManager/ReleaseStore/DeploymentJournal. Mirrors
// znvault-plugin-archon's src/routes/types.ts split.

export interface ManagerLike {
  restart(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ active: boolean; raw: string }>;
  getService(): Promise<string>;
}

export interface StoreLike {
  beginUpload(version: string, totalChunks: number): void;
  appendChunk(version: string, index: number, data: Buffer): void;
  commitUpload(version: string, sha256: string): Promise<void>;
  activate(version: string): Promise<{ previous: string | null }>;
  currentVersion(): Promise<string | null>;
  listReleases(): Promise<string[]>;
}

export interface JournalLike {
  isOpen(): boolean;
  hostname(): string;
  open(options: { version: string }): void;
  close(): void;
}

/** Minimal logger shape routes depend on — matches pino's Logger and the brief's test double ({ info, error }). */
export interface PluginLogger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
}

export interface RouteContext {
  mgr: ManagerLike;
  store: StoreLike;
  journal: JournalLike;
  logger: PluginLogger;
}
