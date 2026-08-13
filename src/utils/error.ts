// Path: src/utils/error.ts
// Error handling utilities. Mirrors znvault-plugin-archon's src/utils/error.ts.

/**
 * Extracts a human-readable error message from an unknown error value.
 *
 * @param err - The error value (can be Error, string, or any other type)
 * @returns The error message string
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
