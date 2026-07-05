---
name: frink
description: Interpreta anotaciones hechas con Frink (Freeze + ink), la app que congela pantalla o lámina y dibuja tinta encima. Usar cuando el usuario pega una imagen anotada junto a un archivo .json de Frink, menciona "frink", "anotación frink", "lámina anotada", "mira lo que te he marcado", o comparte archivos con sufijo _frink_FECHA, o dice "frink" a secas (buzón: leer el par más reciente de su carpeta Frink conectada). El JSON acompañante contiene las coordenadas exactas de cada trazo y texto en píxeles de la imagen original — leerlo siempre; es la fuente de verdad geométrica. Tras leerlo, deducir las órdenes, responder las preguntas señaladas y proponer o ejecutar los cambios que las anotaciones piden. Sabe reconstruir la escena 3D de imágenes en perspectiva (puntos de fuga) y usar el conector MCP de Frink (frink_latest, frink_list, frink_annotate + frink_wait) si está disponible.
---

# Frink — leer anotaciones con precisión de píxel

Frink exporta pares de archivos con el mismo nombre base:
- `<nombre>_frink_<fecha>.png` — la imagen con la tinta ya compuesta (contexto visual)
- `<nombre>_frink_<fecha>.json` — las anotaciones como datos (fuente de verdad)

Carpeta por defecto: subcarpeta `Frink` dentro de Imágenes del usuario
(`C:\Users\<usuario>\Pictures\Frink` o equivalente OneDrive).

## Buzón directo (modo preferente)

Si la carpeta Frink del usuario está conectada al proyecto, funciona como BUZÓN:
cuando el usuario diga "frink", "mira la anotación", "te acabo de marcar algo" o
similar SIN adjuntar archivos, ir a la carpeta, tomar el par PNG+JSON **más
reciente** (por fecha en el nombre `_frink_AAAAMMDD_HHMMSS`) y aplicar el
protocolo completo sobre él. Confirmar qué par se ha leído (nombre y hora) en
una línea, por si el usuario esperaba otro. Si la carpeta no está conectada,
sugerir conectarla una vez: elimina el pegado manual para siempre.

## Protocolo

1. **Si llegan PNG + JSON**: lee el JSON primero. La imagen es para ver; el JSON es para actuar.
2. **Si solo llega el PNG** (pegado como imagen) y el nombre contiene `_frink_`: busca el `.json` hermano en la carpeta Frink; si no hay acceso, pídelo.
3. **Si el JSON trae `source_path`**: abre la imagen ORIGINAL (sin tinta) para trabajar sobre datos limpios. Todas las coordenadas se refieren a ella.

## Esquema del JSON

```json
{
  "frink": "0.3",
  "mode": "lamina" | "pantalla",
  "source_image": "lamina_X.png",
  "source_path": "C:\\ruta\\original.png",
  "image_size": [ancho, alto],
  "exported_region_px": {"x":0,"y":0,"w":0,"h":0},
  "annotations": [
    {"type":"pen|marker|poly|spline|erase","color":"#rrggbb","width_px":9,"bbox":[x1,y1,x2,y2],"points":[[x,y],...]},
    {"type":"rect|ellipse","color":"#rrggbb","width_px":9,"fill":false,"bbox":[x1,y1,x2,y2],"center":[x,y],"radii":[rx,ry]},
    {"type":"dimension","p1":[x,y],"p2":[x,y],"length_px":123.45,"length":4.5,"unit":"m","note":"alto puerta"},
    {"type":"order","order":"borra|blur|aclara|oscurece|mas_color|menos_color|cambia_color|reemplaza|manten|pregunta|linea_fuga|horizonte|cine_guia","kind":"area|line","points":[[x,y],...],"text":"...","target_color":"#rrggbb"},
    {"type":"text","text":"...","x":0,"y":0,"color":"#rrggbb","font_px":30}
  ]
}
```

Desde frink 0.6 las coordenadas son FLOAT (sub-píxel) y el root incluye `export_scale`.
Las coordenadas están SIEMPRE en píxeles de la imagen original (`image_size`), no del PNG
recortado. Para mapear al PNG exportado: restar `exported_region_px.x/y` y, si el PNG está
reescalado (modo pantalla exporta a 2x), multiplicar por `png_ancho / exported_region_px.w`.

## Semántica de las anotaciones

