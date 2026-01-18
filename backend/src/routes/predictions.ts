/**
 * Predictions API Routes
 *
 * These endpoints handle:
 * - Creating new predictions
 * - Getting user's predictions
 * - Getting prediction details
 */

import { Router } from 'express';
import { prisma } from '../index';
import { PredictionChoice } from '@prisma/client';
import { calculatePotentialPayout } from '../utils/points';
import { getRankTier } from '../utils/elo';

const router = Router();

// Minimum points that can be wagered
const MIN_WAGER = 10;

/**
 * POST /api/predictions
 *
 * Create a new prediction on a market
 *
 * Body: {
 *   walletAddress: string,
 *   marketId: string,
 *   prediction: 'YES' | 'NO',
 *   pointsWagered: number
 * }
 */
router.post('/', async (req, res) => {
  try {
    const { walletAddress, marketId, prediction, pointsWagered } = req.body;

    // Validate inputs
    if (!walletAddress || !marketId || !prediction || !pointsWagered) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (prediction !== 'YES' && prediction !== 'NO') {
      return res.status(400).json({ error: 'Prediction must be YES or NO' });
    }

    if (typeof pointsWagered !== 'number' || pointsWagered < MIN_WAGER) {
      return res.status(400).json({ error: `Minimum wager is ${MIN_WAGER} points` });
    }

    // Get user
    const user = await prisma.user.findUnique({
      where: { walletAddress }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found. Please connect wallet first.' });
    }

    // Check user has enough points
    if (user.points < pointsWagered) {
      return res.status(400).json({
        error: 'Insufficient points',
        available: user.points,
        required: pointsWagered
      });
    }

    // Get market
    const market = await prisma.market.findUnique({
      where: { id: marketId }
    });

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    // Check market is still open
    if (market.status !== 'OPEN') {
      return res.status(400).json({ error: 'Market is no longer accepting predictions' });
    }

    // Check if market has ended
    if (market.endDate && new Date() > market.endDate) {
      return res.status(400).json({ error: 'Market has ended' });
    }

    // Check if user already has a prediction on this market
    const existingPrediction = await prisma.prediction.findUnique({
      where: {
        userId_marketId: {
          userId: user.id,
          marketId: market.id
        }
      }
    });

    if (existingPrediction) {
      return res.status(400).json({ error: 'You already have a prediction on this market' });
    }

    // Get the odds at time of prediction
    const oddsAtPrediction = prediction === 'YES' ? market.yesPrice : market.noPrice;

    // Calculate potential payout
    const potentialPayout = calculatePotentialPayout(
      pointsWagered,
      oddsAtPrediction,
      user.isTokenHolder
    );

    // Create prediction and update user in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Deduct points from user
      const updatedUser = await tx.user.update({
        where: { id: user.id },
        data: {
          points: { decrement: pointsWagered },
          totalPredictions: { increment: 1 },
          predictionsThisWeek: { increment: 1 },
          lastPredictionAt: new Date()
        }
      });

      // Create the prediction
      const newPrediction = await tx.prediction.create({
        data: {
          userId: user.id,
          marketId: market.id,
          prediction: prediction as PredictionChoice,
          pointsWagered,
          oddsAtPrediction,
          eloAtPrediction: user.elo,
          wasTokenHolder: user.isTokenHolder,
          isSettled: false
        }
      });

      // Record points transaction
      await tx.pointsTransaction.create({
        data: {
          userId: user.id,
          amount: -pointsWagered,
          balanceBefore: user.points,
          balanceAfter: user.points - pointsWagered,
          reason: 'PREDICTION_WAGER',
          referenceId: newPrediction.id,
          description: `Wagered on: ${market.question.slice(0, 50)}...`
        }
      });

      // Award XP for making a prediction (5 XP base, 2x if token holder)
      const xpEarned = user.isTokenHolder ? 10 : 5;
      await tx.user.update({
        where: { id: user.id },
        data: { xp: { increment: xpEarned } }
      });

      return { prediction: newPrediction, user: updatedUser, xpEarned };
    });

    res.status(201).json({
      prediction: {
        id: result.prediction.id,
        marketId: result.prediction.marketId,
        prediction: result.prediction.prediction,
        pointsWagered: result.prediction.pointsWagered,
        oddsAtPrediction: result.prediction.oddsAtPrediction,
        potentialPayout: Math.round(potentialPayout),
        createdAt: result.prediction.createdAt
      },
      user: {
        points: result.user.points,
        xp: result.user.xp,
        totalPredictions: result.user.totalPredictions
      },
      xpEarned: result.xpEarned,
      message: `Prediction placed! You wagered ${pointsWagered} points on ${prediction}`
    });

  } catch (error) {
    console.error('Error creating prediction:', error);
    res.status(500).json({ error: 'Failed to create prediction' });
  }
});

/**
 * GET /api/predictions/user/:walletAddress
 *
 * Get all predictions for a user
 *
 * Query params:
 * - settled: 'true' | 'false' - filter by settlement status
 * - limit: number
 * - offset: number
 */
