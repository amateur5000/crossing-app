// app/admin/[slug]/page.js
'use client'

import { useState, useEffect, useCallback } from 'react'
import TimelineBar, { mergeClosures } from '../../../components/TimelineBar'

const CROSSING_MAP = { 'mortlake': 1 }

export default function AdminPage({ params }) {
  const crossingId = CROSSING_MAP[params.slug]

  const [data,    setData]    = useState(null)
  const [error,   setError]   = useState(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    if (!crossingId) return
    try {
      const res = await fetch(`/api/admin?id=${crossingId}`)
      if (!res.ok) throw new Error(`API error ${res.status}`)
      setData(await res.json())
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [crossingId])

  useEffect(() => { fetchData() }, [fetchData])

  if (!crossingId) return <p style={s.msg}>Crossing not found: {params.slug}</p>
  if (loading)     return <p style={s.msg}>Loading…</p>
  if (error)       return <p style={s.msg}>Error: {error}</p>

  const { crossing, predictions, locations, fetchedAt } = data
  const now     = new Date(fetchedAt)
  const endTime = new Date(now.getTime() + 30 * 60 * 1000)
  const merged  = mergeClosures(predictions, now, endTime)

  // Build validation list — one row per train, sorted by scheduled time
  // Shows the key times needed to match a physical train to a database record
  const validationRows = buildValidationRows(locations, predictions, now)

  return (
    <main style={s.main}>

      {/* Header */}
      <div style={s.header}>
        <div>
          <span style={s.eyebrow}>Admin · Debug View</span>
          <h1 style={s.title}>{crossing.name} Level Crossing</h1>
          <p style={s.subtitle}>
            Fetched at {fmt(now)} · Lead time: {crossing.lead_time_seconds}s ·
            <a href={`/crossing/${params.slug}`} style={s.link}> ← Live view</a>
          </p>
        </div>
        <button style={s.refreshBtn} onClick={fetchData}>Refresh</button>
      </div>

      {/* ============================================================
          VALIDATION TABLE
          Use this at the crossing to match physical trains to records.
          Sorted by scheduled time — find the train you just saw by time.
          ============================================================ */}
      <section style={s.section}>
        <h2 style={s.sectionTitle}>🚂 Validation — Match trains to records</h2>
        <p style={s.validationHint}>
          Find the train you just saw by its scheduled time. Note the actual
          barrier close/open times and compare against predicted close/open.
          Cross-reference with{' '}
          <a href="https://www.realtimetrains.co.uk/search/detailed/gb-nr:MTL/now/0/30"
             target="_blank" style={s.link}>
            Realtime Trains ↗
          </a>
        </p>

        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Sched time</th>
                <th style={s.th}>Pred time</th>
                <th style={s.th}>Type</th>
                <th style={s.th}>Direction</th>
                <th style={s.th}>Pred close</th>
                <th style={s.th}>Pred open</th>
                <th style={s.th}>Basis</th>
                <th style={s.th}>Status</th>
                <th style={s.th}>Train ID (last 6)</th>
                <th style={s.th}>RTT link</th>
              </tr>
            </thead>
            <tbody>
              {validationRows.map((r, i) => {
                const isCurrent = r.predClose && r.predOpen &&
                  new Date(r.predClose) <= now && new Date(r.predOpen) >= now
                const isPast    = r.predClose && new Date(r.predClose) < now && !isCurrent

                return (
                  <tr key={i} style={{
                    background: isCurrent ? '#1a0000'
                      : isPast    ? '#0a0a0a'
                      : 'transparent',
                    opacity: isPast ? 0.5 : 1
                  }}>
                    <td style={{ ...s.td, ...s.mono, ...s.highlight }}>
                      {r.schedTime || '—'}
                    </td>
                    <td style={{ ...s.td, ...s.mono }}>
                      {r.predTime || '—'}
                    </td>
                    <td style={s.td}>
                      {r.isStopping ? '✓ stop' : '→ pass'}
                    </td>
                    <td style={s.td}>{r.direction || '—'}</td>
                    <td style={{ ...s.td, ...s.mono, color: 'var(--red-dim)' }}>
                      {r.predClose ? fmt(new Date(r.predClose)) : '—'}
                    </td>
                    <td style={{ ...s.td, ...s.mono, color: 'var(--green-dim)' }}>
                      {r.predOpen ? fmt(new Date(r.predOpen)) : '—'}
                    </td>
                    <td style={s.td}>
                      <span style={{
                        ...s.badge,
                        background: r.basis === 'actual'    ? '#0a0a2a'
                          : r.basis === 'predicted' ? '#0a1a0a'
                          : '#1a1a1a'
                      }}>
                        {r.basis}
                      </span>
                    </td>
                    <td style={s.td}>
                      <span style={{
                        ...s.badge,
                        background: r.status === 'actual'   ? '#0a2a0a'
                          : r.status === 'delayed'  ? '#2a1a00'
                          : r.status === 'cancelled'? '#2a0a0a'
                          : '#1a1a1a'
                      }}>
                        {r.status}
                      </span>
                    </td>
                    <td style={{ ...s.td, ...s.mono, fontSize: '11px' }}>
                      {r.trainId.slice(-6)}
                    </td>
                    <td style={s.td}>
                      <a
                        href={`https://www.realtimetrains.co.uk/service/gb-nr:${r.trainId.slice(-6)}/${fmtDate(now)}`}
                        target="_blank"
                        style={{ ...s.link, fontSize: '11px' }}
                      >
                        RTT ↗
                      </a>
                    </td>
                  </tr>
                )
              })}
              {validationRows.length === 0 && (
                <tr><td colSpan={10} style={s.tdMuted}>No trains in window</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Validation log prompt */}
        <div style={s.logPrompt}>
          <p style={s.logPromptTitle}>📋 Validation log template</p>
          <p style={s.logPromptText}>
            For each train, note: actual barrier close time · actual barrier open time ·
            direction · stopping? · any observations
          </p>
        </div>
      </section>

      {/* Train locations table */}
      <section style={s.section}>
        <h2 style={s.sectionTitle}>Train Locations Table ({locations.length} rows)</h2>
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Train ID</th>
                <th style={s.th}>Stopping</th>
                <th style={s.th}>Direction</th>
                <th style={s.th}>Sched arrival</th>
                <th style={s.th}>Pred arrival</th>
                <th style={s.th}>Sched depart</th>
                <th style={s.th}>Pred depart</th>
                <th style={s.th}>Sched pass</th>
                <th style={s.th}>Pred pass</th>
                <th style={s.th}>Basis</th>
                <th style={s.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {locations.map((l, i) => (
                <tr key={i}>
                  <td style={{ ...s.td, ...s.mono }}>{l.train_id.slice(-6)}</td>
                  <td style={s.td}>{l.is_stopping ? '✓ stop' : '→ pass'}</td>
                  <td style={s.td}>{l.direction || '—'}</td>
                  <td style={{ ...s.td, ...s.mono }}>{fmtOrDash(l.scheduled_arrival)}</td>
                  <td style={{ ...s.td, ...s.mono }}>{fmtOrDash(l.predicted_arrival)}</td>
                  <td style={{ ...s.td, ...s.mono }}>{fmtOrDash(l.scheduled_departure)}</td>
                  <td style={{ ...s.td, ...s.mono }}>{fmtOrDash(l.predicted_departure)}</td>
                  <td style={{ ...s.td, ...s.mono }}>{fmtOrDash(l.scheduled_pass)}</td>
                  <td style={{ ...s.td, ...s.mono }}>{fmtOrDash(l.predicted_pass)}</td>
                  <td style={s.td}>
                    <span style={{
                      ...s.badge,
                      background: l.time_basis === 'actual'    ? '#0a0a2a'
                        : l.time_basis === 'predicted' ? '#0a1a0a'
                        : '#1a1a1a'
                    }}>{l.time_basis}</span>
                  </td>
                  <td style={s.td}>
                    <span style={{
                      ...s.badge,
                      background: l.status === 'actual'  ? '#0a2a0a'
                        : l.status === 'delayed' ? '#2a1a00'
                        : '#1a1a1a'
                    }}>{l.status}</span>
                  </td>
                </tr>
              ))}
              {locations.length === 0 && (
                <tr><td colSpan={11} style={s.tdMuted}>No train locations found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Predictions table */}
      <section style={s.section}>
        <h2 style={s.sectionTitle}>Predictions Table ({predictions.length} rows)</h2>
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Train ID</th>
                <th style={s.th}>Closes at</th>
                <th style={s.th}>Opens at</th>
                <th style={s.th}>Status</th>
                <th style={s.th}>Basis</th>
                <th style={s.th}>Direction</th>
                <th style={s.th}>Stopping</th>
                <th style={s.th}>Source</th>
              </tr>
            </thead>
            <tbody>
              {predictions.map((p, i) => {
                const isCurrent = new Date(p.closes_at) <= now && new Date(p.opens_at) >= now
                return (
                  <tr key={i} style={{ background: isCurrent ? '#1a0000' : 'transparent' }}>
                    <td style={{ ...s.td, ...s.mono }}>{p.train_id.slice(-6)}</td>
                    <td style={{ ...s.td, ...s.mono }}>{fmt(new Date(p.closes_at))}</td>
                    <td style={{ ...s.td, ...s.mono }}>{fmt(new Date(p.opens_at))}</td>
                    <td style={s.td}>
                      <span style={{
                        ...s.badge,
                        background: p.status === 'actual'    ? '#0a2a0a'
                          : p.status === 'on_time'  ? '#0a1a0a'
                          : p.status === 'delayed'  ? '#2a1a00'
                          : '#1a1a1a'
                      }}>{p.status}</span>
                    </td>
                    <td style={s.td}>
                      <span style={{
                        ...s.badge,
                        background: p.time_basis === 'actual'    ? '#0a0a2a'
                          : p.time_basis === 'predicted' ? '#0a1a0a'
                          : '#1a1a1a'
                      }}>{p.time_basis}</span>
                    </td>
                    <td style={s.td}>{p.direction || '—'}</td>
                    <td style={s.td}>{p.is_stopping ? '✓ stop' : '→ pass'}</td>
                    <td style={s.td}>{p.source_side || '—'}</td>
                  </tr>
                )
              })}
              {predictions.length === 0 && (
                <tr><td colSpan={8} style={s.tdMuted}>No predictions in window</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Merged closures */}
      <section style={s.section}>
        <h2 style={s.sectionTitle}>Merged Closure Windows ({merged.length})</h2>
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Closes at</th>
                <th style={s.th}>Opens at</th>
                <th style={s.th}>Duration</th>
                <th style={s.th}>Trains</th>
              </tr>
            </thead>
            <tbody>
              {merged.map((m, i) => {
                const duration = Math.round((m.opensAt - m.closesAt) / 1000 / 60)
                const trains   = predictions.filter(p =>
                  new Date(p.closes_at) >= m.closesAt &&
                  new Date(p.closes_at) < m.opensAt
                )
                const isCurrent = m.closesAt <= now && m.opensAt >= now
                return (
                  <tr key={i} style={{ background: isCurrent ? '#1a0000' : 'transparent' }}>
                    <td style={{ ...s.td, ...s.mono }}>{fmt(m.closesAt)}</td>
                    <td style={{ ...s.td, ...s.mono }}>{fmt(m.opensAt)}</td>
                    <td style={s.td}>~{duration} min{duration !== 1 ? 's' : ''}</td>
                    <td style={s.td}>{trains.length} train{trains.length !== 1 ? 's' : ''}</td>
                  </tr>
                )
              })}
              {merged.length === 0 && (
                <tr><td colSpan={4} style={s.tdMuted}>No closures in window</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Timeline bar */}
      <section style={s.section}>
        <h2 style={s.sectionTitle}>Timeline (next 30 mins)</h2>
        <TimelineBar predictions={predictions} fetchedAt={fetchedAt} />
      </section>

    </main>
  )
}

// ============================================================
// Build validation rows
// One row per train, sorted by scheduled time
// Merges train_locations and predictions data
// ============================================================

function buildValidationRows(locations, predictions, now) {
  return locations
    .map(l => {
      // Find matching prediction
      const pred = predictions.find(p => p.train_id === l.train_id)

      // Best scheduled time for display (pass > arrival > departure)
      const schedTime = l.scheduled_pass || l.scheduled_arrival || l.scheduled_departure
      const predTime  = l.predicted_pass  || l.predicted_arrival  || l.predicted_departure

      return {
        trainId:    l.train_id,
        schedTime:  schedTime ? fmt(new Date(schedTime)) : null,
        predTime:   predTime  ? fmt(new Date(predTime))  : null,
        schedRaw:   schedTime,
        isStopping: l.is_stopping,
        direction:  l.direction,
        basis:      l.time_basis,
        status:     l.status,
        predClose:  pred?.closes_at  || null,
        predOpen:   pred?.opens_at   || null,
      }
    })
    .filter(r => r.schedTime) // Only rows with a time
    .sort((a, b) => new Date(a.schedRaw) - new Date(b.schedRaw))
}

// ============================================================
// Helpers
// ============================================================

function fmt(date) {
  if (!date) return '—'
  return new Date(date).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
}

function fmtOrDash(val) {
  if (!val) return '—'
  return fmt(new Date(val))
}

function fmtDate(date) {
  // Format as YYYY-MM-DD for Realtime Trains URL
  return date.toISOString().slice(0, 10)
}

// ============================================================
// Styles
// ============================================================

const s = {
  main: {
    padding:    '20px',
    maxWidth:   '1400px',
    margin:     '0 auto',
    fontFamily: 'var(--font-body)',
  },
  header: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'flex-start',
    marginBottom:   '24px',
    paddingBottom:  '16px',
    borderBottom:   '1px solid var(--border)',
  },
  eyebrow: {
    fontSize:      '10px',
    fontFamily:    'var(--font-mono)',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color:         'var(--text-dimmer)',
    display:       'block',
    marginBottom:  '4px',
  },
  title: {
    fontSize:   '22px',
    fontWeight: '600',
    color:      'var(--text)',
  },
  subtitle: {
    fontSize:  '12px',
    color:     'var(--text-dim)',
    marginTop: '4px',
  },
  link: {
    color:          'var(--green-dim)',
    textDecoration: 'none',
  },
  refreshBtn: {
    padding:      '8px 16px',
    background:   'var(--surface-2)',
    border:       '1px solid var(--border)',
    borderRadius: '6px',
    color:        'var(--text)',
    cursor:       'pointer',
    fontSize:     '13px',
    fontFamily:   'var(--font-mono)',
  },
  section: {
    marginBottom: '32px',
  },
  sectionTitle: {
    fontSize:      '12px',
    fontFamily:    'var(--font-mono)',
    color:         'var(--text-dimmer)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    marginBottom:  '10px',
    fontWeight:    '400',
  },
  validationHint: {
    fontSize:     '12px',
    color:        'var(--text-dim)',
    marginBottom: '12px',
    lineHeight:   '1.5',
  },
  tableWrap: {
    overflowX: 'auto',
  },
  table: {
    width:          '100%',
    borderCollapse: 'collapse',
    fontSize:       '12px',
  },
  th: {
    textAlign:     'left',
    padding:       '6px 10px',
    background:    'var(--surface)',
    color:         'var(--text-dimmer)',
    fontFamily:    'var(--font-mono)',
    fontSize:      '10px',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    borderBottom:  '1px solid var(--border)',
    whiteSpace:    'nowrap',
  },
  td: {
    padding:      '6px 10px',
    color:        'var(--text)',
    borderBottom: '1px solid var(--border)',
    whiteSpace:   'nowrap',
  },
  tdMuted: {
    padding:   '12px 10px',
    color:     'var(--text-dimmer)',
    fontStyle: 'italic',
  },
  mono: {
    fontFamily: 'var(--font-mono)',
  },
  highlight: {
    fontSize:   '13px',
    fontWeight: '500',
    color:      'var(--text)',
  },
  badge: {
    display:      'inline-block',
    padding:      '2px 6px',
    borderRadius: '4px',
    fontFamily:   'var(--font-mono)',
    fontSize:     '10px',
    color:        'var(--text-dim)',
  },
  logPrompt: {
    marginTop:    '12px',
    padding:      '12px 14px',
    background:   'var(--surface)',
    borderRadius: '8px',
    border:       '1px solid var(--border)',
  },
  logPromptTitle: {
    fontSize:     '12px',
    fontWeight:   '500',
    color:        'var(--text)',
    marginBottom: '4px',
  },
  logPromptText: {
    fontSize:   '11px',
    color:      'var(--text-dim)',
    lineHeight: '1.5',
  },
  msg: {
    padding:    '40px',
    color:      'var(--text-dim)',
    fontFamily: 'var(--font-mono)',
  },
}
