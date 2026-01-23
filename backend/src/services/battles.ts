/**
 * Battles Service
 *
 * Handles head-to-head battle logic:
 * - Creating and joining battles
 * - Matchmaking queue processing
 * - Battle resolution and ELO updates
 * - Expired battle cleanup
 */

import { prisma } from '../index';
import { BattleStatus } from '@prisma/client';
import { calculateBattleEloChange, getRankTier } from '../utils/elo';
import { calculateBattlePayout } from '../utils/points';
import crypto from 'crypto';

// Generate a short random code (replacement for nanoid)
function generateShareCode(length: number = 10): string {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

// Constants
const BATTLE_MARKET_COUNT = 10; // Markets per battle
const BATTLE_EXPIRY_HOURS = 24; // Open battles expire after 24 hours
const MATCHMAKING_INITIAL_RANGE = 100; // Initial ELO range for matchmaking
const MATCHMAKING_EXPAND_AMOUNT = 50; // Expand range by this much
const MATCHMAKING_MAX_RANGE = 500; // Max ELO difference for matching

/**
 * Create a new battle (custom or via matchmaking)
 */
export async function createBattle(
  userId: string,
  pointsStake: number,
  isRanked: boolean = false
): Promise<any> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  if (user.points < pointsStake) {
    throw new Error('Insufficient points');
  }

  // Select 10 random open markets with end dates in the future
  const markets = await prisma.market.findMany({
    where: {
      status: 'OPEN',
      endDate: { gt: new Date() }
    },
    orderBy: { volume: 'desc' },
    take: 50 // Get top 50 by volume, then randomly select 10
  });

  if (markets.length < BATTLE_MARKET_COUNT) {
    throw new Error('Not enough open markets available');
  }

  // Shuffle and take 10
  const shuffled = markets.sort(() => Math.random() - 0.5);
  const selectedMarkets = shuffled.slice(0, BATTLE_MARKET_COUNT);

  // Create battle in transaction
  const battle = await prisma.$transaction(async (tx) => {
    // Deduct stake from player 1
    await tx.user.update({
      where: { id: userId },
      data: { points: { decrement: pointsStake } }
    });

    // Record transaction
    await tx.pointsTransaction.create({
      data: {
        userId,
        amount: -pointsStake,
        balanceBefore: user.points,
        balanceAfter: user.points - pointsStake,
        reason: 'BATTLE_STAKE',
        description: 'Staked points for battle'
      }
    });

    // Create battle
    const newBattle = await tx.battle.create({
      data: {
        player1Id: userId,
        player1Elo: user.elo,
        pointsStake,
        status: 'OPEN',
        isRanked,
        shareCode: isRanked ? null : generateShareCode(10),
        expiresAt: new Date(Date.now() + BATTLE_EXPIRY_HOURS * 60 * 60 * 1000),
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
        },
        player1: {
          select: {
            walletAddress: true,
            displayName: true,
            elo: true,
            rankTier: true
          }
        }
      }
    });

    return newBattle;
  });

  return battle;
}

/**
 * Join an existing battle (by share code or battle ID)
 */
export async function joinBattle(
  battleId: string,
  userId: string
): Promise<any> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: { player1: true }
  });

  if (!battle) throw new Error('Battle not found');
  if (battle.status !== 'OPEN') throw new Error('Battle is not open');
  if (battle.player1Id === userId) throw new Error('Cannot join your own battle');
  if (new Date() > battle.expiresAt) throw new Error('Battle has expired');

  if (user.points < battle.pointsStake) {
    throw new Error('Insufficient points');
  }

  // Join battle in transaction
  const updatedBattle = await prisma.$transaction(async (tx) => {
    // Deduct stake from player 2
    await tx.user.update({
      where: { id: userId },
      data: { points: { decrement: battle.pointsStake } }
    });

    // Record transaction
    await tx.pointsTransaction.create({
      data: {
        userId,
        amount: -battle.pointsStake,
        balanceBefore: user.points,
        balanceAfter: user.points - battle.pointsStake,
        reason: 'BATTLE_STAKE',
        referenceId: battleId,
        description: 'Staked points for battle'
      }
    });

    // Update battle
    const updated = await tx.battle.update({
      where: { id: battleId },
      data: {
        player2Id: userId,
        player2Elo: user.elo,
        status: 'ACTIVE',
        startedAt: new Date()
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
        },
        player1: {
          select: {
            walletAddress: true,
            displayName: true,
            elo: true,
            rankTier: true
          }
        },
        player2: {
          select: {
            walletAddress: true,
            displayName: true,
            elo: true,
            rankTier: true
          }
        }
      }
    });

    return updated;
  });

  return updatedBattle;
}

