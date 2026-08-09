import { stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";

import type { Tool } from "./types.js";
import { analyzeCommand, destroysWorkspaceRoot } from "../security/command-analysis.js";
import {
  failure,
  prepareWorkspacePath,
  resolveExistingWorkspacePath,
  type PreparedPath,
} from "./workspace.js";

interface RunCommandInput {
  readonly command: string;
  readonly cwd?: string;
}

interface PreparedRunCommand extends PreparedPath {
  readonly command: string;
}

const SECRET_NAME = /(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;
const OUTPUT_LIMIT = 24 * 1024;

export interface RunCommandToolOptions {
  readonly envPassthrough?: readonly string[];
  readonly shell?: {
    readonly kind: "powershell" | "sh";
    readonly executable?: string;
  };
}

export function createRunCommandTool(
  options: RunCommandToolOptions = {}
): Tool<RunCommandInput, PreparedRunCommand, unknown> {
  const normalizeEnvName = (name: string): string =>
    process.platform === "win32" ? name.toLowerCase() : name;
  const envPassthrough = new Set(
    (options.envPassthrough ?? []).map(normalizeEnvName)
  );
  return {
  name: "run_command",
  description: "Run a non-interactive platform shell command from the workspace. Prefer dedicated read, search, and edit tools whenever they can perform the operation.",
  effect: "execute",
  timeoutMs: 120_000,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", minLength: 1, maxLength: 16_384 },
      cwd: { type: "string", minLength: 1 },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async prepare(input, context) {
    if (!input.command.trim() || Buffer.byteLength(input.command, "utf8") > 16 * 1024) {
      return failure("invalid_input", "Command must be non-empty and at most 16 KiB UTF-8");
    }
    const cwd = prepareWorkspacePath(context.workspace, input.cwd ?? ".");
    if (!cwd.ok) return cwd;
    return { ok: true, data: { ...cwd.data, command: input.command } };
  },
  async authorizationTarget(prepared, context) {
    const cwd = await resolveExistingWorkspacePath(context.workspace, prepared);
    if (!cwd.ok) return cwd;
    const shellKind = options.shell?.kind ?? (process.platform === "win32" ? "powershell" : "sh");
    const analysis = analyzeCommand(prepared.command, shellKind);
    if (analysis.syntaxError) return failure("invalid_input", analysis.syntaxError);
    return {
      ok: true,
      data: {
          primary: analysis.normalized,
          commands: analysis.commands,
        cwd: cwd.data.resolvedPath,
        shell: shellKind,
        ...(analysis.dynamic ? { dynamic: true } : {}),
          ...(analysis.dangerous || (
            cwd.data.resolvedPath === "."
            && destroysWorkspaceRoot(prepared.command, shellKind)
          ) ? { dangerous: true } : {}),
      },
    };
  },
  async execute(prepared, context) {
    const cwd = await resolveExistingWorkspacePath(context.workspace, prepared);
    if (!cwd.ok) return cwd;
    if (!(await stat(cwd.data.absolutePath)).isDirectory()) {
      return failure("not_a_file", "Command cwd is not a directory");
    }
    if (context.signal?.aborted) return failure("cancelled", "Command was cancelled");
    const shell = resolveShell(options.shell);
    if (!shell) return failure("execution_failed", "No supported platform shell was found");
    const started = performance.now();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          (!SECRET_NAME.test(entry[0]) || envPassthrough.has(normalizeEnvName(entry[0])))
      )
    );
    const launch = shell.launch(prepared.command);
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn({
        cmd: launch.cmd,
        cwd: cwd.data.absolutePath,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
      });
      if (launch.stdin) proc.stdin.write(launch.stdin);
      proc.stdin.end();
    } catch (error) {
      return failure("execution_failed", `Unable to start command: ${String(error)}`);
    }
    let timedOut = false;
    let cancelled = false;
    let termination: Promise<void> | undefined;
    const terminate = (): void => {
      termination ??= terminateProcessTree(proc);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, 120_000);
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    const stdoutPromise = new Response(proc.stdout).arrayBuffer();
    const stderrPromise = new Response(proc.stderr).arrayBuffer();
    const exitCode = await proc.exited;
    await termination;
    clearTimeout(timeout);
    context.signal?.removeEventListener("abort", onAbort);
    const [stdoutBytes, stderrBytes] = await Promise.all([
      stdoutPromise.then((value) => new Uint8Array(value)),
      stderrPromise.then((value) => new Uint8Array(value)),
    ]);
    const stdout = boundedOutput(stdoutBytes);
    const stderr = boundedOutput(stderrBytes);
    const details = {
      shell: shell.name,
      cwd: cwd.data.path,
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      stdoutDecodeErrors: stdout.decodeErrors,
      stderrDecodeErrors: stderr.decodeErrors,
      durationMs: Math.max(0, performance.now() - started),
    };
    if (cancelled) return failure("cancelled", "Command was cancelled", false, details);
    if (timedOut) return failure("timeout", "Command timed out", true, details);
    if (exitCode !== 0) return failure("execution_failed", `Command exited with code ${exitCode}`, false, details);
    return { ok: true, data: details };
  },
  };
}