- **`text`** — instrucciones u órdenes escritas sobre la zona donde están. Máxima prioridad.
- **`poly`** (puntos rectos) y **`spline`** (curva suave Catmull-Rom por los puntos) —
  geometría deliberada y precisa. Si el usuario corrige un eje, alineación o ruta, los
  `points` SON la geometría propuesta: úsalos como datos de entrada, no como un gesto.
  En `spline` la curva pasa por todos los puntos (interpolación Catmull-Rom estándar).
- **`rect` / `ellipse`** — marco de foco preciso: el bbox delimita exactamente el elemento
  referido (más fiable que un círculo a mano). Si `fill` es true, el usuario está TAPANDO
  esa zona (ocultación deliberada) o marcando un bloque sólido: no intentes leer lo que
  hay debajo.
- **`pen`** (trazo libre) — señalamiento: "mira aquí". Un círculo a lápiz = localiza qué hay
  dentro de su bbox y trátalo como el objeto referido.
- **`marker`** (semitransparente, ancho) — región amplia de interés o contexto.
- **`erase`** — ignorable (correcciones del propio usuario al anotar).
- **Colores** — pueden codificar significado (p. ej. rojo = error, verde = propuesta,
  amarillo = duda). Si hay varios colores y el mensaje no lo aclara, pregunta la convención
  una vez y aplícala al resto de la sesión.

## Cotas (`dimension`): escala real declarada por el usuario

Una cota son dos puntos + una longitud real (`length`+`unit`; `length_px` da el módulo
en píxeles). Úsalas así:

- **Imagen plana** (plano, lámina, ortofoto): una cota fija la escala global
  `px→real = length / length_px`. TODO lo demás queda medible. Con dos o más cotas,
  verifica coherencia: si difieren >2-3%, avisa de distorsión en la imagen.
- **Escena en perspectiva**: cada cota da escala EN SU PLANO Y PROFUNDIDAD, no global.
  Combinadas con los puntos de fuga (ver geometría inversa), permiten dimensionar la
  escena: usa la cota del plano más cercano al objeto consultado, y decláralo.
- La `note` dice qué mide ("alto puerta"): valida contra lo visible (una puerta de
  4 m debería hacerte sospechar del dato o del objeto).

## Órdenes declaradas (`order`): comandos, no interpretación

Una anotación `order` es una ORDEN EXPLÍCITA del usuario elegida de una paleta — no hay
nada que inferir; ejecuta o traduce directamente:

| order | acción |
|---|---|
| borra | eliminar el contenido de la zona y reconstruir el fondo (inpainting/datos) |
| blur | pixelar o desenfocar la zona (privacidad) |
| aclara / oscurece | subir/bajar luminosidad de la zona |
| mas_color / menos_color | subir/bajar saturación de la zona |
| cambia_color | recolorear la zona hacia `target_color` |
| reemplaza | sustituir el contenido por lo que diga `text` |
| manten | MÁSCARA DE PROTECCIÓN: esta zona no se toca; inverso de la máscara de edición |
| pregunta | responder qué es / qué pasa en la zona (`text` puede afinar la pregunta) |
| linea_fuga | la guía trazada define una dirección de fuga: úsala para calcular el punto de fuga |
| horizonte | la guía ES el horizonte de la escena (fija altura de cámara) |
| cine_guia | rectificar/ajustar la geometría cercana a esta guía (enderezar, alinear) |

`kind: "area"` = polígono cerrado (la máscara); `kind: "line"` = guía (polilínea).
Las órdenes conviven con trazos libres: primero ejecuta las órdenes, después interpreta
el resto con el protocolo general.

## Anclaje semántico (obligatorio antes de actuar)

Una anotación son coordenadas; la acción exige saber QUÉ hay debajo. Nunca actúes
sobre un bbox sin haberlo identificado:

1. **Mira la zona**: recorta de la imagen original la región del bbox (con ~15% de
   margen) y examínala visualmente. Nombra el objeto: "un edificio de 4 plantas",
   "la serie naranja del gráfico", "el botón Guardar", "la esquina noreste de la
   parcela". Ese nombre ancla toda la acción posterior.
2. **Ancla en los datos si existen**: con `source_path` o archivos del proyecto
   accesibles, localiza el objeto en los DATOS (la geometría del edificio, el
   elemento del esquema, la capa del plano), no solo en los píxeles. Si la imagen
   tiene sistema de coordenadas conocido (ejes de un plot, georreferencia, escala
   de plano), convierte los píxeles a ese sistema antes de operar.
