export const GIB_BYTES = 1024 ** 3;

// Every threshold of the traffic light. Initial values; the 14-day checkpoint in the spec
// re-measures them against what actually fired.
export const STATUS_RULES = {
  historyDays: 7,
  // Крани — ontap runs every 12 h.
  scrapeYellowHours: 14,          // the old digest's ⚠️ threshold, carried over
  scrapeRedHours: 26,             // two missed 12 h cycles plus slack
  pubsYellowShare: 0.9,           // pubs scraped in 24 h vs the 7-day median
  // Untappd
  ratingsMissingRel: 0.1,
  ratingsMissingAbs: 20,
  // Фест — multiples of the job's own cycle
  festYellowCycles: 2,
  festRedCycles: 4,
  // Інфраструктура — the resource monitor's own values (scripts/ops/resource_monitor.py)
  diskYellowBytes: 10 * GIB_BYTES,
  diskRedBytes: 5 * GIB_BYTES,
  inodesRedFree: 100_000,
  diskFallYellowBytesPerDay: GIB_BYTES,
  // Тренди — a line needs BOTH the relative and the absolute move (small bases are noise)
  stockRel: 0.1,
  stockAbs: 20,
  diskTrendAbsBytes: GIB_BYTES,
  flowRel: 0.5,
  flowAbs: 10,
  // Хост-патчі (#469 stage 2, spec rules table). Ages compare in seconds: "> 3 days" is strict.
  rebootYellowDays: 3,
  rebootRedDays: 14,
  staleServiceYellowDays: 1,
  unattendedStaleYellowDays: 2,
  livepatchSupportYellowDays: 30,
  eolYellowDays: 180,
  eolRedDays: 30,
  // No machine-readable source is worth a fetch for a date that does not move.
  ubuntuStandardSupportEnd: '2029-05-31',
  nodeSecurityRedDays: 3,          // a security release unattended-upgrades has not installed in 3 days
  litestreamYellowDays: 30,        // litestream is upgraded by hand (it writes the backup)
  snapshotRetentionDays: 90,
} as const;
