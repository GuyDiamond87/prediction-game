/**
 * Battles API Routes
 *
 * Endpoints for head-to-head battles:
 * - Create/join battles
 * - Make battle predictions
 * - Matchmaking queue
 * - Battle history
 */

import { Router } from 'express';
import { prisma } from '../index';
import {
  createBattle,
  joinBattle,
  joinBattleByCode,
  cancelBattle,
  makeBattlePrediction,
  joinMatchmaking,
  leaveMatchmaking
} from '../services/battles';

const router = Router();

/**
 * POST /api/battles
 *
 * Create a new battle
 *
 * Body: {
 *   walletAddress: string,
 *   pointsStake: number
 * }
 */
router.post('/', async (req, res) => {
  try {
    const { walletAddress, pointsStake } = req.body;

    if (!walletAddress || !pointsStake) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (typeof pointsStake !== 'number' || pointsStake < 50) {
      return res.status(400).json({ error: 'Minimum stake is 50 points' });
    }

    const user = await prisma.user.findUnique({
      where: { walletAddress }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const battle = await createBattle(user.id, pointsStake, false);

    res.status(201).json({
      battle,
      shareLink: battle.shareCode ? `/battle/${battle.shareCode}` : null,
      message: 'Battle created! Share the link to invite an opponent.'
    });
  } catch (error: any) {
    console.error('Error creating battle:', error);
    res.status(400).json({ error: error.message || 'Failed to create battle' });
  }
});

/**
 * POST /api/battles/:id/join
 *
 * Join an existing battle by ID
 */
router.post('/:id/join', async (req, res) => {
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

    const battle = await joinBattle(id, user.id);

    res.json({
      battle,
      message: 'Battle joined! Make your predictions.'
    });
  } catch (error: any) {
    console.error('Error joining battle:', error);
    res.status(400).json({ error: error.message || 'Failed to join battle' });
  }
});

/**
 * POST /api/battles/join/:shareCode
 *
 * Join a battle by share code
 */
router.post('/join/:shareCode', async (req, res) => {
  try {
    const { shareCode } = req.params;
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

    const battle = await joinBattleByCode(shareCode, user.id);

    res.json({
      battle,
      message: 'Battle joined! Make your predictions.'
    });
  } catch (error: any) {
    console.error('Error joining battle by code:', error);
    res.status(400).json({ error: error.message || 'Failed to join battle' });
  }
});

/**
 * POST /api/battles/:id/cancel
 *
 * Cancel an open battle (creator only)
 */
router.post('/:id/cancel', async (req, res) => {
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

    await cancelBattle(id, user.id);

    res.json({ message: 'Battle cancelled. Stake refunded.' });
  } catch (error: any) {
    console.error('Error cancelling battle:', error);
    res.status(400).json({ error: error.message || 'Failed to cancel battle' });
  }
});

/**
 * POST /api/battles/:id/predict
 *
 * Make a prediction within a battle
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

    const battlePrediction = await makeBattlePrediction(id, user.id, marketId, prediction);

    // Get updated battle state
    const battle = await prisma.battle.findUnique({
      where: { id },
      include: {
        predictions: {
          where: { userId: user.id }
        }
      }
    });

    res.json({
      prediction: battlePrediction,
      predictionsCount: battle?.predictions.length || 0,
      message: `Predicted ${prediction} on market`
    });
  } catch (error: any) {
    console.error('Error making battle prediction:', error);
    res.status(400).json({ error: error.message || 'Failed to make prediction' });
  }
});

/**
 * GET /api/battles/:id
 *
 * Get battle details
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress } = req.query;

    const battle = await prisma.battle.findUnique({
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
        player1: {
          select: {
            walletAddress: true,
            displayName: true,
            elo: true,
            rankTier: true,
            isTokenHolder: true
          }
        },
        player2: {
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

    if (!battle) {
      return res.status(404).json({ error: 'Battle not found' });
    }

    // If wallet provided, include their predictions
    let userPredictions: any[] = [];
    if (walletAddress) {
      const user = await prisma.user.findUnique({
        where: { walletAddress: walletAddress as string }
      });

      if (user) {
        userPredictions = await prisma.prediction.findMany({
          where: {
            battleId: id,
            userId: user.id
          }
        });
      }
    }

    // Only show opponent predictions after battle is completed
    let opponentPredictions: any[] = [];
    if (battle.status === 'COMPLETED' || battle.status === 'TIE') {
      opponentPredictions = await prisma.prediction.findMany({
        where: { battleId: id },
        include: {
          user: {
            select: { walletAddress: true, displayName: true }
          }
        }
      });
    }

    res.json({
      battle: {
        ...battle,
        userPredictions,
        allPredictions: opponentPredictions
      }
    });
  } catch (error) {
    console.error('Error fetching battle:', error);
    res.status(500).json({ error: 'Failed to fetch battle' });
  }
});

/**
 * GET /api/battles/code/:shareCode
 *
 * Get battle by share code
 */
