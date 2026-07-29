// Proxy serverless (Vercel Edge Function) hacia GET /mis-pedidos del backend.
//
// Objetivo: la URL real del backend (túnel Cloudflare) nunca llega al bundle JS
// del cliente — vive solo en BACKEND_URL, una env var de servidor (sin
// prefijo público de Angular). El front en producción llama a
// /api/mis-pedidos (mismo origen) en vez de la URL del backend directamente.
//
// A diferencia de sesion.ts/validar-pin.ts (POST con body JSON), esta es una
// consulta GET: el teléfono viaja en la query string (no es secreto) y el
// token viaja en el header Authorization (ver main.ts::requerirSesion) — se
// reenvían la URL (con su ?telefono=...) y ese header tal cual.
//
// Proxy opaco, no tubo ciego: los headers salientes hacia Deno se arman
// desde cero en api/_lib/proxySeguro.ts (nunca se reenvían los del cliente
// tal cual, para que un Origin falsificado no llegue nunca al backend).
import { rechazarOrigenFalso, headersProxy } from './_lib/proxySeguro';

export const config = { runtime: 'edge' };

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
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

  const url = new URL(request.url);
  const backendRes = await fetch(`${backendUrl}/mis-pedidos${url.search}`, {
    method: 'GET',
    headers: headersProxy(request),
  });

  const respBody = await backendRes.text();
  return new Response(respBody, {
    status: backendRes.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
