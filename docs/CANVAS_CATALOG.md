# Canvas Catalog

Portable on-disk catalog for Spotify-style canvases.

## Root

Set `CANVAS_LIBRARY_DIR` to the catalog root. On Windows, the service defaults to `E:\Proyectos\Videos-canvas` if the env var is not set.

Recommended:

```text
E:\Proyectos\Videos-canvas\
```

## Layout

```text
<root>\
  manifest.json
  library\
    youtube\
      ready\
        milo-j\
          album\
            rara-vez-2-09\
              veekievq39m\
                Rara_Vez_Milo_J.mp4
                thumb.jpg
                meta.json
      pending\
        milo-j\
          album\
            rara-vez-2-09\
              veekievq39m\
                Rara_Vez_Milo_J.mp4
    isrc\
      ready\
        USRC17607839\
          canvas.mp4
          thumb.jpg
          meta.json
    spotify\
      ready\
        3n3Ppam7vgaVa1iaRUc9Lp\
          canvas.mp4
          thumb.jpg
          meta.json
    hash\
      ready\
        8f3a2c1d9e\
          canvas.mp4
          thumb.jpg
          meta.json
``` 

`pending` guarda las carpetas nuevas hasta que aparece el `.mp4`. El backend las promueve a `ready` y solo publica `ready` en el catálogo.
El backend usa watcher en tiempo real sobre `library/` y re-sincroniza al detectar cambios.

## Canonical ID

Priority:

1. `isrc/<ISRC>`
2. `spotify/<spotifyTrackId>`
3. `youtube/<ytVideoId>`
4. `hash/<sha1>`

## `meta.json`

```json
{
  "canonicalId": "isrc/USRC17607839",
  "ids": {
    "isrc": "USRC17607839",
    "spotifyTrackId": "3n3Ppam7vgaVa1iaRUc9Lp",
    "ytVideoId": "O1PkZaFy61Y"
  },
  "title": "Modelito",
  "artist": "Mora",
  "album": "Estrella",
  "durationMs": 167000,
  "source": "spotify-private",
  "sourceUrl": "https://...",
  "canvasUrl": "https://...",
  "thumbnailUrl": "https://...",
  "file": "canvas.mp4",
  "thumbnail": "thumb.jpg",
  "status": "ready",
  "confidence": 0.98,
  "sha256": "...",
  "createdAt": "2026-06-16T12:30:00Z",
  "updatedAt": "2026-06-16T12:30:00Z"
}
```

## `manifest.json`

```json
{
  "version": 1,
  "updatedAt": "2026-06-16T12:30:00Z",
  "items": [
      {
        "canonicalId": "isrc/USRC17607839",
        "title": "Modelito",
        "artist": "Mora",
        "path": "library/isrc/ready/USRC17607839/canvas.mp4",
        "thumbnailPath": "library/isrc/ready/USRC17607839/thumb.jpg",
        "metaPath": "library/isrc/ready/USRC17607839/meta.json"
      }
  ]
}
```

## API

- `GET /api/canvas/manifest`
- `GET /api/canvas/resolve?...`
- `GET /api/canvas/:canonicalId`
- `GET /api/canvas/:canonicalId/file/canvas`
- `GET /api/canvas/:canonicalId/file/thumbnail`
- `GET /api/canvas/:canonicalId/file/meta`
- `POST /api/canvas/register`
- `POST /api/canvas/sync`

Si no existe `canvas.mp4` local, el endpoint `file/canvas` redirige a `canvasUrl` cuando está presente. Lo mismo aplica a `thumbnail` con `thumbnailUrl`.
