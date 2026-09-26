/* global ZR */
// Long steps you can watch and steer: finding PDFs (each crawler or AI agent on its own),
// annotating full texts, … Each job has a progress (done / total), counts (found, failed),
// the paper it works on, and can be paused, resumed or stopped. Stopping keeps what is
// done; the step (or the autopilot) goes on with it. The loops ask job.gate() before each
// paper: it waits while the job is paused and says false once it should stop.

ZR.Jobs = (() => {
  const jobs = [];
  const listeners = new Set();
  let seq = 0;
  const now = () => Date.now();
  const emit = () => {
    for (const f of listeners) {
      try {
        f();
      } catch (e) {
        /* a closed panel */
      }
    }
  };

  /**
   * @param {{kind: string, label: string, total?: number, queued?: boolean, parallel?: boolean}} o
   * kind: "pdf" | "crawler" | "ai" | "annotate" | … (only for the icon and the grouping)
   */
  function start(o) {
    const job = {
      id: "j" + ++seq,
      kind: o.kind || "job",
      label: o.label || "Working",
      total: o.total || 0,
      done: 0,
      found: 0,
      failed: 0,
      current: "",
      state: o.queued ? "queued" : "running",
      started: o.queued ? 0 : now(),
      ended: 0,
      itemStarted: 0,
      parallel: !!o.parallel,
      active: 0,
      note: "",
      _wake: null,
      /** Before each paper: waits while paused; false when the job should stop. */
      async gate(current = "") {
        if (job.state === "queued") job.begin();
        if (ZR.Activity?.stopping && job.state !== "stopping") job.state = "stopping";
        while (job.state === "paused") await new Promise((r) => (job._wake = r));
        if (job.state === "stopping" || job.state === "stopped") return false;
        job.current = current;
        // several papers at once (parallel): stopping cancels everything started since the
        // oldest paper still in work; each paper calls release() when it is done
        if (!job.parallel || !job.active) job.itemStarted = now();
        if (job.parallel) job.active++;
        emit();
        return true;
      },
      release() {
        job.active = Math.max(0, job.active - 1);
      },
      begin() {
        if (job.state !== "queued") return;
        job.state = "running";
        job.started = now();
        emit();
      },
      progress(patch = {}) {
        Object.assign(job, patch);
        emit();
      },
      /** The loop is over: "done", or "stopped" when it was asked to stop. */
      finish(note = "") {
        job.state = job.state === "stopping" ? "stopped" : job.state === "queued" ? "skipped" : "done";
        job.current = "";
        job.ended = now();
        if (note) job.note = note;
        emit();
      },
    };
    jobs.push(job);
    if (jobs.length > 40) jobs.splice(0, jobs.length - 40);
    emit();
    return job;
  }

  /**
   * One task (a single paper) as a job, so it shows under Work in progress and can be
   * stopped. fn(job) returns the result; a truthy result counts as found.
   * note(result) is the line shown when it is done.
   */
  async function run(o, fn) {
    const job = start(Object.assign({ total: 1 }, o));
    try {
      if (!(await job.gate(o.current || ""))) {
        job.finish();
        return null;
      }
      const r = await fn(job);
      job.progress({ done: 1, found: r ? 1 : 0 });
      job.finish(o.note ? o.note(r) : "");
      return r;
    } catch (e) {
      job.progress({ done: 1, failed: job.state === "stopping" ? 0 : 1 });
      job.finish(job.state === "stopping" ? "" : e.message);
      throw e;
    }
  }

  const get = (id) => jobs.find((j) => j.id === id);
  const active = (j) => ["queued", "running", "paused", "stopping"].includes(j.state);

  function pause(id) {
    const j = get(id);
    if (j && (j.state === "running" || j.state === "queued")) j.state = "paused";
    emit();
  }
  function resume(id) {
    const j = get(id);
    if (j?.state === "paused") {
      j.state = j.started ? "running" : "queued";
      j._wake?.();
    }
    emit();
  }
  /** Stop after the current paper (its running AI calls and requests are cancelled). */
  function stop(id) {
    const j = get(id);
    if (!j || !active(j)) return;
    j.state = "stopping";
    j._wake?.();
    // what this job is waiting for right now (an AI call, a crawler request) ends at once
    for (const e of ZR.Activity?.running?.() || []) if (e.cancel && j.itemStarted && e.started >= j.itemStarted) ZR.Activity.cancel(e.id);
    emit();
  }

  /** Rate and remaining time from the papers done so far. */
  function eta(j) {
    if (!j.started || !j.done || !j.total || j.done >= j.total) return null;
    const per = (now() - j.started) / j.done;
    return Math.round((per * (j.total - j.done)) / 1000);
  }

  return {
    start,
    run,
    get,
    pause,
    resume,
    stop,
    eta,
    list: () => jobs.slice(),
    running: () => jobs.filter(active),
    subscribe(f) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    _reset() {
      jobs.length = 0;
    },
  };
})();
