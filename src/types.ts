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
  { id: 's1', name: 'Mustard', type: 'suspect' },
  { id: 's2', name: 'Orchid', type: 'suspect' },
  { id: 's3', name: 'Green', type: 'suspect' },
  { id: 's4', name: 'Scarlett', type: 'suspect' },
  { id: 's5', name: 'Peacock', type: 'suspect' },
  { id: 's6', name: 'Plum', type: 'suspect' },
  { id: 'w1', name: 'Candlestick', type: 'weapon' },
  { id: 'w2', name: 'Dagger', type: 'weapon' },
  { id: 'w3', name: 'Lead pipe', type: 'weapon' },
  { id: 'w4', name: 'Revolver', type: 'weapon' },
  { id: 'w5', name: 'Rope', type: 'weapon' },
  { id: 'w6', name: 'Wrench', type: 'weapon' },
  { id: 'r1', name: 'Ballroom', type: 'room' },
  { id: 'r2', name: 'Billiard Room', type: 'room' },
  { id: 'r3', name: 'Conservatory', type: 'room' },
  { id: 'r4', name: 'Dining Room', type: 'room' },
  { id: 'r5', name: 'Hall', type: 'room' },
  { id: 'r6', name: 'Kitchen', type: 'room' },
  { id: 'r7', name: 'Library', type: 'room' },
  { id: 'r8', name: 'Lounge', type: 'room' },
  { id: 'r9', name: 'Study', type: 'room' },
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

