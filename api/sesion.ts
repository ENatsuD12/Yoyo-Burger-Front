// Proxy serverless (Vercel Edge Function) hacia POST /sesion del backend.
//
// Objetivo: la URL real del backend (túnel Cloudflare) nunca llega al bundle JS
// del cliente — vive solo en BACKEND_URL, una env var de servidor (sin
// prefijo público de Angular), configurada en el proyecto de Vercel. El
// front en producción llama a /api/sesion (mismo origen) en vez de la URL
// del backend directamente.
//
// Esta función es un proxy opaco, no un tubo ciego: nunca reenvía los
// headers del cliente tal cual (eso permitiría a un atacante falsificar el
// Origin y hacer que Deno vea una petición "legítima"). Arma un paquete
// limpio hacia el backend vía api/_lib/proxySeguro.ts.
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
  const backendRes = await fetch(`${backendUrl}/sesion`, {
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
