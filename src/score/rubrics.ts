/**
 * The answer key, as something the judge can be given.
 *
 * `flightrecorder/answer-key.md` opens with "Keep this open while labelling" —
 * so every human label in this project was made by someone who knew the correct
 * answer, while the judge being measured against those labels saw only two
 * anonymous strings. That is not a hard judge task, it is an impossible one:
 * asked which of "18.33%" and "11.11%" is right, with no data and no tools, the
 * best available strategy is a coin flip, and kappa duly measured one.
 *
 * Reading the key into the judge's prompt equalises the information rather than
 * helping the judge cheat. It also makes the tier's question the honest one:
 * given the same reference a reviewer had, does the judge reach the same
 * verdict? A judge that still disagrees with ground truth in hand is a judge
 * that cannot be trusted with an opinion.
 *
 * Kept as a parser over the committed markdown rather than a second copy of the
 * answers, because two sources of truth for the same numbers is how a project
 * like this ends up publishing a figure nobody can re-derive.
 */

import { readFile } from "node:fs/promises";

export const DEFAULT_ANSWER_KEY = "flightrecorder/answer-key.md";

/** Task text → the correct answer, and how it is derived. */
export type RubricMap = ReadonlyMap<string, string>;

/**
 * Parses the answer-key table: `| # | task | correct answer | from |`.
 *
 * Rows that do not have all four cells are skipped rather than guessed at, and
 * a key that yields nothing is an error at the call site — silently judging
 * without the rubric you asked for would misattribute the result to the prompt.
 */
export function parseAnswerKey(markdown: string): RubricMap {
  const rubrics = new Map<string, string>();

  for (const line of markdown.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;

    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 4) continue;

    const [index, task, answer, derivation] = cells;
    // Skip the header and its separator row.
    if (!index || !/^\d+$/.test(index) || !task || !answer) continue;

    const clean = answer.replaceAll("*", "").trim();
    rubrics.set(task, derivation ? `Correct answer: ${clean} (from ${derivation}).` : `Correct answer: ${clean}.`);
  }

  return rubrics;
}

/**
 * Reads the key if it is there.
 *
 * A missing key is a normal state — most suites will not have one — so it
 * returns null rather than throwing, and the caller says so out loud. A key
 * that exists but parses to nothing IS an error: that means the format drifted,
 * and silently judging blind would credit the difference to the prompt.
 */
export async function readAnswerKey(path: string = DEFAULT_ANSWER_KEY): Promise<RubricMap | null> {
  let markdown: string;
  try {
    markdown = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const rubrics = parseAnswerKey(markdown);
  if (rubrics.size === 0) {
    throw new Error(
      `No rubric rows found in ${path}. Expected a table of | # | task | correct answer | from |.`,
    );
  }
  return rubrics;
}
