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
export const config = { runtime: 'edge' };

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
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

  // x-forwarded-for: Vercel la agrega en la petición entrante con la IP real
  // del cliente. Sin reenviarla explícitamente aquí, el fetch saliente no la
  // trae — el backend vería la IP de Vercel para todos los usuarios y su
  // rate limiting por IP (ver main.ts::obtenerIpCliente) quedaría compartido
  // entre clientes distintos en vez de aislado por persona.
  const ipCliente = request.headers.get('x-forwarded-for') ?? '';
  const authorization = request.headers.get('authorization') ?? '';
  const origin = request.headers.get('origin') ?? '';

  const url = new URL(request.url);
  const backendRes = await fetch(`${backendUrl}/mis-pedidos${url.search}`, {
    method: 'GET',
    headers: {
      ...(ipCliente ? { 'x-forwarded-for': ipCliente } : {}),
      ...(authorization ? { 'authorization': authorization } : {}),
      ...(origin ? { 'origin': origin } : {}),
    },
  });

  const respBody = await backendRes.text();
  return new Response(respBody, {
    status: backendRes.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
