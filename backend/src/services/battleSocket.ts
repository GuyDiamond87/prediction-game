/**
 * Battle Socket Service
 *
 * Handles real-time WebSocket communication for battle rooms using Socket.IO.
 *
 * Events (Server → Client):
 * - battle:playerJoined - Opponent joined the battle
 * - battle:draftStarted - Coin flip result, draft begins
 * - battle:pickMade - A pick was made (market, prediction, who)
 * - battle:turnChanged - Whose turn + deadline
 * - battle:pickTimeout - Random market was assigned due to timeout
 * - battle:tiebreakerPhase - Time for tiebreaker market selection
 * - battle:tiebreakerPrediction - Both players need to predict on tiebreaker
 * - battle:draftComplete - Draft finished, battle now active
 * - battle:resolved - Final results
 * - battle:error - Error message
 *
 * Events (Client → Server):
 * - battle:join - Join a battle room
 * - battle:ready - Player ready to start draft
 * - battle:pick - Make a draft pick
 * - battle:tiebreakerPick - Pick tiebreaker market (coin flip loser)
 * - battle:tiebreakerPredict - Submit tiebreaker prediction
 * - battle:leave - Leave battle room
 */

import { Server, Socket } from 'socket.io';
import { prisma } from '../index';
import {
  startDraft,
  makePick,
  makeTiebreakerPick,
  submitTiebreakerPrediction,
  getAvailableMarkets,
  PICK_TIMEOUT_SECONDS
} from './battles';

// Track which users are in which battle rooms
// battleId -> Set of socket IDs
const battleRooms = new Map<string, Set<string>>();

// Track socket to user mapping
// socketId -> { odId, odWallet }
const socketUsers = new Map<string, { odId: string; battleId: string }>();

// Track ready status for draft start
// battleId -> Set of user IDs who are ready
const readyPlayers = new Map<string, Set<string>>();

let io: Server;

/**
 * Initialize Socket.IO with the HTTP server
 */
