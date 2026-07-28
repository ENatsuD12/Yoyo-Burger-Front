import { ChangeDetectorRef, Component, ElementRef, ViewChild, AfterViewChecked, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { environment } from '../environments/environment';
import { esNumeroWhatsAppValido } from '../shared/validacionTelefono';
import { SesionService, type Sesion, type PedidoHistorialItem } from './sesion.service';

// 6 dígitos para teléfonos nuevos; 4 solo se acepta para no dejar fuera a
// quien ya tenía un PIN creado antes de esta migración (ver
// yoyo-bot/security/pin.ts) — el backend es quien decide cuál exigir según
// si el teléfono es nuevo o no.
const FORMATO_PIN = /^(\d{4}|\d{6})$/;

interface Mensaje {
  tipo: 'burbuja' | 'sistema';
  texto: string;
  lado?: 'in' | 'out';
  ts?: string;
  botonesRapidos?: any[];
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html'
})
export class App implements OnInit, AfterViewChecked {
  @ViewChild('messagesContainer') private messagesContainer!: ElementRef;

  // zone.js no instrumenta fetch()+ReadableStream.getReader() (el parche
  // zone-patch-fetch solo cubre la promesa inicial de fetch, no las
  // iteraciones del reader) — sin este forzado manual, el mensaje del bot
  // solo aparecía al recargar la página o al disparar otro evento que sí
  // pasara por Angular (ej. escribir en el input).
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly sesionSvc = inject(SesionService);

  // Estado de sesión
  isLogin = true;
  /** Paso actual del login (ver yoyo-bot/main.ts: /sesion y /validar-pin
   * están separados a propósito para no filtrar si un teléfono ya existe
   * antes de validar el PIN — "phone enumeration"). 'nombre' solo aparece
   * si el backend dice que hace falta, o si este dispositivo no tiene el
   * nombre de este teléfono cacheado localmente (el backend no lo guarda). */
  pantallaLogin: 'telefono' | 'pin' | 'nombre' = 'telefono';
  sesion: Sesion = { nombre: '', telefono: '', pin: '', token: '' };
  errorLogin = '';
  verificandoLogin = false;
  
  // Estado del chat
  mensajes: Mensaje[] = [];
  inputMensaje = '';
  isTyping = false;
  estadoBot = 'en línea';
  bloquearInput = false;
  
  // Streaming y Voz
  textoStreaming = '';
  escuchando = false;
  reconocedor: any;

  // "Mis Pedidos": historial de folios como comprobante de compra
  // puramente digital (sin SMS/WhatsApp, ver yoyo-bot/db/pedidos.ts).
  mostrarHistorial = false;
  cargandoHistorial = false;
  errorHistorial = '';
  historialPedidos: PedidoHistorialItem[] = [];
  /** Folio en proceso de cancelación (null si ninguno) — deshabilita el
   * botón de esa fila mientras la petición está en vuelo. */
  cancelandoFolio: string | null = null;
  /** Separado de errorHistorial a propósito: un fallo al cancelar no debe
   * reemplazar la lista completa de pedidos por un mensaje de error. */
  errorCancelacion = '';

  // URL del backend: viene de environment.ts (prod, dominio del túnel de
  // Cloudflare) o environment.development.ts (dev, localhost:8000) — nunca
  // hardcodeada aquí.
  readonly URL_STREAM = `${environment.apiUrl}/chat/stream`;
  readonly MAX_TEXTO = 250;

  // El backend borra el historial de un teléfono tras 24h de inactividad
  // (ver memory/history.ts::necesitaLimpieza en yoyo-bot). El caché local en
  // localStorage no tenía ningún límite de tiempo propio: en un equipo
  // compartido, el historial de pedidos de un cliente podía quedar legible
  // ahí indefinidamente, mucho más allá de lo que el propio backend
  // considera "la misma sesión". Se replica la misma ventana de 24h aquí.
  private readonly UN_DIA_MS = 24 * 60 * 60 * 1000;

  ngOnInit() {
    this.inicializarReconocimientoVoz();
    this.restaurarSesion();
  }

  ngAfterViewChecked() {
    this.bajarScroll();
  }

  // --- CONTROL DE SESIÓN ---
  //
  // Login en dos llamadas separadas al backend, a propósito (ver
  // yoyo-bot/main.ts): /sesion (solo teléfono) siempre responde igual,
  // exista o no el número, así que aquí SIEMPRE se avanza a la pantalla de
  // PIN sin importar nada más — no hay "esNuevo" que leer todavía. Solo
  // /validar-pin (paso 2) puede revelar si el teléfono era nuevo
  // (requireProfileCompletion), y solo DESPUÉS de que el PIN ya fue correcto.

