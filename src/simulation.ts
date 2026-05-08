
import { solveGame, type SolverResult } from './solver.ts'
import { createBlankMarks, defaultCards, defaultPlayers, type CardType, type GameState, type Player, type Suggestion, type SuggestionResult } from './types.ts'

export type SimulationStrategy = 'likely' | 'balanced' | 'infoGain' | 'hybrid' | 'random' | 'passNext' | 'targetNext' | 'passMany' | 'privateInfo' | 'tableControl' | 'weightedInfo' | 'weightedPrivate' | 'phaseHybrid' | 'decisiveProbe'
export type SimulationOptions = { games?: number; seed?: number; maxTurns?: number; solverMaxWorlds?: number; candidateLimitPerType?: number; accusationThreshold?: number; paired?: boolean; playerCount?: 3 | 6; myPosition?: number | 'random'; infoWeight?: number; bottleneckWeight?: number; exactWeight?: number; selfProbeWeight?: number; leakageWeight?: number; envelopeWeight?: number; decisiveNobodyWeight?: number; lateLeakageDiscount?: number; targetPasses?: number; targetPassWeight?: number; suspectWeight?: number; weaponWeight?: number; roomWeight?: number; onProgress?: (progress: SimulationProgress) => void; onTrial?: (trial: TrialResult) => void }
export type SimulationProgress = { strategy: SimulationStrategy; strategyIndex: number; strategyCount: number; game: number; games: number; completed: number; total: number; elapsedMs: number; estimatedTotalMs: number; remainingMs: number }
export type StrategySummary = { strategy: SimulationStrategy; games: number; solved: number; failed: number; averagePlayerTurns: number; stdDevTurns: number; ci95Turns: number; medianPlayerTurns: number; iqrPlayerTurns: number; p75PlayerTurns: number; p95PlayerTurns: number; averageMyTurns: number; averageSolverWorlds: number; averagePassesOnMySuggestions: number; immediateDisproofRate: number; nobodyDisprovedRate: number; exactShownToMePerGame: number; avgNoFactsPerMySuggestion: number; avgEntropyImbalance: number; avgSuspectSolvedTurn: number; avgWeaponSolvedTurn: number; avgRoomSolvedTurn: number; meanRank?: number }

export type TrialResult = {
  trial: number
  seed: number
  strategy: SimulationStrategy
  playerCount: number
  myPosition: number
  solved: boolean
  turns: number
  myTurns: number
  suspectSolvedTurn: number
  weaponSolvedTurn: number
  roomSolvedTurn: number
  mySuggestions: number
  passCount: number
  noFacts: number
  immediateDisproofs: number
  nobodyDisproved: number
  exactShownToMe: number
  entropyImbalance: number
  averageSolverWorlds: number
}
export type SimulationReport = { options: ResolvedSimulationOptions; summaries: StrategySummary[] }

type Rng = () => number
type Deal = { envelope: Record<CardType, string>; hands: Record<string, Set<string>> }
type GameMetrics = { mySuggestions: number; passCount: number; immediateDisproofs: number; nobodyDisproved: number; exactShownToMe: number; entropyImbalanceTotal: number; categorySolvedTurns: Partial<Record<CardType, number>> }

const types: CardType[] = ['suspect', 'weapon', 'room']
const defaults = { games: 100, seed: 7154, maxTurns: 240, solverMaxWorlds: 250_000, candidateLimitPerType: 3, accusationThreshold: 0.88, infoWeight: 1, bottleneckWeight: 0.08, exactWeight: 0.35, selfProbeWeight: 0.35, leakageWeight: 0.25, envelopeWeight: 0.15, decisiveNobodyWeight: 1.1, lateLeakageDiscount: 0.35, targetPasses: 1.5, targetPassWeight: 0, suspectWeight: 1, weaponWeight: 1, roomWeight: 1, paired: true, playerCount: 6 as 3 | 6, myPosition: 0 as number | 'random' }
type ResolvedSimulationOptions = Required<Omit<SimulationOptions, 'onProgress' | 'onTrial'>> & { onProgress?: (progress: SimulationProgress) => void; onTrial?: (trial: TrialResult) => void }
const cardsByType = (type: CardType) => defaultCards.filter((card) => card.type === type)
const ordered = (players: Player[]) => [...players].sort((a, b) => a.turnOrder - b.turnOrder)
const me = (players: Player[]) => players.find((player) => player.isMe) ?? players[0]
function playersFor(options: ResolvedSimulationOptions, seed: number) {
  const count = options.playerCount
  const position = options.myPosition === 'random' ? Math.floor(rng(seed + 42_424)() * count) : Math.max(0, Math.min(count - 1, Number(options.myPosition)))
  return defaultPlayers.slice(0, count).map((player, index) => ({ ...player, turnOrder: index + 1, cardCount: Math.floor(18 / count), isMe: index === position }))
}
function myPosition(players: Player[]) { return ordered(players).findIndex((player) => player.isMe) }

