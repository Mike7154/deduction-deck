import { useMemo, useState } from 'react'
import './App.css'
import { createDefaultGame, type BehaviorStats, type Card, type CardType, type GameState, type LocationId, type Mark, type Player, type Suggestion, type SuggestionResult, typeLabel } from './types'
import { solveGame } from './solver'

const saveKey = 'deduction-deck-game-v1'
const statsKey = 'deduction-deck-behavior-stats-v1'
const phaseOptions = ['opening', 'middle', 'endgame'] as const

function loadGame(): GameState {
  try {
    const raw = localStorage.getItem(saveKey)
    if (raw) return JSON.parse(raw) as GameState
  } catch { /* noop */ }
  const game = createDefaultGame()
  // Seed a few cards from the workbook snapshot so the first screen is interesting.
  game.marks['peacock'].me = 'yes'
  game.marks['lead-pipe'].me = 'yes'
  game.marks['lounge'].me = 'yes'
  return game
}

function loadStats(): BehaviorStats {
  try {
    return JSON.parse(localStorage.getItem(statsKey) ?? '{}') as BehaviorStats
  } catch {
    return {}
  }
}

const pct = (n: number) => `${Math.round(n * 100)}%`
const cardById = (cards: Card[], id: string) => cards.find((c) => c.id === id)
const playerById = (players: Player[], id: string) => players.find((p) => p.id === id)

function nextMark(mark: Mark): Mark {
  return mark === 'unknown' ? 'no' : mark === 'no' ? 'yes' : 'unknown'
}

function makeId() {
  return Math.random().toString(36).slice(2, 10)
}

