// Proxy serverless (Vercel Edge Function) hacia POST /cancelar-pedido del
// backend. Mismo motivo que los demás proxies en api/: la URL real del
// backend (túnel Cloudflare) nunca llega al bundle JS del cliente.
//
// Proxy opaco, no tubo ciego: los headers salientes hacia Deno se arman
// desde cero en api/_lib/proxySeguro.ts (nunca se reenvían los del cliente
// tal cual, para que un Origin falsificado no llegue nunca al backend).
import { rechazarOrigenFalso, headersProxy } from './_lib/proxySeguro';

export const config = { runtime: 'edge' };

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método no permitido.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const origenRechazado = rechazarOrigenFalso(request);
  if (origenRechazado) return origenRechazado;

  const backendUrl = process.env['BACKEND_URL'];
  if (!backendUrl) {
    return new Response(JSON.stringify({ error: 'Backend no configurado.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await request.text();
  const backendRes = await fetch(`${backendUrl}/cancelar-pedido`, {
    method: 'POST',
    headers: headersProxy(request),
    body,
  });

  const respBody = await backendRes.text();
  return new Response(respBody, {
    status: backendRes.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
