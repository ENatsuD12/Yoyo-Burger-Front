import { Component, ElementRef, ViewChild, AfterViewChecked, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

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

  // Estado de sesión
  isLogin = true;
  sesion = { nombre: '', telefono: '' };
  errorLogin = '';
  
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

  // URL del backend (Ajusta esto a tu servidor real)
  readonly URL_STREAM = 'https://tu-backend-api.com/chat/stream'; 
  readonly MAX_TEXTO = 250;

  ngOnInit() {
    this.inicializarReconocimientoVoz();
    this.restaurarSesion();
  }

  ngAfterViewChecked() {
    this.bajarScroll();
  }

  // --- CONTROL DE SESIÓN ---

  entrarChat() {
    const tel = this.sesion.telefono.replace(/\D+/g, '');
    
    if (!this.sesion.nombre || !/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'-]+$/.test(this.sesion.nombre)) {
      this.errorLogin = 'El nombre es inválido.'; return;
    }
    if (!/^\d{10}$/.test(tel) || tel[0] === '0' || /^(\d)\1{9}$/.test(tel)) {
      this.errorLogin = 'Teléfono inválido. Debe ser de 10 dígitos y válido.'; return;
    }

    this.sesion.telefono = tel;
    localStorage.setItem('yoyo-sesion', JSON.stringify(this.sesion));
    this.cargarHistorial();
    this.isLogin = false;
  }

  salirChat() {
    localStorage.removeItem('yoyo-sesion');
    this.isLogin = true;
    this.mensajes = [];
    this.sesion = { nombre: '', telefono: '' };
  }

  private restaurarSesion() {
    const raw = localStorage.getItem('yoyo-sesion');
    if (raw) {
      this.sesion = JSON.parse(raw);
      this.cargarHistorial();
      this.isLogin = false;
    }
  }

  // --- HISTORIAL Y MENSAJES ---

  private cargarHistorial() {
    const raw = localStorage.getItem(`yoyo-msgs-${this.sesion.telefono}`);
    if (raw) {
      this.mensajes = JSON.parse(raw);
    } else {
      this.agregarSistema(`Chat de ${this.sesion.nombre} · ${this.sesion.telefono}`);
      this.agregarBurbuja(`¡Hola, ${this.sesion.nombre}! 🍔 Soy el asistente de Yoyo Burger. Dime qué se te antoja.`, 'in');
    }
  }

  private guardarHistorial() {
    if (this.mensajes.length > 100) this.mensajes = this.mensajes.slice(-100);
    localStorage.setItem(`yoyo-msgs-${this.sesion.telefono}`, JSON.stringify(this.mensajes));
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
      const res = await fetch(this.URL_STREAM, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefono: this.sesion.telefono, nombre: this.sesion.nombre, mensaje: texto }),
      });

      if (!res.ok || !res.body) throw new Error('Error en el servidor');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

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
            } else if (ev.tipo === 'fin') {
              const botones = this.detectarBotones(this.textoStreaming);
              this.agregarBurbuja(this.textoStreaming || '(Sin respuesta)', 'in', botones);
              this.textoStreaming = '';
            }
          } catch (e) {}
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

  private detectarBotones(texto: string) {
    const t = texto.trim();
    if (t.endsWith('¿Confirmo tu pedido? Responde "sí" para cerrarlo.')) {
      return [{ texto: 'Sí, confirmar ✅', valor: 'sí', principal: true }, { texto: 'No, esperar', valor: null, guia: 'Dime qué quieres cambiar 😊' }];
    }
    return null; 
  }

  private inicializarReconocimientoVoz() {
    const Reconocimiento = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (Reconocimiento) {
      this.reconocedor = new Reconocimiento();
      this.reconocedor.lang = 'es-MX';
      this.reconocedor.interimResults = true;
      this.reconocedor.onresult = (e: any) => {
        let texto = '';
        for (let i = 0; i < e.results.length; i++) texto += e.results[i][0].transcript;
        this.inputMensaje = texto;
        if (e.results[e.results.length - 1].isFinal) {
          this.toggleVoz();
          this.enviarMensaje();
        }
      };
      this.reconocedor.onerror = () => this.escuchando = false;
      this.reconocedor.onend = () => this.escuchando = false;
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