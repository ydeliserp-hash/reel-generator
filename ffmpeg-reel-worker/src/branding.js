/**
 * Constantes de marca y helpers de color para el reel generator.
 *
 * Modulo puro: no hace I/O ni invoca a FFmpeg. Sirve como fuente unica
 * de verdad para tipografias, paleta y posiciones. Los valores aqui
 * deben coincidir con los reels existentes de @draydeliserodriguez.
 */

export const BRAND = {
  colors: {
    bg_dark: '#0A1F3D',          // navy fondo principal y outline subtitulos
    bg_mid: '#1B4F8C',           // navy medio para degradado radial
    accent_gold: '#F1C40F',      // dorado para badge de titulo
    accent_teal: '#14B8A6',      // turquesa para acentos secundarios
    text_primary: '#FFFFFF',     // blanco para texto y firma
    text_outline: '#0A1F3D',     // outline navy de subtitulos
  },
  fonts: {
    // Nombres tal y como los registra fontconfig dentro del contenedor
    // (ver Dockerfile + assets/fonts/*.ttf instalados en /usr/share/fonts).
    subtitle: 'Montserrat Black',
    title: 'Montserrat Bold',
    signature: 'Montserrat Bold',
    // Rutas de los .ttf, usadas por el filtro `drawtext` que requiere
    // fontfile=. Se consume desde compose.js parametrizado con FONT_DIR.
    file_subtitle: 'Montserrat-Black.ttf',
    file_title: 'Montserrat-Bold.ttf',
    file_signature: 'Montserrat-Bold.ttf',
  },
  // Posiciones expresadas como fraccion del eje vertical (1350 px de alto en 4:5).
  // Calibradas para formato 1080x1350 (Instagram feed portrait).
  positions: {
    subtitle_y_pct: 0.085,       // ~115 px desde arriba (margen V del subtitulo)
    asset_top_pct: 0.18,         // ~243 px (linea superior del area de asset)
    asset_bottom_pct: 0.85,      // ~1147 px (linea inferior del area de asset)
    title_badge_y_pct: 0.18,     // ~243 px (debajo de los subtitulos)
    signature_bar_y_pct: 0.945,  // centro vertical de la barra firma (~1275)
  },
  subtitle: {
    font_size: 64,
    max_chars_per_line: 22,
    max_lines: 2,
    outline_width: 4,
    shadow_offset: 3,
  },
  signature: {
    text: process.env.BRAND_SIGNATURE || '@draydeliserodriguez',
    font_size: 34,
    bar_height: 70,
    bar_alpha: 0.8,
  },
  title_badge: {
    font_size: 56,
    horizontal_padding: 40,
    vertical_padding: 18,
    duration_default: 2.0,
  },
  video: {
    width: 1080,
    height: 1350,                  // Formato 4:5 (Instagram feed portrait)
    fps: 30,
    crf: 21,                       // Mejor calidad (antes 23)
    preset: 'fast',                // Compresion ~70% mejor que ultrafast
    audio_bitrate: '128k',
    xfade_duration: 1.5,           // Transicion cinematografica lenta
    xfade_transition: 'fade',
    // Numero maximo de segmentos pre-procesados en paralelo en fase 1.
    // Bajar este valor si el worker se queda sin RAM o CPU.
    max_parallel_segments: 2,
  },
};

/**
 * Convierte `#RRGGBB` al formato de color de FFmpeg `0xRRGGBB`.
 */
export function ffmpegColor(hex) {
  return '0x' + hex.replace('#', '').toUpperCase();
}

/**
 * Convierte `#RRGGBB` + alpha (0..1) a formato FFmpeg `0xRRGGBB@A`.
 * Apto para argumentos `color=` de `drawbox`, `pad`, `color` source, etc.
 */
export function ffmpegColorAlpha(hex, alpha) {
  return `${ffmpegColor(hex)}@${alpha}`;
}

/**
 * Convierte `#RRGGBB` al formato de color ASS: `&HAABBGGRR`.
 * - ASS usa orden BGR (no RGB).
 * - Alpha invertido: 00 = opaco, FF = transparente.
 */
export function assColor(hex, alpha = 0) {
  const clean = hex.replace('#', '').toUpperCase().padStart(6, '0');
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  const a = alpha.toString(16).toUpperCase().padStart(2, '0');
  return `&H${a}${b}${g}${r}`;
}

/**
 * Convierte un porcentaje (0..1) a coordenada Y absoluta en px.
 */
export function pctY(pct) {
  return Math.round(BRAND.video.height * pct);
}

/**
 * Convierte un porcentaje (0..1) a coordenada X absoluta en px.
 */
export function pctX(pct) {
  return Math.round(BRAND.video.width * pct);
}
