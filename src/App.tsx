import { useMemo, useState, type KeyboardEvent } from 'react'
import './App.css'
import { createBlankMarks, createDefaultGame, defaultCards, defaultPlayers, type BehaviorStats, type Card, type CardType, type GameState, type LocationId, type Mark, type Player, type Suggestion, type SuggestionResult, typeLabel } from './types'
import { solveGame, type SolverResult } from './solver'

const saveKey = 'deduction-deck-game-v1'
const statsKey = 'deduction-deck-behavior-stats-v1'
const themeKey = 'deduction-deck-theme-v1'
const phaseOptions = ['opening', 'middle', 'endgame'] as const

type MatrixMode = 'probabilities' | 'guesses'
type ThemeMode = 'dark' | 'light'
const defaultProfileId = 'local-guest'
const legacySessionKey = 'deduction-deck-current-user-v1'

function userScopedKey(baseKey: string, profileId = defaultProfileId) {
  return `${baseKey}:${encodeURIComponent(profileId)}`
}

function hydrateGame(game: GameState): GameState {
  return {
    ...game,
    activeSuggesterId: game.activeSuggesterId ?? [...game.players].sort((a, b) => a.turnOrder - b.turnOrder)[0]?.id ?? game.players[0]?.id ?? 'me',
  }
}

function loadLegacyProfileId() {
  return localStorage.getItem(legacySessionKey)?.trim().toLowerCase() || null
}

function loadGame(profileId: string): GameState {
  try {
    const raw = localStorage.getItem(userScopedKey(saveKey, profileId))
    if (raw) return hydrateGame(JSON.parse(raw) as GameState)

    const legacyProfileId = loadLegacyProfileId()
    const legacyRaw = legacyProfileId ? localStorage.getItem(userScopedKey(saveKey, legacyProfileId)) : null
    if (legacyRaw) return hydrateGame(JSON.parse(legacyRaw) as GameState)
  } catch { /* noop */ }
  return createDefaultGame()
}

function loadStats(profileId: string): BehaviorStats {
  try {
    const raw = localStorage.getItem(userScopedKey(statsKey, profileId))
    if (raw) return JSON.parse(raw) as BehaviorStats

    const legacyProfileId = loadLegacyProfileId()
    const legacyRaw = legacyProfileId ? localStorage.getItem(userScopedKey(statsKey, legacyProfileId)) : null
    return JSON.parse(legacyRaw ?? '{}') as BehaviorStats
  } catch {
    return {}
  }
}

const pct = (n: number) => `${Math.round(n * 100)}%`
const cardById = (cards: Card[], id: string) => cards.find((c) => c.id === id)
const playerById = (players: Player[], id: string) => players.find((p) => p.id === id)
const orderedPlayers = (players: Player[]) => [...players].sort((a, b) => a.turnOrder - b.turnOrder)

function nextMark(mark: Mark): Mark {
  return mark === 'unknown' ? 'no' : mark === 'no' ? 'yes' : 'unknown'
}

function makeId() {
  return Math.random().toString(36).slice(2, 10)
}

function slugify(value: string, fallback: string) {
  const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return slug || fallback
}

function uniqueId(base: string, used: Set<string>) {
  let id = base
  let i = 2
  while (used.has(id)) id = `${base}-${i++}`
  used.add(id)
  return id
}

function renumberPlayers(players: Player[]) {
  return players.map((p, i) => ({ ...p, turnOrder: i + 1 }))
}

function mePlayer(players: Player[]) {
  return players.find((p) => p.isMe) ?? players[0]
}

function rotatePlayersToFirst(players: Player[], firstId: string) {
  const list = orderedPlayers(players)
  const index = list.findIndex((p) => p.id === firstId)
  if (index <= 0) return renumberPlayers(list)
  return renumberPlayers([...list.slice(index), ...list.slice(0, index)])
}

function suggestedCards(game: GameState, ids: [string, string, string]) {
  return ids.map((id) => cardById(game.cards, id)).filter((card): card is Card => Boolean(card))
}

function possibleShownCards(game: GameState, solver: SolverResult, ids: [string, string, string], playerId: string) {
  const cards = suggestedCards(game, ids)
  const possible = cards.filter((card) => {
    const mark = game.marks[card.id]?.[playerId]
    return mark === 'yes' || (mark !== 'no' && (solver.probabilities[card.id]?.[playerId] ?? 0) > 0)
  })
  return possible.length ? possible : cards.filter((card) => game.marks[card.id]?.[playerId] !== 'no')
}

function respondersAfter(game: GameState, suggesterId: string) {
  const players = orderedPlayers(game.players)
  const start = players.findIndex((p) => p.id === suggesterId)
  if (start < 0) return players.filter((p) => p.id !== suggesterId)
  return Array.from({ length: Math.max(0, players.length - 1) }, (_, i) => players[(start + i + 1) % players.length])
}

function setSingleMe(players: Player[], id: string) {
  return players.map((player) => ({ ...player, isMe: player.id === id }))
}

function distributeCardCounts(players: Player[], cardTotal: number) {
  const dealCount = Math.max(0, cardTotal - 3)
  const count = Math.max(1, players.length)
  return players.map((p, i) => ({ ...p, cardCount: Math.floor(dealCount / count) + (i < dealCount % count ? 1 : 0) }))
}

function normalizeSetupGame(draft: GameState): GameState {
  const usedPlayers = new Set<string>()
  const firstMeId = mePlayer(draft.players)?.id
  const normalizedPlayers = draft.players.map((player, index) => ({
    ...player,
    id: uniqueId(player.id || slugify(player.name, `player-${index + 1}`), usedPlayers),
    name: player.name.trim() || `Player ${index + 1}`,
    cardCount: Math.max(0, Number(player.cardCount) || 0),
    isMe: firstMeId ? player.id === firstMeId : index === 0,
  }))
  const players = renumberPlayers(normalizedPlayers)

  const usedCards = new Set<string>()
  const cards = draft.cards.map((card, index) => ({
    ...card,
    id: uniqueId(card.id || slugify(card.name, `${card.type}-${index + 1}`), usedCards),
    name: card.name.trim() || `${typeLabel[card.type].slice(0, -1)} ${index + 1}`,
  }))

  const marks = createBlankMarks(cards, players)
  const meId = mePlayer(players)?.id
  if (meId) {
    for (const card of cards) {
      if (draft.marks?.[card.id]?.[meId] === 'yes') {
        marks[card.id][meId] = 'yes'
        for (const loc of Object.keys(marks[card.id])) if (loc !== meId) marks[card.id][loc] = 'no'
      }
    }
  }

  return {
    cards,
    players,
    marks,
    suggestions: [],
    behaviorOptIn: draft.behaviorOptIn,
    activeSuggesterId: players[0]?.id ?? 'player-1',
  }
}

function setupErrors(game: GameState) {
  const errors: string[] = []
  if (game.players.length < 1) errors.push('Add at least one player.')
  if (game.cards.length < 3) errors.push('Add at least three cards.')
  for (const type of ['suspect', 'weapon', 'room'] as CardType[]) {
    if (!game.cards.some((card) => card.type === type)) errors.push(`Add at least one ${type}.`)
  }
  const dealtCards = Math.max(0, game.cards.length - 3)
  const totalPlayerCards = game.players.reduce((sum, player) => sum + (Number(player.cardCount) || 0), 0)
  if (totalPlayerCards !== dealtCards) errors.push(`Player card counts must total ${dealtCards}; currently ${totalPlayerCards}.`)
  if (game.players.some((player) => !player.name.trim())) errors.push('Every player needs a name.')
  if (game.cards.some((card) => !card.name.trim())) errors.push('Every card needs a name.')
  return errors
}