function rng(seed: number): Rng { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let x = t; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296 } }
function pick<T>(items: T[], r: Rng) { return items[Math.floor(r() * items.length)] }
function shuffle<T>(items: T[], r: Rng) { const out = [...items]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]] } return out }
function after(players: Player[], fromId: string) { const ps = ordered(players); const start = ps.findIndex((p) => p.id === fromId); return Array.from({ length: ps.length - 1 }, (_, i) => ps[(Math.max(0, start) + i + 1) % ps.length]) }
function between(players: Player[], fromId: string, toId: string) { const out: Player[] = []; for (const p of after(players, fromId)) { if (p.id === toId) break; out.push(p) } return out }
function nextPlayer(game: GameState, fromId: string) { return after(game.players, fromId)[0]?.id ?? fromId }

function deal(r: Rng, players: Player[]): Deal {
  const envelope = Object.fromEntries(types.map((type) => [type, pick(cardsByType(type), r).id])) as Record<CardType, string>
  const deck = shuffle(defaultCards.filter((card) => envelope[card.type] !== card.id).map((card) => card.id), r)
  const hands = Object.fromEntries(players.map((player) => [player.id, new Set<string>()])) as Record<string, Set<string>>
  let i = 0
  for (const player of ordered(players)) for (let n = 0; n < player.cardCount; n++) hands[player.id].add(deck[i++])
  return { envelope, hands }
}

function initialGame(d: Deal, sourcePlayers: Player[]): GameState {
  const cards = structuredClone(defaultCards), players = structuredClone(sourcePlayers), marks = createBlankMarks(cards, players), mine = me(players)
  for (const card of cards) {
    if (d.hands[mine.id].has(card.id)) {
      marks[card.id][mine.id] = 'yes'
      for (const loc of Object.keys(marks[card.id])) if (loc !== mine.id) marks[card.id][loc] = 'no'
    } else marks[card.id][mine.id] = 'no'
  }
  return { cards, players, marks, suggestions: [], behaviorOptIn: true, activeSuggesterId: players[0].id }
}

function apply(game: GameState, suggestion: Suggestion) {
  const next = structuredClone(game)
  const no = (cardId: string, playerId: string) => { if (next.marks[cardId][playerId] !== 'yes') next.marks[cardId][playerId] = 'no' }
  next.suggestions.unshift(suggestion)
  if (suggestion.result.kind === 'nobody') for (const p of after(next.players, suggestion.suggesterId)) for (const cardId of suggestion.cardIds) no(cardId, p.id)
  if (suggestion.result.kind === 'unknown' || suggestion.result.kind === 'shown') for (const p of between(next.players, suggestion.suggesterId, suggestion.result.disproverId)) for (const cardId of suggestion.cardIds) no(cardId, p.id)
  if (suggestion.result.kind === 'shown') {
    next.marks[suggestion.result.shownCardId][suggestion.result.disproverId] = 'yes'
    for (const loc of Object.keys(next.marks[suggestion.result.shownCardId])) if (loc !== suggestion.result.disproverId) next.marks[suggestion.result.shownCardId][loc] = 'no'
  }
  next.activeSuggesterId = nextPlayer(next, suggestion.suggesterId)
  return next
}

function makeSuggestion(game: GameState, suggesterId: string, cardIds: [string, string, string], result: SuggestionResult): Suggestion {
  return { id: `${game.suggestions.length + 1}-${suggesterId}`, suggesterId, cardIds, result, createdAt: game.suggestions.length + 1 }
}

function actualResult(game: GameState, d: Deal, suggesterId: string, cardIds: [string, string, string], r: Rng): SuggestionResult {
  const myId = me(game.players).id
  for (const p of after(game.players, suggesterId)) {
    const held = cardIds.filter((cardId) => d.hands[p.id].has(cardId))
    if (!held.length) continue
    return suggesterId === myId || p.id === myId ? { kind: 'shown', disproverId: p.id, shownCardId: pick(held, r) } : { kind: 'unknown', disproverId: p.id }
  }
  return { kind: 'nobody' }
}


function actualPassCount(game: GameState, d: Deal, suggesterId: string, cardIds: [string, string, string]) {
  let count = 0
  for (const p of after(game.players, suggesterId)) {
    if (cardIds.some((cardId) => d.hands[p.id].has(cardId))) return count
    count += 1
  }
  return count
}

