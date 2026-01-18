/**
 * Points & Payout Calculation Utilities
 *
 * Handles all points-related calculations including:
 * - Potential payouts based on odds
 * - XP earnings
 * - Streak multipliers
 * - Token holder bonuses
 */

// Token holders get 10% bonus on payouts
const TOKEN_HOLDER_BONUS = 0.10;

// Streak multipliers for consecutive wins
const STREAK_MULTIPLIERS: Record<number, number> = {
  0: 1.0,    // No streak
  1: 1.0,    // 1 win (streak starts)
  2: 1.05,   // 2 wins: +5%
  3: 1.10,   // 3 wins: +10%
  4: 1.15,   // 4 wins: +15%
  5: 1.20,   // 5+ wins: +20% (max)
};

/**
 * Calculate potential payout for a prediction
 *
 * Payout is based on the odds at time of prediction:
 * - Lower odds (less likely) = higher potential payout
 * - Formula: wager / odds = potential payout
 *
 * Example: 100 points wagered at 0.25 odds = 400 points potential return
 *
 * @param pointsWagered - Amount wagered
 * @param odds - The price/probability (0.0 to 1.0)
 * @param isTokenHolder - Whether user holds platform token
 * @returns Potential payout (total return, including original wager)
 */
export function calculatePotentialPayout(
  pointsWagered: number,
  odds: number,
  isTokenHolder: boolean = false
): number {
  // Clamp odds to valid range
  const clampedOdds = Math.max(0.01, Math.min(0.99, odds));

  // Base payout: wager / odds
  let payout = pointsWagered / clampedOdds;

  // Token holder bonus
  if (isTokenHolder) {
    payout *= (1 + TOKEN_HOLDER_BONUS);
  }

  return payout;
}

/**
 * Calculate actual payout when a prediction wins
 * Includes streak multiplier
 *
 * @param pointsWagered - Amount wagered
 * @param oddsAtPrediction - The odds when prediction was made
 * @param currentStreak - Current win streak before this win
 * @param isTokenHolder - Whether user held token at time of prediction
 * @returns Actual payout amount
 */
export function calculateWinPayout(
  pointsWagered: number,
  oddsAtPrediction: number,
  currentStreak: number = 0,
  isTokenHolder: boolean = false
): number {
  // Base payout
  let payout = calculatePotentialPayout(pointsWagered, oddsAtPrediction, isTokenHolder);

  // Apply streak multiplier
  const streakLevel = Math.min(currentStreak, 5);
  const streakMultiplier = STREAK_MULTIPLIERS[streakLevel] || 1.0;
  payout *= streakMultiplier;

  return Math.round(payout);
}

/**
 * Calculate XP earned from a prediction
 *
 * XP is earned for:
 * - Making a prediction (base XP)
 * - Winning (bonus XP based on odds difficulty)
 * - Streak bonuses
 * - Token holder 2x multiplier
 *
 * @param won - Whether the prediction was correct
 * @param oddsAtPrediction - The odds when prediction was made
 * @param pointsWagered - Amount wagered (higher wagers = more XP)
 * @param currentStreak - Current win streak
 * @param isTokenHolder - Token holder gets 2x XP
 * @returns XP earned
 */
export function calculateXpEarned(
  won: boolean,
  oddsAtPrediction: number,
  pointsWagered: number,
  currentStreak: number = 0,
  isTokenHolder: boolean = false
): number {
  // Base XP for participating
  let xp = 5;

  if (won) {
    // Win bonus: base 10 XP
    xp += 10;

    // Difficulty bonus: harder predictions give more XP
    // Odds 0.5 = +0 XP, Odds 0.1 = +40 XP, Odds 0.9 = +0 XP (was expected)
    if (oddsAtPrediction < 0.5) {
      const difficultyBonus = Math.round((0.5 - oddsAtPrediction) * 100);
      xp += difficultyBonus;
    }

    // Wager size bonus: 1 XP per 100 points wagered, max +10
    const wagerBonus = Math.min(Math.floor(pointsWagered / 100), 10);
    xp += wagerBonus;

    // Streak bonus: +5 XP per streak level, max +25
    const streakBonus = Math.min(currentStreak * 5, 25);
    xp += streakBonus;
  }

  // Token holder 2x multiplier
  if (isTokenHolder) {
    xp *= 2;
  }

  return xp;
}

