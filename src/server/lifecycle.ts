// ═════════════════════════════════════════════════════════════════════════════
// Cloud Run lifecycle — in-flight background generation tracker.
// ═════════════════════════════════════════════════════════════════════════════
//
// Why this exists:
//   With `--min-instances=0` and `--no-cpu-throttling`, Cloud Run can reap an
//   idle instance (no active HTTP requests) even while a long-running Premium
//   batch is still churning in the background. Cloud Run sends SIGTERM with
//   only ~10s grace before SIGKILL.
//
//   This module lets the background pipeline register/unregister generation
//   IDs so the SIGTERM handler can:
//     1. Log loudly which generation IDs are about to be killed
//        (so the operator can correlate with watchdog refunds in metrics).
//     2. Briefly delay process.exit while batches finish — bounded by
//        Cloud Run's grace period.
//
// The DB watchdog (`reclaim_orphaned_generations`) is the actual safety net:
// it reclaims and refunds any zombie left behind. This module is observability
// + best-effort drain, not a replacement for the watchdog.
// ═════════════════════════════════════════════════════════════════════════════

const inFlight = new Set<string>();
let shuttingDown = false;

export function markGenerationStart(id: string): void {
  inFlight.add(id);
}

export function markGenerationEnd(id: string): void {
  inFlight.delete(id);
}

export function getInFlightCount(): number {
  return inFlight.size;
}

export function getInFlightIds(): string[] {
  return [...inFlight];
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function setShuttingDown(): void {
  shuttingDown = true;
}