3. **Contorno = frontera del objeto**: una línea/poly/spline que rodea algo define
   el límite del objeto referido. Si el trazo queda abierto, ciérralo; si es
   aproximado, ajústalo a los bordes visibles del objeto (el trazo humano es la
   intención, el borde real es la geometría).

## Traducción a herramientas (instrucciones efectivas)

La orden del usuario + el anclaje se convierten en instrucciones PRECISAS para la
herramienta que vaya a ejecutar, en su idioma:

- **Edición/generación de imagen (inpainting, Nano Banana, ComfyUI...)**: construye
  la máscara con el polígono de la anotación (cerrado y ajustado al objeto) o el
  bbox exacto, y redacta la instrucción localizada: "elimina el edificio delimitado
  por el polígono [(x1,y1),...] y rellena con el entorno (cielo/vegetación
  circundante)". Da coordenadas en px de la imagen que la herramienta recibe (aplica
  la conversión de exported_region_px si procede).
- **Datos vectoriales / CAD / GIS**: convierte los puntos a las unidades del
  documento (usando ejes, escala o georreferencia) y opera sobre la entidad de
  datos, no sobre el dibujo: "borrar la polilínea con vértices [...] en la capa X".
- **Código / UI**: identifica el elemento bajo el bbox (botón, componente, línea de
  código en una captura) y refiérete a él por su identificador, no por píxeles.
- **Documentos**: localiza el pasaje/celda/figura bajo el bbox y aplica la orden ahí.

Ejemplo canónico: contorno alrededor de un edificio + texto "bórralo" →
(1) mirar el recorte: es el edificio en L junto al río; (2) cerrar el contorno y
ajustarlo a la silueta del edificio; (3) si el destino es un editor de imagen:
máscara con ese polígono + "eliminar edificio, reconstruir fondo"; si es el modelo
3D/plano del proyecto: identificar esa geometría en los datos y eliminarla ahí.
Después, **verifica**: comprueba que el resultado cambió dentro de la zona y solo
dentro de ella; si la herramienta falló, afina la máscara/instrucción y reintenta.

## Geometría inversa (imágenes en perspectiva)

Si la imagen anotada es una escena en perspectiva cónica (foto, render, croquis con
fugas), las anotaciones viven en 2D pero REFIEREN a un espacio 3D. Antes de traducir:

1. **Reconstruye la escena**: detecta las familias de líneas dominantes y sus puntos de
   fuga (las paralelas 3D convergen en un punto 2D); la línea que une las fugas de las
   horizontales es el horizonte y marca la altura de la cámara; 1, 2 o 3 fugas indican
   el tipo de perspectiva. Identifica el plano del suelo y los planos verticales.
2. **Asigna cada anotación a una entidad 3D, no a píxeles**: una línea sobre la arista
   de un edificio ES esa arista (vertical u horizontal en el mundo aunque en la imagen
   aparezca inclinada); un rectángulo sobre una fachada es el PLANO de fachada con su
   fuga; dos objetos del mismo tamaño a distinta profundidad se proyectan con tamaños
   distintos — corrige por profundidad antes de comparar dimensiones.
3. **Usa las pistas de la escena**: oclusiones para el orden de profundidad; elementos
   de dimensión conocida (puertas ≈2,1 m, plantas ≈3 m, personas ≈1,7 m) para escalar;
   sombras para orientación solar.
