/**
 * Battles API Routes
 *
 * Endpoints for head-to-head battles with draft-style market picking:
 * - Create battles with fixed wager tiers
 * - Join battles and participate in draft
 * - Make draft picks with 60 second timer
 * - Tiebreaker market selection
 * - Battle history and stats
 */

import { Router } from 'express';
import { prisma } from '../index';
import {
  createBattle,
  joinBattle,
  joinBattleByCode,
  cancelBattle,
  getOpenBattles,
  getBattle,
  getAvailableMarkets,
  makePick,
  makeTiebreakerPick,
  submitTiebreakerPrediction,
  WAGER_TIERS
} from '../services/battles';

const router = Router();

/**
 * GET /api/battles/wager-tiers
 *
 * Get available wager tiers
 */
router.get('/wager-tiers', (req, res) => {
  res.json({ tiers: WAGER_TIERS });
});

/**
 * GET /api/battles/open
 *
 * Get list of open battles waiting for opponents
 */
router.get('/open', async (req, res) => {
  try {
    const battles = await getOpenBattles();
    res.json({ battles });
  } catch (error) {
    console.error('Error fetching open battles:', error);
    res.status(500).json({ error: 'Failed to fetch open battles' });
  }
});

/**
 * POST /api/battles
 *
 * Create a new battle with a wager tier
 *
 * Body: {
 *   walletAddress: string,
 *   wagerTier: number  // Must be one of WAGER_TIERS
 * }
 */
router.post('/', async (req, res) => {
  try {
    const { walletAddress, wagerTier } = req.body;

    if (!walletAddress || wagerTier === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!WAGER_TIERS.includes(wagerTier)) {
      return res.status(400).json({
        error: `Invalid wager tier. Must be one of: ${WAGER_TIERS.join(', ')}`
      });
    }

    const user = await prisma.user.findUnique({
      where: { walletAddress }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const battle = await createBattle(user.id, wagerTier);

    res.status(201).json({
      battle,
      shareLink: battle.shareCode ? `/battle/${battle.shareCode}` : null,
      message: 'Battle created! Share the link or wait in the lobby.'
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
      message: 'Battle joined! Connect to the battle room to start the draft.'
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
      message: 'Battle joined! Connect to the battle room to start the draft.'
    });
  } catch (error: any) {
    console.error('Error joining battle by code:', error);
    res.status(400).json({ error: error.message || 'Failed to join battle' });
  }
});

/**
 * POST /api/battles/:id/cancel
 *
 * Cancel an open battle (creator only, before someone joins)
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
 * GET /api/battles/:id/available-markets
 *
 * Get markets available for picking (resolving within 24 hours)
 */
router.get('/:id/available-markets', async (req, res) => {
  try {
    const { id } = req.params;
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

    const battle = await prisma.battle.findUnique({
      where: { id }
    });

    if (!battle) {
      return res.status(404).json({ error: 'Battle not found' });
    }

    // Check user is part of battle
    if (battle.player1Id !== user.id && battle.player2Id !== user.id) {
      return res.status(403).json({ error: 'You are not part of this battle' });
    }

    const markets = await getAvailableMarkets(id);

    res.json({ markets });
  } catch (error: any) {
    console.error('Error fetching available markets:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch markets' });
  }
});

/**
 * POST /api/battles/:id/pick
 *
 * Make a draft pick (market + prediction)
 *
 * Body: {
 *   walletAddress: string,
 *   marketId: string,
 *   prediction: 'YES' | 'NO'
 * }
 */
router.post('/:id/pick', async (req, res) => {
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

    const result = await makePick(id, user.id, marketId, prediction);

    res.json({
      pick: result.pick,
      pickNumber: result.pickNumber,
      draftComplete: result.draftComplete,
      needsTiebreaker: result.needsTiebreaker,
      nextPickerId: result.nextPickerId,
      nextPickNumber: result.nextPickNumber,
      nextDeadline: result.nextDeadline,
      message: `Picked market with ${prediction} prediction`
    });
  } catch (error: any) {
    console.error('Error making pick:', error);
    res.status(400).json({ error: error.message || 'Failed to make pick' });
  }
});

