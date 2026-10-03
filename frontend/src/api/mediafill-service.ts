import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 培养基模拟灌装的批量业务都在这一层：
// 按培养条件分组、按灌装规格分批、质量部核定、整组退回、台账同步与双份核对。
const MEDIA_KEY = 'mediafill'
const STABILITY_KEY = 'stability'

export const MEDIA_STATUSES = ['待灌装', '灌装中', '已判定', '已终止'] as const
// GMP 对培养基模拟灌装的可接受标准：污染瓶数为 0，超过限度即整组作废重来。
export const CONTAMINATION_LIMIT = 0

export type LineResult = {
  id: number
  code: string
  spec: string
  ok: boolean
  kind: 'advance' | 'judge' | 'block' | 'return' | 'skip'
  message: string
  note?: string
}

export type BatchSection = {
  title: string
  tone: 'tip' | 'batch' | 'return' | 'skip'
  lines: LineResult[]
}

export type BatchReport = {
  ok: boolean
  sections: BatchSection[]
  ledgerNote: string
}

type WorkingSet = {
  media: EntryRow[]
  ledger: EntryRow[]
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function text(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

function num(row: EntryRow, field: string): number {
  const value = Number(row[field])
  return Number.isFinite(value) ? value : NaN
}

/** 培养条件分组键：培养温度 + 培养天数，二者共同确定一个培养条件。 */
export function conditionKey(row: EntryRow): string {
  return `${text(row, '培养温度')}|${text(row, '培养天数')}`
}

export function conditionLabel(row: EntryRow): string {
  const temp = text(row, '培养温度') || '温度缺失'
  const days = text(row, '培养天数') || '培养天数缺失'
  return `${temp} / ${days}`
}

function ledgerCodeFor(mediaCode: string): string {
  return `STAB-MF-${mediaCode}`
}

function load(): WorkingSet {
  return { media: listRows(MEDIA_KEY), ledger: listRows(STABILITY_KEY) }
}

function commit(working: WorkingSet): void {
  saveRows(MEDIA_KEY, working.media)
  saveRows(STABILITY_KEY, working.ledger)
}

function pendingOf(status: string): boolean {
  return status === '待灌装' || status === '灌装中'
}

/** 同步到稳定性考察台账：按考察编号幂等写入，已存在的台账不覆盖其原始检验数据。 */
function upsertLedger(
  working: WorkingSet,
  mediaRow: EntryRow,
  patch: Partial<EntryRow>,
): { created: boolean; ledger: EntryRow } {
  const code = text(mediaRow, '灌装编号')
  const ledgerCode = ledgerCodeFor(code)
  const index = working.ledger.findIndex((row) => text(row, '考察编号') === ledgerCode)
  if (index >= 0) {
    const merged: EntryRow = { ...working.ledger[index], ...patch } as EntryRow
    working.ledger[index] = merged
    return { created: false, ledger: merged }
  }
  const nextId = working.ledger.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const created: EntryRow = {
    id: nextId,
    status: '考察中',
    pending: true,
    abnormal: false,
    考察编号: ledgerCode,
    考察批号: code,
    考察条件: conditionLabel(mediaRow),
    考察时间点: `同步于送灌装 ${today()}`,
    检验项目: '微生物计数（同步培养基模拟灌装）',
    考察结果: '灌装动作已同步，等待培养判定',
    考察人: '灌装岗（系统同步）',
    考察状态: '考察中',
    关联灌装编号: code,
    培养温度: text(mediaRow, '培养温度'),
    污染瓶数: '',
    台账核定: false,
  } as EntryRow
  const row: EntryRow = { ...created, ...patch } as EntryRow
  working.ledger.push(row)
  return { created: true, ledger: row }
}

/**
 * 污染瓶数两处核对：灌装记录一份、稳定性台账一份。
 * 先判优先级再定按哪一份：
 *   1. 台账已由质量部核定，按台账；
 *   2. 台账未核定但灌装培养条件已核定，按灌装；
 *   3. 两边都没核定，按现场较早形成的灌装记录；
 *   4. 两边都已核定却仍相左，优先级并列，挡回并转质量部裁决。
 */
function reconcilePair(
  working: WorkingSet,
  mediaRow: EntryRow,
  count: number,
): { status: 'consistent' | 'resolved' | 'conflict'; message: string } {
  const ledgerCode = ledgerCodeFor(text(mediaRow, '灌装编号'))
  const ledger = working.ledger.find((row) => text(row, '考察编号') === ledgerCode)
  if (!ledger) {
    upsertLedger(working, mediaRow, {
      status: '考察中',
      pending: true,
      考察状态: '考察中',
      培养温度: text(mediaRow, '培养温度'),
      污染瓶数: count,
    })
    return { status: 'consistent', message: '台账此前缺记录，已按灌装记录补登，两处一致' }
  }

  const ledgerTemp = text(ledger, '培养温度')
  const mediaTemp = text(mediaRow, '培养温度')
  const ledgerCount = Number(ledger.污染瓶数)
  const tempMismatch = ledgerTemp !== '' && ledgerTemp !== mediaTemp
  const countMismatch = Number.isFinite(ledgerCount) && ledgerCount !== count
  if (!tempMismatch && !countMismatch) {
    return { status: 'consistent', message: `两处对得上（培养温度 ${mediaTemp}、污染瓶数 ${count}）` }
  }

  const mediaApproved = mediaRow.条件核定 === true
  const ledgerApproved = ledger.台账核定 === true
  const detail = `灌装：${mediaTemp} / ${count} 瓶；台账：${ledgerTemp || '空缺'} / ${
    Number.isFinite(ledgerCount) ? ledgerCount : '空缺'
  } 瓶`

  if (mediaApproved && ledgerApproved) {
    return {
      status: 'conflict',
      message: `两处数据相左且均已核定，优先级并列，挡回转质量部裁决（${detail}）`,
    }
  }

  if (ledgerApproved) {
    mediaRow.培养温度 = ledgerTemp || mediaTemp
    mediaRow.污染瓶数 = Number.isFinite(ledgerCount) ? ledgerCount : count
    mediaRow.核对备注 = `与台账相左，按优先级采用台账核定值（${detail}）`
    return {
      status: 'resolved',
      message: `与台账相左，台账已核定优先级更高，按台账 ${ledgerTemp} / ${
        Number.isFinite(ledgerCount) ? ledgerCount : count
      } 瓶回填灌装记录`,
    }
  }

  // 灌装已核定，或两边都没核定（现场灌装记录较早形成）：按灌装并回写台账。
  const reason = mediaApproved ? '灌装培养条件已经质量部核定' : '两边均未核定，按较早形成的灌装记录'
  ledger.培养温度 = mediaTemp
  ledger.污染瓶数 = count
  ledger.核对备注 = `与灌装记录相左，${reason}，按灌装回填（${detail}）`
  mediaRow.核对备注 = `与台账相左，${reason}，两处已统一`
  return {
    status: 'resolved',
    message: `与台账相左，${reason}，按灌装 ${mediaTemp} / ${count} 瓶回写台账`,
  }
}

function findRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

/** 污染瓶数越界校验：空值、非数字、负数、超过本批灌装批量，都算越界。 */
function parseCount(row: EntryRow): { value: number; error?: string } {
  const raw = text(row, '污染瓶数')
  const value = Number(raw)
  if (raw === '' || !Number.isInteger(value) || value < 0) {
    return { value: NaN, error: `污染瓶数「${raw || '未填报'}」越界（需为非负整数），已挡回` }
  }
  const batchSize = num(row, '灌装批量')
  if (Number.isFinite(batchSize) && batchSize >= 0 && value > batchSize) {
    return { value, error: `污染瓶数 ${value} 超过灌装批量 ${batchSize}，越界，已挡回` }
  }
  return { value }
}

function lineBase(row: EntryRow, kind: LineResult['kind'], ok: boolean, message: string): LineResult {
  return {
    id: Number(row.id),
    code: text(row, '灌装编号'),
    spec: text(row, '灌装规格') || '规格缺失',
    ok,
    kind,
    message,
  }
}

/** 批量送灌装：缺规格/培养温度/培养天数的先单独提示并挡下，其余按培养条件→规格分批推进。 */
export function batchSendFill(ids: number[]): BatchReport {
  const working = load()
  const tips: LineResult[] = []
  const skipped: LineResult[] = []
  const picked: EntryRow[] = []

  for (const id of ids) {
    const row = findRow(working.media, id)
    if (!row) {
      tips.push({ id, code: `#${id}`, spec: '—', ok: false, kind: 'block', message: '记录不存在' })
      continue
    }
    const missing: string[] = []
    if (!text(row, '灌装规格')) missing.push('灌装规格')
    if (!text(row, '培养温度')) missing.push('培养温度')
    if (!text(row, '培养天数')) missing.push('培养天数')
    if (missing.length) {
      tips.push(lineBase(row, 'block', false, `${missing.join('、')}缺失，先补齐再送灌装，本条挡下`))
      continue
    }
    const status = String(row.status)
    if (status === '已终止') {
      skipped.push(lineBase(row, 'skip', false, '已终止的灌装不再接收，跳过'))
      continue
    }
    if (status !== '待灌装') {
      skipped.push(lineBase(row, 'skip', false, `当前为「${status}」，不是待灌装，跳过`))
      continue
    }
    picked.push(row)
  }

  const sections: BatchSection[] = []
  if (tips.length) {
    sections.push({ title: '先单独提示（信息缺失，未推进）', tone: 'tip', lines: tips })
  }

  const groups = new Map<string, { label: string; specs: Map<string, EntryRow[]> }>()
  for (const row of picked) {
    const key = conditionKey(row)
    if (!groups.has(key)) {
      groups.set(key, { label: conditionLabel(row), specs: new Map<string, EntryRow[]>() })
    }
    const group = groups.get(key)!
    const spec = text(row, '灌装规格')
    if (!group.specs.has(spec)) group.specs.set(spec, [])
    group.specs.get(spec)!.push(row)
  }

  let ledgerCreates = 0
  let ledgerUpdates = 0
  for (const group of groups.values()) {
    for (const [spec, specRows] of group.specs) {
      const lines: LineResult[] = []
      for (const row of specRows) {
        row.status = '灌装中'
        row.pending = true
        row.abnormal = false
        row.判定结论 = ''
        row.判定时间 = ''
        row.污染瓶数 = ''
        row.核对备注 = ''
        row.条件核定 = row.条件核定 === true
        row.送灌装时间 = today()
        const { created } = upsertLedger(working, row, {
          status: '考察中',
          pending: true,
          abnormal: false,
          考察状态: '考察中',
          考察结果: '已送灌装，台账同步建立关联',
          考察条件: conditionLabel(row),
        })
        if (created) ledgerCreates += 1
        else ledgerUpdates += 1
        lines.push(
          lineBase(
            row,
            'advance',
            true,
            `已按规格「${spec}」一次送灌装，状态 待灌装 → 灌装中；动作已同步稳定性考察台账`,
          ),
        )
      }
      sections.push({
        title: `培养条件 ${group.label} ｜ 灌装规格 ${spec}（${specRows.length} 条）`,
        tone: 'batch',
        lines,
      })
    }
  }

  if (skipped.length) {
    sections.push({ title: '未参与本次推进', tone: 'skip', lines: skipped })
  }

  commit(working)
  const moved = picked.length
  return {
    ok: tips.length === 0,
    sections,
    ledgerNote:
      moved > 0
        ? `稳定性考察台账同步完成：新建 ${ledgerCreates} 条、更新 ${ledgerUpdates} 条；本次共推进 ${moved} 条。`
        : '本次没有可推进的记录。',
  }
}

/**
 * 批量判定：
 *  - 培养条件未经质量部核定的，先提示挡下；
 *  - 污染瓶数越界的逐条挡回；
 *  - 同一培养条件组内出现超限（超过 0 瓶），整组（含组内其他灌装中记录）倒序退回到待灌装重来；
 *  - 其余逐条判定，结论附污染瓶数，并与稳定性台账核对、按优先级统一两份数据；
 *  - 已判定的记录重复判定只算一次。
 */
export function batchJudge(ids: number[]): BatchReport {
  const working = load()
  const tips: LineResult[] = []
  const skipped: LineResult[] = []
  const candidates: EntryRow[] = []

  for (const id of ids) {
    const row = findRow(working.media, id)
    if (!row) {
      tips.push({ id, code: `#${id}`, spec: '—', ok: false, kind: 'block', message: '记录不存在' })
      continue
    }
    const status = String(row.status)
    if (status === '已判定') {
      skipped.push(
        lineBase(row, 'skip', false, '该批灌装已判定过，同一批重复判定只算一次，跳过'),
      )
      continue
    }
    if (status === '已终止') {
      skipped.push(lineBase(row, 'skip', false, '已终止，不能再判定，跳过'))
      continue
    }
    if (status !== '灌装中') {
      skipped.push(lineBase(row, 'skip', false, `当前为「${status}」，需先送灌装，跳过`))
      continue
    }
    candidates.push(row)
  }

  // 培养条件核定是质量部给的整组前置条件。
  const approvedBlocked: EntryRow[] = []
  const valid: EntryRow[] = []
  for (const row of candidates) {
    if (row.条件核定 !== true) {
      approvedBlocked.push(row)
    } else {
      valid.push(row)
    }
  }
  for (const row of approvedBlocked) {
    tips.push(
      lineBase(
        row,
        'block',
        false,
        `培养条件「${conditionLabel(row)}」未经质量部核定，先完成条件核定再判定，本条挡下`,
      ),
    )
  }

  // 越界逐条挡回。
  const boundaryBlocked: LineResult[] = []
  const counted: { row: EntryRow; count: number }[] = []
  for (const row of valid) {
    const parsed = parseCount(row)
    if (parsed.error) {
      boundaryBlocked.push(lineBase(row, 'block', false, parsed.error))
    } else {
      counted.push({ row, count: parsed.value })
    }
  }
  if (boundaryBlocked.length) {
    tips.push(...boundaryBlocked)
  }

  // 超限判定按培养条件整组处理：组内任一条灌装中记录超限（不限是否勾选），全组倒序退回。
  const touchedKeys = new Set(counted.map((item) => conditionKey(item.row)))
  const exceededKeys = new Set<string>()
  for (const key of touchedKeys) {
    const anyExceeded = working.media.some(
      (row) =>
        conditionKey(row) === key &&
        String(row.status) === '灌装中' &&
        Number(row.污染瓶数) > CONTAMINATION_LIMIT,
    )
    if (anyExceeded) exceededKeys.add(key)
  }

  const returnSections: BatchSection[] = []
  for (const key of exceededKeys) {
    const triggers = working.media.filter(
      (row) => conditionKey(row) === key && Number(row.污染瓶数) > CONTAMINATION_LIMIT,
    )
    const groupRows = working.media.filter(
      (row) => conditionKey(row) === key && String(row.status) === '灌装中',
    )
    const lines: LineResult[] = []
    const triggerCodes = new Set(triggers.map((row) => text(row, '灌装编号')))
    for (const row of groupRows) {
      const isTrigger = triggerCodes.has(text(row, '灌装编号'))
      row.status = '待灌装'
      row.pending = true
      row.abnormal = isTrigger
      row.判定结论 = ''
      row.判定时间 = ''
      row.条件核定 = false
      row.核定人 = ''
      row.核定时间 = ''
      row.核对备注 = isTrigger ? '污染瓶数超限，整组退回重来' : '同培养条件组内出现超限，连坐退回重来'
      upsertLedger(working, row, {
        status: '待考察',
        pending: true,
        abnormal: isTrigger,
        考察状态: '待考察',
        考察结果: isTrigger
          ? '灌装组污染瓶数超限，整组退回重来'
          : '同培养条件组超限连坐退回，重新考察',
      })
      lines.push(
        lineBase(
          row,
          'return',
          false,
          isTrigger
            ? `污染瓶数 ${text(row, '污染瓶数')} 超出限度 ${CONTAMINATION_LIMIT}，本组整组退回，状态 灌装中 → 待灌装，重来`
            : '同培养条件组内污染瓶数超限，连坐整组退回，状态 灌装中 → 待灌装，重来',
        ),
      )
    }
    const groupLabel = groupRows[0] ? conditionLabel(groupRows[0]) : key
    returnSections.push({
      title: `整组退回 ｜ 培养条件 ${groupLabel}（${groupRows.length} 条全部倒序拒收）`,
      tone: 'return',
      lines,
    })
  }

  // 未退回的组逐条判定，灌装按规格分批出结果。
  const judgeGroups = new Map<string, Map<string, { row: EntryRow; count: number }[]>>()
  for (const item of counted) {
    const key = conditionKey(item.row)
    if (exceededKeys.has(key)) continue
    if (!judgeGroups.has(key)) {
      judgeGroups.set(key, new Map<string, { row: EntryRow; count: number }[]>())
    }
    const specMap = judgeGroups.get(key)!
    const spec = text(item.row, '灌装规格')
    if (!specMap.has(spec)) specMap.set(spec, [])
    specMap.get(spec)!.push(item)
  }

  const judgeSections: BatchSection[] = []
  for (const [, specMap] of judgeGroups)
    for (const [spec, items] of specMap) {
      const lines: LineResult[] = []
      for (const { row, count } of items) {
        const outcome = reconcilePair(working, row, count)
        if (outcome.status === 'conflict') {
          row.abnormal = true
          lines.push(lineBase(row, 'block', false, outcome.message))
          continue
        }
        const finalCount = Number(row.污染瓶数)
        row.status = '已判定'
        row.pending = false
        row.abnormal = false
        row.判定结论 = `合格（污染瓶数 ${finalCount}，限度 ${CONTAMINATION_LIMIT}）`
        row.判定时间 = today()
        row.核对备注 = outcome.message
        upsertLedger(working, row, {
          status: '已完成',
          pending: false,
          abnormal: false,
          考察状态: '已完成',
          考察结果: `判定合格（污染瓶数 ${finalCount}，限度 ${CONTAMINATION_LIMIT}）`,
          培养温度: text(row, '培养温度'),
          污染瓶数: finalCount,
        })
        lines.push({
          ...lineBase(
            row,
            'judge',
            true,
            `判定完成：合格（污染瓶数 ${finalCount}，限度 ${CONTAMINATION_LIMIT}），状态 灌装中 → 已判定`,
          ),
          note: outcome.message,
        })
      }
      const groupLabel = items[0] ? conditionLabel(items[0].row) : ''
      judgeSections.push({
        title: `培养条件 ${groupLabel} ｜ 灌装规格 ${spec}（${items.length} 条）`,
        tone: 'batch',
        lines,
      })
    }

  commit(working)
  const sections: BatchSection[] = [
    ...(tips.length ? [{ title: '先单独提示（未推进）', tone: 'tip' as const, lines: tips }] : []),
    ...judgeSections,
    ...returnSections,
    ...(skipped.length ? [{ title: '未参与本次判定', tone: 'skip' as const, lines: skipped }] : []),
  ]
  const processed = counted.filter((item) => !exceededKeys.has(conditionKey(item.row))).length
  return {
    ok: tips.length === 0 && returnSections.length === 0,
    sections,
    ledgerNote: `判定与核对完成：合格判定 ${processed} 条，整组退回 ${exceededKeys.size} 组；结论、污染瓶数与核对结果均已同步稳定性考察台账。`,
  }
}

/** 单条倒序拒收：已判定退回灌装中，灌装中退回待灌装，状态一段一段往回走。 */
export function rejectOne(id: number): ActionResult {
  const working = load()
  const row = findRow(working.media, id)
  if (!row) return { ok: false, message: '没有找到这条灌装记录' }
  const status = String(row.status)
  if (status === '已终止') return { ok: false, message: '已终止的记录不能拒收' }
  if (status === '待灌装') return { ok: false, message: '已经是待灌装，没有更前的状态可退' }

  if (status === '已判定') {
    row.status = '灌装中'
    row.pending = true
    row.abnormal = true
    row.判定结论 = ''
    row.判定时间 = ''
    row.核对备注 = '判定被倒序拒收，退回灌装中复核'
    upsertLedger(working, row, {
      status: '考察中',
      pending: true,
      abnormal: true,
      考察状态: '考察中',
      考察结果: '灌装判定被拒收，退回考察中',
    })
    commit(working)
    return { ok: true, message: '已倒序拒收：已判定 → 灌装中，台账同步退回考察中' }
  }

  row.status = '待灌装'
  row.pending = true
  row.abnormal = true
  row.核对备注 = '灌装中被倒序拒收，退回待灌装'
  upsertLedger(working, row, {
    status: '待考察',
    pending: true,
    abnormal: true,
    考察状态: '待考察',
    考察结果: '灌装被拒收，台账退回待考察',
  })
  commit(working)
  return { ok: true, message: '已倒序拒收：灌装中 → 待灌装，台账同步退回待考察' }
}

export function terminateOne(id: number): ActionResult {
  const working = load()
  const row = findRow(working.media, id)
  if (!row) return { ok: false, message: '没有找到这条灌装记录' }
  if (String(row.status) === '已终止') return { ok: false, message: '该记录已经终止' }
  row.status = '已终止'
  row.pending = false
  row.abnormal = true
  upsertLedger(working, row, {
    status: '已终止',
    pending: false,
    abnormal: true,
    考察状态: '已终止',
    考察结果: '灌装终止，考察同步终止',
  })
  commit(working)
  return { ok: true, message: '灌装已终止，稳定性考察台账同步终止' }
}

/** 培养条件由质量部核定：对同一培养条件组整体生效。 */
export function approveCondition(key: string, approver: string): ActionResult {
  const working = load()
  const rows = working.media.filter((row) => conditionKey(row) === key)
  if (!rows.length) return { ok: false, message: '该培养条件下没有记录' }
  const stamp = today()
  for (const row of rows) {
    row.条件核定 = true
    row.核定人 = approver
    row.核定时间 = stamp
  }
  commit(working)
  return { ok: true, message: `培养条件「${conditionLabel(rows[0])}」已由${approver}核定，组内 ${rows.length} 条生效` }
}

export function updateCount(id: number, value: string): ActionResult {
  const working = load()
  const row = findRow(working.media, id)
  if (!row) return { ok: false, message: '没有找到这条灌装记录' }
  if (String(row.status) !== '灌装中') {
    return { ok: false, message: '只有灌装中的记录可以登记污染瓶数' }
  }
  row.污染瓶数 = value
  commit(working)
  return { ok: true, message: '污染瓶数已暂存，批量判定时统一核对' }
}

/** 两处核对：把勾选记录与稳定性台账逐一比对，相左时按优先级统一为同一份。 */
export function reconcileSelected(ids: number[]): BatchReport {
  const working = load()
  const tips: LineResult[] = []
  const lines: LineResult[] = []
  for (const id of ids) {
    const row = findRow(working.media, id)
    if (!row) {
      tips.push({ id, code: `#${id}`, spec: '—', ok: false, kind: 'block', message: '记录不存在' })
      continue
    }
    const parsed = parseCount(row)
    if (parsed.error) {
      tips.push(lineBase(row, 'block', false, parsed.error))
      continue
    }
    const outcome = reconcilePair(working, row, parsed.value)
    lines.push({
      ...lineBase(
        row,
        outcome.status === 'conflict' ? 'block' : 'judge',
        outcome.status !== 'conflict',
        outcome.message,
      ),
    })
    if (outcome.status !== 'conflict') {
      const finalCount = Number(row.污染瓶数)
      upsertLedger(working, row, {
        培养温度: text(row, '培养温度'),
        污染瓶数: finalCount,
      })
    }
  }
  commit(working)
  const sections: BatchSection[] = []
  if (tips.length) sections.push({ title: '核对挡回', tone: 'tip', lines: tips })
  sections.push({ title: '两处核对结果（灌装记录 × 稳定性台账）', tone: 'batch', lines })
  return {
    ok: tips.length === 0 && lines.every((line) => line.ok),
    sections,
    ledgerNote: '核对完成：一致的予以确认，相左的已按优先级统一两份数据并互相回写。',
  }
}

export type MediaGroup = {
  key: string
  label: string
  approved: boolean
  approver: string
  approvedAt: string
  specs: { spec: string; rows: EntryRow[] }[]
}

export function listMediaRows(filters: Record<string, string> = {}): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  return listRows(MEDIA_KEY).filter((row) =>
    pairs.every(([field, value]) => {
      if (field === 'status') return String(row.status) === value
      return String(row[field] ?? '').includes(value.trim())
    }),
  )
}

export function groupRows(rows: EntryRow[]): MediaGroup[] {
  const map = new Map<string, { label: string; specs: Map<string, EntryRow[]> }>()
  for (const row of rows) {
    const key = conditionKey(row)
    if (!map.has(key)) map.set(key, { label: conditionLabel(row), specs: new Map() })
    const group = map.get(key)!
    const spec = text(row, '灌装规格') || '规格缺失'
    if (!group.specs.has(spec)) group.specs.set(spec, [])
    group.specs.get(spec)!.push(row)
  }
  return [...map.entries()].map(([key, group]) => {
    const approvedRows = rows.filter((row) => conditionKey(row) === key)
    const approved = approvedRows.some((row) => row.条件核定 === true)
    return {
      key,
      label: group.label,
      approved,
      approver: approved ? text(approvedRows.find((row) => row.条件核定 === true)!, '核定人') || '质量部' : '',
      approvedAt: approved ? text(approvedRows.find((row) => row.条件核定 === true)!, '核定时间') : '',
      specs: [...group.specs.entries()].map(([spec, specRows]) => ({ spec, rows: specRows })),
    }
  })
}

export type MediaStats = {
  waiting: number
  filling: number
  judged: number
  terminated: number
  totalContamination: number
}

export function mediaStats(): MediaStats {
  const rows = listRows(MEDIA_KEY)
  // 污染瓶总数只从已判定记录统计：同一批重复判定不会产生第二份结论，天然只算一次。
  const totalContamination = rows
    .filter((row) => String(row.status) === '已判定')
    .reduce((sum, row) => sum + (Number(row.污染瓶数) || 0), 0)
  return {
    waiting: rows.filter((row) => String(row.status) === '待灌装').length,
    filling: rows.filter((row) => String(row.status) === '灌装中').length,
    judged: rows.filter((row) => String(row.status) === '已判定').length,
    terminated: rows.filter((row) => String(row.status) === '已终止').length,
    totalContamination,
  }
}

export { pendingOf }
