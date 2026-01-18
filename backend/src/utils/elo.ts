/**
 * ELO Rating System Utilities
 *
 * Based on chess ELO with modifications for prediction markets:
 * - K-factor varies by rank (higher K for lower ranks = faster movement)
 * - Bonus/penalty based on odds (beating long odds = more ELO)
 * - Streak bonuses for consecutive wins
 */

import { RankTier } from '@prisma/client';

// ELO thresholds for each rank tier
const RANK_THRESHOLDS: Record<RankTier, { min: number; max: number }> = {
  BRONZE: { min: 0, max: 1199 },
  SILVER: { min: 1200, max: 1399 },
  GOLD: { min: 1400, max: 1599 },
  PLATINUM: { min: 1600, max: 1799 },
  DIAMOND: { min: 1800, max: 1999 },
  MASTER: { min: 2000, max: 2199 },
  GRANDMASTER: { min: 2200, max: Infinity }
};

// K-factor by rank (how much ELO can change per prediction)
// Lower ranks have higher K for faster progression
const K_FACTORS: Record<RankTier, number> = {
  BRONZE: 40,
  SILVER: 35,
  GOLD: 32,
  PLATINUM: 28,
  DIAMOND: 24,
  MASTER: 20,
  GRANDMASTER: 16
};

/**
 * Get the rank tier based on ELO rating
 */
export function getRankTier(elo: number): RankTier {
  if (elo >= 2200) return 'GRANDMASTER';
  if (elo >= 2000) return 'MASTER';
  if (elo >= 1800) return 'DIAMOND';
  if (elo >= 1600) return 'PLATINUM';
  if (elo >= 1400) return 'GOLD';
  if (elo >= 1200) return 'SILVER';
  return 'BRONZE';
}

/**
 * Get the K-factor for a player based on their current rank
 */
export function getKFactor(elo: number): number {
  const tier = getRankTier(elo);
  return K_FACTORS[tier];
}

/**
 * Calculate expected score (probability of winning) based on ELO difference
 * Uses the standard ELO formula: E = 1 / (1 + 10^((opponent - player) / 400))
 *
 * For predictions, we use the market odds as the "opponent" ELO equivalent
 */
export function calculateExpectedScore(playerElo: number, opponentElo: number): number {
  return 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
}

/**
 * Calculate ELO change for a prediction outcome
 *
 * @param currentElo - Player's current ELO
 * @param won - Whether the prediction was correct
 * @param oddsAtPrediction - The price/probability when prediction was made (0.0 to 1.0)
 * @param currentStreak - Current win streak (for bonus)
 * @returns ELO change (positive or negative)
 */
export function calculateEloChange(
  currentElo: number,
  won: boolean,
  oddsAtPrediction: number,
  currentStreak: number = 0
): number {
  const K = getKFactor(currentElo);

  // Convert odds to an "opponent ELO"
  // Low odds (unlikely) predictions are like beating a high-rated opponent
  // We map odds 0.0-1.0 to an ELO range centered around the player's ELO
  // 0.5 odds = same ELO, 0.1 odds = +400 ELO opponent, 0.9 odds = -400 ELO opponent
  const oddsDeviation = (0.5 - oddsAtPrediction) * 800;
  const impliedOpponentElo = currentElo + oddsDeviation;

  // Expected score based on the "odds difficulty"
  const expectedScore = calculateExpectedScore(currentElo, impliedOpponentElo);

  // Actual score (1 for win, 0 for loss)
  const actualScore = won ? 1 : 0;

  // Base ELO change
  let eloChange = Math.round(K * (actualScore - expectedScore));

  // Streak bonus: +10% per streak level, max +50%
  if (won && currentStreak > 0) {
    const streakMultiplier = 1 + Math.min(currentStreak * 0.1, 0.5);
    eloChange = Math.round(eloChange * streakMultiplier);
  }

  // Minimum change of 1 for wins, -1 for losses (no zero changes)
  if (won && eloChange < 1) eloChange = 1;
  if (!won && eloChange > -1) eloChange = -1;

  return eloChange;
}

/**
 * Calculate ELO change for head-to-head battle
 *
 * @param winnerElo - Winner's current ELO
 * @param loserElo - Loser's current ELO
 * @param scoreDiff - Point difference in the battle (for K modifier)
 * @returns Object with ELO changes for both players
 */
export function calculateBattleEloChange(
  winnerElo: number,
  loserElo: number,
  scoreDiff: number = 1
): { winnerChange: number; loserChange: number } {
  // Use average K-factor of both players
  const winnerK = getKFactor(winnerElo);
  const loserK = getKFactor(loserElo);
  const avgK = (winnerK + loserK) / 2;

  // Expected scores
  const winnerExpected = calculateExpectedScore(winnerElo, loserElo);
  const loserExpected = 1 - winnerExpected;

  // Calculate changes
  let winnerChange = Math.round(avgK * (1 - winnerExpected));
  let loserChange = Math.round(avgK * (0 - loserExpected));

  // Score difference bonus (up to +50% for dominant wins)
  if (scoreDiff > 1) {
    const scoreMultiplier = 1 + Math.min((scoreDiff - 1) * 0.1, 0.5);
    winnerChange = Math.round(winnerChange * scoreMultiplier);
    loserChange = Math.round(loserChange * scoreMultiplier);
  }

  // Minimum changes
  if (winnerChange < 1) winnerChange = 1;
  if (loserChange > -1) loserChange = -1;

  return { winnerChange, loserChange };
}

/**
 * Calculate ELO decay for inactive players
 * Players lose ELO if they haven't made predictions recently
 *
 * @param currentElo - Player's current ELO
 * @param daysSinceLastPrediction - Days since last activity
 * @returns ELO to subtract (always non-negative)
 */
export function calculateEloDecay(
  currentElo: number,
  daysSinceLastPrediction: number
): number {
  // No decay for players at or below starting ELO
  if (currentElo <= 1200) return 0;

  // No decay for first 7 days of inactivity
  if (daysSinceLastPrediction <= 7) return 0;

  // Decay starts after 7 days: 5 ELO per day, max 25 per week
  const decayDays = daysSinceLastPrediction - 7;
  const decay = Math.min(decayDays * 5, 25);

  // Don't decay below 1200
  const maxDecay = currentElo - 1200;

  return Math.min(decay, maxDecay);
}

/**
 * Calculate soft reset ELO for new season
 * Compresses everyone toward the mean while preserving relative ranking
 *
 * @param currentElo - Player's current ELO
 * @param seasonMean - Average ELO of all players (usually ~1200)
 * @returns New ELO for the season
 */
export function calculateSeasonResetElo(
  currentElo: number,
  seasonMean: number = 1200
): number {
  // Soft reset: move 50% toward the mean
  return Math.round(seasonMean + (currentElo - seasonMean) * 0.5);
}

/**
 * Get progress to next rank as percentage
 */
export function getRankProgress(elo: number): number {
  const tier = getRankTier(elo);
  const { min, max } = RANK_THRESHOLDS[tier];

  if (tier === 'GRANDMASTER') return 100;

  const progress = ((elo - min) / (max - min)) * 100;
  return Math.round(Math.max(0, Math.min(100, progress)));
}

/**
 * Get ELO needed for next rank
 */
export function getEloForNextRank(elo: number): number | null {
  const tier = getRankTier(elo);
  const { max } = RANK_THRESHOLDS[tier];

  if (tier === 'GRANDMASTER') return null;

  return max + 1;
}
