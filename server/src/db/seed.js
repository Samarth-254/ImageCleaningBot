import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './index.js';

export const DEFAULT_POLICY = {
  scope_description: 'Used-car / vehicle listing photos',
  background_style: 'keep_original_remove_clutter',
  identifier_handling: 'keep_unchanged',
  never_edit: [
    'documents',
    'id_cards',
    'odometer_readings',
    'vin_plates',
  ],
  discouraged_edit_verbs: [
    'replace',
    'regenerate',
    'redraw',
    'rebuild',
    'reconstruct',
    'recreate',
  ],
  max_minor_differences: 1,
  show_reconstruction_note: false,
  reply_tone: 'warm, concise, practical',
  default_language: 'english_only',
  repair_rules: {
    fix_surface_damage_and_dirt: true,
    preserve_subject_identity: true,
    allow_showroom_background: false,
  },
};

export async function seed() {
  const existing = await db.query(
    'SELECT id, version FROM policies WHERE is_active = TRUE ORDER BY version DESC LIMIT 1'
  );
  if (existing.rowCount > 0) {
    console.log(`[seed] Active policy already exists (version ${existing.rows[0].version}).`);
  } else {
    await db.query(
      'INSERT INTO policies (version, is_active, policy_json) VALUES ($1, $2, $3)',
      [1, true, JSON.stringify(DEFAULT_POLICY)]
    );
    console.log('[seed] Inserted default policy v1.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seed()
    .then(() => db.closePool())
    .catch(async (err) => {
      console.error('[seed] Error:', err);
      await db.closePool();
      process.exit(1);
    });
}
