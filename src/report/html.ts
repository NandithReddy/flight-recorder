/**
 * The report, as one self-contained HTML file.
 *
 * No server, no assets, no network. A report you cannot attach to a pull
 * request or email to someone is a report nobody reads.
 *
 * The layout follows the argument: what happened, then how confident we are,
 * then what regressed, then the exact step where each regression diverged.
 * Cost and latency sit beside quality rather than under it, because reading
 * them apart is how you end up promoting a cheaper, faster, wrong agent.
 */

import { describeInterval, type Interval } from "../stats/bootstrap.ts";
import { diffTraces } from "./diff.ts";
import { headline, type CaseOutcome, type ReportData } from "./build.ts";
import type { SqliteTraceStore } from "../store/sqlite-store.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pct(value: number): string {
  return Number.isNaN(value) ? "—" : `${value.toFixed(1)}%`;
}

function usd(value: number): string {
  return Number.isNaN(value) ? "—" : `$${value.toFixed(6)}`;
}

function ms(value: number): string {
  return Number.isNaN(value) ? "—" : `${Math.round(value)}ms`;
}

/** A delta with its interval, and the verdict on whether it means anything. */
function deltaCell(interval: Interval, format: (n: number) => string): string {
  if (Number.isNaN(interval.lower)) return `<span class="muted">no data</span>`;
  const cls = interval.significant ? (interval.point < 0 ? "bad" : "good") : "muted";
  const sign = interval.point >= 0 ? "+" : "";
  return (
    `<span class="${cls}">${sign}${format(interval.point)}</span>` +
    `<span class="ci">${format(interval.lower)} to ${format(interval.upper)}</span>` +
    (interval.significant ? "" : `<span class="ns">not significant</span>`)
  );
}

function caseRow(outcome: CaseOutcome, diffHtml: string): string {
  const status = outcome.regressed
    ? `<span class="pill bad">regressed</span>`
    : outcome.fixed
      ? `<span class="pill good">fixed</span>`
      : outcome.after.pass
        ? `<span class="pill ok">pass</span>`
        : `<span class="pill warn">failing in both</span>`;

  const untrusted = !outcome.trusted
    ? `<span class="pill untrusted" title="the judge that decided this is not calibrated well enough to present as fact">untrusted</span>`
    : "";

  return `
<details class="case${outcome.regressed ? " is-regression" : ""}">
  <summary>
    <span class="task">${escapeHtml(outcome.task)}</span>
    ${status}${untrusted}
  </summary>
  <div class="case-body">
    <p class="reason">${escapeHtml(outcome.verdict.reason || "—")}
      <span class="by">decided by ${outcome.verdict.decidedBy}</span></p>
    <div class="answers">
      <div><h4>baseline</h4><pre>${escapeHtml(outcome.before.output)}</pre></div>
      <div><h4>candidate</h4><pre>${escapeHtml(outcome.after.output)}</pre></div>
    </div>
    ${diffHtml}
  </div>
</details>`;
}

export interface RenderOptions {
  report: ReportData;
  store: SqliteTraceStore;
  /** Include step diffs for these outcomes. Defaults to regressions only. */
  diffFor?: CaseOutcome[];
}