router.get('/user/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const { settled, limit = '50', offset = '0' } = req.query;

    const user = await prisma.user.findUnique({
      where: { walletAddress }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Build filter
    const where: any = { userId: user.id };
    if (settled === 'true') where.isSettled = true;
    if (settled === 'false') where.isSettled = false;

    const predictions = await prisma.prediction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit as string) || 50, 100),
      skip: parseInt(offset as string) || 0,
      include: {
        market: {
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

    // Calculate potential payouts for unsettled predictions
    const formattedPredictions = predictions.map(p => {
      const potentialPayout = !p.isSettled
        ? calculatePotentialPayout(p.pointsWagered, p.oddsAtPrediction, p.wasTokenHolder)
        : null;

      return {
        id: p.id,
        prediction: p.prediction,
        pointsWagered: p.pointsWagered,
        oddsAtPrediction: p.oddsAtPrediction,
        potentialPayout: potentialPayout ? Math.round(potentialPayout) : null,
        isSettled: p.isSettled,
        won: p.won,
        pointsEarned: p.pointsEarned,
        eloChange: p.eloChange,
        xpEarned: p.xpEarned,
        createdAt: p.createdAt,
        settledAt: p.settledAt,
        market: p.market
      };
    });

    // Get totals
    const [totalActive, totalSettled] = await Promise.all([
      prisma.prediction.count({ where: { userId: user.id, isSettled: false } }),
      prisma.prediction.count({ where: { userId: user.id, isSettled: true } })
    ]);

    res.json({
      predictions: formattedPredictions,
      totals: {
        active: totalActive,
        settled: totalSettled,
        all: totalActive + totalSettled
      }
    });

  } catch (error) {
    console.error('Error fetching predictions:', error);
    res.status(500).json({ error: 'Failed to fetch predictions' });
  }
});

/**
 * GET /api/predictions/:id
 *
 * Get details of a specific prediction
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const prediction = await prisma.prediction.findUnique({
      where: { id },
      include: {
        market: true,
        user: {
          select: {
            walletAddress: true,
            displayName: true,
            isTokenHolder: true
          }
        }
      }
    });

    if (!prediction) {
      return res.status(404).json({ error: 'Prediction not found' });
    }

    const potentialPayout = !prediction.isSettled
      ? calculatePotentialPayout(
          prediction.pointsWagered,
          prediction.oddsAtPrediction,
          prediction.wasTokenHolder
        )
      : null;

    res.json({
      prediction: {
        id: prediction.id,
        prediction: prediction.prediction,
        pointsWagered: prediction.pointsWagered,
        oddsAtPrediction: prediction.oddsAtPrediction,
        potentialPayout: potentialPayout ? Math.round(potentialPayout) : null,
        isSettled: prediction.isSettled,
        won: prediction.won,
        pointsEarned: prediction.pointsEarned,
        eloChange: prediction.eloChange,
        xpEarned: prediction.xpEarned,
        createdAt: prediction.createdAt,
        settledAt: prediction.settledAt,
        market: prediction.market,
        user: prediction.user
      }
    });

  } catch (error) {
    console.error('Error fetching prediction:', error);
    res.status(500).json({ error: 'Failed to fetch prediction' });
  }
});

/**
 * GET /api/predictions/market/:marketId
 *
 * Get all predictions for a specific market (for showing community predictions)
 */
router.get('/market/:marketId', async (req, res) => {
  try {
    const { marketId } = req.params;
    const { limit = '20' } = req.query;

    const predictions = await prisma.prediction.findMany({
      where: { marketId },
      orderBy: { pointsWagered: 'desc' },
      take: Math.min(parseInt(limit as string) || 20, 50),
      include: {
        user: {
          select: {
            walletAddress: true,
            displayName: true,
            elo: true,
            rankTier: true,
            isTokenHolder: true
          }
        }
      }
    });

    // Only show predictions from token holders on public view
    const visiblePredictions = predictions.filter(p => p.user.isTokenHolder);

    // Get aggregate stats
    const allPredictions = await prisma.prediction.findMany({
      where: { marketId },
      select: { prediction: true, pointsWagered: true }
    });

    const yesCount = allPredictions.filter(p => p.prediction === 'YES').length;
    const noCount = allPredictions.filter(p => p.prediction === 'NO').length;
    const totalVolume = allPredictions.reduce((sum, p) => sum + p.pointsWagered, 0);

    res.json({
      predictions: visiblePredictions.map(p => ({
        id: p.id,
        prediction: p.prediction,
        pointsWagered: p.pointsWagered,
        createdAt: p.createdAt,
        user: {
          walletAddress: p.user.walletAddress,
          displayName: p.user.displayName,
          elo: p.user.elo,
          rankTier: p.user.rankTier
        }
      })),
      stats: {
        totalPredictions: allPredictions.length,
        yesCount,
        noCount,
        yesPercentage: allPredictions.length > 0 ? Math.round((yesCount / allPredictions.length) * 100) : 50,
        totalVolume
      }
    });

  } catch (error) {
    console.error('Error fetching market predictions:', error);
    res.status(500).json({ error: 'Failed to fetch predictions' });
  }
});

export default router;
