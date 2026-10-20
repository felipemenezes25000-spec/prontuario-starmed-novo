/**
 * Fixture TISS sintética e determinística para o CI.
 *
 * Gera um lote ENVIO_LOTE_GUIAS com uma guia de consulta (dados 100% fictícios,
 * sem CPF/CNS/reais) e grava no arquivo indicado para validação contra o XSD
 * oficial da ANS (schemas/tiss/4.01.00) via scripts/tiss/validate-tiss.ps1.
 *
 * Uso: npx tsx scripts/tiss/ci-fixture.ts [destino.xml]
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildTissLote, type TissConsultaInput } from '../../apps/api/src/interop/tiss';

const guia: TissConsultaInput = {
  loteId: '1',
  sequencialTransacao: '1',
  dataRegistro: '2026-10-20',
  horaRegistro: '10:00:00',
  prestador: { cnpj: '12345678000195' },
  registroAnsOperadora: '123456',
  numeroGuiaPrestador: '1',
  beneficiario: { numeroCarteira: 'SYNTH0001', atendimentoRN: 'N' },
  contratadoExecutante: { cnpj: '12345678000195', cnes: '1234567' },
  profissionalExecutante: {
    nome: 'Profissional Sintetico CI',
    conselho: '02',
    numeroRegistro: '123456',
    uf: '35',
    cbos: '225124',
  },
  indicacaoAcidente: '0',
  atendimento: { regime: '01', data: '2026-10-20', tipoConsulta: '1' },
  procedimento: { codigoTabela: '22', codigo: '123456789', valor: 150.5 },
};

const destino = resolve(process.cwd(), process.argv[2] || 'tiss-ci.xml');
writeFileSync(destino, buildTissLote([guia]) + '\n', 'utf8');
console.log('Fixture TISS sintética gravada em ' + destino);
