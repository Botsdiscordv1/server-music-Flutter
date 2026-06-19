# Canvas Ingestor

Script Node para poblar el catalogo Canvas con archivos reales y `meta.json`.

## Uso

```bash
npm run canvas:ingest -- --input tracks.json
```

Opcionalmente puedes fijar otro root:

```bash
npm run canvas:ingest -- --input tracks.json --root E:\Proyectos\Videos-canvas
```

## Formato de entrada

El archivo puede ser un array o un objeto con `items`:

```json
{
  "items": [
    {
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
      "status": "ready",
      "confidence": 0.98
    }
  ]
}
```

## Campos soportados

- `ids.isrc`, `ids.spotifyTrackId`, `ids.ytVideoId`, `ids.hash`
- `title`, `artist`, `album`, `durationMs`
- `source`, `sourceUrl`, `canvasUrl`, `thumbnailUrl`
- `canvasPath`, `videoPath`, `filePath`, `localCanvas`
- `thumbnailPath`, `thumbPath`, `localThumbnail`
- `file`, `thumbnail`, `status`, `confidence`

## Resultado

El script:

1. descarga o copia `canvas.mp4`
2. descarga o copia `thumb.jpg` si existe fuente
3. escribe `meta.json`
4. actualiza `manifest.json`

La ruta final sigue la misma estructura del catalogo.
