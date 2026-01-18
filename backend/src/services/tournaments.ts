/**
 * Tournaments Service
 *
 * Handles tournament lifecycle:
 * - Creating and managing tournaments
 * - Registration and entry fees
 * - Scoring and leaderboards
 * - Prize distribution
 */

import { prisma } from '../index';
import { TournamentStatus } from '@prisma/client';
import { calculateTournamentPrizes } from '../utils/points';

// Constants
const MIN_PARTICIPANTS_TO_START = 5;
const MARKETS_PER_TOURNAMENT = 15;
const XP_PER_TOURNAMENT_CORRECT = 15;
const XP_PARTICIPATION_BONUS = 50;

/**
 * Create a new tournament
 */
export async function createTournament(
  name: string,
  description: string,
  entryFee: number,
  maxParticipants: number,
  registrationDeadline: Date,
  startDate: Date,
  endDate: Date
): Promise<any> {
  // Validate dates
  if (registrationDeadline <= new Date()) {
    throw new Error('Registration deadline must be in the future');
  }
  if (startDate <= registrationDeadline) {
    throw new Error('Start date must be after registration deadline');
  }
  if (endDate <= startDate) {
    throw new Error('End date must be after start date');
  }

  // Select markets for the tournament
  const markets = await prisma.market.findMany({
    where: {
      status: 'OPEN',
      endDate: {
        gt: startDate,
        lt: endDate
      },
      yesPrice: {
        gte: 0.10,
        lte: 0.90
      }
    },
    orderBy: { volume: 'desc' },
    take: 30
  });

  if (markets.length < MARKETS_PER_TOURNAMENT) {
    throw new Error('Not enough eligible markets for tournament timeframe');
  }

  // Shuffle and select
  const shuffled = markets.sort(() => Math.random() - 0.5);
  const selectedMarkets = shuffled.slice(0, MARKETS_PER_TOURNAMENT);

  const tournament = await prisma.tournament.create({
    data: {
      name,
      description,
      entryFee,
      maxParticipants,
      registrationDeadline,
      startDate,
      endDate,
      status: 'UPCOMING',
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

  return tournament;
}

/**
 * Register a user for a tournament
 */
export async function registerForTournament(
  tournamentId: string,
  userId: string
): Promise<any> {
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId }
  });

  if (!tournament) {
    throw new Error('Tournament not found');
  }

  if (tournament.status !== 'UPCOMING' && tournament.status !== 'REGISTRATION') {
    throw new Error('Tournament is not accepting registrations');
  }

  if (new Date() > tournament.registrationDeadline) {
    throw new Error('Registration deadline has passed');
  }

  if (tournament.currentParticipants >= tournament.maxParticipants) {
    throw new Error('Tournament is full');
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  if (user.points < tournament.entryFee) {
    throw new Error('Insufficient points for entry fee');
  }

  // Check if already registered
  const existingEntry = await prisma.tournamentEntry.findUnique({
    where: {
      userId_tournamentId: {
        userId,
        tournamentId
      }
    }
  });

  if (existingEntry) {
    throw new Error('Already registered for this tournament');
  }

  // Register in transaction
  const entry = await prisma.$transaction(async (tx) => {
    // Deduct entry fee
    await tx.user.update({
      where: { id: userId },
      data: { points: { decrement: tournament.entryFee } }
    });

    // Record transaction
    await tx.pointsTransaction.create({
      data: {
        userId,
        amount: -tournament.entryFee,
        balanceBefore: user.points,
        balanceAfter: user.points - tournament.entryFee,
        reason: 'TOURNAMENT_ENTRY',
        referenceId: tournamentId,
        description: `Entry fee for: ${tournament.name}`
      }
    });

    // Update tournament participant count and prize pool
    await tx.tournament.update({
      where: { id: tournamentId },
      data: {
        currentParticipants: { increment: 1 },
        prizePool: { increment: tournament.entryFee }
      }
    });

    // Create entry
    return tx.tournamentEntry.create({
      data: {
        userId,
        tournamentId
      }
    });
  });

  return entry;
}

/**
 * Make a tournament prediction
 */
export async function makeTournamentPrediction(
  tournamentId: string,
  userId: string,
  marketId: string,
  prediction: 'YES' | 'NO'
): Promise<any> {
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    include: { markets: true }
  });

  if (!tournament) {
    throw new Error('Tournament not found');
  }

  if (tournament.status !== 'ACTIVE') {
    throw new Error('Tournament is not active');
  }

  // Verify user is registered
  const entry = await prisma.tournamentEntry.findUnique({
    where: {
      userId_tournamentId: {
        userId,
        tournamentId
      }
    }
  });

  if (!entry) {
    throw new Error('You are not registered for this tournament');
  }

  // Verify market is part of tournament
  const market = tournament.markets.find(m => m.id === marketId);
  if (!market) {
    throw new Error('Market is not part of this tournament');
  }

  if (market.status !== 'OPEN') {
    throw new Error('Market is no longer accepting predictions');
  }

  // Check if already predicted
  const existingPrediction = await prisma.prediction.findFirst({
    where: {
      tournamentEntryId: entry.id,
      marketId
    }
  });

  if (existingPrediction) {
    throw new Error('Already predicted on this market');
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  // Create prediction
  const newPrediction = await prisma.prediction.create({
    data: {
      userId,
      marketId,
      prediction,
      pointsWagered: 0,
      oddsAtPrediction: prediction === 'YES' ? market.yesPrice : market.noPrice,
      eloAtPrediction: user.elo,
      wasTokenHolder: user.isTokenHolder,
      tournamentEntryId: entry.id
    }
  });

  return newPrediction;
}

