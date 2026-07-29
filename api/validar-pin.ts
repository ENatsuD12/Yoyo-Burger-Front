// Proxy serverless (Vercel Edge Function) hacia POST /validar-pin del backend.
//
// Objetivo: la URL real del backend (túnel Cloudflare) nunca llega al bundle JS
// del cliente — vive solo en BACKEND_URL, una env var de servidor (sin
// prefijo público de Angular), configurada en el proyecto de Vercel. El
// front en producción llama a /api/validar-pin (mismo origen) en vez de la
// URL del backend directamente. Endpoint separado de api/sesion.ts (que solo
// manda el teléfono): aquí sí viaja el PIN, ver yoyo-bot/main.ts.
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
  const backendRes = await fetch(`${backendUrl}/validar-pin`, {
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
