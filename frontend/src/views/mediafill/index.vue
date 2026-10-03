<template>
  <section class="page" data-module="mediafill">
    <header class="page-head">
      <div>
        <h2>培养基模拟灌装管理</h2>
        <p class="page-desc">
          按培养条件分组核对灌装记录；勾选多条一次送灌装（按规格分批）、批量判定，逐条给出结果；动作同步稳定性考察台账。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出培养基模拟灌装清单</button>
        <button class="btn ghost" type="button" @click="resetDemo">重置演示数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待灌装批次</span>
        <strong class="stat-value">{{ stats.pending }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">灌装中批次</span>
        <strong class="stat-value">{{ stats.running }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">污染瓶总数（台账口径）</span>
        <strong class="stat-value">{{ stats.totalContamination }}</strong>
      </article>
    </div>

    <div class="rule-card">
      <strong>核对规则</strong>
      <ul>
        <li>送灌装按<strong>灌装规格</strong>分批；规格或培养温度缺失的先单独提示，其余照常推进。</li>
        <li>培养条件（温度/天数）由<strong>质量部核定</strong>，未核定不能判定；核定时与登记温度不一致的，按核定值判。</li>
        <li>污染瓶数两处核对（车间培养读数 / 稳定性台账）：对不上先挡回；瓶数与温度两处都相左时，按优先级<strong>质量部 &gt; 车间</strong>，以台账那份判。</li>
        <li>瓶数越界（非整数、负数、大于批量）单条挡回；超过限度（批量 1‰）<strong>整组退回重来</strong>，按状态倒序拒收。</li>
        <li>判定结论附污染瓶数；同一批灌装重复判定只算一次；每次动作都同步稳定性考察台账。</li>
      </ul>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>灌装编号</span>
        <input v-model="filters.code" placeholder="按灌装编号检索" />
      </label>
      <label class="filter-item">
        <span>灌装规格</span>
        <input v-model="filters.spec" placeholder="按灌装规格检索" />
      </label>
      <label class="filter-item">
        <span>培养条件</span>
        <input v-model="filters.condition" placeholder="如 22.5℃/14天" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="bulk-bar">
      <label class="select-all">
        <input type="checkbox" :checked="allVisibleSelected" @change="toggleAll" />
        全选当前列表（已选 {{ selectedIds.size }} 条）
      </label>
      <button class="btn primary" type="button" :disabled="!selectedIds.size" @click="submitBulk">
        批量送灌装
      </button>
      <button class="btn primary" type="button" :disabled="!selectedIds.size" @click="judgeBulk">
        批量判定
      </button>
      <span class="bulk-hint">批量送灌装处理「待灌装」，批量判定处理「灌装中」，其余逐条提示。</span>
    </div>

    <div v-for="group in groups" :key="group.key" class="group-block">
      <div class="group-head">
        <strong>培养条件：{{ group.label }}</strong>
        <span class="group-tag" :class="{ approved: group.approved }">
          {{ group.approved ? '质量部已核定' : '未经核定（用登记值，不可判定）' }}
        </span>
        <span class="group-meta">共 {{ group.rows.length }} 条</span>
      </div>

      <table class="data-table">
        <thead>
          <tr>
            <th class="col-check">选择</th>
            <th>灌装编号</th>
            <th>灌装规格</th>
            <th>灌装批量</th>
            <th>培养温度（登记/核定）</th>
            <th>培养天数</th>
            <th>污染瓶数（车间/台账）</th>
            <th>灌装批号</th>
            <th>判定结论</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in group.rows"
            :key="String(row.id)"
            :class="{ 'is-returned': row.abnormal && String(row.status) !== '已终止' }"
          >
            <td>
              <input
                type="checkbox"
                :checked="selectedIds.has(Number(row.id))"
                @change="toggleOne(Number(row.id))"
              />
            </td>
            <td>{{ row['灌装编号'] || '—' }}</td>
            <td :class="{ 'cell-missing': !String(row['灌装规格'] ?? '').trim() }">
              {{ row['灌装规格'] || '缺规格' }}
            </td>
            <td>{{ row['灌装批量'] || '—' }}</td>
            <td>
              {{ row['培养温度'] || '缺温度' }}
              <template v-if="row['核定温度']">/ {{ row['核定温度'] }}</template>
              <span v-if="isTempConflict(row)" class="mini-warn" title="登记温度与核定温度相左，按质量部核定值判">
                温度相左·质量部优先
              </span>
            </td>
            <td>{{ conditionOf(row).days || '—' }}</td>
            <td>
              <span :class="countClass(row)">{{ display(row['车间污染瓶数']) }} / {{ display(row['台账污染瓶数']) }}</span>
              <span v-if="countMismatch(row)" class="mini-warn">对不上</span>
            </td>
            <td>{{ row['灌装批号'] || '—' }}</td>
            <td>{{ row['判定结论'] || '—' }}</td>
            <td>
              {{ row.status }}
              <div v-if="row['最近拒收原因']" class="return-reason">{{ row['最近拒收原因'] }}</div>
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="singleAction('submit', row)">送灌装</button>
              <button class="link" type="button" @click="singleAction('judge', row)">判定</button>
              <button class="link" type="button" @click="openApprove(row)">核定条件</button>
              <button class="link" type="button" @click="openCounts(row)">录污染数</button>
              <button class="link danger" type="button" @click="singleAction('reject', row)">拒收</button>
              <button class="link danger" type="button" @click="singleAction('terminate', row)">终止</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="!groups.length" class="empty-state" style="padding: 24px">
      没有符合筛选条件的灌装记录
    </p>

    <div v-if="outcomes.length" class="outcome-panel">
      <div class="outcome-head">
        <strong>逐条结果</strong>
        <button class="link" type="button" @click="outcomes = []">清空结果</button>
      </div>
      <ul>
        <li v-for="(line, index) in outcomes" :key="index" :class="`lv-${line.level}`">
          <span class="outcome-code">{{ line.code }}</span>
          <span>{{ line.detail }}</span>
        </li>
      </ul>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条培养基模拟灌装记录，按培养条件分 {{ groups.length }} 组核对</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="approveTarget" class="modal-mask" @click.self="closeModals">
      <div class="modal">
        <h3>质量部核定培养条件 · {{ approveTarget['灌装编号'] }}</h3>
        <p class="modal-hint">
          登记值：{{ approveTarget['培养温度'] || '缺温度' }} /
          {{ approveTarget['培养天数'] || '缺天数' }}天。核定后判定以核定值为准。
        </p>
        <label class="modal-field">
          <span>核定培养温度</span>
          <input v-model="approveForm.temperature" placeholder="如 22.5℃" />
        </label>
        <label class="modal-field">
          <span>核定培养天数</span>
          <input v-model="approveForm.days" placeholder="如 14" />
        </label>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="confirmApprove">确认核定</button>
          <button class="btn ghost" type="button" @click="closeModals">取消</button>
        </div>
      </div>
    </div>

    <div v-if="countsTarget" class="modal-mask" @click.self="closeModals">
      <div class="modal">
        <h3>录入污染瓶数 · {{ countsTarget['灌装编号'] }}</h3>
        <p class="modal-hint">
          两处分别记录：车间培养读数写灌装记录；质量部复核数写稳定性考察台账（{{ ledgerCodeOf(countsTarget) }}）。
        </p>
        <label class="modal-field">
          <span>车间培养读数（瓶）</span>
          <input v-model="countsForm.workshop" placeholder="非负整数" />
        </label>
        <label class="modal-field">
          <span>质量部台账数（瓶）</span>
          <input v-model="countsForm.ledger" placeholder="非负整数" />
        </label>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="confirmCounts">保存并核对</button>
          <button class="btn ghost" type="button" @click="closeModals">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  approveCondition,
  batchJudge,
  batchSubmitFill,
  contaminationLimit,
  effectiveCondition,
  mediafillStats,
  recordCounts,
  rejectOne,
  resetMediafillDemo,
  terminateOne,
  type OutcomeLine,
} from '@/api/mediafill-service'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const filters = ref({ code: '', spec: '', condition: '' })
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const selectedIds = ref<Set<number>>(new Set())
const outcomes = ref<OutcomeLine[]>([])
const stats = ref({ pending: 0, running: 0, totalContamination: 0 })

const approveTarget = ref<EntryRow | null>(null)
const approveForm = reactive({ temperature: '', days: '' })
const countsTarget = ref<EntryRow | null>(null)
const countsForm = reactive({ workshop: '', ledger: '' })

function display(value: unknown): string {
  const raw = String(value ?? '').trim()
  return raw === '' ? '—' : raw
}

function conditionOf(row: EntryRow) {
  return effectiveCondition(row)
}

function isTempConflict(row: EntryRow): boolean {
  return effectiveCondition(row).tempConflict
}

function countMismatch(row: EntryRow): boolean {
  const workshop = String(row['车间污染瓶数'] ?? '').trim()
  const ledger = String(row['台账污染瓶数'] ?? '').trim()
  if (workshop === '' || ledger === '') {
    return false
  }
  return workshop !== ledger
}

function countClass(row: EntryRow): string {
  if (countMismatch(row)) {
    return 'cell-bad'
  }
  const ledger = Number(row['台账污染瓶数'])
  const batch = Number(row['灌装批量'])
  if (Number.isFinite(ledger) && Number.isFinite(batch) && batch > 0 && ledger > contaminationLimit(batch)) {
    return 'cell-bad'
  }
  return ''
}

function ledgerCodeOf(row: EntryRow): string {
  return `STAB-${String(row['灌装编号'] ?? '')}`
}

const filteredRows = computed(() =>
  rows.value.filter((row) => {
    const code = filters.value.code.trim()
    const spec = filters.value.spec.trim()
    const condition = filters.value.condition.trim()
    if (code && !String(row['灌装编号'] ?? '').includes(code)) {
      return false
    }
    if (spec && !String(row['灌装规格'] ?? '').includes(spec)) {
      return false
    }
    if (condition && !effectiveCondition(row).label.includes(condition)) {
      return false
    }
    return true
  }),
)

const groups = computed(() => {
  const map = new Map<string, { key: string; label: string; approved: boolean; rows: EntryRow[] }>()
  for (const row of filteredRows.value) {
    const cond = effectiveCondition(row)
    const group = map.get(cond.key) ?? { key: cond.key, label: cond.label, approved: cond.approved, rows: [] }
    group.rows.push(row)
    if (cond.approved) {
      group.approved = true
    }
    map.set(cond.key, group)
  }
  return [...map.values()].sort((a, b) => Number(b.approved) - Number(a.approved) || a.label.localeCompare(b.label))
})

const allVisibleSelected = computed(
  () => filteredRows.value.length > 0 && filteredRows.value.every((row) => selectedIds.value.has(Number(row.id))),
)

function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const next = new Set(selectedIds.value)
  for (const row of filteredRows.value) {
    if (checked) {
      next.add(Number(row.id))
    } else {
      next.delete(Number(row.id))
    }
  }
  selectedIds.value = next
}

