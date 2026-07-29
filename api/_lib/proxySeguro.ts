// Helpers compartidos por las Edge Functions de api/ (sesion.ts,
// validar-pin.ts, cancelar-pedido.ts, mis-pedidos.ts, chat/stream.ts) para
// hablar con el backend de Deno como "cliente confiable" en vez de tubo
// ciego: arman los headers salientes desde cero (nunca copian ni esparcen
// los del cliente) e inyectan el Origin legítimo del front en lugar de
// reenviar el que trajo la petición entrante — así un Origin falsificado
// nunca llega a Deno, ni siquiera para ser rechazado ahí.
//
// El archivo vive bajo api/_lib/ (prefijo "_") a propósito: Vercel excluye
// de las rutas cualquier carpeta que empiece con "_", así este módulo no se
// convierte en un endpoint propio.

// Dominio real del front en producción. Puede sobreescribirse con la env var
// FRONTEND_URL del proyecto de Vercel (server-side) sin tocar código; el
// valor por defecto es el dominio de producción confirmado (ver
// PENTEST_YOYO_BURGER_V4.md), no un placeholder.
const ORIGEN_FRONTEND = process.env['FRONTEND_URL'] ?? 'https://yoyo-burger.vercel.app';

/**
 * Fail-fast en el borde: si la petición entrante trae un Origin y no
 * coincide con el del front legítimo, corta aquí y devuelve 403 sin llegar
 * a hacer fetch al backend (ahorra el viaje a Cloudflare/Deno). Si no trae
 * Origin (fetch same-origin sin header, herramientas no-browser) se deja
 * pasar: el backend tiene su propia whitelist estricta como segunda
 * barrera y la aplica igual.
 */
export function rechazarOrigenFalso(request: Request): Response | null {
  const origin = request.headers.get('origin');
  if (origin && origin !== ORIGEN_FRONTEND) {
    return new Response(JSON.stringify({ error: 'Origen no permitido.' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}

/**
 * Arma desde cero el objeto Headers para el fetch saliente hacia Deno. A
 * propósito NO clona ni esparce (...request.headers) los headers del
 * cliente: eso es lo que dejaba pasar un Origin/Host falsificado. Solo
 * viajan tres cosas hacia el backend:
 *  - Origin: el legítimo del front (fijo), no el que mandó el cliente.
 *  - x-forwarded-for: la IP real del cliente, para que el rate limiting por
 *    IP del backend (ver yoyo-bot/main.ts::obtenerIpCliente) siga aislado
 *    por persona en vez de ver siempre la IP de Vercel.
 *  - Authorization: el token de sesión, si la petición trae uno.
 *  - x-vercel-edge: candado M2M (ver yoyo-bot/main.ts::vercelEdgeValida) —
 *    sin este secreto, alguien que descubra la URL del túnel Cloudflare y
 *    falsifique el Origin igual no pasa del backend. Vive SOLO en la env var
 *    de servidor de Vercel (VERCEL_EDGE_SECRET), nunca llega al bundle del
 *    cliente. Si la variable no está configurada, el header se omite y el
 *    backend se comporta como fail-open (solo valida Origin).
 */
export function headersProxy(request: Request): Headers {
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Origin', ORIGEN_FRONTEND);

  const edgeSecret = process.env['VERCEL_EDGE_SECRET'];
  if (edgeSecret) headers.set('x-vercel-edge', edgeSecret);

  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip');
  if (ip) headers.set('x-forwarded-for', ip);

  const auth = request.headers.get('authorization');
  if (auth) headers.set('Authorization', auth);

  return headers;
}
