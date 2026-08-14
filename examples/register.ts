/**
 * Registers the bundled example agents.
 *
 * Imported for its side effect by the CLI and by tests. Phase 7 adds the
 * open-source agent here — pointing the harness at something real is a
 * registration, not a rewrite.
 */

import { registerAgent } from "../src/replay/registry.ts";
import { demoAgent } from "./demo-agent.ts";
import { nestedAgent } from "./nested-agent.ts";
import { reactAnalyst } from "./react-analyst.ts";

registerAgent(demoAgent);
registerAgent(nestedAgent);
registerAgent(reactAnalyst);
