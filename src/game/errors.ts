/**
 * Game rule violations. Messages surface VERBATIM in the player's chat,
 * so every one of them must tell the player what to do instead.
 */

export type GameErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'NOT_IN_ROOM'
  | 'ALREADY_STARTED'
  | 'NOT_MODERATOR'
  | 'NOT_ENOUGH_PLAYERS'
  | 'TOO_MANY_PLAYERS'
  | 'WRONG_PHASE'
  | 'DEAD_PLAYER'
  | 'SPECTATOR'
  | 'WRONG_ROLE'
  | 'BAD_TARGET'
  | 'GAME_OVER'
  | 'NO_FEATURED_ROOM'
  | 'MANY_FEATURED_ROOMS'
  | 'CONFLICT';

export class GameError extends Error {
  readonly code: GameErrorCode;
  constructor(code: GameErrorCode, message: string) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

export function fail(code: GameErrorCode, message: string): never {
  throw new GameError(code, message);
}
