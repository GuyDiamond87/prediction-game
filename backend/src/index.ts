/**
 * Main entry point for the Prediction Game backend
 *
 * This file:
 * 1. Sets up the Express server
 * 2. Connects to the database
 * 3. Starts background jobs (market sync, ELO decay, etc.)
 * 4. Mounts all API routes
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import cron from 'node-cron';

// Load environment variables from .env file
dotenv.config();

// Import routes (we'll create these as we build features)
import marketRoutes from './routes/markets';
import userRoutes from './routes/users';
import predictionRoutes from './routes/predictions';
import battleRoutes from './routes/battles';
import dailyChallengeRoutes from './routes/dailyChallenges';
import tournamentRoutes from './routes/tournaments';

// Import services
import { syncMarketsFromPolymarket } from './services/polymarket';
import { checkAndSettleResolvedMarkets } from './services/settlement';
import { batchCheckTokenStatus } from './services/token';
import { runEloDecay } from './services/decay';
import {
  processMatchmakingQueue,
  expandMatchmakingRanges,
  cleanupExpiredBattles,
  checkAndResolveBattles
} from './services/battles';
import {
  generateDailyChallenge,
  checkAndResolveDailyChallenges,
  deactivateOldChallenges
} from './services/dailyChallenge';
import { processTournamentLifecycle } from './services/tournaments';

// Initialize Prisma (database client)
export const prisma = new PrismaClient();

// Initialize Express app
const app = express();

// Middleware
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:3000'
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(allowed => origin.startsWith(allowed))) {
      return callback(null, true);
    }
    callback(null, false);
  },
  credentials: true
}));
app.use(express.json());

// Health check endpoint - useful for monitoring
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// API Routes
app.use('/api/markets', marketRoutes);
app.use('/api/users', userRoutes);
app.use('/api/predictions', predictionRoutes);
app.use('/api/battles', battleRoutes);
app.use('/api/daily-challenges', dailyChallengeRoutes);
app.use('/api/tournaments', tournamentRoutes);

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err.message);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
const PORT = process.env.PORT || 3001;

async function startServer() {
  try {
    // Test database connection
    await prisma.$connect();
    console.log('✅ Connected to database');

    // Start the Express server
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`   Health check: http://localhost:${PORT}/health`);
    });

    // Run initial market sync
    console.log('🔄 Running initial market sync from Polymarket...');
    await syncMarketsFromPolymarket();
    console.log('✅ Initial market sync complete');

    // Schedule background jobs
    setupBackgroundJobs();

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

/**
 * Set up recurring background jobs using cron
 */
function setupBackgroundJobs() {
  // Sync markets from Polymarket every 15 minutes
  // Cron format: minute hour day month weekday
  // "*/15 * * * *" = every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    console.log('🔄 [Cron] Syncing markets from Polymarket...');
    try {
      await syncMarketsFromPolymarket();
      console.log('✅ [Cron] Market sync complete');
    } catch (error) {
      console.error('❌ [Cron] Market sync failed:', error);
    }
  });

  // Check for resolved markets every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    console.log('🔄 [Cron] Checking for resolved markets...');
    try {
      await checkAndSettleResolvedMarkets();
      console.log('✅ [Cron] Resolution check complete');
    } catch (error) {
      console.error('❌ [Cron] Resolution check failed:', error);
    }
  });

  // Check token holder status every hour
  cron.schedule('0 * * * *', async () => {
    console.log('🔄 [Cron] Checking token holder statuses...');
    try {
      await batchCheckTokenStatus(50);
      console.log('✅ [Cron] Token status check complete');
    } catch (error) {
      console.error('❌ [Cron] Token status check failed:', error);
    }
  });

  // ELO decay check daily at midnight UTC
  cron.schedule('0 0 * * *', async () => {
    console.log('🔄 [Cron] Running ELO decay...');
    try {
      await runEloDecay();
      console.log('✅ [Cron] ELO decay complete');
    } catch (error) {
      console.error('❌ [Cron] ELO decay failed:', error);
    }
  });

  // Reset weekly prediction counts every Monday at midnight UTC
  cron.schedule('0 0 * * 1', async () => {
    console.log('🔄 [Cron] Resetting weekly prediction counts...');
    try {
      await prisma.user.updateMany({
        data: { predictionsThisWeek: 0 }
      });
      console.log('✅ [Cron] Weekly reset complete');
    } catch (error) {
      console.error('❌ [Cron] Weekly reset failed:', error);
    }
  });

  // ==========================================
  // BATTLES
  // ==========================================

  // Process matchmaking queue every 10 seconds
  cron.schedule('*/10 * * * * *', async () => {
    try {
      const matches = await processMatchmakingQueue();
      if (matches > 0) {
        console.log(`🎮 [Cron] Created ${matches} matched battles`);
      }
    } catch (error) {
      console.error('❌ [Cron] Matchmaking failed:', error);
    }
  });

  // Expand matchmaking ranges every 30 seconds
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await expandMatchmakingRanges();
    } catch (error) {
      console.error('❌ [Cron] Matchmaking range expansion failed:', error);
    }
  });

  // Cleanup expired battles every hour
  cron.schedule('0 * * * *', async () => {
    console.log('🔄 [Cron] Cleaning up expired battles...');
    try {
      const cleaned = await cleanupExpiredBattles();
      if (cleaned > 0) {
        console.log(`✅ [Cron] Cleaned up ${cleaned} expired battles`);
      }
    } catch (error) {
      console.error('❌ [Cron] Battle cleanup failed:', error);
    }
  });

  // Check and resolve completed battles every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      const resolved = await checkAndResolveBattles();
      if (resolved > 0) {
        console.log(`✅ [Cron] Resolved ${resolved} battles`);
      }
    } catch (error) {
      console.error('❌ [Cron] Battle resolution failed:', error);
    }
  });

  // ==========================================
  // DAILY CHALLENGES
  // ==========================================

  // Generate daily challenge at midnight UTC
  cron.schedule('0 0 * * *', async () => {
    console.log('🔄 [Cron] Generating daily challenge...');
    try {
      await deactivateOldChallenges();
      await generateDailyChallenge();
      console.log('✅ [Cron] Daily challenge generated');
    } catch (error) {
      console.error('❌ [Cron] Daily challenge generation failed:', error);
    }
  });

  // Check and resolve daily challenges every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      const resolved = await checkAndResolveDailyChallenges();
      if (resolved > 0) {
        console.log(`✅ [Cron] Resolved ${resolved} daily challenges`);
      }
    } catch (error) {
      console.error('❌ [Cron] Daily challenge resolution failed:', error);
    }
  });

  // ==========================================
  // TOURNAMENTS
  // ==========================================

  // Process tournament lifecycle every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      const result = await processTournamentLifecycle();
      if (result.opened + result.started + result.cancelled + result.resolved > 0) {
        console.log(`🏆 [Cron] Tournaments: ${result.opened} opened, ${result.started} started, ${result.cancelled} cancelled, ${result.resolved} resolved`);
      }
    } catch (error) {
      console.error('❌ [Cron] Tournament lifecycle failed:', error);
    }
  });

  console.log('✅ Background jobs scheduled');
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});

// Start the server
startServer();