  /** Paso 1: solo teléfono. */
  async enviarTelefono() {
    const tel = this.sesion.telefono.replace(/\D+/g, '');
    // esNumeroWhatsAppValido viene de shared/validacionTelefono.ts, la misma
    // función que usa el backend — ya no hay dos regex que puedan divergir
    // (pasó el 2026-07-26: este login dejaba entrar "9999999990" y el
    // backend lo bloqueaba después con "[SEGURIDAD] Número inválido").
    if (tel[0] === '0' || !esNumeroWhatsAppValido(tel)) {
      this.errorLogin = 'Teléfono inválido. Debe ser de 10 dígitos y válido.'; return;
    }

    this.errorLogin = '';
    this.verificandoLogin = true;
    try {
      const resultado = await this.sesionSvc.iniciarSesion(tel);
      if (!resultado.ok) {
        this.errorLogin = resultado.error || 'No se pudo continuar. Intenta de nuevo.';
        return;
      }
      this.sesion.telefono = tel;
      this.pantallaLogin = 'pin';
    } finally {
      this.verificandoLogin = false;
      this.cdr.markForCheck();
    }
  }

  /** Paso 2: PIN. Solo aquí se sabe si era correcto, y solo aquí el backend
   * revela si el teléfono era nuevo. */
  async confirmarPin() {
    if (!FORMATO_PIN.test(this.sesion.pin)) {
      this.errorLogin = 'El PIN debe tener 6 dígitos (o 4, si ya tenías uno creado antes).'; return;
    }

    this.errorLogin = '';
    this.verificandoLogin = true;
    try {
      const resultado = await this.sesionSvc.validarPin(this.sesion.telefono, this.sesion.pin);
      if (!resultado.ok) {
        this.errorLogin = resultado.error || 'No se pudo iniciar sesión. Intenta de nuevo.';
        return;
      }
      this.sesion.token = resultado.token ?? '';

      // El backend NO guarda el nombre (services/autenticacion.ts solo
      // persiste telefono+pin_hash, ver db/clientes.ts) — si este teléfono
      // ya tenía cuenta pero este es un dispositivo nuevo sin caché local,
      // tampoco hay nombre que usar aunque requireProfileCompletion sea
      // false. En ese caso también hay que pedirlo.
      const nombreCacheado = this.nombreCacheadoPara(this.sesion.telefono);
      if (resultado.requireProfileCompletion || !nombreCacheado) {
        this.pantallaLogin = 'nombre';
        return;
      }
      this.sesion.nombre = nombreCacheado;
      this.completarLogin();
    } finally {
      this.verificandoLogin = false;
      this.cdr.markForCheck();
    }
  }

  /** Paso 3 (solo si aplica): nombre. */
  confirmarNombre() {
    if (!this.sesion.nombre || !/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'-]+$/.test(this.sesion.nombre)) {
      this.errorLogin = 'El nombre es inválido.'; return;
    }
    this.errorLogin = '';
    this.completarLogin();
  }

  /** Regresa a la pantalla de teléfono, ej. si el cliente se equivocó al
   * teclearlo — no hace falta perder todo el login por corregir un dígito. */
  volverATelefono() {
    this.errorLogin = '';
    this.sesion.pin = '';
    this.pantallaLogin = 'telefono';
  }

  private nombreCacheadoPara(telefono: string): string | null {
    const raw = localStorage.getItem('yoyo-sesion');
    if (!raw) return null;
    try {
      const cache = JSON.parse(raw);
      return cache?.telefono === telefono && cache?.nombre ? cache.nombre : null;
    } catch {
      return null;
    }
  }

  private completarLogin() {
    localStorage.setItem('yoyo-sesion', JSON.stringify(this.sesion));
    this.cargarHistorial();
    this.isLogin = false;
  }

  salirChat() {
    localStorage.removeItem('yoyo-sesion');
    this.isLogin = true;
    this.pantallaLogin = 'telefono';
    this.mensajes = [];
    this.sesion = { nombre: '', telefono: '', pin: '', token: '' };
  }

  // --- MIS PEDIDOS (historial de folios) ---

