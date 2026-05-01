-- =============================================================================
-- 001_asset_usage.sql
--
-- Tabla `asset_usage` — historial de assets de B-roll consumidos por el reel
-- generator, para evitar repeticion entre reels.
--
-- Estados (`status`):
--   reserved : reservado durante una sesion de generacion en curso.
--              Se inserta antes de llamar a /compose.
--   used     : asset publicado en un reel completado con exito.
--              NO debe seleccionarse para reels futuros.
--   released : reserva liberada porque la sesion fallo. Vuelve a ser candidato.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS asset_usage (
    id              SERIAL PRIMARY KEY,
    source          VARCHAR(20)  NOT NULL,           -- 'pexels' | 'pixabay' | ...
    asset_id        VARCHAR(100) NOT NULL,           -- id en la API de origen
    asset_type      VARCHAR(10)  NOT NULL,           -- 'image' | 'video'
    asset_url       TEXT         NOT NULL,
    asset_phash     VARCHAR(64),                     -- hash perceptual (fase 2)
    used_in_reel    VARCHAR(100),                    -- session_id mientras esta reservado;
                                                     -- reel_id final cuando pasa a 'used'.
    topic           TEXT,                            -- tema/contexto del reel
    status          VARCHAR(20)  NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'used', 'released')),
    reserved_at     TIMESTAMPTZ           DEFAULT NOW(),
    used_at         TIMESTAMPTZ,
    released_at     TIMESTAMPTZ,

    -- Un asset (combinacion source+asset_id) solo puede aparecer una vez en
    -- la tabla. La logica de no-repeticion se basa en este UNIQUE.
    UNIQUE (source, asset_id)
);

-- Indices para las queries habituales:
--   1) excluir todos los assets bloqueados al buscar candidatos:
--        SELECT source, asset_id FROM asset_usage WHERE status IN ('reserved','used');
--   2) liberar reservas de una session_id concreta tras un fallo:
--        UPDATE asset_usage SET status='released', released_at=NOW()
--        WHERE used_in_reel = $1 AND status = 'reserved';
--   3) confirmar tras un compose exitoso:
--        UPDATE asset_usage SET status='used', used_at=NOW()
--        WHERE used_in_reel = $1 AND status = 'reserved';
CREATE INDEX IF NOT EXISTS idx_asset_usage_status         ON asset_usage(status);
CREATE INDEX IF NOT EXISTS idx_asset_usage_source_id      ON asset_usage(source, asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_usage_used_in_reel   ON asset_usage(used_in_reel);
CREATE INDEX IF NOT EXISTS idx_asset_usage_status_source  ON asset_usage(status, source);

-- Vista util: assets actualmente bloqueados (no candidatos para nueva busqueda).
-- El workflow n8n hace SELECT * FROM asset_usage_blocked.
CREATE OR REPLACE VIEW asset_usage_blocked AS
    SELECT source, asset_id, status
    FROM asset_usage
    WHERE status IN ('reserved', 'used');

COMMENT ON TABLE asset_usage IS
    'Historial de assets de stock (Pexels/Pixabay) consumidos por el reel generator. Evita repeticion entre reels.';
COMMENT ON COLUMN asset_usage.status IS
    'reserved=en uso por una sesion en curso; used=publicado; released=sesion fallo, asset re-disponible.';
COMMENT ON COLUMN asset_usage.asset_phash IS
    'TODO fase 2: hash perceptual (pHash 64-bit) para bloquear assets visualmente similares (Hamming < 5).';

-- TODO fase 2: politica de retencion para `released` viejos.
--   Si un asset estuvo `released` >30 dias y nunca fue `used`, conviene
--   eliminarlo para no inflar la tabla. Cron job sugerido:
--     DELETE FROM asset_usage
--      WHERE status = 'released' AND released_at < NOW() - INTERVAL '30 days';

COMMIT;
