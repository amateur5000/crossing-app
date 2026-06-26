// app/api/crossing/route.js
import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const crossingId = searchParams.get('id')

  if (!crossingId) {
    return NextResponse.json({ error: 'Missing crossing id' }, { status: 400 })
  }

  const now    = new Date()
  const cutoff = new Date(now.getTime() + 30 * 60 * 1000).toISOString()

  // Fetch predictions from the crossing_status view
  // Filter to the next 30 minutes only
  const { data, error } = await supabase
    .from('crossing_status')
    .select('*')
    .eq('crossing_id', crossingId)
    .gte('closes_at', now.toISOString())
    .lte('closes_at', cutoff)
    .neq('status', 'cancelled')
    .order('closes_at', { ascending: true })

  if (error) {
    console.error('Supabase error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Also fetch the crossing details
  const { data: crossing, error: crossingError } = await supabase
    .from('crossings')
    .select('id, name, road_name, line_name, region, lead_time_seconds')
    .eq('id', crossingId)
    .single()

  if (crossingError) {
    return NextResponse.json({ error: crossingError.message }, { status: 500 })
  }

  return NextResponse.json({
    crossing,
    predictions: data,
    fetchedAt: now.toISOString()
  })
}
