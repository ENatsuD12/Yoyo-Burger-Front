// Proxy serverless (Vercel Edge Function) hacia POST /cancelar-pedido del
// backend. Mismo motivo que los demás proxies en api/: la URL real del
// backend (túnel Cloudflare) nunca llega al bundle JS del cliente.
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
  const authorization = request.headers.get('authorization') ?? '';

  const body = await request.text();
  const backendRes = await fetch(`${backendUrl}/cancelar-pedido`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ipCliente ? { 'x-forwarded-for': ipCliente } : {}),
      ...(authorization ? { 'authorization': authorization } : {}),
    },
    body,
  });

  const respBody = await backendRes.text();
  return new Response(respBody, {
    status: backendRes.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