function solved(solver: SolverResult, d: Deal) { return solver.status === 'exact' && types.every((type) => solver.probabilities[d.envelope[type]]?.envelope === 1) }
function candidates(type: CardType, game: GameState, solver: SolverResult) { return cardsByType(type).filter((card) => game.marks[card.id].envelope !== 'no' && (solver.probabilities[card.id]?.envelope ?? 0) > 0).sort((a, b) => (solver.probabilities[b.id]?.envelope ?? 0) - (solver.probabilities[a.id]?.envelope ?? 0)) }
function categoryEntropy(type: CardType, solver: SolverResult) { return -cardsByType(type).reduce((sum, card) => { const p = solver.probabilities[card.id]?.envelope ?? 0; return sum + (p > 0 ? p * Math.log2(p) : 0) }, 0) }
function entropyImbalance(solver: SolverResult) { const values = types.map((type) => categoryEntropy(type, solver)); return Math.max(...values) - Math.min(...values) }
function typeWeight(type: CardType, options: ResolvedSimulationOptions) { return type === 'suspect' ? options.suspectWeight : type === 'weapon' ? options.weaponWeight : options.roomWeight }
function likely(solver: SolverResult): [string, string, string] { return types.map((type) => solver.envelopePick[type]?.cardId ?? cardsByType(type)[0].id) as [string, string, string] }
function randomPick(game: GameState, solver: SolverResult, r: Rng): [string, string, string] { return types.map((type) => pick(candidates(type, game, solver).length ? candidates(type, game, solver) : cardsByType(type), r).id) as [string, string, string] }
function balanced(game: GameState, solver: SolverResult, r: Rng): [string, string, string] {
  const myId = me(game.players).id
  return types.map((type) => {
    const opts = candidates(type, game, solver), top = opts[0], mine = cardsByType(type).filter((card) => game.marks[card.id][myId] === 'yes')
    const entropy = categoryEntropy(type, solver)
    return (mine.length && (opts.length <= 2 || entropy <= 1.1 || (top && (solver.probabilities[top.id]?.envelope ?? 0) >= 0.7))) ? pick(mine, r).id : (top ?? cardsByType(type)[0]).id
  }) as [string, string, string]
}

function infoGain(game: GameState, solver: SolverResult, options: ResolvedSimulationOptions): [string, string, string] {
  const myId = me(game.players).id
  const byType = types.map((type) => [...new Map([...candidates(type, game, solver).slice(0, options.candidateLimitPerType), ...cardsByType(type).filter((card) => game.marks[card.id][myId] === 'yes')].map((card) => [card.id, card])).values()])
  let best = likely(solver), bestScore = -Infinity

  for (const s of byType[0]) for (const w of byType[1]) for (const room of byType[2]) {
    const cardIds: [string, string, string] = [s.id, w.id, room.id]
    let priorNoResponseProbability = 1
    let responseEntropy = 0

    for (const player of after(game.players, myId)) {
      const cardProbabilities = cardIds.map((cardId) => game.marks[cardId][player.id] === 'no' ? 0 : (solver.probabilities[cardId]?.[player.id] ?? 0))
      const canDisproveProbability = Math.max(0, Math.min(1, 1 - cardProbabilities.reduce((product, p) => product * (1 - p), 1)))
      const responseProbability = priorNoResponseProbability * canDisproveProbability
      if (responseProbability > 0) responseEntropy -= responseProbability * Math.log2(responseProbability)
      const totalCardProbability = cardProbabilities.reduce((sum, p) => sum + p, 0)
      if (totalCardProbability > 0) {
        const shownCardEntropy = -cardProbabilities.reduce((sum, p) => {
          const normalized = p / totalCardProbability
          return sum + (normalized > 0 ? normalized * Math.log2(normalized) : 0)
        }, 0)
        responseEntropy += responseProbability * shownCardEntropy
      }
      priorNoResponseProbability *= (1 - canDisproveProbability)
    }
    if (priorNoResponseProbability > 0) responseEntropy -= priorNoResponseProbability * Math.log2(priorNoResponseProbability)

    const bottleneckPressure = cardIds.reduce((sum, cardId) => {
      const card = defaultCards.find((c) => c.id === cardId)
      return sum + (card ? candidates(card.type, game, solver).length : 0)
    }, 0)
    const selfProbeBonus = cardIds.filter((cardId) => game.marks[cardId][myId] === 'yes').length * 0.35
    const envelopePressure = cardIds.reduce((sum, cardId) => sum + (solver.probabilities[cardId]?.envelope ?? 0), 0)
    const score = responseEntropy + bottleneckPressure * 0.08 + selfProbeBonus + envelopePressure * 0.15
    if (score > bestScore) { bestScore = score; best = cardIds }
  }
  return best
}


