import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface ProjectInstruction {
  scope: string;
  source: "AGENTS.md" | "CLAUDE.md";
  content: string;
}

const skippedDirectories = new Set([".git", "node_modules", "dist", ".froe"]);

export async function discoverProjectInstructions(workspace: string): Promise<ProjectInstruction[]> {
  const found: ProjectInstruction[] = [];
  await visit(workspace, workspace, found);
  return found.sort((left, right) => depth(left.scope) - depth(right.scope) || left.scope.localeCompare(right.scope));
}

export function formatInstructions(instructions: ProjectInstruction[]): string {
  if (instructions.length === 0) return "No project instruction files were found.";
  return instructions
    .map((instruction) => `## ${instruction.scope} (${instruction.source})\n${instruction.content.trim()}`)
    .join("\n\n");
}

async function visit(workspace: string, directory: string, found: ProjectInstruction[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const names = new Set(entries.map((entry) => entry.name));
  const source = names.has("AGENTS.md") ? "AGENTS.md" : names.has("CLAUDE.md") ? "CLAUDE.md" : undefined;
  if (source !== undefined) {
    const content = await readFile(join(directory, source), "utf8");
    found.push({
      scope: relative(workspace, directory) || ".",
      source,
      content,
    });
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || skippedDirectories.has(entry.name)) continue;
    await visit(workspace, join(directory, entry.name), found);
  }
}

function depth(scope: string): number {
  return scope === "." ? 0 : scope.split(sep).length;
}
