import type { IngestDeps } from "./ports";
import type { IngestInputFiles } from "../protocol";

/**
 * Wiring point for the real implementations (unit 2 openChatDb, unit 3 extractor,
 * unit 1 storage, unit 4 contacts). Unit 14 replaces this body.
 */
export async function createRealDeps(_files: IngestInputFiles): Promise<IngestDeps> {
  throw new Error("Real ingest deps not wired yet (units 1-4 pending); see ingest/deps.ts");
}
