/**
 * Polymarket Sync Service
 *
 * This service is responsible for:
 * 1. Fetching market data from Polymarket's Gamma API
 * 2. Storing and updating markets in our database
 * 3. Detecting newly resolved markets
 * 4. Marking trending markets (top 50 by volume)
 *
 * Polymarket API docs: https://docs.polymarket.com/developers/gamma-markets-api/overview
 */

import axios from 'axios';
import { prisma } from '../index';
import { MarketStatus, MarketOutcome } from '@prisma/client';

// Polymarket Gamma API base URL (trim to handle env vars with trailing spaces)
const POLYMARKET_API = (process.env.POLYMARKET_API_URL || 'https://gamma-api.polymarket.com').trim();

// How many top markets by volume to consider "trending"
const TRENDING_THRESHOLD = 50;

/**
 * Type definitions for Polymarket API responses
 * These match what Polymarket returns
 */
interface PolymarketMarket {
  id: string;
  question: string;
  description?: string;
  conditionId?: string;
  slug?: string;

  // Outcomes (usually YES/NO)
  outcomes: string[];
  outcomePrices: string[]; // Prices as strings like "0.65"

  // Status
  active: boolean;
  closed: boolean;
  resolved: boolean;
  resolution?: string; // "YES", "NO", or outcome index

  // Dates
  endDate?: string;
  resolutionDate?: string;

  // Volume and liquidity
  volume?: string;
  volumeNum?: number;
  liquidity?: string;

  // Category/tags
  tags?: Array<{ label: string }>;
  category?: string;
}

interface PolymarketResponse {
  data?: PolymarketMarket[];
  markets?: PolymarketMarket[];
  // API might return data in different formats
}

/**
 * Main sync function - pulls all active markets from Polymarket
 * and updates our database
 */
export async function syncMarketsFromPolymarket(): Promise<void> {
  console.log('  Fetching markets from Polymarket...');

  try {
    // Fetch markets from Polymarket Gamma API
    // We'll fetch active markets sorted by volume to get the most popular ones
    const response = await axios.get(`${POLYMARKET_API}/markets`, {
      params: {
        active: true,
        closed: false,
        limit: 100, // Get top 100 markets
        order: 'volume',
        ascending: false
      },
      timeout: 30000 // 30 second timeout
    });

    // Handle different response formats
    const markets: PolymarketMarket[] = response.data?.data || response.data?.markets || response.data || [];

    if (!Array.isArray(markets)) {
      console.log('  Warning: Unexpected response format from Polymarket');
      console.log('  Response:', JSON.stringify(response.data).slice(0, 500));
      return;
    }

    console.log(`  Found ${markets.length} markets from Polymarket`);

    // Get all volumes to determine trending threshold
    const volumes = markets
      .map(m => parseFloat(m.volume || '0') || m.volumeNum || 0)
      .sort((a, b) => b - a);

    const trendingVolumeThreshold = volumes[TRENDING_THRESHOLD - 1] || 0;

    // Process each market
    let created = 0;
    let updated = 0;

    for (const market of markets) {
      try {
        const result = await upsertMarket(market, trendingVolumeThreshold);
        if (result === 'created') created++;
        if (result === 'updated') updated++;
      } catch (error) {
        console.error(`  Error processing market ${market.id}:`, error);
      }
    }

    console.log(`  Sync complete: ${created} created, ${updated} updated`);

    // Also check for resolved markets that we have predictions on
    await checkForResolvedMarkets();

  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('  Polymarket API error:', error.response?.status, error.message);
    } else {
      console.error('  Error syncing markets:', error);
    }
    throw error;
  }
}

/**
 * Insert or update a single market in our database
 */
