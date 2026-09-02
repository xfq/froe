import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverSkills,
  formatSkills,
  parseSkillFrontmatter,
  validateSkill,
  WORKSPACE_SKILL_SUBDIRECTORIES,
} from "../src/skills.js";

test("parseSkillFrontmatter parses valid YAML frontmatter and body", () => {
  const content = `---
name: code-reviewer
description: Reviews pull requests and diffs.
license: Apache-2.0
compatibility: froe >= 0.3.0
metadata:
  author: xfq
  version: "1.0.0"
allowed-tools: read_file search run_command
---
# Instructions
Follow the review checklist.`;

  const parsed = parseSkillFrontmatter(content);
  assert.ok(parsed);
  assert.equal(parsed.attributes.name, "code-reviewer");
  assert.equal(parsed.attributes.description, "Reviews pull requests and diffs.");
  assert.equal(parsed.attributes.license, "Apache-2.0");
  assert.equal(parsed.attributes.compatibility, "froe >= 0.3.0");
  assert.deepEqual(parsed.attributes.metadata, { author: "xfq", version: "1.0.0" });
  assert.equal(parsed.attributes["allowed-tools"], "read_file search run_command");
  assert.equal(parsed.body.trim(), "# Instructions\nFollow the review checklist.");
});

test("parseSkillFrontmatter handles multiline block scalars and comments", () => {
  const content = `---
name: multiline-desc
description: >
  This is a long description
  spanning multiple lines
  folded into one.
# This is a comment
metadata:
  key: value # trailing comment
allowed-tools:
  - read_file
  - apply_patch
---
Body text`;

  const parsed = parseSkillFrontmatter(content);
  assert.ok(parsed);
  assert.equal(parsed.attributes.name, "multiline-desc");
  assert.equal(parsed.attributes.description, "This is a long description spanning multiple lines folded into one.");
  assert.deepEqual(parsed.attributes.metadata, { key: "value" });
  assert.deepEqual(parsed.attributes["allowed-tools"], ["read_file", "apply_patch"]);
});

test("parseSkillFrontmatter returns undefined for missing or invalid frontmatter", () => {
  assert.equal(parseSkillFrontmatter("No frontmatter here"), undefined);
  assert.equal(parseSkillFrontmatter("---\nname: incomplete"), undefined);
});

test("validateSkill checks name and description constraints according to Agent Skills spec", () => {
  const valid = validateSkill(
    { name: "test-skill-1", description: "A valid test skill." },
    ".agents/skills/test-skill-1/SKILL.md",
    "/workspace/.agents/skills/test-skill-1",
    "workspace",
  );
  assert.ok(valid);
  assert.equal(valid.name, "test-skill-1");
  assert.equal(valid.description, "A valid test skill.");
  assert.equal(valid.path, ".agents/skills/test-skill-1/SKILL.md");
  assert.equal(valid.scope, "workspace");

  // Invalid: name with uppercase or underscore or invalid characters
  assert.equal(
    validateSkill({ name: "Invalid_Name", description: "desc" }, "path", "dir", "workspace"),
    undefined,
  );
  assert.equal(
    validateSkill({ name: "-leading-hyphen", description: "desc" }, "path", "dir", "workspace"),
    undefined,
  );
  assert.equal(
    validateSkill({ name: "trailing-hyphen-", description: "desc" }, "path", "dir", "workspace"),
    undefined,
  );
  assert.equal(
    validateSkill({ name: "consecutive--hyphens", description: "desc" }, "path", "dir", "workspace"),
    undefined,
  );
  assert.equal(
    validateSkill({ name: "a".repeat(65), description: "desc" }, "path", "dir", "workspace"),
    undefined,
  );

  // Invalid: missing or empty description
  assert.equal(
    validateSkill({ name: "valid-name" }, "path", "dir", "workspace"),
    undefined,
  );
  assert.equal(
    validateSkill({ name: "valid-name", description: "" }, "path", "dir", "workspace"),
    undefined,
  );
  assert.equal(
    validateSkill({ name: "valid-name", description: "a".repeat(1025) }, "path", "dir", "workspace"),
    undefined,
  );
});

