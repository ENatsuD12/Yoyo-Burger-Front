// Build de producción (`ng build`). Ruta relativa a las funciones
// serverless de Vercel en api/ (api/sesion.ts, api/chat/stream.ts), que
// hacen de proxy hacia el backend real — la URL del backend (dominio de
// Ngrok, ver yoyo-bot/docker-compose.yml) ya NO va en el JS del cliente,
// solo vive server-side en la env var BACKEND_URL del proyecto de Vercel.
export const environment = {
  production: true,
  apiUrl: '/api',
};
