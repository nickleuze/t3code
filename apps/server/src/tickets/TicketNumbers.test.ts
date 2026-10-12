import { assert, it } from "@effect/vitest";

import {
  matchReadableTicketId,
  parseReadableTicketId,
  readableSuffixes,
  readableTicketIds,
} from "./TicketNumbers.ts";
import { ticketIds } from "./TicketRecord.ts";

const A = "01JQ4K7QZ8R3PB5W1N0D4K7QXM";
// Shares A's last six characters but not its last seven.
const CLASH = "01JQ4K7QZ8R3PB5W1N0E4K7QXM";

it("uses the ULID's last six characters", () => {
  assert.equal(readableSuffixes([A]).get(A), "4K7QXM");
  assert.equal(
    readableTicketIds([{ id: A, projectKey: "lighting-director" }]).get(A),
    "lighting-director-4K7QXM",
  );
});

it("extends a clashing suffix by one character, only within one project", () => {
  const suffixes = readableSuffixes([A, CLASH]);
  assert.equal(suffixes.get(A), "D4K7QXM");
  assert.equal(suffixes.get(CLASH), "E4K7QXM");
  const ids = readableTicketIds([
    { id: A, projectKey: "photo" },
    { id: CLASH, projectKey: "systems" },
  ]);
  assert.equal(ids.get(A), "photo-4K7QXM");
  assert.equal(ids.get(CLASH), "systems-4K7QXM");
});

it("two Macs offline mint distinct IDs with no coordination", () => {
  const macA = ticketIds();
  const macB = ticketIds();
  const time = Date.parse("2026-10-12T09:00:00.000Z");
  const tickets = Array.from({ length: 200 }, (_, index) => ({
    id: (index % 2 ? macA : macB)(time + Math.floor(index / 2)),
    projectKey: "lighting-director",
  }));
  const readable = readableTicketIds(tickets);
  assert.equal(new Set(readable.values()).size, tickets.length);
  for (const id of readable.values()) assert.match(id, /^lighting-director-[0-9A-Z]{6,}$/);
});

it("parses hyphenated project keys and rejects non-suffixes", () => {
  assert.deepStrictEqual(parseReadableTicketId("lighting-director-4k7qxm"), {
    projectKey: "lighting-director",
    suffix: "4K7QXM",
  });
  assert.deepStrictEqual(parseReadableTicketId("systems-D4K7QXM"), {
    projectKey: "systems",
    suffix: "D4K7QXM",
  });
  assert.equal(parseReadableTicketId("lighting-director"), null);
  assert.equal(parseReadableTicketId("-4K7QXM"), null);
  assert.equal(parseReadableTicketId("systems-4K7QX"), null);
  // I, L, O and U are not Crockford base32.
  assert.equal(parseReadableTicketId("systems-4K7QXL"), null);
});

it("Ideas without a project key get no readable ID", () => {
  const ids = readableTicketIds([
    { id: A, projectKey: null },
    { id: CLASH, projectKey: undefined },
  ]);
  assert.equal(ids.size, 0);
});

it("matches exact suffixes first and accepts an unambiguous shorter one", () => {
  assert.equal(matchReadableTicketId("D4K7QXM", [A, CLASH]), A);
  assert.equal(matchReadableTicketId("E4K7QXM", [A, CLASH]), CLASH);
  // Quoted before the clash existed; now ambiguous.
  assert.equal(matchReadableTicketId("4K7QXM", [A, CLASH]), null);
  // Still unambiguous with only one ticket.
  assert.equal(matchReadableTicketId("4K7QXM", [A]), A);
  // A longer quoted suffix still names its ticket.
  assert.equal(matchReadableTicketId("0D4K7QXM", [A, CLASH]), A);
  assert.equal(matchReadableTicketId("ZZZZZZ", [A, CLASH]), null);
});
