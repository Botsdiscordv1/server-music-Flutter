# Historial de Cambios — Sincronización YouTube Music

## 1. Inyección de Cookies en InnerTube

**Archivo:** `src/services/innertube.js`

### 1.1 Cookies globales del servidor

El servidor lee `cookies.txt` (o `YOUTUBE_COOKIES` env var) al iniciar y las inyecta en
todas las peticiones a la API de YouTube.

```
server.js:60  →  innertube.setCookies(cookieStr)
                       ↓
           userCookieString = cookieString
                       ↓
           buildHeaders() → Cookie: visitorCookies + userCookieString
                       ↓
           apiRequest() → axios.post() con cookies autenticadas
```

### 1.2 Cookies por usuario (SAPISID)

Cada usuario puede conectar su cuenta YT Music desde la app. El backend las recibe
por request y las almacena en un mapa por `userId`.

```
Flutter interceptor → X-Ytm-Sapisid + Cookie + X-YTM-Active
       ↓
server.js middleware (línea 447) → innertube.setCookies(cookieStr, userId)
       ↓
userCookiesMap.set(userId, cookieStr) + invalida caché del home
       ↓
resolveCookieString(userId) → busca en userCookiesMap → cae a userCookieString
```

**Funciones nuevas:**
- `setCookies(cookieString, userId)` — sin `userId` fija global, con `userId` fija por usuario
- `removeCookies(userId)` — limpia cookies de un usuario y su caché
- `resolveCookieString(userId)` — resuelve qué cookies usar según el userId

### 1.3 Caché del Home Feed

```javascript
const homeFeedCache = new Map();
const HOME_FEED_CACHE_TTL = 5 * 60 * 1000; // 5 minutos
```

- Cachea la respuesta de `getHomeFeed()` por usuario
- Se invalida automáticamente cuando cambian las cookies del usuario
- `clearHomeFeedCache(userId)` — invalida por usuario o global

---

## 2. Propagación de userId en toda la cadena

### 2.1 recommendationService.js

Antes: `innertube.getHomeFeed()` sin userId.  
Después: todas las llamadas a InnerTube reciben `userId`:

| Llamada | Antes | Después |
|---------|-------|---------|
| `getHomeFeed()` | `innertube.getHomeFeed()` | `innertube.getHomeFeed(userId)` |
| `getCharts()` | `innertube.getCharts()` | `innertube.getCharts(userId)` |
| `searchQuery()` | `innertube.searchQuery(q, type)` | `innertube.searchQuery(q, type, userId)` |
| `getRadioQueue()` | `innertube.getRadioQueue(vid)` | `innertube.getRadioQueue(vid, userId)` |

### 2.2 sectionBuilder.js

Antes: llamadas a innertube sin userId + `getRecommendations("guest", ...)`.  
Después: todas las llamadas pasan `userId`.

### 2.3 radioService.js

Todas las llamadas a `innertube.getRadioQueue()` ahora pasan `userId`.

### 2.4 homeAggregatorService.js

Antes: `getRecommendations("guest", source)` en ambas rutas (cold start y
personalized).  
Después: `getRecommendations(userId, source)`.

---

## 3. Corrección del Parseo de la Respuesta de YouTube

**Archivos:** `src/services/innertube.js`, `src/services/recommendationService.js`

YouTube devuelve los shelves del Home dentro de un wrapper renderer:

```
❌ data.contents.singleColumnBrowseResults.tabs[0]...
✅ data.contents.singleColumnBrowseResultsRenderer.tabs[0]...
```

Corregido en 5 ocurrencias (3 en `innertube.js`, 2 en `recommendationService.js`).

---

## 4. Bug Crítico: Formato de Respuesta del Home

**Archivo:** `src/api/server.js` — Rutas `GET /api/home/sections` y `POST /api/home`

### El problema

```javascript
// getHomeSections() devuelve { sessionId, sections: [...] }
async function getHomeSections(userId) {
  return { sessionId, sections: [...] };
}

// La ruta hacía esto:
const sections = await homeAggregatorService.getHomeSections(userId, source);
res.json({ sections });
// ↑ sections NO es el array, es { sessionId, sections: [...] }
// Resultado: { sections: { sessionId, sections: [...] } }
// Flutter esperaba: { sections: [...] }
```

La Flutter app recibía `data['sections']` = el objeto con `sessionId`, no el array.
Al hacer `.map()` sobre un objeto no iterable, lanzaba excepción → `catch` → `[]`
→ fallback "trending".

### La solución

```javascript
const result = await homeAggregatorService.getHomeSections(userId, source);
res.json({ sections: result?.sections || [] });
```

---

## 5. getLibraryPlaylists

**Archivo:** `src/services/innertube.js`

Nueva función que obtiene las playlists de la biblioteca de YT Music del usuario:

```javascript
async function getLibraryPlaylists(userId)
// Llama a: browse?browseId=FEmusic_library_playlists
// Devuelve: [{ id, title, subtitle, artworkUrl, type: "playlist" }]
```

---

## 6. isYtConnected() en Flutter

**Archivo:** `Auris_flutter/lib/data/repositories/user_repository.dart`

Antes: hardcodeado a `true` siempre.  
Después: verifica si hay un SAPISID guardado en SessionStorage:

```dart
Future<bool> isYtConnected() async {
  final sapisid = await _sessionStorage.getYtmSapisid();
  return sapisid != null && sapisid.isNotEmpty;
}
```

---

## Resumen de Archivos Modificados

| Archivo | Cambios |
|---------|---------|
| `src/services/innertube.js` | `setCookies(userId)`, per-user cookie map, `buildHeaders(cookieString)`, `getHomeFeed(userId)`, `getLibraryPlaylists(userId)`, caché home feed, fix `singleColumnBrowseResultsRenderer` |
| `src/services/recommendationService.js` | userId en todas las llamadas a innertube, fix `singleColumnBrowseResultsRenderer` |
| `src/services/sectionBuilder.js` | userId en llamadas a innertube y getRecommendations |
| `src/services/radioService.js` | userId en getRadioQueue |
| `src/services/homeAggregatorService.js` | userId real en lugar de "guest" en getRecommendations |
| `src/api/server.js` | Middleware YTM cookies, fix `{ sections: result.sections }` en rutas home |
| `Auris_flutter/.../user_repository.dart` | `isYtConnected()` real |

---

## Flujo final

```
1. Usuario abre la app
2. GET /api/home/sections?userId=X
3. Server: userContextService.buildUserContext(userId)
   → detecta modo (cold_start / active_user)
4. Server: recommendationService.getRecommendations(userId)
   → innertube.getHomeFeed(userId)
      → apiRequest("browse", { browseId: "FEmusic_home" }, {}, userId)
         → buildHeaders(resolveCookieString(userId))
            → Cookie: visitor + userAuthCookies (globales o por usuario)
         → YouTube responde con feed PERSONALIZADO
5. Server parsea shelves → secciones con items
6. homeAggregatorService arma respuesta final
7. res.json({ sections: result.sections })  ← formato correcto
8. Flutter recibe HomeSectionDto[] → renderiza secciones
```
