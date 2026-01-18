/**
 * Tournaments API Routes
 *
 * Endpoints for tournament management:
 * - List/view tournaments
 * - Registration
 * - Make predictions
 * - Leaderboards
 */

import { Router } from 'express';
import { prisma } from '../index';
import {
  registerForTournament,
  makeTournamentPrediction,
  getTournamentLeaderboard,
  getUserTournamentEntry
} from '../services/tournaments';

const router = Router();

/**
 * GET /api/tournaments
 *
 * List all tournaments (with optional status filter)
 */
router.get('/', async (req, res) => {
  try {
    const { status, limit = '20', offset = '0' } = req.query;

    const where: any = {};
    if (status) {
      where.status = status;
    }

    const tournaments = await prisma.tournament.findMany({
      where,
      orderBy: { startDate: 'desc' },
      take: Math.min(parseInt(limit as string) || 20, 50),
      skip: parseInt(offset as string) || 0,
      select: {
        id: true,
        name: true,
        description: true,
        entryFee: true,
        maxParticipants: true,
        currentParticipants: true,
        prizePool: true,
        status: true,
        registrationDeadline: true,
        startDate: true,
        endDate: true,
        _count: {
          select: { markets: true }
        }
      }
    });

    const total = await prisma.tournament.count({ where });

    res.json({
      tournaments: tournaments.map(t => ({
        ...t,
        marketCount: t._count.markets,
        spotsRemaining: t.maxParticipants - t.currentParticipants
      })),
      total
    });
  } catch (error) {
    console.error('Error fetching tournaments:', error);
    res.status(500).json({ error: 'Failed to fetch tournaments' });
  }
});

/**
 * GET /api/tournaments/active
 *
 * Get currently active and upcoming tournaments
 */
router.get('/active', async (req, res) => {
  try {
    const tournaments = await prisma.tournament.findMany({
      where: {
        status: { in: ['UPCOMING', 'REGISTRATION', 'ACTIVE'] }
      },
      orderBy: { startDate: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        entryFee: true,
        maxParticipants: true,
        currentParticipants: true,
        prizePool: true,
        status: true,
        registrationDeadline: true,
        startDate: true,
        endDate: true
      }
    });

    res.json({ tournaments });
  } catch (error) {
    console.error('Error fetching active tournaments:', error);
    res.status(500).json({ error: 'Failed to fetch tournaments' });
  }
});

/**
 * GET /api/tournaments/:id
 *
 * Get tournament details
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress } = req.query;

    const tournament = await prisma.tournament.findUnique({
      where: { id },
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
        }
      }
    });

    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    // Get user's entry if wallet provided
    let userEntry = null;
    if (walletAddress) {
      const user = await prisma.user.findUnique({
        where: { walletAddress: walletAddress as string }
      });

      if (user) {
        userEntry = await getUserTournamentEntry(tournament.id, user.id);
      }
    }

    // Get leaderboard preview
    const leaderboard = await getTournamentLeaderboard(tournament.id);

    res.json({
      tournament: {
        ...tournament,
        spotsRemaining: tournament.maxParticipants - tournament.currentParticipants
      },
      userEntry: userEntry ? {
        id: userEntry.id,
        pointsScored: userEntry.pointsScored,
        correctPredictions: userEntry.correctPredictions,
        rank: userEntry.rank,
        prizeWon: userEntry.prizeWon,
        predictions: userEntry.predictions.map((p: any) => ({
          marketId: p.marketId,
          prediction: p.prediction,
          isSettled: p.isSettled,
          won: p.won
        }))
      } : null,
      leaderboard: leaderboard.slice(0, 20)
    });
  } catch (error) {
    console.error('Error fetching tournament:', error);
    res.status(500).json({ error: 'Failed to fetch tournament' });
  }
});

/**
 * POST /api/tournaments/:id/register
 *
 * Register for a tournament
 */
