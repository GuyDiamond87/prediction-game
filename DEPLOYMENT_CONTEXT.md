# Deployment Context - Prediction Game

**Last Updated:** January 26, 2026

## What We've Built

A competitive prediction game ("The Pit") with:
- **Battle System**: Draft-style market picking with real-time WebSocket gameplay
- **Polymarket Integration**: Markets synced from Polymarket
- **Solana Wallet Auth**: Users connect with Phantom/Solflare wallets
- **Points System**: 1000 starting points, wager on predictions and battles

## Current Architecture

### Backend
- **Location**: `/Users/julianvasil/prediction-game/backend`
- **GitHub**: `https://github.com/GuyDiamond87/prediction-game.git`
- **Stack**: Express + Prisma + Socket.IO + TypeScript
- **Database**: PostgreSQL on Railway
  - Connection: `postgresql://postgres:jLQweBNaNkhVvEWrxUHLXNWgNKdGuJii@shuttle.proxy.rlwy.net:33049/railway`

### Frontend
- **Location**: `/Users/julianvasil/frontend`
- **GitHub**: Needs to be created (see deployment steps below)
- **Stack**: React 19 + Vite + TailwindCSS + Socket.IO Client + Zustand

## Recent Changes Made

1. **Battle Draft System** - Alternating picks, 60s timer, tiebreaker phase
2. **Real-time WebSocket** - Socket.IO for battle rooms
3. **Modal Popups** - Improved UX for market picks (no more scrolling to bottom)
4. **Bug Fixes**:
   - Fixed comma-separated status filter in battle routes
   - Fixed missing player IDs in socket state
   - Fixed undefined opponent crashes
   - Added safety checks throughout BattleRoom.tsx

## Deployment Status

### Completed:
- [x] Backend code committed and pushed to GitHub
- [x] Frontend initialized as git repo with initial commit
- [x] Build scripts updated for deployment (`prisma generate` added)
- [x] .gitignore files configured (excluding .env files)

### Next Steps:

#### 1. Create Frontend GitHub Repo
```bash
# Go to https://github.com/new and create "prediction-game-frontend"
# Then run:
cd /Users/julianvasil/frontend
git remote add origin https://github.com/GuyDiamond87/prediction-game-frontend.git
git push -u origin main
```

#### 2. Deploy Backend to Railway
1. Go to https://railway.app
2. New Project → Deploy from GitHub Repo
3. Select `prediction-game` repo
4. **Set Root Directory to `backend`**
5. Add environment variables:
   - `DATABASE_URL` = (your Railway PostgreSQL URL)
   - `FRONTEND_URL` = (update after frontend deployed)
   - `NODE_ENV` = `production`

#### 3. Deploy Frontend to Vercel
1. Go to https://vercel.com
2. Import `prediction-game-frontend` repo
3. Add environment variables:
   - `VITE_API_URL` = `https://[your-railway-url].up.railway.app/api`
   - `VITE_SOLANA_NETWORK` = `mainnet-beta`

#### 4. Update Backend CORS
- Set `FRONTEND_URL` in Railway to your Vercel URL

## Key Files Modified

### Backend:
- `backend/package.json` - Added `postinstall` and updated build script
- `backend/src/services/battleSocket.ts` - New file for WebSocket handling
- `backend/src/services/battles.ts` - Draft logic
- `backend/src/routes/battles.ts` - Fixed status filter

### Frontend:
- `src/components/battle/BattleRoom.tsx` - Added modal popups for picks
- `src/api/users.ts` - Fixed API response format
- `src/hooks/useBattleSocket.ts` - WebSocket client hook

## Local Development

To run locally:

**Terminal 1 - Backend:**
```bash
cd /Users/julianvasil/prediction-game/backend
npm run dev
```

**Terminal 2 - Frontend:**
```bash
cd /Users/julianvasil/frontend
npm run dev
```

Frontend runs on http://localhost:5174
Backend runs on http://localhost:3001

## Environment Variables Needed

### Backend (.env):
```
DATABASE_URL="postgresql://postgres:jLQweBNaNkhVvEWrxUHLXNWgNKdGuJii@shuttle.proxy.rlwy.net:33049/railway"
FRONTEND_URL="http://localhost:5174"
NODE_ENV="development"
```

### Frontend (.env):
```
VITE_API_URL=http://localhost:3001/api
VITE_SOLANA_NETWORK=mainnet-beta
```

For production, update these URLs to your Railway/Vercel domains.
