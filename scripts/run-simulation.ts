
import { createWriteStream } from 'node:fs'
import { formatSimulationReport, runStrategySimulation, type SimulationStrategy, type TrialResult } from '../src/simulation.ts'

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=')
  return [key, value]
}))

function fmt(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`
}

const quiet = args.get('quiet') === 'true'
let lastPrint = 0
const strategyArg = args.get('strategies')
const strategies = strategyArg ? strategyArg.split(',').map((s) => s.trim()).filter(Boolean) as SimulationStrategy[] : undefined
const outPath = args.get('out')
const out = outPath ? createWriteStream(outPath, { flags: args.get('append') === 'true' ? 'a' : 'w' }) : null
const header = ['trial','seed','strategy','playerCount','myPosition','solved','turns','myTurns','suspectSolvedTurn','weaponSolvedTurn','roomSolvedTurn','mySuggestions','passCount','noFacts','immediateDisproofs','nobodyDisproved','exactShownToMe','entropyImbalance','averageSolverWorlds']
if (out && args.get('append') !== 'true') out.write(`${header.join(',')}\n`)
function writeTrial(t: TrialResult) {
  if (!out) return
  out.write(header.map((key) => String(t[key as keyof TrialResult])).join(',') + '\n')
}

function runOne(myPosition: number | 'random') {
  return runStrategySimulation({
    games: Number(args.get('games') ?? 50),
    seed: Number(args.get('seed') ?? 7154),
    maxTurns: Number(args.get('maxTurns') ?? 240),
    paired: args.get('paired') !== 'false',
    playerCount: Number(args.get('playerCount') ?? 6) as 3 | 6,
    myPosition,
    candidateLimitPerType: Number(args.get('candidates') ?? 3),
    solverMaxWorlds: Number(args.get('solverMaxWorlds') ?? 250000),
    accusationThreshold: Number(args.get('accusationThreshold') ?? 0.88),
    infoWeight: Number(args.get('infoWeight') ?? 1),
    bottleneckWeight: Number(args.get('bottleneckWeight') ?? 0.08),
    exactWeight: Number(args.get('exactWeight') ?? 0.35),
    selfProbeWeight: Number(args.get('selfProbeWeight') ?? 0.35),
    leakageWeight: Number(args.get('leakageWeight') ?? 0.25),
    envelopeWeight: Number(args.get('envelopeWeight') ?? 0.15),
    decisiveNobodyWeight: Number(args.get('decisiveNobodyWeight') ?? 1.1),
    lateLeakageDiscount: Number(args.get('lateLeakageDiscount') ?? 0.35),
    onTrial: writeTrial,
    onProgress: quiet ? undefined : (p) => {
      const now = Date.now()
      if (now - lastPrint < 1000 && p.completed < p.total) return
      lastPrint = now
      const percent = Math.round((p.completed / p.total) * 100)
      console.error(`[${percent}%] pos ${myPosition} ${p.strategy} ${p.game}/${p.games} (${p.completed}/${p.total}) elapsed ${fmt(p.elapsedMs)} ETA ${fmt(p.remainingMs)}`)
    },
  }, strategies)
}

const positions = args.get('positionSweep') === 'true'
  ? Array.from({ length: Number(args.get('playerCount') ?? 6) }, (_, i) => i)
  : [args.get('myPosition') === 'random' ? 'random' as const : Number(args.get('myPosition') ?? 0)]
const reports = positions.map((position) => runOne(position))
out?.end()
for (const report of reports) {
  console.log(formatSimulationReport(report))
  console.log('')
}