  async abrirHistorial() {
    this.mostrarHistorial = true;
    this.cargandoHistorial = true;
    this.errorHistorial = '';
    try {
      const resultado = await this.sesionSvc.obtenerHistorial(this.sesion, (token) => {
        this.sesion.token = token;
        localStorage.setItem('yoyo-sesion', JSON.stringify(this.sesion));
      });
      if (!resultado.ok) {
        if (resultado.sesionExpirada) {
          this.mostrarHistorial = false;
          this.salirChat();
          this.errorLogin = resultado.error || 'Tu sesión ya no es válida. Inicia sesión de nuevo.';
          return;
        }
        this.errorHistorial = resultado.error || 'No se pudo cargar tu historial.';
        return;
      }
      this.historialPedidos = resultado.pedidos ?? [];
    } finally {
      this.cargandoHistorial = false;
      this.cdr.markForCheck();
    }
  }

  cerrarHistorial() {
    this.mostrarHistorial = false;
  }

  // Cancelación estrictamente visual (ver PASO 3/4 del rediseño): este botón
  // llama directo al backend, nunca pasa por el LLM — un modelo pequeño
  // manejando cancelaciones de pedidos pasados es justo el tipo de decisión
  // que este proyecto nunca le confía a la IA (ver ai/prompts.ts).
  async cancelarPedido(pedido: PedidoHistorialItem) {
    if (pedido.estado !== 'recibido' || this.cancelandoFolio) return;
    if (!confirm(`¿Cancelar el pedido ${pedido.folio}? Esta acción no se puede deshacer.`)) return;

    this.cancelandoFolio = pedido.folio;
    this.errorCancelacion = '';
    try {
      const { res, sesionExpirada, mensajeError } = await this.sesionSvc.fetchConSesion(
        `${environment.apiUrl}/cancelar-pedido`,
        { telefono: this.sesion.telefono, folio: pedido.folio },
        this.sesion,
        (token) => {
          this.sesion.token = token;
          localStorage.setItem('yoyo-sesion', JSON.stringify(this.sesion));
        },
      );

      if (sesionExpirada) {
        this.mostrarHistorial = false;
        this.salirChat();
        this.errorLogin = mensajeError || 'Tu sesión ya no es válida. Inicia sesión de nuevo.';
        return;
      }
      if (!res.ok) {
        const datos = await res.json().catch(() => ({}));
        this.errorCancelacion = mensajeError || datos.error || 'No se pudo cancelar el pedido.';
        return;
      }
      // Éxito: se refleja de inmediato en la lista ya cargada, sin tener que
      // volver a pedir el historial completo.
      pedido.estado = 'cancelado';
    } finally {
      this.cancelandoFolio = null;
      this.cdr.markForCheck();
    }
  }

  private restaurarSesion() {
    const raw = localStorage.getItem('yoyo-sesion');
    if (!raw) return;
    const sesionGuardada = JSON.parse(raw);
    // Sesiones guardadas antes de agregar el PIN no lo traen: forzar login
    // de nuevo en vez de entrar directo a un chat que va a rechazar cada
    // mensaje por falta de PIN.
    if (!FORMATO_PIN.test(sesionGuardada?.pin ?? '')) {
      localStorage.removeItem('yoyo-sesion');
      return;
    }
    this.sesion = { token: '', ...sesionGuardada };
    this.cargarHistorial();
    this.isLogin = false;

    // Sesiones guardadas antes de agregar el token de sesión (o cerradas por
    // más de 15 min) no traen uno vigente. En vez de esperar a que el primer
    // mensaje choque con un 401 y solo AHÍ pedir el refresh, se renueva aquí
    // en segundo plano llamando a /validar-pin con el PIN que ya está
    // guardado — el cliente entra directo al chat sin ver ningún error de
    // por medio.
    if (!this.sesion.token) {
      this.sesionSvc.validarPin(this.sesion.telefono, this.sesion.pin).then((r) => {
        if (r.ok && r.token) {
          this.sesion.token = r.token;
          localStorage.setItem('yoyo-sesion', JSON.stringify(this.sesion));
        }
        this.cdr.markForCheck();
      });
    }
  }

  // --- HISTORIAL Y MENSAJES ---

  private cargarHistorial() {
    const clave = `yoyo-msgs-${this.sesion.telefono}`;
    const raw = localStorage.getItem(clave);
    const cache = raw ? JSON.parse(raw) : null;

    // Formato viejo (array plano, sin marca de tiempo) o caché vencido por
    // inactividad >24h: se descarta y se arranca en limpio, igual que ya
    // hace el backend con el historial de Supabase.
    const vigente = cache && typeof cache.ultimaActividad === 'number'
      && (Date.now() - cache.ultimaActividad) <= this.UN_DIA_MS;

    if (vigente) {
      this.mensajes = cache.mensajes;
    } else {
      if (raw) localStorage.removeItem(clave);
      this.agregarSistema(`Chat de ${this.sesion.nombre} · ${this.sesion.telefono}`);
      this.agregarBurbuja(`¡Hola, ${this.sesion.nombre}! 🍔 Soy el asistente de Yoyo Burger. Dime qué se te antoja.`, 'in');
    }
  }

