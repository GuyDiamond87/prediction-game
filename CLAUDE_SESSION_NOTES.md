# Prediction Game - Session Notes
> Last updated: January 18, 2026

## Project Location
`/Users/julianvasil/prediction-game`

## What This Project Is
A competitive prediction game where users:
- Connect Solana wallets to play
- Wager points on Polymarket prediction outcomes
- Compete via ELO rankings, head-to-head battles, tournaments
- Earn XP for airdrops (token holders get 2x XP, 10% payout bonus)

---

## Current State

### Backend (`/backend`) - COMPLETE ✅

**Structure:**
```
backend/
├── package.json
├── tsconfig.json
├── .env.example
├── prisma/
│   └── schema.prisma          # 17 models (User, Market, Prediction, Battle, etc.)
└── src/
    ├── index.ts               # Express server + cron jobs
    ├── routes/
    │   ├── markets.ts         # GET /api/markets, GET /api/markets/:id
    │   ├── users.ts           # POST /api/users/connect, GET /api/users/:wallet
    │   ├── predictions.ts     # POST /api/predictions, GET user predictions
    │   ├── battles.ts         # Create/join battles, matchmaking, predictions
    │   ├── dailyChallenges.ts # Daily pick'em challenges
    │   └── tournaments.ts     # Tournament registration, predictions, leaderboards
    ├── services/
    │   ├── polymarket.ts      # Syncs markets from Polymarket Gamma API
    │   ├── settlement.ts      # Settles predictions when markets resolve
    │   ├── token.ts           # Checks Solana token holder status
    │   ├── decay.ts           # Daily ELO decay for inactive players
    │   ├── battles.ts         # Battle logic, matchmaking, resolution
    │   ├── dailyChallenge.ts  # Daily challenge generation & resolution
    │   └── tournaments.ts     # Tournament lifecycle & prize distribution
    └── utils/
        ├── elo.ts             # ELO calculations, rank tiers, K-factors
        └── points.ts          # Payout calculations, XP, streak multipliers
```

**API Endpoints:**

Markets:
- `GET /api/markets` - List markets (filter by status, category)
- `GET /api/markets/:id` - Get market details

Users:
- `POST /api/users/connect` - Connect wallet / create user
- `GET /api/users/:wallet` - Get user profile & stats

Predictions:
- `POST /api/predictions` - Make a prediction
- `GET /api/predictions/user/:wallet` - User's predictions
- `GET /api/predictions/:id` - Prediction details
- `GET /api/predictions/market/:id` - Market predictions

Battles:
- `POST /api/battles` - Create a battle
- `POST /api/battles/:id/join` - Join by ID
- `POST /api/battles/join/:shareCode` - Join by share code
- `POST /api/battles/:id/cancel` - Cancel open battle
- `POST /api/battles/:id/predict` - Make battle prediction
- `GET /api/battles/:id` - Battle details
- `GET /api/battles/code/:shareCode` - Get by share code
- `GET /api/battles/user/:wallet` - User's battle history
- `POST /api/battles/matchmaking/join` - Join ranked queue
- `POST /api/battles/matchmaking/leave` - Leave queue
- `GET /api/battles/matchmaking/status` - Check queue status

Daily Challenges:
- `GET /api/daily-challenges/today` - Today's challenge
- `POST /api/daily-challenges/enter` - Enter challenge
- `POST /api/daily-challenges/predict` - Make prediction
- `GET /api/daily-challenges/leaderboard` - Today's leaderboard
- `GET /api/daily-challenges/:id` - Specific challenge
- `GET /api/daily-challenges/history/:wallet` - User history

Tournaments:
- `GET /api/tournaments` - List tournaments
- `GET /api/tournaments/active` - Active/upcoming tournaments
- `GET /api/tournaments/:id` - Tournament details
- `POST /api/tournaments/:id/register` - Register for tournament
- `POST /api/tournaments/:id/predict` - Make prediction
- `GET /api/tournaments/:id/leaderboard` - Leaderboard
- `GET /api/tournaments/user/:wallet` - User tournament history

**Cron Jobs (all wired up):**
- Every 15 min: Sync markets from Polymarket
- Every 5 min: Check & settle resolved markets
- Every 5 min: Resolve battles with completed markets
- Every 5 min: Process tournament lifecycle
- Every 15 min: Resolve daily challenges
- Every hour: Batch check token holder statuses
- Every hour: Cleanup expired battles
- Every 10 seconds: Process matchmaking queue
- Every 30 seconds: Expand matchmaking ranges
- Daily midnight: Run ELO decay, generate daily challenge
- Weekly Monday: Reset weekly prediction counts

**To run backend:**
```bash
cd /Users/julianvasil/prediction-game/backend
npm install
cp .env.example .env   # Edit with your PostgreSQL credentials
npm run db:generate
npm run db:push
npm run dev
```

---

### Frontend (`/frontend`) - NOT STARTED ❌

Directory structure exists but empty:
```
frontend/
└── src/
    ├── components/   # empty
    ├── contexts/     # empty
    ├── hooks/        # empty
    ├── pages/        # empty
    └── utils/        # empty
```

**Needs:**
- Vite + React + TypeScript setup
- Solana wallet adapter integration
- UI components for markets, predictions, leaderboard
- API client for backend

---

## Key Design Decisions

1. **Points System**: Users start with 1000 points, wager on predictions
2. **ELO Rating**: Chess-style with rank tiers (Bronze → Grandmaster)
3. **Token Holders**: Get 2x XP, 10% payout bonus, profile customization
4. **Streaks**: Consecutive wins give up to +20% payout bonus
5. **Decay**: Inactive players lose ELO after 7 days (max -25/week)

### Battles
- 10 markets per battle
- Share code for custom battles
- Matchmaking with ELO-based pairing
- Battles expire after 24 hours if not joined
- Winner takes pot minus small rake (5% custom, 2% ranked)

### Daily Challenges
- 5 markets per day, selected from trending markets
- Perfect score (5/5) awards 500 bonus points
- XP awarded per correct pick (token holders get 2x)
- Auto-generated at midnight UTC

### Tournaments
- Entry fee goes to prize pool
- 15 markets per tournament
- Top 30% of participants get prizes
- Minimum 5 participants to start

---

## Environment Variables Needed

```env
DATABASE_URL="postgresql://..."
PORT=3001
SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
TOKEN_MINT_ADDRESS=""           # Your pump.fun token mint
MIN_TOKEN_BALANCE="1"
FRONTEND_URL="http://localhost:5173"
POLYMARKET_API_URL="https://gamma-api.polymarket.com"
```

---

## Next Steps When Resuming

1. **Option A**: Start frontend (React + Vite + Solana wallet adapter)
2. **Option B**: Deploy backend (Railway, Render, etc.)
3. **Option C**: Add admin routes for creating tournaments manually

---

## Commands Reference

```bash
# Backend
cd /Users/julianvasil/prediction-game/backend
npm run dev          # Start dev server
npm run db:studio    # Open Prisma Studio (DB GUI)
npm run db:push      # Push schema changes to DB

# Test API
curl http://localhost:3001/health
curl http://localhost:3001/api/markets
curl http://localhost:3001/api/tournaments/active
curl http://localhost:3001/api/daily-challenges/today
```
