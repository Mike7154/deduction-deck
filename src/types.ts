export type CardType = 'suspect' | 'weapon' | 'room'
export type LocationId = 'envelope' | string
export type Mark = 'unknown' | 'yes' | 'no'

export type Card = { id: string; name: string; type: CardType }
export type Player = { id: string; name: string; cardCount: number; turnOrder: number; isMe?: boolean }

export type SuggestionResult =
  | { kind: 'unresolved' }
  | { kind: 'nobody' }
  | { kind: 'unknown'; disproverId: string }
  | { kind: 'shown'; disproverId: string; shownCardId: string }

export type Suggestion = {
  id: string
  suggesterId: string
  cardIds: [string, string, string]
  result: SuggestionResult
  createdAt: number
  disabled?: boolean
}

export type GameState = {
  cards: Card[]
  players: Player[]
  marks: Record<string, Record<LocationId, Mark>>
  suggestions: Suggestion[]
  behaviorOptIn: boolean
  activeSuggesterId: string
}

export type BehaviorCardStat = {
  suggested: number
  held: number
  byPhase: Record<string, { suggested: number; held: number }>
}

export type BehaviorStats = Record<string, BehaviorCardStat>

export const defaultCards: Card[] = [
  { id: 'mustard', name: 'Mustard', type: 'suspect' },
  { id: 'orchid', name: 'Orchid', type: 'suspect' },
  { id: 'green', name: 'Green', type: 'suspect' },
  { id: 'scarlett', name: 'Scarlett', type: 'suspect' },
  { id: 'peacock', name: 'Peacock', type: 'suspect' },
  { id: 'plum', name: 'Plum', type: 'suspect' },
  { id: 'candlestick', name: 'Candlestick', type: 'weapon' },
  { id: 'dagger', name: 'Dagger', type: 'weapon' },
  { id: 'lead-pipe', name: 'Lead pipe', type: 'weapon' },
  { id: 'revolver', name: 'Revolver', type: 'weapon' },
  { id: 'rope', name: 'Rope', type: 'weapon' },
  { id: 'wrench', name: 'Wrench', type: 'weapon' },
  { id: 'ballroom', name: 'Ballroom', type: 'room' },
  { id: 'billiard-room', name: 'Billiard Room', type: 'room' },
  { id: 'conservatory', name: 'Conservatory', type: 'room' },
  { id: 'dining-room', name: 'Dining Room', type: 'room' },
  { id: 'hall', name: 'Hall', type: 'room' },
  { id: 'kitchen', name: 'Kitchen', type: 'room' },
  { id: 'library', name: 'Library', type: 'room' },
  { id: 'lounge', name: 'Lounge', type: 'room' },
  { id: 'study', name: 'Study', type: 'room' },
]

export const defaultPlayers: Player[] = [
  { id: 'p1', name: 'Mustard', cardCount: 3, turnOrder: 1, isMe: true },
  { id: 'p2', name: 'Orchid', cardCount: 3, turnOrder: 2 },
  { id: 'p3', name: 'Green', cardCount: 3, turnOrder: 3 },
  { id: 'p4', name: 'Scarlett', cardCount: 3, turnOrder: 4 },
  { id: 'p5', name: 'Peacock', cardCount: 3, turnOrder: 5 },
  { id: 'p6', name: 'Plum', cardCount: 3, turnOrder: 6 },
]

export function createBlankMarks(cards = defaultCards, players = defaultPlayers) {
  const marks: GameState['marks'] = {}
  for (const card of cards) {
    marks[card.id] = { envelope: 'unknown' }
    for (const player of players) marks[card.id][player.id] = 'unknown'
  }
  return marks
}

export function createDefaultGame(): GameState {
  return {
    cards: defaultCards,
    players: defaultPlayers,
    marks: createBlankMarks(),
    suggestions: [],
    behaviorOptIn: true,
    activeSuggesterId: defaultPlayers[0].id,
  }
}

export const typeLabel: Record<CardType, string> = {
  suspect: 'Suspects',
  weapon: 'Weapons',
  room: 'Rooms',
}

