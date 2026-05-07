import { useMemo, useState } from 'react'
import './App.css'
import { createBlankMarks, createDefaultGame, defaultCards, defaultPlayers, type BehaviorStats, type Card, type CardType, type GameState, type LocationId, type Mark, type Player, type Suggestion, type SuggestionResult, typeLabel } from './types'
import { solveGame, type SolverResult } from './solver'

const saveKey = 'deduction-deck-game-v1'
const statsKey = 'deduction-deck-behavior-stats-v1'
const usersKey = 'deduction-deck-users-v1'
const sessionKey = 'deduction-deck-current-user-v1'
const phaseOptions = ['opening', 'middle', 'endgame'] as const

type MatrixMode = 'probabilities' | 'guesses'
type AuthMode = 'login' | 'signup'
type UserAccount = { email: string; createdAt: number }

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function isValidEmail(email: string) {
  return emailPattern.test(normalizeEmail(email))
}

function userScopedKey(baseKey: string, email: string) {
  return `${baseKey}:${encodeURIComponent(normalizeEmail(email))}`
}

function loadUsers(): UserAccount[] {
  try {
    return JSON.parse(localStorage.getItem(usersKey) ?? '[]') as UserAccount[]
  } catch {
    return []
  }
}

function saveUsers(users: UserAccount[]) {
  localStorage.setItem(usersKey, JSON.stringify(users))
}

function loadSession() {
  const email = normalizeEmail(localStorage.getItem(sessionKey) ?? '')
  return email && loadUsers().some((u) => u.email === email) ? email : null
}

function hydrateGame(game: GameState): GameState {
  return {
    ...game,
    activeSuggesterId: game.activeSuggesterId ?? [...game.players].sort((a, b) => a.turnOrder - b.turnOrder)[0]?.id ?? game.players[0]?.id ?? 'me',
  }
}

function loadGame(email: string): GameState {
  try {
    const scopedKey = userScopedKey(saveKey, email)
    const raw = localStorage.getItem(scopedKey)
    if (raw) return hydrateGame(JSON.parse(raw) as GameState)
  } catch { /* noop */ }
  return createDefaultGame()
}