async function upsertMarket(
  polymarket: PolymarketMarket,
  trendingVolumeThreshold: number
): Promise<'created' | 'updated' | 'skipped'> {
  // Parse prices - Polymarket returns YES price first, NO price second
  // Handle NaN values by defaulting to 0.5
  let yesPrice = parseFloat(polymarket.outcomePrices?.[0] || '0.5');
  let noPrice = parseFloat(polymarket.outcomePrices?.[1] || '0.5');
  if (isNaN(yesPrice)) yesPrice = 0.5;
  if (isNaN(noPrice)) noPrice = 0.5;

  // Parse volume (handle NaN)
  let volume = parseFloat(polymarket.volume || '0') || polymarket.volumeNum || 0;
  if (isNaN(volume)) volume = 0;

  // Determine if this market is trending (top 50 by volume)
  const isTrending = volume >= trendingVolumeThreshold;

  // Determine market status
  let status: MarketStatus = 'OPEN';
  let outcome: MarketOutcome | null = null;

  if (polymarket.resolved) {
    status = 'RESOLVED';
    // Parse resolution - could be "YES", "NO", or index
    if (polymarket.resolution === 'YES' || polymarket.resolution === '0') {
      outcome = 'YES';
    } else if (polymarket.resolution === 'NO' || polymarket.resolution === '1') {
      outcome = 'NO';
    }
  } else if (polymarket.closed) {
    status = 'CLOSED';
  }

  // Get category from tags
  const category = polymarket.category ||
    polymarket.tags?.[0]?.label ||
    'other';

  // Parse dates
  const endDate = polymarket.endDate ? new Date(polymarket.endDate) : null;
  const resolutionDate = polymarket.resolutionDate ? new Date(polymarket.resolutionDate) : null;

  // Check if market already exists
  const existing = await prisma.market.findUnique({
    where: { polymarketId: polymarket.id }
  });

  if (existing) {
    // Update existing market
    await prisma.market.update({
      where: { polymarketId: polymarket.id },
      data: {
        question: polymarket.question,
        description: polymarket.description,
        category,
        yesPrice,
        noPrice,
        status,
        outcome,
        endDate,
        resolutionDate,
        volume,
        isTrending,
        lastSyncedAt: new Date()
      }
    });
    return 'updated';
  } else {
    // Create new market
    await prisma.market.create({
      data: {
        polymarketId: polymarket.id,
        conditionId: polymarket.conditionId,
        question: polymarket.question,
        description: polymarket.description,
        category,
        yesPrice,
        noPrice,
        status,
        outcome,
        endDate,
        resolutionDate,
        volume,
        isTrending,
        lastSyncedAt: new Date()
      }
    });
    return 'created';
  }
}

/**
 * Check for markets that have resolved but we haven't settled yet
 * This is called both during regular sync and on its own schedule
 */
export async function checkForResolvedMarkets(): Promise<void> {
  // Find markets in our database that:
  // 1. Have unsettled predictions
  // 2. Might be resolved on Polymarket

  const marketsWithUnsettledPredictions = await prisma.market.findMany({
    where: {
      predictions: {
        some: {
          isSettled: false
        }
      },
      status: {
        not: 'RESOLVED'
      }
    },
    select: {
      id: true,
      polymarketId: true
    }
  });

  if (marketsWithUnsettledPredictions.length === 0) {
    return;
  }

  console.log(`  Checking resolution status for ${marketsWithUnsettledPredictions.length} markets with unsettled predictions`);

  // Check each market individually on Polymarket
  for (const market of marketsWithUnsettledPredictions) {
    try {
      const response = await axios.get(`${POLYMARKET_API}/markets/${market.polymarketId}`, {
        timeout: 10000
      });

      const polymarket: PolymarketMarket = response.data;

      if (polymarket.resolved) {
        let outcome: MarketOutcome | null = null;
        if (polymarket.resolution === 'YES' || polymarket.resolution === '0') {
          outcome = 'YES';
        } else if (polymarket.resolution === 'NO' || polymarket.resolution === '1') {
          outcome = 'NO';
        }

        if (outcome) {
          // Update market status in our database
          await prisma.market.update({
            where: { id: market.id },
            data: {
              status: 'RESOLVED',
              outcome,
              resolutionDate: polymarket.resolutionDate ? new Date(polymarket.resolutionDate) : new Date(),
              lastSyncedAt: new Date()
            }
          });

          console.log(`  Market ${market.polymarketId} resolved as ${outcome}`);

          // Trigger settlement (we'll implement this in the settlement service)
          // await settleMarketPredictions(market.id);
        }
      }
    } catch (error) {
      console.error(`  Error checking market ${market.polymarketId}:`, error);
    }
  }
}

/**
 * Get a single market from Polymarket by ID
 * Useful for getting fresh data before placing a bet
 */
export async function getMarketFromPolymarket(polymarketId: string): Promise<PolymarketMarket | null> {
  try {
    const response = await axios.get(`${POLYMARKET_API}/markets/${polymarketId}`, {
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching market ${polymarketId}:`, error);
    return null;
  }
}

/**
 * Search markets on Polymarket
 */
export async function searchPolymarketMarkets(query: string): Promise<PolymarketMarket[]> {
  try {
    const response = await axios.get(`${POLYMARKET_API}/markets`, {
      params: {
        search: query,
        active: true,
        limit: 20
      },
      timeout: 10000
    });

    return response.data?.data || response.data?.markets || response.data || [];
  } catch (error) {
    console.error('Error searching markets:', error);
    return [];
  }
}
