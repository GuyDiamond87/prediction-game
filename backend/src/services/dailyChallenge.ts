/**
 * Daily Challenge Service
 *
 * Handles daily pick'em challenges:
 * - Auto-generating daily challenges from trending markets
 * - Managing challenge entries and predictions
 * - Resolving completed challenges and awarding prizes
 */

import { prisma } from '../index';

// Constants
const MARKETS_PER_CHALLENGE = 5;
const PERFECT_SCORE_BONUS = 500; // Points for getting all 5 right
const BASE_XP_PER_CORRECT = 20;

/**
 * Generate today's daily challenge
 * Should be called once per day (at midnight UTC)
 */
export async function generateDailyChallenge(): Promise<any> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  // Check if challenge already exists for today
  const existing = await prisma.dailyChallenge.findUnique({
    where: { date: today }
  });

  if (existing) {
    console.log('Daily challenge already exists for today');
    return existing;
  }

  // Get trending open markets that will resolve soon (within 7 days)
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const markets = await prisma.market.findMany({
    where: {
      status: 'OPEN',
      endDate: {
        gt: new Date(),
        lt: sevenDaysFromNow
      },
      // Avoid markets with extreme odds (too easy)
      yesPrice: {
        gte: 0.15,
        lte: 0.85
      }
    },
    orderBy: [
      { isTrending: 'desc' },
      { volume: 'desc' }
    ],
    take: 20 // Get more than needed for variety
  });

  if (markets.length < MARKETS_PER_CHALLENGE) {
    console.error('Not enough markets for daily challenge');
    throw new Error('Not enough eligible markets');
  }

  // Try to pick diverse categories
  const selectedMarkets: typeof markets = [];
  const usedCategories = new Set<string>();

  // First pass: one per category
  for (const market of markets) {
    if (selectedMarkets.length >= MARKETS_PER_CHALLENGE) break;
    if (market.category && !usedCategories.has(market.category)) {
      selectedMarkets.push(market);
      usedCategories.add(market.category);
    }
  }

  // Second pass: fill remaining slots
  for (const market of markets) {
    if (selectedMarkets.length >= MARKETS_PER_CHALLENGE) break;
    if (!selectedMarkets.includes(market)) {
      selectedMarkets.push(market);
    }
  }

  // Create the daily challenge
  const challenge = await prisma.dailyChallenge.create({
    data: {
      date: today,
      isActive: true,
      markets: {
        connect: selectedMarkets.map(m => ({ id: m.id }))
      }
    },
    include: {
      markets: {
        select: {
          id: true,
          question: true,
          category: true,
          yesPrice: true,
          noPrice: true,
          endDate: true
        }
      }
    }
  });

  console.log(`Generated daily challenge with ${selectedMarkets.length} markets`);
  return challenge;
}

/**
 * Get today's challenge
 */
export async function getTodaysChallenge(): Promise<any> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  let challenge = await prisma.dailyChallenge.findUnique({
    where: { date: today },
    include: {
      markets: {
        select: {
          id: true,
          question: true,
          category: true,
          yesPrice: true,
          noPrice: true,
          status: true,
          outcome: true,
          endDate: true
        }
      },
      _count: {
        select: { entries: true }
      }
    }
  });

  // If no challenge exists, try to generate one
  if (!challenge) {
    try {
      const generated = await generateDailyChallenge();
      if (!generated) return null;
      challenge = await prisma.dailyChallenge.findUnique({
        where: { id: generated.id },
        include: {
          markets: {
            select: {
              id: true,
              question: true,
              category: true,
              yesPrice: true,
              noPrice: true,
              status: true,
              outcome: true,
              endDate: true
            }
          },
          _count: {
            select: { entries: true }
          }
        }
      });
    } catch (error) {
      console.error('Failed to generate daily challenge:', error);
      return null;
    }
  }

  return challenge;
}

/**
 * Enter today's challenge (creates an entry for the user)
 */
