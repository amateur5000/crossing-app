// app/crossing/[slug]/page.js
'use client'

import { useState, useEffect, useCallback } from 'react'
import TimelineBar, { mergeClosures } from '../../../components/TimelineBar'

const CROSSING_MAP = { 'mortlake': 1 }
const REFRESH_INTERVAL_MS = 30 * 1000

export default function CrossingPage({ params }) {
  const crossingId = CROSSING_MAP[params.slug]

  const [data,        setData]        = useState(null)
  const [error,       setError]       = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [lastRefresh, setLastRefresh] = useState(null)

  const fetchData = useCallback(async () => {
    if (!crossingId) return
    try {
      const res = await fetch(`/api/crossing?id=${crossingId}`)
      if (!res.ok) throw new Error(`API error ${res.status}`)
      const json = await res.json()
      setData(json)
      setLastRefresh(new Date())
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [crossingId])

  useEffect(() => { fetchData() }, [fetchData])
  useEffect(() => {
    const interval = setInterval(fetchData, REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [fetchData])

  if (!crossingId) return <NotFound slug={params.slug} />
  if (loading)     return <LoadingScreen />
  if (error)       return <ErrorScreen error={error} onRetry={fetchData} />

  const { crossing, predictions, fetchedAt } = data
  const now    = new Date(fetchedAt)
  const endTime = new Date(now.getTime() + 30 * 60 * 1000)

  // Merge closures for both status summary and display
  const merged = mergeClosures(predictions, now, endTime)
  const status = getCrossingStatus(merged, now)

  return (
    <main style={styles.main}>

      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <span style={styles.eyebrow}>Level Crossing</span>
          <h1 style={styles.title}>{crossing.name}</h1>
          <p style={styles.subtitle}>{crossing.road_name} · {crossing.line_name}</p>
        </div>
      </header>

      {/* Status */}
      <section style={styles.section}>
        <div style={{
          ...styles.statusPill,
          backgroundColor: status.isOpen ? 'var(--green)' : 'var(--red)',
        }}>
          <span style={styles.statusDot} />
          <span style={styles.statusText}>{status.isOpen ? 'OPEN' : 'CLOSED'}</span>
        </div>
        <p style={styles.summary}>{status.summary}</p>
      </section>

      {/* Timeline */}
      <section style={styles.section}>
        <h2 style={styles.sectionLabel}>Next 30 minutes</h2>
        <TimelineBar predictions={predictions} fetchedAt={fetchedAt} />

        {/* Upcoming merged closures list */}
        {merged.length > 0 && (
          <div style={styles.closureList}>
            {merged.map((m, i) => {
              const closesIn = Math.round((m.closesAt - now) / 1000 / 60)
              const duration = Math.round((m.opensAt - m.closesAt) / 1000 / 60)
              const isPast   = m.closesAt <= now

              // Find individual trains within this merged window
              const trains = predictions.filter(p =>
                new Date(p.closes_at) >= m.closesAt &&
                new Date(p.closes_at) < m.opensAt
              )

              return (
                <div key={i} style={styles.closureItem}>
                  <div style={styles.closureTime}>
                    <span style={styles.closureTimeMain}>
                      {formatTime(m.closesAt)}
                    </span>
                    <span style={styles.closureTimeSub}>closes</span>
                  </div>
                  <div style={styles.closureDivider} />
                  <div style={styles.closureTime}>
                    <span style={styles.closureTimeMain}>
                      {formatTime(m.opensAt)}
                    </span>
                    <span style={styles.closureTimeSub}>opens</span>
                  </div>
                  <div style={styles.closureMeta}>
                    <span style={styles.closureDuration}>
                      ~{duration} min{duration !== 1 ? 's' : ''}
                    </span>
                    <span style={styles.closureTrainCount}>
                      {trains.length} train{trains.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {merged.length === 0 && (
          <p style={styles.noPredictions}>
            No closures expected in the next 30 minutes.
          </p>
        )}
      </section>

      {/* Engine off notice */}
      <section style={styles.engineSection}>
        <p style={styles.engineNotice}>
          🚗 Please turn your engine off while waiting at the level crossing.
        </p>
      </section>

      {/* Footer */}
      <footer style={styles.footer}>
        <span style={styles.footerText}>
          Updated {lastRefresh ? formatTimeFull(lastRefresh) : '—'} · refreshes every 30s
        </span>
        <span style={styles.footerBasis}>
          {predictions.some(p => p.time_basis === 'predicted' || p.time_basis === 'actual')
            ? '● Live'
            : '○ Timetable'}
        </span>
      </footer>

    </main>
  )
}

// ============================================================
// Status — uses merged closures for accuracy
// ============================================================

function getCrossingStatus(merged, now) {
  // Is crossing currently closed?
  const current = merged.find(m => m.closesAt <= now && m.opensAt >= now)

  if (current) {
    const opensIn = Math.round((current.opensAt - now) / 1000 / 60)
    return {
      isOpen:  false,
      summary: opensIn <= 0
        ? 'Crossing closed. Expected to open shortly.'
        : `Crossing closed. Expected to open in ${opensIn} minute${opensIn !== 1 ? 's' : ''}.`
    }
  }

  // Next upcoming merged closure
  const next = merged.find(m => m.closesAt > now)

  if (next) {
    const closesIn = Math.round((next.closesAt - now) / 1000 / 60)
    const duration = Math.round((next.opensAt - next.closesAt) / 1000 / 60)

    if (closesIn <= 0) {
      return {
        isOpen:  false,
        summary: `Crossing closing now — expected closed for approximately ${duration} minute${duration !== 1 ? 's' : ''}.`
      }
    }

    return {
      isOpen:  true,
      summary: `Crossing open. Next closure in ${closesIn} minute${closesIn !== 1 ? 's' : ''}, for approximately ${duration} minute${duration !== 1 ? 's' : ''}.`
    }
  }

  return {
    isOpen:  true,
    summary: 'Crossing open. No closures expected in the next 30 minutes.'
  }
}

// ============================================================
// Helper screens
// ============================================================

function LoadingScreen() {
  return (
    <main style={styles.main}>
      <div style={styles.centred}>
        <p style={styles.loadingText}>Loading crossing data…</p>
      </div>
    </main>
  )
}

function ErrorScreen({ error, onRetry }) {
  return (
    <main style={styles.main}>
      <div style={styles.centred}>
        <p style={styles.errorText}>Could not load crossing data.</p>
        <p style={styles.errorDetail}>{error}</p>
        <button style={styles.retryBtn} onClick={onRetry}>Try again</button>
      </div>
    </main>
  )
}

function NotFound({ slug }) {
  return (
    <main style={styles.main}>
      <div style={styles.centred}>
        <p style={styles.errorText}>Crossing not found: {slug}</p>
      </div>
    </main>
  )
}

// ============================================================
// Helpers
// ============================================================

function formatTime(date) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function formatTimeFull(date) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// ============================================================
// Styles
// ============================================================

const styles = {
  main: {
    maxWidth:  '480px',
    margin:    '0 auto',
    padding:   '0 0 40px',
    minHeight: '100vh',
  },
  header: {
    padding:      '24px 20px 20px',
    borderBottom: '1px solid var(--border)',
    marginBottom: '8px',
  },
  headerInner: {},
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
    fontSize:   '28px',
    fontWeight: '600',
    color:      'var(--text)',
    lineHeight: '1.2',
  },
  subtitle: {
    fontSize:  '13px',
    color:     'var(--text-dim)',
    marginTop: '4px',
  },
  section: {
    padding: '16px 20px',
  },
  sectionLabel: {
    fontSize:      '11px',
    fontFamily:    'var(--font-mono)',
    color:         'var(--text-dimmer)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    marginBottom:  '12px',
    fontWeight:    '400',
  },
  statusPill: {
    display:      'inline-flex',
    alignItems:   'center',
    gap:          '8px',
    padding:      '8px 16px',
    borderRadius: '999px',
    marginBottom: '12px',
  },
  statusDot: {
    width:        '8px',
    height:       '8px',
    borderRadius: '50%',
    background:   'rgba(255,255,255,0.7)',
  },
  statusText: {
    fontSize:      '13px',
    fontFamily:    'var(--font-mono)',
    fontWeight:    '500',
    letterSpacing: '0.1em',
    color:         'white',
  },
  summary: {
    fontSize:   '15px',
    color:      'var(--text)',
    lineHeight: '1.5',
  },
  closureList: {
    marginTop:     '16px',
    display:       'flex',
    flexDirection: 'column',
    gap:           '8px',
  },
  closureItem: {
    display:      'flex',
    alignItems:   'center',
    gap:          '12px',
    background:   'var(--surface)',
    borderRadius: '8px',
    padding:      '10px 14px',
    border:       '1px solid var(--border)',
  },
  closureTime: {
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'center',
    minWidth:      '48px',
  },
  closureTimeMain: {
    fontFamily: 'var(--font-mono)',
    fontSize:   '15px',
    fontWeight: '500',
    color:      'var(--text)',
  },
  closureTimeSub: {
    fontSize:  '10px',
    color:     'var(--text-dimmer)',
    marginTop: '1px',
  },
  closureDivider: {
    flex:            1,
    height:          '1px',
    backgroundColor: 'var(--red)',
    opacity:         0.4,
  },
  closureMeta: {
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'flex-end',
    gap:           '3px',
    marginLeft:    'auto',
  },
  closureDuration: {
    fontSize:   '13px',
    fontFamily: 'var(--font-mono)',
    color:      'var(--text)',
    fontWeight: '500',
  },
  closureTrainCount: {
    fontSize: '10px',
    color:    'var(--text-dimmer)',
  },
  noPredictions: {
    marginTop: '16px',
    fontSize:  '14px',
    color:     'var(--text-dim)',
  },
  engineSection: {
    margin:       '8px 20px',
    padding:      '14px 16px',
    background:   'var(--surface)',
    borderRadius: '8px',
    border:       '1px solid var(--border)',
  },
  engineNotice: {
    fontSize:  '13px',
    color:     'var(--text-dim)',
    lineHeight:'1.5',
    textAlign: 'center',
  },
  footer: {
    padding:         '16px 20px 0',
    display:         'flex',
    justifyContent:  'space-between',
    alignItems:      'center',
    borderTop:       '1px solid var(--border)',
    marginTop:       '8px',
  },
  footerText: {
    fontSize:   '11px',
    fontFamily: 'var(--font-mono)',
    color:      'var(--text-dimmer)',
  },
  footerBasis: {
    fontSize:   '11px',
    fontFamily: 'var(--font-mono)',
    color:      'var(--text-dimmer)',
  },
  centred: {
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    minHeight:      '100vh',
    gap:            '12px',
    padding:        '20px',
  },
  loadingText: {
    fontSize:   '14px',
    color:      'var(--text-dim)',
    fontFamily: 'var(--font-mono)',
  },
  errorText: {
    fontSize: '15px',
    color:    'var(--text)',
  },
  errorDetail: {
    fontSize:   '12px',
    color:      'var(--text-dimmer)',
    fontFamily: 'var(--font-mono)',
  },
  retryBtn: {
    marginTop:    '8px',
    padding:      '8px 20px',
    background:   'var(--surface-2)',
    border:       '1px solid var(--border)',
    borderRadius: '6px',
    color:        'var(--text)',
    cursor:       'pointer',
    fontSize:     '14px',
  },
}
