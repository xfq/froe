import type { ActionRequest } from "./types.js";

const sensitiveFlag = /^(?:--?)[\w-]*(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|authorization|credential|cookie|session)[\w-]*$/i;
const sensitiveAssignment = /((?:--?)[\w-]*(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|authorization|credential|cookie|session)[\w-]*=)([^\s]+)/gi;
const sensitiveNamedValue = /(\b[A-Za-z_][\w-]*(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|authorization|credential|cookie|session)[\w-]*\s*[:=]\s*)([^\s,;]+)/gi;
const authorizationValue = /(authorization\s*:\s*(?:bearer|basic|token)\s+)([^\s,;]+)/gi;
const urlCredentials = /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s]+):([^@/\s]+)@/gi;

export function formatActionDetails(action: Pick<ActionRequest, "name" | "arguments">): string[] {
  const arguments_ = record(action.arguments);
  if (arguments_ === undefined) return [];

  switch (action.name) {
    case "run_command":
      return commandDetails(arguments_);
    case "apply_patch":
      return patchDetails(arguments_);
    case "list_files":
    case "search":
      return pathDetails(arguments_, true);
    case "web_search":
      return [];
    case "read_file":
      return pathDetails(arguments_);
    case "finish":
      return typeof arguments_.outcome === "string" ? [`outcome: ${quote(arguments_.outcome)}`] : [];
    default:
      return [];
  }
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(urlCredentials, "$1:<redacted>@")
    .replace(authorizationValue, "$1<redacted>")
    .replace(sensitiveAssignment, "$1<redacted>")
    .replace(sensitiveNamedValue, "$1<redacted>");
}

export function formatApprovalPrompt(
  action: Pick<ActionRequest, "name" | "arguments">,
  reason: string,
  choices: string,
): string {
  return [
    `Approve ${action.name}?`,
    ...formatActionDetails(action).map((detail) => `  ${detail}`),
    `  reason: ${redactSensitiveText(reason)}`,
    `${choices}: `,
  ].join("\n");
}

function commandDetails(arguments_: Record<string, unknown>): string[] {
  const executable = typeof arguments_.executable === "string" ? arguments_.executable : "<unavailable>";
  const args = Array.isArray(arguments_.args) && arguments_.args.every((argument) => typeof argument === "string")
    ? [...arguments_.args] as string[]
    : [];
  const redacted = [executable, ...args].map(redactSensitiveText);
  for (let index = 0; index < redacted.length - 1; index += 1) {
    if (sensitiveFlag.test(redacted[index] ?? "")) redacted[index + 1] = "<redacted>";
  }
  const cwd = typeof arguments_.cwd === "string" ? arguments_.cwd : ".";
  return [`argv: ${JSON.stringify(redacted)}`, `cwd: ${quote(cwd)}`];
}

function patchDetails(arguments_: Record<string, unknown>): string[] {
  if (!Array.isArray(arguments_.changes)) return [];
  return arguments_.changes.flatMap((change) => {
    const value = record(change);
    if (value === undefined || typeof value.path !== "string") return [];
    const operation = value.oldText === null ? "create" : value.newText === null ? "delete" : "replace";
    return [`${operation}: ${quote(value.path)}`];
  });
}

function pathDetails(arguments_: Record<string, unknown>, defaultToWorkspace = false): string[] {
  if (typeof arguments_.path === "string") return [`path: ${quote(arguments_.path)}`];
  return defaultToWorkspace ? [`path: ${quote(".")}`] : [];
}

function quote(value: string): string {
  return JSON.stringify(redactSensitiveText(value));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
