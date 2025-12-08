import {
  Config,
  PlaybookBullet,
  FeedbackEvent,
  BulletMaturity,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers to tolerate config drift (scoring section vs legacy fields)
// ---------------------------------------------------------------------------

function getHalfLifeDays(config: Config): number {
  const fromScoring = (config as any)?.scoring?.decayHalfLifeDays;
  if (typeof fromScoring === "number" && fromScoring > 0) return fromScoring;
  const legacy = (config as any)?.defaultDecayHalfLife;
  if (typeof legacy === "number" && legacy > 0) return legacy;
  return 90;
}

function getHarmfulMultiplier(config: Config): number {
  const fromScoring = (config as any)?.scoring?.harmfulMultiplier;
  if (typeof fromScoring === "number" && fromScoring > 0) return fromScoring;
  return 4;
}

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

export function calculateDecayedValue(
  event: FeedbackEvent,
  now: Date,
  halfLifeDays = 90
): number {
  const eventDate = new Date(event.timestamp);
  const ageMs = now.getTime() - eventDate.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(ageDays) || halfLifeDays <= 0) return 0;

  // Exponential decay: value = 1 * (0.5)^(age/halfLife); clamp future events
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

export function getDecayedCounts(
  bullet: PlaybookBullet,
  config: Config
): { decayedHelpful: number; decayedHarmful: number } {
  const now = new Date();
  const halfLifeDays = getHalfLifeDays(config);
  let decayedHelpful = 0;
  let decayedHarmful = 0;

  const allHelpful = [
    ...(bullet.helpfulEvents || []),
    ...(bullet.feedbackEvents || []).filter((e) => e.type === "helpful"),
  ];
  const allHarmful = [
    ...(bullet.harmfulEvents || []),
    ...(bullet.feedbackEvents || []).filter((e) => e.type === "harmful"),
  ];

  for (const event of allHelpful) {
    const val = calculateDecayedValue(event, now, halfLifeDays);
    if (Number.isFinite(val)) decayedHelpful += val;
  }
  for (const event of allHarmful) {
    const val = calculateDecayedValue(event, now, halfLifeDays);
    if (Number.isFinite(val)) decayedHarmful += val;
  }

  return { decayedHelpful, decayedHarmful };
}

// ---------------------------------------------------------------------------
// Effective score
// ---------------------------------------------------------------------------

export function getEffectiveScore(
  bullet: PlaybookBullet,
  config: Config
): number {
  const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);

  const harmfulMultiplier = getHarmfulMultiplier(config);
  const rawScore = decayedHelpful - harmfulMultiplier * decayedHarmful;

  const maturityMultiplier: Record<BulletMaturity, number> = {
    candidate: 0.5,
    established: 1.0,
    proven: 1.5,
    deprecated: 0,
  };

  const multiplier = maturityMultiplier[bullet.maturity] ?? 1.0;
  return rawScore * multiplier;
}

// ---------------------------------------------------------------------------
// Maturity transitions
// ---------------------------------------------------------------------------

export function calculateMaturityState(
  bullet: PlaybookBullet,
  config: Config
): BulletMaturity {
  if (bullet.maturity === "deprecated" || bullet.deprecated) return "deprecated";

  const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);
  const total = decayedHelpful + decayedHarmful;
  const harmfulRatio = total > 0 ? decayedHarmful / total : 0;

  if (harmfulRatio > 0.3 && total > 2) return "deprecated";
  if (total < 3) return "candidate";
  if (decayedHelpful >= 10 && harmfulRatio < 0.1) return "proven";
  return "established";
}

export function checkForPromotion(
  bullet: PlaybookBullet,
  config: Config
): BulletMaturity {
  const current = bullet.maturity;
  if (current === "proven" || current === "deprecated") return current;

  const newState = calculateMaturityState(bullet, config);
  const isPromotion =
    (current === "candidate" &&
      (newState === "established" || newState === "proven")) ||
    (current === "established" && newState === "proven");

  return isPromotion ? newState : current;
}

export function checkForDemotion(
  bullet: PlaybookBullet,
  config: Config
): BulletMaturity | "auto-deprecate" {
  if (bullet.pinned) return bullet.maturity;

  const score = getEffectiveScore(bullet, config);

  if (score < -config.pruneHarmfulThreshold) {
    return "auto-deprecate";
  }

  if (score < 0) {
    if (bullet.maturity === "proven") return "established";
    if (bullet.maturity === "established") return "candidate";
  }

  return bullet.maturity;
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

export function isStale(
  bullet: PlaybookBullet,
  staleDays = 90
): boolean {
  const events = [
    ...(bullet.helpfulEvents || []),
    ...(bullet.harmfulEvents || []),
    ...(bullet.feedbackEvents || []),
  ];

  if (events.length === 0) {
    return (
      Date.now() - new Date(bullet.createdAt).getTime() >
      staleDays * 86_400_000
    );
  }

  const lastTs = Math.max(
    ...events.map((e) => new Date(e.timestamp).getTime())
  );
  return Date.now() - lastTs > staleDays * 86_400_000;
}

// ---------------------------------------------------------------------------
// Score distribution helper (used by stats command)
// ---------------------------------------------------------------------------

export function analyzeScoreDistribution(
  bullets: PlaybookBullet[],
  config: Config
): { excellent: number; good: number; neutral: number; atRisk: number } {
  let excellent = 0;
  let good = 0;
  let neutral = 0;
  let atRisk = 0;

  for (const b of bullets) {
    const score = getEffectiveScore(b, config);
    if (score > 10) excellent++;
    else if (score >= 5) good++;
    else if (score >= 0) neutral++;
    else atRisk++;
  }

  return { excellent, good, neutral, atRisk };
}

// ---------------------------------------------------------------------------
// Score Distribution Analysis
// ---------------------------------------------------------------------------

export function analyzeScoreDistribution(
  bullets: PlaybookBullet[],
  config: Config
): { excellent: number; good: number; neutral: number; atRisk: number } {
  let excellent = 0;
  let good = 0;
  let neutral = 0;
  let atRisk = 0;

  for (const bullet of bullets) {
    const score = getEffectiveScore(bullet, config);
    if (score >= 5) excellent++;
    else if (score >= 2) good++;
    else if (score >= 0) neutral++;
    else atRisk++;
  }

  return { excellent, good, neutral, atRisk };
}
