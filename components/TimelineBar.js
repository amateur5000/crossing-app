// components/TimelineBar.js
'use client'

// ============================================================
// TimelineBar
// Shows a 30-minute window of crossing open/closed status.
// Green = open, Red = closed.
// All time calculations in UTC-aware Date objects.
// Display times converted to local time via toLocaleTimeString.
// Overlapping/near-overlapping closures are merged.
// ============================================================

const MERGE_GAP_MS = 60 * 1000 // Merge closures within 60 seconds of each other

export default function TimelineBar({ predictions, fetchedAt }) {
  const now        = fetchedAt ? new Date(fetchedAt) : new Date()
  const windowMins = 30
  const windowMs   = windowMins * 60 * 1000
  const endTime    = new Date(now.getTime() + windowMs)

  // Merge overlapping/near-overlapping closures
  const merged   = mergeClosures(predictions, now, endTime)
  const segments = buildSegments(merged, now, endTime)

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
// Merge overlapping or near-overlapping closure windows
// Returns array of { closesAt, opensAt } merged periods
// ============================================================

export function mergeClosures(predictions, now, endTime) {
  if (!predictions || predictions.length === 0) return []

  // Filter to relevant window and sort by closes_at
  const relevant = predictions
    .filter(p => {
      const closes = new Date(p.closes_at)
      const opens  = new Date(p.opens_at)
      return closes < endTime && opens > now && p.status !== 'cancelled'
    })
    .sort((a, b) => new Date(a.closes_at) - new Date(b.closes_at))

  if (relevant.length === 0) return []

  const merged = []
  let current  = {
    closesAt: new Date(relevant[0].closes_at),
    opensAt:  new Date(relevant[0].opens_at)
  }

  for (let i = 1; i < relevant.length; i++) {
    const closes = new Date(relevant[i].closes_at)
    const opens  = new Date(relevant[i].opens_at)

    // If this closure starts within MERGE_GAP_MS of the current one ending, merge them
    if (closes - current.opensAt <= MERGE_GAP_MS) {
      // Extend the current closure if this one ends later
      if (opens > current.opensAt) {
        current.opensAt = opens
      }
    } else {
      merged.push(current)
      current = { closesAt: closes, opensAt: opens }
    }
  }
  merged.push(current)

  return merged
}

// ============================================================
// Build visual segments from merged closures
// Fills gaps with green (open) segments
// ============================================================

function buildSegments(mergedClosures, now, endTime) {
  const segments = []
  let cursor     = now

  for (const closure of mergedClosures) {
    const closes = closure.closesAt < now     ? now     : closure.closesAt
    const opens  = closure.opensAt  > endTime ? endTime : closure.opensAt

    if (closes >= endTime) break
    if (opens  <= now)     continue

    // Green gap before this closure
    if (cursor < closes) {
      segments.push({
        start:    cursor,
        end:      closes,
        startPct: toPct(cursor, now, endTime),
        widthPct: toPct(closes, now, endTime) - toPct(cursor, now, endTime),
        isOpen:   true
      })
    }

    // Red segment
    segments.push({
      start:    closes,
      end:      opens,
      startPct: toPct(closes, now, endTime),
      widthPct: toPct(opens,  now, endTime) - toPct(closes, now, endTime),
      isOpen:   false
    })

    cursor = opens
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
  const total = end   - start
  const pos   = new Date(time) - start
  return Math.max(0, Math.min(100, (pos / total) * 100))
}

function formatTime(date) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

const styles = {
  wrapper: {
    position:   'relative',
    width:      '100%',
    userSelect: 'none',
  },
  labelRow: {
    position: 'relative',
    height:   '20px',
    width:    '100%',
  },
  label: {
    position:   'absolute',
    transform:  'translateX(-50%)',
    fontSize:   '11px',
    color:      'var(--text-dim)',
    fontFamily: 'var(--font-mono)',
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
    position:   'absolute',
    top:        0,
    height:     '100%',
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