function loadStats(email: string): BehaviorStats {
  try {
    const scopedKey = userScopedKey(statsKey, email)
    return JSON.parse(localStorage.getItem(scopedKey) ?? '{}') as BehaviorStats
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

function distributeCardCounts(players: Player[], cardTotal: number) {
  const dealCount = Math.max(0, cardTotal - 3)
  const count = Math.max(1, players.length)
  return players.map((p, i) => ({ ...p, cardCount: Math.floor(dealCount / count) + (i < dealCount % count ? 1 : 0) }))
}

function normalizeSetupGame(draft: GameState): GameState {
  const usedPlayers = new Set<string>()
  const players = renumberPlayers(draft.players.map((player, index) => ({
    ...player,
    id: uniqueId(player.id || slugify(player.name, `player-${index + 1}`), usedPlayers),
    name: player.name.trim() || `Player ${index + 1}`,
    cardCount: Math.max(0, Number(player.cardCount) || 0),
  })))

  const usedCards = new Set<string>()
  const cards = draft.cards.map((card, index) => ({
    ...card,
    id: uniqueId(card.id || slugify(card.name, `${card.type}-${index + 1}`), usedCards),
    name: card.name.trim() || `${typeLabel[card.type].slice(0, -1)} ${index + 1}`,
  }))

  return {
    cards,
    players,
    marks: createBlankMarks(cards, players),
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

function countsFor(game: GameState, playerId: string) {
  const known = game.cards.filter((c) => game.marks[c.id]?.[playerId] === 'yes').length
  const impossible = game.cards.filter((c) => game.marks[c.id]?.[playerId] === 'no').length
  const target = playerById(game.players, playerId)?.cardCount ?? 0
  return { known, unknownInHand: Math.max(0, target - known), possible: game.cards.length - known - impossible }
}

function guessCount(game: GameState, playerId: string, cardId: string) {
  return game.suggestions.filter((s) => s.suggesterId === playerId && s.cardIds.includes(cardId)).length
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

function App() {
  const [userEmail, setUserEmail] = useState<string | null>(loadSession)
  const [game, setGame] = useState<GameState>(() => userEmail ? loadGame(userEmail) : createDefaultGame())
  const [stats, setStats] = useState<BehaviorStats>(() => userEmail ? loadStats(userEmail) : {})
  const [selected, setSelected] = useState<{ cardId: string; locationId: LocationId } | null>(null)
  const [matrixMode, setMatrixMode] = useState<MatrixMode>('probabilities')
  const [detailCardId, setDetailCardId] = useState<string | null>(null)
  const [setupMode, setSetupMode] = useState(false)
  const [setupDraft, setSetupDraft] = useState<GameState>(() => createDefaultGame())
  const [collapsedTypes, setCollapsedTypes] = useState<Record<CardType, boolean>>({ suspect: false, weapon: false, room: false })
  const solver = useMemo(() => setupMode ? null : solveGame(game), [game, setupMode])
  const locations = useMemo(() => ['envelope', ...orderedPlayers(game.players).map((p) => p.id)], [game.players])

  function activateUser(email: string) {
    const normalized = normalizeEmail(email)
    localStorage.setItem(sessionKey, normalized)
    setUserEmail(normalized)
    setGame(loadGame(normalized))
    setStats(loadStats(normalized))
    setSelected(null)
    setMatrixMode('probabilities')
    setDetailCardId(null)
    setSetupMode(false)
    setSetupDraft(createDefaultGame())
  }

  function logout() {
    localStorage.removeItem(sessionKey)
    setUserEmail(null)
    setSelected(null)
    setDetailCardId(null)
    setSetupMode(false)
  }

  function updateGame(next: GameState) {
    if (!userEmail) return
    const hydrated = hydrateGame(next)
    setGame(hydrated)
    localStorage.setItem(userScopedKey(saveKey, userEmail), JSON.stringify(hydrated))
  }

  function setMark(cardId: string, locationId: LocationId, mark: Mark) {
    const next = structuredClone(game)
    next.marks[cardId][locationId] = mark
    if (mark === 'yes') {
      for (const loc of locations) if (loc !== locationId) next.marks[cardId][loc] = 'no'
    }
    updateGame(next)
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

  function finishGame(envelope: Record<CardType, string>, playerHands: Record<string, string[]>, phase: string) {
    if (!userEmail) return
    const nextStats = structuredClone(stats)
    for (const suggestion of game.suggestions) {
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
    localStorage.setItem(userScopedKey(statsKey, userEmail), JSON.stringify(nextStats))
    updateGame(nextGame)
  }

  const selectedCard = selected ? cardById(game.cards, selected.cardId) : null
  const selectedLocation = selected?.locationId === 'envelope' ? 'Envelope' : playerById(game.players, selected?.locationId ?? '')?.name
  const detailCard = detailCardId ? cardById(game.cards, detailCardId) : null

  if (!userEmail) return <AuthScreen onAuthenticated={activateUser} />
  if (setupMode) return <SetupScreen draft={setupDraft} onChange={setSetupDraft} onCancel={() => setSetupMode(false)} onStart={(draft) => { updateGame(normalizeSetupGame(draft)); setSetupMode(false); setSelected(null); setDetailCardId(null); setMatrixMode('probabilities') }} onLogout={logout} />
  if (!solver) return null

  return (
    <div className="app-shell">
      <TopBar game={game} userEmail={userEmail} onLogout={logout} onNew={() => { setSetupDraft(createDefaultGame()); setSetupMode(true); setDetailCardId(null) }} onSave={() => localStorage.setItem(userScopedKey(saveKey, userEmail), JSON.stringify(game))} />
      <main className="workspace">
        <aside className="sidebar panel">
          <GameSummary game={game} onChange={updateGame} onEditSetup={() => { setSetupDraft(resetKnownEvidence(game)); setSetupMode(true); setDetailCardId(null) }} />
          <SuggestionForm key={game.activeSuggesterId} game={game} onAdd={addSuggestion} onSkip={skipSuggester} />
          <EvidenceLog game={game} />
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
            ? <ProbabilityMatrix game={game} solver={solver} locations={locations} selected={selected} collapsedTypes={collapsedTypes} onToggleType={(type) => setCollapsedTypes((next) => ({ ...next, [type]: !next[type] }))} onSelect={setSelected} onSetMark={setMark} onOpenCard={setDetailCardId} />
            : <GuessMatrix game={game} solver={solver} locations={locations.filter((loc) => loc !== 'envelope')} collapsedTypes={collapsedTypes} onToggleType={(type) => setCollapsedTypes((next) => ({ ...next, [type]: !next[type] }))} onOpenCard={setDetailCardId} />}
        </section>

        <aside className="inspector panel">
          <CurrentDeduction game={game} solver={solver} />
          <SelectionInspector selectedCard={selectedCard} selectedLocation={selectedLocation} selected={selected} solver={solver} stats={stats} onSetMark={setMark} />
          <BehaviorPanel game={game} stats={stats} onFinish={finishGame} />
        </aside>
      </main>
      {detailCard && <CardDetailModal card={detailCard} game={game} solver={solver} onClose={() => setDetailCardId(null)} />}
    </div>
  )
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (email: string) => void }) {
  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')

  function submit() {
    const normalized = normalizeEmail(email)
    if (!isValidEmail(normalized)) {
      setError('Enter a valid email address.')
      return
    }

    const users = loadUsers()
    const exists = users.some((u) => u.email === normalized)
    if (mode === 'signup') {
      if (exists) {
        setError('That email already has an account. Log in instead.')
        return
      }
      saveUsers([...users, { email: normalized, createdAt: Date.now() }])
      onAuthenticated(normalized)
      return
    }

    if (!exists) saveUsers([...users, { email: normalized, createdAt: Date.now() }])
    onAuthenticated(normalized)
  }

  return <div className="auth-shell">
    <section className="auth-card panel">
      <div className="brand auth-brand"><span className="brand-mark">DD</span><div><strong>Deduction Deck</strong><small>Private local game spaces</small></div></div>
      <h1>{mode === 'login' ? 'Log in' : 'Sign up'}</h1>
      <p className="muted">Use a valid email to keep each player's game board and behavior hints separate on this device.</p>
      <label className="field"><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(e) => { setEmail(e.target.value); setError('') }} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} placeholder="you@example.com" /></label>
      {error && <p className="auth-error">{error}</p>}
      <button className="primary wide" onClick={submit}>{mode === 'login' ? 'Log in' : 'Create account'}</button>
      <button className="link-button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError('') }}>{mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in'}</button>
      <p className="local-note">Accounts are local to this browser. If the account list is missing after an update, logging in with the same email will relink that local save.</p>
    </section>
  </div>
}

function TopBar({ game, userEmail, onLogout, onNew, onSave }: { game: GameState; userEmail: string; onLogout: () => void; onNew: () => void; onSave: () => void }) {
  function exportJson() {
    const blob = new Blob([JSON.stringify(game, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'deduction-deck-game.json'
    a.click()
  }
  return <header className="topbar">
    <div className="brand"><span className="brand-mark">DD</span><div><strong>Deduction Deck</strong><small>{userEmail}</small></div></div>
    <nav><button onClick={onNew}>New Game</button><button onClick={onSave}>Save</button><button onClick={exportJson}>Export</button><button onClick={onLogout}>Log out</button></nav>
  </header>
}

function SetupScreen({ draft, onChange, onCancel, onStart, onLogout }: { draft: GameState; onChange: (g: GameState) => void; onCancel: () => void; onStart: (g: GameState) => void; onLogout: () => void }) {
  const errors = setupErrors(draft)
  const dealtCards = Math.max(0, draft.cards.length - 3)

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
      <nav><button onClick={onCancel}>Cancel</button><button onClick={onLogout}>Log out</button></nav>
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
              <label className="field"><span>Name</span><input value={p.name} onChange={(e) => updatePlayer(p.id, { name: e.target.value })} /></label>
              <label className="field"><span>Cards</span><input type="number" min="0" max={draft.cards.length} value={p.cardCount} onChange={(e) => updatePlayer(p.id, { cardCount: Number(e.target.value) })} /></label>
              <button onClick={() => removePlayer(p.id)} disabled={draft.players.length <= 1}>Remove</button>
            </div>)}
          </div>
        </section>

        <section className="setup-section">
          <div className="section-head"><h2>Cards</h2><div><button onClick={resetCards}>Default cards</button></div></div>
          {(['suspect', 'weapon', 'room'] as CardType[]).map((type) => <div className="card-type-editor" key={type}>
            <div className="card-type-head"><h3>{typeLabel[type]}</h3><button onClick={() => addCard(type)}>Add {type}</button></div>
            <div className="card-edit-list">
              {draft.cards.filter((card) => card.type === type).map((card) => <div className="card-edit-row" key={card.id}>
                <input value={card.name} onChange={(e) => updateCard(card.id, { name: e.target.value })} />
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
        <label className="summary-name"><span>{player.turnOrder}.</span><input value={player.name} onChange={(event) => renamePlayer(player.id, event.target.value)} /></label>
        <strong>{player.cardCount}</strong>
        <span className="mini-reorder"><button aria-label={`Move ${player.name} earlier`} disabled={index === 0} onClick={() => movePlayer(player.id, -1)}>▲</button><button aria-label={`Move ${player.name} later`} disabled={index === game.players.length - 1} onClick={() => movePlayer(player.id, 1)}>▼</button></span>
      </div>)}</div>
      <button className="wide" onClick={onEditSetup}>Edit setup for new game</button>
    </>}
  </section>
}

function SuggestionForm({ game, onAdd, onSkip }: { game: GameState; onAdd: (s: Suggestion) => void; onSkip: () => void }) {
  const firstByType = (type: CardType) => game.cards.find((c) => c.type === type)!.id
  const [suspect, setSuspect] = useState(firstByType('suspect'))
  const [weapon, setWeapon] = useState(firstByType('weapon'))
  const [room, setRoom] = useState(firstByType('room'))
  const [resultKind, setResultKind] = useState<'nobody' | 'unknown' | 'shown' | 'unresolved'>('unknown')
  const [disproverId, setDisprover] = useState(nextPlayerId(game, game.activeSuggesterId))
  const [shownCardId, setShownCard] = useState(suspect)
  const suggester = playerById(game.players, game.activeSuggesterId) ?? game.players[0]
  const responderOptions = orderedPlayers(game.players).filter((p) => p.id !== suggester.id).map((p) => [p.id, p.name])
  const canDisprove = responderOptions.length > 0
  const resultOptions = canDisprove
    ? [['unknown','Disproved, unknown card'], ['shown','Showed exact card'], ['nobody','Nobody disproved'], ['unresolved','Only log guess']]
    : [['nobody','Nobody disproved'], ['unresolved','Only log guess']]

  function submit() {
    const safeResultKind = canDisprove ? resultKind : resultKind === 'nobody' ? 'nobody' : 'unresolved'
    const result: SuggestionResult = safeResultKind === 'nobody' ? { kind: 'nobody' } : safeResultKind === 'shown' ? { kind: 'shown', disproverId, shownCardId } : safeResultKind === 'unknown' ? { kind: 'unknown', disproverId } : { kind: 'unresolved' }
    onAdd({ id: makeId(), suggesterId: suggester.id, cardIds: [suspect, weapon, room], result, createdAt: Date.now() })
  }
  return <section className="suggestion-card">
    <div className="suggestion-title"><h2>Current suggestion</h2><button className="tiny" onClick={onSkip}>Skip suggester</button></div>
    <div className="current-turn-box"><span>Now asking</span><strong>{suggester.name}</strong></div>
    <div className="form-grid">
      <CardSelect label="Suspect" type="suspect" game={game} value={suspect} onChange={(v) => { setSuspect(v); setShownCard(v) }} />
      <CardSelect label="Weapon" type="weapon" game={game} value={weapon} onChange={setWeapon} />
      <CardSelect label="Room" type="room" game={game} value={room} onChange={setRoom} />
      <Select label="Result" value={canDisprove ? resultKind : 'nobody'} onChange={(v) => setResultKind(v as typeof resultKind)} options={resultOptions} />
      {canDisprove && resultKind !== 'nobody' && resultKind !== 'unresolved' && <Select label="Disprover" value={disproverId} onChange={setDisprover} options={responderOptions} />}
      {canDisprove && resultKind === 'shown' && <Select label="Shown card" value={shownCardId} onChange={setShownCard} options={[[suspect, cardById(game.cards, suspect)!.name], [weapon, cardById(game.cards, weapon)!.name], [room, cardById(game.cards, room)!.name]]} />}
    </div>
    <p className="microcopy">The solver automatically marks everyone between the suggester and disprover as unable to disprove.</p>
    <button className="primary wide" onClick={submit}>Record evidence and advance turn</button>
  </section>
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[][] }) {
  return <label className="field"><span>{label}</span><select value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
}
function CardSelect({ label, type, game, value, onChange }: { label: string; type: CardType; game: GameState; value: string; onChange: (v: string) => void }) {
  return <Select label={label} value={value} onChange={onChange} options={game.cards.filter((c) => c.type === type).map((c) => [c.id, c.name])} />
}

function envelopeLabel(game: GameState, solver: SolverResult, type: CardType) {
  const solved = game.cards.find((card) => card.type === type && (game.marks[card.id].envelope === 'yes' || solver.probabilities[card.id]?.envelope === 1))
  return solved ? ` - Envelope: ${solved.name}` : ''
}

function TypeHeader({ type, game, solver, collapsed, onToggle, colSpan }: { type: CardType; game: GameState; solver: SolverResult; collapsed: boolean; onToggle: () => void; colSpan: number }) {
  return <tr className="group-row"><td colSpan={colSpan}><button className="group-toggle" aria-label={`${collapsed ? 'Show' : 'Hide'} ${typeLabel[type]}`} onClick={onToggle}><span className="chevron">{collapsed ? '▶' : '▼'}</span>{typeLabel[type]}{envelopeLabel(game, solver, type)}</button></td></tr>
}

function ProbabilityMatrix({ game, solver, locations, selected, collapsedTypes, onToggleType, onSelect, onSetMark, onOpenCard }: { game: GameState; solver: SolverResult; locations: LocationId[]; selected: { cardId: string; locationId: LocationId } | null; collapsedTypes: Record<CardType, boolean>; onToggleType: (type: CardType) => void; onSelect: (s: { cardId: string; locationId: LocationId }) => void; onSetMark: (cardId: string, loc: LocationId, mark: Mark) => void; onOpenCard: (cardId: string) => void }) {
  return <div className="matrix-wrap"><table className="matrix"><thead><tr><th>Card</th>{locations.map((loc) => <th key={loc}>{loc === 'envelope' ? 'Envelope' : playerById(game.players, loc)?.name}</th>)}</tr></thead><tbody>
    {(['suspect', 'weapon', 'room'] as CardType[]).map((type) => <GroupedRows key={type} type={type} game={game} solver={solver} locations={locations} selected={selected} collapsed={collapsedTypes[type]} onToggle={() => onToggleType(type)} onSelect={onSelect} onSetMark={onSetMark} onOpenCard={onOpenCard} />)}
  </tbody><tfoot><tr><td>Known / unknown</td>{locations.map((loc) => loc === 'envelope' ? <td key={loc}>3 cards</td> : <td key={loc}>{countsFor(game, loc).known} known<br />{countsFor(game, loc).unknownInHand} unknown</td>)}</tr></tfoot></table></div>
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
          return <td key={loc} className={`prob-cell ${loc === 'envelope' && envelopeOut ? 'envelope-out' : ''} ${isSelected ? 'selected' : ''} mark-${mark}`} onClick={() => onSelect({ cardId: card.id, locationId: loc })} onDoubleClick={() => onSetMark(card.id, loc, nextMark(mark))} style={{ '--p': prob } as React.CSSProperties}>
            {mark === 'yes' ? 'YES' : mark === 'no' ? 'no' : pct(prob)}
          </td>
        })}
      </tr>
    })}
  </>
}