function nextPlayerId(game: GameState, currentId = game.activeSuggesterId) {
  const players = orderedPlayers(game.players)
  const idx = Math.max(0, players.findIndex((p) => p.id === currentId))
  return players[(idx + 1) % players.length]?.id ?? currentId
}

function countsFor(game: GameState, playerId: string, solver?: SolverResult) {
  const known = game.cards.filter((c) => game.marks[c.id]?.[playerId] === 'yes' || solver?.probabilities[c.id]?.[playerId] === 1).length
  const impossible = game.cards.filter((c) => game.marks[c.id]?.[playerId] === 'no').length
  const target = playerById(game.players, playerId)?.cardCount ?? 0
  return { known, unknownInHand: Math.max(0, target - known), possible: game.cards.length - known - impossible }
}

function loadTheme(): ThemeMode {
  return localStorage.getItem(themeKey) === 'light' ? 'light' : 'dark'
}

function guessCount(game: GameState, playerId: string, cardId: string) {
  return game.suggestions.filter((s) => !s.disabled && s.suggesterId === playerId && s.cardIds.includes(cardId)).length
}

function resetKnownEvidence(game: GameState): GameState {
  const players = orderedPlayers(game.players).map((p, i) => ({ ...p, turnOrder: i + 1 }))
  return {
    ...game,
    players,
    marks: createBlankMarks(game.cards, players),
    suggestions: [],
    activeSuggesterId: players[0]?.id ?? game.activeSuggesterId,
  }
}

function withSuggestionDisabledForTest(game: GameState, suggestionId: string): GameState {
  const next = structuredClone(game)
  const suggestion = next.suggestions.find((s) => s.id === suggestionId)
  if (!suggestion) return next
  suggestion.disabled = true
  if (suggestion.result.kind === 'shown') {
    const { shownCardId, disproverId } = suggestion.result
    const stillShownByActiveEvidence = next.suggestions.some((s) =>
      s.id !== suggestionId &&
      !s.disabled &&
      s.result.kind === 'shown' &&
      s.result.shownCardId === shownCardId &&
      s.result.disproverId === disproverId
    )
    if (!stillShownByActiveEvidence && next.marks[shownCardId]?.[disproverId] === 'yes') next.marks[shownCardId][disproverId] = 'unknown'
  }
  return next
}

