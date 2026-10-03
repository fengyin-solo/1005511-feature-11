<template>
  <section class="page mediafill-page" data-module="mediafill">
    <header class="page-head">
      <div>
        <h2>培养基模拟灌装管理</h2>
        <p class="page-desc">
          灌装记录按培养条件分组核对：勾选多条灌装编号可一次送灌装/批量判定，结果逐条给出；
          灌装按规格分批，培养条件由质量部核定，污染超限整组退回重来。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出培养基模拟灌装清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="rule-hint">
      <strong>核对规则</strong>
      <ol>
        <li>灌装规格或培养温度（含培养天数）缺失的，批量送灌装时先单独提示并挡下，其余照常推进。</li>
        <li>培养条件须由质量部整组核定后才能判定；状态一段一段往前走，支持倒序拒收（已判定 → 灌装中 → 待灌装）。</li>
        <li>污染瓶数限度为 0：越界（非整数/负数/超过批量）逐条挡回；超限则同一培养条件整组退回重来。</li>
        <li>同一批灌装重复判定只算一次；判定结论附污染瓶数，并同步到稳定性考察台账。</li>
        <li>污染瓶数/培养温度两处（灌装记录、台账）对得上才放行；相左时先判优先级（台账已核定 &gt; 灌装已核定 &gt; 较早的灌装记录；双核定冲突转质量部）。</li>
      </ol>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>灌装编号</span>
        <input v-model="filters['灌装编号']" placeholder="按灌装编号检索" />
      </label>
      <label class="filter-item">
        <span>灌装规格</span>
        <input v-model="filters['灌装规格']" placeholder="按灌装规格检索" />
      </label>
      <label class="filter-item">
        <span>培养温度</span>
        <input v-model="filters['培养温度']" placeholder="按培养温度检索" />
      </label>
      <label class="filter-item">
        <span>当前状态</span>
        <select v-model="filters.status">
          <option value="">全部</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="batch-bar">
      <label class="select-all">
        <input
          type="checkbox"
          :checked="allVisibleSelected"
          :ref="(el) => { if (el) (el as HTMLInputElement).indeterminate = someSelected }"
          @change="toggleAll(($event.target as HTMLInputElement).checked)"
        />
        全选当前列表（共 {{ rows.length }} 条，已选 {{ selected.size }} 条）
      </label>
      <div class="batch-actions">
        <button class="btn primary" type="button" :disabled="!selected.size" @click="runBatch('send')">
          批量送灌装
        </button>
        <button class="btn primary" type="button" :disabled="!selected.size" @click="runBatch('judge')">
          批量判定
        </button>
        <button class="btn" type="button" :disabled="!selected.size" @click="runBatch('reconcile')">
          与稳定性台账核对
        </button>
        <button class="btn ghost" type="button" :disabled="!selected.size" @click="selected.clear()">
          清除勾选
        </button>
      </div>
    </div>

    <div v-if="errorMessage" class="inline-error">{{ errorMessage }}</div>

    <div v-if="report" class="report-panel">
      <header class="report-head">
        <strong :class="report.ok ? 'report-ok' : 'report-warn'">
          {{ report.ok ? '批量处理完成' : '批量处理完成（含挡回/退回项，请逐条核对）' }}
        </strong>
        <button class="link" type="button" @click="report = null">关闭结果</button>
      </header>
      <p class="report-ledger">{{ report.ledgerNote }}</p>
      <div v-for="(section, sIndex) in report.sections" :key="sIndex" class="report-section" :data-tone="section.tone">
        <h4>{{ section.title }}</h4>
        <ul>
          <li v-for="line in section.lines" :key="`${line.id}-${line.kind}`" :class="`line-${line.kind}`">
            <span class="line-code">{{ line.code }}</span>
            <span class="line-spec">规格：{{ line.spec }}</span>
            <span class="line-message">{{ line.message }}</span>
            <em v-if="line.note" class="line-note">↳ {{ line.note }}</em>
          </li>
        </ul>
      </div>
    </div>

    <div v-for="group in groups" :key="group.key" class="condition-group" :data-approved="group.approved">
      <header class="group-head">
        <div class="group-title">
          <label>
            <input type="checkbox" :checked="groupAllSelected(group)" @change="toggleGroup(group, ($event.target as HTMLInputElement).checked)" />
          </label>
          <h3>培养条件：{{ group.label }}</h3>
          <span class="group-badge" :class="group.approved ? 'badge-ok' : 'badge-pending'">
            {{ group.approved ? `质量部已核定（${group.approver} ${group.approvedAt}）` : '待质量部核定' }}
          </span>
        </div>
        <div class="group-tools">
          <button v-if="!group.approved" class="btn small" type="button" @click="approve(group)">
            质量部核定本条件
          </button>
          <span class="group-count">组内 {{ groupRowsOf(group).length }} 条</span>
        </div>
      </header>

      <div v-for="spec in group.specs" :key="spec.spec" class="spec-block">
        <h5 class="spec-title">灌装规格分批：{{ spec.spec }}（{{ spec.rows.length }} 条）</h5>
        <table class="data-table">
          <thead>
            <tr>
              <th class="col-check">勾选</th>
              <th>灌装编号</th>
              <th>灌装批量</th>
              <th>培养温度</th>
              <th>培养天数</th>
              <th>污染瓶数</th>
              <th>判定结论</th>
              <th>当前状态</th>
              <th>可执行动作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in spec.rows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal }">
              <td>
                <input
                  type="checkbox"
                  :checked="selected.has(Number(row.id))"
                  @change="toggleOne(Number(row.id), ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td>{{ row['灌装编号'] }}</td>
              <td>{{ row['灌装批量'] }}</td>
              <td>{{ row['培养温度'] || '—' }}</td>
              <td>{{ row['培养天数'] || '—' }}</td>
              <td>
                <input
                  v-if="String(row.status) === '灌装中'"
                  class="count-input"
                  :value="String(row['污染瓶数'] ?? '')"
                  @change="saveCount(Number(row.id), ($event.target as HTMLInputElement).value)"
                />
                <span v-else>{{ row['污染瓶数'] === '' || row['污染瓶数'] == null ? '—' : row['污染瓶数'] }}</span>
              </td>
              <td class="col-conclusion">
                {{ row['判定结论'] || '—' }}
                <small v-if="row['核对备注']" class="recon-note" :title="String(row['核对备注'])">
                  {{ String(row['核对备注']).startsWith('两处对得上') ? '两处一致' : '核对有处理，悬停查看' }}
                </small>
              </td>
              <td>
                <span class="status-pill" :data-status="row.status">{{ row.status }}</span>
              </td>
              <td class="row-actions">
                <button v-if="String(row.status) === '待灌装'" class="link" type="button" @click="singleSend(row)">
                  送灌装
                </button>
                <button
                  v-if="['灌装中', '已判定'].includes(String(row.status))"
                  class="link"
                  type="button"
                  @click="singleReject(row)"
                >
                  倒序拒收
                </button>
                <button v-if="String(row.status) !== '已终止'" class="link danger" type="button" @click="singleTerminate(row)">
                  终止灌装
                </button>
                <span v-else class="muted-text">流程已终态</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <p v-if="!groups.length" class="empty-state" style="background:#fff;padding:24px;border:1px solid var(--border);border-radius:8px;">
      当前筛选条件下没有灌装记录
    </p>

    <footer class="page-foot">
      <span>共 {{ total }} 条培养基模拟灌装记录，按培养条件归为 {{ groups.length }} 组</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  approveCondition,
  batchJudge,
  batchSendFill,
  groupRows,
  listMediaRows,
  mediaStats,
  reconcileSelected,
  rejectOne,
  terminateOne,
  updateCount,
  type BatchReport,
  type MediaGroup,
} from '@/api/mediafill-service'
import type { EntryRow } from '@/data/types'

