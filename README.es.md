# Frink

🇬🇧 [English version](README.md)

**Autor: Luis Berián «lberian»** · © 2026 · Licencia [GPL-3.0](LICENSE)

> **Frink** = **Fr**eeze + **ink**: congela lo que ves y dibuja tinta encima.
> El nombre es el modelo de uso: *congelar-luego-anotar*.

## Por qué Frink

Quien firma esto es **arquitecto — de edificios — sin conocimientos de programación**.
Vivimos un momento importante para los creativos, ha cambiado el paradigma: en seis
meses he pasado de guardar mis ideas en una libreta a desarrollar proyectos impensables
para mí hace seis meses. Ahora construyo herramientas propias para una interacción más
fluida. Frink es a la vez producto y prueba de ese cambio: una herramienta hecha
*conversando* con la IA para comunicarse mejor *con* la IA.

Las herramientas de captura llevan quince años diseñadas para enseñar cosas: por eso
todas terminan en un bitmap. Frink nace para enseñarle cosas a una **máquina que
entiende**: cada anotación se exporta también como **datos** — un JSON con las
coordenadas exactas de cada trazo, texto, cota y orden. La IA no interpreta tu
garabato: lo *lee*.

Y funciona igual de bien para lo humano: anotaciones rápidas en reuniones online
mientras alguien comparte pantalla.

## Uso

1. **Ctrl+↑** — congela la pantalla donde esté el ratón (modo pantalla).
2. **Ctrl+↓** — modo lámina: se abre una ventana pequeña y manejable; suéltale un
   archivo de imagen y se expande para anotarlo a resolución completa.
3. **Dibuja**: lápiz, rotulador, puntos rectos, spline, rectángulo, elipse (con o sin
   relleno), texto, goma, **cota** (dos puntos + distancia real = escala) y la paleta ⚡
   de **órdenes** (BORRA ESTO, PIXELA, ACLARA, MANTÉN ESTO, LÍNEA DE FUGA…).
4. **Enter** — exporta. Modo pantalla: la imagen al portapapeles. Modo lámina: **los dos
   archivos (PNG + JSON) al portapapeles** — un solo Ctrl+V en tu chat de IA adjunta
   imagen y datos a la vez.

`Esc` cancela · `Ctrl+Z` deshace · rueda = zoom · espacio = mover (modo lámina) ·
atajos 1-9 para herramientas · el icono de la bandeja permite elegir la carpeta de
destino y salir.

## Qué exporta

Pares con el mismo nombre en tu carpeta de destino (por defecto `Imágenes\Frink`):

- `<nombre>_frink_<fecha>.png` — la imagen anotada
- `<nombre>_frink_<fecha>.json` — las anotaciones como datos: coordenadas float
  sub-píxel de cada trazo, textos como texto, cotas con su longitud real, órdenes como
  comandos declarados, y la ruta de la imagen original

## La skill (para Claude)

En [`skill/`](skill/) está la **skill de Frink**: enseña a Claude a leer el JSON como
fuente de verdad geométrica, anclar cada anotación a lo que hay debajo, convertir
cotas en escala real (plana o por planos en perspectiva), reconstruir escenas 3D desde
los puntos de fuga, y traducir las órdenes a herramientas concretas (máscaras de
inpainting, datos CAD/GIS, elementos de UI). Se instala importando `skill/frink.skill`
en Claude (Ajustes → Capacidades).

## El conector MCP

Frink incluye un **conector MCP** (`frink_mcp.exe`, compilado junto a la app) que da a
la IA tres poderes:

- `frink_latest` / `frink_list` — leer tus anotaciones directamente, sin pegar nada.
- `frink_annotate(imagen, mensaje)` — **la IA te pide una anotación**: Frink se abre en
  tu pantalla con la imagen y su pregunta en un banner; marcas, pulsas Enter, y le
  llega el par con coordenadas exactas (`frink_wait` recoge el resultado). El canal
  deja de ser de un solo sentido.

Registro en Claude Desktop (`claude_desktop_config.json`, y reiniciar Claude):

```json
"mcpServers": {
  "frink": { "command": "C:\\ruta\\a\\frink_mcp.exe" }
}
```

Todo es 100 % local: el conector habla con la app por `127.0.0.1` y nada sale de tu
equipo salvo lo que tú pegues o la IA te pida.

## Instalación

Descarga `frink.exe` y `frink_mcp.exe` de [Releases](../../releases). Sin instalación,
portátiles (Windows 10/11). Windows SmartScreen avisará por ser un binario sin firmar:
"Más información → Ejecutar de todas formas".

### Compilar desde el código

[Rust](https://rustup.rs) + `cargo install tauri-cli --version "^2"`, y desde
`src-tauri/`:

```bash
cargo tauri build --no-bundle   # genera target/release/frink.exe y frink_mcp.exe
```

Sin Node ni npm: el frontend son 3 archivos estáticos con el Tauri global.

## Estructura

```
frink/
├─ src/                      # frontend estático (sin bundler)
│  ├─ index.html
│  ├─ main.js                # herramientas, vista, exportación PNG+JSON
│  └─ style.css
├─ src-tauri/
│  ├─ src/main.rs            # captura, lámina, bandeja, API local del conector
│  ├─ src/bin/frink_mcp.rs   # conector MCP (stdio) para Claude
│  ├─ Cargo.toml · tauri.conf.json · capabilities/ · icons/
└─ skill/                    # skill de Frink para Claude (SKILL.md + frink.skill)
```

## Hoja de ruta

Hecho: dos modos · 9 herramientas + cotas + órdenes · zoom/mano · sub-píxel · multi-
monitor · bandeja · carpeta configurable · "Abrir con Frink" · buzón · conector MCP
bidireccional · skill.

Ideas: pixelado/desenfoque local (privacidad antes de compartir) · parche de
brillo/contraste · clonar fondo · índice histórico · IDs estables anotación→entidad.

---

Licencia GPL-3.0 · para licencias comerciales, contactar con el autor.