function GuessMatrix({ game, solver, locations, collapsedTypes, onToggleType, onOpenCard }: { game: GameState; solver: SolverResult; locations: LocationId[]; collapsedTypes: Record<CardType, boolean>; onToggleType: (type: CardType) => void; onOpenCard: (cardId: string) => void }) {
  return <div className="matrix-wrap"><table className="matrix guess-matrix"><thead><tr><th>Card</th>{locations.map((loc) => <th key={loc}>{playerById(game.players, loc)?.name}</th>)}</tr></thead><tbody>
    {(['suspect', 'weapon', 'room'] as CardType[]).map((type) => <>
      <TypeHeader key={`${type}-group`} type={type} game={game} solver={solver} collapsed={collapsedTypes[type]} onToggle={() => onToggleType(type)} colSpan={locations.length + 1} />
      {!collapsedTypes[type] && game.cards.filter((c) => c.type === type).map((card) => <tr key={card.id}><td className="card-name"><button className="card-link" onClick={() => onOpenCard(card.id)}>{card.name}</button></td>{locations.map((loc) => {
        const count = guessCount(game, loc, card.id)
        const mark = game.marks[card.id][loc]
        const probability = solver.probabilities[card.id]?.[loc] ?? 0
        return <td className={`guess-cell ${count > 0 ? 'has-guesses' : ''}`} key={loc}><strong>{count}</strong><small>{mark === 'yes' ? 'known held' : mark === 'no' ? 'ruled out' : pct(probability)}</small></td>
      })}</tr>)}
    </>)}
  </tbody></table></div>
}


function CardDetailModal({ card, game, solver, onClose }: { card: Card; game: GameState; solver: SolverResult; onClose: () => void }) {
  const involved = game.suggestions.filter((s) => s.cardIds.includes(card.id))
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

function EvidenceLog({ game }: { game: GameState }) {
  return <section><h2>Evidence log</h2><div className="log-list">{game.suggestions.slice(0, 8).map((s) => <div className="log-item" key={s.id}><strong>{playerById(game.players, s.suggesterId)?.name}</strong> guessed {s.cardIds.map((id) => cardById(game.cards, id)?.name).join(', ')}<small>{resultText(game, s)}</small></div>)}</div></section>
}
function resultText(game: GameState, s: Suggestion) {
  if (s.result.kind === 'nobody') return 'Nobody could disprove'
  if (s.result.kind === 'unknown') return `${playerById(game.players, s.result.disproverId)?.name} disproved with unknown card`
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