const statuses = ['待灌装', '灌装中', '已判定', '已终止']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const report = ref<BatchReport | null>(null)
const filters = ref<Record<string, string>>({})
const selected = ref<Set<number>>(new Set())

const groups = computed<MediaGroup[]>(() => groupRows(rows.value))
const stats = ref(mediaStats())

const statCards = computed(() => [
  { label: '待灌装批次', value: stats.value.waiting },
  { label: '灌装中批次', value: stats.value.filling },
  { label: '已判定批次', value: stats.value.judged },
  { label: '已终止批次', value: stats.value.terminated },
  { label: '污染瓶总数（仅已判定）', value: stats.value.totalContamination },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const visibleIds = computed(() => rows.value.map((row) => Number(row.id)))
const allVisibleSelected = computed(
  () => visibleIds.value.length > 0 && visibleIds.value.every((id) => selected.value.has(id)),
)
const someSelected = computed(
  () => !allVisibleSelected.value && visibleIds.value.some((id) => selected.value.has(id)),
)

function groupRowsOf(group: MediaGroup): EntryRow[] {
  return group.specs.flatMap((spec) => spec.rows)
}

function groupAllSelected(group: MediaGroup): boolean {
  const ids = groupRowsOf(group).map((row) => Number(row.id))
  return ids.length > 0 && ids.every((id) => selected.value.has(id))
}

function groupRowsCount(group: MediaGroup): number {
  return groupRowsOf(group).length
}

function toggleAll(checked: boolean) {
  const next = new Set(selected.value)
  for (const id of visibleIds.value) {
    if (checked) next.add(id)
    else next.delete(id)
  }
  selected.value = next
}

function toggleGroup(group: MediaGroup, checked: boolean) {
  const next = new Set(selected.value)
  for (const row of groupRowsOf(group)) {
    const id = Number(row.id)
    if (checked) next.add(id)
    else next.delete(id)
  }
  selected.value = next
}

function toggleOne(id: number, checked: boolean) {
  const next = new Set(selected.value)
  if (checked) next.add(id)
  else next.delete(id)
  selected.value = next
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('mediafill')
}

function applyResult(payload: BatchReport) {
  report.value = payload
  selected.value = new Set()
  reload()
}

function runBatch(kind: 'send' | 'judge' | 'reconcile') {
  errorMessage.value = ''
  report.value = null
  const ids = [...selected.value]
  if (!ids.length) {
    errorMessage.value = '请先勾选灌装编号'
    return
  }
  if (kind === 'send') applyResult(batchSendFill(ids))
  else if (kind === 'judge') applyResult(batchJudge(ids))
  else applyResult(reconcileSelected(ids))
}

function singleSend(row: EntryRow) {
  applyResult(batchSendFill([Number(row.id)]))
}

function singleReject(row: EntryRow) {
  const result = rejectOne(Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  report.value = {
    ok: true,
    sections: [
      {
        title: '倒序拒收',
        tone: 'return',
        lines: [
          {
            id: Number(row.id),
            code: String(row['灌装编号']),
            spec: String(row['灌装规格'] ?? '—'),
            ok: true,
            kind: 'return',
            message: result.message,
          },
        ],
      },
    ],
    ledgerNote: '动作已同步到稳定性考察台账。',
  }
  reload()
}

function singleTerminate(row: EntryRow) {
  const result = terminateOne(Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  report.value = {
    ok: true,
    sections: [],
    ledgerNote: result.message,
  }
  reload()
}

function approve(group: MediaGroup) {
  const approver = window.prompt('请输入质量部核定人姓名', '质量部-周敏')
  if (!approver?.trim()) return
  const result = approveCondition(group.key, approver.trim())
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = ''
  reload()
}

function saveCount(id: number, value: string) {
  const result = updateCount(id, value)
  if (!result.ok) errorMessage.value = result.message
  else reload()
}

function reload() {
  errorMessage.value = ''
  rows.value = listMediaRows(filters.value)
  total.value = rows.value.length
  stats.value = mediaStats()
  // 清理筛选后已不可见的勾选，避免误把范围外记录带进批量操作。
  const visible = new Set(visibleIds.value)
  selected.value = new Set([...selected.value].filter((id) => visible.has(id)))
}

onMounted(reload)
</script>

<style scoped>
.mediafill-page .rule-hint {
  background: #fff;
  border: 1px solid var(--border);
  border-left: 3px solid var(--brand);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
  font-size: 12px;
  color: #334155;
}
.mediafill-page .rule-hint ol {
  margin: 6px 0 0;
  padding-left: 18px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 24px;
}
.batch-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #eef4ff;
  border: 1px solid #c6d9fb;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
}
.select-all { font-size: 13px; display: flex; gap: 8px; align-items: center; }
.batch-actions { display: flex; gap: 8px; }
.btn.small { padding: 3px 10px; font-size: 12px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.inline-error {
  color: #b42318;
  background: #fef3f2;
  border: 1px solid #f4c7c2;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 13px;
  margin-bottom: 10px;
}
.condition-group {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 14px;
  overflow: hidden;
}
.condition-group[data-approved='false'] { border-color: #e3b341; }
.group-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  background: #f8fafc;
  border-bottom: 1px solid var(--border);
}
.group-title { display: flex; align-items: center; gap: 10px; }
.group-title h3 { margin: 0; font-size: 14px; }
.group-badge {
  font-size: 12px;
  border-radius: 999px;
  padding: 2px 10px;
}
.badge-ok { background: #e7f6ec; color: #1a7f37; }
.badge-pending { background: #fdf3e0; color: #9a6b16; }
.group-tools { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted); }
.spec-block { padding: 0 12px 12px; }
.spec-title {
  margin: 12px 0 6px;
  font-size: 13px;
  color: #0f3d7a;
}
.col-check { width: 42px; text-align: center; }
.count-input { width: 80px; padding: 3px 6px; border: 1px solid var(--border); border-radius: 4px; }
.col-conclusion { max-width: 240px; }
.recon-note {
  display: inline-block;
  margin-left: 6px;
  color: var(--brand);
  cursor: help;
}
.row-abnormal { background: #fff7ed; }
.status-pill {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 10px;
  font-size: 12px;
  background: #eef2f7;
}
.status-pill[data-status='已判定'] { background: #e7f6ec; color: #1a7f37; }
.status-pill[data-status='已终止'] { background: #f2f4f7; color: #667085; }
.status-pill[data-status='灌装中'] { background: #e8f0fe; color: #1f6feb; }
.link.danger { color: #b42318; }
.muted-text { color: var(--muted); font-size: 12px; }
.report-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.report-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.report-ok { color: #1a7f37; }
.report-warn { color: #b45309; }
.report-ledger { margin: 0 0 8px; font-size: 12px; color: var(--muted); }
.report-section { border-top: 1px dashed var(--border); padding-top: 6px; margin-top: 6px; }
.report-section h4 { margin: 4px 0; font-size: 13px; }
.report-section[data-tone='tip'] h4 { color: #b45309; }
.report-section[data-tone='return'] h4 { color: #b42318; }
.report-section ul { margin: 0; padding-left: 0; list-style: none; }
.report-section li {
  display: grid;
  grid-template-columns: 150px 160px 1fr;
  gap: 8px;
  font-size: 12px;
  padding: 3px 0;
  border-bottom: 1px dotted #eef2f7;
}
.report-section li .line-code { font-weight: 600; }
.line-note { grid-column: 3; color: var(--muted); font-style: normal; }
.line-block, .line-return { color: #b42318; }
.line-skip { color: var(--muted); }
.line-advance, .line-judge { color: #14532d; }
.filter-item select {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 6px;
}
</style>
