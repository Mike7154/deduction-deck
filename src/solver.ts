import type { Card, CardType, GameState, LocationId, Mark, Player, Suggestion } from './types'

export type SolverResult = {
  status: 'exact' | 'capped' | 'contradiction'
  worlds: number
  cappedAt: number
  probabilities: Record<string, Record<LocationId, number>>
  deductions: Array<{ cardId: string; locationId: LocationId; mark: 'yes' | 'no'; reason: string }>
  envelopePick: Record<CardType, { cardId: string; probability: number } | null>
  accusationProbability: number
  messages: string[]
}

type Clause = { playerId: string; cardIds: string[]; kind: 'atLeastOne' }
type AntiClause = { playerId: string; cardIds: string[]; kind: 'notAll' }
type SoftClause = { playerId: string; cardIds: string[]; penalty: number; reason: string }
type NoFact = { playerId: string; cardIds: string[] }
type CountResult = { worlds: bigint; counts: bigint[]; weightedWorlds: number; weightedCounts: number[] }


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
  const antiClauses: AntiClause[] = []
  const yesFacts: Array<{ playerId: string; cardId: string }> = []

  for (const s of suggestions) {
    if (s.disabled) continue
    antiClauses.push({ playerId: s.suggesterId, cardIds: [...s.cardIds], kind: 'notAll' })
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
  return { noFacts, clauses, antiClauses, yesFacts }
}

