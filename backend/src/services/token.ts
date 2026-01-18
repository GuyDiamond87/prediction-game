/**
 * Token Holder Verification Service
 *
 * Checks if a Solana wallet holds the platform token.
 * Token holders get:
 * - 2x XP earnings
 * - 10% bonus on payouts
 * - Profile customization (display name, colors)
 * - Visible predictions on markets
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { prisma } from '../index';

// Solana RPC endpoint (use environment variable or default to mainnet)
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Platform token mint address (set this in .env)
const TOKEN_MINT = process.env.TOKEN_MINT_ADDRESS || '';

// Minimum tokens required to be considered a "holder"
const MIN_TOKEN_BALANCE = parseInt(process.env.MIN_TOKEN_BALANCE || '1');

// Cache token status for 1 hour to reduce RPC calls
const CACHE_DURATION_MS = 60 * 60 * 1000;

// Solana connection instance
let connection: Connection | null = null;

/**
 * Get or create Solana connection
 */
function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(SOLANA_RPC, 'confirmed');
  }
  return connection;
}

/**
 * Check if a wallet holds the platform token
 * Updates the user record with the result
 *
 * @param userId - Internal user ID
 * @param walletAddress - Solana wallet address
 * @returns Whether the wallet holds the token
 */
export async function checkTokenHolderStatus(
  userId: string,
  walletAddress: string
): Promise<boolean> {
  try {
    // Check if we have a recent cached result
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        isTokenHolder: true,
        tokenBalanceCheckedAt: true
      }
    });

    if (user?.tokenBalanceCheckedAt) {
      const cacheAge = Date.now() - user.tokenBalanceCheckedAt.getTime();
      if (cacheAge < CACHE_DURATION_MS) {
        // Return cached result
        return user.isTokenHolder;
      }
    }

    // If no token mint configured, everyone is a non-holder
    if (!TOKEN_MINT) {
      await updateTokenStatus(userId, false);
      return false;
    }

    // Check token balance on-chain
    const isHolder = await checkOnChainBalance(walletAddress);

    // Update user record
    await updateTokenStatus(userId, isHolder);

    return isHolder;

  } catch (error) {
    console.error(`Error checking token status for ${walletAddress}:`, error);
    // On error, don't change existing status
    return false;
  }
}

/**
 * Check token balance on Solana blockchain
 */
async function checkOnChainBalance(walletAddress: string): Promise<boolean> {
  try {
    const conn = getConnection();
    const wallet = new PublicKey(walletAddress);
    const mint = new PublicKey(TOKEN_MINT);

    // Get all token accounts for this wallet
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(wallet, {
      mint: mint
    });

    // Check if any account has sufficient balance
    for (const { account } of tokenAccounts.value) {
      const tokenAmount = account.data.parsed?.info?.tokenAmount;
      if (tokenAmount) {
        const balance = parseInt(tokenAmount.amount);
        const decimals = tokenAmount.decimals;
        const humanBalance = balance / Math.pow(10, decimals);

        if (humanBalance >= MIN_TOKEN_BALANCE) {
          return true;
        }
      }
    }

    return false;

  } catch (error) {
    console.error('Error checking on-chain balance:', error);
    throw error;
  }
}

/**
 * Update user's token holder status in database
 */
async function updateTokenStatus(userId: string, isTokenHolder: boolean): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      isTokenHolder,
      tokenBalanceCheckedAt: new Date()
    }
  });
}

/**
 * Batch check token status for multiple users
 * Useful for running as a periodic job
 *
 * @param limit - Maximum users to check per batch
 */
export async function batchCheckTokenStatus(limit: number = 100): Promise<void> {
  // Find users with stale or missing token checks
  const staleThreshold = new Date(Date.now() - CACHE_DURATION_MS);

  const usersToCheck = await prisma.user.findMany({
    where: {
      OR: [
        { tokenBalanceCheckedAt: null },
        { tokenBalanceCheckedAt: { lt: staleThreshold } }
      ]
    },
    select: {
      id: true,
      walletAddress: true
    },
    take: limit,
    orderBy: {
      tokenBalanceCheckedAt: 'asc'
    }
  });

  console.log(`Checking token status for ${usersToCheck.length} users`);

  for (const user of usersToCheck) {
    try {
      await checkTokenHolderStatus(user.id, user.walletAddress);
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`Failed to check token for ${user.walletAddress}:`, error);
    }
  }
}

/**
 * Force refresh token status (bypasses cache)
 */
export async function forceRefreshTokenStatus(
  userId: string,
  walletAddress: string
): Promise<boolean> {
  // Clear cache by setting old timestamp
  await prisma.user.update({
    where: { id: userId },
    data: {
      tokenBalanceCheckedAt: new Date(0)
    }
  });

  return checkTokenHolderStatus(userId, walletAddress);
}

/**
 * Get token holder statistics for the platform
 */
export async function getTokenHolderStats(): Promise<{
  totalHolders: number;
  percentageOfUsers: number;
}> {
  const [totalUsers, totalHolders] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { isTokenHolder: true } })
  ]);

  const percentageOfUsers = totalUsers > 0
    ? Math.round((totalHolders / totalUsers) * 100)
    : 0;

  return {
    totalHolders,
    percentageOfUsers
  };
}