/**
 * Join a battle by share code
 */
export async function joinBattleByCode(
  shareCode: string,
  userId: string
): Promise<any> {
  const battle = await prisma.battle.findUnique({
    where: { shareCode }
  });

  if (!battle) throw new Error('Battle not found');

  return joinBattle(battle.id, userId);
}

/**
 * Cancel an open battle (only player 1 can cancel before player 2 joins)
 */
export async function cancelBattle(
  battleId: string,
  userId: string
): Promise<void> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: { player1: true }
  });

  if (!battle) throw new Error('Battle not found');
  if (battle.player1Id !== userId) throw new Error('Only the creator can cancel');
  if (battle.status !== 'OPEN') throw new Error('Cannot cancel - battle is not open');

  await prisma.$transaction(async (tx) => {
    // Refund player 1
    await tx.user.update({
      where: { id: battle.player1Id },
      data: { points: { increment: battle.pointsStake } }
    });

    // Record refund
    await tx.pointsTransaction.create({
      data: {
        userId: battle.player1Id,
        amount: battle.pointsStake,
        balanceBefore: battle.player1.points,
        balanceAfter: battle.player1.points + battle.pointsStake,
        reason: 'BATTLE_REFUND',
        referenceId: battleId,
        description: 'Battle cancelled - stake refunded'
      }
    });

    // Update battle status
    await tx.battle.update({
      where: { id: battleId },
      data: { status: 'CANCELLED' }
    });
  });
}

/**
 * Make a prediction within a battle
 */
export async function makeBattlePrediction(
  battleId: string,
  userId: string,
  marketId: string,
  prediction: 'YES' | 'NO'
): Promise<any> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: { markets: true }
  });

  if (!battle) throw new Error('Battle not found');
  if (battle.status !== 'ACTIVE') throw new Error('Battle is not active');
  if (battle.player1Id !== userId && battle.player2Id !== userId) {
    throw new Error('You are not in this battle');
  }

  // Check market is part of this battle
  const market = battle.markets.find(m => m.id === marketId);
  if (!market) throw new Error('Market is not part of this battle');
  if (market.status !== 'OPEN') throw new Error('Market is no longer open');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  // Check if already predicted
  const existingPrediction = await prisma.prediction.findFirst({
    where: {
      battleId,
      userId,
      marketId
    }
  });

  if (existingPrediction) throw new Error('Already predicted on this market in this battle');

  // Create prediction (no points wagered for battle predictions)
  const newPrediction = await prisma.prediction.create({
    data: {
      userId,
      marketId,
      prediction,
      pointsWagered: 0, // Battle predictions don't have individual wagers
      oddsAtPrediction: prediction === 'YES' ? market.yesPrice : market.noPrice,
      eloAtPrediction: user.elo,
      wasTokenHolder: user.isTokenHolder,
      battleId
    }
  });

  return newPrediction;
}

/**
 * Check if a battle is ready to be resolved (all markets settled)
 */
export async function checkBattleResolution(battleId: string): Promise<boolean> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: {
      markets: true,
      predictions: true
    }
  });

  if (!battle) return false;
  if (battle.status !== 'ACTIVE' && battle.status !== 'RESOLVING') return false;

  // Check if all markets are resolved
  const allResolved = battle.markets.every(m => m.status === 'RESOLVED');

  if (allResolved && battle.status === 'ACTIVE') {
    // Move to RESOLVING
    await prisma.battle.update({
      where: { id: battleId },
      data: { status: 'RESOLVING' }
    });
  }

  return allResolved;
}

