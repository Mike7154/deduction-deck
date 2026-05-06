import type { Card, CardType, GameState, LocationId, Mark, Player, Suggestion } from './types'

export type SolverResult = {
  status: 'exact' | 'capped' | 'contradiction'
  worlds: number
  cappedAt: number
  probabilities: Record<string, Record<LocationId, number>>
  deductions: Array<{ cardId: string; locationId: LocationId; mark: 'yes' | 'no'; reason: string }>
  envelopePick: Record<CardType, { cardId: string; probability: number } | null>
  messages: string[]
}

type Clause = { playerId: string; cardIds: string[]; kind: 'atLeastOne' }
type NoFact = { playerId: string; cardIds: string[] }


function orderedPlayers(players: Player[]) {
  return [...players].sort((a, b) => a.turnOrder - b.turnOrder)
}

function playersBetween(players: Player[], fromId: string, toId?: string) {
  const ordered = orderedPlayers(players)
  const start = ordered.findIndex((p) => p.id === fromId)
  if (start < 0) return []
  const out: Player[] = []
  for (let step = 1; step < ordered.length; step++) {
    const p = ordered[(start + step) % ordered.length]
    if (toId && p.id === toId) break
    out.push(p)
  }
  return out
}

function suggestionFacts(players: Player[], suggestions: Suggestion[]) {
  const noFacts: NoFact[] = []
  const clauses: Clause[] = []
  const yesFacts: Array<{ playerId: string; cardId: string }> = []

  for (const s of suggestions) {
    if (s.result.kind === 'unresolved') continue
    if (s.result.kind === 'nobody') {
      for (const p of playersBetween(players, s.suggesterId)) noFacts.push({ playerId: p.id, cardIds: [...s.cardIds] })
    }
    if (s.result.kind === 'unknown') {
      for (const p of playersBetween(players, s.suggesterId, s.result.disproverId)) noFacts.push({ playerId: p.id, cardIds: [...s.cardIds] })
      clauses.push({ playerId: s.result.disproverId, cardIds: [...s.cardIds], kind: 'atLeastOne' })
    }
    if (s.result.kind === 'shown') {
      for (const p of playersBetween(players, s.suggesterId, s.result.disproverId)) noFacts.push({ playerId: p.id, cardIds: [...s.cardIds] })
      yesFacts.push({ playerId: s.result.disproverId, cardId: s.result.shownCardId })
    }
  }
  return { noFacts, clauses, yesFacts }
}

function emptyProbabilities(cards: Card[], locations: LocationId[]) {
  const probs: Record<string, Record<LocationId, number>> = {}
  for (const card of cards) {
    probs[card.id] = {}
    for (const loc of locations) probs[card.id][loc] = 0
  }
  return probs
}

function forcedLocation(marks: Record<LocationId, Mark>) {
  const yes = Object.entries(marks).filter(([, mark]) => mark === 'yes')
  return yes.length === 1 ? yes[0][0] : yes.length > 1 ? '__conflict__' : null
}

