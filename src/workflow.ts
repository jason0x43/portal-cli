import { parse } from "yaml";
import { isRecord } from "./config.ts";
import { newestTag } from "./registry.ts";

/** The GitHub repository that publishes portal's deploy action. */
export const ACTION_REPO = "jason0x43/portal-cli";

/** Inputs action.yml marks as required. */
export const ACTION_REQUIRED_INPUTS = ["image", "host", "user", "ssh-key", "known-hosts"];

export interface ActionStep {
  job: string;
  /** The ref after @, e.g. v0.5.0 */
  ref: string;
  inputs: Record<string, unknown>;
  /**
   * Whether the job's token can read packages, which the default
   * registry-token needs; undefined when the workflow doesn't say, so the
   * repository's default applies.
   */
  readsPackages?: boolean;
}

function readsPackages(permissions: unknown): boolean | undefined {
  if (permissions === undefined) {
    return;
  }
  if (typeof permissions === "string") {
    return permissions === "read-all" || permissions === "write-all";
  }
  return isRecord(permissions) && ["read", "write"].includes(String(permissions.packages));
}

/** The steps in a workflow that use portal's action. */
export function actionSteps(text: string): ActionStep[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return [];
  }
  if (!isRecord(doc) || !isRecord(doc.jobs)) {
    return [];
  }
  const steps: ActionStep[] = [];
  for (const [job, body] of Object.entries(doc.jobs)) {
    if (!isRecord(body) || !Array.isArray(body.steps)) {
      continue;
    }
    for (const step of body.steps) {
      const uses = isRecord(step) && typeof step.uses === "string" ? step.uses : "";
      const [repo, ref] = uses.split("@");
      if (repo?.toLowerCase() !== ACTION_REPO || !ref) {
        continue;
      }
      steps.push({
        job,
        ref,
        inputs: isRecord(step.with) ? step.with : {},
        readsPackages: readsPackages(body.permissions ?? doc.permissions),
      });
    }
  }
  return steps;
}

/**
 * Move steps that use an older release of portal's action, or of its labels
 * action, to `ref`, editing the text so the rest of the workflow keeps its
 * formatting. Steps on a branch or commit are left alone.
 */
export function updateActionRef(text: string, ref: string): string {
  return text.replace(
    new RegExp(`(\\buses:\\s*["']?${ACTION_REPO}(?:/labels)?@)([^\\s"'#]+)`, "gi"),
    (match, uses: string, current: string) =>
      newestTag(current, [ref]) ? `${uses}${ref}` : match,
  );
}