/**
 * Open registration for upcoming tournaments
 */
export async function openRegistration(): Promise<number> {
  const now = new Date();

  const result = await prisma.tournament.updateMany({
    where: {
      status: 'UPCOMING',
      registrationDeadline: { gt: now }
    },
    data: { status: 'REGISTRATION' }
  });

  return result.count;
}

/**
 * Start tournaments that are ready
 */
export async function startTournaments(): Promise<number> {
  const now = new Date();

  const tournamentsToStart = await prisma.tournament.findMany({
    where: {
      status: 'REGISTRATION',
      startDate: { lte: now },
      currentParticipants: { gte: MIN_PARTICIPANTS_TO_START }
    }
  });

  let started = 0;

  for (const tournament of tournamentsToStart) {
    await prisma.tournament.update({
      where: { id: tournament.id },
      data: { status: 'ACTIVE' }
    });
    started++;
    console.log(`Started tournament: ${tournament.name}`);
  }

  return started;
}

/**
 * Cancel tournaments with insufficient participants
 */
export async function cancelInsufficientTournaments(): Promise<number> {
  const now = new Date();

  const tournamentsToCancel = await prisma.tournament.findMany({
    where: {
      status: 'REGISTRATION',
      startDate: { lte: now },
      currentParticipants: { lt: MIN_PARTICIPANTS_TO_START }
    },
    include: {
      entries: {
        include: { user: true }
      }
    }
  });

  let cancelled = 0;

  for (const tournament of tournamentsToCancel) {
    await prisma.$transaction(async (tx) => {
      // Refund all participants
      for (const entry of tournament.entries) {
        await tx.user.update({
          where: { id: entry.userId },
          data: { points: { increment: tournament.entryFee } }
        });

        await tx.pointsTransaction.create({
          data: {
            userId: entry.userId,
            amount: tournament.entryFee,
            balanceBefore: entry.user.points,
            balanceAfter: entry.user.points + tournament.entryFee,
            reason: 'TOURNAMENT_PRIZE', // Using prize as refund reason
            referenceId: tournament.id,
            description: `Tournament cancelled - entry fee refunded: ${tournament.name}`
          }
        });
      }

      await tx.tournament.update({
        where: { id: tournament.id },
        data: { status: 'CANCELLED' }
      });
    });

    cancelled++;
    console.log(`Cancelled tournament (insufficient participants): ${tournament.name}`);
  }

  return cancelled;
}

/**
 * Check if tournament is ready for resolution
 */
export async function checkTournamentResolution(tournamentId: string): Promise<boolean> {
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    include: { markets: true }
  });

  if (!tournament) return false;
  if (tournament.status !== 'ACTIVE' && tournament.status !== 'RESOLVING') return false;

  // Check if all markets are resolved or tournament end date passed
  const allResolved = tournament.markets.every(m => m.status === 'RESOLVED');
  const endDatePassed = new Date() > tournament.endDate;

  if ((allResolved || endDatePassed) && tournament.status === 'ACTIVE') {
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: 'RESOLVING' }
    });
  }

  return allResolved || endDatePassed;
}

/**
 * Resolve a tournament and distribute prizes
 */
