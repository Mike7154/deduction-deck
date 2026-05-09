import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import './App.css'
import { createBlankMarks, createDefaultGame, defaultCards, defaultPlayers, type Card, type CardType, type GameState, type LocationId, type Mark, type Player, type Suggestion, type SuggestionResult, typeLabel } from './types'
import { solveGame, type SolverResult } from './solver'

const saveKey = 'deduction-deck-game-v1'
const themeKey = 'deduction-deck-theme-v1'

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
    notes: game.notes ?? {},
    behaviorOptIn: game.behaviorOptIn ?? true,
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

const pct = (n: number) => `${Math.round(n * 100)}%`
function envelopeOddsLabel(game: GameState, solver: SolverResult, cardId: string) {
  const probability = solver.probabilities[cardId]?.envelope ?? 0
  const rounded = Math.round(probability * 100)
  if (rounded !== 0) return `${rounded}%`
  const holder = orderedPlayers(game.players).find((player) => game.marks[cardId]?.[player.id] === 'yes' || solver.probabilities[cardId]?.[player.id] === 1)
  return holder ? `0% (${holder.name})` : '0%'
}
const cardById = (cards: Card[], id: string) => cards.find((c) => c.id === id)
const playerById = (players: Player[], id: string) => players.find((p) => p.id === id)
const orderedPlayers = (players: Player[]) => [...players].sort((a, b) => a.turnOrder - b.turnOrder)
function matrixPlayers(players: Player[]) {
  const ordered = orderedPlayers(players)
  const meIndex = ordered.findIndex((player) => player.isMe)
  return meIndex < 0 ? ordered : [...ordered.slice(meIndex), ...ordered.slice(0, meIndex)]
}

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

function playersIShowedCardTo(game: GameState, cardId: string) {
  const meId = mePlayer(game.players)?.id
  if (!meId) return []
  const ids = new Set(game.suggestions
    .filter((suggestion) =>
      !suggestion.disabled &&
      suggestion.result.kind === 'shown' &&
      suggestion.result.disproverId === meId &&
      suggestion.result.shownCardId === cardId
    )
    .map((suggestion) => suggestion.suggesterId))
  return orderedPlayers(game.players).filter((player) => ids.has(player.id))
}