function repeatShownCardSoftClauses(cards: Card[], suggestions: Suggestion[]) {
  const cardType = Object.fromEntries(cards.map((card) => [card.id, card.type])) as Record<string, CardType>
  const active = suggestions.filter((s) => !s.disabled).sort((a, b) => a.createdAt - b.createdAt)
  const softClauses: SoftClause[] = []
  for (const [index, suggestion] of active.entries()) {
    if (suggestion.result.kind !== 'unknown') continue
    const laterBySamePlayer = active.slice(index + 1).filter((later) => later.suggesterId === suggestion.suggesterId)
    const repeated = new Set<string>()
    for (const later of laterBySamePlayer) for (const cardId of later.cardIds) if (suggestion.cardIds.includes(cardId)) repeated.add(cardId)
    if (!repeated.size) continue
    const alternatives = suggestion.cardIds.filter((cardId) => !repeated.has(cardId))
    if (!alternatives.length) continue
    const repeatsRoom = [...repeated].some((cardId) => cardType[cardId] === 'room')
    const repeatedPair = repeated.size >= 2
    softClauses.push({
      playerId: suggestion.result.disproverId,
      cardIds: alternatives,
      penalty: repeatedPair ? (repeatsRoom ? 0.08 : 0.02) : (repeatsRoom ? 0.15 : 0.05),
      reason: repeatedPair ? 'repeat-two-shown-cards' : 'repeat-shown-card',
    })
  }
  return softClauses
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
  const players = orderedPlayers(game.players)
  const locations: LocationId[] = ['envelope', ...players.map((p) => p.id)]
  const playerIndex = Object.fromEntries(players.map((p, i) => [p.id, i])) as Record<string, number>
  const locationIndex = Object.fromEntries(locations.map((loc, i) => [loc, i])) as Record<LocationId, number>
  const remaining = players.map((p) => p.cardCount)
  const envelopeRemaining: Record<CardType, number> = { suspect: 1, weapon: 1, room: 1 }
  const probabilities = emptyProbabilities(game.cards, locations)
  const messages: string[] = []
  const { noFacts, clauses, antiClauses, yesFacts } = suggestionFacts(players, game.suggestions)
  const softClauses = game.behaviorOptIn ? repeatShownCardSoftClauses(game.cards, game.suggestions) : []

  const hardMarks: GameState['marks'] = structuredClone(game.marks)
  for (const no of noFacts) for (const cardId of no.cardIds) hardMarks[cardId][no.playerId] = hardMarks[cardId][no.playerId] === 'yes' ? 'yes' : 'no'
  for (const yes of yesFacts) hardMarks[yes.cardId][yes.playerId] = 'yes'
  const clauseCardSets = clauses.map((clause) => new Set(clause.cardIds))
  const behavioralClauses = game.behaviorOptIn ? antiClauses : []
  const behavioralCardSets = behavioralClauses.map((clause) => new Set(clause.cardIds))
  const softCardSets = softClauses.map((clause) => new Set(clause.cardIds))
  const valueCount = game.cards.length * locations.length

  for (const card of game.cards) {
    const f = forcedLocation(hardMarks[card.id])
    if (f === '__conflict__') return contradiction(game, maxWorlds, 'A card is marked yes in more than one location.')
    if (f) {
      if (f === 'envelope') envelopeRemaining[card.type] -= 1
      else remaining[playerIndex[f]] -= 1
      if ((f === 'envelope' && envelopeRemaining[card.type] < 0) || (f !== 'envelope' && remaining[playerIndex[f]] < 0)) {
        return contradiction(game, maxWorlds, 'Known yes facts exceed an envelope or player card-count limit.')
      }
    }
  }

  const allowedFor = (card: Card): LocationId[] => {
    const forced = forcedLocation(hardMarks[card.id])
    if (forced && forced !== '__conflict__') return [forced]
    return locations.filter((loc) => hardMarks[card.id][loc] !== 'no')
  }

  const cardsToAssign = game.cards
    .filter((c) => !forcedLocation(hardMarks[c.id]))
    .sort((a, b) => allowedFor(a).length - allowedFor(b).length)

  let initialClauseMask = 0n
  for (const [clauseIndex, clause] of clauses.entries()) {
    if (clause.cardIds.some((cardId) => forcedLocation(hardMarks[cardId]) === clause.playerId)) initialClauseMask |= 1n << BigInt(clauseIndex)
  }

  let initialBehavioralMask = 0n
  for (const [clauseIndex, clause] of behavioralClauses.entries()) {
    if (clause.cardIds.some((cardId) => {
      const forced = forcedLocation(hardMarks[cardId])
      return forced && forced !== clause.playerId
    })) initialBehavioralMask |= 1n << BigInt(clauseIndex)
  }

  let initialSoftMask = 0n
  for (const [clauseIndex, clause] of softClauses.entries()) {
    if (clause.cardIds.some((cardId) => forcedLocation(hardMarks[cardId]) === clause.playerId)) initialSoftMask |= 1n << BigInt(clauseIndex)
  }

  function baseAllowedFor(card: Card): LocationId[] {
    return allowedFor(card)
  }

  function comboAllowedFor(forcedEnvelopeIds: Set<string>) {
    return (card: Card): LocationId[] => {
      if (!forcedEnvelopeIds.has(card.id)) return allowedFor(card)
      return allowedFor(card).includes('envelope') ? ['envelope'] : []
    }
  }

  function canFinishCounts(index: number, playerRemaining: number[], envelopeByType: Record<CardType, number>, allowed: (card: Card) => LocationId[]) {
    const unassigned = cardsToAssign.slice(index)
    for (const [i, p] of players.entries()) {
      if (playerRemaining[i] < 0) return false
      const possible = unassigned.filter((c) => allowed(c).includes(p.id)).length
      if (possible < playerRemaining[i]) return false
    }
    for (const t of Object.keys(envelopeByType) as CardType[]) {
      if (envelopeByType[t] < 0) return false
      const possible = unassigned.filter((c) => c.type === t && allowed(c).includes('envelope')).length
      if (possible < envelopeByType[t]) return false
    }
    return true
  }

  function possibleClauses(index: number, mask: bigint, allowed: (card: Card) => LocationId[]) {
    return clauses.every((clause, clauseIndex) => {
      if (mask & (1n << BigInt(clauseIndex))) return true
      return cardsToAssign.slice(index).some((card) => clauseCardSets[clauseIndex].has(card.id) && allowed(card).includes(clause.playerId))
    })
  }

  function possibleBehavioralClauses(index: number, mask: bigint, allowed: (card: Card) => LocationId[]) {
    return behavioralClauses.every((clause, clauseIndex) => {
      if (mask & (1n << BigInt(clauseIndex))) return true
      return cardsToAssign.slice(index).some((card) => behavioralCardSets[clauseIndex].has(card.id) && allowed(card).some((loc) => loc !== clause.playerId))
    })
  }

  const zeroResult = (): CountResult => ({ worlds: 0n, counts: Array<bigint>(valueCount).fill(0n), weightedWorlds: 0, weightedCounts: Array<number>(valueCount).fill(0) })

  function count(index: number, playerRemaining: number[], envelopeByType: Record<CardType, number>, mask: bigint, behavioralMask: bigint, softMask: bigint, memo: Map<string, CountResult>, allowed: (card: Card) => LocationId[]): CountResult {
    if (!canFinishCounts(index, playerRemaining, envelopeByType, allowed)) return zeroResult()
    if (!possibleClauses(index, mask, allowed)) return zeroResult()
    if (!possibleBehavioralClauses(index, behavioralMask, allowed)) return zeroResult()
    if (index === cardsToAssign.length) {
      if (playerRemaining.some((n) => n !== 0)) return zeroResult()
      if (Object.values(envelopeByType).some((n) => n !== 0)) return zeroResult()
      if (clauses.some((_, clauseIndex) => !(mask & (1n << BigInt(clauseIndex))))) return zeroResult()
      if (behavioralClauses.some((_, clauseIndex) => !(behavioralMask & (1n << BigInt(clauseIndex))))) return zeroResult()
      const base = zeroResult()
      base.worlds = 1n
      base.weightedWorlds = softClauses.reduce((weight, clause, clauseIndex) => weight * (softMask & (1n << BigInt(clauseIndex)) ? 1 : clause.penalty), 1)
      return base
    }

    const key = `${index}|${playerRemaining.join(',')}|${envelopeByType.suspect},${envelopeByType.weapon},${envelopeByType.room}|${mask}|${behavioralMask}|${softMask}`
    const cached = memo.get(key)
    if (cached) return cached

    const card = cardsToAssign[index]
    const total = zeroResult()
    for (const loc of allowed(card)) {
      if (loc === 'envelope' && envelopeByType[card.type] <= 0) continue
      if (loc !== 'envelope' && playerRemaining[playerIndex[loc]] <= 0) continue

      const nextPlayers = [...playerRemaining]
      const nextEnvelope = { ...envelopeByType }
      if (loc === 'envelope') nextEnvelope[card.type] -= 1
      else nextPlayers[playerIndex[loc]] -= 1

      let nextMask = mask
      for (const [clauseIndex, clause] of clauses.entries()) {
        if (loc === clause.playerId && clauseCardSets[clauseIndex].has(card.id)) nextMask |= 1n << BigInt(clauseIndex)
      }

      let nextBehavioralMask = behavioralMask
      for (const [clauseIndex, clause] of behavioralClauses.entries()) {
        if (loc !== clause.playerId && behavioralCardSets[clauseIndex].has(card.id)) nextBehavioralMask |= 1n << BigInt(clauseIndex)
      }

      let nextSoftMask = softMask
      for (const [clauseIndex, clause] of softClauses.entries()) {
        if (loc === clause.playerId && softCardSets[clauseIndex].has(card.id)) nextSoftMask |= 1n << BigInt(clauseIndex)
      }

      const child = count(index + 1, nextPlayers, nextEnvelope, nextMask, nextBehavioralMask, nextSoftMask, memo, allowed)
      if (child.worlds === 0n) continue
      total.worlds += child.worlds
      total.counts[game.cards.indexOf(card) * locations.length + locationIndex[loc]] += child.worlds
      for (let i = 0; i < valueCount; i++) total.counts[i] += child.counts[i]
      total.weightedWorlds += child.weightedWorlds
      total.weightedCounts[game.cards.indexOf(card) * locations.length + locationIndex[loc]] += child.weightedWorlds
      for (let i = 0; i < valueCount; i++) total.weightedCounts[i] += child.weightedCounts[i]
    }

    memo.set(key, total)
    return total
  }

  const result = count(0, remaining, envelopeRemaining, initialClauseMask, initialBehavioralMask, initialSoftMask, new Map(), baseAllowedFor)

  if (result.worlds === 0n) return contradiction(game, maxWorlds, 'No valid deals match the current evidence.')

  const useWeightedProbabilities = game.behaviorOptIn && softClauses.length > 0 && result.weightedWorlds > 0

  for (const card of game.cards) {
    const forced = forcedLocation(hardMarks[card.id])
    for (const loc of locations) {
      if (forced) probabilities[card.id][loc] = forced === loc ? 1 : 0
      else {
        const valueIndex = game.cards.indexOf(card) * locations.length + locationIndex[loc]
        probabilities[card.id][loc] = useWeightedProbabilities
          ? result.weightedCounts[valueIndex] / result.weightedWorlds
          : Number(result.counts[valueIndex]) / Number(result.worlds)
      }
    }
  }

  const deductions: SolverResult['deductions'] = []
  for (const card of game.cards) {
    for (const loc of locations) {
      const p = probabilities[card.id][loc]
      if (p === 1 && game.marks[card.id][loc] !== 'yes') deductions.push({ cardId: card.id, locationId: loc, mark: 'yes', reason: 'True in every valid deal.' })
      if (p === 0 && game.marks[card.id][loc] === 'unknown') deductions.push({ cardId: card.id, locationId: loc, mark: 'no', reason: 'Impossible in every valid deal.' })
    }
  }

  messages.push(`Exact calculation across ${Number(result.worlds).toLocaleString()} valid deals.`)
  if (behavioralClauses.length) messages.push(`Behavior heuristic enabled: excluded deals where a suggester holds all three cards they guessed.`)
  if (useWeightedProbabilities) messages.push(`Behavior weighting enabled: repeated guesses down-weight the chance that repeated cards were previously shown; single repeats use 15% for rooms and 5% otherwise, repeated pairs use 8% with rooms and 2% otherwise.`)

  const envelopePick = Object.fromEntries((['suspect', 'weapon', 'room'] as CardType[]).map((type) => {
    const cards = game.cards.filter((c) => c.type === type).map((c) => ({ cardId: c.id, probability: probabilities[c.id].envelope })).sort((a, b) => b.probability - a.probability)
    return [type, cards[0] ?? null]
  })) as SolverResult['envelopePick']
  let accusationProbability = 0
  if (envelopePick.suspect && envelopePick.weapon && envelopePick.room) {
    const forcedEnvelopeIds = new Set([envelopePick.suspect.cardId, envelopePick.weapon.cardId, envelopePick.room.cardId])
    const combo = count(0, remaining, envelopeRemaining, initialClauseMask, initialBehavioralMask, initialSoftMask, new Map(), comboAllowedFor(forcedEnvelopeIds))
    accusationProbability = useWeightedProbabilities ? combo.weightedWorlds / result.weightedWorlds : Number(combo.worlds) / Number(result.worlds)
  }

  return { status: 'exact', worlds: Number(result.worlds), cappedAt: maxWorlds, probabilities, deductions, envelopePick, accusationProbability, messages }
}

function contradiction(game: GameState, maxWorlds: number, message: string): SolverResult {
  return {
    status: 'contradiction',
    worlds: 0,
    cappedAt: maxWorlds,
    probabilities: emptyProbabilities(game.cards, ['envelope', ...game.players.map((p) => p.id)]),
    deductions: [],
    envelopePick: { suspect: null, weapon: null, room: null },
    accusationProbability: 0,
    messages: [message],
  }
}
