/**
 * Battles Service - Draft System
 *
 * Handles head-to-head battle logic with draft-style market picking:
 * - Creating battles with fixed wager tiers
 * - Joining battles and starting draft
 * - Alternating market picks with 60 second timer
 * - Tiebreaker market for tie scenarios
 * - Battle resolution with 2.5% platform rake
 */

import { prisma } from '../index';
import { BattleStatus, PredictionChoice } from '@prisma/client';
import { calculateBattleEloChange, getRankTier } from '../utils/elo';
import crypto from 'crypto';

// Generate a short random code
function generateShareCode(length: number = 8): string {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

// ==========================================
// CONSTANTS
// ==========================================

export const WAGER_TIERS = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
export const PLATFORM_RAKE = 0.025; // 2.5%
export const PICK_TIMEOUT_SECONDS = 60;
export const BATTLE_EXPIRY_HOURS = 4;
export const MARKET_RESOLVE_WINDOW_HOURS = 24;
export const PICKS_PER_PLAYER = 5;
export const TOTAL_PICKS = 10;

// ==========================================
// BATTLE CREATION & JOINING
// ==========================================

/**
 * Create a new battle with a fixed wager tier
 */
export async function createBattle(
  userId: string,
  wagerTier: number
): Promise<any> {
  // Validate wager tier
  if (!WAGER_TIERS.includes(wagerTier)) {
    throw new Error(`Invalid wager tier. Must be one of: ${WAGER_TIERS.join(', ')}`);
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  if (user.points < wagerTier) {
    throw new Error('Insufficient points');
  }

  // Check user doesn't have another open/active battle
  const existingBattle = await prisma.battle.findFirst({
    where: {
      OR: [
        { player1Id: userId },
        { player2Id: userId }
      ],
      status: { in: ['OPEN', 'DRAFTING', 'ACTIVE'] }
    }
  });
  if (existingBattle) {
    throw new Error('You already have an active battle');
  }

  // Create battle in transaction
  const battle = await prisma.$transaction(async (tx) => {
    // Deduct stake from player 1
    await tx.user.update({
      where: { id: userId },
      data: { points: { decrement: wagerTier } }
    });

    // Record transaction
    await tx.pointsTransaction.create({
      data: {
        userId,
        amount: -wagerTier,
        balanceBefore: user.points,
        balanceAfter: user.points - wagerTier,
        reason: 'BATTLE_STAKE',
        description: `Staked ${wagerTier} points for battle`
      }
    });

    // Create battle
    const newBattle = await tx.battle.create({
      data: {
        player1Id: userId,
        player1Elo: user.elo,
        pointsStake: wagerTier,
        status: 'OPEN',
        shareCode: generateShareCode(),
        expiresAt: new Date(Date.now() + BATTLE_EXPIRY_HOURS * 60 * 60 * 1000)
      },
      include: {
        player1: {
          select: {
            id: true,
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
 * Join an existing battle
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
        description: `Staked ${battle.pointsStake} points for battle`
      }
    });

    // Update battle - still OPEN, waiting for both to be ready
    const updated = await tx.battle.update({
      where: { id: battleId },
      data: {
        player2Id: userId,
        player2Elo: user.elo,
        startedAt: new Date()
      },
      include: {
        player1: {
          select: {
            id: true,
            walletAddress: true,
            displayName: true,
            elo: true,
            rankTier: true
          }
        },
        player2: {
          select: {
            id: true,
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

// ==========================================
// DRAFT SYSTEM
// ==========================================

/**
 * Start the draft phase - called when both players are ready
 */
export async function startDraft(battleId: string): Promise<{
  coinFlipWinnerId: string;
  firstPickerId: string;
  currentPickDeadline: Date;
  battle: any;
}> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: { player1: true, player2: true }
  });

  if (!battle) throw new Error('Battle not found');
  if (!battle.player2Id) throw new Error('Waiting for opponent');
  if (battle.status !== 'OPEN') throw new Error('Battle already started');

  // Coin flip to determine first picker
  const coinFlipWinnerId = Math.random() < 0.5 ? battle.player1Id : battle.player2Id;
  const currentPickDeadline = new Date(Date.now() + PICK_TIMEOUT_SECONDS * 1000);

  const updatedBattle = await prisma.battle.update({
    where: { id: battleId },
    data: {
      status: 'DRAFTING',
      coinFlipWinnerId,
      currentPickPlayerId: coinFlipWinnerId,
      currentPickNumber: 1,
      currentPickDeadline
    },
    include: {
      player1: {
        select: { id: true, walletAddress: true, displayName: true, elo: true, rankTier: true }
      },
      player2: {
        select: { id: true, walletAddress: true, displayName: true, elo: true, rankTier: true }
      }
    }
  });

  return {
    coinFlipWinnerId,
    firstPickerId: coinFlipWinnerId,
    currentPickDeadline,
    battle: updatedBattle
  };
}

/**
 * Get markets available for picking (resolving within 24 hours, not already picked)
 */
export async function getAvailableMarkets(battleId: string): Promise<any[]> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: { picks: true }
  });

  if (!battle) throw new Error('Battle not found');

  // Get IDs of already picked markets
  const pickedMarketIds = battle.picks.map(p => p.marketId);

  // Also exclude tiebreaker if set
  if (battle.tiebreakerMarketId) {
    pickedMarketIds.push(battle.tiebreakerMarketId);
  }

  // Find markets that:
  // 1. Are OPEN
  // 2. Have endDate within next 24 hours
  // 3. Haven't been picked yet
  const now = new Date();
  const twentyFourHoursFromNow = new Date(now.getTime() + MARKET_RESOLVE_WINDOW_HOURS * 60 * 60 * 1000);

  const markets = await prisma.market.findMany({
    where: {
      status: 'OPEN',
      endDate: {
        gte: now,
        lte: twentyFourHoursFromNow
      },
      id: {
        notIn: pickedMarketIds.length > 0 ? pickedMarketIds : undefined
      }
    },
    orderBy: { volume: 'desc' },
    take: 50,
    select: {
      id: true,
      polymarketId: true,
      question: true,
      description: true,
      category: true,
      yesPrice: true,
      noPrice: true,
      endDate: true,
      volume: true,
      isTrending: true
    }
  });

  return markets;
}

/**
 * Make a pick during the draft
 */
export async function makePick(
  battleId: string,
  userId: string,
  marketId: string,
  prediction: 'YES' | 'NO'
): Promise<any> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: { picks: true }
  });

  if (!battle) throw new Error('Battle not found');
  if (battle.status !== 'DRAFTING') throw new Error('Battle is not in drafting phase');
  if (battle.currentPickPlayerId !== userId) throw new Error('Not your turn');
  if (battle.currentPickNumber > TOTAL_PICKS) throw new Error('All picks completed');

  // Check market is available
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market) throw new Error('Market not found');
  if (market.status !== 'OPEN') throw new Error('Market is not open');

  // Check market hasn't been picked
  const alreadyPicked = battle.picks.some(p => p.marketId === marketId);
  if (alreadyPicked) throw new Error('Market already picked in this battle');

  // Check market is within 24 hours
  const now = new Date();
  const twentyFourHoursFromNow = new Date(now.getTime() + MARKET_RESOLVE_WINDOW_HOURS * 60 * 60 * 1000);
  if (!market.endDate || market.endDate < now || market.endDate > twentyFourHoursFromNow) {
    throw new Error('Market must resolve within 24 hours');
  }

  // Determine next picker (alternates)
  const nextPickNumber = battle.currentPickNumber + 1;
  const isLastMainPick = nextPickNumber > TOTAL_PICKS;

  // After pick 10, move to tiebreaker phase
  let nextPickPlayerId: string | null = null;
  let nextStatus: BattleStatus = 'DRAFTING';

  if (!isLastMainPick) {
    // Alternate between players
    nextPickPlayerId = battle.currentPickPlayerId === battle.player1Id
      ? battle.player2Id
      : battle.player1Id;
  }

  // Create pick in transaction
  const result = await prisma.$transaction(async (tx) => {
    // Create the pick
    const pick = await tx.battlePick.create({
      data: {
        battleId,
        pickNumber: battle.currentPickNumber,
        pickerId: userId,
        marketId,
        prediction: prediction as PredictionChoice,
        wasTimeout: false
      }
    });

    // Update battle
    const updateData: any = {
      currentPickNumber: nextPickNumber,
      currentPickPlayerId: nextPickPlayerId,
      currentPickDeadline: isLastMainPick ? null : new Date(Date.now() + PICK_TIMEOUT_SECONDS * 1000)
    };

    // Determine tiebreaker picker (coin flip loser)
    const tiebreakerPickerId = battle.coinFlipWinnerId === battle.player1Id
      ? battle.player2Id
      : battle.player1Id;

    // If all main picks done, start tiebreaker phase
    if (isLastMainPick) {
      updateData.currentPickNumber = 11; // Tiebreaker pick phase
      updateData.currentPickPlayerId = tiebreakerPickerId;
      updateData.currentPickDeadline = new Date(Date.now() + PICK_TIMEOUT_SECONDS * 1000);
    }

    const updatedBattle = await tx.battle.update({
      where: { id: battleId },
      data: updateData,
      include: {
        picks: {
          include: {
            market: {
              select: { id: true, question: true, category: true, yesPrice: true, noPrice: true, endDate: true }
            }
          },
          orderBy: { pickNumber: 'asc' }
        },
        player1: { select: { id: true, walletAddress: true, displayName: true, elo: true, rankTier: true } },
        player2: { select: { id: true, walletAddress: true, displayName: true, elo: true, rankTier: true } }
      }
    });

    return { pick, battle: updatedBattle };
  });

  // Return structured response for socket events
  return {
    pickNumber: battle.currentPickNumber,
    draftComplete: isLastMainPick,
    needsTiebreaker: isLastMainPick,
    tiebreakerPickerId: isLastMainPick ? (battle.coinFlipWinnerId === battle.player1Id ? battle.player2Id : battle.player1Id) : undefined,
    tiebreakerDeadline: isLastMainPick ? result.battle.currentPickDeadline : undefined,
    nextPickerId: nextPickPlayerId,
    nextPickNumber: nextPickNumber,
    nextDeadline: result.battle.currentPickDeadline,
    pick: result.pick,
    battle: result.battle
  };
}

/**
 * Handle pick timeout - assign random market
 */
export async function handlePickTimeout(battleId: string): Promise<any> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: { picks: true }
  });

  if (!battle) throw new Error('Battle not found');
  if (battle.status !== 'DRAFTING') return null;
  if (!battle.currentPickDeadline || new Date() < battle.currentPickDeadline) return null;

  // If in tiebreaker pick phase (pick 11), handle differently
  if (battle.currentPickNumber === 11) {
    return handleTiebreakerPickTimeout(battleId);
  }

  // Get available markets
  const availableMarkets = await getAvailableMarkets(battleId);
  if (availableMarkets.length === 0) {
    // No markets available - this shouldn't happen but handle gracefully
    throw new Error('No markets available for timeout pick');
  }

  // Random market and prediction
  const randomMarket = availableMarkets[Math.floor(Math.random() * availableMarkets.length)];
  const randomPrediction = Math.random() < 0.5 ? 'YES' : 'NO';

  // Make the pick with timeout flag
  const result = await prisma.$transaction(async (tx) => {
    const pick = await tx.battlePick.create({
      data: {
        battleId,
        pickNumber: battle.currentPickNumber,
        pickerId: battle.currentPickPlayerId!,
        marketId: randomMarket.id,
        prediction: randomPrediction as PredictionChoice,
        wasTimeout: true
      }
    });

    // Determine next state
    const nextPickNumber = battle.currentPickNumber + 1;
    const isLastMainPick = nextPickNumber > TOTAL_PICKS;

    let nextPickPlayerId: string | null = null;
    const updateData: any = {
      currentPickNumber: nextPickNumber,
      currentPickDeadline: new Date(Date.now() + PICK_TIMEOUT_SECONDS * 1000)
    };

    if (!isLastMainPick) {
      nextPickPlayerId = battle.currentPickPlayerId === battle.player1Id
        ? battle.player2Id
        : battle.player1Id;
      updateData.currentPickPlayerId = nextPickPlayerId;
    } else {
      // Move to tiebreaker phase
      updateData.currentPickNumber = 11;
      updateData.currentPickPlayerId = battle.coinFlipWinnerId === battle.player1Id
        ? battle.player2Id
        : battle.player1Id;
    }

    const updatedBattle = await tx.battle.update({
      where: { id: battleId },
      data: updateData,
      include: {
        picks: { orderBy: { pickNumber: 'asc' } },
        player1: { select: { id: true, walletAddress: true, displayName: true } },
        player2: { select: { id: true, walletAddress: true, displayName: true } }
      }
    });

    return { pick, battle: updatedBattle, wasTimeout: true };
  });

  return result;
}

