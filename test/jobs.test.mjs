import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./harness.mjs";

test("a single paper runs as a job: found, note, done", async () => {
  const ZR = load();
  const r = await ZR.Jobs.run({ kind: "pdf", label: "Find PDF: X", current: "X", note: (a) => (a ? "PDF attached" : "no PDF found") }, async () => ({ id: 1 }));
  assert.deepEqual(r, { id: 1 });
  const j = ZR.Jobs.list().at(-1);
  assert.equal(j.state, "done");
  assert.equal(j.found, 1);
  assert.equal(j.note, "PDF attached");
});

test("a failed single job reports the error and rethrows", async () => {
  const ZR = load();
  await assert.rejects(ZR.Jobs.run({ kind: "pdf", label: "Find PDF: Y" }, async () => {
    throw new Error("boom");
  }), /boom/);
  const j = ZR.Jobs.list().at(-1);
  assert.equal(j.failed, 1);
  assert.equal(j.note, "boom");
});

test("parallel jobs: stopping cancels what started since the oldest paper in work", async () => {
  const ZR = load();
  const job = ZR.Jobs.start({ kind: "annotate", label: "A", total: 3, parallel: true });
  assert.equal(await job.gate("one"), true);
  const first = job.itemStarted;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await job.gate("two"), true);
  assert.equal(job.itemStarted, first); // the oldest in work
  job.release();
  job.release();
  await new Promise((r) => setTimeout(r, 5));
  await job.gate("three");
  assert.ok(job.itemStarted > first); // nothing older in work any more
  ZR.Jobs.stop(job.id);
  assert.equal(await job.gate("four"), false);
});