/**
 * Resolve a completed battle
 */
export async function resolveBattle(battleId: string): Promise<any> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: {
      markets: true,
      predictions: true,
      player1: true,
      player2: true
    }
  });

  if (!battle) throw new Error('Battle not found');
  if (battle.status !== 'RESOLVING') throw new Error('Battle is not ready for resolution');
  if (!battle.player2) throw new Error('Battle has no opponent');

  // Count correct predictions for each player
  let player1Correct = 0;
  let player2Correct = 0;

  for (const market of battle.markets) {
    if (market.status !== 'RESOLVED' || !market.outcome) continue;

    const p1Prediction = battle.predictions.find(
      p => p.userId === battle.player1Id && p.marketId === market.id
    );
    const p2Prediction = battle.predictions.find(
      p => p.userId === battle.player2Id && p.marketId === market.id
    );

    if (p1Prediction && p1Prediction.prediction === market.outcome) {
      player1Correct++;
    }
    if (p2Prediction && p2Prediction.prediction === market.outcome) {
      player2Correct++;
    }
  }

  // Determine winner
  const isTie = player1Correct === player2Correct;
  const winnerId = isTie ? null :
    (player1Correct > player2Correct ? battle.player1Id : battle.player2Id);
  const loserId = isTie ? null :
    (winnerId === battle.player1Id ? battle.player2Id : battle.player1Id);

  // Calculate payouts and ELO changes
  let player1EloChange = 0;
  let player2EloChange = 0;
  let winnerPayout = 0;

  if (!isTie && winnerId && loserId) {
    const scoreDiff = Math.abs(player1Correct - player2Correct);
    const { winnerChange, loserChange } = calculateBattleEloChange(
      winnerId === battle.player1Id ? battle.player1Elo : battle.player2Elo!,
      loserId === battle.player1Id ? battle.player1Elo : battle.player2Elo!,
      scoreDiff
    );

    player1EloChange = winnerId === battle.player1Id ? winnerChange : loserChange;
    player2EloChange = winnerId === battle.player2Id ? winnerChange : loserChange;

    winnerPayout = calculateBattlePayout(
      battle.pointsStake,
      battle.pointsStake,
      battle.isRanked
    );
  }

  // Update everything in transaction
  await prisma.$transaction(async (tx) => {
    // Update battle
    await tx.battle.update({
      where: { id: battleId },
      data: {
        status: isTie ? 'TIE' : 'COMPLETED',
        player1Correct,
        player2Correct,
        winnerId,
        player1EloChange,
        player2EloChange,
        completedAt: new Date()
      }
    });

    if (isTie) {
      // Refund both players
      await tx.user.update({
        where: { id: battle.player1Id },
        data: { points: { increment: battle.pointsStake } }
      });
      await tx.user.update({
        where: { id: battle.player2Id! },
        data: { points: { increment: battle.pointsStake } }
      });

      // Record refunds
      await tx.pointsTransaction.create({
        data: {
          userId: battle.player1Id,
          amount: battle.pointsStake,
          balanceBefore: battle.player1.points,
          balanceAfter: battle.player1.points + battle.pointsStake,
          reason: 'BATTLE_REFUND',
          referenceId: battleId,
          description: 'Battle tied - stake refunded'
        }
      });
      await tx.pointsTransaction.create({
        data: {
          userId: battle.player2Id!,
          amount: battle.pointsStake,
          balanceBefore: battle.player2!.points,
          balanceAfter: battle.player2!.points + battle.pointsStake,
          reason: 'BATTLE_REFUND',
          referenceId: battleId,
          description: 'Battle tied - stake refunded'
        }
      });
    } else {
      // Pay winner
      const winner = winnerId === battle.player1Id ? battle.player1 : battle.player2!;
      const loser = loserId === battle.player1Id ? battle.player1 : battle.player2!;

      await tx.user.update({
        where: { id: winnerId! },
        data: {
          points: { increment: winnerPayout },
          h2hWins: { increment: 1 },
          elo: { increment: winnerId === battle.player1Id ? player1EloChange : player2EloChange },
          rankTier: getRankTier(winner.elo + (winnerId === battle.player1Id ? player1EloChange : player2EloChange))
        }
      });

      await tx.user.update({
        where: { id: loserId! },
        data: {
          h2hLosses: { increment: 1 },
          elo: { increment: loserId === battle.player1Id ? player1EloChange : player2EloChange },
          rankTier: getRankTier(loser.elo + (loserId === battle.player1Id ? player1EloChange : player2EloChange))
        }
      });

      // Record win transaction
      await tx.pointsTransaction.create({
        data: {
          userId: winnerId!,
          amount: winnerPayout,
          balanceBefore: winner.points,
          balanceAfter: winner.points + winnerPayout,
          reason: 'BATTLE_WIN',
          referenceId: battleId,
          description: `Won battle ${player1Correct > player2Correct ? player1Correct : player2Correct}-${player1Correct > player2Correct ? player2Correct : player1Correct}`
        }
      });

      // Record ELO changes
      await tx.eloHistory.create({
        data: {
          userId: battle.player1Id,
          eloBefore: battle.player1Elo,
          eloAfter: battle.player1Elo + player1EloChange,
          change: player1EloChange,
          reason: 'BATTLE',
          referenceId: battleId
        }
      });
      await tx.eloHistory.create({
        data: {
          userId: battle.player2Id!,
          eloBefore: battle.player2Elo!,
          eloAfter: battle.player2Elo! + player2EloChange,
          change: player2EloChange,
          reason: 'BATTLE',
          referenceId: battleId
        }
      });
    }

    // Mark all battle predictions as settled
    for (const prediction of battle.predictions) {
      const market = battle.markets.find(m => m.id === prediction.marketId);
      const won = market && prediction.prediction === market.outcome;

      await tx.prediction.update({
        where: { id: prediction.id },
        data: {
          isSettled: true,
          won,
          settledAt: new Date()
        }
      });
    }
  });

  return prisma.battle.findUnique({
    where: { id: battleId },
    include: {
      player1: { select: { walletAddress: true, displayName: true, elo: true, rankTier: true } },
      player2: { select: { walletAddress: true, displayName: true, elo: true, rankTier: true } }
    }
  });
}