export const runCommandTool = createRunCommandTool();

async function terminateProcessTree(
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">
): Promise<void> {
  if (process.platform === "win32") {
    const graceful = Bun.spawn({
      cmd: ["taskkill", "/PID", String(proc.pid), "/T"],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await graceful.exited;
    if (proc.exitCode === null) {
      const forced = Bun.spawn({
        cmd: ["taskkill", "/PID", String(proc.pid), "/T", "/F"],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      await forced.exited;
    }
    return;
  }
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
  await Bun.sleep(250);
  if (proc.exitCode === null) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }
}

function resolveShell(config?: RunCommandToolOptions["shell"]): {
  name: string;
  launch(command: string): { cmd: string[]; stdin?: Uint8Array };
} | undefined {
  if (process.platform === "win32") {
    if (config?.kind === "sh") return undefined;
    const executable = config?.executable ?? Bun.which("pwsh") ?? Bun.which("powershell.exe");
    if (!executable) return undefined;
    return {
      name: executable,
      launch: (command) => ({
        cmd: [
          executable,
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          powershellWrapper(),
        ],
        stdin: Buffer.from(command, "utf8"),
      }),
    };
  }
  if (config?.kind === "powershell") return undefined;
  const executable = config?.executable ?? "/bin/sh";
  return {
    name: executable,
    launch: (command) => ({ cmd: [executable, "-c", command] }),
  };
}

function powershellWrapper(): string {
  const suffix = randomBytes(8).toString("hex");
  const bytes = `$nekoderBytes_${suffix}`;
  const memory = `$nekoderMemory_${suffix}`;
  const buffer = `$nekoderBuffer_${suffix}`;
  const count = `$nekoderCount_${suffix}`;
  const utf8 = `$nekoderUtf8_${suffix}`;
  const script = `$nekoderScript_${suffix}`;
  const success = `$nekoderSuccess_${suffix}`;
  const nativeExit = `$nekoderNativeExit_${suffix}`;
  return [
    `${memory} = New-Object System.IO.MemoryStream`,
    `${buffer} = New-Object byte[] 4096`,
    `while ((${count} = [Console]::OpenStandardInput().Read(${buffer}, 0, ${buffer}.Length)) -gt 0) { ${memory}.Write(${buffer}, 0, ${count}) }`,
    `${bytes} = ${memory}.ToArray()`,
    `${utf8} = New-Object System.Text.UTF8Encoding($false, $true)`,
    `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)`,
    `[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)`,
    `$OutputEncoding = [Console]::OutputEncoding`,
    `${script} = [ScriptBlock]::Create(${utf8}.GetString(${bytes}))`,
    `& ${script}`,
    `${success} = $?`,
    `${nativeExit} = $LASTEXITCODE`,
    `if ($null -ne ${nativeExit}) { exit ${nativeExit} }`,
    `if (-not ${success}) { exit 1 }`,
  ].join("; ");
}

function boundedOutput(bytes: Uint8Array): { text: string; truncated: boolean; decodeErrors: number } {
  let selected = bytes;
  let truncated = false;
  if (bytes.byteLength > OUTPUT_LIMIT) {
    const half = Math.floor(OUTPUT_LIMIT / 2);
    const omitted = bytes.byteLength - half * 2;
    const marker = Buffer.from(`\n... ${omitted} bytes omitted ...\n`, "utf8");
    selected = Buffer.concat([bytes.subarray(0, half), marker, bytes.subarray(bytes.length - half)]);
    truncated = true;
  }
  const text = new TextDecoder("utf-8").decode(selected);
  return { text, truncated, decodeErrors: [...text].filter((char) => char === "�").length };
}