function responseProfile(game: GameState, solver: SolverResult, cardIds: [string, string, string]) {
  const myId = me(game.players).id
  let probabilityReach = 1
  let expectedPasses = 0
  let immediateDisproofProbability = 0
  let exactShownEntropy = 0

  for (const [index, player] of after(game.players, myId).entries()) {
    const cardProbabilities = cardIds.map((cardId) => game.marks[cardId][player.id] === 'no' ? 0 : (solver.probabilities[cardId]?.[player.id] ?? 0))
    const canDisproveProbability = Math.max(0, Math.min(1, 1 - cardProbabilities.reduce((product, p) => product * (1 - p), 1)))
    const responseProbability = probabilityReach * canDisproveProbability
    if (index === 0) immediateDisproofProbability = responseProbability
    expectedPasses += probabilityReach * (1 - canDisproveProbability)

    const total = cardProbabilities.reduce((sum, p) => sum + p, 0)
    if (total > 0 && responseProbability > 0) {
      exactShownEntropy += responseProbability * -cardProbabilities.reduce((sum, p) => {
        const normalized = p / total
        return sum + (normalized > 0 ? normalized * Math.log2(normalized) : 0)
      }, 0)
    }
    probabilityReach *= (1 - canDisproveProbability)
  }
  return { expectedPasses, immediateDisproofProbability, nobodyProbability: probabilityReach, exactShownEntropy }
}

function strategicCandidates(game: GameState, solver: SolverResult, options: ResolvedSimulationOptions) {
  const myId = me(game.players).id
  return types.map((type) => [...new Map([...candidates(type, game, solver).slice(0, options.candidateLimitPerType), ...cardsByType(type).filter((card) => game.marks[card.id][myId] === 'yes')].map((card) => [card.id, card])).values()])
}

function optimizeByProfile(game: GameState, solver: SolverResult, options: ResolvedSimulationOptions, score: (profile: ReturnType<typeof responseProfile>, cardIds: [string, string, string]) => number) {
  const byType = strategicCandidates(game, solver, options)
  let best = likely(solver), bestScore = -Infinity
  for (const s of byType[0]) for (const w of byType[1]) for (const room of byType[2]) {
    const cardIds: [string, string, string] = [s.id, w.id, room.id]
    const value = score(responseProfile(game, solver, cardIds), cardIds)
    if (value > bestScore) { bestScore = value; best = cardIds }
  }
  return best
}

function passNext(game: GameState, solver: SolverResult, options: ResolvedSimulationOptions) {
  return optimizeByProfile(game, solver, options, (profile, cardIds) => profile.expectedPasses + profile.nobodyProbability * 0.7 + cardIds.reduce((sum, cardId) => sum + (solver.probabilities[cardId]?.envelope ?? 0), 0) * 0.1)
}

function targetNext(game: GameState, solver: SolverResult, options: ResolvedSimulationOptions) {
  return optimizeByProfile(game, solver, options, (profile) => profile.immediateDisproofProbability + profile.exactShownEntropy * 0.35 - profile.expectedPasses * 0.2)
}

function passMany(game: GameState, solver: SolverResult, options: ResolvedSimulationOptions) {
  return optimizeByProfile(game, solver, options, (profile) => profile.expectedPasses + profile.nobodyProbability + profile.exactShownEntropy * 0.15)
}

function privateInfo(game: GameState, solver: SolverResult, options: ResolvedSimulationOptions) {
  return optimizeByProfile(game, solver, options, (profile) => profile.immediateDisproofProbability + profile.exactShownEntropy * 0.5 - profile.expectedPasses * 0.45 - profile.nobodyProbability * 0.25)
}

function tableControl(game: GameState, solver: SolverResult, options: ResolvedSimulationOptions) {
  const worldRatio = Math.min(1, Math.log10(Math.max(10, solver.worlds)) / 10)
  if (solver.accusationProbability >= options.accusationThreshold) return likely(solver)
  if (worldRatio > 0.82) return passMany(game, solver, options)
  if (worldRatio > 0.62) return infoGain(game, solver, options)
  return targetNext(game, solver, options)
}



function totalEnvelopeEntropy(solver: SolverResult) {
  return types.reduce((sum, type) => sum + categoryEntropy(type, solver), 0)
}

function lateGameFactor(solver: SolverResult) {
  const entropy = totalEnvelopeEntropy(solver)
  const entropyFactor = Math.max(0, Math.min(1, 1 - entropy / 5.2))
  return Math.max(entropyFactor, solver.accusationProbability)
}

function decisiveNobodyValue(game: GameState, solver: SolverResult, options: ResolvedSimulationOptions, cardIds: [string, string, string]) {
  const myId = me(game.players).id
  const late = lateGameFactor(solver)
  const selfAnchors = cardIds.filter((cardId) => game.marks[cardId][myId] === 'yes').length
  const categoryValues = cardIds.map((cardId) => {
    const card = defaultCards.find((c) => c.id === cardId)
    if (!card) return 0
    const candidateCount = candidates(card.type, game, solver).length
    const envelopeP = solver.probabilities[cardId]?.envelope ?? 0
    const bottleneckSolvedByNoOne = candidateCount <= 3 ? (4 - candidateCount) * 0.35 : 0
    return typeWeight(card.type, options) * (envelopeP + bottleneckSolvedByNoOne)
  })
  const unknownPressure = categoryValues.reduce((sum, value) => sum + value, 0)
  return late * (unknownPressure + selfAnchors * 0.45) * Math.min(1, 0.25 + late)
}

