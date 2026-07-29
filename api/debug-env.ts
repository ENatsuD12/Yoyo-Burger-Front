// DIAGNÓSTICO TEMPORAL — borrar este archivo en cuanto se resuelva el 401 de
// /api/sesion. Compara (con booleanos, nunca exponiendo el valor real) si
// las env vars de servidor que necesita api/_lib/proxySeguro.ts están
// realmente presentes en el deployment de Vercel que sirve producción.
export const config = { runtime: 'edge' };

const TOKEN_ESPERADO = '7BQ2zxeajUQ2LBu3gD/chOFoHYU7CI3Il5Pt36ebHHU=';
const URL_ESPERADA = 'https://sphere-licenses-hawk-adequate.trycloudflare.com';

export default async function handler(): Promise<Response> {
  const token = process.env['BACKEND_API_TOKEN'] ?? '';
  const url = process.env['BACKEND_URL'] ?? '';

  return new Response(
    JSON.stringify(
      {
        tokenPresente: token.length > 0,
        tokenLongitud: token.length,
        tokenCoincideConElEsperado: token === TOKEN_ESPERADO,
        urlPresente: url.length > 0,
        urlCoincideConLaEsperada: url === URL_ESPERADA,
        urlValorActual: url, 
      },
      null,
      2,
    ),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}