// ==========================================
// TIEBREAKER SYSTEM
// ==========================================

/**
 * Pick the tiebreaker market (coin flip loser picks)
 */
export async function makeTiebreakerPick(
  battleId: string,
  userId: string,
  marketId: string
): Promise<any> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: { picks: true }
  });

  if (!battle) throw new Error('Battle not found');
  if (battle.status !== 'DRAFTING') throw new Error('Battle is not in drafting phase');
  if (battle.currentPickNumber !== 11) throw new Error('Not in tiebreaker pick phase');
  if (battle.currentPickPlayerId !== userId) throw new Error('Not your turn to pick tiebreaker');

  // Validate market
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market) throw new Error('Market not found');
  if (market.status !== 'OPEN') throw new Error('Market is not open');

  // Check market hasn't been picked in main draft
  const alreadyPicked = battle.picks.some(p => p.marketId === marketId);
  if (alreadyPicked) throw new Error('Market already picked in this battle');

  const predictionDeadline = new Date(Date.now() + PICK_TIMEOUT_SECONDS * 1000);

  // Update battle with tiebreaker market
  const updatedBattle = await prisma.battle.update({
    where: { id: battleId },
    data: {
      tiebreakerMarketId: marketId,
      currentPickNumber: 12, // Move to tiebreaker prediction phase
      currentPickPlayerId: null, // Both need to predict
      currentPickDeadline: predictionDeadline
    },
    include: {
      tiebreakerMarket: {
        select: { id: true, question: true, category: true, yesPrice: true, noPrice: true, endDate: true }
      },
      picks: { orderBy: { pickNumber: 'asc' } },
      player1: { select: { id: true, walletAddress: true, displayName: true } },
      player2: { select: { id: true, walletAddress: true, displayName: true } }
    }
  });

  return {
    battle: updatedBattle,
    predictionDeadline
  };
}

