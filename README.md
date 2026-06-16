# 🎵 Android Music Backend 2.0

Backend API para Android Music App. Búsqueda y streaming de música con InnerTube cliente propio.

## Stack
- **Express** — API REST
- **InnerTube cliente propio** — búsqueda y streaming directo desde YouTube (sin cookies, sin 403)
- **Lavalink** — fallback de búsqueda y resolución de streams
- **yt-dlp / play-dl / Invidious** — fallback de streaming
- **MongoDB** — likes, playlists, historial, metadata
- **LRCLib** — letras sincronizadas (sin API key)
- **Deezer API** — imágenes de artista, ISRC
- **Spotify Web API** — metadatos (caído, Deezer como respaldo)

## Endpoints principales

| Endpoint | Descripción | Tiempo |
|---|---|---|
| `GET /api/search` | Búsqueda musical (InnerTube → Lavalink) | ~1s |
| `GET /api/stream` | Resolver URL de audio (InnerTube → yt-dlp → Invidious) | ~1s |
| `GET /api/lyrics` | Letras sincronizadas (BetterLyrics / LRCLib / Genius) | ~1s |
| `GET /api/search/suggestions` | Autocomplete | <500ms |
| `GET /api/artist/info` | Info de artista (Deezer + Wikipedia) | ~2s |
| `POST /api/metadata/enrich` | Enriquecer metadatos de tracks | ~3s |
| `GET/POST/DELETE /api/likes/:userId` | Likes del usuario | ~50ms |
| `GET/POST/DELETE /api/playlists/:userId` | Playlists | ~50ms |

Ver `API_ENDPOINTS.txt` para documentación detallada.

## Flujo de streaming

```
1. InnerTube /player  → URL directa del CDN (itag 251 Opus)
2. yt-dlp             → fallback si InnerTube falla
3. play-dl            → fallback (solo local, no Render)
4. Invidious          → fallback final (iv.melmac.space)
5. Cliente Android    → InnertubeClient local como último recurso
```

## Protecciones

- **Rate limiter**: 10 search/s, 3 player/s a InnerTube
- **Cache**: player por 6h, search por 60s, suggestions por 60s
- **Refresh**: config de InnerTube cada 30min
- **Geo-blocking**: detectado y reportado como 403 `{ blocked: true }`

### InnerTube client

Fijado por defecto a `INNERTUBE_CLIENT=ANDROID_VR` para probar el arranque más rápido.

## Setup

```bash
npm install
cp .env.example .env
# Editar .env con credenciales

# Iniciar servidor
npm run dev
```

Requiere Lavalink corriendo en `localhost:2333` (o configurar en .env).
