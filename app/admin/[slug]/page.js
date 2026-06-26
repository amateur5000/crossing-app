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

      {/* Timeline bar */}
      <section style={s.section}>
        <h2 style={s.sectionTitle}>Timeline (next 30 mins)</h2>
        <TimelineBar predictions={predictions} fetchedAt={fetchedAt} />
      </section>

      {/* Merged closures */}
      <section style={s.section}>
        <h2 style={s.sectionTitle}>Merged Closure Windows ({merged.length})</h2>
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
                  <td style={s.td}>{fmt(m.closesAt)}</td>
                  <td style={s.td}>{fmt(m.opensAt)}</td>
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
                        background: p.status === 'actual' ? '#0a2a0a'
                          : p.status === 'on_time' ? '#0a1a0a'
                          : p.status === 'delayed' ? '#2a1a00'
                          : '#1a1a1a'
                      }}>
                        {p.status}
                      </span>
                    </td>
                    <td style={s.td}>
                      <span style={{
                        ...s.badge,
                        background: p.time_basis === 'actual' ? '#0a0a2a'
                          : p.time_basis === 'predicted' ? '#0a1a0a'
                          : '#1a1a1a'
                      }}>
                        {p.time_basis}
                      </span>
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
                      background: l.time_basis === 'actual' ? '#0a0a2a'
                        : l.time_basis === 'predicted' ? '#0a1a0a'
                        : '#1a1a1a'
                    }}>
                      {l.time_basis}
                    </span>
                  </td>
                  <td style={s.td}>
                    <span style={{
                      ...s.badge,
                      background: l.status === 'actual' ? '#0a2a0a'
                        : l.status === 'delayed' ? '#2a1a00'
                        : '#1a1a1a'
                    }}>
                      {l.status}
                    </span>
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

    </main>
  )
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

// ============================================================
// Styles
// ============================================================

const s = {
  main: {
    padding:    '20px',
    maxWidth:   '1200px',
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
    fontSize:     '12px',
    fontFamily:   'var(--font-mono)',
    color:        'var(--text-dimmer)',
    letterSpacing:'0.08em',
    textTransform:'uppercase',
    marginBottom: '10px',
    fontWeight:   '400',
  },
  tableWrap: {
    overflowX: 'auto',
  },
  table: {
    width:           '100%',
    borderCollapse:  'collapse',
    fontSize:        '12px',
  },
  th: {
    textAlign:    'left',
    padding:      '6px 10px',
    background:   'var(--surface)',
    color:        'var(--text-dimmer)',
    fontFamily:   'var(--font-mono)',
    fontSize:     '10px',
    letterSpacing:'0.06em',
    textTransform:'uppercase',
    borderBottom: '1px solid var(--border)',
    whiteSpace:   'nowrap',
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
  badge: {
    display:      'inline-block',
    padding:      '2px 6px',
    borderRadius: '4px',
    fontFamily:   'var(--font-mono)',
    fontSize:     '10px',
    color:        'var(--text-dim)',
  },
  msg: {
    padding:    '40px',
    color:      'var(--text-dim)',
    fontFamily: 'var(--font-mono)',
  },
}