4. **Traduce en el espacio correcto**: las máscaras de inpainting van en px 2D (la
   proyección del objeto), pero las instrucciones de modelado/CAD van en el espacio 3D
   reconstruido ("prolonga la fachada oeste un vano hacia el fondo", no "alarga el
   trapecio").
5. **Declara la reconstrucción** en una línea ("perspectiva a 2 fugas, horizonte a
   ≈1,6 m, fachada principal fugando a la derecha") para que el usuario pueda corregirla.

## Conector MCP de Frink (si está conectado)

Si existen las herramientas `frink_latest`, `frink_list`, `frink_annotate` y `frink_wait`:

- `frink_latest` / `frink_list` sustituyen al buzón y al pegado: consulta directa de los
  pares PNG+JSON (la respuesta incluye rutas y el JSON completo; lee el PNG desde su ruta
  si necesitas verlo).
- `frink_annotate(image_path, prompt)` abre Frink en la pantalla del usuario con esa
  imagen y tu mensaje, y RESPONDE AL INSTANTE. El resultado se recoge con `frink_wait`
  (espera ~45 s por llamada): si devuelve "pendiente", vuelve a llamarla — el usuario
  sigue dibujando; insiste unas cuantas veces antes de rendirte, sin agobiar. Úsala
  proactivamente cuando necesites que el usuario señale, corrija, delimite o elija sobre
  una imagen: una anotación es más precisa que cualquier descripción verbal. El usuario
  puede cancelar con Esc — respétalo y no insistas de inmediato. Requiere que la app
  Frink esté abierta.

## De anotación a acción (obligatorio)

Leer las anotaciones no es el final: hay que convertirlas en órdenes, interpretaciones
o propuestas. Protocolo:

**1. Agrupar.** Asocia anotaciones que van juntas: un `text` cuyo ancla (x,y) cae dentro
o cerca (~1.5× su font_px) del bbox de otra forma, califica a esa forma. Un trazo que une
un texto con una zona actúa de flecha: el texto se aplica a la zona apuntada (el extremo
del trazo más alejado del texto). Mismo color en varias anotaciones = misma intención.

**2. Clasificar la intención de cada grupo:**
- Texto imperativo ("quita", "mueve", "más grande", "aquí no") → **orden**: hay que ejecutarla.
- Texto interrogativo ("¿esto qué es?", "¿por qué…?") → **pregunta**: hay que responderla
  sobre el contenido señalado.
- Texto nominal ("fachada norte", "v2") → **etiqueta**: contexto, no acción.
- Forma sin texto (círculo, subrayado, marker) → **foco**: identifica QUÉ hay dentro del
  bbox (botón, párrafo, elemento del esquema, zona de la imagen) y deduce del contexto de
  la conversación qué se espera: si el usuario pidió "corrige", eso es lo que se corrige;
  si no dijo nada, descríbelo y propón.
- `poly` → **geometría propuesta**: datos de entrada, no gesto.

**3. Producir un plan.** Responde SIEMPRE con: (a) qué se ha entendido de cada grupo, en
una línea cada uno; (b) los cambios concretos propuestos en consecuencia — sobre el
archivo, código, prompt o dato real, no sobre el dibujo.

**4. Ejecutar según el modo configurado.** El usuario puede fijar el modo de ejecución
en la conversación (o en sus preferencias/memoria):
- **Modo directo** ("avanza sin preguntar"): ejecuta los cambios deducidos inmediatamente
  y presenta el resultado. No pedir permiso para lo que ya se ordenó en la lámina.
- **Modo consulta** ("pregunta antes de actuar"): presenta el plan y espera confirmación
  ANTES de tocar nada, siempre.
- **Sin modo fijado**: presenta el plan y pregunta una única vez: "¿aplico? (puedo quedarme
  en modo directo o consulta para el resto)" — y recuerda la elección para la sesión.

**5. Ambigüedad.** Si una anotación admite dos lecturas y cambian el resultado, elige la
más probable, decláralo ("interpreto el círculo rojo como X") y sigue; pregunta solo si
el coste de equivocarse es alto. En modo consulta, inclúyelo como pregunta del plan.

## Ejemplos de flujo

**Iteración de imágenes generadas (Nano Banana, Midjourney, ComfyUI, etc.)**
El usuario anota una imagen generada: rotulador sobre una zona + texto "más luz aquí",
un pen rodeando un objeto + "quitar esto".
→ Cada anotación se convierte en una instrucción localizada: usa los bbox para describir
la zona en el prompt de edición/inpainting o para construir la máscara de la región.

**Imágenes y esquemas de arquitectura**
El usuario anota un plano, alzado o render: poly siguiendo una alineación propuesta,
textos con cotas o correcciones ("este hueco 20 cm más ancho").
→ El poly son coordenadas de la geometría propuesta; los textos son órdenes localizadas.
Traduce a las unidades del documento si hay escala o referencia conocida.

**Cualquier esquema o diagrama**
Anotaciones sobre un diagrama de flujo, un mapa, una captura de UI o un gráfico.
→ Identifica qué elemento cae bajo cada bbox y aplica la instrucción a ese elemento
(renombrar el nodo, mover la caja, corregir el dato de la serie señalada).
