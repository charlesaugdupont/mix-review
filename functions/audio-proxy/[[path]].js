export async function onRequest(context) {
  const url = new URL(context.request.url);
  
  // More robust path extraction
  const filename = url.pathname.split('/audio-proxy/')[1];
  if (!filename) return new Response('Not found', { status: 404 });
  
  const supabaseUrl = `https://nxmodpianwotdvpixjqp.supabase.co/storage/v1/object/public/audio/${filename}`;
  
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const cache = caches.default;
  let response = await cache.match(context.request);
  if (response) return response;

  response = await fetch(supabaseUrl);
  
  // Log to verify the URL being fetched
  console.log('Fetching:', supabaseUrl, 'Status:', response.status);
  
  if (!response.ok) return new Response('Upstream error', { status: response.status });
  
  const toCache = new Response(response.body, response);
  toCache.headers.set('Cache-Control', 'public, max-age=2592000');
  Object.entries(corsHeaders).forEach(([k, v]) => toCache.headers.set(k, v));
  cache.put(context.request, toCache.clone());
  return toCache;
}