function App() {
  const [profileId] = useState(defaultProfileId)
  const [game, setGame] = useState<GameState>(() => loadGame(profileId))
  const [stats, setStats] = useState<BehaviorStats>(() => loadStats(profileId))
  const [selected, setSelected] = useState<{ cardId: string; locationId: LocationId } | null>(null)
  const [matrixMode, setMatrixMode] = useState<MatrixMode>('probabilities')
  const [detailCardId, setDetailCardId] = useState<string | null>(null)
  const [quickMark, setQuickMark] = useState<{ cardId: string; locationId: LocationId } | null>(null)
  const [setupMode, setSetupMode] = useState(false)
  const [setupDraft, setSetupDraft] = useState<GameState>(() => createDefaultGame())
  const [collapsedTypes, setCollapsedTypes] = useState<Record<CardType, boolean>>({ suspect: false, weapon: false, room: false })
  const [undoStack, setUndoStack] = useState<GameState[]>([])
  const [theme, setTheme] = useState<ThemeMode>(loadTheme)
  const solver = useMemo(() => setupMode ? null : solveGame(game), [game, setupMode])
  const locations = useMemo(() => ['envelope', ...orderedPlayers(game.players).map((p) => p.id)], [game.players])
  const likelyBadSuggestionIds = useMemo(() => {
    if (setupMode || solver?.status !== 'contradiction') return new Set<string>()
    const helpfulIds = game.suggestions
      .filter((suggestion) => !suggestion.disabled)
      .filter((suggestion) => solveGame(withSuggestionDisabledForTest(game, suggestion.id)).status !== 'contradiction')
      .map((suggestion) => suggestion.id)
    return new Set(helpfulIds)
  }, [game, setupMode, solver?.status])

  function resetLocalGame() {
    setGame(loadGame(profileId))
    setStats(loadStats(profileId))
    setSelected(null)
    setQuickMark(null)
    setMatrixMode('probabilities')
    setDetailCardId(null)
    setSetupMode(false)
  }

  function updateGame(next: GameState) {
    const hydrated = hydrateGame(next)
    setUndoStack((stack) => [game, ...stack].slice(0, 25))
    setGame(hydrated)
    localStorage.setItem(userScopedKey(saveKey, profileId), JSON.stringify(hydrated))
  }

  function replaceGame(next: GameState) {
    const hydrated = hydrateGame(next)
    setUndoStack([])
    setGame(hydrated)
    localStorage.setItem(userScopedKey(saveKey, profileId), JSON.stringify(hydrated))
  }

  function undoLastChange() {
    const [previous, ...rest] = undoStack
    if (!previous) return
    setUndoStack(rest)
    setGame(previous)
    setSelected(null)
    setQuickMark(null)
    setDetailCardId(null)
    localStorage.setItem(userScopedKey(saveKey, profileId), JSON.stringify(previous))
  }

  function setMark(cardId: string, locationId: LocationId, mark: Mark) {
    const next = structuredClone(game)
    next.marks[cardId][locationId] = mark
    if (mark === 'yes') {
      for (const loc of locations) if (loc !== locationId) next.marks[cardId][loc] = 'no'
    }
    updateGame(next)
    setQuickMark(null)
  }

  function applyDeductions() {
    if (!solver) return
    const next = structuredClone(game)
    for (const d of solver.deductions) next.marks[d.cardId][d.locationId] = d.mark
    updateGame(next)
  }

  function skipSuggester() {
    updateGame({ ...game, activeSuggesterId: nextPlayerId(game) })
  }

  function addSuggestion(suggestion: Suggestion) {
    const next = structuredClone(game)
    next.suggestions.unshift(suggestion)
    if (suggestion.result.kind === 'shown') next.marks[suggestion.result.shownCardId][suggestion.result.disproverId] = 'yes'
    next.activeSuggesterId = nextPlayerId(next, suggestion.suggesterId)
    updateGame(next)
  }

  function setSuggestionDisabled(id: string, disabled: boolean) {
    const next = structuredClone(game)
    const suggestion = next.suggestions.find((s) => s.id === id)
    if (!suggestion) return
    suggestion.disabled = disabled
    if (suggestion.result.kind === 'shown') {
      const { shownCardId, disproverId } = suggestion.result
      if (disabled) {
        const stillShownByActiveEvidence = next.suggestions.some((s) =>
          s.id !== id &&
          !s.disabled &&
          s.result.kind === 'shown' &&
          s.result.shownCardId === shownCardId &&
          s.result.disproverId === disproverId
        )
        if (!stillShownByActiveEvidence && next.marks[shownCardId]?.[disproverId] === 'yes') next.marks[shownCardId][disproverId] = 'unknown'
      } else {
        next.marks[shownCardId][disproverId] = 'yes'
      }
    }
    updateGame(next)
  }

  function finishGame(envelope: Record<CardType, string>, playerHands: Record<string, string[]>, phase: string) {
    const nextStats = structuredClone(stats)
    for (const suggestion of game.suggestions) {
      if (suggestion.disabled) continue
      const holderCards = playerHands[suggestion.suggesterId] ?? []
      for (const cardId of suggestion.cardIds) {
        const key = `${suggestion.suggesterId}:${cardId}`
        const held = holderCards.includes(cardId) ? 1 : 0
        nextStats[key] ??= { suggested: 0, held: 0, byPhase: {} }
        nextStats[key].suggested += 1
        nextStats[key].held += held
        nextStats[key].byPhase[phase] ??= { suggested: 0, held: 0 }
        nextStats[key].byPhase[phase].suggested += 1
        nextStats[key].byPhase[phase].held += held
      }
    }
    const nextGame = structuredClone(game)
    for (const type of Object.keys(envelope) as CardType[]) if (envelope[type]) nextGame.marks[envelope[type]].envelope = 'yes'
    setStats(nextStats)
    localStorage.setItem(userScopedKey(statsKey, profileId), JSON.stringify(nextStats))
    updateGame(nextGame)
  }

  function toggleTheme() {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark'
      localStorage.setItem(themeKey, next)
      return next
    })
  }

  const selectedCard = selected ? cardById(game.cards, selected.cardId) : null
  const selectedLocation = selected?.locationId === 'envelope' ? 'Envelope' : playerById(game.players, selected?.locationId ?? '')?.name
  const detailCard = detailCardId ? cardById(game.cards, detailCardId) : null
  const quickMarkCard = quickMark ? cardById(game.cards, quickMark.cardId) : null
  const quickMarkLocation = quickMark?.locationId === 'envelope' ? 'Envelope' : playerById(game.players, quickMark?.locationId ?? '')?.name

  if (setupMode) return <SetupScreen draft={setupDraft} onChange={setSetupDraft} onCancel={() => setSetupMode(false)} onStart={(draft) => { replaceGame(normalizeSetupGame(draft)); setSetupMode(false); setSelected(null); setQuickMark(null); setDetailCardId(null); setMatrixMode('probabilities') }} />
  if (!solver) return null

  return (
    <div className="app-shell" data-theme={theme}>
      <TopBar game={game} theme={theme} onToggleTheme={toggleTheme} canUndo={undoStack.length > 0} onUndo={undoLastChange} onResetLocal={resetLocalGame} onNew={() => { setSetupDraft(createDefaultGame()); setSetupMode(true); setDetailCardId(null) }} onSave={() => localStorage.setItem(userScopedKey(saveKey, profileId), JSON.stringify(game))} />
      <main className="workspace">
        <aside className="sidebar panel">
          <GameSummary game={game} onChange={updateGame} onEditSetup={() => { setSetupDraft(resetKnownEvidence(game)); setSetupMode(true); setDetailCardId(null) }} />
          <SuggestionForm key={game.activeSuggesterId} game={game} solver={solver} onAdd={addSuggestion} onSkip={skipSuggester} />
        </aside>

        <section className="matrix-panel panel">
          <div className="matrix-head">
            <div>
              <h1>{matrixMode === 'probabilities' ? 'Probability matrix' : 'Guessing tracker'}</h1>
              <p>{matrixMode === 'probabilities' ? 'Exact deal enumeration when possible. Double-click a cell to cycle unknown/no/yes.' : 'Counts how often each player suggested each card. Useful as a human-behavior hint, not a hard deduction.'}</p>
            </div>
            <div className="matrix-actions">
              <button onClick={() => setMatrixMode(matrixMode === 'probabilities' ? 'guesses' : 'probabilities')}>{matrixMode === 'probabilities' ? 'Show guesses' : 'Show probabilities'}</button>
              <button className="primary" onClick={applyDeductions} disabled={solver.deductions.length === 0}>Apply {solver.deductions.length} deductions</button>
            </div>
          </div>
          {matrixMode === 'probabilities'
            ? <ProbabilityMatrix game={game} solver={solver} locations={locations} selected={selected} collapsedTypes={collapsedTypes} onToggleType={(type) => setCollapsedTypes((next) => ({ ...next, [type]: !next[type] }))} onSelect={(cell) => { setSelected(cell); setQuickMark(cell) }} onSetMark={setMark} onOpenCard={setDetailCardId} />
            : <GuessMatrix game={game} solver={solver} locations={locations.filter((loc) => loc !== 'envelope')} collapsedTypes={collapsedTypes} onToggleType={(type) => setCollapsedTypes((next) => ({ ...next, [type]: !next[type] }))} onOpenCard={setDetailCardId} />}
          <EvidenceLog game={game} solver={solver} likelyBadSuggestionIds={likelyBadSuggestionIds} onToggleDisabled={setSuggestionDisabled} />
        </section>

        <aside className="inspector panel">
          <CurrentDeduction game={game} solver={solver} />
          <SelectionInspector selectedCard={selectedCard} selectedLocation={selectedLocation} selected={selected} solver={solver} stats={stats} onSetMark={setMark} />
          <BehaviorPanel game={game} stats={stats} onFinish={finishGame} />
        </aside>
      </main>
      {quickMark && quickMarkCard && <QuickMarkSheet card={quickMarkCard} locationName={quickMarkLocation ?? quickMark.locationId} onSet={(mark) => setMark(quickMark.cardId, quickMark.locationId, mark)} onClose={() => setQuickMark(null)} />}
      {detailCard && <CardDetailModal card={detailCard} game={game} solver={solver} onClose={() => setDetailCardId(null)} />}
    </div>
  )
}

