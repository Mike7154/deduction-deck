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
type NoFact = { playerId: string; cardIds: string[] }
type EnvelopeSelection = Record<CardType, number>
type CountResult = { worlds: bigint; counts: bigint[]; envelopeCombos: bigint[] }


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
    if (s.disabled) continue
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
  const players = orderedPlayers(game.players)
  const locations: LocationId[] = ['envelope', ...players.map((p) => p.id)]
  const envelopeTypes: CardType[] = ['suspect', 'weapon', 'room']
  const cardsByType = Object.fromEntries(envelopeTypes.map((type) => [type, game.cards.filter((card) => card.type === type)])) as Record<CardType, Card[]>
  const typeCardIndex = Object.fromEntries(envelopeTypes.map((type) => [type, Object.fromEntries(cardsByType[type].map((card, i) => [card.id, i]))])) as Record<CardType, Record<string, number>>
  const comboCount = cardsByType.suspect.length * cardsByType.weapon.length * cardsByType.room.length
  const playerIndex = Object.fromEntries(players.map((p, i) => [p.id, i])) as Record<string, number>
  const locationIndex = Object.fromEntries(locations.map((loc, i) => [loc, i])) as Record<LocationId, number>
  const remaining = players.map((p) => p.cardCount)
  const envelopeRemaining: Record<CardType, number> = { suspect: 1, weapon: 1, room: 1 }
  const initialEnvelopeSelection: EnvelopeSelection = { suspect: -1, weapon: -1, room: -1 }
  const probabilities = emptyProbabilities(game.cards, locations)
  const messages: string[] = []
  const { noFacts, clauses, yesFacts } = suggestionFacts(players, game.suggestions)

  const hardMarks: GameState['marks'] = structuredClone(game.marks)
  for (const no of noFacts) for (const cardId of no.cardIds) hardMarks[cardId][no.playerId] = hardMarks[cardId][no.playerId] === 'yes' ? 'yes' : 'no'
  for (const yes of yesFacts) hardMarks[yes.cardId][yes.playerId] = 'yes'
  const clauseCardSets = clauses.map((clause) => new Set(clause.cardIds))
  const valueCount = game.cards.length * locations.length

  for (const card of game.cards) {
    const f = forcedLocation(hardMarks[card.id])
    if (f === '__conflict__') return contradiction(game, maxWorlds, 'A card is marked yes in more than one location.')
    if (f) {
      if (f === 'envelope') {
        envelopeRemaining[card.type] -= 1
        initialEnvelopeSelection[card.type] = typeCardIndex[card.type][card.id]
      }
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

  let initialClauseMask = 0
  for (const [clauseIndex, clause] of clauses.entries()) {
    if (clause.cardIds.some((cardId) => forcedLocation(hardMarks[cardId]) === clause.playerId)) initialClauseMask |= 1 << clauseIndex
  }

  function canFinishCounts(index: number, playerRemaining: number[], envelopeByType: Record<CardType, number>) {
    const unassigned = cardsToAssign.slice(index)
    for (const [i, p] of players.entries()) {
      if (playerRemaining[i] < 0) return false
      const possible = unassigned.filter((c) => allowedFor(c).includes(p.id)).length
      if (possible < playerRemaining[i]) return false
    }
    for (const t of Object.keys(envelopeByType) as CardType[]) {
      if (envelopeByType[t] < 0) return false
      const possible = unassigned.filter((c) => c.type === t && allowedFor(c).includes('envelope')).length
      if (possible < envelopeByType[t]) return false
    }
    return true
  }

  function possibleClauses(index: number, mask: number) {
    return clauses.every((clause, clauseIndex) => {
      if (mask & (1 << clauseIndex)) return true
      return cardsToAssign.slice(index).some((card) => clauseCardSets[clauseIndex].has(card.id) && allowedFor(card).includes(clause.playerId))
    })
  }

  const memo = new Map<string, CountResult>()
  const zeroResult = (): CountResult => ({ worlds: 0n, counts: Array<bigint>(valueCount).fill(0n), envelopeCombos: Array<bigint>(comboCount).fill(0n) })

  function envelopeComboIndex(selection: EnvelopeSelection) {
    if (selection.suspect < 0 || selection.weapon < 0 || selection.room < 0) return -1
    return (selection.suspect * cardsByType.weapon.length * cardsByType.room.length) + (selection.weapon * cardsByType.room.length) + selection.room
  }

  function count(index: number, playerRemaining: number[], envelopeByType: Record<CardType, number>, mask: number, envelopeSelection: EnvelopeSelection): CountResult {
    if (!canFinishCounts(index, playerRemaining, envelopeByType)) return zeroResult()
    if (!possibleClauses(index, mask)) return zeroResult()
    if (index === cardsToAssign.length) {
      if (playerRemaining.some((n) => n !== 0)) return zeroResult()
      if (Object.values(envelopeByType).some((n) => n !== 0)) return zeroResult()
      if (clauses.some((_, clauseIndex) => !(mask & (1 << clauseIndex)))) return zeroResult()
      const base = zeroResult()
      base.worlds = 1n
      const comboIndex = envelopeComboIndex(envelopeSelection)
      if (comboIndex >= 0) base.envelopeCombos[comboIndex] = 1n
      return base
    }

    const key = `${index}|${playerRemaining.join(',')}|${envelopeByType.suspect},${envelopeByType.weapon},${envelopeByType.room}|${mask}|${envelopeSelection.suspect},${envelopeSelection.weapon},${envelopeSelection.room}`
    const cached = memo.get(key)
    if (cached) return cached

    const card = cardsToAssign[index]
    const total = zeroResult()
    for (const loc of allowedFor(card)) {
      if (loc === 'envelope' && envelopeByType[card.type] <= 0) continue
      if (loc !== 'envelope' && playerRemaining[playerIndex[loc]] <= 0) continue

      const nextPlayers = [...playerRemaining]
      const nextEnvelope = { ...envelopeByType }
      const nextEnvelopeSelection = { ...envelopeSelection }
      if (loc === 'envelope') {
        nextEnvelope[card.type] -= 1
        nextEnvelopeSelection[card.type] = typeCardIndex[card.type][card.id]
      }
      else nextPlayers[playerIndex[loc]] -= 1

      let nextMask = mask
      for (const [clauseIndex, clause] of clauses.entries()) {
        if (loc === clause.playerId && clauseCardSets[clauseIndex].has(card.id)) nextMask |= 1 << clauseIndex
      }

      const child = count(index + 1, nextPlayers, nextEnvelope, nextMask, nextEnvelopeSelection)
      if (child.worlds === 0n) continue
      total.worlds += child.worlds
      total.counts[game.cards.indexOf(card) * locations.length + locationIndex[loc]] += child.worlds
      for (let i = 0; i < valueCount; i++) total.counts[i] += child.counts[i]
      for (let i = 0; i < comboCount; i++) total.envelopeCombos[i] += child.envelopeCombos[i]
    }

    memo.set(key, total)
    return total
  }

  const result = count(0, remaining, envelopeRemaining, initialClauseMask, initialEnvelopeSelection)

  if (result.worlds === 0n) return contradiction(game, maxWorlds, 'No valid deals match the current evidence.')

  for (const card of game.cards) {
    const forced = forcedLocation(hardMarks[card.id])
    for (const loc of locations) {
      if (forced) probabilities[card.id][loc] = forced === loc ? 1 : 0
      else probabilities[card.id][loc] = Number(result.counts[game.cards.indexOf(card) * locations.length + locationIndex[loc]]) / Number(result.worlds)
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

  const envelopePick = Object.fromEntries((['suspect', 'weapon', 'room'] as CardType[]).map((type) => {
    const cards = game.cards.filter((c) => c.type === type).map((c) => ({ cardId: c.id, probability: probabilities[c.id].envelope })).sort((a, b) => b.probability - a.probability)
    return [type, cards[0] ?? null]
  })) as SolverResult['envelopePick']
  const accusationProbability = envelopePick.suspect && envelopePick.weapon && envelopePick.room
    ? Number(result.envelopeCombos[envelopeComboIndex({
      suspect: typeCardIndex.suspect[envelopePick.suspect.cardId],
      weapon: typeCardIndex.weapon[envelopePick.weapon.cardId],
      room: typeCardIndex.room[envelopePick.room.cardId],
    })] ?? 0n) / Number(result.worlds)
    : 0

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
