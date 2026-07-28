// Proxy serverless (Vercel Edge Function) hacia POST /chat/stream del
// backend. Mismo motivo que api/sesion.ts: oculta BACKEND_URL del bundle
// del cliente. Usa runtime "edge" (no Node.js) porque necesita reenviar el
// ReadableStream de la respuesta SSE del backend token por token — el
// runtime Node.js de Vercel bufferea la respuesta completa antes de
// enviarla, lo que rompería el streaming en vivo del chat.
export const config = { runtime: 'edge' };

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método no permitido.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const backendUrl = process.env['BACKEND_URL'];
  if (!backendUrl) {
    return new Response(JSON.stringify({ error: 'Backend no configurado.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const ipCliente = request.headers.get('x-forwarded-for') ?? '';

  const body = await request.text();
  const backendRes = await fetch(`${backendUrl}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
      ...(ipCliente ? { 'x-forwarded-for': ipCliente } : {}),
    },
    body,
  });

  // El backend puede rechazar ANTES de abrir el stream (401 por PIN
  // bloqueado, etc.) y devolver JSON normal en vez de SSE — se reenvía tal
  // cual, sin asumir que el body siempre es un stream de eventos.
  return new Response(backendRes.body, {
    status: backendRes.status,
    headers: {
      'Content-Type': backendRes.headers.get('Content-Type') ?? 'application/json',
    },
  });
}