/**
 * POST /api/battles/:id/tiebreaker/pick
 *
 * Pick the tiebreaker market (coin flip loser only)
 *
 * Body: {
 *   walletAddress: string,
 *   marketId: string
 * }
 */
router.post('/:id/tiebreaker/pick', async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress, marketId } = req.body;

    if (!walletAddress || !marketId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const user = await prisma.user.findUnique({
      where: { walletAddress }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const result = await makeTiebreakerPick(id, user.id, marketId);

    res.json({
      battle: result.battle,
      predictionDeadline: result.predictionDeadline,
      message: 'Tiebreaker market selected. Both players must now predict YES or NO.'
    });
  } catch (error: any) {
    console.error('Error picking tiebreaker:', error);
    res.status(400).json({ error: error.message || 'Failed to pick tiebreaker' });
  }
});

/**
 * POST /api/battles/:id/tiebreaker/predict
 *
 * Submit tiebreaker prediction (both players)
 *
 * Body: {
 *   walletAddress: string,
 *   prediction: 'YES' | 'NO'
 * }
 */
router.post('/:id/tiebreaker/predict', async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress, prediction } = req.body;

    if (!walletAddress || !prediction) {
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

    const result = await submitTiebreakerPrediction(id, user.id, prediction);

    res.json({
      bothSubmitted: result.bothSubmitted,
      draftComplete: result.bothSubmitted,
      message: result.bothSubmitted
        ? 'Draft complete! Battle is now active.'
        : 'Prediction submitted. Waiting for opponent.'
    });
  } catch (error: any) {
    console.error('Error submitting tiebreaker prediction:', error);
    res.status(400).json({ error: error.message || 'Failed to submit prediction' });
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

    const battle = await getBattle(id);

    if (!battle) {
      return res.status(404).json({ error: 'Battle not found' });
    }

    // Filter data based on whether user is in the battle and battle status
    let responseData: any = { battle };

    if (walletAddress) {
      const user = await prisma.user.findUnique({
        where: { walletAddress: walletAddress as string }
      });

      if (user) {
        const isInBattle = battle.player1Id === user.id || battle.player2Id === user.id;
        const isPlayer1 = battle.player1Id === user.id;

        responseData.isInBattle = isInBattle;
        responseData.isPlayer1 = isPlayer1;
        responseData.isMyTurn = battle.currentPickPlayerId === user.id;

        // Hide opponent picks during draft (except which markets they picked)
        if (isInBattle && battle.status === 'DRAFTING') {
          responseData.battle.picks = battle.picks.map((pick: any) => ({
            ...pick,
            prediction: pick.pickerId === user.id ? pick.prediction : undefined
          }));
        }

        // Hide tiebreaker predictions during prediction phase
        if (isInBattle && battle.status === 'DRAFTING' && battle.currentPickNumber === 12) {
          if (!isPlayer1) {
            responseData.battle.player1TiebreakerPick = undefined;
          } else {
            responseData.battle.player2TiebreakerPick = undefined;
          }
        }
      }
    }

    res.json(responseData);
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
      // Handle comma-separated status values
      const statusList = (status as string).split(',').map(s => s.trim());
      if (statusList.length === 1) {
        where.status = statusList[0];
      } else {
        where.status = { in: statusList };
      }
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
    const battlesWithRole = battles.map((b: any) => ({
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
          winnerId: { not: user.id },
          NOT: { winnerId: null },
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
        winRate: total > 0 ? Math.round((wins / (wins + losses || 1)) * 100) : 0
      }
    });
  } catch (error) {
    console.error('Error fetching user battles:', error);
    res.status(500).json({ error: 'Failed to fetch battles' });
  }
});

export default router;