function App() {
  const [game, setGame] = useState<GameState>(loadGame)
  const [stats, setStats] = useState<BehaviorStats>(loadStats)
  const [selected, setSelected] = useState<{ cardId: string; locationId: LocationId } | null>(null)
  const solver = useMemo(() => solveGame(game), [game])
  const locations = useMemo(() => ['envelope', ...game.players.map((p) => p.id)], [game.players])

  function updateGame(next: GameState) {
    setGame(next)
    localStorage.setItem(saveKey, JSON.stringify(next))
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

  function addSuggestion(suggestion: Suggestion) {
    const next = structuredClone(game)
    next.suggestions.unshift(suggestion)
    if (suggestion.result.kind === 'shown') {
      next.marks[suggestion.result.shownCardId][suggestion.result.disproverId] = 'yes'
    }
    updateGame(next)
  }

  function finishGame(envelope: Record<CardType, string>, playerHands: Record<string, string[]>, phase: string) {
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
    for (const type of Object.keys(envelope) as CardType[]) {
      const cardId = envelope[type]
      if (cardId) setMark(cardId, 'envelope', 'yes')
    }
    setStats(nextStats)
    localStorage.setItem(statsKey, JSON.stringify(nextStats))
  }

  const selectedCard = selected ? cardById(game.cards, selected.cardId) : null
  const selectedLocation = selected?.locationId === 'envelope' ? 'Envelope' : playerById(game.players, selected?.locationId ?? '')?.name

  return (
    <div className="app-shell">
      <TopBar game={game} onNew={() => updateGame(createDefaultGame())} onSave={() => localStorage.setItem(saveKey, JSON.stringify(game))} />
      <main className="workspace">
        <aside className="sidebar panel">
          <GameSetup game={game} onChange={updateGame} />
          <SuggestionForm game={game} onAdd={addSuggestion} />
          <EvidenceLog game={game} />
        </aside>

        <section className="matrix-panel panel">
          <div className="matrix-head">
            <div>
              <h1>Probability matrix</h1>
              <p>Exact deal enumeration when possible. Behavior hints are separate, so the solver stays mathematically clean.</p>
            </div>
            <button className="primary" onClick={applyDeductions} disabled={solver.deductions.length === 0}>Apply {solver.deductions.length} deductions</button>
          </div>
          <ProbabilityMatrix game={game} solver={solver} locations={locations} selected={selected} onSelect={setSelected} onSetMark={setMark} />
        </section>

        <aside className="inspector panel">
          <CurrentDeduction game={game} solver={solver} />
          <SelectionInspector selectedCard={selectedCard} selectedLocation={selectedLocation} selected={selected} game={game} solver={solver} stats={stats} onSetMark={setMark} />
          <BehaviorPanel game={game} stats={stats} onFinish={finishGame} />
        </aside>
      </main>
    </div>
  )
}

function TopBar({ game, onNew, onSave }: { game: GameState; onNew: () => void; onSave: () => void }) {
  function exportJson() {
    const blob = new Blob([JSON.stringify(game, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'deduction-deck-game.json'
    a.click()
  }
  return <header className="topbar">
    <div className="brand"><span className="brand-mark">?</span><div><strong>Deduction Deck</strong><small>Cluedo probability calculator</small></div></div>
    <nav><button onClick={onNew}>New Game</button><button onClick={onSave}>Save</button><button onClick={exportJson}>Export</button></nav>
  </header>
}

function GameSetup({ game, onChange }: { game: GameState; onChange: (g: GameState) => void }) {
  function updatePlayer(id: string, patch: Partial<Player>) {
    const next = structuredClone(game)
    next.players = next.players.map((p) => p.id === id ? { ...p, ...patch } : p)
    onChange(next)
  }
  return <section className="setup-card">
    <h2>Game setup</h2>
    <div className="player-list">
      {game.players.map((p) => <div className="player-row" key={p.id}>
        <input value={p.name} onChange={(e) => updatePlayer(p.id, { name: e.target.value })} />
        <label>Cards <input type="number" min="0" max="18" value={p.cardCount} onChange={(e) => updatePlayer(p.id, { cardCount: Number(e.target.value) })} /></label>
      </div>)}
    </div>
  </section>
}

function SuggestionForm({ game, onAdd }: { game: GameState; onAdd: (s: Suggestion) => void }) {
  const firstByType = (type: CardType) => game.cards.find((c) => c.type === type)!.id
  const [suggesterId, setSuggester] = useState(game.players[0].id)
  const [suspect, setSuspect] = useState(firstByType('suspect'))
  const [weapon, setWeapon] = useState(firstByType('weapon'))
  const [room, setRoom] = useState(firstByType('room'))
  const [resultKind, setResultKind] = useState<'nobody' | 'unknown' | 'shown' | 'unresolved'>('unknown')
  const [disproverId, setDisprover] = useState(game.players[1]?.id ?? game.players[0].id)
  const [shownCardId, setShownCard] = useState(suspect)

  function submit() {
    const result: SuggestionResult = resultKind === 'nobody' ? { kind: 'nobody' } : resultKind === 'shown' ? { kind: 'shown', disproverId, shownCardId } : resultKind === 'unknown' ? { kind: 'unknown', disproverId } : { kind: 'unresolved' }
    onAdd({ id: makeId(), suggesterId, cardIds: [suspect, weapon, room], result, createdAt: Date.now() })
  }
  return <section className="suggestion-card">
    <h2>Enter suggestion</h2>
    <div className="form-grid">
      <Select label="Suggester" value={suggesterId} onChange={setSuggester} options={game.players.map((p) => [p.id, p.name])} />
      <CardSelect label="Suspect" type="suspect" game={game} value={suspect} onChange={setSuspect} />
      <CardSelect label="Weapon" type="weapon" game={game} value={weapon} onChange={setWeapon} />
      <CardSelect label="Room" type="room" game={game} value={room} onChange={setRoom} />
      <Select label="Result" value={resultKind} onChange={(v) => setResultKind(v as typeof resultKind)} options={[['unknown','Disproved, unknown card'], ['shown','Showed exact card'], ['nobody','Nobody disproved'], ['unresolved','Only log guess']]} />
      {resultKind !== 'nobody' && resultKind !== 'unresolved' && <Select label="Disprover" value={disproverId} onChange={setDisprover} options={game.players.map((p) => [p.id, p.name])} />}
      {resultKind === 'shown' && <Select label="Shown card" value={shownCardId} onChange={setShownCard} options={[[suspect, cardById(game.cards, suspect)!.name], [weapon, cardById(game.cards, weapon)!.name], [room, cardById(game.cards, room)!.name]]} />}
    </div>
    <button className="primary wide" onClick={submit}>Record evidence</button>
  </section>
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[][] }) {
  return <label className="field"><span>{label}</span><select value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
}
function CardSelect({ label, type, game, value, onChange }: { label: string; type: CardType; game: GameState; value: string; onChange: (v: string) => void }) {
  return <Select label={label} value={value} onChange={onChange} options={game.cards.filter((c) => c.type === type).map((c) => [c.id, c.name])} />
}

function ProbabilityMatrix({ game, solver, locations, selected, onSelect, onSetMark }: any) {
  return <div className="matrix-wrap"><table className="matrix"><thead><tr><th>Card</th>{locations.map((loc: LocationId) => <th key={loc}>{loc === 'envelope' ? 'Envelope' : playerById(game.players, loc)?.name}</th>)}</tr></thead><tbody>
    {(['suspect', 'weapon', 'room'] as CardType[]).map((type) => <GroupedRows key={type} type={type} game={game} solver={solver} locations={locations} selected={selected} onSelect={onSelect} onSetMark={onSetMark} />)}
  </tbody></table></div>
}

function GroupedRows({ type, game, solver, locations, selected, onSelect, onSetMark }: any) {
  return <>
    <tr className="group-row"><td colSpan={locations.length + 1}>{typeLabel[type as CardType]}</td></tr>
    {game.cards.filter((c: Card) => c.type === type).map((card: Card) => <tr key={card.id}>
      <td className="card-name">{card.name}</td>
      {locations.map((loc: LocationId) => {
        const mark = game.marks[card.id][loc]
        const prob = solver.probabilities[card.id]?.[loc] ?? 0
        const isSelected = selected?.cardId === card.id && selected?.locationId === loc
        return <td key={loc} className={`prob-cell ${isSelected ? 'selected' : ''} mark-${mark}`} onClick={() => onSelect({ cardId: card.id, locationId: loc })} onDoubleClick={() => onSetMark(card.id, loc, nextMark(mark))} style={{ '--p': prob } as React.CSSProperties}>
          {mark === 'yes' ? 'YES' : mark === 'no' ? 'no' : pct(prob)}
        </td>
      })}
    </tr>)}
  </>
}

function CurrentDeduction({ game, solver }: any) {
  const accusation = (['suspect', 'weapon', 'room'] as CardType[]).map((type) => solver.envelopePick[type] ? cardById(game.cards, solver.envelopePick[type].cardId)?.name : '�')
  return <section className="deduction-card">
    <h2>Current deduction</h2>
    <div className="accusation"><span>{accusation[0]}</span><span>{accusation[1]}</span><span>{accusation[2]}</span></div>
    <div className={`status ${solver.status}`}>{solver.status === 'exact' ? 'Exact solver' : solver.status === 'capped' ? 'Capped enumeration' : 'Contradiction'}</div>
    {solver.messages.map((m: string) => <p className="message" key={m}>{m}</p>)}
  </section>
}

function SelectionInspector({ selectedCard, selectedLocation, selected, solver, stats, onSetMark }: any) {
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
    <p className="muted">Yes, you can learn this over finished games. The hard part is phase/context, so this prototype stores phase-tagged local stats separately from solver odds.</p>
    <div className="top-hints">{top.length ? top.map(([key, s]) => <span key={key}>{key.split(':').map((id, i) => i ? cardById(game.cards,id)?.name : playerById(game.players,id)?.name).join(' / ')} � {pct(s.held / Math.max(1, s.suggested))}</span>) : <span>No completed games yet.</span>}</div>
    <button onClick={() => setOpen(!open)}>Finish game / learn</button>
    {open && <div className="finish-box"><Select label="Game phase tag" value={phase} onChange={setPhase} options={phaseOptions.map((p) => [p, p])} /><p className="muted">MVP: records suggested-card ownership from known marked hands. A hosted version should save full final hands in a database and model phase, player, and suggestion result.</p><button className="primary wide" onClick={finishDemo}>Store behavior sample</button></div>}
  </section>
}

export default App