export async function resolveTournament(tournamentId: string): Promise<any> {
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
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

  if (!tournament) {
    throw new Error('Tournament not found');
  }

  if (tournament.status !== 'RESOLVING') {
    throw new Error('Tournament is not ready for resolution');
  }

  // Calculate scores for each entry
  const scores: { entryId: string; userId: string; score: number; correctCount: number }[] = [];

  for (const entry of tournament.entries) {
    let correctCount = 0;

    for (const prediction of entry.predictions) {
      const market = tournament.markets.find(m => m.id === prediction.marketId);
      if (market && market.status === 'RESOLVED' && prediction.prediction === market.outcome) {
        correctCount++;
      }

      // Settle prediction
      await prisma.prediction.update({
        where: { id: prediction.id },
        data: {
          isSettled: true,
          won: market ? prediction.prediction === market.outcome : null,
          settledAt: new Date()
        }
      });
    }

    // Score is based on correct predictions
    // Could add complexity like odds weighting later
    const score = correctCount * 100;

    scores.push({
      entryId: entry.id,
      userId: entry.userId,
      score,
      correctCount
    });
  }

  // Sort by score (descending)
  scores.sort((a, b) => b.score - a.score);

  // Calculate prizes
  const prizes = calculateTournamentPrizes(tournament.prizePool, tournament.currentParticipants);

  // Update entries and distribute prizes
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < scores.length; i++) {
      const entry = scores[i];
      const rank = i + 1;
      const prize = prizes[i] || 0;
      const xpAwarded = XP_PARTICIPATION_BONUS + (entry.correctCount * XP_PER_TOURNAMENT_CORRECT);

      // Update entry
      await tx.tournamentEntry.update({
        where: { id: entry.entryId },
        data: {
          pointsScored: entry.score,
          correctPredictions: entry.correctCount,
          rank,
          prizeWon: prize,
          xpAwarded
        }
      });

      // Award prizes and XP to user
      const user = tournament.entries.find(e => e.id === entry.entryId)?.user;
      if (user) {
        const xpMultiplier = user.isTokenHolder ? 2 : 1;
        const actualXp = xpAwarded * xpMultiplier;

        await tx.user.update({
          where: { id: entry.userId },
          data: {
            points: { increment: prize },
            xp: { increment: actualXp },
            tournamentWins: rank === 1 ? { increment: 1 } : undefined
          }
        });

        if (prize > 0) {
          await tx.pointsTransaction.create({
            data: {
              userId: entry.userId,
              amount: prize,
              balanceBefore: user.points,
              balanceAfter: user.points + prize,
              reason: 'TOURNAMENT_PRIZE',
              referenceId: tournamentId,
              description: `${tournament.name} - Rank #${rank}`
            }
          });
        }
      }
    }

    // Mark tournament as completed
    await tx.tournament.update({
      where: { id: tournamentId },
      data: { status: 'COMPLETED' }
    });
  });

  return {
    tournamentId,
    status: 'completed',
    results: scores.slice(0, 10).map((s, i) => ({
      rank: i + 1,
      userId: s.userId,
      score: s.score,
      correctCount: s.correctCount,
      prize: prizes[i] || 0
    }))
  };
}

/**
 * Check and resolve all pending tournaments
 */
export async function checkAndResolveTournaments(): Promise<number> {
  const pendingTournaments = await prisma.tournament.findMany({
    where: {
      status: { in: ['ACTIVE', 'RESOLVING'] }
    }
  });

  let resolved = 0;

  for (const tournament of pendingTournaments) {
    const ready = await checkTournamentResolution(tournament.id);
    if (ready) {
      try {
        await resolveTournament(tournament.id);
        resolved++;
        console.log(`Resolved tournament: ${tournament.name}`);
      } catch (error) {
        console.error(`Error resolving tournament ${tournament.id}:`, error);
      }
    }
  }

  return resolved;
}

/**
 * Get tournament leaderboard
 */
export async function getTournamentLeaderboard(tournamentId: string): Promise<any[]> {
  const entries = await prisma.tournamentEntry.findMany({
    where: { tournamentId },
    orderBy: [
      { pointsScored: 'desc' },
      { createdAt: 'asc' }
    ],
    include: {
      user: {
        select: {
          walletAddress: true,
          displayName: true,
          rankTier: true,
          isTokenHolder: true
        }
      },
      _count: {
        select: { predictions: true }
      }
    }
  });

  return entries.map((entry, index) => ({
    rank: entry.rank || index + 1,
    user: entry.user,
    pointsScored: entry.pointsScored,
    correctPredictions: entry.correctPredictions,
    predictionsCount: entry._count.predictions,
    prizeWon: entry.prizeWon
  }));
}

/**
 * Get user's tournament entry with predictions
 */
export async function getUserTournamentEntry(
  tournamentId: string,
  userId: string
): Promise<any> {
  return prisma.tournamentEntry.findUnique({
    where: {
      userId_tournamentId: {
        userId,
        tournamentId
      }
    },
    include: {
      predictions: {
        include: {
          market: {
            select: {
              id: true,
              question: true,
              status: true,
              outcome: true
            }
          }
        }
      }
    }
  });
}

/**
 * Process tournament lifecycle (called by cron)
 */
export async function processTournamentLifecycle(): Promise<{
  opened: number;
  started: number;
  cancelled: number;
  resolved: number;
}> {
  const opened = await openRegistration();
  const cancelled = await cancelInsufficientTournaments();
  const started = await startTournaments();
  const resolved = await checkAndResolveTournaments();

  return { opened, started, cancelled, resolved };
}