function weightedScore(game: GameState, solver: SolverResult, options: ResolvedSimulationOptions, cardIds: [string, string, string], privacyBias = 1) {
  const profile = responseProfile(game, solver, cardIds)
  const myId = me(game.players).id
  const bottleneckPressure = cardIds.reduce((sum, cardId) => {
    const card = defaultCards.find((c) => c.id === cardId)
    return sum + (card ? typeWeight(card.type, options) * candidates(card.type, game, solver).length * categoryEntropy(card.type, solver) : 0)
  }, 0)
  const selfProbe = cardIds.reduce((sum, cardId) => { const card = defaultCards.find((c) => c.id === cardId); return sum + (game.marks[cardId][myId] === 'yes' ? typeWeight(card?.type ?? 'suspect', options) : 0) }, 0)
  const envelopePressure = cardIds.reduce((sum, cardId) => { const card = defaultCards.find((c) => c.id === cardId); return sum + typeWeight(card?.type ?? 'suspect', options) * (solver.probabilities[cardId]?.envelope ?? 0) }, 0)
  const infoValue = profile.exactShownEntropy + profile.nobodyProbability * 0.65 + profile.expectedPasses * 0.18
  const exactValue = profile.immediateDisproofProbability + profile.exactShownEntropy
  const late = lateGameFactor(solver)
  const leakage = profile.expectedPasses + profile.nobodyProbability * 1.4
  const lateAdjustedLeakage = leakage * (1 - late * options.lateLeakageDiscount)
  const decisiveValue = profile.nobodyProbability * decisiveNobodyValue(game, solver, options, cardIds)
  const targetPassPenalty = Math.abs(profile.expectedPasses - options.targetPasses)
  return options.infoWeight * infoValue
    + options.bottleneckWeight * bottleneckPressure
    + options.exactWeight * exactValue
    + options.selfProbeWeight * selfProbe
    + options.envelopeWeight * envelopePressure
    + options.decisiveNobodyWeight * decisiveValue
    - options.leakageWeight * privacyBias * lateAdjustedLeakage
    - options.targetPassWeight * targetPassPenalty
}

function weightedInfo(game: GameState, solver: SolverResult, options: ResolvedSimulationOptions) {
  return optimizeByProfile(game, solver, options, (_profile, cardIds) => weightedScore(game, solver, options, cardIds, 0.55))
}

function weightedPrivate(game: GameState, solver: SolverResult, options: ResolvedSimulationOptions) {
  return optimizeByProfile(game, solver, options, (_profile, cardIds) => weightedScore(game, solver, options, cardIds, 1.35))
}


function decisiveProbe(game: GameState, solver: SolverResult, options: ResolvedSimulationOptions) {
  return optimizeByProfile(game, solver, options, (profile, cardIds) => {
    const decisiveValue = profile.nobodyProbability * decisiveNobodyValue(game, solver, options, cardIds)
    const exactFallback = profile.immediateDisproofProbability * 0.2 + profile.exactShownEntropy * 0.25
    const envelopePressure = cardIds.reduce((sum, cardId) => sum + (solver.probabilities[cardId]?.envelope ?? 0), 0)
    return decisiveValue * 2.2 + exactFallback + envelopePressure * 0.2
  })
}

function phaseHybrid(game: GameState, solver: SolverResult, options: ResolvedSimulationOptions) {
  if (solver.accusationProbability >= options.accusationThreshold) return likely(solver)
  if (lateGameFactor(solver) >= 0.55) return decisiveProbe(game, solver, options)
  const candidateCounts = types.map((type) => candidates(type, game, solver).length)
  const maxCandidates = Math.max(...candidateCounts)
  const minCandidates = Math.min(...candidateCounts)
  const imbalance = entropyImbalance(solver)
  if (maxCandidates - minCandidates >= 3 || imbalance >= 0.9) return weightedInfo(game, solver, { ...options, bottleneckWeight: options.bottleneckWeight * 1.8, selfProbeWeight: options.selfProbeWeight * 1.25 })
  if (solver.worlds < 50_000) return weightedPrivate(game, solver, options)
  return weightedInfo(game, solver, options)
}

