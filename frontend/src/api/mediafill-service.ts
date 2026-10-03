import { listRows, resetRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 培养基模拟灌装的业务规则都收在这里：
// 1. 灌装按规格分批，勾选多条一次送灌装，逐条出结果；
// 2. 培养条件（温度/天数）由质量部核定，未核定不能判定；
// 3. 判定结论必须附污染瓶数；状态只能一段一段往下走，拒收倒序回退一段；
// 4. 同一批灌装重复判定只算一次（幂等）；动作同步稳定性考察台账；
// 5. 污染瓶数两处核对：车间培养读数 vs 质量部台账数；
//    与培养温度两处相左时先判优先级（质量部 > 车间），按质量部那份判；
// 6. 瓶数越界（非整数/负数/大于灌装批量）单条挡回；
//    超限（超过批量的 1‰）整组退回重来。

const MEDIAFILL = 'mediafill'
const STABILITY = 'stability'

const STATUS_PENDING = '待灌装'
const STATUS_RUNNING = '灌装中'
const STATUS_JUDGED = '已判定'
const STATUS_TERMINATED = '已终止'
const REVERSIBLE = [STATUS_PENDING, STATUS_RUNNING, STATUS_JUDGED]

export type OutcomeLevel = 'ok' | 'skip' | 'block' | 'return' | 'info'

export type OutcomeLine = {
  code: string
  level: OutcomeLevel
  detail: string
}

export type BatchSubmitResult = {
  lines: OutcomeLine[]
  groups: { spec: string; batchNo: string; count: number }[]
}

export type BatchJudgeResult = {
  lines: OutcomeLine[]
  returnedGroups: { key: string; limit: number; count: number }[]
}

type Precheck =
  | { kind: 'duplicate'; ledgerStatus: string }
  | { kind: 'notRunning' }
  | { kind: 'notApproved' }
  | { kind: 'workshopInvalid'; value: string }
  | { kind: 'ledgerInvalid'; value: string }
  | { kind: 'batchInvalid'; value: string }
  | { kind: 'countMismatch'; workshop: string; ledger: number }
  | {
      kind: 'conflictRuling'
      workshop: number
      ledger: number
      registeredTemp: string
      approvedTemp: string
      limit: number
    }
  | { kind: 'overLimit'; count: number; limit: number }
  | { kind: 'pass'; count: number; limit: number }

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}${month}${day}`
}

function text(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

function parseCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value
  }
  const raw = String(value ?? '').trim()
  if (!/^\d+$/.test(raw)) {
    return null
  }
  return Number(raw)
}

function parseBatch(row: EntryRow): number | null {
  const value = Number(row['灌装批量'])
  return Number.isFinite(value) && value > 0 ? value : null
}

/** 污染瓶数限度：按 GMP 培养基模拟灌装常规口径取批量的 1‰，且不低于 1 瓶。 */
export function contaminationLimit(batchSize: number): number {
  return Math.max(1, Math.floor(batchSize / 1000))
}

export type EffectiveCondition = {
  key: string
  label: string
  temperature: string
  days: string
  approved: boolean
  tempConflict: boolean
}

/** 有效培养条件：已核定时以质量部核定值为准，未核定用登记值。 */
export function effectiveCondition(row: EntryRow): EffectiveCondition {
  const registeredTemp = text(row, '培养温度')
  const registeredDays = text(row, '培养天数')
  const approvedTemp = text(row, '核定温度')
  const approvedDays = text(row, '核定天数')
  const approved =
    text(row, '培养条件核定') === '已核定' && approvedTemp !== '' && approvedDays !== ''
  const temperature = approved ? approvedTemp : registeredTemp
  const days = approved ? approvedDays : registeredDays
  return {
    key: `${temperature}|${days}`,
    label: `${temperature || '温度缺失'}/${days ? `${days}天` : '天数缺失'}`,
    temperature,
    days,
    approved,
    tempConflict: approved && registeredTemp !== '' && registeredTemp !== approvedTemp,
  }
}

function ledgerCode(mediaCode: string): string {
  return `STAB-${mediaCode}`
}

function findLedger(ledger: EntryRow[], mediaCode: string): EntryRow | undefined {
  return ledger.find((item) => text(item, '来源灌装编号') === mediaCode)
}

function nextLedgerId(ledger: EntryRow[]): number {
  return ledger.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
}

function specCode(spec: string): string {
  const matched = spec.match(/^[0-9]+[a-zA-Zμ]+/)
  return matched ? matched[0].replace('μ', 'u') : 'MEDIA'
}

function buildLedger(row: EntryRow, id: number): EntryRow {
  const cond = effectiveCondition(row)
  const linked = text(row, 'status') === STATUS_RUNNING
  return {
    id,
    status: linked ? '考察中' : '待考察',
    pending: true,
    abnormal: false,
    考察编号: ledgerCode(text(row, '灌装编号')),
    考察批号: text(row, '灌装批号'),
    考察条件: cond.label,
    考察时间点: new Date().toISOString().slice(0, 10),
    检验项目: '培养基无菌检查',
    考察结果: '',
    污染瓶数: row['台账污染瓶数'] ?? '',
    考察人: '质量部',
    考察状态: linked ? '考察中' : '待考察',
    来源灌装编号: text(row, '灌装编号'),
  }
}

/** 勾选多条一次送灌装：按规格分批，缺规格/缺培养温度的先单独提示，其余照常推进。 */
export function batchSubmitFill(selectedIds: number[]): BatchSubmitResult {
  const rows = listRows(MEDIAFILL)
  const ledger = listRows(STABILITY)
  const selected = rows.filter((row) => selectedIds.includes(Number(row.id)))
  const lines: OutcomeLine[] = []

  const eligible: EntryRow[] = []
  for (const row of selected) {
    const code = text(row, '灌装编号')
    if (text(row, 'status') !== STATUS_PENDING) {
      lines.push({
        code,
        level: 'skip',
        detail: `当前状态「${text(row, 'status')}」，不在待灌装段，跳过`,
      })
      continue
    }
    if (!text(row, '灌装规格')) {
      lines.push({ code, level: 'block', detail: '灌装规格缺失，先单独补录规格，未送灌装' })
      continue
    }
    if (!text(row, '培养温度')) {
      lines.push({ code, level: 'block', detail: '培养温度缺失，先单独补录温度，未送灌装' })
      continue
    }
    eligible.push(row)
  }

  // 灌装按规格分批：同一规格共用一个灌装批号。
  const groups = new Map<string, EntryRow[]>()
  for (const row of eligible) {
    const spec = text(row, '灌装规格')
    const group = groups.get(spec) ?? []
    group.push(row)
    groups.set(spec, group)
  }

  const datePart = today()
  const existing = rows.filter((row) => text(row, '灌装批号').includes(datePart)).length
  let seq = existing
  const batchNos = new Map<string, string>()
  for (const spec of groups.keys()) {
    seq += 1
    batchNos.set(spec, `${specCode(spec)}-${datePart}-${String(seq).padStart(2, '0')}`)
  }

  const nextRows = [...rows]
  let nextLedger = [...ledger]
  for (const [spec, groupRows] of groups) {
    const batchNo = batchNos.get(spec) as string
    for (const row of groupRows) {
      const code = text(row, '灌装编号')
      const index = nextRows.findIndex((item) => item.id === row.id)
      const cond = effectiveCondition(row)
      const updated: EntryRow = {
        ...nextRows[index],
        status: STATUS_RUNNING,
        pending: true,
        abnormal: false,
        灌装批号: batchNo,
        最近拒收原因: '',
      }
      nextRows[index] = updated

      // 动作同步稳定性考察台账：送灌装即建/挂台账，考察条件跟着有效培养条件走。
      let target = findLedger(nextLedger, code)
      if (!target) {
        target = buildLedger(updated, nextLedgerId(nextLedger))
        nextLedger = [...nextLedger, target]
      }
      const ledgerIndex = nextLedger.findIndex((item) => item.id === target!.id)
      nextLedger[ledgerIndex] = {
        ...nextLedger[ledgerIndex],
        status: '考察中',
        pending: true,
        abnormal: false,
        考察批号: batchNo,
        考察条件: cond.label,
        考察状态: '考察中',
      }

      lines.push({
        code,
        level: 'ok',
        detail: `已送灌装，规格「${spec}」编入批号 ${batchNo}，台账 ${text(target, '考察编号')} 已同步`,
      })
    }
  }

  saveRows(MEDIAFILL, nextRows)
  saveRows(STABILITY, nextLedger)

  return {
    lines,
    groups: [...groups.entries()].map(([spec, groupRows]) => ({
      spec,
      batchNo: batchNos.get(spec) as string,
      count: groupRows.length,
    })),
  }
}

function precheck(row: EntryRow, ledgerRow: EntryRow | undefined, batchSize: number): Precheck {
  if (text(row, 'status') === STATUS_JUDGED) {
    return { kind: 'duplicate', ledgerStatus: ledgerRow ? text(ledgerRow, 'status') : '—' }
  }
  if (text(row, 'status') !== STATUS_RUNNING) {
    return { kind: 'notRunning' }
  }
  const cond = effectiveCondition(row)
  if (!cond.approved) {
    return { kind: 'notApproved' }
  }
  const workshop = parseCount(row['车间污染瓶数'])
  if (workshop === null) {
    return { kind: 'workshopInvalid', value: String(row['车间污染瓶数'] ?? '').trim() || '空' }
  }
  if (!ledgerRow) {
    return { kind: 'ledgerInvalid', value: '台账未记录' }
  }
  const ledgerCount = parseCount(ledgerRow['污染瓶数'])
  if (ledgerCount === null) {
    return { kind: 'ledgerInvalid', value: String(ledgerRow['污染瓶数'] ?? '').trim() || '空' }
  }
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    return { kind: 'batchInvalid', value: String(row['灌装批量'] ?? '').trim() || '空' }
  }
  const limit = contaminationLimit(batchSize)
  if (workshop > batchSize || ledgerCount > batchSize) {
    // 越界优先：瓶数比整批批量还大，数据本身不成立。
    return {
      kind: 'workshopInvalid',
      value: `${Math.max(workshop, ledgerCount)}（超过灌装批量${batchSize}）`,
    }
  }
  const tempConflict = cond.tempConflict
  if (workshop !== ledgerCount) {
    if (tempConflict) {
      // 瓶数与培养温度两处相左：先判优先级，质量部台账高于车间读数，按台账那份判。
      return {
        kind: 'conflictRuling',
        workshop,
        ledger: ledgerCount,
        registeredTemp: text(row, '培养温度'),
        approvedTemp: cond.temperature,
        limit,
      }
    }
    // 只瓶数对不上：挡回核对，不按任何一份往下判。
    return { kind: 'countMismatch', workshop: String(workshop), ledger: ledgerCount }
  }
  if (workshop > limit) {
    return { kind: 'overLimit', count: workshop, limit }
  }
  return { kind: 'pass', count: workshop, limit }
}

/** 勾选多条批量判定：逐条给结论；超限的整组（同一培养条件）倒序退回重来。 */
export function batchJudge(selectedIds: number[]): BatchJudgeResult {
  const rows = listRows(MEDIAFILL)
  const ledger = listRows(STABILITY)
  const selected = rows.filter((row) => selectedIds.includes(Number(row.id)))
  const lines: OutcomeLine[] = []

  const overLimitGroups = new Map<string, { limit: number }>()
  const judgedNow: { row: EntryRow; count: number; limit: number }[] = []

  for (const row of selected) {
    const code = text(row, '灌装编号')
    const batchSize = parseBatch(row) ?? 0
    const ledgerRow = findLedger(ledger, code)
    const result = precheck(row, ledgerRow, batchSize)

    switch (result.kind) {
      case 'duplicate':
        // 同一批灌装重复判定只算一次。
        lines.push({
          code,
          level: 'info',
          detail: `已判定过，重复判定只算一次（台账状态「${result.ledgerStatus}」，未重复记账）`,
        })
        break
      case 'notRunning':
        lines.push({
          code,
          level: 'skip',
          detail: `当前状态「${text(row, 'status')}」，不是灌装中，无法判定`,
        })
        break
      case 'notApproved':
        lines.push({
          code,
          level: 'block',
          detail: '培养条件未经质量部核定，先核定培养温度/天数，再做判定',
        })
        break
      case 'workshopInvalid':
        lines.push({
          code,
          level: 'block',
          detail: `车间污染瓶数「${result.value}」越界（应为非负整数且不超过灌装批量），本条挡回`,
        })
        break
      case 'ledgerInvalid':
        lines.push({
          code,
          level: 'block',
          detail: `质量部台账污染瓶数「${result.value}」越界或缺失，本条挡回`,
        })
        break
      case 'batchInvalid':
        lines.push({
          code,
          level: 'block',
          detail: `灌装批量「${result.value}」无效，无法计算污染限度，本条挡回`,
        })
        break
      case 'countMismatch':
        lines.push({
          code,
          level: 'block',
          detail: `两处污染瓶数对不上：车间${result.workshop}瓶 / 台账${result.ledger}瓶，先核对再判，本条挡回`,
        })
        break
      case 'conflictRuling':
        lines.push({
          code,
          level: 'info',
          detail:
            `瓶数(${result.workshop}/${result.ledger})与培养温度(${result.registeredTemp}/${result.approvedTemp})两处相左；` +
            `按优先级采用质量部台账：${result.ledger}瓶（限度${result.limit}瓶）`,
        })
        if (result.ledger > result.limit) {
          overLimitGroups.set(effectiveCondition(row).key, { limit: result.limit })
        } else {
          judgedNow.push({ row, count: result.ledger, limit: result.limit })
        }
        break
      case 'overLimit':
        lines.push({
          code,
          level: 'return',
          detail: `污染瓶数${result.count}瓶，超过限度${result.limit}瓶，触发整组退回`,
        })
        overLimitGroups.set(effectiveCondition(row).key, { limit: result.limit })
        break
      case 'pass':
        judgedNow.push({ row, count: result.count, limit: result.limit })
        break
    }
  }

  let nextRows = [...rows]
  let nextLedger = [...ledger]
  const returnedGroups: { key: string; limit: number; count: number }[] = []

  if (overLimitGroups.size > 0) {
    // 超限整组退回：同一培养条件下所有在途/已判定记录，按状态倒序退回待灌装重来。
    for (const [key, info] of overLimitGroups) {
      const members = nextRows
        .filter(
          (row) =>
            [STATUS_RUNNING, STATUS_JUDGED].includes(text(row, 'status')) &&
            effectiveCondition(row).key === key,
        )
        .sort((a, b) => REVERSIBLE.indexOf(text(b, 'status')) - REVERSIBLE.indexOf(text(a, 'status')))
      for (const member of members) {
        const code = text(member, '灌装编号')
        const index = nextRows.findIndex((item) => item.id === member.id)
        nextRows[index] = {
          ...nextRows[index],
          status: STATUS_PENDING,
          pending: true,
          abnormal: true,
          车间污染瓶数: '',
          判定结论: '',
          最近拒收原因: `污染超限整组退回（限度${info.limit}瓶）`,
        }
        const ledgerRow = findLedger(nextLedger, code)
        if (ledgerRow) {
          const ledgerIndex = nextLedger.findIndex((item) => item.id === ledgerRow.id)
          nextLedger[ledgerIndex] = {
            ...nextLedger[ledgerIndex],
            status: '待考察',
            pending: true,
            abnormal: true,
            考察结果: `污染超限整组退回（限度${info.limit}瓶）`,
            考察状态: '待考察',
          }
        }
      }
      returnedGroups.push({ key, limit: info.limit, count: members.length })
      const condLabel = members[0] ? effectiveCondition(members[0]).label : key
      lines.push({
        code: '整组退回',
        level: 'return',
        detail: `培养条件 ${condLabel} 全组 ${members.length} 条已按状态倒序拒收，退回待灌装重来`,
      })
    }
    // 同组内原本合格的也被连坐退回，不再落判定。
    const returnedKeys = new Set(overLimitGroups.keys())
    for (let i = judgedNow.length - 1; i >= 0; i--) {
      if (returnedKeys.has(effectiveCondition(judgedNow[i].row).key)) {
        judgedNow.splice(i, 1)
      }
    }
  }

  for (const item of judgedNow) {
    const code = text(item.row, '灌装编号')
    const index = nextRows.findIndex((row) => row.id === item.row.id)
    const cond = effectiveCondition(nextRows[index])
    const conclusion = `符合要求（污染瓶数${item.count}瓶，限度${item.limit}瓶）`
    nextRows[index] = {
      ...nextRows[index],
      status: STATUS_JUDGED,
      pending: false,
      abnormal: false,
      判定结论: conclusion,
      最近拒收原因: '',
    }
    const ledgerRow = findLedger(nextLedger, code)
    if (ledgerRow) {
      const ledgerIndex = nextLedger.findIndex((row) => row.id === ledgerRow.id)
      nextLedger[ledgerIndex] = {
        ...nextLedger[ledgerIndex],
        status: '已完成',
        pending: false,
        abnormal: false,
        考察批号: text(nextRows[index], '灌装批号'),
        考察条件: cond.label,
        污染瓶数: item.count,
        考察结果: conclusion,
        考察状态: '已完成',
      }
    }
    lines.push({
      code,
      level: 'ok',
      detail: `判定符合要求：污染瓶数${item.count}瓶，限度${item.limit}瓶；结论与瓶数已同步台账`,
    })
  }

  saveRows(MEDIAFILL, nextRows)
  saveRows(STABILITY, nextLedger)
  return { lines, returnedGroups }
}

/** 倒序拒收：状态只回退一段（已判定/灌装中 -> 待灌装），台账同步退回。 */
export function rejectOne(id: number): OutcomeLine {
  const rows = listRows(MEDIAFILL)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { code: String(id), level: 'block', detail: '没有找到这条灌装记录' }
  }
  const row = rows[index]
  const code = text(row, '灌装编号')
  const current = text(row, 'status')
  if (!REVERSIBLE.includes(current)) {
    return { code, level: 'skip', detail: `「${STATUS_TERMINATED}」记录不再参与退回` }
  }
  if (current === STATUS_PENDING) {
    return { code, level: 'skip', detail: '已经是待灌装，不能再倒序拒收' }
  }
  const nextRows = [...rows]
  nextRows[index] = {
    ...row,
    status: STATUS_PENDING,
    pending: true,
    abnormal: true,
    车间污染瓶数: '',
    判定结论: '',
    最近拒收原因: '倒序拒收，退回上一段重来',
  }
  let nextLedger = listRows(STABILITY)
  const ledgerRow = findLedger(nextLedger, code)
  if (ledgerRow) {
    const ledgerIndex = nextLedger.findIndex((item) => item.id === ledgerRow.id)
    nextLedger = [...nextLedger]
    nextLedger[ledgerIndex] = {
      ...nextLedger[ledgerIndex],
      status: '待考察',
      pending: true,
      abnormal: true,
      考察结果: '随灌装倒序拒收退回',
      考察状态: '待考察',
    }
  }
  saveRows(MEDIAFILL, nextRows)
  saveRows(STABILITY, nextLedger)
  return { code, level: 'return', detail: '已倒序拒收，状态回退一段至待灌装，台账同步退回' }
}

/** 终止灌装：走到末段，台账同步终止。 */
export function terminateOne(id: number): OutcomeLine {
  const rows = listRows(MEDIAFILL)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { code: String(id), level: 'block', detail: '没有找到这条灌装记录' }
  }
  const row = rows[index]
  const code = text(row, '灌装编号')
  const nextRows = [...rows]
  nextRows[index] = { ...row, status: STATUS_TERMINATED, pending: false, abnormal: true }
  let nextLedger = listRows(STABILITY)
  const ledgerRow = findLedger(nextLedger, code)
  if (ledgerRow) {
    const ledgerIndex = nextLedger.findIndex((item) => item.id === ledgerRow.id)
    nextLedger = [...nextLedger]
    nextLedger[ledgerIndex] = {
      ...nextLedger[ledgerIndex],
      status: '已终止',
      pending: false,
      abnormal: true,
      考察状态: '已终止',
    }
  }
  saveRows(MEDIAFILL, nextRows)
  saveRows(STABILITY, nextLedger)
  return { code, level: 'info', detail: '灌装已终止，稳定性台账同步终止' }
}

/** 质量部核定培养条件：核定温度/天数生效，台账考察条件同步更新。 */
export function approveCondition(
  id: number,
  temperature: string,
  days: string,
): OutcomeLine {
  const rows = listRows(MEDIAFILL)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { code: String(id), level: 'block', detail: '没有找到这条灌装记录' }
  }
  const temp = temperature.trim()
  const dayValue = days.trim()
  if (!temp || !/^\d+$/.test(dayValue)) {
    return { code: text(rows[index], '灌装编号'), level: 'block', detail: '核定温度与培养天数（整数天）都要填写' }
  }
  const row = rows[index]
  const code = text(row, '灌装编号')
  const nextRows = [...rows]
  nextRows[index] = {
    ...row,
    培养条件核定: '已核定',
    核定温度: temp,
    核定天数: Number(dayValue),
  }
  const cond = effectiveCondition(nextRows[index])
  let nextLedger = listRows(STABILITY)
  const ledgerRow = findLedger(nextLedger, code)
  if (ledgerRow) {
    const ledgerIndex = nextLedger.findIndex((item) => item.id === ledgerRow.id)
    nextLedger = [...nextLedger]
    nextLedger[ledgerIndex] = { ...nextLedger[ledgerIndex], 考察条件: cond.label }
  }
  saveRows(MEDIAFILL, nextRows)
  saveRows(STABILITY, nextLedger)
  return {
    code,
    level: 'ok',
    detail: `质量部已核定培养条件 ${cond.label}，判定时以核定值为准`,
  }
}

/** 录入两处污染瓶数：车间培养读数写灌装记录，质量部复核数写稳定性台账。 */
export function recordCounts(id: number, workshop: string, ledgerCount: string): OutcomeLine {
  const rows = listRows(MEDIAFILL)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { code: String(id), level: 'block', detail: '没有找到这条灌装记录' }
  }
  const row = rows[index]
  const code = text(row, '灌装编号')
  const workshopValue = workshop.trim()
  const ledgerValue = ledgerCount.trim()
  if (workshopValue === '' || ledgerValue === '') {
    return { code, level: 'block', detail: '车间读数与台账数都要填写' }
  }
  const nextRows = [...rows]
  nextRows[index] = { ...row, 车间污染瓶数: workshopValue, 台账污染瓶数: ledgerValue }

  // 台账两处同源核对：灌装在灌装中时台账必须已挂上（送灌装时自动建档）。
  let nextLedger = listRows(STABILITY)
  let target = findLedger(nextLedger, code)
  if (!target) {
    target = buildLedger(nextRows[index], nextLedgerId(nextLedger))
    nextLedger = [...nextLedger, target]
  }
  const ledgerIndex = nextLedger.findIndex((item) => item.id === target!.id)
  nextLedger[ledgerIndex] = { ...nextLedger[ledgerIndex], 污染瓶数: ledgerValue }

  saveRows(MEDIAFILL, nextRows)
  saveRows(STABILITY, nextLedger)
  const same = workshopValue === String(parseCount(ledgerValue))
  return {
    code,
    level: same ? 'ok' : 'info',
    detail: same
      ? `两处污染瓶数一致：${ledgerValue}瓶`
      : `两处污染瓶数暂不一致：车间${workshopValue}瓶 / 台账${ledgerValue}瓶，判定时会核对`,
  }
}

export function mediafillStats(): { pending: number; running: number; totalContamination: number } {
  const rows = listRows(MEDIAFILL)
  return {
    pending: rows.filter((row) => text(row, 'status') === STATUS_PENDING).length,
    running: rows.filter((row) => text(row, 'status') === STATUS_RUNNING).length,
    totalContamination: rows.reduce((sum, row) => sum + (parseCount(row['台账污染瓶数']) ?? 0), 0),
  }
}

export function resetMediafillDemo(): void {
  resetRows(STABILITY)
  resetRows(MEDIAFILL)
}