export function initBattleSocket(socketIoServer: Server): void {
  io = socketIoServer;

  io.on('connection', (socket: Socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Handle joining a battle room
    socket.on('battle:join', async (data: { battleId: string; walletAddress: string }) => {
      try {
        const { battleId, walletAddress } = data;

        // Verify user exists and is part of this battle
        const user = await prisma.user.findUnique({
          where: { walletAddress }
        });

        if (!user) {
          socket.emit('battle:error', { message: 'User not found' });
          return;
        }

        const battle = await prisma.battle.findUnique({
          where: { id: battleId },
          include: {
            player1: { select: { id: true, walletAddress: true, displayName: true, elo: true } },
            player2: { select: { id: true, walletAddress: true, displayName: true, elo: true } }
          }
        });

        if (!battle) {
          socket.emit('battle:error', { message: 'Battle not found' });
          return;
        }

        // Check if user is part of this battle
        if (battle.player1Id !== user.id && battle.player2Id !== user.id) {
          socket.emit('battle:error', { message: 'You are not part of this battle' });
          return;
        }

        // Join the socket room
        socket.join(battleId);

        // Track this socket
        if (!battleRooms.has(battleId)) {
          battleRooms.set(battleId, new Set());
        }
        battleRooms.get(battleId)!.add(socket.id);
        socketUsers.set(socket.id, { odId: user.id, battleId });

        // Notify room that player joined
        const playerNumber = battle.player1Id === user.id ? 1 : 2;
        socket.to(battleId).emit('battle:playerJoined', {
          odId: user.id,
          displayName: user.displayName || walletAddress.slice(0, 8),
          playerNumber
        });

        // Send current battle state to the joining player
        socket.emit('battle:state', await getBattleState(battleId, user.id));

        console.log(`User ${user.id} joined battle room ${battleId}`);

      } catch (error) {
        console.error('Error joining battle room:', error);
        socket.emit('battle:error', { message: 'Failed to join battle room' });
      }
    });

    // Handle player ready for draft
    socket.on('battle:ready', async (data: { battleId: string }) => {
      try {
        const { battleId } = data;
        const socketData = socketUsers.get(socket.id);

        if (!socketData || socketData.battleId !== battleId) {
          socket.emit('battle:error', { message: 'Not in this battle room' });
          return;
        }

        const battle = await prisma.battle.findUnique({
          where: { id: battleId }
        });

        if (!battle || battle.status !== 'OPEN') {
          socket.emit('battle:error', { message: 'Battle not ready for draft' });
          return;
        }

        // Both players must have joined
        if (!battle.player1Id || !battle.player2Id) {
          socket.emit('battle:error', { message: 'Waiting for opponent to join' });
          return;
        }

        // Track ready status
        if (!readyPlayers.has(battleId)) {
          readyPlayers.set(battleId, new Set());
        }
        readyPlayers.get(battleId)!.add(socketData.odId);

        // Notify room of ready status
        io.to(battleId).emit('battle:playerReady', { odId: socketData.odId });

        // Check if both players are ready
        const ready = readyPlayers.get(battleId)!;
        if (ready.has(battle.player1Id) && ready.has(battle.player2Id)) {
          // Start the draft!
          const draftResult = await startDraft(battleId);

          // Clear ready status
          readyPlayers.delete(battleId);

          // Notify both players
          io.to(battleId).emit('battle:draftStarted', {
            coinFlipWinnerId: draftResult.coinFlipWinnerId,
            firstPickerId: draftResult.firstPickerId,
            currentPickDeadline: draftResult.currentPickDeadline
          });
        }

      } catch (error: any) {
        console.error('Error handling ready:', error);
        socket.emit('battle:error', { message: error.message || 'Failed to ready up' });
      }
    });

    // Handle making a draft pick
    socket.on('battle:pick', async (data: { battleId: string; marketId: string; prediction: 'YES' | 'NO' }) => {
      try {
        const { battleId, marketId, prediction } = data;
        const socketData = socketUsers.get(socket.id);

        if (!socketData || socketData.battleId !== battleId) {
          socket.emit('battle:error', { message: 'Not in this battle room' });
          return;
        }

        // Make the pick
        const result = await makePick(battleId, socketData.odId, marketId, prediction);

        // Get market details for broadcast
        const market = await prisma.market.findUnique({
          where: { id: marketId },
          select: { id: true, question: true, category: true, yesPrice: true, noPrice: true }
        });

        // Broadcast the pick to all players in the room
        io.to(battleId).emit('battle:pickMade', {
          pickNumber: result.pickNumber,
          pickerId: socketData.odId,
          marketId,
          market,
          prediction,
          wasTimeout: false
        });

        // Check if draft is complete
        if (result.draftComplete) {
          if (result.needsTiebreaker) {
            // Move to tiebreaker phase
            io.to(battleId).emit('battle:tiebreakerPhase', {
              tiebreakerPickerId: result.tiebreakerPickerId,
              deadline: result.tiebreakerDeadline
            });
          } else {
            // Draft complete, battle goes active
            io.to(battleId).emit('battle:draftComplete', {
              status: 'ACTIVE',
              message: 'All picks made! Waiting for markets to resolve.'
            });
          }
        } else {
          // Notify turn change
          io.to(battleId).emit('battle:turnChanged', {
            currentPickPlayerId: result.nextPickerId,
            currentPickNumber: result.nextPickNumber,
            currentPickDeadline: result.nextDeadline
          });
        }

      } catch (error: any) {
        console.error('Error making pick:', error);
        socket.emit('battle:error', { message: error.message || 'Failed to make pick' });
      }
    });

    // Handle tiebreaker market pick (coin flip loser picks the market)
    socket.on('battle:tiebreakerPick', async (data: { battleId: string; marketId: string }) => {
      try {
        const { battleId, marketId } = data;
        const socketData = socketUsers.get(socket.id);

        if (!socketData || socketData.battleId !== battleId) {
          socket.emit('battle:error', { message: 'Not in this battle room' });
          return;
        }

        const result = await makeTiebreakerPick(battleId, socketData.odId, marketId);

        const market = await prisma.market.findUnique({
          where: { id: marketId },
          select: { id: true, question: true, category: true, yesPrice: true, noPrice: true }
        });

        // Notify all players that tiebreaker market is selected
        io.to(battleId).emit('battle:tiebreakerMarketSelected', {
          marketId,
          market,
          deadline: result.predictionDeadline
        });

        // Now both players need to predict
        io.to(battleId).emit('battle:tiebreakerPrediction', {
          message: 'Both players must predict YES or NO on the tiebreaker market',
          deadline: result.predictionDeadline
        });

      } catch (error: any) {
        console.error('Error picking tiebreaker:', error);
        socket.emit('battle:error', { message: error.message || 'Failed to pick tiebreaker' });
      }
    });

    // Handle tiebreaker prediction
    socket.on('battle:tiebreakerPredict', async (data: { battleId: string; prediction: 'YES' | 'NO' }) => {
      try {
        const { battleId, prediction } = data;
        const socketData = socketUsers.get(socket.id);

        if (!socketData || socketData.battleId !== battleId) {
          socket.emit('battle:error', { message: 'Not in this battle room' });
          return;
        }

        const result = await submitTiebreakerPrediction(battleId, socketData.odId, prediction);

        // Notify that this player submitted their prediction
        io.to(battleId).emit('battle:tiebreakerPredicted', {
          odId: socketData.odId,
          // Don't reveal prediction until both have submitted
        });

        if (result.bothSubmitted) {
          // Both players have submitted, draft is complete
          io.to(battleId).emit('battle:draftComplete', {
            status: 'ACTIVE',
            player1TiebreakerPick: result.player1Prediction,
            player2TiebreakerPick: result.player2Prediction,
            message: 'Draft complete! Waiting for markets to resolve.'
          });
        }

      } catch (error: any) {
        console.error('Error submitting tiebreaker prediction:', error);
        socket.emit('battle:error', { message: error.message || 'Failed to submit prediction' });
      }
    });

    // Handle leaving battle room
    socket.on('battle:leave', (data: { battleId: string }) => {
      handleLeave(socket, data.battleId);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      const socketData = socketUsers.get(socket.id);
      if (socketData) {
        handleLeave(socket, socketData.battleId);
      }
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });
}

/**
 * Handle a player leaving a battle room
 */
function handleLeave(socket: Socket, battleId: string): void {
  const socketData = socketUsers.get(socket.id);

  if (socketData && socketData.battleId === battleId) {
    socket.leave(battleId);

    const room = battleRooms.get(battleId);
    if (room) {
      room.delete(socket.id);
      if (room.size === 0) {
        battleRooms.delete(battleId);
      }
    }

    // Notify remaining players
    socket.to(battleId).emit('battle:playerLeft', { odId: socketData.odId });

    socketUsers.delete(socket.id);
  }
}

/**
 * Get current battle state for a player
 */
async function getBattleState(battleId: string, odId: string): Promise<any> {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: {
      player1: { select: { id: true, walletAddress: true, displayName: true, elo: true, rankTier: true } },
      player2: { select: { id: true, walletAddress: true, displayName: true, elo: true, rankTier: true } },
      picks: {
        include: {
          market: {
            select: { id: true, question: true, category: true, yesPrice: true, noPrice: true }
          }
        },
        orderBy: { pickNumber: 'asc' }
      },
      tiebreakerMarket: {
        select: { id: true, question: true, category: true, yesPrice: true, noPrice: true }
      }
    }
  });

  if (!battle) return null;

  // Filter picks - only show opponent's picks after draft complete
  const myPicks = battle.picks.filter(p => p.pickerId === odId);
  const opponentPicks = battle.status === 'ACTIVE' || battle.status === 'COMPLETED'
    ? battle.picks.filter(p => p.pickerId !== odId)
    : battle.picks.filter(p => p.pickerId !== odId).map(p => ({ ...p, prediction: undefined })); // Hide predictions during draft

  // Get available markets if in drafting phase and it's this player's turn
  let availableMarkets: any[] = [];
  if (battle.status === 'DRAFTING' && battle.currentPickPlayerId === odId) {
    availableMarkets = await getAvailableMarkets(battleId);
  }

  return {
    battle: {
      id: battle.id,
      player1Id: battle.player1Id,
      player2Id: battle.player2Id,
      status: battle.status,
      pointsStake: battle.pointsStake,
      shareCode: battle.shareCode,
      expiresAt: battle.expiresAt,
      player1: battle.player1,
      player2: battle.player2,
      coinFlipWinnerId: battle.coinFlipWinnerId,
      currentPickPlayerId: battle.currentPickPlayerId,
      currentPickNumber: battle.currentPickNumber,
      currentPickDeadline: battle.currentPickDeadline,
      tiebreakerMarket: battle.tiebreakerMarket,
      player1TiebreakerPick: battle.status === 'ACTIVE' || battle.status === 'COMPLETED'
        ? battle.player1TiebreakerPick : undefined,
      player2TiebreakerPick: battle.status === 'ACTIVE' || battle.status === 'COMPLETED'
        ? battle.player2TiebreakerPick : undefined,
      winnerId: battle.winnerId,
      player1Correct: battle.player1Correct,
      player2Correct: battle.player2Correct
    },
    myPicks,
    opponentPicks,
    availableMarkets,
    isMyTurn: battle.currentPickPlayerId === odId
  };
}

