/**
 * Docker sandbox for live tool execution.
 *
 * Uses the same `ToolInterceptor` seam as stubbed replay, which is the payoff
 * of putting that seam in the recorder rather than in the replay layer: one hook
 * serves both "answer this from a recording" and "run this somewhere it cannot
 * hurt anything".
 *
 * Scope, stated plainly: a tool that is a pure in-process function gains
 * nothing from a container, and wrapping one would be theatre. This is for
 * tools that shell out — the shape phase 7's open-source agent is likely to
 * have. Declare which tools need it; everything else runs in-process.
 *
 * The container is deliberately hostile to the code inside it: no network, a
 * read-only root filesystem, dropped capabilities, a memory cap, and a hard
 * timeout. An agent under test is untrusted input.
 */

import { spawn } from "node:child_process";
import type { ToolInterceptor } from "../recorder/recorder.ts";

export interface SandboxOptions {
  /** Tool names to run in a container. Everything else runs in-process. */
  tools: string[];
  image?: string;
  /** Wall-clock ceiling per call. Default 30s. */
  timeoutMs?: number;
  memory?: string;
  /** Off by default — a sandboxed tool with network access is barely sandboxed. */
  allowNetwork?: boolean;
}

export interface SandboxCommand {
  /** argv to run inside the container. */
  command: string[];
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export class DockerUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      "Docker is not available. Start Docker Desktop, or run without the sandbox " +
        "if the tools under test do not shell out." +
        (cause instanceof Error ? ` (${cause.message})` : ""),
    );
    this.name = "DockerUnavailableError";
  }
}

export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["info", "--format", "{{.ServerVersion}}"], {
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Runs one argv inside a locked-down container. */
export async function runInSandbox(
  command: string[],
  options: Omit<SandboxOptions, "tools"> = {},
): Promise<SandboxResult> {
  const image = options.image ?? "alpine:3.20";
  const timeoutMs = options.timeoutMs ?? 30_000;

  const args = [
    "run",
    "--rm",
    "--interactive=false",
    ...(options.allowNetwork ? [] : ["--network", "none"]),
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "128",
    "--memory", options.memory ?? "256m",
    // Writable scratch that vanishes with the container.
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    image,
    ...command,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("docker", args);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new DockerUnavailableError(error));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
  });
}

/**
 * An interceptor that runs the named tools in a container.
 *
 * The tool's input must describe a command; anything else is a programming
 * error in the tool definition, not something to paper over at runtime.
 */
export function dockerSandbox(options: SandboxOptions): ToolInterceptor {
  const sandboxed = new Set(options.tools);

  return async ({ name, input, execute }) => {
    if (!sandboxed.has(name)) return execute();

    const command = (input as SandboxCommand)?.command;
    if (!Array.isArray(command) || command.length === 0) {
      throw new Error(
        `Tool "${name}" is configured to run in a sandbox, so its input must carry ` +
          `a { command: string[] }. Received: ${JSON.stringify(input)}`,
      );
    }

    const result = await runInSandbox(command, options);
    if (result.timedOut) {
      return `[sandbox timeout] ${name} exceeded ${options.timeoutMs ?? 30_000}ms and was killed`;
    }
    // Non-zero exit is a legitimate tool result, not a harness failure — the
    // agent should see the error and decide what to do about it.
    return result.exitCode === 0
      ? result.stdout.trimEnd()
      : `[exit ${result.exitCode}] ${(result.stderr || result.stdout).trimEnd()}`;
  };
}