function choose(strategy: SimulationStrategy, game: GameState, solver: SolverResult, r: Rng, options: ResolvedSimulationOptions) {
  if (strategy === 'likely') return likely(solver)
  if (strategy === 'balanced') return balanced(game, solver, r)
  if (strategy === 'infoGain') return infoGain(game, solver, options)
  if (strategy === 'hybrid') return solver.accusationProbability >= options.accusationThreshold ? likely(solver) : infoGain(game, solver, options)
  if (strategy === 'passNext') return passNext(game, solver, options)
  if (strategy === 'targetNext') return targetNext(game, solver, options)
  if (strategy === 'passMany') return passMany(game, solver, options)
  if (strategy === 'privateInfo') return privateInfo(game, solver, options)
  if (strategy === 'tableControl') return tableControl(game, solver, options)
  if (strategy === 'weightedInfo') return weightedInfo(game, solver, options)
  if (strategy === 'weightedPrivate') return weightedPrivate(game, solver, options)
  if (strategy === 'phaseHybrid') return phaseHybrid(game, solver, options)
  if (strategy === 'decisiveProbe') return decisiveProbe(game, solver, options)
  return randomPick(game, solver, r)
}

function opponent(game: GameState, d: Deal, player: Player, r: Rng): [string, string, string] {
  const cardIds = types.map((type) => {
    const own = cardsByType(type).filter((card) => d.hands[player.id].has(card.id))
    const unknown = cardsByType(type).filter((card) => !d.hands[player.id].has(card.id) && !game.players.some((p) => p.id !== player.id && game.marks[card.id][p.id] === 'yes'))
    return pick(own.length && r() < 0.28 ? own : (unknown.length ? unknown : cardsByType(type)), r).id
  }) as [string, string, string]
  if (cardIds.every((cardId) => d.hands[player.id].has(cardId))) { const i = Math.floor(r() * 3), type = types[i]; cardIds[i] = pick(cardsByType(type).filter((card) => !d.hands[player.id].has(card.id)), r).id }
  return cardIds
}

function single(strategy: SimulationStrategy, seed: number, options: ResolvedSimulationOptions, strategyIndex = 0) {
  const players = playersFor(options, seed); const d = deal(rng(seed), players); let game = initialGame(d, players), worldTotal = 0, calls = 0
  const metrics: GameMetrics = { mySuggestions: 0, passCount: 0, immediateDisproofs: 0, nobodyDisproved: 0, exactShownToMe: 0, entropyImbalanceTotal: 0, categorySolvedTurns: {} }
  for (let turn = 0; turn < options.maxTurns; turn++) {
    const player = game.players.find((p) => p.id === game.activeSuggesterId) ?? game.players[0]
    let cardIds: [string, string, string]
    const isMe = player.id === me(game.players).id
    if (isMe) {
      const solver = solveGame(game, options.solverMaxWorlds); worldTotal += solver.worlds; calls++
      for (const type of types) if (!metrics.categorySolvedTurns[type] && solver.probabilities[d.envelope[type]]?.envelope === 1) metrics.categorySolvedTurns[type] = turn + 1
      metrics.entropyImbalanceTotal += entropyImbalance(solver)
      if (solved(solver, d)) return { solved: true, turns: turn + 1, playerCount: game.players.length, averageSolverWorlds: worldTotal / calls, metrics }
      cardIds = choose(strategy, game, solver, rng(seed + strategyIndex * 100_003 + turn * 9_973), options)
    } else {
      cardIds = opponent(game, d, player, rng(seed + turn * 7_919 + 17))
    }
    const result = actualResult(game, d, player.id, cardIds, rng(seed + turn * 12_289 + 31))
    if (isMe) {
      metrics.mySuggestions += 1
      const passes = actualPassCount(game, d, player.id, cardIds)
      metrics.passCount += passes
      if (passes === 0 && result.kind !== 'nobody') metrics.immediateDisproofs += 1
      if (result.kind === 'nobody') metrics.nobodyDisproved += 1
      if (result.kind === 'shown') metrics.exactShownToMe += 1
    }
    game = apply(game, makeSuggestion(game, player.id, cardIds, result))
  }
  return { solved: false, turns: options.maxTurns, playerCount: game.players.length, averageSolverWorlds: worldTotal / Math.max(1, calls), metrics }
}
function q(values: number[], quantile: number) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0 }
function mean(values: number[]) { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length) }
function stddev(values: number[]) { const avg = mean(values); return values.length > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1)) : 0 }
function ci95(values: number[]) { return values.length > 1 ? 1.96 * stddev(values) / Math.sqrt(values.length) : 0 }
function summary(strategy: SimulationStrategy, results: ReturnType<typeof single>[]): StrategySummary {
  const solvedResults = results.filter((result) => result.solved), turns = solvedResults.map((result) => result.turns), avg = mean(turns)
  const mySuggestions = results.reduce((s, r) => s + r.metrics.mySuggestions, 0)
  const avgCategoryTurn = (type: CardType) => Number(mean(results.map((r) => r.metrics.categorySolvedTurns[type] ?? r.turns)).toFixed(2))
  return {
    strategy,
    games: results.length,
    solved: solvedResults.length,
    failed: results.length - solvedResults.length,
    averagePlayerTurns: Number(avg.toFixed(2)),
    stdDevTurns: Number(stddev(turns).toFixed(2)),
    ci95Turns: Number(ci95(turns).toFixed(2)),
    medianPlayerTurns: q(turns, 0.5),
    iqrPlayerTurns: Number((q(turns, 0.75) - q(turns, 0.25)).toFixed(2)),
    p75PlayerTurns: q(turns, 0.75),
    p95PlayerTurns: q(turns, 0.95),
    averageMyTurns: Number((avg / Math.max(1, results[0]?.playerCount ?? defaultPlayers.length)).toFixed(2)),
    averageSolverWorlds: Number(mean(results.map((r) => r.averageSolverWorlds)).toFixed(2)),
    averagePassesOnMySuggestions: Number((results.reduce((s, r) => s + r.metrics.passCount, 0) / Math.max(1, mySuggestions)).toFixed(2)),
    immediateDisproofRate: Number((results.reduce((s, r) => s + r.metrics.immediateDisproofs, 0) / Math.max(1, mySuggestions)).toFixed(2)),
    nobodyDisprovedRate: Number((results.reduce((s, r) => s + r.metrics.nobodyDisproved, 0) / Math.max(1, mySuggestions)).toFixed(2)),
    exactShownToMePerGame: Number((results.reduce((s, r) => s + r.metrics.exactShownToMe, 0) / Math.max(1, results.length)).toFixed(2)),
    avgNoFactsPerMySuggestion: Number((results.reduce((s, r) => s + r.metrics.passCount, 0) * 3 / Math.max(1, mySuggestions)).toFixed(2)),
    avgEntropyImbalance: Number((results.reduce((s, r) => s + r.metrics.entropyImbalanceTotal, 0) / Math.max(1, mySuggestions)).toFixed(2)),
    avgSuspectSolvedTurn: avgCategoryTurn('suspect'),
    avgWeaponSolvedTurn: avgCategoryTurn('weapon'),
    avgRoomSolvedTurn: avgCategoryTurn('room'),
  }
}