/**
 * Broadcast a timeout event to a battle room
 * Called from the cron job when a pick times out
 */
export async function broadcastPickTimeout(
  battleId: string,
  pickNumber: number,
  pickerId: string,
  marketId: string,
  prediction: 'YES' | 'NO',
  nextState: {
    nextPickerId?: string;
    nextPickNumber?: number;
    nextDeadline?: Date;
    draftComplete?: boolean;
    needsTiebreaker?: boolean;
    tiebreakerPickerId?: string;
  }
): Promise<void> {
  if (!io) return;

  const market = await prisma.market.findUnique({
    where: { id: marketId },
    select: { id: true, question: true, category: true, yesPrice: true, noPrice: true }
  });

  io.to(battleId).emit('battle:pickTimeout', {
    pickNumber,
    pickerId,
    marketId,
    market,
    prediction,
    wasTimeout: true
  });

  if (nextState.draftComplete) {
    if (nextState.needsTiebreaker) {
      io.to(battleId).emit('battle:tiebreakerPhase', {
        tiebreakerPickerId: nextState.tiebreakerPickerId
      });
    } else {
      io.to(battleId).emit('battle:draftComplete', {
        status: 'ACTIVE',
        message: 'All picks made! Waiting for markets to resolve.'
      });
    }
  } else if (nextState.nextPickerId) {
    io.to(battleId).emit('battle:turnChanged', {
      currentPickPlayerId: nextState.nextPickerId,
      currentPickNumber: nextState.nextPickNumber,
      currentPickDeadline: nextState.nextDeadline
    });
  }
}

/**
 * Broadcast battle resolution to players
 */
export function broadcastBattleResolved(
  battleId: string,
  result: {
    winnerId: string | null;
    player1Correct: number;
    player2Correct: number;
    tiebreakerWinnerId?: string;
    winnerPayout: number;
    rake: number;
  }
): void {
  if (!io) return;

  io.to(battleId).emit('battle:resolved', result);
}

/**
 * Get the Socket.IO server instance
 */
export function getIO(): Server | undefined {
  return io;
}