function wasCardShownByMeTo(game: GameState, cardId: string, playerId: string) {
  return playersIShowedCardTo(game, cardId).some((player) => player.id === playerId)
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
    notes: {},
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
    notes: {},
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
  const [selected, setSelected] = useState<{ cardId: string; locationId: LocationId } | null>(null)
  const [matrixMode, setMatrixMode] = useState<MatrixMode>('probabilities')
  const [detailCardId, setDetailCardId] = useState<string | null>(null)
  const [detailPlayerId, setDetailPlayerId] = useState<string | null>(null)
  const [quickMark, setQuickMark] = useState<{ cardId: string; locationId: LocationId } | null>(null)
  const [setupMode, setSetupMode] = useState(false)
  const [setupDraft, setSetupDraft] = useState<GameState>(() => createDefaultGame())
  const [collapsedTypes, setCollapsedTypes] = useState<Record<CardType, boolean>>({ suspect: false, weapon: false, room: false })
  const [undoStack, setUndoStack] = useState<GameState[]>([])
  const [theme, setTheme] = useState<ThemeMode>(loadTheme)
  const solver = useMemo(() => setupMode ? null : solveGame(game), [game, setupMode])
  const locations = useMemo(() => ['envelope', ...matrixPlayers(game.players).map((p) => p.id)], [game.players])
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
    setSelected(null)
    setQuickMark(null)
    setMatrixMode('probabilities')
    setDetailCardId(null)
    setDetailPlayerId(null)
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
    setDetailPlayerId(null)
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

  function setCardNote(cardId: string, note: string) {
    const next = structuredClone(game)
    next.notes ??= {}
    const trimmed = note.trim()
    if (trimmed) next.notes[cardId] = note
    else delete next.notes[cardId]
    updateGame(next)
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
  const detailPlayer = detailPlayerId ? playerById(game.players, detailPlayerId) : null
  const quickMarkCard = quickMark ? cardById(game.cards, quickMark.cardId) : null
  const quickMarkLocation = quickMark?.locationId === 'envelope' ? 'Envelope' : playerById(game.players, quickMark?.locationId ?? '')?.name

  if (setupMode) return <SetupScreen draft={setupDraft} onChange={setSetupDraft} onCancel={() => setSetupMode(false)} onStart={(draft) => { replaceGame(normalizeSetupGame(draft)); setSetupMode(false); setSelected(null); setQuickMark(null); setDetailCardId(null); setMatrixMode('probabilities') }} />
  if (!solver) return null

  return (
    <div className="app-shell" data-theme={theme}>
      <TopBar game={game} theme={theme} onToggleTheme={toggleTheme} canUndo={undoStack.length > 0} onUndo={undoLastChange} onResetLocal={resetLocalGame} onNew={() => { setSetupDraft(createDefaultGame()); setSetupMode(true); setDetailCardId(null); setDetailPlayerId(null) }} onSave={() => localStorage.setItem(userScopedKey(saveKey, profileId), JSON.stringify(game))} onImport={(imported) => { replaceGame(imported); setSelected(null); setQuickMark(null); setDetailCardId(null); setDetailPlayerId(null); setMatrixMode('probabilities'); setSetupMode(false) }} />
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
            ? <ProbabilityMatrix game={game} solver={solver} locations={locations} selected={selected} collapsedTypes={collapsedTypes} onToggleType={(type) => setCollapsedTypes((next) => ({ ...next, [type]: !next[type] }))} onSelect={(cell) => { setSelected(cell); setQuickMark(cell) }} onSetMark={setMark} onOpenCard={setDetailCardId} onOpenPlayer={setDetailPlayerId} />
            : <GuessMatrix game={game} solver={solver} locations={locations.filter((loc) => loc !== 'envelope')} collapsedTypes={collapsedTypes} onToggleType={(type) => setCollapsedTypes((next) => ({ ...next, [type]: !next[type] }))} onOpenCard={setDetailCardId} onOpenPlayer={setDetailPlayerId} />}
          <EvidenceLog game={game} solver={solver} likelyBadSuggestionIds={likelyBadSuggestionIds} onToggleDisabled={setSuggestionDisabled} />
        </section>

        <aside className="inspector panel">
          <CurrentDeduction game={game} solver={solver} />
          <SelectionInspector selectedCard={selectedCard} selectedLocation={selectedLocation} selected={selected} solver={solver} onSetMark={setMark} />
        </aside>
      </main>
      {quickMark && quickMarkCard && <QuickMarkSheet card={quickMarkCard} locationName={quickMarkLocation ?? quickMark.locationId} onSet={(mark) => setMark(quickMark.cardId, quickMark.locationId, mark)} onClose={() => setQuickMark(null)} />}
      {detailCard && <CardDetailModal card={detailCard} game={game} solver={solver} onSaveNote={setCardNote} onClose={() => setDetailCardId(null)} />}
      {detailPlayer && <PlayerDetailModal player={detailPlayer} game={game} solver={solver} onClose={() => setDetailPlayerId(null)} />}
    </div>
  )
}