router.get('/code/:shareCode', async (req, res) => {
  try {
    const { shareCode } = req.params;

    const battle = await prisma.battle.findUnique({
      where: { shareCode },
      include: {
        markets: {
          select: {
            id: true,
            question: true,
            category: true,
            yesPrice: true,
            noPrice: true,
            status: true,
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

    if (!battle) {
      return res.status(404).json({ error: 'Battle not found' });
    }

    res.json({ battle });
  } catch (error) {
    console.error('Error fetching battle by code:', error);
    res.status(500).json({ error: 'Failed to fetch battle' });
  }
});

/**
 * GET /api/battles/user/:walletAddress
 *
 * Get all battles for a user
 */
router.get('/user/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const { status, limit = '20', offset = '0' } = req.query;

    const user = await prisma.user.findUnique({
      where: { walletAddress }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const where: any = {
      OR: [
        { player1Id: user.id },
        { player2Id: user.id }
      ]
    };

    if (status) {
      where.status = status;
    }

    const battles = await prisma.battle.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit as string) || 20, 50),
      skip: parseInt(offset as string) || 0,
      include: {
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

    // Add user's role in each battle
    const battlesWithRole = battles.map(b => ({
      ...b,
      userRole: b.player1Id === user.id ? 'player1' : 'player2',
      won: b.winnerId === user.id,
      lost: b.winnerId && b.winnerId !== user.id
    }));

    const [total, wins, losses] = await Promise.all([
      prisma.battle.count({ where }),
      prisma.battle.count({ where: { ...where, winnerId: user.id } }),
      prisma.battle.count({
        where: {
          ...where,
          winnerId: { not: null, not: user.id },
          status: 'COMPLETED'
        }
      })
    ]);

    res.json({
      battles: battlesWithRole,
      stats: {
        total,
        wins,
        losses,
        winRate: total > 0 ? Math.round((wins / (wins + losses)) * 100) : 0
      }
    });
  } catch (error) {
    console.error('Error fetching user battles:', error);
    res.status(500).json({ error: 'Failed to fetch battles' });
  }
});

/**
 * POST /api/battles/matchmaking/join
 *
 * Join the matchmaking queue for ranked battles
 */
router.post('/matchmaking/join', async (req, res) => {
  try {
    const { walletAddress, pointsStake } = req.body;

    if (!walletAddress || !pointsStake) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (typeof pointsStake !== 'number' || pointsStake < 50) {
      return res.status(400).json({ error: 'Minimum stake is 50 points' });
    }

    const user = await prisma.user.findUnique({
      where: { walletAddress }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const entry = await joinMatchmaking(user.id, pointsStake);

    res.json({
      entry,
      message: 'Joined matchmaking queue. Searching for opponent...'
    });
  } catch (error: any) {
    console.error('Error joining matchmaking:', error);
    res.status(400).json({ error: error.message || 'Failed to join matchmaking' });
  }
});

/**
 * POST /api/battles/matchmaking/leave
 *
 * Leave the matchmaking queue
 */
router.post('/matchmaking/leave', async (req, res) => {
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

    await leaveMatchmaking(user.id);

    res.json({ message: 'Left matchmaking queue' });
  } catch (error: any) {
    console.error('Error leaving matchmaking:', error);
    res.status(400).json({ error: error.message || 'Failed to leave matchmaking' });
  }
});

/**
 * GET /api/battles/matchmaking/status
 *
 * Check matchmaking status
 */
router.get('/matchmaking/status', async (req, res) => {
  try {
    const { walletAddress } = req.query;

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    const user = await prisma.user.findUnique({
      where: { walletAddress: walletAddress as string }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const entry = await prisma.matchmakingQueue.findUnique({
      where: { userId: user.id }
    });

    // Check if they got matched to a battle
    const recentBattle = await prisma.battle.findFirst({
      where: {
        OR: [
          { player1Id: user.id },
          { player2Id: user.id }
        ],
        isRanked: true,
        createdAt: { gt: new Date(Date.now() - 60 * 1000) } // Within last minute
      },
      include: {
        player1: { select: { walletAddress: true, displayName: true, elo: true } },
        player2: { select: { walletAddress: true, displayName: true, elo: true } }
      }
    });

    if (recentBattle && recentBattle.status === 'ACTIVE') {
      return res.json({
        status: 'matched',
        battle: recentBattle
      });
    }

    if (!entry) {
      return res.json({ status: 'not_in_queue' });
    }

    const queueSize = await prisma.matchmakingQueue.count();

    res.json({
      status: 'searching',
      entry,
      queueSize,
      searchingFor: `${Math.round((Date.now() - entry.joinedAt.getTime()) / 1000)}s`
    });
  } catch (error) {
    console.error('Error checking matchmaking status:', error);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

export default router;
