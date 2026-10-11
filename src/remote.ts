/** Quote a string for a POSIX shell. */
export function q(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Quote a path for a remote shell, leaving a leading ~ unquoted so it expands. */
export function qPath(path: string): string {
  if (path === "~") {
    return "~";
  }
  if (path.startsWith("~/")) {
    return `~/${q(path.slice(2))}`;
  }
  return q(path);
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(
      `command failed (exit ${code}): ${command}${stderr ? `\n${stderr.trimEnd()}` : ""}`,
    );
  }
}

export interface RunOptions {
  /** Data written to the command's stdin */
  input?: string | Uint8Array | ReadableStream<Uint8Array>;
  /** Pass output through to the terminal instead of capturing it */
  inherit?: boolean;
  /** Don't throw on a non-zero exit */
  allowFail?: boolean;
  /** Allocate a tty (for interactive or follow-mode commands) */
  tty?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a local command. */
export async function run(
  argv: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    stdin:
      options.input === undefined
        ? options.inherit
          ? "inherit"
          : "ignore"
        : typeof options.input === "string"
          ? new TextEncoder().encode(options.input)
          : options.input,
    stdout: options.inherit ? "inherit" : "pipe",
    stderr: options.inherit ? "inherit" : "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    options.inherit ? "" : new Response(proc.stdout as ReadableStream).text(),
    options.inherit ? "" : new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  if (code !== 0 && !options.allowFail) {
    throw new CommandError(argv.join(" "), code, stderr);
  }
  return { code, stdout, stderr };
}

/** Runs commands on the server over a shared ssh connection. */
export class Remote {
  private readonly sshOptions: string[];

  constructor(
    readonly host: string,
    readonly root: string,
  ) {
    this.sshOptions = [
      "-o",
      "BatchMode=yes",
      "-o",
      "ControlMaster=auto",
      "-o",
      // Short path: macOS $TMPDIR is long enough to hit the socket path limit
      "ControlPath=~/.ssh/portal-%C",
      "-o",
      "ControlPersist=60",
    ];
  }

  /** The ssh argv for running `command` in the root directory. */
  sshArgv(command: string, tty = false): string[] {
    return [
      "ssh",
      ...this.sshOptions,
      ...(tty ? ["-t"] : []),
      this.host,
      `cd ${qPath(this.root)} && ${command}`,
    ];
  }

  /** Run a shell command in the root directory. */
  exec(command: string, options: RunOptions = {}): Promise<RunResult> {
    return run(this.sshArgv(command, options.tty), options);
  }

  /** `docker compose ...` in the root directory. */
  compose(args: string, options: RunOptions = {}): Promise<RunResult> {
    return this.exec(`docker compose ${args}`, options);
  }

  /** Read a file relative to the root; undefined if it doesn't exist. */
  async readFile(path: string): Promise<string | undefined> {
    const result = await this.exec(
      `if [ -f ${q(path)} ]; then cat ${q(path)}; else exit 3; fi`,
      { allowFail: true },
    );
    if (result.code === 3) {
      return;
    }
    if (result.code !== 0) {
      throw new CommandError(`read ${path}`, result.code, result.stderr);
    }
    return result.stdout;
  }

  /**
   * Write a file relative to the root, creating parent directories. The write
   * goes to a temp file first so readers never see a partial file.
   */
  async writeFile(
    path: string,
    content: string,
    { mode }: { mode?: string } = {},
  ): Promise<void> {
    const tmp = `${path}.portal-tmp`;
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    await this.exec(
      [
        `mkdir -p ${q(dir)}`,
        `${mode ? "umask 077 && " : ""}cat > ${q(tmp)}`,
        ...(mode ? [`chmod ${mode} ${q(tmp)}`] : []),
        `mv ${q(tmp)} ${q(path)}`,
      ].join(" && "),
      { input: content },
    );
  }

  async removeFile(path: string): Promise<void> {
    await this.exec(`rm -f ${q(path)}`);
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.exec(`test -e ${q(path)}`, { allowFail: true });
    return result.code === 0;
  }
}
