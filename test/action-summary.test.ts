import assert from "node:assert/strict";
import test from "node:test";
import { formatActionDetails, formatApprovalPrompt } from "../src/action-summary.js";

test("command summaries show a redacted argv and cwd", () => {
  assert.deepEqual(formatActionDetails({
    name: "run_command",
    arguments: {
      executable: "git",
      args: ["reset", "--hard", "--token=ghp_secret", "https://user:password@example.test/repo.git"],
      cwd: "/work/froe",
    },
  }), [
    "argv: [\"git\",\"reset\",\"--hard\",\"--token=<redacted>\",\"https://user:<redacted>@example.test/repo.git\"]",
    "cwd: \"/work/froe\"",
  ]);
});

test("patch summaries list each affected file and change type without source text", () => {
  assert.deepEqual(formatActionDetails({
    name: "apply_patch",
    arguments: {
      changes: [
        { path: "new.ts", oldText: null, newText: "secret source text" },
        { path: "updated.ts", oldText: "before", newText: "after" },
        { path: "old.ts", oldText: "private source text", newText: null },
      ],
    },
  }), [
    "create: \"new.ts\"",
    "replace: \"updated.ts\"",
    "delete: \"old.ts\"",
  ]);
});

test("read-only action summaries retain their safe target without exposing search text", () => {
  assert.deepEqual(formatActionDetails({
    name: "search",
    arguments: { query: "private source text" },
  }), ["path: \".\""]);
});

test("approval prompts repeat the redacted action summary immediately before the decision", () => {
  assert.equal(formatApprovalPrompt({
    name: "run_command",
    arguments: { executable: "git", args: ["reset", "--hard"], cwd: "/work/froe" },
  }, "git reset can discard workspace changes.", "[y]es/[n]o"), [
    "Approve run_command?",
    "  argv: [\"git\",\"reset\",\"--hard\"]",
    "  cwd: \"/work/froe\"",
    "  reason: git reset can discard workspace changes.",
    "[y]es/[n]o: ",
  ].join("\n"));
});
