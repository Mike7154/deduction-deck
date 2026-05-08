
import { readFileSync } from 'node:fs'

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=')
  return [key, value]
}))
const file = args.get('in')
if (!file) throw new Error('Usage: npm run analyze -- --in=results.csv')

const text = readFileSync(file, 'utf8').trim()
const [headerLine, ...lines] = text.split(/\r?\n/)
const headers = headerLine.split(',')
type Row = Record<string, string>
const rows: Row[] = lines.filter(Boolean).map((line) => Object.fromEntries(line.split(',').map((value, i) => [headers[i], value])))
const strategies = [...new Set(rows.map((r) => r.strategy))]
const blocks = [...new Set(rows.map((r) => `${r.playerCount}:${r.myPosition}:${r.trial}`))]
const turns = (r: Row) => Number(r.turns)
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)
const quantile = (xs: number[], q: number) => { const s = sorted(xs); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))] ?? 0 }
const stddev = (xs: number[]) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) : 0 }

function ranks(values: Array<{ strategy: string; value: number }>) {
  const out = new Map<string, number>()
  const s = [...values].sort((a, b) => a.value - b.value)
  let i = 0
  while (i < s.length) {
    let j = i + 1
    while (j < s.length && s[j].value === s[i].value) j++
    const rank = (i + 1 + j) / 2
    for (let k = i; k < j; k++) out.set(s[k].strategy, rank)
    i = j
  }
  return out
}

const completeBlocks = blocks.map((block) => rows.filter((r) => `${r.playerCount}:${r.myPosition}:${r.trial}` === block)).filter((group) => new Set(group.map((r) => r.strategy)).size === strategies.length)
const rankTotals = new Map(strategies.map((s) => [s, 0]))
for (const group of completeBlocks) {
  const rs = ranks(group.map((r) => ({ strategy: r.strategy, value: turns(r) })))
  for (const s of strategies) rankTotals.set(s, (rankTotals.get(s) ?? 0) + (rs.get(s) ?? 0))
}
const n = completeBlocks.length, k = strategies.length
const meanRanks = new Map(strategies.map((s) => [s, (rankTotals.get(s) ?? 0) / Math.max(1, n)]))
const friedman = (12 * n / (k * (k + 1))) * strategies.reduce((sum, s) => sum + (meanRanks.get(s) ?? 0) ** 2, 0) - 3 * n * (k + 1)

function erf(x: number) {
  const sign = x < 0 ? -1 : 1, a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const t = 1 / (1 + p * Math.abs(x))
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
  return sign * y
}
const normalCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2))

function wilcoxon(a: number[], b: number[]) {
  const diffs = a.map((x, i) => x - b[i]).filter((d) => d !== 0)
  const abs = diffs.map((d, i) => ({ abs: Math.abs(d), sign: Math.sign(d), i })).sort((x, y) => x.abs - y.abs)
  const rs = Array(abs.length).fill(0)
  let i = 0
  while (i < abs.length) {
    let j = i + 1
    while (j < abs.length && abs[j].abs === abs[i].abs) j++
    const rank = (i + 1 + j) / 2
    for (let k = i; k < j; k++) rs[abs[k].i] = rank
    i = j
  }
  const wPlus = diffs.reduce((s, d, i) => s + (d > 0 ? rs[i] : 0), 0)
  const m = diffs.length
  const mu = m * (m + 1) / 4
  const sigma = Math.sqrt(m * (m + 1) * (2 * m + 1) / 24)
  const z = sigma ? (Math.abs(wPlus - mu) - 0.5) / sigma : 0
  const p = 2 * (1 - normalCdf(Math.abs(z)))
  const rankBiserial = m ? 2 * wPlus / (m * (m + 1) / 2) - 1 : 0
  return { n: m, wPlus, z, p, rankBiserial }
}

const byStrategy = new Map(strategies.map((s) => [s, rows.filter((r) => r.strategy === s).map(turns)]))
console.log('Summary')
console.log('| Strategy | N | Mean | Median | IQR | P95 | SD | Mean rank |')
console.log('|---|---:|---:|---:|---:|---:|---:|---:|')
for (const s of strategies.sort((a, b) => (meanRanks.get(a) ?? 0) - (meanRanks.get(b) ?? 0))) {
  const xs = byStrategy.get(s) ?? []
  console.log(`| ${s} | ${xs.length} | ${mean(xs).toFixed(2)} | ${quantile(xs, .5)} | ${(quantile(xs, .75) - quantile(xs, .25)).toFixed(2)} | ${quantile(xs, .95)} | ${stddev(xs).toFixed(2)} | ${(meanRanks.get(s) ?? 0).toFixed(2)} |`)
}
console.log(`\nFriedman chi-square(${k - 1}) = ${friedman.toFixed(3)} across ${n} paired blocks (use scipy/R for exact p-value).`)

const best = strategies.reduce((best, s) => (meanRanks.get(s) ?? Infinity) < (meanRanks.get(best) ?? Infinity) ? s : best, strategies[0])
const pairRows = strategies.filter((s) => s !== best).map((s) => {
  const a: number[] = [], b: number[] = []
  for (const group of completeBlocks) {
    const br = group.find((r) => r.strategy === best), sr = group.find((r) => r.strategy === s)
    if (br && sr) { a.push(turns(sr)); b.push(turns(br)) }
  }
  const w = wilcoxon(a, b)
  return { strategy: s, ...w, medianDiff: quantile(a.map((x, i) => x - b[i]), .5) }
}).sort((x, y) => x.p - y.p)
console.log(`\nPairwise Wilcoxon signed-rank vs best mean-rank strategy: ${best}`)
console.log('| Strategy | N | Median diff | p approx | Holm alpha | Significant | Rank-biserial |')
console.log('|---|---:|---:|---:|---:|---:|---:|')
for (const [i, row] of pairRows.entries()) {
  const alpha = 0.05 / (pairRows.length - i)
  console.log(`| ${row.strategy} | ${row.n} | ${row.medianDiff} | ${row.p.toExponential(3)} | ${alpha.toFixed(4)} | ${row.p <= alpha ? 'yes' : 'no'} | ${row.rankBiserial.toFixed(3)} |`)
}
