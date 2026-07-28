// src/app/sesion.service.ts
//
// Encapsula el login en DOS pasos contra el backend:
//   1. POST /sesion    — solo el teléfono. Respuesta SIEMPRE idéntica, exista
//      o no el número en la base — evita "phone enumeration" (ver main.ts).
//   2. POST /validar-pin — el PIN. Solo aquí se sabe (y se revela, ya con el
//      PIN correcto) si el teléfono era nuevo, vía requireProfileCompletion.
//
// También maneja el refresco silencioso del token de sesión de 15 minutos
// (ver yoyo-bot/security/session.ts) para que una conversación larga no
// interrumpa al cliente pidiéndole el PIN de nuevo a la mitad de un pedido —
// el refresco reutiliza el PIN ya guardado localmente y llama /validar-pin
// de nuevo, el mismo paso 2, sin pasar otra vez por /sesion.
//
// No es un HttpInterceptor de Angular porque este proyecto no usa
// HttpClient: /chat/stream se consume con fetch()+ReadableStream (Server-Sent
// Events) porque HttpClient bufferea la respuesta completa antes de
// entregarla, lo que rompería el streaming en vivo del chat (ver app.ts).
// Este servicio cumple el mismo rol que cumpliría un interceptor — un solo
// lugar que decide qué hacer con 401/429/403 — pero sobre fetch.

import { Injectable } from '@angular/core';
import { environment } from '../environments/environment';

export interface Sesion {
  nombre: string;
  telefono: string;
  /** Solo vive en memoria/localStorage del cliente. Tras el login ya NO
   * viaja en /chat ni /chat/stream — solo en /validar-pin (login inicial y
   * cada refresco silencioso del token). */
  pin: string;
  /** Token firmado de 15 min (ver security/session.ts). Viaja en /chat y
   * /chat/stream en vez del PIN. */
  token: string;
}

export interface ResultadoPasoTelefono {
  ok: boolean;
  error?: string;
  status?: number;
}

export interface ResultadoValidarPin {
  ok: boolean;
  token?: string;
  /** Solo tiene sentido cuando ok===true: true si el teléfono nunca había
   * tenido PIN (recién se creó con este) y al front le falta el nombre. */
  requireProfileCompletion?: boolean;
  error?: string;
  status?: number;
}

export interface ResultadoFetchSesion {
  res: Response;
  /** true si hay que forzar login de nuevo (token inválido/forjado, o el
   * refresco silencioso también falló) — a diferencia de un 429, que no
   * cierra la sesión, solo pide esperar. */
  sesionExpirada: boolean;
  /** Mensaje ya listo para mostrar, solo presente si sesionExpirada o si el
   * rechazo fue por rate limit (429). Nunca revela si el PIN era correcto. */
  mensajeError?: string;
}

/** Un pedido ya confirmado, tal como lo guarda db/pedidos.ts — el folio es
 * el comprobante de compra puramente digital (sin SMS/WhatsApp). */
export interface PedidoHistorialItem {
  folio: string;
  fecha: string;
  total: number;
  estado: string;
}

