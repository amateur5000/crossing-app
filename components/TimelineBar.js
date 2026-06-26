// components/TimelineBar.js
'use client'

// ============================================================
// TimelineBar
// Shows a 30-minute window of crossing open/closed status.
// Green = open, Red = closed.
// Two rows of time labels: actual clock time and relative time.
// ============================================================

export default function TimelineBar({ predictions, fetchedAt }) {
  const now         = fetchedAt ? new Date(fetchedAt) : new Date()
  const windowMins  = 30
  const windowMs    = windowMins * 60 * 1000
  const endTime     = new Date(now.getTime() + windowMs)

  // Build segments from predictions
  // Each prediction has closes_at and opens_at
  // Gaps between predictions are green (crossing open)
  const segments = buildSegments(predictions, now, endTime)

  // Time label markers at 0, 10, 20, 30 minutes
  const markers = [0, 10, 20, 30]

  return (
    <div style={styles.wrapper}>

      {/* Top row: actual clock times */}
      <div style={styles.labelRow}>
        {markers.map(mins => {
          const t = new Date(now.getTime() + mins * 60 * 1000)
          return (
            <div key={mins} style={{ ...styles.label, left: `${(mins / windowMins) * 100}%` }}>
              {formatTime(t)}
            </div>
          )
        })}
      </div>

      {/* The bar itself */}
      <div style={styles.barTrack}>
        {segments.map((seg, i) => (
          <div
            key={i}
            style={{
              ...styles.segment,
              left:            `${seg.startPct}%`,
              width:           `${seg.widthPct}%`,
              backgroundColor: seg.isOpen ? 'var(--green)' : 'var(--red)',
            }}
            title={seg.isOpen
              ? `Open ${formatTime(seg.start)} – ${formatTime(seg.end)}`
              : `Closed ${formatTime(seg.start)} – ${formatTime(seg.end)}`
            }
          />
        ))}

        {/* "Now" marker line */}
        <div style={styles.nowMarker} />
      </div>

      {/* Bottom row: relative times */}
      <div style={styles.labelRow}>
        {markers.map(mins => (
          <div key={mins} style={{ ...styles.label, left: `${(mins / windowMins) * 100}%` }}>
            <span style={styles.relLabel}>{mins === 0 ? 'now' : `+${mins}m`}</span>
          </div>
        ))}
      </div>

    </div>
  )
}

// ============================================================
// Build segments array from predictions
// Fills gaps with green (open) segments
// ============================================================

function buildSegments(predictions, now, endTime) {
  const segments = []
  let cursor     = now

  for (const pred of predictions) {
    const closes = new Date(pred.closes_at)
    const opens  = new Date(pred.opens_at)

    // Clamp to window
    if (closes >= endTime) break
    if (opens  <= now)     continue

    const segCloses = closes < now     ? now     : closes
    const segOpens  = opens  > endTime ? endTime : opens

    // Green gap before this closure (crossing open)
    if (cursor < segCloses) {
      segments.push({
        start:    cursor,
        end:      segCloses,
        startPct: toPct(cursor,   now, endTime),
        widthPct: toPct(segCloses, now, endTime) - toPct(cursor, now, endTime),
        isOpen:   true
      })
    }

    // Red segment (crossing closed)
    segments.push({
      start:    segCloses,
      end:      segOpens,
      startPct: toPct(segCloses, now, endTime),
      widthPct: toPct(segOpens,  now, endTime) - toPct(segCloses, now, endTime),
      isOpen:   false
    })

    cursor = segOpens
  }

  // Final green segment to end of window
  if (cursor < endTime) {
    segments.push({
      start:    cursor,
      end:      endTime,
      startPct: toPct(cursor,  now, endTime),
      widthPct: toPct(endTime, now, endTime) - toPct(cursor, now, endTime),
      isOpen:   true
    })
  }

  return segments
}

function toPct(time, start, end) {
  const total = end - start
  const pos   = new Date(time) - start
  return Math.max(0, Math.min(100, (pos / total) * 100))
}

function formatTime(date) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

// ============================================================
// Styles
// ============================================================

const styles = {
  wrapper: {
    position: 'relative',
    width:    '100%',
    userSelect: 'none',
  },
  labelRow: {
    position: 'relative',
    height:   '20px',
    width:    '100%',
  },
  label: {
    position:  'absolute',
    transform: 'translateX(-50%)',
    fontSize:  '11px',
    color:     'var(--text-dim)',
    fontFamily:'var(--font-mono)',
    whiteSpace: 'nowrap',
  },
  relLabel: {
    color:    'var(--text-dimmer)',
    fontSize: '10px',
  },
  barTrack: {
    position:     'relative',
    height:       '40px',
    width:        '100%',
    borderRadius: '6px',
    overflow:     'hidden',
    background:   'var(--surface-2)',
    margin:       '4px 0',
  },
  segment: {
    position: 'absolute',
    top:      0,
    height:   '100%',
    transition: 'width 0.3s ease',
  },
  nowMarker: {
    position:        'absolute',
    left:            '0%',
    top:             0,
    bottom:          0,
    width:           '2px',
    backgroundColor: 'white',
    opacity:         0.6,
    zIndex:          10,
  }
}
