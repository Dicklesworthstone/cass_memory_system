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

  // Clamp future events to 0 age (value 1.0)
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

  const allHelpful = (bullet.feedbackEvents || []).filter((e) => e.type === "helpful");
  const allHarmful = (bullet.feedbackEvents || []).filter((e) => e.type === "harmful");

  for (const event of allHelpful) {
    const base = calculateDecayedValue(event, now, halfLifeDays);
    // `decayedValue` is an optional per-event weight used by implicit feedback
    // (e.g., outcomes) to represent stronger/weaker signals. Default weight is 1.
    const weight =
      typeof event.decayedValue === "number" && Number.isFinite(event.decayedValue)
        ? Math.max(0, event.decayedValue)
        : 1;
    const val = base * weight;
    if (Number.isFinite(val)) decayedHelpful += val;
  }
  for (const event of allHarmful) {
    const base = calculateDecayedValue(event, now, halfLifeDays);
    const weight =
      typeof event.decayedValue === "number" && Number.isFinite(event.decayedValue)
        ? Math.max(0, event.decayedValue)
        : 1;
    const val = base * weight;
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
  // No floor at 0 for raw score? A very harmful rule should be negative.
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
  
  // Pinned bullets should not be auto-deprecated or demoted by feedback
  if (bullet.pinned) return bullet.maturity;

  const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);
  
  const total = decayedHelpful + decayedHarmful;
  // Use epsilon for float comparisons
  const epsilon = 0.01;
  const safeTotal = total > epsilon ? total : 0;
  
  const harmfulRatio = safeTotal > 0 ? decayedHarmful / safeTotal : 0;

  const { minFeedbackForActive, minHelpfulForProven, maxHarmfulRatioForProven } = config.scoring;

  // If we have enough signal and it's bad -> deprecated
  // We use minFeedbackForActive (default 3) as threshold for automatic deprecation too?
  // Yes, to give it a chance to recover if just 1 bad event? 
  // But 1 bad event might be enough if ratio > 0.3.
  // Let's stick to minFeedbackForActive - epsilon to be consistent.
  if (harmfulRatio > 0.3 && safeTotal >= (minFeedbackForActive - epsilon)) return "deprecated"; 
  
  // If not enough signal yet -> candidate
  if (safeTotal < (minFeedbackForActive - epsilon)) return "candidate";                        
  
  // If strong positive signal -> proven
  if (decayedHelpful >= (minHelpfulForProven - epsilon) && harmfulRatio < maxHarmfulRatioForProven) return "proven";
  
  // Otherwise -> established
  return "established";
}

export function checkForPromotion(
  bullet: PlaybookBullet,
  config: Config
): BulletMaturity {
  const current = bullet.maturity;
  if (current === "proven" || current === "deprecated") return current;

  const newState = calculateMaturityState(bullet, config);
  
  // Allow promotion sequence: candidate -> established -> proven
  // Also allow candidate -> proven directly if signal is strong enough
  const isPromotion =
    (current === "candidate" && (newState === "established" || newState === "proven")) ||
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
  const events = bullet.feedbackEvents || [];

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
    if (score >= 10) excellent++;
    else if (score >= 5) good++;
    else if (score >= 0) neutral++;
    else atRisk++;
  }

  return { excellent, good, neutral, atRisk };
}
