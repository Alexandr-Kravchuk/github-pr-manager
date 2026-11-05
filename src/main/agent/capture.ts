// The PR agent's stand-in for the review skill's `pr-review-publish.sh`:
// `<electron or node> capture.js <run dir> review|comment|reply|resolve …`,
// started by the run's own wrapper script (`writePublishWrapper`). It checks a
// call the way the real wrapper does — the same fields, the same rejection
// text — and appends it to the run's plan instead of posting it. The app posts
// the plan afterwards (`main/agent/publish.ts`), so nothing reaches GitHub from
// inside the session.
//
// Run with ELECTRON_RUN_AS_NODE=1, like the guard hook; no Electron imports.

import fs from "node:fs";
import path from "node:path";

import { isInsideDir, parseFileComment, parsePublishCall, parseReview, PLAN_FILE_MAX_BYTES, type PublishStep } from "../../shared/agent-publish";

export interface CaptureRun {
  repo: string;
  number: number;
  outDir: string;
  wrapperPath: string;
}

export const PLAN_FILE = "plan.jsonl";

/** "/c/Users/x" (Git Bash, when its own path conversion didn't apply) → "C:\Users\x" on Windows. */
function nativePath(p: string): string {
  const m = /^\/([A-Za-z])\/(.*)$/.exec(p);
  return process.platform === "win32" && m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}` : p;
}

/** One checked call → the plan step it records, or the reason it is refused. */
export function captureCall(run: CaptureRun, args: readonly string[]): { step: PublishStep } | { error: string } {
  const parsed = parsePublishCall(args);
  if (!parsed.ok) return { error: parsed.error };
  const call = parsed.value;
  if (call.sub === "resolve") return { step: { kind: "resolve", threadId: call.threadId } };
  if (call.repo.toLowerCase() !== run.repo.toLowerCase() || call.number !== run.number) {
    return { error: `this run publishes to ${run.repo}#${run.number} only, got: ${call.repo}#${call.number}` };
  }
  const file = nativePath(call.file);
  let real: string;
  try {
    // Through links: a file must really be in the run's folder.
    real = fs.realpathSync.native(file);
    if (!isInsideDir(real, fs.realpathSync.native(run.outDir))) return { error: `write the file under ${run.outDir}, got: ${call.file}` };
    const st = fs.statSync(real);
    if (!st.isFile()) return { error: `no such file: ${call.file}` };
    if (st.size > PLAN_FILE_MAX_BYTES) return { error: `${call.file} is larger than ${PLAN_FILE_MAX_BYTES} bytes` };
  } catch {
    return { error: `no such file: ${call.file}` };
  }
  const text = fs.readFileSync(real, "utf8");
  if (call.sub === "reply") {
    if (!text.length) return { error: "the reply body is empty" };
    return { step: { kind: "reply", replyTo: call.replyTo, body: text } };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { error: `${call.file} is not JSON: ${(e as Error).message}` };
  }
  const step = call.sub === "review" ? parseReview(json) : parseFileComment(json);
  return step.ok ? { step: step.value } : { error: step.error };
}

/** What the session reads back: shaped like the API's answer, and saying plainly that nothing was posted yet. */
export function captureReply(step: PublishStep): string {
  const note = "Recorded by PR Dashboard for publishing: the app posts it after this session (in Shadow, once you press Publish). Nothing was posted from here.";
  if (step.kind === "resolve") return JSON.stringify({ data: { resolveReviewThread: { thread: { id: step.threadId, isResolved: true } } }, note });
  return JSON.stringify({ id: 0, state: step.kind === "review" ? "RECORDED" : undefined, note });
}

function main(): void {
  const runDir = process.argv[2] ?? "";
  let run: CaptureRun;
  try {
    run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")) as CaptureRun;
  } catch {
    process.stderr.write("PUBLISH-REJECTED: this run has no publish folder.\n");
    process.exit(2);
  }
  const result = captureCall(run, process.argv.slice(3));
  if ("error" in result) {
    process.stderr.write(`PUBLISH-REJECTED: ${result.error}\n`);
    process.exit(2);
  }
  fs.appendFileSync(path.join(runDir, PLAN_FILE), `${JSON.stringify(result.step)}\n`);
  process.stdout.write(`${captureReply(result.step)}\n`);
  process.exit(0);
}

if (require.main === module) main();