test("discoverSkills finds skills and enforces workspace > user precedence", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "froe-skills-test-"));
  const workspace = join(tempDir, "workspace");
  const userRoots = [join(tempDir, "user-skills")];

  try {
    // Create workspace skill in .agents/skills/alpha
    const wsAlphaDir = join(workspace, ".agents", "skills", "alpha");
    await mkdir(wsAlphaDir, { recursive: true });
    await writeFile(
      join(wsAlphaDir, "SKILL.md"),
      `---\nname: alpha\ndescription: Workspace alpha skill.\n---\nWorkspace body`,
    );

    // Create workspace skill in .claude/skills/beta
    const wsBetaDir = join(workspace, ".claude", "skills", "beta");
    await mkdir(wsBetaDir, { recursive: true });
    await writeFile(
      join(wsBetaDir, "SKILL.md"),
      `---\nname: beta\ndescription: Workspace beta skill.\n---\nWorkspace beta body`,
    );

    // Create user skill with same name "alpha" (should be overridden by workspace alpha)
    const userAlphaDir = join(userRoots[0]!, "alpha");
    await mkdir(userAlphaDir, { recursive: true });
    await writeFile(
      join(userAlphaDir, "SKILL.md"),
      `---\nname: alpha\ndescription: User alpha skill (should be masked).\n---\nUser alpha body`,
    );

    // Create user skill "gamma"
    const userGammaDir = join(userRoots[0]!, "gamma");
    await mkdir(userGammaDir, { recursive: true });
    await writeFile(
      join(userGammaDir, "SKILL.md"),
      `---\nname: gamma\ndescription: User gamma skill.\n---\nUser gamma body`,
    );

    const skills = await discoverSkills({ workspace, userSkillsRoots: userRoots });

    assert.equal(skills.length, 3);
    assert.equal(skills[0]?.name, "alpha");
    assert.equal(skills[0]?.description, "Workspace alpha skill.");
    assert.equal(skills[0]?.scope, "workspace");
    assert.equal(skills[0]?.path, join(".agents", "skills", "alpha", "SKILL.md"));

    assert.equal(skills[1]?.name, "beta");
    assert.equal(skills[1]?.description, "Workspace beta skill.");
    assert.equal(skills[1]?.scope, "workspace");

    assert.equal(skills[2]?.name, "gamma");
    assert.equal(skills[2]?.description, "User gamma skill.");
    assert.equal(skills[2]?.scope, "user");
    assert.equal(skills[2]?.path, join(userGammaDir, "SKILL.md"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("formatSkills returns empty string when no skills are provided", () => {
  assert.equal(formatSkills([]), "");
});

test("formatSkills formats available skills with progressive disclosure instructions", () => {
  const formatted = formatSkills([
    {
      name: "code-review",
      description: "Review pull requests and code changes.",
      path: ".agents/skills/code-review/SKILL.md",
      directory: "/workspace/.agents/skills/code-review",
      scope: "workspace",
    },
    {
      name: "git-helper",
      description: "Helper for advanced git operations.",
      path: "/Users/xfq/.agents/skills/git-helper/SKILL.md",
      directory: "/Users/xfq/.agents/skills/git-helper",
      scope: "user",
    },
  ]);

  assert.match(formatted, /^Available agent skills:/);
  assert.match(formatted, /- code-review: Review pull requests and code changes\. \(file: \.agents\/skills\/code-review\/SKILL\.md\)/);
  assert.match(formatted, /- git-helper: Helper for advanced git operations\. \(file: \/Users\/xfq\/\.agents\/skills\/git-helper\/SKILL\.md\)/);
  assert.match(formatted, /When a task matches an available agent skill's description, read its `SKILL\.md` using `read_file`/);
});