/**
 * Handle tiebreaker pick timeout - assign random market
 */
async function handleTiebreakerPickTimeout(battleId: string): Promise<any> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId }
  });

  if (!battle) return null;

  const availableMarkets = await getAvailableMarkets(battleId);
  if (availableMarkets.length === 0) {
    throw new Error('No markets available for tiebreaker');
  }

  const randomMarket = availableMarkets[Math.floor(Math.random() * availableMarkets.length)];

  const updatedBattle = await prisma.battle.update({
    where: { id: battleId },
    data: {
      tiebreakerMarketId: randomMarket.id,
      currentPickNumber: 12,
      currentPickPlayerId: null,
      currentPickDeadline: new Date(Date.now() + PICK_TIMEOUT_SECONDS * 1000)
    }
  });

  return { battle: updatedBattle, wasTimeout: true };
}

/**
 * Submit tiebreaker prediction (both players)
 */
export async function submitTiebreakerPrediction(
  battleId: string,
  odId: string,
  prediction: 'YES' | 'NO'
): Promise<any> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId }
  });

  if (!battle) throw new Error('Battle not found');
  if (battle.status !== 'DRAFTING') throw new Error('Battle is not in drafting phase');
  if (battle.currentPickNumber !== 12) throw new Error('Not in tiebreaker prediction phase');
  if (!battle.tiebreakerMarketId) throw new Error('No tiebreaker market selected');

  const isPlayer1 = battle.player1Id === odId;
  const isPlayer2 = battle.player2Id === odId;
  if (!isPlayer1 && !isPlayer2) throw new Error('You are not in this battle');

  // Check if already submitted
  if (isPlayer1 && battle.player1TiebreakerPick) throw new Error('Already submitted tiebreaker prediction');
  if (isPlayer2 && battle.player2TiebreakerPick) throw new Error('Already submitted tiebreaker prediction');

  const updateData: any = {};
  if (isPlayer1) {
    updateData.player1TiebreakerPick = prediction as PredictionChoice;
  } else {
    updateData.player2TiebreakerPick = prediction as PredictionChoice;
  }

  // Check if both have submitted
  const otherPlayerSubmitted = isPlayer1 ? battle.player2TiebreakerPick : battle.player1TiebreakerPick;
  if (otherPlayerSubmitted) {
    // Both submitted - complete draft
    updateData.status = 'ACTIVE';
    updateData.draftCompletedAt = new Date();
    updateData.currentPickPlayerId = null;
    updateData.currentPickDeadline = null;
  }

  const bothSubmitted = !!otherPlayerSubmitted;

  const updatedBattle = await prisma.battle.update({
    where: { id: battleId },
    data: updateData,
    include: {
      picks: { orderBy: { pickNumber: 'asc' } },
      tiebreakerMarket: true,
      player1: { select: { id: true, walletAddress: true, displayName: true } },
      player2: { select: { id: true, walletAddress: true, displayName: true } }
    }
  });

  return {
    battle: updatedBattle,
    bothSubmitted,
    player1Prediction: bothSubmitted ? (isPlayer1 ? prediction : otherPlayerSubmitted) : undefined,
    player2Prediction: bothSubmitted ? (isPlayer2 ? prediction : otherPlayerSubmitted) : undefined
  };
}

