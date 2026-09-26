#!/usr/bin/env node
/**
 * Live end-to-end probe for the gm narration slice (plain node ≥20, zero
 * dependencies): POSTs one turn and streams the NDJSON reply, logging one
 * line per event with wall-clock ms since request start. Exit 1 on an
 * error event. The live-LLM leg is exercised only when
 * OPENROUTER_API_KEY is present in the environment.
 *
 *   node scripts/e2e-probe.mjs [--base http://localhost:3001] [--text "..."]
 */
import process from "node:process";

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1] : undefined;
}

const base = argValue("--base") ?? "http://localhost:3001";
const text =
  argValue("--text") ??
  "We regroup in the back booth of the Ram's Horn Diner and plan how to hit the van before it reaches the interchange.";

const hasKey = Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim() !== "");
console.log(`probe -> ${base}  (openrouter key: ${hasKey ? "present — live LLM will be exercised" : "ABSENT — the turn will fail at the LLM leg"})`);

const started = Date.now();
const response = await fetch(`${base}/v1/turn`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text }),
});

console.log(`HTTP ${response.status} ${response.headers.get("content-type") ?? ""}`);
if (!response.ok) {
  console.log(await response.text());
  process.exit(1);
}

const decoder = new TextDecoder();
let buffer = "";
let failed = false;

const reader = response.body.getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) {
      newline = buffer.indexOf("\n");
      continue;
    }
    const elapsed = Date.now() - started;
    try {
      const event = JSON.parse(line);
      if (event.type === "ack") {
        console.log(`[${elapsed}ms] [ack] filler=${event.filler?.id} text=${JSON.stringify(event.filler?.text)} audioHref=${event.filler?.audioHref}`);
      } else if (event.type === "beat") {
        console.log(
          `[${elapsed}ms] [beat ${event.i}] synthMs=${event.synthMs} durationMs=${event.durationMs} degraded=${event.degraded} audioHref=${event.audioHref} chars=${event.text?.length}`,
        );
      } else if (event.type === "done") {
        console.log(`[${elapsed}ms] [done] firstBeatMs=${event.firstBeatMs} totalMs=${event.totalMs} beats=${event.beats} turnId=${event.turnId}`);
      } else if (event.type === "error") {
        console.log(`[${elapsed}ms] [error] message=${JSON.stringify(event.message)}`);
        failed = true;
      } else {
        console.log(`[${elapsed}ms] [?] ${line}`);
      }
    } catch {
      console.log(`[${elapsed}ms] [unparseable] ${line}`);
      failed = true;
    }
    newline = buffer.indexOf("\n");
  }
}

process.exit(failed ? 1 : 0);
