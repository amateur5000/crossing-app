// app/api/admin/route.js
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

  // Fetch predictions joined with crossing info
  const { data: predictions, error: predError } = await supabase
    .from('crossing_status')
    .select('*')
    .eq('crossing_id', crossingId)
    .gte('closes_at', new Date(now.getTime() - 5 * 60 * 1000).toISOString()) // 5 mins ago
    .lte('closes_at', cutoff)
    .order('closes_at', { ascending: true })

  if (predError) {
    return NextResponse.json({ error: predError.message }, { status: 500 })
  }

  // Get unique train IDs from predictions
  const trainIds = predictions.map(p => p.train_id)

  // Fetch raw train_locations for these trains
  const { data: locations, error: locError } = await supabase
    .from('train_locations')
    .select('*')
    .in('train_id', trainIds.length > 0 ? trainIds : ['none'])
    .order('scheduled_pass', { ascending: true, nullsFirst: false })

  if (locError) {
    return NextResponse.json({ error: locError.message }, { status: 500 })
  }

  // Fetch crossing details
  const { data: crossing } = await supabase
    .from('crossings')
    .select('*')
    .eq('id', crossingId)
    .single()

  return NextResponse.json({
    crossing,
    predictions,
    locations,
    fetchedAt: now.toISOString()
  })
}
