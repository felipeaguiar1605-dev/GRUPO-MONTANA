/**
 * Atualiza SEDUC 11/2023 (Segurança) com ATA localizada.
 * ATA DE REGISTRO DE PREÇOS N° 01/2023 - PE 19/2020 - SEGURANÇA P. ARMADA
 */
const Database = require('better-sqlite3');
const db = new Database('data/seguranca/montana.db');

db.prepare(`
  UPDATE contratos
  SET ata_registro_precos = 'ATA DE REGISTRO DE PREÇOS N° 01/2023 — Pregão Eletrônico 19/2020 — Segurança Patrimonial Armada (contratos/seguranca/seduc-011-2023/ATA DE REGISTRO DE PRECOS No 01_2023 - PE_19_2020 - SEGURANCA P. ARMADA E PUBLICACAO.pdf). Processo Originário 2022/27000/005515, Traslado 2024/27000/004671'
  WHERE numContrato = 'SEDUC 11/2023 + 3°TA'
`).run();

const r = db.prepare(`
  SELECT numContrato, ata_registro_precos FROM contratos WHERE numContrato = 'SEDUC 11/2023 + 3°TA'
`).get();
console.log('SEDUC 011/2023 ATA atualizada:');
console.log(JSON.stringify(r, null, 2));
db.close();
