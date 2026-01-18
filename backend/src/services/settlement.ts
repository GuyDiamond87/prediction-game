/**
 * Settlement Service
 *
 * Handles the settlement of predictions when markets resolve.
 * This includes:
 * - Paying out winners
 * - Updating ELO ratings
 * - Awarding XP
 * - Updating streaks
 * - Recording all transactions
 */

import { prisma } from '../index';
import { MarketOutcome, PredictionChoice } from '@prisma/client';
import { calculateEloChange, getRankTier } from '../utils/elo';
import { calculateWinPayout, calculateXpEarned } from '../utils/points';

/**
 * Settle all predictions for a resolved market
 *
 * @param marketId - The internal market ID
 * @returns Settlement results
 */
export async function settleMarketPredictions(marketId: string): Promise<{
  settled: number;
  winners: number;
  losers: number;
  totalPayout: number;
}> {
  // Get market with outcome
  const market = await prisma.market.findUnique({
    where: { id: marketId }
  });

  if (!market) {
    throw new Error(`Market ${marketId} not found`);
  }

  if (market.status !== 'RESOLVED' || !market.outcome) {
    throw new Error(`Market ${marketId} is not resolved`);
  }

  // Get all unsettled predictions for this market
  const predictions = await prisma.prediction.findMany({
    where: {
      marketId,
      isSettled: false
    },
    include: {
      user: true
    }
  });

  if (predictions.length === 0) {
    console.log(`No unsettled predictions for market ${marketId}`);
    return { settled: 0, winners: 0, losers: 0, totalPayout: 0 };
  }

  console.log(`Settling ${predictions.length} predictions for market: ${market.question.slice(0, 50)}...`);

  let winners = 0;
  let losers = 0;
  let totalPayout = 0;

  // Process each prediction
  for (const prediction of predictions) {
    try {
      const won = didPredictionWin(prediction.prediction, market.outcome);

      if (won) {
        await settlePredictionWin(prediction, market);
        winners++;
      } else {
        await settlePredictionLoss(prediction, market);
        losers++;
      }

      if (won) {
        const payout = calculateWinPayout(
          prediction.pointsWagered,
          prediction.oddsAtPrediction,
          prediction.user.currentStreak,
          prediction.wasTokenHolder
        );
        totalPayout += payout;
      }

    } catch (error) {
      console.error(`Error settling prediction ${prediction.id}:`, error);
    }
  }

  console.log(`Settlement complete: ${winners} winners, ${losers} losers, ${totalPayout} points paid out`);

  return {
    settled: predictions.length,
    winners,
    losers,
    totalPayout
  };
}

/**
 * Check if a prediction won
 */
function didPredictionWin(prediction: PredictionChoice, outcome: MarketOutcome): boolean {
  return prediction === outcome;
}

/**
 * Settle a winning prediction
 */
async function settlePredictionWin(
  prediction: any,
  market: any
): Promise<void> {
  const user = prediction.user;

  // Calculate payout
  const payout = calculateWinPayout(
    prediction.pointsWagered,
    prediction.oddsAtPrediction,
    user.currentStreak,
    prediction.wasTokenHolder
  );

  // Calculate ELO change
  const eloChange = calculateEloChange(
    user.elo,
    true,
    prediction.oddsAtPrediction,
    user.currentStreak
  );

  // Calculate XP earned
  const xpEarned = calculateXpEarned(
    true,
    prediction.oddsAtPrediction,
    prediction.pointsWagered,
    user.currentStreak,
    prediction.wasTokenHolder
  );

  // New ELO and rank
  const newElo = user.elo + eloChange;
  const newRankTier = getRankTier(newElo);
  const newPeakElo = Math.max(user.peakElo, newElo);
  const newStreak = user.currentStreak + 1;
  const newLongestStreak = Math.max(user.longestStreak, newStreak);

  // Update everything in a transaction
  await prisma.$transaction(async (tx) => {
    // Update prediction
    await tx.prediction.update({
      where: { id: prediction.id },
      data: {
        isSettled: true,
        won: true,
        pointsEarned: payout,
        eloChange,
        xpEarned,
        streakAtSettlement: user.currentStreak,
        settledAt: new Date()
      }
    });

    // Update user
    await tx.user.update({
      where: { id: user.id },
      data: {
        points: { increment: payout },
        xp: { increment: xpEarned },
        elo: newElo,
        peakElo: newPeakElo,
        rankTier: newRankTier,
        currentStreak: newStreak,
        longestStreak: newLongestStreak,
        totalWins: { increment: 1 }
      }
    });

    // Record points transaction
    await tx.pointsTransaction.create({
      data: {
        userId: user.id,
        amount: payout,
        balanceBefore: user.points,
        balanceAfter: user.points + payout,
        reason: 'PREDICTION_WIN',
        referenceId: prediction.id,
        description: `Won prediction: ${market.question.slice(0, 50)}...`
      }
    });

    // Record ELO history
    await tx.eloHistory.create({
      data: {
        userId: user.id,
        eloBefore: user.elo,
        eloAfter: newElo,
        change: eloChange,
        reason: 'PREDICTION',
        referenceId: prediction.id
      }
    });
  });
}