function toggleOne(id: number) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selectedIds.value = next
}

function pushOutcomes(lines: OutcomeLine[]) {
  outcomes.value = [...lines, ...outcomes.value].slice(0, 50)
}

function submitBulk() {
  const result = batchSubmitFill([...selectedIds.value])
  pushOutcomes(result.lines)
  reload()
}

function judgeBulk() {
  const result = batchJudge([...selectedIds.value])
  pushOutcomes(result.lines)
  reload()
}

function singleAction(kind: 'submit' | 'judge' | 'reject' | 'terminate', row: EntryRow) {
  errorMessage.value = ''
  let line: OutcomeLine
  if (kind === 'submit') {
    const result = batchSubmitFill([Number(row.id)])
    line =
      result.lines[0] ?? { code: String(row['灌装编号']), level: 'skip', detail: '本次没有产生处理结果' }
  } else if (kind === 'judge') {
    const result = batchJudge([Number(row.id)])
    line =
      result.lines[0] ?? { code: String(row['灌装编号']), level: 'skip', detail: '本次没有产生处理结果' }
  } else if (kind === 'reject') {
    line = rejectOne(Number(row.id))
  } else {
    line = terminateOne(Number(row.id))
  }
  pushOutcomes([line])
  reload()
}

function openApprove(row: EntryRow) {
  approveTarget.value = row
  approveForm.temperature = String(row['核定温度'] ?? row['培养温度'] ?? '')
  approveForm.days = String(row['核定天数'] ?? '').trim()
}

