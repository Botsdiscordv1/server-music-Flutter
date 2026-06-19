# Canvas Export

Genera un snapshot JSON listo para el cliente con el manifest del catalogo Canvas.

## Uso

```bash
npm run canvas:export
```

Opcionalmente define salida y root:

```bash
npm run canvas:export -- --out canvas-export.json --root E:\Proyectos\Videos-canvas
```

## Salida

Por defecto escribe un archivo como:

```json
{
  "exportedAt": "2026-06-16T12:30:00Z",
  "root": "E:\\Proyectos\\Videos-canvas",
  "count": 1,
  "items": [
    {
      "canonicalId": "isrc/USRC17607839",
      "title": "Modelito",
      "artist": "Mora",
      "urls": {
        "self": "http://localhost:3000/api/canvas/isrc%2FUSRC17607839",
        "manifest": "http://localhost:3000/api/canvas/manifest",
        "canvas": "http://localhost:3000/api/canvas/isrc%2FUSRC17607839/file/canvas",
        "thumbnail": "http://localhost:3000/api/canvas/isrc%2FUSRC17607839/file/thumbnail",
        "meta": "http://localhost:3000/api/canvas/isrc%2FUSRC17607839/file/meta"
      }
    }
  ]
}
```

## Variables útiles

- `CANVAS_BASE_URL`: base usada para construir URLs absolutas.