/**
 * Settle a losing prediction
 */
async function settlePredictionLoss(
  prediction: any,
  market: any
): Promise<void> {
  const user = prediction.user;

  // Calculate ELO change (negative)
  const eloChange = calculateEloChange(
    user.elo,
    false,
    prediction.oddsAtPrediction,
    0 // No streak for losses
  );

  // Small XP for participating (even in losses)
  const xpEarned = calculateXpEarned(
    false,
    prediction.oddsAtPrediction,
    prediction.pointsWagered,
    0,
    prediction.wasTokenHolder
  );

  // New ELO and rank (can't go below 100)
  const newElo = Math.max(100, user.elo + eloChange);
  const newRankTier = getRankTier(newElo);

  // Update everything in a transaction
  await prisma.$transaction(async (tx) => {
    // Update prediction
    await tx.prediction.update({
      where: { id: prediction.id },
      data: {
        isSettled: true,
        won: false,
        pointsLost: prediction.pointsWagered,
        eloChange,
        xpEarned,
        streakAtSettlement: user.currentStreak,
        settledAt: new Date()
      }
    });

    // Update user (reset streak)
    await tx.user.update({
      where: { id: user.id },
      data: {
        xp: { increment: xpEarned },
        elo: newElo,
        rankTier: newRankTier,
        currentStreak: 0, // Reset streak on loss
        totalLosses: { increment: 1 }
      }
    });

    // Record points transaction (loss tracking)
    await tx.pointsTransaction.create({
      data: {
        userId: user.id,
        amount: 0, // Points already deducted when prediction was made
        balanceBefore: user.points,
        balanceAfter: user.points,
        reason: 'PREDICTION_LOSS',
        referenceId: prediction.id,
        description: `Lost prediction: ${market.question.slice(0, 50)}...`
      }
    });

    // Record ELO history
    await tx.eloHistory.create({
      data: {
        userId: user.id,
        eloBefore: user.elo,
        eloAfter: newElo,
        change: eloChange,
        reason: 'PREDICTION',
        referenceId: prediction.id
      }
    });
  });
}

/**
 * Handle voided markets - refund all predictions
 */
export async function voidMarketPredictions(marketId: string): Promise<number> {
  const predictions = await prisma.prediction.findMany({
    where: {
      marketId,
      isSettled: false
    },
    include: {
      user: true
    }
  });

  if (predictions.length === 0) {
    return 0;
  }

  console.log(`Voiding ${predictions.length} predictions for market ${marketId}`);

  for (const prediction of predictions) {
    await prisma.$transaction(async (tx) => {
      // Mark prediction as settled (voided)
      await tx.prediction.update({
        where: { id: prediction.id },
        data: {
          isSettled: true,
          won: null, // Neither won nor lost
          settledAt: new Date()
        }
      });

      // Refund points
      await tx.user.update({
        where: { id: prediction.userId },
        data: {
          points: { increment: prediction.pointsWagered }
        }
      });

      // Record refund transaction
      await tx.pointsTransaction.create({
        data: {
          userId: prediction.userId,
          amount: prediction.pointsWagered,
          balanceBefore: prediction.user.points,
          balanceAfter: prediction.user.points + prediction.pointsWagered,
          reason: 'PREDICTION_REFUND',
          referenceId: prediction.id,
          description: 'Market voided - prediction refunded'
        }
      });
    });
  }

  // Update market status
  await prisma.market.update({
    where: { id: marketId },
    data: { status: 'VOIDED' }
  });

  return predictions.length;
}

/**
 * Check all resolved markets and settle pending predictions
 * Called by cron job
 */
export async function checkAndSettleResolvedMarkets(): Promise<void> {
  // Find resolved markets with unsettled predictions
  const marketsToSettle = await prisma.market.findMany({
    where: {
      status: 'RESOLVED',
      outcome: { not: null },
      predictions: {
        some: {
          isSettled: false
        }
      }
    }
  });

  console.log(`Found ${marketsToSettle.length} markets to settle`);

  for (const market of marketsToSettle) {
    try {
      await settleMarketPredictions(market.id);
    } catch (error) {
      console.error(`Error settling market ${market.id}:`, error);
    }
  }
}

/**
 * Get settlement statistics
 */
export async function getSettlementStats(): Promise<{
  pendingPredictions: number;
  pendingMarkets: number;
  settledToday: number;
  totalPaidOutToday: number;
}> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [pendingPredictions, pendingMarkets, settledToday] = await Promise.all([
    prisma.prediction.count({ where: { isSettled: false } }),
    prisma.market.count({
      where: {
        status: 'RESOLVED',
        predictions: { some: { isSettled: false } }
      }
    }),
    prisma.prediction.findMany({
      where: {
        isSettled: true,
        settledAt: { gte: today },
        won: true
      },
      select: { pointsEarned: true }
    })
  ]);

  const totalPaidOutToday = settledToday.reduce(
    (sum, p) => sum + (p.pointsEarned || 0),
    0
  );

  return {
    pendingPredictions,
    pendingMarkets,
    settledToday: settledToday.length,
    totalPaidOutToday
  };
}