/**
 * Process matchmaking queue - find matches and create battles
 */
export async function processMatchmakingQueue(): Promise<number> {
  const queue = await prisma.matchmakingQueue.findMany({
    orderBy: { joinedAt: 'asc' },
    include: { user: true }
  });

  if (queue.length < 2) return 0;

  let matchesCreated = 0;
  const matched = new Set<string>();

  for (const entry of queue) {
    if (matched.has(entry.userId)) continue;

    // Find potential opponents
    for (const opponent of queue) {
      if (opponent.userId === entry.userId) continue;
      if (matched.has(opponent.userId)) continue;

      // Check ELO range
      const eloDiff = Math.abs(entry.elo - opponent.elo);
      const maxRange = Math.max(entry.eloRangeMax - entry.eloRangeMin, opponent.eloRangeMax - opponent.eloRangeMin);

      if (eloDiff <= maxRange) {
        // Check stake compatibility (must be within 20%)
        const stakeRatio = Math.min(entry.pointsStake, opponent.pointsStake) /
          Math.max(entry.pointsStake, opponent.pointsStake);

        if (stakeRatio >= 0.8) {
          // Create ranked battle
          const stake = Math.min(entry.pointsStake, opponent.pointsStake);

          try {
            const battle = await createBattle(entry.userId, stake, true);
            await joinBattle(battle.id, opponent.userId);

            // Remove from queue
            await prisma.matchmakingQueue.deleteMany({
              where: { userId: { in: [entry.userId, opponent.userId] } }
            });

            matched.add(entry.userId);
            matched.add(opponent.userId);
            matchesCreated++;
            break;
          } catch (error) {
            console.error('Error creating matched battle:', error);
          }
        }
      }
    }
  }

  return matchesCreated;
}