export async function enterDailyChallenge(userId: string): Promise<any> {
  const challenge = await getTodaysChallenge();

  if (!challenge) {
    throw new Error('No daily challenge available');
  }

  if (!challenge.isActive) {
    throw new Error('Daily challenge is no longer active');
  }

  // Check if already entered
  const existingEntry = await prisma.dailyChallengeEntry.findUnique({
    where: {
      userId_challengeId: {
        userId,
        challengeId: challenge.id
      }
    }
  });

  if (existingEntry) {
    throw new Error('Already entered today\'s challenge');
  }

  const entry = await prisma.dailyChallengeEntry.create({
    data: {
      userId,
      challengeId: challenge.id
    },
    include: {
      challenge: {
        include: {
          markets: {
            select: {
              id: true,
              question: true,
              category: true,
              yesPrice: true,
              noPrice: true,
              endDate: true
            }
          }
        }
      }
    }
  });

  return entry;
}

/**
 * Make a prediction within a daily challenge
 */
export async function makeDailyChallengePrediction(
  userId: string,
  marketId: string,
  prediction: 'YES' | 'NO'
): Promise<any> {
  const challenge = await getTodaysChallenge();

  if (!challenge) {
    throw new Error('No daily challenge available');
  }

  // Get user's entry
  const entry = await prisma.dailyChallengeEntry.findUnique({
    where: {
      userId_challengeId: {
        userId,
        challengeId: challenge.id
      }
    }
  });

  if (!entry) {
    throw new Error('You must enter the challenge first');
  }

  if (entry.isComplete) {
    throw new Error('You have already completed all picks');
  }

  // Verify market is part of challenge
  const market = challenge.markets.find((m: any) => m.id === marketId);
  if (!market) {
    throw new Error('Market is not part of today\'s challenge');
  }

  if (market.status !== 'OPEN') {
    throw new Error('Market is no longer accepting predictions');
  }

  // Check if already predicted
  const existingPrediction = await prisma.prediction.findFirst({
    where: {
      dailyChallengeEntryId: entry.id,
      marketId
    }
  });

  if (existingPrediction) {
    throw new Error('Already predicted on this market');
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  // Create prediction (no points wagered for daily challenges)
  const newPrediction = await prisma.prediction.create({
    data: {
      userId,
      marketId,
      prediction,
      pointsWagered: 0,
      oddsAtPrediction: prediction === 'YES' ? market.yesPrice : market.noPrice,
      eloAtPrediction: user.elo,
      wasTokenHolder: user.isTokenHolder,
      dailyChallengeEntryId: entry.id
    }
  });

  // Update entry predictions count
  const predictionsCount = await prisma.prediction.count({
    where: { dailyChallengeEntryId: entry.id }
  });

  const isComplete = predictionsCount >= MARKETS_PER_CHALLENGE;

  await prisma.dailyChallengeEntry.update({
    where: { id: entry.id },
    data: {
      predictionsCount,
      isComplete,
      completedAt: isComplete ? new Date() : null
    }
  });

  return {
    prediction: newPrediction,
    predictionsCount,
    isComplete,
    remainingPicks: MARKETS_PER_CHALLENGE - predictionsCount
  };
}

/**
 * Get user's entry for today's challenge
 */
export async function getUserChallengeEntry(userId: string): Promise<any> {
  const challenge = await getTodaysChallenge();

  if (!challenge) {
    return null;
  }

  const entry = await prisma.dailyChallengeEntry.findUnique({
    where: {
      userId_challengeId: {
        userId,
        challengeId: challenge.id
      }
    },
    include: {
      predictions: {
        include: {
          market: {
            select: {
              id: true,
              question: true,
              category: true,
              status: true,
              outcome: true
            }
          }
        }
      }
    }
  });

  return entry;
}

/**
 * Check if a daily challenge is fully resolved and process results
 */
export async function resolveDailyChallenge(challengeId: string): Promise<any> {
  const challenge = await prisma.dailyChallenge.findUnique({
    where: { id: challengeId },
    include: {
      markets: true,
      entries: {
        include: {
          predictions: true,
          user: true
        }
      }
    }
  });

  if (!challenge) {
    throw new Error('Challenge not found');
  }

  // Check if all markets are resolved
  const allResolved = challenge.markets.every(m => m.status === 'RESOLVED');

  if (!allResolved) {
    return { status: 'pending', resolvedCount: challenge.markets.filter(m => m.status === 'RESOLVED').length };
  }

  if (challenge.isFullyResolved) {
    return { status: 'already_resolved' };
  }

  // Process each entry
  const results: any[] = [];

  for (const entry of challenge.entries) {
    let correctCount = 0;

    // Check each prediction
    for (const prediction of entry.predictions) {
      const market = challenge.markets.find(m => m.id === prediction.marketId);
      if (market && prediction.prediction === market.outcome) {
        correctCount++;
      }

      // Mark prediction as settled
      await prisma.prediction.update({
        where: { id: prediction.id },
        data: {
          isSettled: true,
          won: market ? prediction.prediction === market.outcome : null,
          settledAt: new Date()
        }
      });
    }

    const isPerfect = correctCount === MARKETS_PER_CHALLENGE;

    // Calculate rewards
    let xpAwarded = correctCount * BASE_XP_PER_CORRECT;
    let bonusPointsAwarded = 0;

    if (isPerfect) {
      bonusPointsAwarded = PERFECT_SCORE_BONUS;
      xpAwarded += 100; // Bonus XP for perfect
    }

    // Token holder bonus
    if (entry.user.isTokenHolder) {
      xpAwarded *= 2;
      bonusPointsAwarded = Math.round(bonusPointsAwarded * 1.1);
    }

    // Update entry
    await prisma.dailyChallengeEntry.update({
      where: { id: entry.id },
      data: {
        correctCount,
        isPerfect,
        xpAwarded,
        bonusPointsAwarded
      }
    });

    // Update user
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: entry.userId },
        data: {
          xp: { increment: xpAwarded },
          points: { increment: bonusPointsAwarded }
        }
      });

      if (bonusPointsAwarded > 0) {
        await tx.pointsTransaction.create({
          data: {
            userId: entry.userId,
            amount: bonusPointsAwarded,
            balanceBefore: entry.user.points,
            balanceAfter: entry.user.points + bonusPointsAwarded,
            reason: 'PREDICTION_WIN',
            referenceId: entry.id,
            description: `Daily challenge ${isPerfect ? 'PERFECT' : ''} bonus: ${correctCount}/${MARKETS_PER_CHALLENGE}`
          }
        });
      }
    });

    results.push({
      userId: entry.userId,
      correctCount,
      isPerfect,
      xpAwarded,
      bonusPointsAwarded
    });
  }

  // Mark challenge as resolved
  await prisma.dailyChallenge.update({
    where: { id: challengeId },
    data: {
      isActive: false,
      isFullyResolved: true
    }
  });

  return {
    status: 'resolved',
    results,
    perfectScores: results.filter(r => r.isPerfect).length
  };
}