  private guardarHistorial() {
    if (this.mensajes.length > 100) this.mensajes = this.mensajes.slice(-100);
    const cache = { ultimaActividad: Date.now(), mensajes: this.mensajes };
    localStorage.setItem(`yoyo-msgs-${this.sesion.telefono}`, JSON.stringify(cache));
  }

  private agregarBurbuja(texto: string, lado: 'in' | 'out', botones: any[] | null = null) {
    const ts = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    this.mensajes.push({ tipo: 'burbuja', texto, lado, ts, botonesRapidos: botones || [] });
    this.guardarHistorial();
  }

  private agregarSistema(texto: string) {
    this.mensajes.push({ tipo: 'sistema', texto });
    this.guardarHistorial();
  }

  // --- COMUNICACIÓN STREAMING (SSE) ---

  onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!this.bloquearInput) {
        this.enviarMensaje();
      }
    }
  }

  async enviarMensaje(textoForzado?: string) {
    const texto = (textoForzado || this.inputMensaje).trim();
    if (!texto) return;
    
    if (texto.length > this.MAX_TEXTO) {
      this.agregarBurbuja(`Tu mensaje supera el límite de ${this.MAX_TEXTO} caracteres.`, 'in');
      return;
    }

    this.mensajes.forEach(m => m.botonesRapidos = []);

    this.agregarBurbuja(texto, 'out');
    this.inputMensaje = '';
    this.bloquearInput = true;
    this.isTyping = true;
    this.textoStreaming = '';
    this.estadoBot = 'conectando...';

    try {
      // fetchConSesion manda el token en vez del PIN, y si el backend dice
      // que venció (tokenExpirado, no que sea inválido) lo renueva solo con
      // el PIN que ya está guardado y reintenta — esta llamada nunca ve esa
      // renovación, solo el resultado final ya reintentado si hizo falta.
      const { res, sesionExpirada, mensajeError: mensajeRechazo } = await this.sesionSvc.fetchConSesion(
        this.URL_STREAM,
        { telefono: this.sesion.telefono, nombre: this.sesion.nombre, mensaje: texto },
        this.sesion,
        (token) => {
          this.sesion.token = token;
          localStorage.setItem('yoyo-sesion', JSON.stringify(this.sesion));
        },
      );

      if (!res.ok) {
        // El backend rechaza ANTES de abrir el stream (ej. cuenta bloqueada
        // por demasiados intentos fallidos desde otro lado, rate limit, o
        // Supabase caído justo en este turno) — no es un error de red
        // genérico, así que se muestra el motivo real en vez de "error
        // conectando con el bot".
        if (sesionExpirada) {
          // El token ya no sirve y el refresco silencioso tampoco resolvió
          // (PIN cambiado en otro lado, cuenta bloqueada, token forjado):
          // forzar a iniciar sesión de nuevo en vez de dejar al cliente
          // escribiendo mensajes que van a seguir rechazándose uno por uno.
          this.salirChat();
          this.errorLogin = mensajeRechazo || 'Tu sesión ya no es válida. Inicia sesión de nuevo.';
        } else if (mensajeRechazo) {
          // 429 (rate limit): no cierra la sesión, solo pide esperar.
          this.agregarBurbuja(mensajeRechazo, 'in');
        } else {
          const datos = await res.json().catch(() => ({}));
          this.agregarBurbuja(datos.error || 'Ocurrió un error procesando tu mensaje.', 'in');
        }
        return;
      }
      if (!res.body) throw new Error('Error en el servidor');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // El backend siempre manda "fin" justo después de "error": sin este
      // guard, el "fin" empujaría una segunda burbuja "(Sin respuesta)"
      // duplicando el mensaje de error que ya se mostró.
      let errorMostrado = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const bloques = buffer.split('\n\n');
        buffer = bloques.pop() || '';

        for (const bloque of bloques) {
          const linea = bloque.split('\n').find(l => l.startsWith('data: '));
          if (!linea) continue;
          
          try {
            const ev = JSON.parse(linea.slice(6));
            
            if (ev.tipo === 'estado') {
              this.estadoBot = ev.valor + '...';
            } else if (ev.tipo === 'token') {
              this.isTyping = false;
              this.textoStreaming += ev.texto;
            } else if (ev.tipo === 'reset') {
              // El backend va a reemplazar todo lo acumulado por el resumen final.
              this.textoStreaming = '';
            } else if (ev.tipo === 'error') {
              this.isTyping = false;
              this.agregarBurbuja(ev.texto || 'Ocurrió un error procesando tu mensaje.', 'in');
              this.textoStreaming = '';
              errorMostrado = true;
            } else if (ev.tipo === 'fin') {
              if (!errorMostrado) {
                const botones = this.detectarBotones(this.textoStreaming);
                this.agregarBurbuja(this.textoStreaming || '(Sin respuesta)', 'in', botones);
              }
              this.textoStreaming = '';
            }
          } catch (e) {}

          // Cada evento SSE llega fuera de la zona de Angular (ver comentario
          // en la declaración de `cdr`) — sin esto, el cambio de estado queda
          // aplicado en memoria pero invisible hasta el próximo repintado.
          this.cdr.markForCheck();
        }
      }
    } catch (err) {
      this.isTyping = false;
      this.agregarBurbuja('Ocurrió un error conectando con el bot.', 'in');
    } finally {
      this.isTyping = false;
      this.bloquearInput = false;
      this.estadoBot = 'en línea';
      this.textoStreaming = '';
      this.cdr.markForCheck();
    }
  }

  // --- HELPERS Y VOZ ---

  clickBotonRapido(boton: any) {
    if (boton.valor) {
      this.enviarMensaje(boton.valor);
    } else {
      this.mensajes.forEach(m => m.botonesRapidos = []);
      if (boton.guia) this.agregarSistema(boton.guia);
    }
  }

  // Mismos 4 patrones deterministas que yoyo_chat.html (el texto de cierre
  // siempre lo genera el backend de forma fija, nunca el LLM — ver
  // yoyo-bot/services/router.ts). Si falta alguno aquí, esa fase de la
  // conversación se queda sin botones de respuesta rápida.
  private detectarBotones(texto: string) {
    const t = (texto || '').trim();
    if (t.endsWith('¿Confirmo tu pedido? Responde "sí" para cerrarlo.')) {
      return [
        { texto: 'Sí, confirmar ✅', valor: 'sí', principal: true },
        { texto: 'No, esperar', valor: null, guia: 'Sin problema, tu pedido no se ha cerrado. Dime qué quieres agregar, quitar o cambiar 😊' },
      ];
    }
    if (t.endsWith('¿Así está bien tu pedido, o quieres agregar/quitar algo?')) {
      return [
        { texto: 'Sí, está bien', valor: 'sí', principal: true },
        { texto: 'No, quiero cambiar algo', valor: null, guia: 'Dime qué quieres agregar, quitar o cambiar 😊' },
      ];
    }
    if (t.endsWith('¿Deseas agregar algo más, o ya es todo tu pedido? 😊')) {
      return [
        { texto: 'Ya es todo', valor: 'ya es todo', principal: true },
        { texto: 'Quiero agregar más', valor: null, guia: 'Dime qué más quieres agregar, quitar o cambiar 🍔' },
      ];
    }
    if (t.endsWith('Responde "sí" para cancelar o "no" para seguir con tu pedido.')) {
      return [
        { texto: 'Sí, cancelar ❌', valor: 'sí', principal: true },
        { texto: 'No, continuar con mi pedido', valor: 'no' },
      ];
    }
    return null;
  }

  private inicializarReconocimientoVoz() {
    const Reconocimiento = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (Reconocimiento) {
      this.reconocedor = new Reconocimiento();
      this.reconocedor.lang = 'es-MX';
      this.reconocedor.interimResults = true;
      // onresult/onerror/onend son callbacks nativos del Web Speech API,
      // asignados por propiedad (no addEventListener) — tampoco los cubre
      // zone.js, mismo motivo que el fetch/ReadableStream de arriba.
      this.reconocedor.onresult = (e: any) => {
        let texto = '';
        for (let i = 0; i < e.results.length; i++) texto += e.results[i][0].transcript;
        this.inputMensaje = texto;
        if (e.results[e.results.length - 1].isFinal) {
          this.toggleVoz();
          this.enviarMensaje();
        }
        this.cdr.markForCheck();
      };
      this.reconocedor.onerror = () => { this.escuchando = false; this.cdr.markForCheck(); };
      this.reconocedor.onend = () => { this.escuchando = false; this.cdr.markForCheck(); };
    }
  }

  toggleVoz() {
    if (!this.reconocedor) return;
    if (this.escuchando) {
      this.reconocedor.stop();
      this.escuchando = false;
    } else {
      this.reconocedor.start();
      this.escuchando = true;
    }
  }

  private bajarScroll() {
    if (this.messagesContainer) {
      this.messagesContainer.nativeElement.scrollTop = this.messagesContainer.nativeElement.scrollHeight;
    }
  }
}