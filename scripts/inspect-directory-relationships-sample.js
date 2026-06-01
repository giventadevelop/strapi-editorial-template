/**
 * Print sample rows for diocese↔priest, diocese↔parish, and parish↔vicar (priest)
 * from a Strapi 5 SQLite DB. Strapi 5 stores relations in *_lnk tables.
 *
 * Usage:
 *   node scripts/inspect-directory-relationships-sample.js
 *   node scripts/inspect-directory-relationships-sample.js path/to/data.db
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] || path.join(__dirname, '..', '.tmp', 'data.db');
const db = new Database(dbPath, { readonly: true });

try {
  const counts = {
    priests: db.prepare(`SELECT COUNT(*) AS c FROM priests`).get().c,
    parishes: db.prepare(`SELECT COUNT(*) AS c FROM parishes`).get().c,
    dioceses: db.prepare(`SELECT COUNT(*) AS c FROM dioceses`).get().c,
    priests_diocese_lnk: db.prepare(`SELECT COUNT(*) AS c FROM priests_diocese_lnk`).get().c,
    parishes_diocese_lnk: db.prepare(`SELECT COUNT(*) AS c FROM parishes_diocese_lnk`).get().c,
    parishes_vicar_lnk: db.prepare(`SELECT COUNT(*) AS c FROM parishes_vicar_lnk`).get().c,
  };
  console.log('Counts:', JSON.stringify(counts, null, 2));

  const priestDiocese = db
    .prepare(
      `
    SELECT pr.name AS priest_name, d.name AS diocese_name, d.slug AS diocese_slug
    FROM priests pr
    INNER JOIN priests_diocese_lnk pdl ON pdl.priest_id = pr.id
    INNER JOIN dioceses d ON d.id = pdl.diocese_id
    ORDER BY d.name, pr.name
    LIMIT 8
  `
    )
    .all();
  console.log('\nSample priest ↔ diocese:', JSON.stringify(priestDiocese, null, 2));

  const parishDiocese = db
    .prepare(
      `
    SELECT pa.name AS parish_name, d.name AS diocese_name
    FROM parishes pa
    INNER JOIN parishes_diocese_lnk pal ON pal.parish_id = pa.id
    INNER JOIN dioceses d ON d.id = pal.diocese_id
    ORDER BY d.name, pa.name
    LIMIT 8
  `
    )
    .all();
  console.log('\nSample parish ↔ diocese:', JSON.stringify(parishDiocese, null, 2));

  const vicar = db
    .prepare(
      `
    SELECT pa.name AS parish_name, vic.name AS vicar_name, d.name AS diocese_name
    FROM parishes_vicar_lnk pvl
    INNER JOIN parishes pa ON pa.id = pvl.parish_id
    INNER JOIN priests vic ON vic.id = pvl.priest_id
    LEFT JOIN parishes_diocese_lnk pal ON pal.parish_id = pa.id
    LEFT JOIN dioceses d ON d.id = pal.diocese_id
    ORDER BY d.name, pa.name
    LIMIT 8
  `
    )
    .all();
  console.log(
    '\nSample parish ↔ vicar (priest):',
    vicar.length ? JSON.stringify(vicar, null, 2) : '(no rows in parishes_vicar_lnk)'
  );
} finally {
  db.close();
}