/**
 * Expand matchmaking search ranges for players waiting too long
 */
export async function expandMatchmakingRanges(): Promise<void> {
  const expandAfterMs = 30 * 1000; // 30 seconds

  const staleEntries = await prisma.matchmakingQueue.findMany({
    where: {
      lastExpandedAt: {
        lt: new Date(Date.now() - expandAfterMs)
      }
    }
  });

  for (const entry of staleEntries) {
    const newMin = Math.max(0, entry.eloRangeMin - MATCHMAKING_EXPAND_AMOUNT);
    const newMax = Math.min(entry.elo + MATCHMAKING_MAX_RANGE, entry.eloRangeMax + MATCHMAKING_EXPAND_AMOUNT);

    await prisma.matchmakingQueue.update({
      where: { id: entry.id },
      data: {
        eloRangeMin: newMin,
        eloRangeMax: newMax,
        lastExpandedAt: new Date()
      }
    });
  }
}

/**
 * Clean up expired open battles
 */
export async function cleanupExpiredBattles(): Promise<number> {
  const expiredBattles = await prisma.battle.findMany({
    where: {
      status: 'OPEN',
      expiresAt: { lt: new Date() }
    },
    include: { player1: true }
  });

  let cleaned = 0;

  for (const battle of expiredBattles) {
    await prisma.$transaction(async (tx) => {
      // Refund player 1
      await tx.user.update({
        where: { id: battle.player1Id },
        data: { points: { increment: battle.pointsStake } }
      });

      await tx.pointsTransaction.create({
        data: {
          userId: battle.player1Id,
          amount: battle.pointsStake,
          balanceBefore: battle.player1.points,
          balanceAfter: battle.player1.points + battle.pointsStake,
          reason: 'BATTLE_REFUND',
          referenceId: battle.id,
          description: 'Battle expired - stake refunded'
        }
      });

      await tx.battle.update({
        where: { id: battle.id },
        data: { status: 'EXPIRED' }
      });
    });

    cleaned++;
  }

  return cleaned;
}

/**
 * Check and resolve battles where all markets have settled
 */
export async function checkAndResolveBattles(): Promise<number> {
  const battlesToCheck = await prisma.battle.findMany({
    where: {
      status: { in: ['ACTIVE', 'RESOLVING'] }
    }
  });

  let resolved = 0;

  for (const battle of battlesToCheck) {
    const ready = await checkBattleResolution(battle.id);
    if (ready) {
      try {
        await resolveBattle(battle.id);
        resolved++;
      } catch (error) {
        console.error(`Error resolving battle ${battle.id}:`, error);
      }
    }
  }

  return resolved;
}

/**
 * Add user to matchmaking queue
 */
export async function joinMatchmaking(
  userId: string,
  pointsStake: number
): Promise<any> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');
  if (user.points < pointsStake) throw new Error('Insufficient points');

  // Check if already in queue
  const existing = await prisma.matchmakingQueue.findUnique({
    where: { userId }
  });
  if (existing) throw new Error('Already in matchmaking queue');

  // Check if user has active battle
  const activeBattle = await prisma.battle.findFirst({
    where: {
      OR: [
        { player1Id: userId },
        { player2Id: userId }
      ],
      status: { in: ['OPEN', 'ACTIVE', 'RESOLVING'] }
    }
  });
  if (activeBattle) throw new Error('You already have an active battle');

  return prisma.matchmakingQueue.create({
    data: {
      userId,
      elo: user.elo,
      pointsStake,
      eloRangeMin: Math.max(0, user.elo - MATCHMAKING_INITIAL_RANGE),
      eloRangeMax: user.elo + MATCHMAKING_INITIAL_RANGE
    }
  });
}

/**
 * Leave matchmaking queue
 */
export async function leaveMatchmaking(userId: string): Promise<void> {
  await prisma.matchmakingQueue.delete({
    where: { userId }
  }).catch(() => {}); // Ignore if not in queue
}
