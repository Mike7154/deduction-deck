import { useMemo, useState } from 'react'
import './App.css'
import { createBlankMarks, createDefaultGame, type BehaviorStats, type Card, type CardType, type GameState, type LocationId, type Mark, type Player, type Suggestion, type SuggestionResult, typeLabel } from './types'
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

function migrateLegacyDataForFirstUser(email: string) {
  if (localStorage.getItem(userScopedKey(saveKey, email)) === null) {
    const legacyGame = localStorage.getItem(saveKey)
    if (legacyGame) localStorage.setItem(userScopedKey(saveKey, email), legacyGame)
  }
  if (localStorage.getItem(userScopedKey(statsKey, email)) === null) {
    const legacyStats = localStorage.getItem(statsKey)
    if (legacyStats) localStorage.setItem(userScopedKey(statsKey, email), legacyStats)
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
  const solver = useMemo(() => solveGame(game), [game])
  const locations = useMemo(() => ['envelope', ...orderedPlayers(game.players).map((p) => p.id)], [game.players])

  function activateUser(email: string) {
    const normalized = normalizeEmail(email)
    localStorage.setItem(sessionKey, normalized)
    setUserEmail(normalized)
    setGame(loadGame(normalized))
    setStats(loadStats(normalized))
    setSelected(null)
    setMatrixMode('probabilities')
  }

  function logout() {
    localStorage.removeItem(sessionKey)
    setUserEmail(null)
    setSelected(null)
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

  if (!userEmail) return <AuthScreen onAuthenticated={activateUser} />

  return (
    <div className="app-shell">
      <TopBar game={game} userEmail={userEmail} onLogout={logout} onNew={() => updateGame(resetKnownEvidence(game))} onSave={() => localStorage.setItem(userScopedKey(saveKey, userEmail), JSON.stringify(game))} />
      <main className="workspace">
        <aside className="sidebar panel">
          <GameSetup game={game} onChange={updateGame} />
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
            ? <ProbabilityMatrix game={game} solver={solver} locations={locations} selected={selected} onSelect={setSelected} onSetMark={setMark} />
            : <GuessMatrix game={game} locations={locations.filter((loc) => loc !== 'envelope')} />}
        </section>

        <aside className="inspector panel">
          <CurrentDeduction game={game} solver={solver} />
          <SelectionInspector selectedCard={selectedCard} selectedLocation={selectedLocation} selected={selected} solver={solver} stats={stats} onSetMark={setMark} />
          <BehaviorPanel game={game} stats={stats} onFinish={finishGame} />
        </aside>
      </main>
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
      if (users.length === 0) migrateLegacyDataForFirstUser(normalized)
      saveUsers([...users, { email: normalized, createdAt: Date.now() }])
      onAuthenticated(normalized)
      return
    }

    if (!exists) {
      setError('No account exists for that email yet. Sign up first.')
      return
    }
    onAuthenticated(normalized)
  }

  return <div className="auth-shell">
    <section className="auth-card panel">
      <div className="brand auth-brand"><span className="brand-mark">DD</span><div><strong>Deduction Deck</strong><small>Private local game spaces</small></div></div>
      <h1>{mode === 'login' ? 'Log in' : 'Sign up'}</h1>
      <p className="muted">Use a valid email to keep each player’s game board and behavior hints separate on this device.</p>
      <label className="field"><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(e) => { setEmail(e.target.value); setError('') }} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} placeholder="you@example.com" /></label>
      {error && <p className="auth-error">{error}</p>}
      <button className="primary wide" onClick={submit}>{mode === 'login' ? 'Log in' : 'Create account'}</button>
      <button className="link-button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError('') }}>{mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in'}</button>
      <p className="local-note">Accounts are local to this browser; this is separation, not secure cloud authentication.</p>
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