function toTrialResult(trial: number, seed: number, strategy: SimulationStrategy, result: ReturnType<typeof single>, options: ResolvedSimulationOptions): TrialResult {
  const players = playersFor(options, seed)
  return {
    trial,
    seed,
    strategy,
    playerCount: options.playerCount,
    myPosition: myPosition(players),
    solved: result.solved,
    turns: result.turns,
    myTurns: Number((result.turns / defaultPlayers.length).toFixed(2)),
    suspectSolvedTurn: result.metrics.categorySolvedTurns.suspect ?? result.turns,
    weaponSolvedTurn: result.metrics.categorySolvedTurns.weapon ?? result.turns,
    roomSolvedTurn: result.metrics.categorySolvedTurns.room ?? result.turns,
    mySuggestions: result.metrics.mySuggestions,
    passCount: result.metrics.passCount,
    noFacts: result.metrics.passCount * 3,
    immediateDisproofs: result.metrics.immediateDisproofs,
    nobodyDisproved: result.metrics.nobodyDisproved,
    exactShownToMe: result.metrics.exactShownToMe,
    entropyImbalance: Number((result.metrics.entropyImbalanceTotal / Math.max(1, result.metrics.mySuggestions)).toFixed(3)),
    averageSolverWorlds: Number(result.averageSolverWorlds.toFixed(2)),
  }
}

function rankSummaries(summaries: StrategySummary[], trials: TrialResult[]) {
  const grouped = new Map<number, TrialResult[]>()
  for (const trial of trials) grouped.set(trial.trial, [...(grouped.get(trial.trial) ?? []), trial])
  const rankTotals = new Map<SimulationStrategy, number>()
  for (const group of grouped.values()) {
    const sorted = [...group].sort((a, b) => a.turns - b.turns)
    let i = 0
    while (i < sorted.length) {
      let j = i + 1
      while (j < sorted.length && sorted[j].turns === sorted[i].turns) j++
      const avgRank = (i + 1 + j) / 2
      for (let k = i; k < j; k++) rankTotals.set(sorted[k].strategy, (rankTotals.get(sorted[k].strategy) ?? 0) + avgRank)
      i = j
    }
  }
  const trialCount = Math.max(1, grouped.size)
  return summaries.map((summary) => ({ ...summary, meanRank: Number(((rankTotals.get(summary.strategy) ?? 0) / trialCount).toFixed(2)) }))
}

