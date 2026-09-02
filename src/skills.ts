import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

export interface AgentSkill {
  name: string;
  description: string;
  path: string;
  directory: string;
  scope: "workspace" | "additional" | "user";
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}

export interface DiscoverSkillsOptions {
  workspace: string;
  additionalDirectories?: readonly string[];
  userSkillsRoots?: readonly string[];
}

export const WORKSPACE_SKILL_SUBDIRECTORIES = [
  ".agents/skills",
  ".froe/skills",
  ".claude/skills",
  ".codex/skills",
  ".cursor/skills",
  ".github/skills",
] as const;

export const USER_SKILL_SUBDIRECTORIES = [
  ".agents/skills",
  ".froe/skills",
  ".claude/skills",
  ".codex/skills",
  ".cursor/skills",
] as const;

export async function discoverSkills(options: DiscoverSkillsOptions): Promise<AgentSkill[]> {
  const discoveredByName = new Map<string, AgentSkill>();
  const workspace = resolve(options.workspace);

  // 1. Workspace roots (highest priority)
  for (const subDir of WORKSPACE_SKILL_SUBDIRECTORIES) {
    const rootDir = join(workspace, subDir);
    await scanSkillRoot(rootDir, "workspace", workspace, discoveredByName);
  }

  // 2. Additional authorized directory roots
  for (const additionalDir of options.additionalDirectories ?? []) {
    const resolvedAdditional = resolve(additionalDir);
    for (const subDir of WORKSPACE_SKILL_SUBDIRECTORIES) {
      const rootDir = join(resolvedAdditional, subDir);
      await scanSkillRoot(rootDir, "additional", workspace, discoveredByName);
    }
  }

  // 3. User roots (lowest priority)
  const userRoots = options.userSkillsRoots ?? defaultUserSkillsRoots();
  for (const rootDir of userRoots) {
    await scanSkillRoot(rootDir, "user", workspace, discoveredByName);
  }

  return [...discoveredByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function defaultUserSkillsRoots(): string[] {
  const home = homedir();
  const roots: string[] = [];
  for (const subDir of USER_SKILL_SUBDIRECTORIES) {
    roots.push(join(home, subDir));
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig !== undefined && xdgConfig.trim()) {
    roots.push(join(xdgConfig, "froe", "skills"));
  }
  return [...new Set(roots)];
}

async function scanSkillRoot(
  rootDir: string,
  scope: "workspace" | "additional" | "user",
  workspace: string,
  discovered: Map<string, AgentSkill>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const skillDir = join(rootDir, entry.name);
    const skillFile = join(skillDir, "SKILL.md");

    try {
      const fileStat = await stat(skillFile);
      if (!fileStat.isFile()) continue;
      const rawContent = await readFile(skillFile, "utf8");
      const parsed = parseSkillFrontmatter(rawContent);
      if (parsed === undefined) continue;

      const skillPath = scope === "workspace" ? relative(workspace, skillFile) : skillFile;
      const validated = validateSkill(parsed.attributes, skillPath, skillDir, scope);
      if (validated !== undefined && !discovered.has(validated.name)) {
        discovered.set(validated.name, validated);
      }
    } catch {
      // Ignore unreadable or invalid skill files
    }
  }
}

export function parseSkillFrontmatter(rawContent: string): {
  attributes: Record<string, unknown>;
  body: string;
} | undefined {
  const match = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (match === null) return undefined;
  const yamlBlock = match[1];
  if (yamlBlock === undefined) return undefined;
  const body = match[2] ?? "";
  const attributes = parseSimpleYaml(yamlBlock);
  return { attributes, body };
}

export function validateSkill(
  attributes: Record<string, unknown>,
  filePath: string,
  directory: string,
  scope: "workspace" | "additional" | "user",
): AgentSkill | undefined {
  const name = typeof attributes.name === "string" ? attributes.name.trim() : undefined;
  const description = typeof attributes.description === "string" ? attributes.description.trim() : undefined;

  if (name === undefined || description === undefined || name === "" || description === "") return undefined;

  // Agent Skills spec: 1-64 characters, lowercase alphanumeric and hyphens, no consecutive hyphens
  if (name.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    return undefined;
  }

  if (description.length > 1024) {
    return undefined;
  }

  const license = typeof attributes.license === "string" && attributes.license.trim()
    ? attributes.license.trim()
    : undefined;
  const compatibility = typeof attributes.compatibility === "string" && attributes.compatibility.trim()
    ? attributes.compatibility.trim()
    : undefined;
  if (compatibility !== undefined && compatibility.length > 500) {
    return undefined;
  }

  let metadata: Record<string, string> | undefined;
  if (attributes.metadata !== undefined && typeof attributes.metadata === "object" && attributes.metadata !== null && !Array.isArray(attributes.metadata)) {
    const metaRecord: Record<string, string> = {};
    for (const [key, value] of Object.entries(attributes.metadata)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        metaRecord[key] = String(value);
      }
    }
    if (Object.keys(metaRecord).length > 0) {
      metadata = metaRecord;
    }
  }

  let allowedTools: string[] | undefined;
  if (typeof attributes["allowed-tools"] === "string") {
    const tools = attributes["allowed-tools"].trim().split(/\s+/).filter(Boolean);
    if (tools.length > 0) allowedTools = tools;
  } else if (Array.isArray(attributes["allowed-tools"])) {
    const tools = attributes["allowed-tools"].map(String).map((s) => s.trim()).filter(Boolean);
    if (tools.length > 0) allowedTools = tools;
  }

  return {
    name,
    description,
    path: filePath,
    directory,
    scope,
    ...(license !== undefined ? { license } : {}),
    ...(compatibility !== undefined ? { compatibility } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
  };
}

export function formatSkills(skills: AgentSkill[]): string {
  if (skills.length === 0) return "";
  const header = "Available agent skills:";
  const items = skills
    .map((skill) => `- ${skill.name}: ${skill.description} (file: ${skill.path})`)
    .join("\n");
  const guidance = "When a task matches an available agent skill's description, read its `SKILL.md` using `read_file` to inspect its detailed instructions before proceeding.";
  return `${header}\n\n${items}\n\n${guidance}`;
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const lines = yaml.split(/\r?\n/);
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentBlockType: "|" | ">" | null = null;
  let blockLines: string[] = [];
  let inMetadata = false;
  let metadataMap: Record<string, string> = {};
  let inList = false;
  let listItems: string[] = [];

  const flushBlock = (): void => {
    if (currentKey !== null && currentBlockType !== null) {
      if (currentBlockType === "|") {
        result[currentKey] = blockLines.join("\n").trim();
      } else {
        result[currentKey] = blockLines.join(" ").replace(/\s+/g, " ").trim();
      }
      currentKey = null;
      currentBlockType = null;
      blockLines = [];
    }
    if (inMetadata && currentKey !== null) {
      result[currentKey] = metadataMap;
      inMetadata = false;
      metadataMap = {};
      currentKey = null;
    }
    if (inList && currentKey !== null) {
      result[currentKey] = listItems;
      inList = false;
      listItems = [];
      currentKey = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Inside a block scalar (multiline string)
    if (currentBlockType !== null) {
      if (/^\s+/.test(rawLine)) {
        blockLines.push(rawLine.trim());
        continue;
      } else {
        flushBlock();
      }
    }

    // Inside metadata map
    if (inMetadata) {
      if (/^\s+/.test(rawLine)) {
        const metaMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (metaMatch !== null && metaMatch[1] !== undefined && metaMatch[2] !== undefined) {
          metadataMap[metaMatch[1]] = unquote(stripTrailingComment(metaMatch[2].trim()));
        }
        continue;
      } else {
        flushBlock();
      }
    }

    // Inside list
    if (inList) {
      if (/^\s*-\s+/.test(rawLine)) {
        listItems.push(unquote(stripTrailingComment(trimmed.replace(/^-\s+/, "").trim())));
        continue;
      } else {
        flushBlock();
      }
    }

    // Key-value pair
    const kvMatch = rawLine.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kvMatch === null || kvMatch[1] === undefined || kvMatch[2] === undefined) continue;

    flushBlock();
    const key = kvMatch[1];
    const rest = stripTrailingComment(kvMatch[2].trim());

    if (rest === "|" || rest === "|+" || rest === "|-") {
      currentKey = key;
      currentBlockType = "|";
      blockLines = [];
    } else if (rest === ">" || rest === ">+" || rest === ">-") {
      currentKey = key;
      currentBlockType = ">";
      blockLines = [];
    } else if (key === "metadata" && rest === "") {
      currentKey = key;
      inMetadata = true;
      metadataMap = {};
    } else if (rest === "") {
      currentKey = key;
      inList = true;
      listItems = [];
    } else {
      result[key] = unquote(rest);
    }
  }

  flushBlock();
  return result;
}

function stripTrailingComment(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) {
    return value;
  }
  const commentIndex = value.indexOf(" #");
  if (commentIndex !== -1) {
    return value.slice(0, commentIndex).trim();
  }
  return value;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const quote = value[0];
    const inner = value.slice(1, -1);
    if (quote === '"') {
      return inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return inner.replace(/''/g, "'");
  }
  return value;
}
