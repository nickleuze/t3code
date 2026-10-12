/**
 * Readable Ticket IDs: `<projectKey>-<suffix>`, e.g. `lighting-director-4K7QXM`.
 *
 * The suffix is the last six characters of the ticket's ULID, extended one
 * character at a time for every ticket in the same project that shares it.
 * The readable ID is derived, never stored or synced, so two Macs creating
 * tickets offline need no coordination. Ideas (tickets with no project or
 * area key) have no readable ID.
 *
 * @module TicketNumbers
 */

const READABLE_SUFFIX_LENGTH = 6;
const ULID_LENGTH = 26;
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;

/** Assigns each ULID its shortest unique suffix of at least six characters. */
export function readableSuffixes(ids: Iterable<string>): Map<string, string> {
  const result = new Map<string, string>();
  const assign = (group: readonly string[], length: number) => {
    const byTail = new Map<string, string[]>();
    for (const id of group) {
      const tail = id.slice(-length);
      byTail.set(tail, [...(byTail.get(tail) ?? []), id]);
    }
    for (const [tail, members] of byTail)
      if (members.length === 1 || length >= ULID_LENGTH)
        for (const id of members) result.set(id, tail);
      else assign(members, length + 1);
  };
  assign([...new Set(ids)], READABLE_SUFFIX_LENGTH);
  return result;
}

/** Readable IDs for every ticket that has a project or area key. */
export function readableTicketIds(
  tickets: Iterable<{ readonly id: string; readonly projectKey?: string | null | undefined }>,
): Map<string, string> {
  const byKey = new Map<string, string[]>();
  for (const ticket of tickets)
    if (ticket.projectKey)
      byKey.set(ticket.projectKey, [...(byKey.get(ticket.projectKey) ?? []), ticket.id]);
  const result = new Map<string, string>();
  for (const [key, ids] of byKey)
    for (const [id, suffix] of readableSuffixes(ids)) result.set(id, `${key}-${suffix}`);
  return result;
}

/** Splits `<key>-<suffix>`; the key may itself contain hyphens. */
export function parseReadableTicketId(
  value: string,
): { readonly projectKey: string; readonly suffix: string } | null {
  const index = value.lastIndexOf("-");
  if (index <= 0) return null;
  const projectKey = value.slice(0, index);
  const suffix = value.slice(index + 1).toUpperCase();
  if (suffix.length < READABLE_SUFFIX_LENGTH || suffix.length > ULID_LENGTH) return null;
  if (!CROCKFORD.test(suffix)) return null;
  return { projectKey, suffix };
}

/**
 * Resolves a readable ID against the ticket ULIDs in its project. An exact
 * readable match wins; a shorter suffix that still names exactly one ticket is
 * accepted too, so IDs quoted before a later clash keep working when unambiguous.
 */
export function matchReadableTicketId(
  suffix: string,
  projectIds: readonly string[],
): string | null {
  const exact = [...readableSuffixes(projectIds)].filter(([, tail]) => tail === suffix);
  if (exact.length === 1) return exact[0]![0];
  const loose = projectIds.filter((id) => id.endsWith(suffix));
  return loose.length === 1 ? loose[0]! : null;
}
