/**
 * Daily Challenges API Routes
 *
 * Endpoints for daily pick'em challenges:
 * - Get today's challenge
 * - Enter challenge
 * - Make predictions
 * - View leaderboard
 */

import { Router } from 'express';
import { prisma } from '../index';
import {
  getTodaysChallenge,
  enterDailyChallenge,
  makeDailyChallengePrediction,
  getUserChallengeEntry,
  getDailyChallengeLeaderboard
} from '../services/dailyChallenge';

const router = Router();

/**
 * GET /api/daily-challenges/today
 *
 * Get today's daily challenge
 */
router.get('/today', async (req, res) => {
  try {
    const { walletAddress } = req.query;

    const challenge = await getTodaysChallenge();

    if (!challenge) {
      return res.status(404).json({ error: 'No daily challenge available today' });
    }

    // Get user's entry if wallet provided
    let userEntry = null;
    if (walletAddress) {
      const user = await prisma.user.findUnique({
        where: { walletAddress: walletAddress as string }
      });

      if (user) {
        userEntry = await getUserChallengeEntry(user.id);
      }
    }

    // Calculate time remaining
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    const timeRemainingMs = tomorrow.getTime() - Date.now();
    const hoursRemaining = Math.floor(timeRemainingMs / (1000 * 60 * 60));
    const minutesRemaining = Math.floor((timeRemainingMs % (1000 * 60 * 60)) / (1000 * 60));

    res.json({
      challenge: {
        id: challenge.id,
        date: challenge.date,
        isActive: challenge.isActive,
        markets: challenge.markets,
        participantCount: challenge._count?.entries || 0
      },
      userEntry: userEntry ? {
        id: userEntry.id,
        predictionsCount: userEntry.predictionsCount,
        isComplete: userEntry.isComplete,
        correctCount: userEntry.correctCount,
        isPerfect: userEntry.isPerfect,
        xpAwarded: userEntry.xpAwarded,
        bonusPointsAwarded: userEntry.bonusPointsAwarded,
        predictions: userEntry.predictions.map((p: any) => ({
          marketId: p.marketId,
          prediction: p.prediction,
          isSettled: p.isSettled,
          won: p.won
        }))
      } : null,
      timeRemaining: {
        hours: hoursRemaining,
        minutes: minutesRemaining,
        display: `${hoursRemaining}h ${minutesRemaining}m`
      }
    });
  } catch (error) {
    console.error('Error fetching daily challenge:', error);
    res.status(500).json({ error: 'Failed to fetch daily challenge' });
  }
});

/**
 * POST /api/daily-challenges/enter
 *
 * Enter today's daily challenge
 */
router.post('/enter', async (req, res) => {
  try {
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

    const entry = await enterDailyChallenge(user.id);

    res.status(201).json({
      entry: {
        id: entry.id,
        challenge: entry.challenge,
        message: 'Entered daily challenge! Make your 5 predictions.'
      }
    });
  } catch (error: any) {
    console.error('Error entering daily challenge:', error);
    res.status(400).json({ error: error.message || 'Failed to enter challenge' });
  }
});

/**
 * POST /api/daily-challenges/predict
 *
 * Make a prediction in today's challenge
 *
 * Body: {
 *   walletAddress: string,
 *   marketId: string,
 *   prediction: 'YES' | 'NO'
 * }
 */
router.post('/predict', async (req, res) => {
  try {
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

    const result = await makeDailyChallengePrediction(user.id, marketId, prediction);

    res.json({
      ...result,
      message: result.isComplete
        ? 'All picks submitted! Good luck!'
        : `Pick recorded. ${result.remainingPicks} remaining.`
    });
  } catch (error: any) {
    console.error('Error making daily challenge prediction:', error);
    res.status(400).json({ error: error.message || 'Failed to make prediction' });
  }
});

/**
 * GET /api/daily-challenges/leaderboard
 *
 * Get today's challenge leaderboard
 */
router.get('/leaderboard', async (req, res) => {
  try {
    const challenge = await getTodaysChallenge();

    if (!challenge) {
      return res.status(404).json({ error: 'No daily challenge available' });
    }

    const leaderboard = await getDailyChallengeLeaderboard(challenge.id);

    res.json({
      challengeId: challenge.id,
      date: challenge.date,
      isResolved: challenge.isFullyResolved,
      leaderboard
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

/**
 * GET /api/daily-challenges/:id
 *
 * Get a specific daily challenge by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress } = req.query;

    const challenge = await prisma.dailyChallenge.findUnique({
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
        },
        _count: {
          select: { entries: true }
        }
      }
    });

    if (!challenge) {
      return res.status(404).json({ error: 'Challenge not found' });
    }

    // Get user's entry if wallet provided
    let userEntry = null;
    if (walletAddress) {
      const user = await prisma.user.findUnique({
        where: { walletAddress: walletAddress as string }
      });

      if (user) {
        userEntry = await prisma.dailyChallengeEntry.findUnique({
          where: {
            userId_challengeId: {
              userId: user.id,
              challengeId: challenge.id
            }
          },
          include: {
            predictions: true
          }
        });
      }
    }

    const leaderboard = await getDailyChallengeLeaderboard(challenge.id);

    res.json({
      challenge: {
        ...challenge,
        participantCount: challenge._count.entries
      },
      userEntry,
      leaderboard
    });
  } catch (error) {
    console.error('Error fetching challenge:', error);
    res.status(500).json({ error: 'Failed to fetch challenge' });
  }
});

/**
 * GET /api/daily-challenges/history/:walletAddress
 *
 * Get user's daily challenge history
 */
router.get('/history/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const { limit = '10', offset = '0' } = req.query;

    const user = await prisma.user.findUnique({
      where: { walletAddress }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const entries = await prisma.dailyChallengeEntry.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit as string) || 10, 50),
      skip: parseInt(offset as string) || 0,
      include: {
        challenge: {
          select: {
            id: true,
            date: true,
            isFullyResolved: true
          }
        }
      }
    });

    // Get stats
    const [totalEntries, perfectCount, totalCorrect] = await Promise.all([
      prisma.dailyChallengeEntry.count({ where: { userId: user.id, isComplete: true } }),
      prisma.dailyChallengeEntry.count({ where: { userId: user.id, isPerfect: true } }),
      prisma.dailyChallengeEntry.aggregate({
        where: { userId: user.id },
        _sum: { correctCount: true }
      })
    ]);

    res.json({
      entries: entries.map(e => ({
        id: e.id,
        date: e.challenge.date,
        isComplete: e.isComplete,
        isResolved: e.challenge.isFullyResolved,
        correctCount: e.correctCount,
        isPerfect: e.isPerfect,
        xpAwarded: e.xpAwarded,
        bonusPointsAwarded: e.bonusPointsAwarded
      })),
      stats: {
        totalEntries,
        perfectCount,
        totalCorrect: totalCorrect._sum.correctCount || 0,
        averageCorrect: totalEntries > 0
          ? Math.round((totalCorrect._sum.correctCount || 0) / totalEntries * 10) / 10
          : 0
      }
    });
  } catch (error) {
    console.error('Error fetching challenge history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

export default router;
