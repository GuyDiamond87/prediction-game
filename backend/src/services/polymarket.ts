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
  outcomePrices: string[] | string; // Can be array or JSON string like "[\"0.65\", \"0.35\"]"

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

  // Events (contains series info with category hints)
  events?: Array<{
    title?: string;
    slug?: string;
    series?: Array<{
      title?: string;
      slug?: string;
    }>;
  }>;
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
// Map Polymarket data to our categories
function mapCategory(market: PolymarketMarket): string {
  // Combine all text sources for category inference
  const texts = [
    market.category,
    market.question,
    market.tags?.[0]?.label,
    market.events?.[0]?.title,
    market.events?.[0]?.slug,
    market.events?.[0]?.series?.[0]?.title,
    market.events?.[0]?.series?.[0]?.slug,
  ].filter(Boolean).join(' ').toLowerCase();

  // Sports - check first as many markets are sports
  if (texts.match(/\b(nfl|nba|mlb|nhl|soccer|football|basketball|baseball|hockey|tennis|golf|ufc|mma|boxing|f1|formula|racing|league|liga|premier|champions|world cup|olympics|sports?|game|match|win|score|team)\b/)) {
    return 'sports';
  }

  // Crypto
  if (texts.match(/\b(crypto|bitcoin|btc|ethereum|eth|solana|sol|defi|token|blockchain|binance|coinbase)\b/)) {
    return 'crypto';
  }

  // Politics
  if (texts.match(/\b(politic|election|president|trump|biden|democrat|republican|congress|senate|governor|vote|poll|cabinet|impeach|primary|nomination)\b/)) {
    return 'politics';
  }

  // Entertainment
  if (texts.match(/\b(entertainment|movie|film|music|album|grammy|oscar|emmy|celebrity|actor|actress|singer|netflix|disney|stream|box office|pop.?culture)\b/)) {
    return 'entertainment';
  }

  // Technology
  if (texts.match(/\b(tech|ai|artificial.?intelligence|openai|google|apple|microsoft|meta|amazon|software|startup|ipo|chip|semiconductor)\b/)) {
    return 'technology';
  }

  // Economics
  if (texts.match(/\b(econ|inflation|fed|federal.?reserve|interest.?rate|gdp|recession|stock|s&p|dow|nasdaq|treasury|unemployment|jobs.?report)\b/)) {
    return 'economics';
  }

  // Science
  if (texts.match(/\b(science|health|medical|fda|vaccine|virus|covid|corona|disease|drug|pharma|clinical|research|nasa|space|climate)\b/)) {
    return 'science';
  }

  return 'other';
}

async function upsertMarket(
  polymarket: PolymarketMarket,
  trendingVolumeThreshold: number
): Promise<'created' | 'updated' | 'skipped'> {
  // Parse prices - outcomePrices may be a JSON string like "[\"0.65\", \"0.35\"]"
  let pricesArray: string[] = [];
  if (typeof polymarket.outcomePrices === 'string') {
    try {
      pricesArray = JSON.parse(polymarket.outcomePrices);
    } catch {
      pricesArray = [];
    }
  } else if (Array.isArray(polymarket.outcomePrices)) {
    pricesArray = polymarket.outcomePrices;
  }

  let yesPrice = parseFloat(pricesArray[0] || '0.5');
  let noPrice = parseFloat(pricesArray[1] || '0.5');
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

  // Map category to our standard categories using all available data
  const category = mapCategory(polymarket);

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
