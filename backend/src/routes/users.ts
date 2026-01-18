/**
 * Users API Routes
 *
 * These endpoints handle:
 * - User registration (on wallet connect)
 * - Getting user profile and stats
 * - Checking token holder status
 */

import { Router } from 'express';
import { prisma } from '../index';
import { checkTokenHolderStatus } from '../services/token';
import { getRankTier } from '../utils/elo';

const router = Router();

/**
 * POST /api/users/connect
 *
 * Called when a user connects their wallet.
 * Creates a new user if they don't exist, or returns existing user.
 *
 * Body: { walletAddress: string }
 */
router.post('/connect', async (req, res) => {
  try {
    const { walletAddress } = req.body;

    if (!walletAddress || typeof walletAddress !== 'string') {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    // Normalize wallet address (Solana addresses are case-sensitive base58)
    const normalizedAddress = walletAddress.trim();

    // Check if user already exists
    let user = await prisma.user.findUnique({
      where: { walletAddress: normalizedAddress }
    });

    const isNewUser = !user;

    if (!user) {
      // Create new user with starting values
      user = await prisma.user.create({
        data: {
          walletAddress: normalizedAddress,
          points: 1000,        // Starting bonus
          xp: 0,
          elo: 1200,           // Starting ELO
          peakElo: 1200,
          rankTier: 'BRONZE',
          currentStreak: 0,
          longestStreak: 0,
          lastLoginAt: new Date()
        }
      });

      // Record the initial points bonus in transaction log
      await prisma.pointsTransaction.create({
        data: {
          userId: user.id,
          amount: 1000,
          balanceBefore: 0,
          balanceAfter: 1000,
          reason: 'INITIAL_BONUS',
          description: 'Welcome bonus - 1000 starting points'
        }
      });

      console.log(`New user created: ${normalizedAddress}`);
    } else {
      // Update last login
      user = await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() }
      });
    }

    // Check token holder status (async, don't block response)
    checkTokenHolderStatus(user.id, normalizedAddress).catch(err => {
      console.error('Error checking token status:', err);
    });

    res.json({
      user: formatUserResponse(user),
      isNewUser
    });

  } catch (error) {
    console.error('Error connecting user:', error);
    res.status(500).json({ error: 'Failed to connect user' });
  }
});

/**
 * GET /api/users/:walletAddress
 *
 * Get a user's public profile by wallet address
 */
router.get('/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;

    const user = await prisma.user.findUnique({
      where: { walletAddress },
      include: {
        // Get recent predictions for profile
        predictions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            market: {
              select: {
                question: true,
                status: true,
                outcome: true
              }
            }
          }
        },
        // Get season results
        seasonResults: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: {
            season: {
              select: {
                name: true,
                seasonNumber: true
              }
            }
          }
        },
        // Get recent ELO history for graph
        eloHistory: {
          orderBy: { createdAt: 'desc' },
          take: 50
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Calculate win rate
    const winRate = user.totalPredictions > 0
      ? Math.round((user.totalWins / user.totalPredictions) * 100)
      : 0;

    // Calculate head-to-head win rate
    const h2hTotal = user.h2hWins + user.h2hLosses;
    const h2hWinRate = h2hTotal > 0
      ? Math.round((user.h2hWins / h2hTotal) * 100)
      : 0;

    res.json({
      user: {
        walletAddress: user.walletAddress,
        displayName: user.displayName,
        profileColor: user.profileColor,
        points: user.points,
        xp: user.xp,
        elo: user.elo,
        peakElo: user.peakElo,
        rankTier: user.rankTier,
        currentStreak: user.currentStreak,
        longestStreak: user.longestStreak,
        totalPredictions: user.totalPredictions,
        totalWins: user.totalWins,
        totalLosses: user.totalLosses,
        winRate,
        h2hWins: user.h2hWins,
        h2hLosses: user.h2hLosses,
        h2hWinRate,
        tournamentWins: user.tournamentWins,
        isTokenHolder: user.isTokenHolder,
        createdAt: user.createdAt
      },
      recentPredictions: user.predictions.map(p => ({
        id: p.id,
        prediction: p.prediction,
        pointsWagered: p.pointsWagered,
        isSettled: p.isSettled,
        won: p.won,
        pointsEarned: p.pointsEarned,
        createdAt: p.createdAt,
        market: p.market
      })),
      seasonResults: user.seasonResults.map(sr => ({
        seasonName: sr.season.name,
        seasonNumber: sr.season.seasonNumber,
        finalElo: sr.finalElo,
        finalRank: sr.finalRank,
        badge: sr.badge
      })),
      eloHistory: user.eloHistory.map(eh => ({
        elo: eh.eloAfter,
        change: eh.change,
        reason: eh.reason,
        timestamp: eh.createdAt
      }))
    });

  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

/**
 * GET /api/users/:walletAddress/token-status
 *
 * Force refresh and return token holder status
 */
router.get('/:walletAddress/token-status', async (req, res) => {
  try {
    const { walletAddress } = req.params;

    const user = await prisma.user.findUnique({
      where: { walletAddress }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Force refresh token status
    const isTokenHolder = await checkTokenHolderStatus(user.id, walletAddress);

    res.json({
      walletAddress,
      isTokenHolder,
      checkedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error checking token status:', error);
    res.status(500).json({ error: 'Failed to check token status' });
  }
});

/**
 * PATCH /api/users/:walletAddress/profile
 *
 * Update user profile (token holders only)
 *
 * Body: { displayName?: string, profileColor?: string }
 */
router.patch('/:walletAddress/profile', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const { displayName, profileColor } = req.body;

    const user = await prisma.user.findUnique({
      where: { walletAddress }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Only token holders can customize profile
    if (!user.isTokenHolder) {
      return res.status(403).json({
        error: 'Profile customization requires holding the platform token'
      });
    }

    // Validate display name (if provided)
    if (displayName !== undefined) {
      if (typeof displayName !== 'string' || displayName.length > 20) {
        return res.status(400).json({ error: 'Display name must be 20 characters or less' });
      }
    }

    // Validate profile color (if provided)
    if (profileColor !== undefined) {
      if (!/^#[0-9A-Fa-f]{6}$/.test(profileColor)) {
        return res.status(400).json({ error: 'Profile color must be a valid hex color' });
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        displayName: displayName ?? user.displayName,
        profileColor: profileColor ?? user.profileColor
      }
    });

    res.json({
      user: formatUserResponse(updatedUser)
    });

  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * Format user object for API response (hide sensitive fields)
 */
function formatUserResponse(user: any) {
  return {
    id: user.id,
    walletAddress: user.walletAddress,
    displayName: user.displayName,
    profileColor: user.profileColor,
    points: user.points,
    xp: user.xp,
    elo: user.elo,
    peakElo: user.peakElo,
    rankTier: user.rankTier,
    currentStreak: user.currentStreak,
    longestStreak: user.longestStreak,
    totalPredictions: user.totalPredictions,
    totalWins: user.totalWins,
    totalLosses: user.totalLosses,
    h2hWins: user.h2hWins,
    h2hLosses: user.h2hLosses,
    tournamentWins: user.tournamentWins,
    isTokenHolder: user.isTokenHolder,
    lastPredictionAt: user.lastPredictionAt,
    createdAt: user.createdAt
  };
}

export default router;
