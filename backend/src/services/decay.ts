/**
 * ELO Decay Service
 *
 * Handles ELO decay for inactive players to:
 * - Keep the leaderboard active and competitive
 * - Encourage regular participation
 * - Prevent inactive players from holding top spots
 *
 * Rules:
 * - No decay for first 7 days of inactivity
 * - After 7 days: -5 ELO per day, max -25 per week
 * - Never decay below 1200 (starting ELO)
 * - Token holders get 50% reduced decay rate
 */

import { prisma } from '../index';
import { calculateEloDecay, getRankTier } from '../utils/elo';

// Days of inactivity before decay starts
const DECAY_GRACE_PERIOD_DAYS = 7;

/**
 * Run ELO decay for all inactive players
 * Should be called once daily (midnight UTC)
 */
export async function runEloDecay(): Promise<{
  playersDecayed: number;
  totalEloDecayed: number;
}> {
  const now = new Date();
  const gracePeriodEnd = new Date(now.getTime() - DECAY_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  // Find players who:
  // 1. Haven't made a prediction in over 7 days
  // 2. Have ELO above 1200 (starting ELO)
  const inactivePlayers = await prisma.user.findMany({
    where: {
      elo: { gt: 1200 },
      OR: [
        { lastPredictionAt: null },
        { lastPredictionAt: { lt: gracePeriodEnd } }
      ]
    },
    select: {
      id: true,
      elo: true,
      lastPredictionAt: true,
      isTokenHolder: true
    }
  });

  console.log(`Found ${inactivePlayers.length} inactive players eligible for decay`);

  let playersDecayed = 0;
  let totalEloDecayed = 0;

  for (const player of inactivePlayers) {
    try {
      // Calculate days since last prediction
      const daysSinceActivity = player.lastPredictionAt
        ? Math.floor((now.getTime() - player.lastPredictionAt.getTime()) / (24 * 60 * 60 * 1000))
        : 30; // Default to 30 days if never made prediction

      // Calculate decay amount
      let decay = calculateEloDecay(player.elo, daysSinceActivity);

      // Token holders get 50% reduced decay
      if (player.isTokenHolder) {
        decay = Math.floor(decay * 0.5);
      }

      if (decay > 0) {
        await applyEloDecay(player.id, player.elo, decay);
        playersDecayed++;
        totalEloDecayed += decay;
      }

    } catch (error) {
      console.error(`Error applying decay for player ${player.id}:`, error);
    }
  }

  console.log(`Decay complete: ${playersDecayed} players decayed, ${totalEloDecayed} total ELO removed`);

  return {
    playersDecayed,
    totalEloDecayed
  };
}

/**
 * Apply ELO decay to a single player
 */
async function applyEloDecay(
  userId: string,
  currentElo: number,
  decayAmount: number
): Promise<void> {
  const newElo = currentElo - decayAmount;
  const newRankTier = getRankTier(newElo);

  await prisma.$transaction(async (tx) => {
    // Update user's ELO
    await tx.user.update({
      where: { id: userId },
      data: {
        elo: newElo,
        rankTier: newRankTier
      }
    });

    // Record in ELO history
    await tx.eloHistory.create({
      data: {
        userId,
        eloBefore: currentElo,
        eloAfter: newElo,
        change: -decayAmount,
        reason: 'DECAY'
      }
    });
  });
}

/**
 * Get decay preview for a specific user
 * Useful for showing users what will happen if they stay inactive
 */
export async function getDecayPreview(userId: string): Promise<{
  currentElo: number;
  daysInactive: number;
  pendingDecay: number;
  protectedUntil: Date | null;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      elo: true,
      lastPredictionAt: true,
      isTokenHolder: true
    }
  });

  if (!user) {
    throw new Error('User not found');
  }

  const now = new Date();
  const daysInactive = user.lastPredictionAt
    ? Math.floor((now.getTime() - user.lastPredictionAt.getTime()) / (24 * 60 * 60 * 1000))
    : 30;

  // Calculate when protection expires
  let protectedUntil: Date | null = null;
  if (user.lastPredictionAt && daysInactive < DECAY_GRACE_PERIOD_DAYS) {
    protectedUntil = new Date(user.lastPredictionAt.getTime() + DECAY_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  }

  // Calculate pending decay
  let pendingDecay = calculateEloDecay(user.elo, daysInactive);
  if (user.isTokenHolder) {
    pendingDecay = Math.floor(pendingDecay * 0.5);
  }

  return {
    currentElo: user.elo,
    daysInactive,
    pendingDecay,
    protectedUntil
  };
}

/**
 * Get decay statistics for admin dashboard
 */
export async function getDecayStats(): Promise<{
  playersAtRisk: number;
  totalPendingDecay: number;
  avgInactiveDays: number;
}> {
  const now = new Date();
  const gracePeriodEnd = new Date(now.getTime() - DECAY_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const atRiskPlayers = await prisma.user.findMany({
    where: {
      elo: { gt: 1200 },
      OR: [
        { lastPredictionAt: null },
        { lastPredictionAt: { lt: gracePeriodEnd } }
      ]
    },
    select: {
      elo: true,
      lastPredictionAt: true,
      isTokenHolder: true
    }
  });

  let totalPendingDecay = 0;
  let totalInactiveDays = 0;

  for (const player of atRiskPlayers) {
    const daysInactive = player.lastPredictionAt
      ? Math.floor((now.getTime() - player.lastPredictionAt.getTime()) / (24 * 60 * 60 * 1000))
      : 30;

    totalInactiveDays += daysInactive;

    let decay = calculateEloDecay(player.elo, daysInactive);
    if (player.isTokenHolder) {
      decay = Math.floor(decay * 0.5);
    }
    totalPendingDecay += decay;
  }

  return {
    playersAtRisk: atRiskPlayers.length,
    totalPendingDecay,
    avgInactiveDays: atRiskPlayers.length > 0
      ? Math.round(totalInactiveDays / atRiskPlayers.length)
      : 0
  };
}
