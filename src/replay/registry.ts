/**
 * Agent registry.
 *
 * A frozen case records which agent produced it, but a case is data — it cannot
 * carry a function. Something has to turn `"metrics-analyst"` back into code
 * that runs, and that is this: the boundary between the fixtures (portable,
 * committed, inert) and the program (local, importable, live).
 *
 * Phase 7 points the harness at an open-source agent by registering an adapter
 * here rather than by changing anything else.
 */

import type { RecordableAgent } from "./replay.ts";

const agents = new Map<string, RecordableAgent>();

export function registerAgent(agent: RecordableAgent): void {
  const existing = agents.get(agent.ref.name);
  if (existing && existing.ref.version !== agent.ref.version) {
    throw new Error(
      `Agent "${agent.ref.name}" is already registered at version ` +
        `${existing.ref.version}; refusing to replace it with ${agent.ref.version}. ` +
        "Two agents sharing a name would make replays ambiguous.",
    );
  }
  agents.set(agent.ref.name, agent);
}

export function getAgent(name: string): RecordableAgent {
  const agent = agents.get(name);
  if (!agent) {
    const known = [...agents.keys()].sort();
    throw new Error(
      `No agent registered as "${name}".` +
        (known.length ? ` Known agents: ${known.join(", ")}.` : " None are registered."),
    );
  }
  return agent;
}

export function listAgents(): RecordableAgent[] {
  return [...agents.values()].sort((a, b) => (a.ref.name < b.ref.name ? -1 : 1));
}

/** Test helper; production never needs to forget an agent. */
export function clearAgents(): void {
  agents.clear();
}
