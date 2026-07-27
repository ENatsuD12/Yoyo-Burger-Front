// shared/validacionTelefono.ts
//
// Fuente ÚNICA de la regla de teléfono válido. La usan yoyo-bot (Deno, vía
// re-export en utils/validators.ts) y yoyo-front (Angular, import directo)
// para que nunca vuelvan a divergir como pasó el 2026-07-26: el login de
// Angular aceptaba "9999999990" porque solo rechazaba los 10 dígitos
// idénticos, mientras el backend ya rechazaba 7+ dígitos idénticos seguidos
// en cualquier parte del número — el cliente pasaba el login para enterarse
// hasta el primer mensaje de que su número no servía.

// Número local mexicano: exactamente 10 dígitos.
const LONGITUD_LOCAL_MX = 10;

// Detecta secuencias de 7+ dígitos idénticos consecutivos.
// Cubre números falsos como: 1111111113, 9999999999, 0000000000...
const RE_SECUENCIA_REPETITIVA = /(\d)\1{6,}/;

/**
 * Valida que un número de teléfono sea un número local mexicano real.
 *
 * Reglas aplicadas en orden:
 *   1. Limpieza   — elimina todo lo que no sea dígito (+, -, espacios, etc.)
 *   2. Longitud   — debe tener exactamente 10 dígitos
 *   3. Anti-spam  — no debe tener 7+ dígitos idénticos consecutivos
 *
 * @returns true solo si el número supera las 3 barreras.
 */
export function esNumeroWhatsAppValido(telefono: string): boolean {
  // ── Barrera 1: Limpieza ─────────────────────────────────────────────────
  // Normaliza cualquier formato de entrada: "999 123-4567", "+9991234567" → "9991234567"
  const soloDigitos = telefono.replace(/\D/g, "");

  // ── Barrera 2: Longitud ──────────────────────────────────────────────────
  // Los números locales mexicanos tienen exactamente 10 dígitos.
  if (soloDigitos.length !== LONGITUD_LOCAL_MX) return false;

  // ── Barrera 3: Anti-Spam / Anti-Fake ────────────────────────────────────
  // Rechaza números de prueba generados automáticamente con secuencias
  // repetitivas obvias: 1111111113, 9999999999, 0000000012, etc.
  if (RE_SECUENCIA_REPETITIVA.test(soloDigitos)) return false;

  return true;
}