function TopBar({ game, theme, onToggleTheme, canUndo, onUndo, onResetLocal, onNew, onSave }: { game: GameState; theme: ThemeMode; onToggleTheme: () => void; canUndo: boolean; onUndo: () => void; onResetLocal: () => void; onNew: () => void; onSave: () => void }) {
  function exportJson() {
    const blob = new Blob([JSON.stringify(game, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'deduction-deck-game.json'
    a.click()
  }
  return <header className="topbar">
    <div className="brand"><span className="brand-mark">DD</span><div><strong>Deduction Deck</strong><small>Saved in this browser</small></div></div>
    <nav><button className="undo-button" onClick={onUndo} disabled={!canUndo}>Undo</button><button onClick={onToggleTheme}>{theme === 'dark' ? 'Light' : 'Dark'}</button><button onClick={onNew}>New Game</button><button onClick={onSave}>Save</button><button onClick={exportJson}>Export</button><button onClick={onResetLocal}>Reload save</button></nav>
  </header>
}

function SetupScreen({ draft, onChange, onCancel, onStart }: { draft: GameState; onChange: (g: GameState) => void; onCancel: () => void; onStart: (g: GameState) => void }) {
  const errors = setupErrors(draft)
  const dealtCards = Math.max(0, draft.cards.length - 3)

  function moveBetweenSetupNames(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
    const nameFields = Array.from(document.querySelectorAll<HTMLInputElement>('[data-setup-name="true"]'))
      .filter((input) => !input.disabled)
    const currentIndex = nameFields.indexOf(event.currentTarget)
    const nextIndex = currentIndex + (event.shiftKey ? -1 : 1)
    const nextField = nameFields[nextIndex]
    if (!nextField) return
    event.preventDefault()
    nextField.focus()
    nextField.select()
  }

  function setDraft(next: GameState) {
    onChange({ ...next, players: renumberPlayers(next.players) })
  }
  function updatePlayer(id: string, patch: Partial<Player>) {
    const next = structuredClone(draft)
    next.players = next.players.map((p) => p.id === id ? { ...p, ...patch } : p)
    setDraft(next)
  }
  function addPlayer() {
    const next = structuredClone(draft)
    const used = new Set(next.players.map((p) => p.id))
    const id = uniqueId(`player-${next.players.length + 1}`, used)
    next.players.push({ id, name: `Player ${next.players.length + 1}`, cardCount: 0, turnOrder: next.players.length + 1 })
    setDraft({ ...next, players: distributeCardCounts(next.players, next.cards.length) })
  }
  function removePlayer(id: string) {
    const next = structuredClone(draft)
    next.players = distributeCardCounts(next.players.filter((p) => p.id !== id), next.cards.length)
    setDraft(next)
  }
  function movePlayer(id: string, direction: -1 | 1) {
    const list = orderedPlayers(draft.players)
    const idx = list.findIndex((p) => p.id === id)
    const swap = idx + direction
    if (idx < 0 || swap < 0 || swap >= list.length) return
    ;[list[idx], list[swap]] = [list[swap], list[idx]]
    setDraft({ ...draft, players: renumberPlayers(list) })
  }
  function setMe(id: string) {
    setDraft({ ...draft, players: setSingleMe(draft.players, id) })
  }
  function setGoesFirst(id: string) {
    setDraft({ ...draft, players: rotatePlayersToFirst(draft.players, id), activeSuggesterId: id })
  }
  function toggleMyCard(cardId: string) {
    const meId = mePlayer(draft.players)?.id
    if (!meId) return
    const next = structuredClone(draft)
    next.marks = next.marks ?? createBlankMarks(next.cards, next.players)
    next.marks[cardId] ??= { envelope: 'unknown' }
    for (const player of next.players) next.marks[cardId][player.id] ??= 'unknown'
    const nextMarkValue: Mark = next.marks[cardId][meId] === 'yes' ? 'unknown' : 'yes'
    next.marks[cardId][meId] = nextMarkValue
    if (nextMarkValue === 'yes') for (const loc of Object.keys(next.marks[cardId])) if (loc !== meId) next.marks[cardId][loc] = 'no'
    setDraft(next)
  }
  function updateCard(id: string, patch: Partial<Card>) {
    const next = structuredClone(draft)
    next.cards = next.cards.map((card) => card.id === id ? { ...card, ...patch } : card)
    setDraft(next)
  }
  function addCard(type: CardType) {
    const next = structuredClone(draft)
    const used = new Set(next.cards.map((card) => card.id))
    const id = uniqueId(`${type}-${next.cards.filter((card) => card.type === type).length + 1}`, used)
    next.cards.push({ id, name: `${typeLabel[type].slice(0, -1)} ${next.cards.length + 1}`, type })
    setDraft({ ...next, players: distributeCardCounts(next.players, next.cards.length) })
  }
  function removeCard(id: string) {
    const next = structuredClone(draft)
    next.cards = next.cards.filter((card) => card.id !== id)
    next.players = distributeCardCounts(next.players, next.cards.length)
    setDraft(next)
  }
  function resetCards() {
    setDraft({ ...draft, cards: structuredClone(defaultCards), players: distributeCardCounts(draft.players, defaultCards.length) })
  }
  function resetPlayers() {
    setDraft({ ...draft, players: distributeCardCounts(structuredClone(defaultPlayers), draft.cards.length) })
  }

  return <div className="app-shell setup-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">DD</span><div><strong>New game setup</strong><small>No solver runs until you start</small></div></div>
      <nav><button onClick={onCancel}>Cancel</button></nav>
    </header>
    <main className="setup-workspace">
      <section className="panel setup-editor">
        <div className="setup-hero">
          <div>
            <h1>Build the deck and deal</h1>
            <p>Set players, turn order, card counts, and custom card names before calculations begin.</p>
          </div>
          <div className="setup-total"><span>Cards to players</span><strong>{draft.players.reduce((sum, p) => sum + Number(p.cardCount || 0), 0)} / {dealtCards}</strong></div>
        </div>

        <section className="setup-section">
          <div className="section-head"><h2>Players and turn order</h2><div><button onClick={resetPlayers}>Default players</button><button onClick={() => onChange({ ...draft, players: distributeCardCounts(draft.players, draft.cards.length) })}>Auto deal</button><button className="primary" onClick={addPlayer}>Add player</button></div></div>
          <div className="setup-player-list">
            {orderedPlayers(draft.players).map((p, index) => <div className="setup-player-row" key={p.id}>
              <div className="reorder-buttons"><button aria-label={`Move ${p.name} earlier`} disabled={index === 0} onClick={() => movePlayer(p.id, -1)}>Up</button><button aria-label={`Move ${p.name} later`} disabled={index === draft.players.length - 1} onClick={() => movePlayer(p.id, 1)}>Down</button></div>
              <label className="field"><span>Name</span><input data-setup-name="true" value={p.name} onKeyDown={moveBetweenSetupNames} onChange={(e) => updatePlayer(p.id, { name: e.target.value })} /></label>
              <label className="field"><span>Cards</span><input type="number" min="0" max={draft.cards.length} value={p.cardCount} onChange={(e) => updatePlayer(p.id, { cardCount: Number(e.target.value) })} /></label>
              <div className="setup-player-flags"><button className={p.isMe ? 'primary' : ''} onClick={() => setMe(p.id)}>{p.isMe ? 'Me' : 'Set me'}</button><button onClick={() => setGoesFirst(p.id)} disabled={index === 0}>Goes first</button><button onClick={() => removePlayer(p.id)} disabled={draft.players.length <= 1}>Remove</button></div>
            </div>)}
          </div>
        </section>

        <section className="setup-section">
          <div className="section-head"><h2>My hand</h2><p className="microcopy">Check the cards dealt to {mePlayer(draft.players)?.name ?? 'Me'}; they start as YES in your matrix.</p></div>
          <div className="my-hand-grid">
            {(['suspect', 'weapon', 'room'] as CardType[]).map((type) => <div className="my-hand-group" key={type}>
              <h3>{typeLabel[type]}</h3>
              {draft.cards.filter((card) => card.type === type).map((card) => <label className="hand-card-check" key={card.id}><input type="checkbox" checked={draft.marks?.[card.id]?.[mePlayer(draft.players)?.id ?? ''] === 'yes'} onChange={() => toggleMyCard(card.id)} /> <span>{card.name}</span></label>)}
            </div>)}
          </div>
        </section>

        <section className="setup-section">
          <div className="section-head"><h2>Cards</h2><div><button onClick={resetCards}>Default cards</button></div></div>
          {(['suspect', 'weapon', 'room'] as CardType[]).map((type) => <div className="card-type-editor" key={type}>
            <div className="card-type-head"><h3>{typeLabel[type]}</h3><button onClick={() => addCard(type)}>Add {type}</button></div>
            <div className="card-edit-list">
              {draft.cards.filter((card) => card.type === type).map((card) => <div className="card-edit-row" key={card.id}>
                <input data-setup-name="true" value={card.name} onKeyDown={moveBetweenSetupNames} onChange={(e) => updateCard(card.id, { name: e.target.value })} />
                <button onClick={() => removeCard(card.id)} disabled={draft.cards.filter((c) => c.type === type).length <= 1}>Remove</button>
              </div>)}
            </div>
          </div>)}
        </section>

        <div className="setup-footer">
          <div className="setup-errors">{errors.length ? errors.map((error) => <span key={error}>{error}</span>) : <span className="ok">Ready to start.</span>}</div>
          <button className="primary start-button" disabled={errors.length > 0} onClick={() => onStart(draft)}>Start game</button>
        </div>
      </section>
    </main>
  </div>
}

function GameSummary({ game, onChange, onEditSetup }: { game: GameState; onChange: (g: GameState) => void; onEditSetup: () => void }) {
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches)
  function movePlayer(id: string, direction: -1 | 1) {
    const list = orderedPlayers(game.players)
    const idx = list.findIndex((p) => p.id === id)
    const swap = idx + direction
    if (idx < 0 || swap < 0 || swap >= list.length) return
    ;[list[idx], list[swap]] = [list[swap], list[idx]]
    const players = renumberPlayers(list)
    const activeStillExists = players.some((p) => p.id === game.activeSuggesterId)
    onChange({ ...game, players, activeSuggesterId: activeStillExists ? game.activeSuggesterId : players[0]?.id ?? game.activeSuggesterId })
  }
  function renamePlayer(id: string, name: string) {
    onChange({ ...game, players: game.players.map((player) => player.id === id ? { ...player, name } : player) })
  }
  return <section className="setup-card">
    <div className="summary-head"><h2>Game setup</h2><button className="tiny" onClick={() => setCollapsed(!collapsed)}>{collapsed ? 'Show' : 'Hide'}</button></div>
    <p className="muted">{game.players.length} players - {game.cards.length} cards - {Math.max(0, game.cards.length - 3)} dealt cards</p>
    {!collapsed && <>
      <div className="summary-list">{orderedPlayers(game.players).map((player, index) => <div key={player.id}>
        <label className="summary-name"><span>{player.turnOrder}.</span><input value={player.name} onChange={(event) => renamePlayer(player.id, event.target.value)} /></label>{player.isMe && <span className="me-badge">Me</span>}
        <strong>{player.cardCount}</strong>
        <span className="mini-reorder"><button aria-label={`Move ${player.name} earlier`} disabled={index === 0} onClick={() => movePlayer(player.id, -1)}>▲</button><button aria-label={`Move ${player.name} later`} disabled={index === game.players.length - 1} onClick={() => movePlayer(player.id, 1)}>▼</button></span>
      </div>)}</div>
      <button className="wide" onClick={onEditSetup}>Edit setup for new game</button>
    </>}
  </section>
}

function QuickMarkSheet({ card, locationName, onSet, onClose }: { card: Card; locationName: string; onSet: (mark: Mark) => void; onClose: () => void }) {
  return <div className="quick-mark-backdrop" onClick={onClose}>
    <section className="quick-mark-sheet panel" onClick={(event) => event.stopPropagation()}>
      <div><strong>{card.name}</strong><span>{locationName}</span></div>
      <div className="quick-mark-actions"><button className="primary" onClick={() => onSet('yes')}>Mark yes</button><button onClick={() => onSet('no')}>Mark no</button><button onClick={() => onSet('unknown')}>Clear</button></div>
    </section>
  </div>
}

function SuggestionForm({ game, solver, onAdd, onSkip }: { game: GameState; solver: SolverResult; onAdd: (s: Suggestion) => void; onSkip: () => void }) {
  const firstByType = (type: CardType) => game.cards.find((c) => c.type === type)!.id
  const [suspect, setSuspect] = useState(firstByType('suspect'))
  const [weapon, setWeapon] = useState(firstByType('weapon'))
  const [room, setRoom] = useState(firstByType('room'))
  const [resultKind, setResultKind] = useState<'nobody' | 'unknown' | 'shown' | 'unresolved'>('unknown')
  const [disproverId, setDisprover] = useState(nextPlayerId(game, game.activeSuggesterId))
  const [shownCardId, setShownCard] = useState(suspect)
  const [quickOpen, setQuickOpen] = useState(false)
  const [responderIndex, setResponderIndex] = useState(0)
  const suggester = playerById(game.players, game.activeSuggesterId) ?? game.players[0]
  const me = mePlayer(game.players)
  const responderList = respondersAfter(game, suggester.id)
  const responderOptions = responderList.map((p) => [p.id, p.name])
  const currentResponder = responderList[responderIndex]
  const canDisprove = responderOptions.length > 0
  const exactCardKnown = canDisprove && (suggester.isMe || playerById(game.players, disproverId)?.isMe)
  const selectedCardIds: [string, string, string] = [suspect, weapon, room]
  const selectedCards = suggestedCards(game, selectedCardIds)
  const shownCardOptions = canDisprove ? possibleShownCards(game, solver, selectedCardIds, disproverId) : selectedCards
  const safeShownCardId = shownCardOptions.some((card) => card.id === shownCardId) ? shownCardId : shownCardOptions[0]?.id ?? suspect
  const displayedResultKind = exactCardKnown && resultKind === 'unknown' ? 'shown' : resultKind
  const resultOptions = canDisprove
    ? [['unknown','Disproved, unknown card'], ['shown','Showed exact card'], ['nobody','Nobody disproved'], ['unresolved','Only log guess']]
    : [['nobody','Nobody disproved'], ['unresolved','Only log guess']]

  function submit(override?: SuggestionResult) {
    const safeResultKind = canDisprove ? displayedResultKind : resultKind === 'nobody' ? 'nobody' : 'unresolved'
    const result: SuggestionResult = override ?? (safeResultKind === 'nobody' ? { kind: 'nobody' } : safeResultKind === 'shown' ? { kind: 'shown', disproverId, shownCardId: safeShownCardId } : safeResultKind === 'unknown' ? { kind: 'unknown', disproverId } : { kind: 'unresolved' })
    onAdd({ id: makeId(), suggesterId: suggester.id, cardIds: selectedCardIds, result, createdAt: new Date().getTime() })
    setQuickOpen(false)
    setResponderIndex(0)
  }

  function openQuickPlay() {
    setResponderIndex(0)
    setQuickOpen(true)
  }

  function markCannotDisprove() {
    if (responderIndex >= responderList.length - 1) submit({ kind: 'nobody' })
    else setResponderIndex((i) => i + 1)
  }

  function markCanDisprove(cardId?: string) {
    if (!currentResponder) return
    const currentOptions = possibleShownCards(game, solver, selectedCardIds, currentResponder.id)
    const fallbackShownCardId = currentOptions[0]?.id ?? suspect
    const result: SuggestionResult = cardId || suggester.isMe || currentResponder.isMe
      ? { kind: 'shown', disproverId: currentResponder.id, shownCardId: cardId ?? fallbackShownCardId }
      : { kind: 'unknown', disproverId: currentResponder.id }
    submit(result)
  }

  return <section className="suggestion-card">
    <div className="suggestion-title"><h2>Current suggestion</h2><button className="tiny" onClick={onSkip}>Skip suggester</button></div>
    <div className="current-turn-box"><span>Now asking</span><strong>{suggester.name}{suggester.id === me?.id ? ' (Me)' : ''}</strong><button className="tiny popout-button" onClick={openQuickPlay}>Pop out</button></div>
    <div className="form-grid">
      <CardSelect label="Suspect" type="suspect" game={game} solver={solver} showEnvelopeOdds value={suspect} onChange={(v) => { setSuspect(v); setShownCard(v) }} />
      <CardSelect label="Weapon" type="weapon" game={game} solver={solver} showEnvelopeOdds value={weapon} onChange={setWeapon} />
      <CardSelect label="Room" type="room" game={game} solver={solver} showEnvelopeOdds value={room} onChange={setRoom} />
      <Select label="Result" value={canDisprove ? displayedResultKind : 'nobody'} onChange={(v) => setResultKind(v as typeof resultKind)} options={resultOptions} />
      {canDisprove && displayedResultKind !== 'nobody' && displayedResultKind !== 'unresolved' && <Select label="Disprover" value={disproverId} onChange={setDisprover} options={responderOptions} />}
      {canDisprove && displayedResultKind === 'shown' && <Select label="Shown card" value={safeShownCardId} onChange={setShownCard} options={shownCardOptions.map((card) => [card.id, `${card.name} ? ${pct(solver.probabilities[card.id]?.envelope ?? 0)}`])} />}
    </div>
    {exactCardKnown && displayedResultKind === 'shown' && <p className="hint exact-hint">Because {suggester.isMe ? 'you are asking' : 'you are disproving'}, the result defaults to the exact card shown.</p>}
    <p className="microcopy">The solver automatically marks everyone between the suggester and disprover as unable to disprove.</p>
    <button className="primary wide" onClick={() => submit()}>Record evidence and advance turn</button>

    {quickOpen && <div className="modal-backdrop quick-suggestion-backdrop" role="dialog" aria-modal="true" onClick={() => setQuickOpen(false)}>
      <section className="quick-suggestion-modal panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><h1>Log suggestion</h1><p>{suggester.name}{suggester.id === me?.id ? ' (Me)' : ''} is asking.</p></div><button onClick={() => setQuickOpen(false)}>Close</button></div>
        <div className="form-grid quick-card-grid">
          <CardSelect label="Suspect" type="suspect" game={game} solver={solver} showEnvelopeOdds value={suspect} onChange={(v) => { setSuspect(v); setShownCard(v) }} />
          <CardSelect label="Weapon" type="weapon" game={game} solver={solver} showEnvelopeOdds value={weapon} onChange={setWeapon} />
          <CardSelect label="Room" type="room" game={game} solver={solver} showEnvelopeOdds value={room} onChange={setRoom} />
        </div>
        {currentResponder ? <div className="responder-step">
          <span>Next player</span>
          <strong>{currentResponder.name}{currentResponder.id === me?.id ? ' (Me)' : ''}</strong>
          {(suggester.isMe || currentResponder.isMe) ? <div className="shown-card-buttons">
            <p className="microcopy">If they can disprove, choose the exact card shown.</p>
            {possibleShownCards(game, solver, selectedCardIds, currentResponder.id).map((card) => <button className="primary" key={card.id} onClick={() => markCanDisprove(card.id)}>Showed {card.name}</button>)}
          </div> : <button className="primary wide" onClick={() => markCanDisprove()}>Can disprove</button>}
          <button className="wide" onClick={markCannotDisprove}>Cannot disprove</button>
        </div> : <button className="primary wide" onClick={() => submit({ kind: 'nobody' })}>Nobody disproved</button>}
        <button className="wide" onClick={() => { onSkip(); setQuickOpen(false) }}>Skip / advance asker</button>
      </section>
    </div>}
  </section>
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[][] }) {
  return <label className="field"><span>{label}</span><select value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
}
function CardSelect({ label, type, game, value, onChange, solver, showEnvelopeOdds = false }: { label: string; type: CardType; game: GameState; value: string; onChange: (v: string) => void; solver?: SolverResult; showEnvelopeOdds?: boolean }) {
  return <Select label={label} value={value} onChange={onChange} options={game.cards.filter((c) => c.type === type).map((c) => [c.id, showEnvelopeOdds && solver ? `${c.name} ? ${pct(solver.probabilities[c.id]?.envelope ?? 0)}` : c.name])} />
}

function envelopeLabel(game: GameState, solver: SolverResult, type: CardType) {
  const solved = game.cards.find((card) => card.type === type && (game.marks[card.id].envelope === 'yes' || solver.probabilities[card.id]?.envelope === 1))
  return solved ? ` - Envelope: ${solved.name}` : ''
}

function TypeHeader({ type, game, solver, collapsed, onToggle, colSpan }: { type: CardType; game: GameState; solver: SolverResult; collapsed: boolean; onToggle: () => void; colSpan: number }) {
  return <tr className="group-row"><td colSpan={colSpan}><button className="group-toggle" aria-label={`${collapsed ? 'Show' : 'Hide'} ${typeLabel[type]}`} onClick={onToggle}><span className="chevron">{collapsed ? '▶' : '▼'}</span>{typeLabel[type]}{envelopeLabel(game, solver, type)}</button></td></tr>
}

function ProbabilityMatrix({ game, solver, locations, selected, collapsedTypes, onToggleType, onSelect, onSetMark, onOpenCard }: { game: GameState; solver: SolverResult; locations: LocationId[]; selected: { cardId: string; locationId: LocationId } | null; collapsedTypes: Record<CardType, boolean>; onToggleType: (type: CardType) => void; onSelect: (s: { cardId: string; locationId: LocationId }) => void; onSetMark: (cardId: string, loc: LocationId, mark: Mark) => void; onOpenCard: (cardId: string) => void }) {
  return <div className="matrix-wrap"><table className="matrix"><thead><tr><th>Card</th>{locations.map((loc) => { const player = loc === 'envelope' ? null : playerById(game.players, loc); return <th key={loc} className={`${loc === 'envelope' ? 'envelope-col' : ''} ${player?.isMe ? 'me-col' : ''}`}>{loc === 'envelope' ? 'Envelope' : player?.name}</th> })}</tr></thead><tbody>
    {(['suspect', 'weapon', 'room'] as CardType[]).map((type) => <GroupedRows key={type} type={type} game={game} solver={solver} locations={locations} selected={selected} collapsed={collapsedTypes[type]} onToggle={() => onToggleType(type)} onSelect={onSelect} onSetMark={onSetMark} onOpenCard={onOpenCard} />)}
  </tbody><tfoot><tr><td>Known / unknown</td>{locations.map((loc) => loc === 'envelope' ? <td key={loc} className="envelope-col">3 cards</td> : <td key={loc} className={playerById(game.players, loc)?.isMe ? 'me-col' : ''}>{countsFor(game, loc, solver).known} known<br />{countsFor(game, loc, solver).unknownInHand} unknown</td>)}</tr></tfoot></table></div>
}

function GroupedRows({ type, game, solver, locations, selected, collapsed, onToggle, onSelect, onSetMark, onOpenCard }: { type: CardType; game: GameState; solver: SolverResult; locations: LocationId[]; selected: { cardId: string; locationId: LocationId } | null; collapsed: boolean; onToggle: () => void; onSelect: (s: { cardId: string; locationId: LocationId }) => void; onSetMark: (cardId: string, loc: LocationId, mark: Mark) => void; onOpenCard: (cardId: string) => void }) {
  return <>
    <TypeHeader type={type} game={game} solver={solver} collapsed={collapsed} onToggle={onToggle} colSpan={locations.length + 1} />
    {!collapsed && game.cards.filter((c) => c.type === type).map((card) => {
      const envelopeOut = game.marks[card.id].envelope === 'no' || (solver.probabilities[card.id]?.envelope ?? 0) === 0
      return <tr className={envelopeOut ? 'not-envelope-row' : ''} key={card.id}>
        <td className="card-name"><button className="card-link" onClick={() => onOpenCard(card.id)}>{card.name}</button></td>
        {locations.map((loc) => {
          const mark = game.marks[card.id][loc]
          const prob = solver.probabilities[card.id]?.[loc] ?? 0
          const isSelected = selected?.cardId === card.id && selected?.locationId === loc
          return <td key={loc} className={`prob-cell ${loc === 'envelope' ? 'envelope-col' : ''} ${playerById(game.players, loc)?.isMe ? 'me-col' : ''} ${loc === 'envelope' && envelopeOut ? 'envelope-out' : ''} ${isSelected ? 'selected' : ''} mark-${mark}`} onClick={() => onSelect({ cardId: card.id, locationId: loc })} onDoubleClick={() => onSetMark(card.id, loc, nextMark(mark))} style={{ '--p': prob } as React.CSSProperties}>
            {mark === 'yes' ? 'YES' : mark === 'no' ? 'no' : pct(prob)}
          </td>
        })}
      </tr>
    })}
  </>
}

function GuessMatrix({ game, solver, locations, collapsedTypes, onToggleType, onOpenCard }: { game: GameState; solver: SolverResult; locations: LocationId[]; collapsedTypes: Record<CardType, boolean>; onToggleType: (type: CardType) => void; onOpenCard: (cardId: string) => void }) {
  return <div className="matrix-wrap"><table className="matrix guess-matrix"><thead><tr><th>Card</th>{locations.map((loc) => <th key={loc} className={playerById(game.players, loc)?.isMe ? 'me-col' : ''}>{playerById(game.players, loc)?.name}</th>)}</tr></thead><tbody>
    {(['suspect', 'weapon', 'room'] as CardType[]).map((type) => <>
      <TypeHeader key={`${type}-group`} type={type} game={game} solver={solver} collapsed={collapsedTypes[type]} onToggle={() => onToggleType(type)} colSpan={locations.length + 1} />
      {!collapsedTypes[type] && game.cards.filter((c) => c.type === type).map((card) => <tr key={card.id}><td className="card-name"><button className="card-link" onClick={() => onOpenCard(card.id)}>{card.name}</button></td>{locations.map((loc) => {
        const count = guessCount(game, loc, card.id)
        const mark = game.marks[card.id][loc]
        const probability = solver.probabilities[card.id]?.[loc] ?? 0
        return <td className={`guess-cell ${playerById(game.players, loc)?.isMe ? 'me-col' : ''} ${count > 0 ? 'has-guesses' : ''}`} key={loc}><strong>{count}</strong><small>{mark === 'yes' ? 'known held' : mark === 'no' ? 'ruled out' : pct(probability)}</small></td>
      })}</tr>)}
    </>)}
  </tbody></table></div>
}


function CardDetailModal({ card, game, solver, onClose }: { card: Card; game: GameState; solver: SolverResult; onClose: () => void }) {
  const involved = game.suggestions.filter((s) => !s.disabled && s.cardIds.includes(card.id))
  const repeatedByPlayer = orderedPlayers(game.players)
    .map((player) => ({ player, count: involved.filter((s) => s.suggesterId === player.id).length }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count)
  const envelopeProbability = solver.probabilities[card.id]?.envelope ?? 0
  const holderProbabilities = orderedPlayers(game.players)
    .map((player) => ({ player, probability: solver.probabilities[card.id]?.[player.id] ?? 0, mark: game.marks[card.id]?.[player.id] ?? 'unknown' }))
    .sort((a, b) => b.probability - a.probability)

  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="card-detail-title" onClick={onClose}>
    <section className="card-modal panel" onClick={(event) => event.stopPropagation()}>
      <div className="modal-head">
        <div>
          <h1 id="card-detail-title">{card.name}</h1>
          <p>{typeLabel[card.type]} card - involved in {involved.length} logged suggestion{involved.length === 1 ? '' : 's'}</p>
        </div>
        <button onClick={onClose}>Close</button>
      </div>

      <div className="card-detail-grid">
        <section className="detail-block emphasis-block">
          <span>Envelope odds</span>
          <strong>{pct(envelopeProbability)}</strong>
          <p>If a player repeats this card and nobody reliably disproves it, this number is the hard-solver signal to watch.</p>
        </section>
        <section className="detail-block">
          <h2>Most likely holders</h2>
          <div className="prob-list">{holderProbabilities.slice(0, 4).map(({ player, probability, mark }) => <div key={player.id}><span>{player.name}</span><strong>{mark === 'yes' ? 'YES' : mark === 'no' ? 'no' : pct(probability)}</strong></div>)}</div>
        </section>
        <section className="detail-block">
          <h2>Repeat guesses</h2>
          <div className="repeat-list">{repeatedByPlayer.length ? repeatedByPlayer.map(({ player, count }) => <div key={player.id}><strong>{count}</strong><span>{player.name}</span></div>) : <p className="muted">No one has guessed this card yet.</p>}</div>
        </section>
      </div>

      <section className="detail-block action-history">
        <h2>Action history</h2>
        {involved.length ? involved.map((suggestion) => <CardActionRow key={suggestion.id} card={card} game={game} solver={solver} suggestion={suggestion} />) : <p className="muted">No logged suggestions include this card.</p>}
      </section>
    </section>
  </div>
}

function CardActionRow({ card, game, solver, suggestion }: { card: Card; game: GameState; solver: SolverResult; suggestion: Suggestion }) {
  const suggester = playerById(game.players, suggestion.suggesterId)?.name ?? 'Unknown player'
  const guessedCards = suggestion.cardIds.map((id) => cardById(game.cards, id)).filter((c): c is Card => Boolean(c))
  const otherCards = guessedCards.filter((c) => c.id !== card.id)
  const result = suggestion.result
  const time = new Date(suggestion.createdAt).toLocaleString()

  let resultLine = 'Only logged; no disproof result recorded.'
  let alternateLine = ''

  if (result.kind === 'nobody') {
    resultLine = 'Nobody disproved this suggestion.'
    alternateLine = 'That keeps envelope pressure on all three guessed cards unless other evidence rules them out.'
  } else if (result.kind === 'unknown') {
    const disprover = playerById(game.players, result.disproverId)?.name ?? 'Unknown player'
    const selectedProb = solver.probabilities[card.id]?.[result.disproverId] ?? 0
    const alternatives = otherCards
      .map((other) => ({ card: other, probability: solver.probabilities[other.id]?.[result.disproverId] ?? 0, mark: game.marks[other.id]?.[result.disproverId] ?? 'unknown' }))
      .sort((a, b) => b.probability - a.probability)
    resultLine = `${disprover} disproved it, but the shown card is unknown.`
    alternateLine = alternatives.length
      ? `If it was not ${card.name} (${pct(selectedProb)} for ${disprover}), likely alternatives: ${alternatives.map(({ card: other, probability, mark }) => `${other.name} ${mark === 'yes' ? 'YES' : mark === 'no' ? 'ruled out' : pct(probability)}`).join(', ')}.`
      : ''
  } else if (result.kind === 'shown') {
    const disprover = playerById(game.players, result.disproverId)?.name ?? 'Unknown player'
    const shown = cardById(game.cards, result.shownCardId)
    resultLine = shown?.id === card.id ? `${disprover} showed this exact card.` : `${disprover} disproved it by showing ${shown?.name ?? 'another card'}.`
    alternateLine = shown?.id === card.id ? 'This is direct evidence for this card holder.' : `So this action does not prove ${card.name} was held by ${disprover}.`
  }

  return <article className="action-row">
    <div className="action-main"><strong>{suggester}</strong><span>guessed {guessedCards.map((c) => c.name).join(' / ')}</span></div>
    <p>{resultLine}</p>
    {alternateLine && <small>{alternateLine}</small>}
    <time>{time}</time>
  </article>
}

function CurrentDeduction({ game, solver }: { game: GameState; solver: SolverResult }) {
  const accusation = (['suspect', 'weapon', 'room'] as CardType[]).map((type) => solver.envelopePick[type] ? cardById(game.cards, solver.envelopePick[type]!.cardId)?.name : '?')
  return <section className="deduction-card">
    <h2>Current deduction</h2>
    <div className="accusation"><span>{accusation[0]}</span><span>{accusation[1]}</span><span>{accusation[2]}</span></div>
    <div className="deduction-prob"><span>Combo probability</span><strong>{pct(solver.accusationProbability)}</strong></div>
    <div className={`status ${solver.status}`}>{solver.status === 'exact' ? 'Exact solver' : solver.status === 'capped' ? 'Capped enumeration' : 'Contradiction'}</div>
    {solver.messages.map((m) => <p className="message" key={m}>{m}</p>)}
  </section>
}

function SelectionInspector({ selectedCard, selectedLocation, selected, solver, stats, onSetMark }: { selectedCard: Card | null | undefined; selectedLocation: string | undefined; selected: { cardId: string; locationId: LocationId } | null; solver: SolverResult; stats: BehaviorStats; onSetMark: (cardId: string, loc: LocationId, mark: Mark) => void }) {
  if (!selected || !selectedCard) return <section><h2>Cell inspector</h2><p className="muted">Select a matrix cell to mark yes/no or inspect its reasoning.</p></section>
  const probability = solver.probabilities[selected.cardId]?.[selected.locationId] ?? 0
  const statKey = selected.locationId !== 'envelope' ? `${selected.locationId}:${selected.cardId}` : ''
  const stat = stats[statKey]
  return <section>
    <h2>Cell inspector</h2>
    <p><strong>{selectedCard.name}</strong> at <strong>{selectedLocation}</strong></p>
    <div className="big-prob">{pct(probability)}</div>
    <div className="button-row"><button onClick={() => onSetMark(selected.cardId, selected.locationId, 'yes')}>Mark yes</button><button onClick={() => onSetMark(selected.cardId, selected.locationId, 'no')}>Mark no</button><button onClick={() => onSetMark(selected.cardId, selected.locationId, 'unknown')}>Clear</button></div>
    {stat && <p className="hint">Behavior history: this player held this card in {stat.held}/{stat.suggested} logged suggestions.</p>}
  </section>
}

function EvidenceLog({ game, solver, likelyBadSuggestionIds, onToggleDisabled }: { game: GameState; solver: SolverResult; likelyBadSuggestionIds: Set<string>; onToggleDisabled: (id: string, disabled: boolean) => void }) {
  return <section className="matrix-subsection evidence-log">
    <h2>Evidence log</h2>
    <p className="microcopy">Probabilities below use the current board, so older entries update as new evidence is added.</p>
    {solver.status === 'contradiction' && <p className="hint danger-hint">
      Contradiction found. Highlighted entries are likely suspects because disabling that single entry makes the board valid again.
    </p>}
    <div className="log-list">
      {game.suggestions.length ? game.suggestions.map((s) => {
        const guessedCards = s.cardIds.map((id) => cardById(game.cards, id)).filter((card): card is Card => Boolean(card))
        const likelyBad = likelyBadSuggestionIds.has(s.id)
        return <article className={`log-item action-row ${s.disabled ? 'disabled-evidence' : ''} ${likelyBad ? 'likely-bad-evidence' : ''}`} key={s.id}>
          <div className="action-main">
            <strong>{playerById(game.players, s.suggesterId)?.name ?? 'Unknown player'}</strong>
            <span>guessed {guessedCards.map((card) => card.name).join(' / ')}</span>
          </div>
          <div className="evidence-actions">
            {likelyBad && <span className="suspect-pill">Likely bad entry</span>}
            {s.disabled && <span className="disabled-pill">Disabled</span>}
            <button className="tiny" onClick={() => onToggleDisabled(s.id, !s.disabled)}>{s.disabled ? 'Re-enable' : 'Disable'}</button>
          </div>
          <p>{resultText(game, s)}</p>
          <DisproverProbabilities game={game} solver={solver} suggestion={s} cards={guessedCards} />
          <time>{new Date(s.createdAt).toLocaleString()}</time>
        </article>
      }) : <p className="muted">No evidence logged yet.</p>}
    </div>
  </section>
}

function DisproverProbabilities({ game, solver, suggestion, cards }: { game: GameState; solver: SolverResult; suggestion: Suggestion; cards: Card[] }) {
  const disproverId = suggestion.result.kind === 'unknown' || suggestion.result.kind === 'shown' ? suggestion.result.disproverId : null
  if (!disproverId) return null
  const disprover = playerById(game.players, disproverId)?.name ?? 'Unknown player'
  return <div className="card-prob-strip" aria-label={`Probability ${disprover} has each guessed card`}>
    {cards.map((card) => {
      const mark = game.marks[card.id]?.[disproverId] ?? 'unknown'
      const wasShown = suggestion.result.kind === 'shown' && suggestion.result.shownCardId === card.id
      const label = wasShown ? 'shown' : mark === 'yes' ? 'YES' : mark === 'no' ? 'no' : pct(solver.probabilities[card.id]?.[disproverId] ?? 0)
      return <span className={`prob-chip ${wasShown ? 'shown' : ''}`} key={card.id}>
        <span>{card.name}</span>
        <strong>{label}</strong>
      </span>
    })}
  </div>
}
function resultText(game: GameState, s: Suggestion) {
  if (s.result.kind === 'nobody') return 'Nobody could disprove'
  if (s.result.kind === 'unknown') return `${playerById(game.players, s.result.disproverId)?.name} disproved; chance they hold each guessed card:`
  if (s.result.kind === 'shown') return `${playerById(game.players, s.result.disproverId)?.name} showed ${cardById(game.cards, s.result.shownCardId)?.name}`
  return 'Logged only'
}

function BehaviorPanel({ game, stats, onFinish }: { game: GameState; stats: BehaviorStats; onFinish: (e: Record<CardType,string>, h: Record<string,string[]>, p: string) => void }) {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<string>('middle')
  const top = Object.entries(stats).sort((a,b) => (b[1].held / Math.max(1,b[1].suggested)) - (a[1].held / Math.max(1,a[1].suggested))).slice(0, 3)
  function finishDemo() {
    const envelope: Record<CardType,string> = { suspect: game.cards.find((c)=>c.type==='suspect')!.id, weapon: game.cards.find((c)=>c.type==='weapon')!.id, room: game.cards.find((c)=>c.type==='room')!.id }
    const hands: Record<string,string[]> = {}
    for (const p of game.players) hands[p.id] = game.cards.filter((c) => game.marks[c.id][p.id] === 'yes').map((c) => c.id)
    onFinish(envelope, hands, phase)
    setOpen(false)
  }
  return <section className="behavior-card">
    <h2>Behavior hints</h2>
    <p className="muted">Finished games can teach how often each player suggests cards they hold. This stays separate from exact solver odds because skill and game phase matter.</p>
    <div className="top-hints">{top.length ? top.map(([key, s]) => <span key={key}>{key.split(':').map((id, i) => i ? cardById(game.cards,id)?.name : playerById(game.players,id)?.name).join(' / ')} to {pct(s.held / Math.max(1, s.suggested))}</span>) : <span>No completed games yet.</span>}</div>
    <button onClick={() => setOpen(!open)}>Finish game / learn</button>
    {open && <div className="finish-box"><Select label="Game phase tag" value={phase} onChange={setPhase} options={phaseOptions.map((p) => [p, p])} /><p className="muted">MVP: records suggested-card ownership from known marked hands. A hosted version should save full final hands in a database and model phase, player, and suggestion result.</p><button className="primary wide" onClick={finishDemo}>Store behavior sample</button></div>}
  </section>
}

export default App