/**
 * Check and resolve all pending daily challenges
 */
export async function checkAndResolveDailyChallenges(): Promise<number> {
  const pendingChallenges = await prisma.dailyChallenge.findMany({
    where: {
      isFullyResolved: false,
      entries: { some: {} } // Has at least one entry
    }
  });

  let resolved = 0;

  for (const challenge of pendingChallenges) {
    try {
      const result = await resolveDailyChallenge(challenge.id);
      if (result.status === 'resolved') {
        resolved++;
        console.log(`Resolved daily challenge ${challenge.id}`);
      }
    } catch (error) {
      console.error(`Error resolving challenge ${challenge.id}:`, error);
    }
  }

  return resolved;
}

/**
 * Get daily challenge leaderboard
 */
export async function getDailyChallengeLeaderboard(challengeId: string): Promise<any[]> {
  const entries = await prisma.dailyChallengeEntry.findMany({
    where: {
      challengeId,
      isComplete: true
    },
    orderBy: [
      { correctCount: 'desc' },
      { completedAt: 'asc' } // Earlier completion wins ties
    ],
    take: 100,
    include: {
      user: {
        select: {
          walletAddress: true,
          displayName: true,
          rankTier: true,
          isTokenHolder: true
        }
      }
    }
  });

  return entries.map((entry, index) => ({
    rank: index + 1,
    user: entry.user,
    correctCount: entry.correctCount,
    isPerfect: entry.isPerfect,
    xpAwarded: entry.xpAwarded,
    bonusPointsAwarded: entry.bonusPointsAwarded,
    completedAt: entry.completedAt
  }));
}

/**
 * Deactivate yesterday's challenge (if still active)
 */
export async function deactivateOldChallenges(): Promise<void> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  await prisma.dailyChallenge.updateMany({
    where: {
      date: { lt: today },
      isActive: true
    },
    data: { isActive: false }
  });
}
