import { BASE_IMAGE_LABEL } from "./compose.ts";

/** ARG that `addBaseLabel` introduces when the base image is written inline. */
export const BASE_IMAGE_ARG = "BASE_IMAGE";

export class DockerfileError extends Error {}

/** One instruction, which may span several lines. Line numbers are 0-based. */
export interface Instruction {
  keyword: string;
  args: string;
  start: number;
  end: number;
}

export interface Stage {
  name?: string;
  /** The image after FROM, as written */
  image: string;
  from: Instruction;
  /** Instructions after FROM, up to the next stage */
  instructions: Instruction[];
}

/**
 * Split a Dockerfile into instructions, joining continuation lines and
 * skipping comments and heredoc bodies.
 */
export function parseInstructions(text: string): Instruction[] {
  const lines = text.split("\n");
  const instructions: Instruction[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const start = i;
    let body = trimmed;
    while (body.endsWith("\\") && i + 1 < lines.length) {
      const next = lines[++i]!.trim();
      if (!next.startsWith("#")) {
        body = `${body.slice(0, -1)} ${next}`;
      }
    }
    const match = /^(\w+)\s*([\s\S]*)$/.exec(body);
    if (!match) {
      continue;
    }
    const keyword = match[1]!.toUpperCase();
    const args = match[2]!.trim();
    if (["RUN", "COPY", "ADD"].includes(keyword)) {
      for (const heredoc of args.matchAll(/<<-?(["']?)([A-Za-z_]\w*)\1/g)) {
        while (i + 1 < lines.length && lines[++i]!.trim() !== heredoc[2]) {}
      }
    }
    instructions.push({ keyword, args, start, end: i });
  }
  return instructions;
}

/** Global ARGs (before the first FROM) and the stages. */
export function parseStages(text: string): { globals: Instruction[]; stages: Stage[] } {
  const globals: Instruction[] = [];
  const stages: Stage[] = [];
  for (const instruction of parseInstructions(text)) {
    if (instruction.keyword === "FROM") {
      const words = instruction.args.split(/\s+/).filter((w) => !w.startsWith("--"));
      stages.push({
        image: words[0] ?? "",
        name: words[1]?.toLowerCase() === "as" ? words[2] : undefined,
        from: instruction,
        instructions: [],
      });
    } else if (stages.length === 0) {
      if (instruction.keyword === "ARG") {
        globals.push(instruction);
      }
    } else {
      stages.at(-1)!.instructions.push(instruction);
    }
  }
  return { globals, stages };
}

/** The `NAME` or `NAME=default` declarations in an ARG instruction. */
function argDeclarations(args: string): [string, string | undefined][] {
  return [...args.matchAll(/(\w+)(?:=("[^"]*"|'[^']*'|\S*))?/g)].map((m) => [
    m[1]!,
    m[2] === undefined ? undefined : unquote(m[2]),
  ]);
}

/** The key=value pairs in a LABEL instruction. */
function labelPairs(args: string): [string, string][] {
  return [...args.matchAll(/([^\s=]+)=("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g)].map((m) => [
    unquote(m[1]!),
    unquote(m[2]!),
  ]);
}

function unquote(value: string): string {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

/** Variables an expression like node:${NODE_VERSION}-slim refers to. */
export function referencedVars(expression: string): string[] {
  return [...expression.matchAll(/\$\{(\w+)[^}]*\}|\$(\w+)/g)].map((m) => m[1] ?? m[2]!);
}

/**
 * Substitute variables the way Docker does, including ${VAR:-default} and
 * ${VAR:+alternative}. Variables that aren't set become empty and are listed
 * in `missing`.
 */
function expand(
  expression: string,
  vars: Map<string, string>,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = expression.replace(
    /\$\{(\w+)(?::?([-+])([^}]*))?\}|\$(\w+)/g,
    (_, braced?: string, op?: string, word = "", bare?: string) => {
      const name = (braced ?? bare)!;
      const set = vars.get(name);
      if (op === "-") {
        return set || word;
      }
      if (op === "+") {
        return set ? word : "";
      }
      if (set === undefined) {
        missing.push(name);
      }
      return set ?? "";
    },
  );
  return { value, missing };
}

export interface BaseAnalysis {
  /** The stage that becomes the image: the build target, or the last stage */
  stage: Stage;
  /** The image the chain of stages starts from; undefined for scratch */
  base?: { expression: string; value: string; missing: string[]; stage: Stage };
  /** The nearest base.name label in the chain of stages */
  label?: {
    expression: string;
    value: string;
    missing: string[];
    stage: Stage;
    instruction: Instruction;
  };
}

/**
 * Find the image a Dockerfile's output is built from, following stages that
 * build on earlier stages, and the base.name label it declares, if any.
 */
export function analyzeBase(
  text: string,
  options: { target?: string; args?: Record<string, string> } = {},
): BaseAnalysis {
  const { globals, stages } = parseStages(text);
  const buildArgs = options.args ?? {};
  if (stages.length === 0) {
    throw new DockerfileError("has no FROM instruction");
  }
  const stage = options.target
    ? stages.find((s) => s.name?.toLowerCase() === options.target!.toLowerCase())
    : stages.at(-1)!;
  if (!stage) {
    throw new DockerfileError(`has no stage named "${options.target}"`);
  }

  const globalVars = new Map<string, string>();
  for (const instruction of globals) {
    for (const [name, value] of argDeclarations(instruction.args)) {
      const set = buildArgs[name] ?? value;
      if (set !== undefined) {
        globalVars.set(name, set);
      }
    }
  }

  // Variables a stage's instructions can use: only the ARGs it declares
  const stageVars = (s: Stage, before: number) => {
    const vars = new Map<string, string>();
    for (const instruction of s.instructions) {
      if (instruction.keyword !== "ARG" || instruction.start >= before) {
        continue;
      }
      for (const [name, value] of argDeclarations(instruction.args)) {
        const set = buildArgs[name] ?? value ?? globalVars.get(name);
        if (set !== undefined) {
          vars.set(name, set);
        }
      }
    }
    return vars;
  };

  // The chain from the output stage back to the stage built on a real image
  const chain: Stage[] = [stage];
  for (;;) {
    const current = chain.at(-1)!;
    const index = stages.indexOf(current);
    const parent = stages
      .slice(0, index)
      .findLast((s) => s.name?.toLowerCase() === current.image.toLowerCase());
    if (!parent || chain.includes(parent)) {
      break;
    }
    chain.push(parent);
  }

  let label: BaseAnalysis["label"];
  for (const s of chain) {
    const labels = s.instructions.filter((i) => i.keyword === "LABEL");
    for (const instruction of labels.reverse()) {
      const pair = labelPairs(instruction.args).findLast(([key]) => key === BASE_IMAGE_LABEL);
      if (pair) {
        label = {
          expression: pair[1],
          ...expand(pair[1], stageVars(s, instruction.start)),
          stage: s,
          instruction,
        };
        break;
      }
    }
    if (label) {
      break;
    }
  }

  const root = chain.at(-1)!;
  const base =
    root.image.toLowerCase() === "scratch"
      ? undefined
      : { expression: root.image, ...expand(root.image, globalVars), stage: root };
  return { stage, base, label };
}

/** Whether the label names the image the build starts from. */
export function labelMatches({ base, label }: BaseAnalysis): boolean {
  return (
    base !== undefined &&
    label !== undefined &&
    label.missing.length === 0 &&
    base.missing.length === 0 &&
    label.value === base.value
  );
}

/**
 * Make the output stage label the image the build starts from. A base image
 * written inline is moved into a global ARG so FROM and the label share it.
 * Returns the text unchanged if the label is already right.
 */
export function addBaseLabel(
  text: string,
  options: { target?: string; args?: Record<string, string> } = {},
): string {
  const analysis = analyzeBase(text, options);
  if (labelMatches(analysis)) {
    return text;
  }
  const { stage, base, label } = analysis;
  if (!base) {
    throw new DockerfileError("builds from scratch, so there's no base image to label");
  }
  if (base.missing.length > 0) {
    throw new DockerfileError(
      `base image ${base.expression} uses ${base.missing.join(", ")}, which has no default`,
    );
  }

  const lines = text.split("\n");
  // Edits as [line, lines to delete, lines to insert], applied bottom-up
  const edits: [number, number, string[]][] = [];
  let expression = base.expression;
  if (referencedVars(expression).length === 0) {
    const { globals, stages } = parseStages(text);
    if (globals.some((g) => argDeclarations(g.args).some(([n]) => n === BASE_IMAGE_ARG))) {
      throw new DockerfileError(
        `already declares ${BASE_IMAGE_ARG}, but the base image doesn't use it`,
      );
    }
    const fromLine = lines[base.stage.from.start]!;
    const at = fromLine.indexOf(base.expression);
    if (base.stage.from.start !== base.stage.from.end || at < 0) {
      throw new DockerfileError(`couldn't find ${base.expression} on its FROM line`);
    }
    expression = `\${${BASE_IMAGE_ARG}}`;
    edits.push([
      base.stage.from.start,
      1,
      [fromLine.slice(0, at) + expression + fromLine.slice(at + base.expression.length)],
    ]);
    edits.push([stages[0]!.from.start, 0, [`ARG ${BASE_IMAGE_ARG}=${base.expression}`]]);
  }

  // A wrong label in the output stage is replaced; one in an earlier stage is
  // overridden by the new one
  if (label && label.stage === stage) {
    if (labelPairs(label.instruction.args).length !== 1) {
      throw new DockerfileError(
        `its ${BASE_IMAGE_LABEL} label shares a LABEL instruction with other labels`,
      );
    }
    edits.push([label.instruction.start, label.instruction.end - label.instruction.start + 1, []]);
  }

  // Insert after FROM and any LABELs that directly follow it
  let after = stage.from.end;
  for (const instruction of stage.instructions) {
    if (instruction.keyword !== "LABEL") {
      break;
    }
    if (instruction !== label?.instruction) {
      after = instruction.end;
    }
  }
  const declared = new Set(
    stage.instructions
      .filter((i) => i.keyword === "ARG" && i.start < after)
      .flatMap((i) => argDeclarations(i.args).map(([name]) => name)),
  );
  edits.push([
    after + 1,
    0,
    [
      ...referencedVars(expression)
        .filter((name) => !declared.has(name))
        .map((name) => `ARG ${name}`),
      `LABEL ${BASE_IMAGE_LABEL}=${expression}`,
    ],
  ]);

  edits.sort((a, b) => b[0] - a[0]);
  for (const [line, remove, insert] of edits) {
    lines.splice(line, remove, ...insert);
  }
  const fixed = lines.join("\n");
  if (!labelMatches(analyzeBase(fixed, options))) {
    throw new DockerfileError("couldn't add a label that matches the base image");
  }
  return fixed;
}
