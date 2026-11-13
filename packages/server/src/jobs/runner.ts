// Runs jobs from the table, one at a time, holding a lease it renews while the job works.
// One runner per process. The app's runner handles the check kinds; M4's updater process will
// run its own runner over the update kinds, with its own key, against the same table.
import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { recordEvent } from '../events.js';
import { claim, finish, interruptExpired, renew, type Job } from './store.js';

export interface JobContext {
  /** Aborted on shutdown or when the lease is lost. Long work must check it. */
  signal: AbortSignal;
  now: () => number;
}

export type Handler = (job: Job, ctx: JobContext) => Promise<unknown>;

export interface RunnerOptions {
  handlers: Record<string, Handler>;
  now?: () => number;
  leaseMs?: number;
  pollMs?: number;
  owner?: string;
  log?: (message: string) => void;
}

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);

export class Runner {
  readonly owner: string;
  private readonly handlers: Record<string, Handler>;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly log: (message: string) => void;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private current: AbortController | null = null;
  /** Gives up on the running job, for stop(): its handler may not be listening to the signal. */
  private abandon: (() => void) | null = null;
  private wakeUp: (() => void) | null = null;

  constructor(
    private readonly db: Db,
    options: RunnerOptions,
  ) {
    this.handlers = options.handlers;
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.pollMs = options.pollMs ?? 1_000;
    this.owner = options.owner ?? `app-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.log = options.log ?? (() => {});
  }

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  /**
   * Stops claiming, aborts the running job and marks it interrupted straight away, without waiting
   * for its handler: a check or report that doesn't watch the signal would hold a restart for
   * minutes. Interrupting is safe, as after a crash; the next start runs a fresh cycle.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.current?.abort(new Error('shutdown'));
    this.abandon?.();
    this.wake();
    await this.loop;
    this.loop = null;
  }

  /** Checks for work now instead of at the next poll. */
  wake(): void {
    this.wakeUp?.();
  }

  /** One pass: mark expired leases, then run one due job. True if a job ran. */
  async tick(): Promise<boolean> {
    for (const job of interruptExpired(this.db, this.now())) {
      recordEvent(this.db, this.now(), {
        kind: 'job.interrupted',
        summary: `A ${job.kind} job was interrupted and not retried`,
        detail: { job: job.id },
      });
      this.log(`job ${job.id} (${job.kind}) interrupted: lease expired`);
    }
    const job = claim(this.db, this.now(), this.owner, this.leaseMs, Object.keys(this.handlers));
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let ran = false;
      try {
        ran = await this.tick();
      } catch (error) {
        this.log(`runner: ${message(error)}`);
      }
      if (!ran && !this.stopping) await this.sleep(this.pollMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = done;
    });
  }

  private async execute(job: Job): Promise<void> {
    const handler = this.handlers[job.kind];
    const controller = new AbortController();
    this.current = controller;
    const renewal = setInterval(
      () => {
        if (!renew(this.db, job.id, this.owner, this.now() + this.leaseMs)) {
          controller.abort(new Error('lease lost'));
        }
      },
      Math.max(10, Math.floor(this.leaseMs / 3)),
    );
    try {
      if (!handler) throw new Error(`no handler for ${job.kind}`);
      const work = handler(job, { signal: controller.signal, now: this.now });
      // Once abandoned, whatever the handler does after is nobody's to handle.
      work.catch(() => {});
      const abandoned = new Promise<never>((_resolve, reject) => {
        this.abandon = () => reject(new Error('shutdown'));
      });
      const result = await Promise.race([work, abandoned]);
      finish(this.db, this.now(), job.id, this.owner, { state: 'succeeded', result });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const reason = aborted ? message(controller.signal.reason) : message(error);
      const wrote = finish(this.db, this.now(), job.id, this.owner, {
        state: aborted ? 'interrupted' : 'failed',
        error: reason,
      });
      if (wrote) {
        recordEvent(this.db, this.now(), {
          kind: aborted ? 'job.interrupted' : 'job.failed',
          summary: aborted
            ? `A ${job.kind} job was interrupted (${reason}) and not retried`
            : `A ${job.kind} job failed`,
          detail: { job: job.id, error: reason },
        });
      }
      this.log(`job ${job.id} (${job.kind}) ${aborted ? 'interrupted' : 'failed'}: ${reason}`);
    } finally {
      clearInterval(renewal);
      this.current = null;
      this.abandon = null;
    }
  }
}