export interface ResultadoHistorial {
  ok: boolean;
  pedidos?: PedidoHistorialItem[];
  /** true si hay que forzar login de nuevo, igual que en ResultadoFetchSesion. */
  sesionExpirada?: boolean;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class SesionService {
  /** Paso 1: POST /sesion con SOLO el teléfono. La respuesta de éxito es
   * genérica a propósito — nunca distingue si el número ya tiene cuenta. */
  async iniciarSesion(telefono: string): Promise<ResultadoPasoTelefono> {
    try {
      const res = await fetch(`${environment.apiUrl}/sesion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefono }),
      });
      const datos = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, status: res.status, error: this.mensajeAmigable(res, datos) };
      }
      return { ok: true, status: res.status };
    } catch {
      return { ok: false, error: 'No se pudo conectar con el servidor. Intenta de nuevo.' };
    }
  }

  /** Paso 2: POST /validar-pin con teléfono + PIN. Solo aquí se sabe si el
   * PIN era correcto, y solo aquí se revela requireProfileCompletion. */
  async validarPin(telefono: string, pin: string): Promise<ResultadoValidarPin> {
    try {
      const res = await fetch(`${environment.apiUrl}/validar-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefono, pin }),
      });
      const datos = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, status: res.status, error: this.mensajeAmigable(res, datos) };
      }
      return {
        ok: true,
        token: datos.token,
        requireProfileCompletion: !!datos.requireProfileCompletion,
        status: res.status,
      };
    } catch {
      return { ok: false, error: 'No se pudo conectar con el servidor. Intenta de nuevo.' };
    }
  }

  /**
   * fetch autenticado con el token de la sesión, para /chat y /chat/stream.
   * Si el backend responde 401 con `tokenExpirado: true` (el token venció,
   * no que sea inválido), renueva la sesión EN SILENCIO llamando de nuevo a
   * /validar-pin con el PIN que ya está guardado localmente, y reintenta la
   * llamada original una sola vez — el cliente nunca ve un mensaje de error
   * por esto, solo una respuesta un poco más lenta.
   *
   * `actualizarToken` deja que quien llama (App) persista el token nuevo en
   * su propio estado/localStorage sin que este servicio conozca esos
   * detalles de almacenamiento.
   */
  async fetchConSesion(
    url: string,
    cuerpo: Record<string, unknown>,
    sesion: Sesion,
    actualizarToken: (token: string) => void,
  ): Promise<ResultadoFetchSesion> {
    // El token viaja en el header Authorization, no mezclado en el body —
    // convención estándar para credenciales (ver main.ts::requerirSesion).
    const llamar = (token: string) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(cuerpo),
      });

    let res = await llamar(sesion.token);

    if (res.status === 401) {
      const datos = await res.clone().json().catch(() => ({}));
      if (datos.tokenExpirado) {
        const refresco = await this.validarPin(sesion.telefono, sesion.pin);
        if (refresco.ok && refresco.token) {
          actualizarToken(refresco.token);
          res = await llamar(refresco.token);
        }
      }
    }

    if (res.status === 401 || res.status === 403) {
      // Si tras el refresco silencioso SIGUE en 401 (o el backend/algún
      // proxy delante manda 403), ya no es cuestión de expiración normal
      // (PIN inválido, cuenta bloqueada, token forjado) — aquí sí hay que
      // forzar login de nuevo mostrando el motivo real.
      const datos = await res.clone().json().catch(() => ({}));
      return { res, sesionExpirada: true, mensajeError: this.mensajeAmigable(res, datos) };
    }

    if (res.status === 429) {
      const datos = await res.clone().json().catch(() => ({}));
      return { res, sesionExpirada: false, mensajeError: this.mensajeAmigable(res, datos) };
    }

    return { res, sesionExpirada: false };
  }

  /**
   * GET /mis-pedidos: historial de pedidos confirmados (folio, fecha, total,
   * estado). Mismo refresco silencioso de token que fetchConSesion, pero
   * para una consulta GET (el teléfono va en la query string porque no es
   * secreto; el token va en el header Authorization, nunca en la URL —
   * una URL con el token dentro queda guardada en el historial del
   * navegador y en logs de acceso de cualquier proxy intermedio).
   */
  async obtenerHistorial(sesion: Sesion, actualizarToken: (token: string) => void): Promise<ResultadoHistorial> {
    const llamar = (token: string) => {
      const qs = new URLSearchParams({ telefono: sesion.telefono });
      return fetch(`${environment.apiUrl}/mis-pedidos?${qs}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      });
    };

    try {
      let res = await llamar(sesion.token);

      if (res.status === 401) {
        const datos = await res.clone().json().catch(() => ({}));
        if (datos.tokenExpirado) {
          const refresco = await this.validarPin(sesion.telefono, sesion.pin);
          if (refresco.ok && refresco.token) {
            actualizarToken(refresco.token);
            res = await llamar(refresco.token);
          }
        }
      }

      const datos = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) {
        return { ok: false, sesionExpirada: true, error: this.mensajeAmigable(res, datos) };
      }
      if (!res.ok) {
        return { ok: false, error: this.mensajeAmigable(res, datos) };
      }
      return { ok: true, pedidos: datos.pedidos ?? [] };
    } catch {
      return { ok: false, error: 'No se pudo conectar con el servidor. Intenta de nuevo.' };
    }
  }

  /** Mensaje claro para el cliente sin revelar si el PIN era correcto o no
   * — el backend ya manda texto genérico ("Credenciales inválidas.", el
   * tiempo de bloqueo formateado, etc.); aquí solo se completa con el
   * Retry-After cuando el backend no incluyó ya un tiempo en el texto. */
  private mensajeAmigable(res: Response, datos: { error?: string }): string {
    if (res.status === 429) {
      const seg = this.retryAfterSegundos(res);
      const base = datos.error || 'Demasiadas solicitudes.';
      return seg && !/\d/.test(base) ? `${base} Intenta de nuevo en ~${seg}s.` : base;
    }
    if (res.status === 403) {
      return datos.error || 'Acceso bloqueado por seguridad. Intenta más tarde.';
    }
    return datos.error || 'No se pudo verificar tu sesión. Inicia sesión de nuevo.';
  }

  private retryAfterSegundos(res: Response): number | undefined {
    const header = res.headers.get('Retry-After');
    const n = header ? Number(header) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
}