/**
 * Calculate daily allowance for players who go broke
 * Gives players a chance to recover without grinding from zero
 *
 * @param currentPoints - Player's current points
 * @param isTokenHolder - Token holders get larger allowance
 * @returns Points to award (0 if player has enough)
 */
export function calculateDailyAllowance(
  currentPoints: number,
  isTokenHolder: boolean = false
): number {
  // Threshold: below 50 points triggers allowance
  const threshold = 50;

  if (currentPoints >= threshold) {
    return 0;
  }

  // Base allowance brings player up to 100 points
  const baseAllowance = 100 - currentPoints;

  // Token holders get 2x allowance (up to 200 points)
  if (isTokenHolder) {
    return Math.max(0, 200 - currentPoints);
  }

  return Math.max(0, baseAllowance);
}

/**
 * Calculate tournament prize distribution
 *
 * @param prizePool - Total points in the pool
 * @param totalParticipants - Number of participants
 * @returns Array of prizes for top positions
 */
export function calculateTournamentPrizes(
  prizePool: number,
  totalParticipants: number
): number[] {
  // Prize distribution percentages for top 10
  const distribution = [
    0.30,  // 1st: 30%
    0.20,  // 2nd: 20%
    0.12,  // 3rd: 12%
    0.08,  // 4th: 8%
    0.06,  // 5th: 6%
    0.05,  // 6th: 5%
    0.05,  // 7th: 5%
    0.05,  // 8th: 5%
    0.05,  // 9th: 5%
    0.04,  // 10th: 4%
  ];

  // Only pay out positions that exist
  const payoutPositions = Math.min(
    Math.ceil(totalParticipants * 0.3), // Top 30%
    10 // Max 10 prizes
  );

  const prizes: number[] = [];
  let remaining = prizePool;

  for (let i = 0; i < payoutPositions; i++) {
    const prize = Math.floor(prizePool * (distribution[i] || 0.02));
    prizes.push(prize);
    remaining -= prize;
  }

  // Add any rounding remainder to first place
  if (remaining > 0 && prizes.length > 0) {
    prizes[0] += remaining;
  }

  return prizes;
}

/**
 * Calculate battle payout for winner
 *
 * @param winnerStake - Points the winner put up
 * @param loserStake - Points the loser put up
 * @param isRanked - Ranked battles have slightly lower rake
 * @returns Points the winner receives
 */
export function calculateBattlePayout(
  winnerStake: number,
  loserStake: number,
  isRanked: boolean = false
): number {
  // In battles, winner gets their stake back + loser's stake
  // Small house rake for unranked (5%), smaller for ranked (2%)
  const rake = isRanked ? 0.02 : 0.05;
  const loserContribution = Math.floor(loserStake * (1 - rake));

  return winnerStake + loserContribution;
}

/**
 * Get streak multiplier for display
 */
export function getStreakMultiplier(streak: number): number {
  const level = Math.min(streak, 5);
  return STREAK_MULTIPLIERS[level] || 1.0;
}

/**
 * Format points for display (with commas)
 */
export function formatPoints(points: number): string {
  return points.toLocaleString();
}

/**
 * Calculate minimum wager based on user's balance
 * Prevents users from making tiny bets that clog up the system
 */
export function getMinimumWager(userPoints: number): number {
  // Minimum 10 points or 1% of balance, whichever is higher
  return Math.max(10, Math.floor(userPoints * 0.01));
}

/**
 * Calculate maximum wager based on user's balance
 * Prevents users from betting everything on one prediction
 */
export function getMaximumWager(userPoints: number): number {
  // Maximum 50% of balance
  return Math.floor(userPoints * 0.5);
}