function TopBar({ game, theme, onToggleTheme, canUndo, onUndo, onResetLocal, onNew, onSave, onImport }: { game: GameState; theme: ThemeMode; onToggleTheme: () => void; canUndo: boolean; onUndo: () => void; onResetLocal: () => void; onNew: () => void; onSave: () => void; onImport: (game: GameState) => void }) {
  const importInputRef = useRef<HTMLInputElement | null>(null)
  function exportJson() {
    const blob = new Blob([JSON.stringify(game, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'deduction-deck-game.json'
    a.click()
  }
  async function importJson(file: File | undefined) {
    if (!file) return
    try {
      const imported = JSON.parse(await file.text()) as GameState
      if (!Array.isArray(imported.cards) || !Array.isArray(imported.players) || !imported.marks || !Array.isArray(imported.suggestions)) throw new Error('Invalid game file')
      onImport(imported)
    } catch (error) {
      alert(`Could not import game: ${error instanceof Error ? error.message : 'invalid JSON'}`)
    } finally {
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }
  return <header className="topbar">
    <div className="brand"><span className="brand-mark">DD</span><div><strong>Deduction Deck</strong><small>Saved in this browser</small></div></div>
    <nav><button className="undo-button" onClick={onUndo} disabled={!canUndo}>Undo</button><button onClick={onToggleTheme}>{theme === 'dark' ? 'Light' : 'Dark'}</button><button onClick={onNew}>New Game</button><button onClick={onSave}>Save</button><button onClick={exportJson}>Export</button><button onClick={() => importInputRef.current?.click()}>Import</button><button onClick={onResetLocal}>Reload save</button><input ref={importInputRef} className="hidden-file-input" type="file" accept="application/json,.json" onChange={(event) => void importJson(event.target.files?.[0])} /></nav>
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
      <label className="hand-card-check">
        <input type="checkbox" checked={game.behaviorOptIn} onChange={(event) => onChange({ ...game, behaviorOptIn: event.target.checked })} />
        <span>Use behavior heuristics: no all-own-card guesses, and repeated guesses probably were not previously shown</span>
      </label>
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
      {canDisprove && displayedResultKind === 'shown' && <Select label="Shown card" value={safeShownCardId} onChange={setShownCard} options={shownCardOptions.map((card) => [card.id, `${card.name} - ${envelopeOddsLabel(game, solver, card.id)}`])} />}
    </div>
    {exactCardKnown && displayedResultKind === 'shown' && <p className="hint exact-hint">Because {suggester.isMe ? 'you are asking' : 'you are disproving'}, the result defaults to the exact card shown.</p>}
    <p className="microcopy">The solver automatically marks everyone between the suggester and disprover as unable to disprove.</p>
    <button className="primary wide" onClick={() => submit()}>Record evidence and advance turn</button>

    {quickOpen && <div className="modal-backdrop quick-suggestion-backdrop" role="dialog" aria-modal="true" onClick={() => setQuickOpen(false)}>
      <section className="quick-suggestion-modal panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><h1>Log suggestion</h1><div className="quick-asker-banner"><span>Asker</span><strong>{suggester.name}{suggester.id === me?.id ? ' (Me)' : ''}</strong></div></div><button onClick={() => setQuickOpen(false)}>Close</button></div>
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
  return <Select label={label} value={value} onChange={onChange} options={game.cards.filter((c) => c.type === type).map((c) => [c.id, showEnvelopeOdds && solver ? `${c.name} - ${envelopeOddsLabel(game, solver, c.id)}` : c.name])} />
}

function envelopeLabel(game: GameState, solver: SolverResult, type: CardType) {
  const solved = game.cards.find((card) => card.type === type && (game.marks[card.id].envelope === 'yes' || solver.probabilities[card.id]?.envelope === 1))
  return solved ? ` - Envelope: ${solved.name}` : ''
}

function TypeHeader({ type, game, solver, collapsed, onToggle, colSpan }: { type: CardType; game: GameState; solver: SolverResult; collapsed: boolean; onToggle: () => void; colSpan: number }) {
  return <tr className="group-row"><td colSpan={colSpan}><button className="group-toggle" aria-label={`${collapsed ? 'Show' : 'Hide'} ${typeLabel[type]}`} onClick={onToggle}><span className="chevron">{collapsed ? '▶' : '▼'}</span>{typeLabel[type]}{envelopeLabel(game, solver, type)}</button></td></tr>
}

function ProbabilityMatrix({ game, solver, locations, selected, collapsedTypes, onToggleType, onSelect, onSetMark, onOpenCard, onOpenPlayer }: { game: GameState; solver: SolverResult; locations: LocationId[]; selected: { cardId: string; locationId: LocationId } | null; collapsedTypes: Record<CardType, boolean>; onToggleType: (type: CardType) => void; onSelect: (s: { cardId: string; locationId: LocationId }) => void; onSetMark: (cardId: string, loc: LocationId, mark: Mark) => void; onOpenCard: (cardId: string) => void; onOpenPlayer: (playerId: string) => void }) {
  return <div className="matrix-wrap"><table className="matrix"><thead><tr><th>Card</th>{locations.map((loc) => { const player = loc === 'envelope' ? null : playerById(game.players, loc); return <th key={loc} className={`${loc === 'envelope' ? 'envelope-col' : ''} ${player?.isMe ? 'me-col' : ''}`}>{loc === 'envelope' ? 'Envelope' : <button className="header-link" onClick={() => onOpenPlayer(loc)}>{player?.name}</button>}</th> })}</tr></thead><tbody>
    {(['suspect', 'weapon', 'room'] as CardType[]).map((type) => <GroupedRows key={type} type={type} game={game} solver={solver} locations={locations} selected={selected} collapsed={collapsedTypes[type]} onToggle={() => onToggleType(type)} onSelect={onSelect} onSetMark={onSetMark} onOpenCard={onOpenCard} />)}
  </tbody><tfoot><tr><td>Known / unknown</td>{locations.map((loc) => loc === 'envelope' ? <td key={loc} className="envelope-col">3 cards</td> : <td key={loc} className={playerById(game.players, loc)?.isMe ? 'me-col' : ''}>{countsFor(game, loc, solver).known} known<br />{countsFor(game, loc, solver).unknownInHand} unknown</td>)}</tr></tfoot></table></div>
}

function GroupedRows({ type, game, solver, locations, selected, collapsed, onToggle, onSelect, onSetMark, onOpenCard }: { type: CardType; game: GameState; solver: SolverResult; locations: LocationId[]; selected: { cardId: string; locationId: LocationId } | null; collapsed: boolean; onToggle: () => void; onSelect: (s: { cardId: string; locationId: LocationId }) => void; onSetMark: (cardId: string, loc: LocationId, mark: Mark) => void; onOpenCard: (cardId: string) => void }) {
  return <>
    <TypeHeader type={type} game={game} solver={solver} collapsed={collapsed} onToggle={onToggle} colSpan={locations.length + 1} />
    {!collapsed && game.cards.filter((c) => c.type === type).map((card) => {
      const envelopeOut = game.marks[card.id].envelope === 'no' || (solver.probabilities[card.id]?.envelope ?? 0) === 0
      return <tr className={envelopeOut ? 'not-envelope-row' : ''} key={card.id}>
        <td className="card-name"><button className="card-link" onClick={() => onOpenCard(card.id)}>{card.name}{game.notes?.[card.id]?.trim() && <span className="note-badge" title={game.notes[card.id]}>📝</span>}</button></td>
        {locations.map((loc) => {
          const mark = game.marks[card.id][loc]
          const prob = solver.probabilities[card.id]?.[loc] ?? 0
          const isSelected = selected?.cardId === card.id && selected?.locationId === loc
          const player = loc === 'envelope' ? null : playerById(game.players, loc)
          const shownByMe = Boolean(player && !player.isMe && wasCardShownByMeTo(game, card.id, player.id))
          const label = mark === 'yes' ? 'YES' : shownByMe ? 'shown' : mark === 'no' ? 'no' : pct(prob)
          return <td key={loc} className={`prob-cell ${shownByMe ? 'shown-to-player' : ''} ${loc === 'envelope' ? 'envelope-col' : ''} ${player?.isMe ? 'me-col' : ''} ${loc === 'envelope' && envelopeOut ? 'envelope-out' : ''} ${isSelected ? 'selected' : ''} mark-${mark}`} title={shownByMe ? `You showed ${card.name} to ${player?.name}` : undefined} onClick={() => onSelect({ cardId: card.id, locationId: loc })} onDoubleClick={() => onSetMark(card.id, loc, nextMark(mark))} style={{ '--p': prob } as React.CSSProperties}>
            {label}
          </td>
        })}
      </tr>
    })}
  </>
}

function GuessMatrix({ game, solver, locations, collapsedTypes, onToggleType, onOpenCard, onOpenPlayer }: { game: GameState; solver: SolverResult; locations: LocationId[]; collapsedTypes: Record<CardType, boolean>; onToggleType: (type: CardType) => void; onOpenCard: (cardId: string) => void; onOpenPlayer: (playerId: string) => void }) {
  return <div className="matrix-wrap"><table className="matrix guess-matrix"><thead><tr><th>Card</th>{locations.map((loc) => <th key={loc} className={playerById(game.players, loc)?.isMe ? 'me-col' : ''}><button className="header-link" onClick={() => onOpenPlayer(loc)}>{playerById(game.players, loc)?.name}</button></th>)}</tr></thead><tbody>
    {(['suspect', 'weapon', 'room'] as CardType[]).map((type) => <>
      <TypeHeader key={`${type}-group`} type={type} game={game} solver={solver} collapsed={collapsedTypes[type]} onToggle={() => onToggleType(type)} colSpan={locations.length + 1} />
      {!collapsedTypes[type] && game.cards.filter((c) => c.type === type).map((card) => <tr key={card.id}><td className="card-name"><button className="card-link" onClick={() => onOpenCard(card.id)}>{card.name}{game.notes?.[card.id]?.trim() && <span className="note-badge" title={game.notes[card.id]}>📝</span>}</button></td>{locations.map((loc) => {
        const count = guessCount(game, loc, card.id)
        const mark = game.marks[card.id][loc]
        const probability = solver.probabilities[card.id]?.[loc] ?? 0
        return <td className={`guess-cell ${playerById(game.players, loc)?.isMe ? 'me-col' : ''} ${count > 0 ? 'has-guesses' : ''}`} key={loc}><strong>{count}</strong><small>{mark === 'yes' ? 'known held' : mark === 'no' ? 'ruled out' : pct(probability)}</small></td>
      })}</tr>)}
    </>)}
  </tbody></table></div>
}

function cardList(game: GameState, ids: readonly string[]) {
  return ids.map((id) => cardById(game.cards, id)).filter((card): card is Card => Boolean(card))
}

function comboLabel(game: GameState, ids: readonly string[]) {
  return cardList(game, ids).map((card) => card.name).join(' / ')
}

function playerBehaviorNotes(game: GameState, solver: SolverResult, player: Player) {
  const active = game.suggestions.filter((s) => !s.disabled).sort((a, b) => a.createdAt - b.createdAt)
  const notes: Array<{ title: string; text: string; cards: Card[] }> = []
  for (const [index, suggestion] of active.entries()) {
    if (suggestion.result.kind !== 'unknown') continue
    const laterBySameSuggester = active.slice(index + 1).filter((later) => later.suggesterId === suggestion.suggesterId)
    const repeated = new Set<string>()
    for (const later of laterBySameSuggester) for (const cardId of later.cardIds) if (suggestion.cardIds.includes(cardId)) repeated.add(cardId)
    if (!repeated.size) continue
    const alternatives = suggestion.cardIds.filter((cardId) => !repeated.has(cardId))
    const disproverId = suggestion.result.disproverId
    const repeatedForced = [...repeated].some((cardId) => (solver.probabilities[cardId]?.[disproverId] ?? 0) === 1)
    const alternativeForced = alternatives.some((cardId) => (solver.probabilities[cardId]?.[disproverId] ?? 0) === 1)
    if (suggestion.suggesterId === player.id) {
      notes.push({
        title: repeatedForced || alternativeForced ? 'Repeat clue skipped' : 'Repeated a card after an unknown show',
        text: `${player.name} later repeated ${comboLabel(game, [...repeated])}. ${repeatedForced ? 'The repeated card is now forced to the disprover, so the solver skips this behavior weight.' : alternativeForced ? 'A non-repeated alternative is now forced to the disprover, so the behavior explanation is already satisfied and the solver skips this weight.' : `Behavior weighting treats the repeated card(s) as less likely to have been shown earlier, pushing toward ${comboLabel(game, alternatives)} if those are still plausible.`}`,
        cards: cardList(game, suggestion.cardIds),
      })
    }
    if (suggestion.result.disproverId === player.id) {
      const alreadyExplained = repeatedForced || alternativeForced
      notes.push({
        title: alreadyExplained ? 'Repeat clue skipped' : 'Repeat clue affects this disproof',
        text: `${player.name} disproved ${comboLabel(game, suggestion.cardIds)}. The asker later repeated ${comboLabel(game, [...repeated])}. ${repeatedForced ? 'Because the repeated card is now forced to this disprover, the solver skips this behavior weight.' : alternativeForced ? 'Because a non-repeated alternative is already forced to this disprover, the behavior explanation is satisfied and the solver skips this weight.' : `The behavior model favors ${comboLabel(game, alternatives)} as what ${player.name} may have shown.`}`,
        cards: cardList(game, suggestion.cardIds),
      })
    }
  }
  return notes
}

function PlayerDetailModal({ player, game, solver, onClose }: { player: Player; game: GameState; solver: SolverResult; onClose: () => void }) {
  const asked = game.suggestions.filter((s) => !s.disabled && s.suggesterId === player.id)
  const disproved = game.suggestions.filter((s) => !s.disabled && (s.result.kind === 'unknown' || s.result.kind === 'shown') && s.result.disproverId === player.id)
  const repeatedCards = game.cards
    .map((card) => ({ card, count: asked.filter((s) => s.cardIds.includes(card.id)).length, probability: solver.probabilities[card.id]?.[player.id] ?? 0, envelope: solver.probabilities[card.id]?.envelope ?? 0 }))
    .filter(({ count }) => count > 1)
    .sort((a, b) => b.count - a.count || b.envelope - a.envelope)
  const behaviorNotes = playerBehaviorNotes(game, solver, player)
  const holdings = game.cards
    .map((card) => ({ card, probability: solver.probabilities[card.id]?.[player.id] ?? 0, mark: game.marks[card.id]?.[player.id] ?? 'unknown' }))
    .filter(({ probability, mark }) => probability > 0 || mark === 'yes')
    .sort((a, b) => b.probability - a.probability)

  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="player-detail-title" onClick={onClose}>
    <section className="card-modal player-modal panel" onClick={(event) => event.stopPropagation()}>
      <div className="modal-head">
        <div>
          <h1 id="player-detail-title">{player.name}{player.isMe ? ' (Me)' : ''}</h1>
          <p>{asked.length} suggestion{asked.length === 1 ? '' : 's'} made - {disproved.length} disproof{disproved.length === 1 ? '' : 's'} logged - {countsFor(game, player.id, solver).known}/{player.cardCount} cards known</p>
        </div>
        <button onClick={onClose}>Close</button>
      </div>

      <div className="card-detail-grid">
        <section className="detail-block">
          <h2>Likely hand</h2>
          <div className="prob-list">{holdings.slice(0, 6).map(({ card, probability, mark }) => <div key={card.id}><span>{card.name}</span><strong>{mark === 'yes' ? 'YES' : pct(probability)}</strong></div>)}</div>
        </section>
        <section className="detail-block">
          <h2>Top repeated guesses</h2>
          <div className="repeat-list">{repeatedCards.length ? repeatedCards.slice(0, 6).map(({ card, count, probability, envelope }) => <div key={card.id}><strong>{count}x</strong><span>{card.name} - held {pct(probability)}, env {pct(envelope)}</span></div>) : <p className="muted">No repeated guessed cards.</p>}</div>
        </section>
        <section className="detail-block emphasis-block">
          <span>Behavior explanations</span>
          <strong>{behaviorNotes.length}</strong>
          <p>These are soft hints. They explain where behavior weighting may be nudging the probabilities, not hard Clue rules.</p>
        </section>
      </div>

      <section className="detail-block action-history">
        <h2>Suggestions they made</h2>
        {asked.length ? asked.map((suggestion) => <PlayerSuggestionRow key={suggestion.id} game={game} solver={solver} suggestion={suggestion} />) : <p className="muted">No suggestions made.</p>}
      </section>
      <section className="detail-block action-history">
        <h2>Suggestions they disproved</h2>
        {disproved.length ? disproved.map((suggestion) => <PlayerSuggestionRow key={suggestion.id} game={game} solver={solver} suggestion={suggestion} focusPlayerId={player.id} />) : <p className="muted">No disproofs logged.</p>}
      </section>
      <section className="detail-block action-history">
        <h2>Behavior heuristic notes</h2>
        {behaviorNotes.length ? behaviorNotes.map((note, index) => <article className="action-row" key={`${note.title}-${index}`}><div className="action-main"><strong>{note.title}</strong><span>{note.cards.map((card) => card.name).join(' / ')}</span></div><p>{note.text}</p></article>) : <p className="muted">No repeat-card behavior weights currently involve this player.</p>}
      </section>
    </section>
  </div>
}

function PlayerSuggestionRow({ game, solver, suggestion, focusPlayerId }: { game: GameState; solver: SolverResult; suggestion: Suggestion; focusPlayerId?: string }) {
  const guessedCards = cardList(game, suggestion.cardIds)
  const suggester = playerById(game.players, suggestion.suggesterId)?.name ?? 'Unknown player'
  const result = resultText(game, suggestion)
  const targetId = focusPlayerId ?? (suggestion.result.kind === 'unknown' || suggestion.result.kind === 'shown' ? suggestion.result.disproverId : suggestion.suggesterId)
  return <article className="action-row">
    <div className="action-main"><strong>{suggester}</strong><span>{comboLabel(game, suggestion.cardIds)}</span></div>
    <p>{result}</p>
    <div className="card-prob-strip">{guessedCards.map((card) => <span className="prob-chip" key={card.id}><span>{card.name}</span><strong>{targetId ? pct(solver.probabilities[card.id]?.[targetId] ?? 0) : pct(solver.probabilities[card.id]?.envelope ?? 0)}</strong></span>)}</div>
    <small>{focusPlayerId ? `Chips show chance ${playerById(game.players, focusPlayerId)?.name} holds each guessed card.` : 'Chips show current holder odds for the disprover/suggester context.'}</small>
    <time>{new Date(suggestion.createdAt).toLocaleString()}</time>
  </article>
}


function CardDetailModal({ card, game, solver, onSaveNote, onClose }: { card: Card; game: GameState; solver: SolverResult; onSaveNote: (cardId: string, note: string) => void; onClose: () => void }) {
  const [note, setNote] = useState(game.notes?.[card.id] ?? '')
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

      <section className="detail-block note-editor emphasis-note">
        <h2>My note</h2>
        <input value={note} maxLength={120} placeholder="Short note, e.g. Green keeps probing this" onChange={(event) => setNote(event.target.value)} />
        <div className="button-row"><button className="primary" onClick={() => onSaveNote(card.id, note)}>Save note</button><button onClick={() => { setNote(''); onSaveNote(card.id, '') }}>Clear</button></div>
      </section>

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
  const [behaviorOpen, setBehaviorOpen] = useState(false)
  const accusation = (['suspect', 'weapon', 'room'] as CardType[]).map((type) => solver.envelopePick[type] ? cardById(game.cards, solver.envelopePick[type]!.cardId)?.name : '?')
  return <section className="deduction-card">
    <h2>Current deduction</h2>
    <div className="accusation"><span>{accusation[0]}</span><span>{accusation[1]}</span><span>{accusation[2]}</span></div>
    <div className="deduction-prob"><span>Combo probability</span><strong>{pct(solver.accusationProbability)}</strong></div>
    <div className={`status ${solver.status}`}>{solver.status === 'exact' ? 'Exact solver' : solver.status === 'capped' ? 'Capped enumeration' : 'Contradiction'}</div>
    {solver.behaviorWeights.length > 0 && <button className="wide behavior-impact-button" onClick={() => setBehaviorOpen(true)}>View {solver.behaviorWeights.length} behavior impact{solver.behaviorWeights.length === 1 ? '' : 's'}</button>}
    {solver.status === 'contradiction' && game.behaviorOptIn && <p className="message">Behavior heuristics are on. If the entries are correct, try turning them off in Game setup; the contradiction may mean someone guessed all three cards from their own hand.</p>}
    {solver.messages.map((m) => <p className="message" key={m}>{m}</p>)}
    {behaviorOpen && <BehaviorWeightsModal game={game} solver={solver} onClose={() => setBehaviorOpen(false)} />}
  </section>
}

function BehaviorWeightsModal({ game, solver, onClose }: { game: GameState; solver: SolverResult; onClose: () => void }) {
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="behavior-impact-title" onClick={onClose}>
    <section className="card-modal panel" onClick={(event) => event.stopPropagation()}>
      <div className="modal-head">
        <div>
          <h1 id="behavior-impact-title">Behavior impacts</h1>
          <p>These are active soft assumptions from player behavior. They nudge probabilities, but they are not hard Clue rules.</p>
        </div>
        <button onClick={onClose}>Close</button>
      </div>
      <section className="detail-block action-history">
        {solver.behaviorWeights.map((weight, index) => {
          const disprover = playerById(game.players, weight.playerId)?.name ?? 'Unknown player'
          return <article className="action-row" key={`${weight.playerId}-${weight.cardIds.join('-')}-${index}`}>
            <div className="action-main"><strong>{disprover} disproved an earlier suggestion</strong><span>{comboLabel(game, [...weight.cardIds, ...weight.repeatedCardIds])}</span></div>
            <p>The asker later guessed <strong>{comboLabel(game, weight.repeatedCardIds)}</strong> again. The behavior model treats it as less likely that {disprover} had shown that repeated card earlier, so it shifts weight toward <strong>{comboLabel(game, weight.cardIds)}</strong> as the card {disprover} may have shown.</p>
            <small>Repeated-card explanation weight: {Math.round(weight.penalty * 100)}%. Lower means the repeat is treated as stronger evidence against that card having been shown.</small>
          </article>
        })}
      </section>
    </section>
  </div>
}

function SelectionInspector({ selectedCard, selectedLocation, selected, solver, onSetMark }: { selectedCard: Card | null | undefined; selectedLocation: string | undefined; selected: { cardId: string; locationId: LocationId } | null; solver: SolverResult; onSetMark: (cardId: string, loc: LocationId, mark: Mark) => void }) {
  if (!selected || !selectedCard) return <section><h2>Cell inspector</h2><p className="muted">Select a matrix cell to mark yes/no or inspect its reasoning.</p></section>
  const probability = solver.probabilities[selected.cardId]?.[selected.locationId] ?? 0
  return <section>
    <h2>Cell inspector</h2>
    <p><strong>{selectedCard.name}</strong> at <strong>{selectedLocation}</strong></p>
    <div className="big-prob">{pct(probability)}</div>
    <div className="button-row"><button onClick={() => onSetMark(selected.cardId, selected.locationId, 'yes')}>Mark yes</button><button onClick={() => onSetMark(selected.cardId, selected.locationId, 'no')}>Mark no</button><button onClick={() => onSetMark(selected.cardId, selected.locationId, 'unknown')}>Clear</button></div>
  </section>
}

function EvidenceLog({ game, solver, likelyBadSuggestionIds, onToggleDisabled }: { game: GameState; solver: SolverResult; likelyBadSuggestionIds: Set<string>; onToggleDisabled: (id: string, disabled: boolean) => void }) {
  return <section className="matrix-subsection evidence-log">
    <h2>Evidence log</h2>
    <p className="microcopy">Probabilities below use the current board, so older entries update as new evidence is added.</p>
    {solver.status === 'contradiction' && <p className="hint danger-hint">
      Contradiction found. Highlighted entries are likely suspects because disabling that single entry makes the board valid again. If no entry looks wrong, turn off behavior heuristics in Game setup; someone may have guessed all three cards from their own hand.
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
      const disproverProbability = solver.probabilities[card.id]?.[disproverId] ?? 0
      const probabilityLabel = pct(disproverProbability)
      const label = wasShown ? 'shown' : mark === 'yes' ? 'YES' : mark === 'no' ? 'no' : probabilityLabel
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


export default App