function confirmApprove() {
  if (!approveTarget.value) {
    return
  }
  const line = approveCondition(
    Number(approveTarget.value.id),
    approveForm.temperature,
    approveForm.days,
  )
  pushOutcomes([line])
  closeModals()
  reload()
}

function openCounts(row: EntryRow) {
  countsTarget.value = row
  countsForm.workshop = String(row['车间污染瓶数'] ?? '')
  countsForm.ledger = String(row['台账污染瓶数'] ?? '')
}

function confirmCounts() {
  if (!countsTarget.value) {
    return
  }
  const line = recordCounts(Number(countsTarget.value.id), countsForm.workshop, countsForm.ledger)
  pushOutcomes([line])
  closeModals()
  reload()
}

function closeModals() {
  approveTarget.value = null
  countsTarget.value = null
}

function resetFilters() {
  filters.value = { code: '', spec: '', condition: '' }
  reload()
}

function exportRows() {
  downloadEntries('mediafill')
}

function resetDemo() {
  resetMediafillDemo()
  selectedIds.value = new Set()
  outcomes.value = []
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    rows.value = listRows('mediafill')
    total.value = rows.value.length
    stats.value = mediafillStats()
    const alive = new Set(rows.value.map((row) => Number(row.id)))
    selectedIds.value = new Set([...selectedIds.value].filter((id) => alive.has(id)))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '培养基模拟灌装列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.rule-card {
  background: #fff;
  border: 1px solid var(--border);
  border-left: 4px solid var(--brand);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
  font-size: 12.5px;
  color: #334155;
}
.rule-card ul { margin: 6px 0 0; padding-left: 18px; }
.rule-card li { margin: 3px 0; }
.bulk-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #eef4ff;
  border: 1px solid #c6d9fb;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
}
.select-all { font-size: 13px; display: flex; align-items: center; gap: 6px; }
.bulk-hint { color: var(--muted); font-size: 12px; }
.group-block { margin-bottom: 16px; }
.group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #101828;
  color: #e5e7eb;
  border-radius: 8px 8px 0 0;
  padding: 8px 12px;
  font-size: 13px;
}
.group-block .data-table { border-top: none; }
.group-tag {
  font-size: 12px;
  background: #7f1d1d;
  border-radius: 999px;
  padding: 2px 10px;
}
.group-tag.approved { background: #166534; }
.group-meta { margin-left: auto; color: #cbd5e1; font-size: 12px; }
.col-check { width: 40px; text-align: center; }
.cell-missing { color: #b42318; font-weight: 600; }
.cell-bad { color: #b42318; font-weight: 600; }
.mini-warn {
  display: inline-block;
  margin-left: 4px;
  font-size: 11px;
  color: #b45309;
  background: #fef3c7;
  border-radius: 4px;
  padding: 0 6px;
}
.return-reason { font-size: 11px; color: #b42318; margin-top: 2px; }
.is-returned { background: #fef2f2; }
.link.danger { color: #b42318; }
.outcome-panel {
  margin-top: 14px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
}
.outcome-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.outcome-panel ul { list-style: none; margin: 0; padding: 0; font-size: 12.5px; max-height: 260px; overflow: auto; }
.outcome-panel li { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px dashed #e5e7eb; }
.outcome-code { font-weight: 600; min-width: 96px; }
.lv-ok { color: #166534; }
.lv-info { color: #1d4ed8; }
.lv-skip { color: #64748b; }
.lv-block { color: #b42318; }
.lv-return { color: #b42318; font-weight: 600; }
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal {
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  width: 420px;
}
.modal h3 { margin: 0 0 8px; font-size: 15px; }
.modal-hint { color: var(--muted); font-size: 12px; margin: 0 0 10px; }
.modal-field { display: block; margin-bottom: 10px; }
.modal-field span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.modal-field input { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
