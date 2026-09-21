# PDF Editor Pro

Editor de PDFs 100% en el navegador (sin backend, sin subir tus archivos a ningún servidor). Corre entero en tu navegador usando [pdf.js](https://mozilla.github.io/pdf.js/) y [pdf-lib](https://pdf-lib.js.org/).

## Funciones

- **Subir varios PDFs** (botón o arrastrar y soltar) — todas las páginas se combinan en un único documento de trabajo.
- **Reordenar páginas** arrastrando las miniaturas.
- **Eliminar páginas** individuales.
- **Unir PDFs** simplemente subiendo varios archivos: se fusionan en el mismo lienzo de páginas.
- **Escribir texto** en cualquier punto de la página, con color y tamaño.
- **Dibujar** a mano alzada con distintos colores y grosores.
- **Resaltar de forma totalmente libre** (no detecta texto, es un trazo libre) en varios colores.
- **Resaltado recto asistido**: con la herramienta de resaltador, haz clic y mantén pulsado el botón del ratón, y sin soltarlo pulsa **Ctrl + flecha** (←, →, ↑, ↓). Mientras mantengas el clic y la combinación, el trazo avanzará recto y a ritmo constante en esa dirección.
- **Exportar** el resultado final como un nuevo PDF descargable, con las páginas y anotaciones ya "horneadas" en el documento.

## Uso local

No requiere build ni instalación: es HTML/CSS/JS estático.

```
python3 -m http.server 8000
```

y abre `http://localhost:8000`.

## Despliegue

Publicado con GitHub Pages directamente desde la rama `main`.