export function runStrategySimulation(input: SimulationOptions = {}, strategies: SimulationStrategy[] = ['likely', 'balanced', 'infoGain', 'hybrid', 'weightedInfo', 'weightedPrivate', 'phaseHybrid', 'decisiveProbe', 'tableControl', 'passNext', 'targetNext', 'passMany', 'privateInfo', 'random']): SimulationReport {
  const options = { ...defaults, ...input } as ResolvedSimulationOptions
  const startedAt = Date.now()
  let completed = 0
  const total = strategies.length * options.games
  const allTrials: TrialResult[] = []
  const resultsByStrategy = new Map<SimulationStrategy, ReturnType<typeof single>[]>()
  for (const strategy of strategies) resultsByStrategy.set(strategy, [])

  if (options.paired) {
    for (let trial = 0; trial < options.games; trial++) {
      const seed = options.seed + trial
      strategies.forEach((strategy, strategyIndex) => {
        const result = single(strategy, seed, options, strategyIndex)
        resultsByStrategy.get(strategy)?.push(result)
        const trialResult = toTrialResult(trial, seed, strategy, result, options)
        allTrials.push(trialResult)
        options.onTrial?.(trialResult)
        completed += 1
        const elapsedMs = Date.now() - startedAt
        const estimatedTotalMs = elapsedMs * total / completed
        options.onProgress?.({ strategy, strategyIndex: strategyIndex + 1, strategyCount: strategies.length, game: trial + 1, games: options.games, completed, total, elapsedMs, estimatedTotalMs, remainingMs: Math.max(0, estimatedTotalMs - elapsedMs) })
      })
    }
  } else {
    strategies.forEach((strategy, strategyIndex) => {
      for (let trial = 0; trial < options.games; trial++) {
        const seed = options.seed + strategyIndex * 100_000 + trial
        const result = single(strategy, seed, options, strategyIndex)
        resultsByStrategy.get(strategy)?.push(result)
        const trialResult = toTrialResult(trial, seed, strategy, result, options)
        allTrials.push(trialResult)
        options.onTrial?.(trialResult)
        completed += 1
        const elapsedMs = Date.now() - startedAt
        const estimatedTotalMs = elapsedMs * total / completed
        options.onProgress?.({ strategy, strategyIndex: strategyIndex + 1, strategyCount: strategies.length, game: trial + 1, games: options.games, completed, total, elapsedMs, estimatedTotalMs, remainingMs: Math.max(0, estimatedTotalMs - elapsedMs) })
      }
    })
  }

  const summaries = strategies.map((strategy) => summary(strategy, resultsByStrategy.get(strategy) ?? []))
  return { options, summaries: options.paired ? rankSummaries(summaries, allTrials) : summaries }
}

export function formatSimulationReport(report: SimulationReport) {
  return [
    `Simulated ${report.options.games} games per strategy`,
    `Design: ${report.options.paired ? 'paired/blocked' : 'unpaired'}; Players: ${report.options.playerCount}; Me position: ${report.options.myPosition}; Max turns: ${report.options.maxTurns}; solver maxWorlds argument: ${report.options.solverMaxWorlds.toLocaleString()}`,
    `Weights: info=${report.options.infoWeight}, bottleneck=${report.options.bottleneckWeight}, exact=${report.options.exactWeight}, self=${report.options.selfProbeWeight}, leakage=${report.options.leakageWeight}, envelope=${report.options.envelopeWeight}, decisiveNobody=${report.options.decisiveNobodyWeight}, lateLeakageDiscount=${report.options.lateLeakageDiscount}, targetPasses=${report.options.targetPasses}, targetPassWeight=${report.options.targetPassWeight}, suspect=${report.options.suspectWeight}, weapon=${report.options.weaponWeight}, room=${report.options.roomWeight}`,
    '',
    '| Strategy | Solved | Avg turns | StdDev | 95% CI | Median | IQR | P95 | Mean rank | Avg my | Passes | No facts | Immediate | Nobody | Exact/game | Ent imbalance | S/W/R solved | Avg worlds |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.summaries.map((s) => `| ${s.strategy} | ${s.solved}/${s.games} | ${s.averagePlayerTurns} | ${s.stdDevTurns} | +/-${s.ci95Turns} | ${s.medianPlayerTurns} | ${s.iqrPlayerTurns} | ${s.p95PlayerTurns} | ${s.meanRank ?? ''} | ${s.averageMyTurns} | ${s.averagePassesOnMySuggestions} | ${s.avgNoFactsPerMySuggestion} | ${s.immediateDisproofRate} | ${s.nobodyDisprovedRate} | ${s.exactShownToMePerGame} | ${s.avgEntropyImbalance} | ${s.avgSuspectSolvedTurn}/${s.avgWeaponSolvedTurn}/${s.avgRoomSolvedTurn} | ${Math.round(s.averageSolverWorlds).toLocaleString()} |`),
  ].join('\n')
}
