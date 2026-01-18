/**
 * Markets API Routes
 *
 * These endpoints let the frontend:
 * - Get list of trending markets
 * - Get details of a specific market
 * - Filter markets by category, status, etc.
 */

import { Router } from 'express';
import { prisma } from '../index';

const router = Router();

/**
 * GET /api/markets
 *
 * Get list of markets with optional filters
 *
 * Query params:
 * - trending: boolean - only show top 50 by volume
 * - category: string - filter by category
 * - status: string - OPEN, CLOSED, RESOLVED
 * - limit: number - max results (default 50)
 * - offset: number - for pagination
 */
router.get('/', async (req, res) => {
  try {
    const {
      trending,
      category,
      status,
      limit = '50',
      offset = '0'
    } = req.query;

    // Build filter conditions
    const where: any = {};

    if (trending === 'true') {
      where.isTrending = true;
    }

    if (category && typeof category === 'string') {
      where.category = category;
    }

    if (status && typeof status === 'string') {
      where.status = status.toUpperCase();
    }

    // Default to only showing OPEN markets unless specified
    if (!status) {
      where.status = 'OPEN';
    }

    const markets = await prisma.market.findMany({
      where,
      orderBy: [
        { isTrending: 'desc' },
        { volume: 'desc' }
      ],
      take: Math.min(parseInt(limit as string) || 50, 100),
      skip: parseInt(offset as string) || 0,
      select: {
        id: true,
        polymarketId: true,
        question: true,
        description: true,
        category: true,
        yesPrice: true,
        noPrice: true,
        status: true,
        outcome: true,
        endDate: true,
        volume: true,
        isTrending: true,
        lastSyncedAt: true,
        // Include count of predictions from our platform
        _count: {
          select: { predictions: true }
        }
      }
    });

    // Format response
    const formattedMarkets = markets.map(market => ({
      ...market,
      predictionCount: market._count.predictions,
      _count: undefined
    }));

    res.json({
      markets: formattedMarkets,
      count: formattedMarkets.length
    });

  } catch (error) {
    console.error('Error fetching markets:', error);
    res.status(500).json({ error: 'Failed to fetch markets' });
  }
});

/**
 * GET /api/markets/:id
 *
 * Get details of a specific market
 * Includes aggregated prediction stats from our platform users
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const market = await prisma.market.findUnique({
      where: { id },
      include: {
        // Get prediction statistics
        predictions: {
          select: {
            prediction: true,
            pointsWagered: true
          }
        }
      }
    });

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    // Calculate aggregated stats from our platform users
    const predictions = market.predictions;
    const totalPredictions = predictions.length;
    const yesPredictions = predictions.filter(p => p.prediction === 'YES').length;
    const noPredictions = predictions.filter(p => p.prediction === 'NO').length;
    const totalVolume = predictions.reduce((sum, p) => sum + p.pointsWagered, 0);

    // Calculate our platform's consensus (what % of our users predict YES)
    const platformYesPercentage = totalPredictions > 0
      ? Math.round((yesPredictions / totalPredictions) * 100)
      : 50;

    res.json({
      market: {
        id: market.id,
        polymarketId: market.polymarketId,
        question: market.question,
        description: market.description,
        category: market.category,
        yesPrice: market.yesPrice,
        noPrice: market.noPrice,
        status: market.status,
        outcome: market.outcome,
        endDate: market.endDate,
        resolutionDate: market.resolutionDate,
        volume: market.volume,
        isTrending: market.isTrending,
        lastSyncedAt: market.lastSyncedAt
      },
      platformStats: {
        totalPredictions,
        yesPredictions,
        noPredictions,
        totalVolume,
        platformYesPercentage
      }
    });

  } catch (error) {
    console.error('Error fetching market:', error);
    res.status(500).json({ error: 'Failed to fetch market' });
  }
});

/**
 * GET /api/markets/categories
 *
 * Get list of all categories with market counts
 */
router.get('/meta/categories', async (req, res) => {
  try {
    const categories = await prisma.market.groupBy({
      by: ['category'],
      where: {
        status: 'OPEN'
      },
      _count: {
        id: true
      },
      orderBy: {
        _count: {
          id: 'desc'
        }
      }
    });

    res.json({
      categories: categories.map(c => ({
        name: c.category || 'other',
        count: c._count.id
      }))
    });

  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

/**
 * GET /api/markets/stats
 *
 * Get overall platform statistics
 */
router.get('/meta/stats', async (req, res) => {
  try {
    const [
      totalMarkets,
      openMarkets,
      totalPredictions,
      totalUsers
    ] = await Promise.all([
      prisma.market.count(),
      prisma.market.count({ where: { status: 'OPEN' } }),
      prisma.prediction.count(),
      prisma.user.count()
    ]);

    res.json({
      totalMarkets,
      openMarkets,
      totalPredictions,
      totalUsers
    });

  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
