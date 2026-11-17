/**
 * PRD: "Each job gets a budget of N upstream attempts and 240 seconds of wall-clock time across
 * both passes; whichever runs out first ends the job with the matching error."
 * Counted as FAILED attempts (successful calls are free), so a job can always finish both passes.
 */
export class JobBudget {
  private failuresLeft: number;
  readonly deadline: number;
  private readonly now: () => number;
  failures = 0;

  constructor(opts: { maxFailedAttempts: number; timeoutMs: number; now?: () => number }) {
    this.now = opts.now ?? Date.now;
    this.failuresLeft = opts.maxFailedAttempts;
    this.deadline = this.now() + opts.timeoutMs;
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - this.now());
  }

  /** Records a failed attempt. Returns true if another attempt is allowed. */
  fail(): boolean {
    this.failures++;
    this.failuresLeft--;
    return this.failuresLeft >= 0;
  }

  get exhausted(): boolean {
    return this.failuresLeft <= 0 || this.remainingMs() <= 0;
  }
}