export function solveGame(game: GameState, maxWorlds = 250_000): SolverResult {
  const locations: LocationId[] = ['envelope', ...game.players.map((p) => p.id)]
  const counts = Object.fromEntries(game.players.map((p) => [p.id, p.cardCount])) as Record<string, number>
  const remaining = { ...counts }
  const envelopeRemaining: Record<CardType, number> = { suspect: 1, weapon: 1, room: 1 }
  const assignment: Record<string, LocationId> = {}
  const probabilities = emptyProbabilities(game.cards, locations)
  const messages: string[] = []
  const { noFacts, clauses, yesFacts } = suggestionFacts(game.players, game.suggestions)

  const hardMarks: GameState['marks'] = structuredClone(game.marks)
  for (const no of noFacts) for (const cardId of no.cardIds) hardMarks[cardId][no.playerId] = hardMarks[cardId][no.playerId] === 'yes' ? 'yes' : 'no'
  for (const yes of yesFacts) hardMarks[yes.cardId][yes.playerId] = 'yes'

  for (const card of game.cards) {
    const f = forcedLocation(hardMarks[card.id])
    if (f === '__conflict__') return contradiction(game, maxWorlds, 'A card is marked yes in more than one location.')
    if (f) {
      assignment[card.id] = f
      if (f === 'envelope') envelopeRemaining[card.type] -= 1
      else remaining[f] -= 1
      if ((f === 'envelope' && envelopeRemaining[card.type] < 0) || (f !== 'envelope' && remaining[f] < 0)) {
        return contradiction(game, maxWorlds, 'Known yes facts exceed an envelope or player card-count limit.')
      }
    }
  }

  const allowedFor = (card: Card): LocationId[] => {
    if (assignment[card.id]) return [assignment[card.id]]
    return locations.filter((loc) => hardMarks[card.id][loc] !== 'no')
  }

  const cardsToAssign = game.cards
    .filter((c) => !assignment[c.id])
    .sort((a, b) => allowedFor(a).length - allowedFor(b).length)

  let worlds = 0
  let capped = false

  const possibleClause = (clause: Clause) => clause.cardIds.some((cardId) => assignment[cardId] === clause.playerId || (!assignment[cardId] && allowedFor(game.cards.find((c) => c.id === cardId)!).includes(clause.playerId)))
  const satisfiedClause = (clause: Clause) => clause.cardIds.some((cardId) => assignment[cardId] === clause.playerId)

  function canFinishCounts(index: number) {
    const unassigned = cardsToAssign.slice(index)
    for (const p of game.players) {
      if (remaining[p.id] < 0) return false
      const possible = unassigned.filter((c) => allowedFor(c).includes(p.id)).length
      if (possible < remaining[p.id]) return false
    }
    for (const t of Object.keys(envelopeRemaining) as CardType[]) {
      if (envelopeRemaining[t] < 0) return false
      const possible = unassigned.filter((c) => c.type === t && allowedFor(c).includes('envelope')).length
      if (possible < envelopeRemaining[t]) return false
    }
    return true
  }

  function isAllowed(card: Card, loc: LocationId) {
    if (hardMarks[card.id][loc] === 'no') return false
    if (loc === 'envelope') return envelopeRemaining[card.type] > 0
    return remaining[loc] > 0
  }

  function recordWorld() {
    worlds++
    for (const card of game.cards) probabilities[card.id][assignment[card.id]] += 1
  }

  function recurse(index: number) {
    if (capped) return
    if (worlds >= maxWorlds) {
      capped = true
      return
    }
    if (!canFinishCounts(index)) return
    if (clauses.some((clause) => !possibleClause(clause))) return
    if (index === cardsToAssign.length) {
      if (Object.values(remaining).some((n) => n !== 0)) return
      if (Object.values(envelopeRemaining).some((n) => n !== 0)) return
      if (clauses.some((clause) => !satisfiedClause(clause))) return
      recordWorld()
      return
    }
    const card = cardsToAssign[index]
    const options = allowedFor(card).sort((a, b) => {
      if (a === 'envelope') return -1
      if (b === 'envelope') return 1
      return (remaining[b] ?? 0) - (remaining[a] ?? 0)
    })
    for (const loc of options) {
      if (!isAllowed(card, loc)) continue
      assignment[card.id] = loc
      if (loc === 'envelope') envelopeRemaining[card.type] -= 1
      else remaining[loc] -= 1
      recurse(index + 1)
      if (loc === 'envelope') envelopeRemaining[card.type] += 1
      else remaining[loc] += 1
      delete assignment[card.id]
      if (capped) return
    }
  }

  recurse(0)

  if (worlds === 0) return contradiction(game, maxWorlds, 'No valid deals match the current evidence.')
  for (const card of game.cards) for (const loc of locations) probabilities[card.id][loc] /= worlds

  const deductions: SolverResult['deductions'] = []
  for (const card of game.cards) {
    for (const loc of locations) {
      const p = probabilities[card.id][loc]
      if (p === 1 && game.marks[card.id][loc] !== 'yes') deductions.push({ cardId: card.id, locationId: loc, mark: 'yes', reason: 'True in every valid deal.' })
      if (p === 0 && game.marks[card.id][loc] === 'unknown') deductions.push({ cardId: card.id, locationId: loc, mark: 'no', reason: 'Impossible in every valid deal.' })
    }
  }

  if (capped) messages.push(`Enumeration stopped at ${maxWorlds.toLocaleString()} valid deals; percentages are based on the first valid deals found. Add evidence for exact results.`)
  else messages.push(`Exact calculation across ${worlds.toLocaleString()} valid deals.`)

  const envelopePick = Object.fromEntries((['suspect', 'weapon', 'room'] as CardType[]).map((type) => {
    const cards = game.cards.filter((c) => c.type === type).map((c) => ({ cardId: c.id, probability: probabilities[c.id].envelope })).sort((a, b) => b.probability - a.probability)
    return [type, cards[0] ?? null]
  })) as SolverResult['envelopePick']

  return { status: capped ? 'capped' : 'exact', worlds, cappedAt: maxWorlds, probabilities, deductions, envelopePick, messages }
}

function contradiction(game: GameState, maxWorlds: number, message: string): SolverResult {
  return {
    status: 'contradiction',
    worlds: 0,
    cappedAt: maxWorlds,
    probabilities: emptyProbabilities(game.cards, ['envelope', ...game.players.map((p) => p.id)]),
    deductions: [],
    envelopePick: { suspect: null, weapon: null, room: null },
    messages: [message],
  }
}