function GameSetup({ game, onChange }: { game: GameState; onChange: (g: GameState) => void }) {
  const players = orderedPlayers(game.players)
  function updatePlayer(id: string, patch: Partial<Player>) {
    const next = structuredClone(game)
    next.players = next.players.map((p) => p.id === id ? { ...p, ...patch } : p)
    onChange(next)
  }
  function movePlayer(id: string, direction: -1 | 1) {
    const list = orderedPlayers(game.players)
    const idx = list.findIndex((p) => p.id === id)
    const swap = idx + direction
    if (idx < 0 || swap < 0 || swap >= list.length) return
    ;[list[idx], list[swap]] = [list[swap], list[idx]]
    const next = structuredClone(game)
    next.players = list.map((p, i) => ({ ...p, turnOrder: i + 1 }))
    onChange(next)
  }
  return <section className="setup-card">
    <h2>Game setup</h2>
    <div className="turn-order-label">Turn Order</div>
    <div className="player-list">
      {players.map((p, index) => {
        const counts = countsFor(game, p.id)
        const active = p.id === game.activeSuggesterId
        return <div className={`player-row ${active ? 'active-turn' : ''}`} key={p.id}>
          <div className="reorder-buttons"><button aria-label={`Move ${p.name} earlier`} disabled={index === 0} onClick={() => movePlayer(p.id, -1)}>↑</button><button aria-label={`Move ${p.name} later`} disabled={index === players.length - 1} onClick={() => movePlayer(p.id, 1)}>↓</button></div>
          <input value={p.name} onChange={(e) => updatePlayer(p.id, { name: e.target.value })} />
          <label>Cards <input type="number" min="0" max="18" value={p.cardCount} onChange={(e) => updatePlayer(p.id, { cardCount: Number(e.target.value) })} /></label>
          <small>{active ? 'Current turn → ' : ''}{counts.known} known / {counts.unknownInHand} unknown</small>
        </div>
      })}
    </div>
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

  function submit() {
    const result: SuggestionResult = resultKind === 'nobody' ? { kind: 'nobody' } : resultKind === 'shown' ? { kind: 'shown', disproverId, shownCardId } : resultKind === 'unknown' ? { kind: 'unknown', disproverId } : { kind: 'unresolved' }
    onAdd({ id: makeId(), suggesterId: suggester.id, cardIds: [suspect, weapon, room], result, createdAt: Date.now() })
  }
  return <section className="suggestion-card">
    <div className="suggestion-title"><h2>Current suggestion</h2><button className="tiny" onClick={onSkip}>Skip suggester</button></div>
    <div className="current-turn-box"><span>Now asking</span><strong>{suggester.name}</strong></div>
    <div className="form-grid">
      <CardSelect label="Suspect" type="suspect" game={game} value={suspect} onChange={(v) => { setSuspect(v); setShownCard(v) }} />
      <CardSelect label="Weapon" type="weapon" game={game} value={weapon} onChange={setWeapon} />
      <CardSelect label="Room" type="room" game={game} value={room} onChange={setRoom} />
      <Select label="Result" value={resultKind} onChange={(v) => setResultKind(v as typeof resultKind)} options={[['unknown','Disproved, unknown card'], ['shown','Showed exact card'], ['nobody','Nobody disproved'], ['unresolved','Only log guess']]} />
      {resultKind !== 'nobody' && resultKind !== 'unresolved' && <Select label="Disprover" value={disproverId} onChange={setDisprover} options={responderOptions} />}
      {resultKind === 'shown' && <Select label="Shown card" value={shownCardId} onChange={setShownCard} options={[[suspect, cardById(game.cards, suspect)!.name], [weapon, cardById(game.cards, weapon)!.name], [room, cardById(game.cards, room)!.name]]} />}
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

function ProbabilityMatrix({ game, solver, locations, selected, onSelect, onSetMark }: { game: GameState; solver: SolverResult; locations: LocationId[]; selected: { cardId: string; locationId: LocationId } | null; onSelect: (s: { cardId: string; locationId: LocationId }) => void; onSetMark: (cardId: string, loc: LocationId, mark: Mark) => void }) {
  return <div className="matrix-wrap"><table className="matrix"><thead><tr><th>Card</th>{locations.map((loc) => <th key={loc}>{loc === 'envelope' ? 'Envelope' : playerById(game.players, loc)?.name}</th>)}</tr></thead><tbody>
    {(['suspect', 'weapon', 'room'] as CardType[]).map((type) => <GroupedRows key={type} type={type} game={game} solver={solver} locations={locations} selected={selected} onSelect={onSelect} onSetMark={onSetMark} />)}
  </tbody><tfoot><tr><td>Known / unknown</td>{locations.map((loc) => loc === 'envelope' ? <td key={loc}>3 cards</td> : <td key={loc}>{countsFor(game, loc).known} known<br />{countsFor(game, loc).unknownInHand} unknown</td>)}</tr></tfoot></table></div>
}

function GroupedRows({ type, game, solver, locations, selected, onSelect, onSetMark }: { type: CardType; game: GameState; solver: SolverResult; locations: LocationId[]; selected: { cardId: string; locationId: LocationId } | null; onSelect: (s: { cardId: string; locationId: LocationId }) => void; onSetMark: (cardId: string, loc: LocationId, mark: Mark) => void }) {
  return <>
    <tr className="group-row"><td colSpan={locations.length + 1}>{typeLabel[type]}</td></tr>
    {game.cards.filter((c) => c.type === type).map((card) => {
      const envelopeOut = game.marks[card.id].envelope === 'no' || (solver.probabilities[card.id]?.envelope ?? 0) === 0
      return <tr className={envelopeOut ? 'not-envelope-row' : ''} key={card.id}>
        <td className="card-name">{card.name}</td>
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

function GuessMatrix({ game, locations }: { game: GameState; locations: LocationId[] }) {
  return <div className="matrix-wrap"><table className="matrix guess-matrix"><thead><tr><th>Card</th>{locations.map((loc) => <th key={loc}>{playerById(game.players, loc)?.name}</th>)}</tr></thead><tbody>
    {(['suspect', 'weapon', 'room'] as CardType[]).map((type) => <>
      <tr className="group-row" key={`${type}-group`}><td colSpan={locations.length + 1}>{typeLabel[type]}</td></tr>
      {game.cards.filter((c) => c.type === type).map((card) => <tr key={card.id}><td className="card-name">{card.name}</td>{locations.map((loc) => {
        const count = guessCount(game, loc, card.id)
        const mark = game.marks[card.id][loc]
        return <td className={`guess-cell ${count > 0 ? 'has-guesses' : ''}`} key={loc}><strong>{count}</strong><small>{mark === 'yes' ? 'known held' : mark === 'no' ? 'ruled out' : 'unknown'}</small></td>
      })}</tr>)}
    </>)}
  </tbody></table></div>
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
    <div className="top-hints">{top.length ? top.map(([key, s]) => <span key={key}>{key.split(':').map((id, i) => i ? cardById(game.cards,id)?.name : playerById(game.players,id)?.name).join(' / ')} → {pct(s.held / Math.max(1, s.suggested))}</span>) : <span>No completed games yet.</span>}</div>
    <button onClick={() => setOpen(!open)}>Finish game / learn</button>
    {open && <div className="finish-box"><Select label="Game phase tag" value={phase} onChange={setPhase} options={phaseOptions.map((p) => [p, p])} /><p className="muted">MVP: records suggested-card ownership from known marked hands. A hosted version should save full final hands in a database and model phase, player, and suggestion result.</p><button className="primary wide" onClick={finishDemo}>Store behavior sample</button></div>}
  </section>
}

export default App