export async function renderReportHtml(options: RenderOptions): Promise<string> {
  const { report, store } = options;
  const diffTargets = new Set((options.diffFor ?? report.regressions).map((o) => o.caseId));

  const caseBlocks: string[] = [];
  for (const outcome of report.cases) {
    let diffHtml = "";
    if (diffTargets.has(outcome.caseId)) {
      const before = await store.get(outcome.before.traceId);
      const after = await store.get(outcome.after.traceId);
      if (before && after) {
        const diff = diffTraces(before, after);
        const rows = diff.steps
          .map((step) => {
            const cls =
              step.status === "same" ? "same" : step.index === diff.divergedAt ? "diverge" : "changed";
            const label = (side: typeof step.baseline) =>
              side
                ? side.kind === "model"
                  ? `<span class="muted">model</span> ${escapeHtml(side.detail)}`
                  : `${escapeHtml(side.name)}`
                : "<em>—</em>";
            const value = (side: typeof step.baseline) =>
              side ? escapeHtml(side.output.slice(0, 120)) : "";
            return `<tr class="${cls}">
  <td class="idx">${step.index + 1}</td>
  <td>${label(step.baseline)}<div class="out">${value(step.baseline)}</div></td>
  <td>${label(step.candidate)}<div class="out">${value(step.candidate)}</div></td>
</tr>`;
          })
          .join("");
        diffHtml = `<p class="diverge-summary">${escapeHtml(diff.summary)}</p>
<table class="steps"><thead><tr><th></th><th>baseline</th><th>candidate</th></tr></thead><tbody>${rows}</tbody></table>`;
      }
    }
    caseBlocks.push(caseRow(outcome, diffHtml));
  }

  const judgeNote = report.judge
    ? report.judge.kappa === null
      ? `<p class="warn-banner">The judge has never been calibrated, so every verdict it produced is
         marked untrusted. Run <code>fr calibrate</code> before relying on these results.</p>`
      : report.judge.trusted
        ? `<p class="muted">Judge <code>${escapeHtml(report.judge.model)}</code> agrees with human labels at
           κ&nbsp;=&nbsp;${report.judge.kappa.toFixed(3)}.</p>`
        : `<p class="warn-banner">Judge <code>${escapeHtml(report.judge.model)}</code> agrees with human labels
           at only κ&nbsp;=&nbsp;${report.judge.kappa.toFixed(3)}, below the 0.6 threshold.
           ${report.untrustedVerdicts} judged verdict${report.untrustedVerdicts === 1 ? " is" : "s are"}
           marked untrusted below and should not be used to gate a merge.</p>`
    : `<p class="muted">Deterministic assertions only — no judge was configured for this run.</p>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flight Recorder — ${escapeHtml(report.suite)}</title>
<style>
:root {
  --bg:#fbfbfd; --panel:#f1f2f6; --rule:#d8dbe4; --ink:#14161c; --ink-2:#3d4350; --ink-3:#6c7285;
  --good:#1d6b49; --bad:#a02c22; --warn:#8a5a00; --accent:#a05c06;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#0e1015; --panel:#171a21; --rule:#2e333f; --ink:#e9ebf1; --ink-2:#b3b9c8; --ink-3:#7c8396;
    --good:#52b489; --bad:#e17e72; --warn:#e0a94a; --accent:#e7a64a;
  }
}
*{box-sizing:border-box}
body{margin:0;padding:2.5rem 1.25rem 5rem;background:var(--bg);color:var(--ink-2);
  font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:60rem;margin:0 auto}
h1{font-size:1.6rem;margin:0 0 .2rem;color:var(--ink);letter-spacing:-.02em}
h2{font-size:1.05rem;margin:2.4rem 0 .6rem;color:var(--ink);
  padding-bottom:.4rem;border-bottom:1px solid var(--rule)}
h4{margin:0 0 .3rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-3)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em}
.sub{color:var(--ink-3);font-size:.9rem;margin:0 0 1.6rem}
.headline{font-size:1.15rem;color:var(--ink);background:var(--panel);
  border:1px solid var(--rule);border-left:3px solid var(--accent);padding:1rem 1.2rem;margin:0 0 1.4rem}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th{text-align:left;font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-3);
  padding:0 .8rem .5rem 0;border-bottom:1px solid var(--rule);font-weight:600}
td{padding:.6rem .8rem .6rem 0;border-bottom:1px solid var(--rule);vertical-align:top}
.metrics td:first-child{color:var(--ink);font-weight:600}
.good{color:var(--good)} .bad{color:var(--bad)} .muted{color:var(--ink-3)}
.ci{display:block;font-size:.78rem;color:var(--ink-3);font-family:ui-monospace,monospace}
.ns{display:block;font-size:.75rem;color:var(--warn)}
.pill{display:inline-block;padding:.1rem .45rem;border-radius:2px;font-size:.7rem;
  text-transform:uppercase;letter-spacing:.06em;margin-left:.5rem;border:1px solid currentColor}
.pill.bad{color:var(--bad)} .pill.good{color:var(--good)} .pill.ok{color:var(--ink-3)}
.pill.warn{color:var(--warn)} .pill.untrusted{color:var(--warn)}
.warn-banner{background:var(--panel);border:1px solid var(--warn);border-left:3px solid var(--warn);
  padding:.8rem 1rem;color:var(--ink-2);font-size:.9rem}
.case{border-bottom:1px solid var(--rule);padding:.55rem 0}
.case.is-regression summary .task{color:var(--bad)}
summary{cursor:pointer;color:var(--ink)}
.task{font-weight:500}
.case-body{padding:.8rem 0 .4rem 1rem;border-left:2px solid var(--rule);margin-top:.6rem}
.reason{margin:0 0 .8rem;font-size:.9rem}
.by{color:var(--ink-3);font-size:.8rem;margin-left:.4rem}
.answers{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:.8rem}
@media(max-width:38rem){.answers{grid-template-columns:1fr}}
pre{margin:0;padding:.6rem .7rem;background:var(--panel);border:1px solid var(--rule);
  white-space:pre-wrap;word-break:break-word;font-size:.82rem;color:var(--ink-2)}
.steps{font-size:.8rem;margin-top:.4rem}
.steps td{padding:.35rem .6rem .35rem 0}
.steps tr.same{color:var(--ink-3)}
.steps tr.diverge td{background:color-mix(in srgb,var(--bad) 12%,transparent)}
.steps .idx{color:var(--ink-3);width:1.6rem}
.out{color:var(--ink-3);font-family:ui-monospace,monospace;font-size:.75rem;margin-top:.15rem}
.diverge-summary{font-size:.88rem;color:var(--ink);margin:.6rem 0 .2rem}
footer{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--rule);
  color:var(--ink-3);font-size:.8rem}
.overflow{overflow-x:auto}
</style>
</head><body><main>

<h1>${escapeHtml(report.suite)}</h1>
<p class="sub">
  <code>${escapeHtml(report.baseline.model)}</code> (${escapeHtml(report.baseline.promptVersion)})
  → <code>${escapeHtml(report.candidate.model)}</code> (${escapeHtml(report.candidate.promptVersion)})
  · ${escapeHtml(report.mode)} mode
  · ${report.n} cases${report.missing > 0 ? ` (${report.missing} with no comparable pair)` : ""}
  · ${new Date(report.createdAt).toISOString().slice(0, 16).replace("T", " ")}
</p>

<p class="headline">${escapeHtml(headline(report))}</p>

${judgeNote}

<h2>Measurements</h2>
<div class="overflow">
<table class="metrics">
<thead><tr><th>metric</th><th>baseline</th><th>candidate</th><th>change</th></tr></thead>
<tbody>
  <tr><td>pass rate</td><td>${pct(report.passRateBefore)}</td><td>${pct(report.passRateAfter)}</td>
      <td>${deltaCell(report.passRateDelta, (n) => `${n.toFixed(1)}%`)}</td></tr>
  <tr><td>cost per task</td><td>${usd(report.costPerTaskBefore)}</td><td>${usd(report.costPerTaskAfter)}</td>
      <td>${deltaCell(report.costDelta, (n) => `$${n.toFixed(6)}`)}</td></tr>
  <tr><td>latency p50</td><td>${ms(report.latencyP50Before)}</td><td>${ms(report.latencyP50After)}</td>
      <td class="muted">—</td></tr>
  <tr><td>latency p95</td><td>${ms(report.latencyP95Before)}</td><td>${ms(report.latencyP95After)}</td>
      <td>${deltaCell(report.latencyP95Delta, (n) => `${Math.round(n)}ms`)}</td></tr>
</tbody>
</table>
</div>
<p class="muted" style="font-size:.82rem;margin-top:.6rem">
  Intervals are 95% percentile bootstrap over ${report.passRateDelta.iterations.toLocaleString()}
  resamples of the ${report.n} cases. Cases are resampled as pairs, because every case ran under both
  configurations. A change whose interval spans zero is reported as not significant rather than as a direction.
</p>

<h2>Regressions${report.regressions.length ? ` (${report.regressions.length})` : ""}</h2>
${
  report.regressions.length === 0
    ? `<p class="muted">Nothing that passed on the baseline fails now.</p>`
    : report.regressions.map((o) => `<p>· ${escapeHtml(o.task)}</p>`).join("")
}

<h2>All cases</h2>
${caseBlocks.join("\n")}

<footer>
  Generated by Flight Recorder. Baseline <code>${escapeHtml(report.baseline.configId)}</code>,
  candidate <code>${escapeHtml(report.candidate.configId)}</code>.
  ${report.untrustedVerdicts > 0 ? `${report.untrustedVerdicts} verdict(s) marked untrusted.` : ""}
</footer>
</main></body></html>`;
}