/**
 * Handle tiebreaker prediction timeout - assign random prediction
 */
export async function handleTiebreakerPredictionTimeout(battleId: string): Promise<any> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId }
  });

  if (!battle) return null;
  if (battle.status !== 'DRAFTING' || battle.currentPickNumber !== 12) return null;
  if (!battle.currentPickDeadline || new Date() < battle.currentPickDeadline) return null;

  const updateData: any = {};

  // Assign random predictions for anyone who hasn't submitted
  if (!battle.player1TiebreakerPick) {
    updateData.player1TiebreakerPick = Math.random() < 0.5 ? 'YES' : 'NO';
  }
  if (!battle.player2TiebreakerPick) {
    updateData.player2TiebreakerPick = Math.random() < 0.5 ? 'YES' : 'NO';
  }

  // Complete draft
  updateData.status = 'ACTIVE';
  updateData.draftCompletedAt = new Date();
  updateData.currentPickPlayerId = null;
  updateData.currentPickDeadline = null;

  const updatedBattle = await prisma.battle.update({
    where: { id: battleId },
    data: updateData
  });

  return { battle: updatedBattle, wasTimeout: true };
}

// ==========================================
// BATTLE MANAGEMENT
// ==========================================

/**
 * Cancel an open battle (only creator can cancel before someone joins)
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
  if (battle.player2Id) throw new Error('Cannot cancel - opponent already joined');

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
 * Get list of open battles (for lobby)
 */
