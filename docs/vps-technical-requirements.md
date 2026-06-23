# Technical Requirements — Backend VPS

## Objetivo
Latencia < 2s y alineación con estrategia "Frontend First" (estilo OpenTune).

## 1. Nueva Cadena de Resolución
- Flutter extrae URL de stream e info de álbumes/playlists **localmente** vía InnerTube.
- Backend actúa como **fallback secundario** solo si extracción local falla (HTTP 403/404 persistente).

## 2. Optimización de Clientes InnerTube
| Caso | Cliente | ID | Notas |
|---|---|---|---|
| Audio | `ANDROID_VR` | 52 | Más rápido, omite descifrado (throttling 50kbps) |
| Metadatos Rápidos | `ANDROID_MUSIC` | 21 | JSONs ligeros |
| Listas Completas | `WEB_REMIX` | 67 | Único fiable para IDs tipo `OLAK...` |

## 3. Lógica de Atajo (Short-circuit)
- IDs `OLAK...` o `RDCLAK...` → saltar directo a **WEB_REMIX**, evitar clientes móviles.
- No hacer retries secuenciales: lanzar fallbacks en **paralelo**.

## 4. Enriquecimiento de Respuesta (Metadata Grouping)
- Al devolver tracks de playlist/radio, incluir objeto `header` con `artworkUrl` real del grupo.
- Album endpoint incluye `header` con title, artist, artworkUrl, year, trackCount.

## 5. Eliminación de yt-dlp en Caliente
- No lanzar yt-dlp como precarga (consume CPU/ancho de banda).
- yt-dlp solo como fallback final tras play-dl y Cobalt.

## 6. Signature Timestamp
- Extraído de YouTube Music (antes YouTube.com).
- Cache reducido a 1h (antes 6h) para timestamps más frescos.

---

## Implementación

### `src/services/innertube.js`
- `PLAYER_STREAM_CLIENTS`: ANDROID_VR primero para audio
- `endpointClientMap.player`: ANDROID_VR como default
- `getPlayer()`: fallbacks en paralelo vía `Promise.allSettled`
- `getPlaylistTracks()`: ahora retorna `{ tracks, header }`
- `extractPlaylistHeader()`: extrae título, artworkUrl, artista del header
- `getSignatureTimestamp()`: extrae de YTM, cache 1h
- Fallback 500 ANDROID_VR → ANDROID_MUSIC (antes WEB_REMIX)

### `src/api/server.js`
- `getPlaylistTracks` caller actualizado para `{ tracks, header }`
- Playlist endpoint incluye `header` en respuesta
- Radio endpoint incluye `header` en respuesta
- `buildAlbumPayload()` incluye `header` en respuesta
- `doResolveStreamUrl()`: orden cambiado a InnerTube → play-dl → Cobalt → yt-dlp
- Search browseId: OLAK y RDCLAK explícitamente reconocidos