router.post('/:id/register', async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress } = req.body;

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    const user = await prisma.user.findUnique({
      where: { walletAddress }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const entry = await registerForTournament(id, user.id);

    const tournament = await prisma.tournament.findUnique({
      where: { id },
      select: { name: true, entryFee: true }
    });

    res.status(201).json({
      entry,
      message: `Registered for ${tournament?.name}! Entry fee: ${tournament?.entryFee} points`
    });
  } catch (error: any) {
    console.error('Error registering for tournament:', error);
    res.status(400).json({ error: error.message || 'Failed to register' });
  }
});

/**
 * POST /api/tournaments/:id/predict
 *
 * Make a prediction in a tournament
 *
 * Body: {
 *   walletAddress: string,
 *   marketId: string,
 *   prediction: 'YES' | 'NO'
 * }
 */
router.post('/:id/predict', async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress, marketId, prediction } = req.body;

    if (!walletAddress || !marketId || !prediction) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (prediction !== 'YES' && prediction !== 'NO') {
      return res.status(400).json({ error: 'Prediction must be YES or NO' });
    }

    const user = await prisma.user.findUnique({
      where: { walletAddress }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const tournamentPrediction = await makeTournamentPrediction(id, user.id, marketId, prediction);

    // Get updated entry stats
    const entry = await prisma.tournamentEntry.findUnique({
      where: {
        userId_tournamentId: {
          userId: user.id,
          tournamentId: id
        }
      },
      include: {
        _count: { select: { predictions: true } }
      }
    });

    const tournament = await prisma.tournament.findUnique({
      where: { id },
      select: { _count: { select: { markets: true } } }
    });

    res.json({
      prediction: tournamentPrediction,
      predictionsCount: entry?._count.predictions || 0,
      totalMarkets: tournament?._count.markets || 0,
      message: `Prediction recorded!`
    });
  } catch (error: any) {
    console.error('Error making tournament prediction:', error);
    res.status(400).json({ error: error.message || 'Failed to make prediction' });
  }
});

/**
 * GET /api/tournaments/:id/leaderboard
 *
 * Get tournament leaderboard
 */
router.get('/:id/leaderboard', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = '100' } = req.query;

    const tournament = await prisma.tournament.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        status: true,
        prizePool: true,
        currentParticipants: true
      }
    });

    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const leaderboard = await getTournamentLeaderboard(id);

    res.json({
      tournament,
      leaderboard: leaderboard.slice(0, parseInt(limit as string) || 100)
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

/**
 * GET /api/tournaments/user/:walletAddress
 *
 * Get user's tournament history
 */
router.get('/user/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const { limit = '20', offset = '0' } = req.query;

    const user = await prisma.user.findUnique({
      where: { walletAddress }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const entries = await prisma.tournamentEntry.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit as string) || 20, 50),
      skip: parseInt(offset as string) || 0,
      include: {
        tournament: {
          select: {
            id: true,
            name: true,
            status: true,
            prizePool: true,
            currentParticipants: true,
            startDate: true,
            endDate: true
          }
        }
      }
    });

    // Get stats
    const [totalEntered, totalWins, totalPrize] = await Promise.all([
      prisma.tournamentEntry.count({ where: { userId: user.id } }),
      prisma.tournamentEntry.count({ where: { userId: user.id, rank: 1 } }),
      prisma.tournamentEntry.aggregate({
        where: { userId: user.id },
        _sum: { prizeWon: true }
      })
    ]);

    res.json({
      entries: entries.map(e => ({
        id: e.id,
        tournament: e.tournament,
        pointsScored: e.pointsScored,
        correctPredictions: e.correctPredictions,
        rank: e.rank,
        prizeWon: e.prizeWon,
        xpAwarded: e.xpAwarded
      })),
      stats: {
        totalEntered,
        totalWins,
        totalPrize: totalPrize._sum.prizeWon || 0
      }
    });
  } catch (error) {
    console.error('Error fetching tournament history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

export default router;
