/**
 * The adoption surface, as executable tests.
 *
 * Everything else in this repo tests the harness against agents that live in
 * this repo — which is exactly the blind spot that let three "point it at your
 * own agent" gaps survive to phase 7: the registry was a static import, `record`
 * could only ask the demo question, and `seed` could only run the demo tasks.
 *
 * These tests therefore drive the real CLI as a subprocess, with an agent
 * written to a temp directory outside the repository. That is the only way to
 * exercise `FR_AGENTS`, and a unit test of the loader would not have caught the
 * hardcoded import it replaced.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const REPO = process.cwd();

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "fr-cli-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Invokes `fr` the way a user would, returning stdout plus the exit code. */
async function fr(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run("node", ["src/cli.ts", ...args], {
      cwd: REPO,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

/** An agent that lives outside this repository, as a user's would. */
async function writeExternalAgent(name: string): Promise<string> {
  const path = join(scratch, "agent.ts");
  await writeFile(
    path,
    `import { registerAgent } from ${JSON.stringify(join(REPO, "src/replay/registry.ts"))};
     registerAgent({
       ref: { name: ${JSON.stringify(name)}, version: "1.0.0" },
       async run(input, ctx) {
         const reply = await ctx.client.generate({
           model: ctx.model,
           temperature: ctx.temperature,
           messages: [{ role: "user", content: String(input) }],
         });
         return reply.text;
       },
     });`,
    "utf8",
  );
  return path;
}

describe("registering an agent from outside the repository", () => {
  it("loads it from FR_AGENTS and lists it", async () => {
    const path = await writeExternalAgent("outsider");
    const { stdout, code } = await fr(["agents"], { FR_AGENTS: path });

    expect(code).toBe(0);
    expect(stdout).toContain("outsider@1.0.0");
  });

  it("fails loudly when a registration module cannot be loaded", async () => {
    // Quietly skipping it would leave `fr matrix` reporting a rate over a suite
    // whose agents never registered — a smaller denominator, no error.
    const missing = join(scratch, "not-here.ts");
    const { stderr, code } = await fr(["agents"], { FR_AGENTS: missing });

    expect(code).not.toBe(0);
    expect(stderr).toContain("FR_AGENTS could not load");
    expect(stderr).toContain(missing);
  });
});

describe("recording something other than the demo question", () => {
  it("records the input given on the command line", async () => {
    const path = await writeExternalAgent("outsider");
    const question = "what changed in the pricing table last week?";
    const { stdout, code } = await fr(["record", "--agent", "outsider", "--input", question], {
      FR_AGENTS: path,
    });

    expect(code).toBe(0);
    expect(stdout).toContain(question);
  });

  it("rejects a task file that is not a list of strings, naming the file", async () => {
    const tasks = join(scratch, "tasks.json");
    await writeFile(tasks, JSON.stringify({ items: ["wrong shape"] }), "utf8");

    const { stderr, code } = await fr(["seed", "--tasks", tasks, "--suite", "scratch"]);

    expect(code).not.toBe(0);
    expect(stderr).toContain(tasks);
    expect(stderr).toContain("JSON array of strings");
  });
});
