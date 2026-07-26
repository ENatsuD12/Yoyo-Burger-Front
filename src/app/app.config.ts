import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Sin esto la app corre "zoneless": las actualizaciones de estado que
    // llegan desde el stream SSE (fetch + ReadableStream) o el reconocimiento
    // de voz nunca disparan un repintado, porque ocurren fuera de cualquier
    // evento que Angular esté vigilando. El mensaje del bot solo aparecía al
    // recargar la página.
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes)
  ]
};
