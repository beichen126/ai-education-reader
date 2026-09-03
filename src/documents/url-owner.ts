// Central page object-URL ownership (Stage 9.2B1.1). The Reader must NEVER keep a
// desynced urlRef: exactly one place revokes the previous URL on replace / leave.
export type UrlOwner = {
  /** Revoke the current URL (if any) and record the new one. */
  replace(next: string | null): void
  /** Revoke + drop the current URL (reader leave / document switch). */
  revokeAll(): void
  get current(): string | null
}
export function createUrlOwner(): UrlOwner {
  let current: string | null = null
  const revoke = (u: string | null) => { if (u) { try { URL.revokeObjectURL(u) } catch { /* ignore */ } } }
  return {
    replace(next: string | null) { revoke(current); current = next },
    revokeAll() { revoke(current); current = null },
    get current() { return current },
  }
}
