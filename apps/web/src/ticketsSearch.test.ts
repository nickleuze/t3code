import { describe, expect, it } from "vite-plus/test";
import { parseTicketsSearch, ticketBoardColumns } from "./ticketsSearch";

describe("ticket capture search", () => {
  it.each([1, "1", true])("opens capture for %s", (capture) => {
    expect(parseTicketsSearch({ capture, project: "project-1" })).toEqual({
      capture: true,
      project: "project-1",
    });
  });
  it.each([0, "0", false, "false", {}, undefined])("ignores invalid capture %s", (capture) => {
    expect(parseTicketsSearch({ capture, project: 42 })).toEqual({});
  });
  it("preserves board filters and detail while ignoring unknown params", () => {
    expect(
      parseTicketsSearch({
        capture: 1,
        project: "",
        search: "phone",
        showDropped: true,
        projectId: "p1",
        projectEnvironmentId: "e1",
        ticketId: "t1",
        ticketEnvironmentId: "e1",
        unknown: "value",
      }),
    ).toEqual({
      capture: true,
      search: "phone",
      showDropped: true,
      projectId: "p1",
      projectEnvironmentId: "e1",
      ticketId: "t1",
      ticketEnvironmentId: "e1",
    });
  });
});
describe("ticket board columns", () => {
  it("keeps all five desktop columns, plus dropped when requested", () => {
    expect(ticketBoardColumns(false, false, "ready")).toEqual([
      "inbox",
      "ready",
      "in_progress",
      "in_review",
      "done",
    ]);
    expect(ticketBoardColumns(true, false, "ready")).toEqual([
      "inbox",
      "ready",
      "in_progress",
      "in_review",
      "done",
      "dropped",
    ]);
  });
  it.each(["inbox", "ready", "in_progress", "in_review", "done"] as const)(
    "shows only %s on a phone",
    (status) => {
      expect(ticketBoardColumns(false, true, status)).toEqual([status]);
    },
  );
  it("returns to Inbox when the selected dropped column is hidden", () => {
    expect(ticketBoardColumns(true, true, "dropped")).toEqual(["dropped"]);
    expect(ticketBoardColumns(false, true, "dropped")).toEqual(["inbox"]);
  });
});