export async function getOpenBattles(): Promise<any[]> {
  const battles = await prisma.battle.findMany({
    where: {
      status: 'OPEN',
      player2Id: null,
      expiresAt: { gt: new Date() }
    },
    orderBy: { createdAt: 'desc' },
    include: {
      player1: {
        select: {
          id: true,
          walletAddress: true,
          displayName: true,
          elo: true,
          rankTier: true
        }
      }
    }
  });

  return battles;
}

/**
 * Get battle details
 */
export async function getBattle(battleId: string): Promise<any> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: {
      player1: {
        select: { id: true, walletAddress: true, displayName: true, elo: true, rankTier: true, points: true }
      },
      player2: {
        select: { id: true, walletAddress: true, displayName: true, elo: true, rankTier: true, points: true }
      },
      picks: {
        include: {
          market: {
            select: { id: true, question: true, category: true, yesPrice: true, noPrice: true, endDate: true, status: true, outcome: true }
          },
          picker: {
            select: { id: true, walletAddress: true, displayName: true }
          }
        },
        orderBy: { pickNumber: 'asc' }
      },
      tiebreakerMarket: {
        select: { id: true, question: true, category: true, yesPrice: true, noPrice: true, endDate: true, status: true, outcome: true }
      }
    }
  });

  return battle;
}

// ==========================================
// BATTLE RESOLUTION
// ==========================================

/**
 * Check if a battle is ready to be resolved
 */
export async function checkBattleResolution(battleId: string): Promise<boolean> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: {
      picks: { include: { market: true } },
      tiebreakerMarket: true
    }
  });

  if (!battle) return false;
  if (battle.status !== 'ACTIVE') return false;

  // Check if all picked markets are resolved
  const allPicksResolved = battle.picks.every(p => p.market.status === 'RESOLVED');
  const tiebreakerResolved = !battle.tiebreakerMarketId || battle.tiebreakerMarket?.status === 'RESOLVED';

  return allPicksResolved && tiebreakerResolved;
}

/**
 * Resolve a completed battle
 */
export async function resolveBattle(battleId: string): Promise<any> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: {
      picks: { include: { market: true } },
      tiebreakerMarket: true,
      player1: true,
      player2: true
    }
  });

  if (!battle) throw new Error('Battle not found');
  if (battle.status !== 'ACTIVE') throw new Error('Battle is not ready for resolution');
  if (!battle.player2) throw new Error('Battle has no opponent');

  // Count correct predictions for each player
  let player1Correct = 0;
  let player2Correct = 0;

  for (const pick of battle.picks) {
    if (pick.market.status !== 'RESOLVED' || !pick.market.outcome) continue;

    const isCorrect = pick.prediction === pick.market.outcome;

    if (pick.pickerId === battle.player1Id && isCorrect) {
      player1Correct++;
    } else if (pick.pickerId === battle.player2Id && isCorrect) {
      player2Correct++;
    }

    // Update pick with result
    await prisma.battlePick.update({
      where: { id: pick.id },
      data: { isCorrect }
    });
  }

  // Check for tie and use tiebreaker
  let winnerId: string | null = null;
  let tiebreakerWinnerId: string | null = null;
  let isTie = player1Correct === player2Correct;

  if (isTie && battle.tiebreakerMarket && battle.tiebreakerMarket.status === 'RESOLVED') {
    const tiebreakerOutcome = battle.tiebreakerMarket.outcome;
    const p1Correct = battle.player1TiebreakerPick === tiebreakerOutcome;
    const p2Correct = battle.player2TiebreakerPick === tiebreakerOutcome;

    if (p1Correct && !p2Correct) {
      tiebreakerWinnerId = battle.player1Id;
      winnerId = battle.player1Id;
      isTie = false;
    } else if (p2Correct && !p1Correct) {
      tiebreakerWinnerId = battle.player2Id;
      winnerId = battle.player2Id;
      isTie = false;
    }
    // If both correct or both wrong, it's still a tie
  } else if (!isTie) {
    winnerId = player1Correct > player2Correct ? battle.player1Id : battle.player2Id;
  }

  const loserId = winnerId ? (winnerId === battle.player1Id ? battle.player2Id : battle.player1Id) : null;

  // Calculate payouts
  const totalPot = battle.pointsStake * 2;
  const rake = Math.floor(totalPot * PLATFORM_RAKE);
  const winnerPayout = totalPot - rake;

  // Calculate ELO changes
  let player1EloChange = 0;
  let player2EloChange = 0;

  if (!isTie && winnerId && loserId) {
    const scoreDiff = Math.abs(player1Correct - player2Correct);
    const { winnerChange, loserChange } = calculateBattleEloChange(
      winnerId === battle.player1Id ? battle.player1Elo : battle.player2Elo!,
      loserId === battle.player1Id ? battle.player1Elo : battle.player2Elo!,
      scoreDiff
    );

    player1EloChange = winnerId === battle.player1Id ? winnerChange : loserChange;
    player2EloChange = winnerId === battle.player2Id ? winnerChange : loserChange;
  }

  // Update everything in transaction
  await prisma.$transaction(async (tx) => {
    // Update battle
    await tx.battle.update({
      where: { id: battleId },
      data: {
        status: isTie ? 'COMPLETED' : 'COMPLETED',
        player1Correct,
        player2Correct,
        winnerId,
        tiebreakerWinnerId,
        player1EloChange,
        player2EloChange,
        completedAt: new Date()
      }
    });

    if (isTie) {
      // Split pot (each gets their stake back minus half rake)
      const refundAmount = battle.pointsStake - Math.floor(rake / 2);

      await tx.user.update({
        where: { id: battle.player1Id },
        data: { points: { increment: refundAmount } }
      });
      await tx.user.update({
        where: { id: battle.player2Id! },
        data: { points: { increment: refundAmount } }
      });

      await tx.pointsTransaction.create({
        data: {
          userId: battle.player1Id,
          amount: refundAmount,
          balanceBefore: battle.player1.points,
          balanceAfter: battle.player1.points + refundAmount,
          reason: 'BATTLE_REFUND',
          referenceId: battleId,
          description: `Battle tied ${player1Correct}-${player2Correct} - partial refund (${PLATFORM_RAKE * 100}% rake)`
        }
      });
      await tx.pointsTransaction.create({
        data: {
          userId: battle.player2Id!,
          amount: refundAmount,
          balanceBefore: battle.player2!.points,
          balanceAfter: battle.player2!.points + refundAmount,
          reason: 'BATTLE_REFUND',
          referenceId: battleId,
          description: `Battle tied ${player1Correct}-${player2Correct} - partial refund (${PLATFORM_RAKE * 100}% rake)`
        }
      });
    } else if (winnerId && loserId) {
      // Pay winner
      const winner = winnerId === battle.player1Id ? battle.player1 : battle.player2!;
      const loser = loserId === battle.player1Id ? battle.player1 : battle.player2!;

      await tx.user.update({
        where: { id: winnerId },
        data: {
          points: { increment: winnerPayout },
          h2hWins: { increment: 1 },
          elo: { increment: winnerId === battle.player1Id ? player1EloChange : player2EloChange },
          rankTier: getRankTier(winner.elo + (winnerId === battle.player1Id ? player1EloChange : player2EloChange))
        }
      });

      await tx.user.update({
        where: { id: loserId },
        data: {
          h2hLosses: { increment: 1 },
          elo: { increment: loserId === battle.player1Id ? player1EloChange : player2EloChange },
          rankTier: getRankTier(loser.elo + (loserId === battle.player1Id ? player1EloChange : player2EloChange))
        }
      });

      await tx.pointsTransaction.create({
        data: {
          userId: winnerId,
          amount: winnerPayout,
          balanceBefore: winner.points,
          balanceAfter: winner.points + winnerPayout,
          reason: 'BATTLE_WIN',
          referenceId: battleId,
          description: `Won battle ${player1Correct > player2Correct ? player1Correct : player2Correct}-${player1Correct > player2Correct ? player2Correct : player1Correct} (${PLATFORM_RAKE * 100}% rake)`
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
  });

  return getBattle(battleId);
}

/**
 * Check and resolve battles where all markets have settled
 */
export async function checkAndResolveBattles(): Promise<number> {
  const battlesToCheck = await prisma.battle.findMany({
    where: { status: 'ACTIVE' }
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
 * Clean up expired open battles
 */
export async function cleanupExpiredBattles(): Promise<number> {
  const expiredBattles = await prisma.battle.findMany({
    where: {
      status: 'OPEN',
      player2Id: null,
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

// ==========================================
// LEGACY MATCHMAKING (kept for backwards compatibility)
// ==========================================

/**
 * Process matchmaking queue - matches players with similar ELO
 * @deprecated Use the new draft-based battle system instead
 */
export async function processMatchmakingQueue(): Promise<number> {
  // With the new draft system, matchmaking is no longer used
  // Open battles are displayed in a lobby and players join directly
  return 0;
}

/**
 * Expand matchmaking search ranges for players waiting too long
 * @deprecated Use the new draft-based battle system instead
 */
export async function expandMatchmakingRanges(): Promise<void> {
  // No longer needed with new lobby-based system
  return;
}

/**
 * Join matchmaking queue
 * @deprecated Use createBattle and joinBattle instead
 */
export async function joinMatchmaking(userId: string, pointsStake: number): Promise<any> {
  throw new Error('Matchmaking is deprecated. Use createBattle to create a battle and share the link.');
}

/**
 * Leave matchmaking queue
 * @deprecated No longer needed
 */
export async function leaveMatchmaking(userId: string): Promise<void> {
  // No-op for backwards compatibility
  return;
}

/**
 * Make a battle prediction (legacy - use makePick instead)
 * @deprecated Use makePick for the new draft system
 */
export async function makeBattlePrediction(
  battleId: string,
  userId: string,
  marketId: string,
  prediction: 'YES' | 'NO'
): Promise<any> {
  // Redirect to the new pick system
  return makePick(battleId, userId, marketId, prediction);
}

// ==========================================
// DRAFT TIMEOUTS
// ==========================================

/**
 * Check and handle draft timeouts
 */
export async function checkDraftTimeouts(): Promise<number> {
  const battlesInDraft = await prisma.battle.findMany({
    where: {
      status: 'DRAFTING',
      currentPickDeadline: { lt: new Date() }
    }
  });

  let handled = 0;

  for (const battle of battlesInDraft) {
    try {
      if (battle.currentPickNumber <= TOTAL_PICKS) {
        await handlePickTimeout(battle.id);
      } else if (battle.currentPickNumber === 11) {
        await handlePickTimeout(battle.id); // This will call handleTiebreakerPickTimeout
      } else if (battle.currentPickNumber === 12) {
        await handleTiebreakerPredictionTimeout(battle.id);
      }
      handled++;
    } catch (error) {
      console.error(`Error handling timeout for battle ${battle.id}:`, error);
    }
  }

  return handled;
}
